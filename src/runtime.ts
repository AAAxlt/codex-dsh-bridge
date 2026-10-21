/**
 * One DSH SDK runtime process. Line-delimited JSON-RPC over stdio.
 *
 * Confirmed handlers on the pinned community runtime: initialize, session/prompt, shutdown.
 * There is no native per-turn cancel; cancellation is implemented as "shut down this task's
 * own SDK process" and is reported as such.
 */
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {buildChildEnv, CLI_ENTRY, CLI_ENTRY_IS_REAL, IS_WINDOWS, LIMITS, API_KEY_ENV, credentialValue, describeCredential, PROVIDER_ID, MODEL_ID, resolveReasoningEffort, type ReasoningEffort} from './config.js';
import {scrubText, truncate} from './evidence.js';

export interface RuntimeOptions {
  workspace: string;
  homeDir: string;
  overlayPath: string;
  profileName: string;
  reasoningEffort: ReasoningEffort;
  maxTokens: number;
}

export interface RuntimeNotification {
  kind: 'notification';
  method: string;
  type: string;
  params: unknown;
  at: string;
}

export interface RuntimeExit {
  kind: 'exit';
  code: number | null;
  signal: string | null;
  at: string;
}

export interface RuntimeStderr {
  kind: 'stderr';
  text: string;
  at: string;
}

export type RuntimeEvent = RuntimeNotification | RuntimeExit | RuntimeStderr;

export interface StopEvidence {
  /** the runtime pid itself is gone */
  stopped: boolean;
  method: string;
  pid: number | null;
  stderrPreview: string;
  /** the runtime's own pid is gone (this alone is NOT proof that the task stopped) */
  parentStopped: boolean;
  /**
   * true only when this platform could enumerate the task's process tree AND at least one process
   * was actually attributed to this task. An empty capture is unknown, not a verified tree.
   */
  treeVerified: boolean;
  /**
   * captured task pids still alive after the sweep; null when the platform cannot enumerate, or
   * when nothing could be attributed to this task at all (an empty capture proves nothing, so it is
   * reported as unknown rather than as "no survivors").
   */
  survivorPids: number[] | null;
  /**
   * parent gone AND the tree was enumerable AND at least one process was actually attributed to
   * this task AND nothing captured survived. Deliberately scoped to the CAPTURED set: a descendant
   * that detached with setsid() and was reparented before the capture leaves no trace this bridge
   * can attribute, so this is never a claim about the whole process tree.
   */
  fullyStopped: boolean;
  note: string;
}

export interface StartResult {
  serverInfo: {name: string; version: string} | null;
  raw: unknown;
  /** true when this call reused an already-live process instead of spawning a new one. */
  reused: boolean;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RuntimeRpcError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message);
    this.name = 'RuntimeRpcError';
  }
}

const NOTIFICATION_MAX_CHARS = 60_000;

function isProcessAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------- owned process tree (POSIX) */

/**
 * One process this bridge believes it owns, pinned to the start time observed when it was
 * captured. The start time is what makes signalling safe: a pid recycled by an unrelated
 * process has a different start time, so it is skipped instead of killed.
 */
interface OwnedProcess {
  pid: number;
  startTime: string;
  pgid: number;
  sid: number;
  ppid: number;
}

interface ProcStat {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  state: string;
  startTime: string;
}

/** Reads /proc/<pid>/stat. null when the process is gone or /proc is unavailable. */
function readProcStat(pid: number): ProcStat | null {
  if (pid <= 0) return null;
  let raw: string;
  try { raw = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  // After "pid (comm) " the fields are: state ppid pgrp session ... starttime (field 22 overall).
  const fields = raw.slice(close + 2).split(' ');
  const ppid = Number.parseInt(fields[1] ?? '', 10);
  const pgid = Number.parseInt(fields[2] ?? '', 10);
  const sid = Number.parseInt(fields[3] ?? '', 10);
  const startTime = fields[19] ?? '';
  const state = fields[0] ?? '';
  if (!Number.isFinite(ppid) || !Number.isFinite(pgid) || startTime.length === 0) return null;
  return {pid, ppid, pgid, sid, state, startTime};
}

function posixProcessTable(): Map<number, ProcStat> {
  const table = new Map<number, ProcStat>();
  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return table; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readProcStat(Number.parseInt(entry, 10));
    if (stat) table.set(stat.pid, stat);
  }
  return table;
}

function descendantsOf(table: Map<number, ProcStat>, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const stat of table.values()) {
    const list = children.get(stat.ppid);
    if (list) list.push(stat.pid);
    else children.set(stat.ppid, [stat.pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const stack = [...(children.get(root) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return out;
}

/**
 * Everything this bridge can attribute to one task, captured BEFORE any signal is sent:
 * descendants of the runtime pid plus every process still sharing its process group. Our own
 * process and its ancestors are never included, so the bridge cannot signal itself.
 *
 * A descendant that called setsid() and outlived its parent can no longer be attributed to this
 * task; that is an honest gap (reported as unverifiable), not an invitation to sweep the system.
 */
function collectOwnedProcesses(runtimePid: number, processGroup: number | null): OwnedProcess[] {
  const table = posixProcessTable();
  if (table.size === 0) return [];
  const mine = new Set<number>([process.pid]);
  for (let pid = process.pid, hops = 0; hops < 16; hops += 1) {
    const stat = table.get(pid);
    if (!stat || stat.ppid <= 0) break;
    pid = stat.ppid;
    mine.add(pid);
  }
  const owned = new Map<number, OwnedProcess>();
  const add = (stat: ProcStat): void => {
    if (mine.has(stat.pid)) return;
    owned.set(stat.pid, {pid: stat.pid, startTime: stat.startTime, pgid: stat.pgid, sid: stat.sid, ppid: stat.ppid});
  };
  const root = table.get(runtimePid);
  if (root) add(root);
  for (const pid of descendantsOf(table, runtimePid)) {
    const stat = table.get(pid);
    if (stat) add(stat);
  }
  if (processGroup !== null && processGroup > 0) {
    for (const stat of table.values()) if (stat.pgid === processGroup) add(stat);
  }
  return [...owned.values()];
}

export class DshRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private exitInfo: RuntimeExit | null = null;
  private stderrLog = '';
  private stopping = false;
  private stopPromise: Promise<StopEvidence> | null = null;
  /** process group of our own child, captured at spawn so it is known even if the child exits first */
  private childPgid: number | null = null;
  private serverInfoCache: {name: string; version: string} | null = null;

  constructor(private readonly options: RuntimeOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get alive(): boolean {
    if (!this.child) return false;
    if (this.exitInfo) return false;
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  get exit(): RuntimeExit | null {
    return this.exitInfo;
  }

  get stderrPreview(): string {
    return this.stderrLog;
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* a listener must never kill the runtime */ }
    }
  }

  /** Fixed argv. No shell, no user-controlled executable, no string concatenation. */
  private argv(): string[] {
    return [
      CLI_ENTRY,
      '--profile', this.options.profileName,
      '--from-default-profile', 'sdk',
      '--patch', this.options.overlayPath,
    ];
  }

  spawnOnly(): number {
    if (this.child) throw new Error('runtime already spawned');
    const child = spawn(process.execPath, this.argv(), {
      cwd: this.options.workspace,
      env: buildChildEnv(this.options.homeDir),
      windowsHide: true,
      // POSIX: give the runtime its own process group so stop() can signal the whole tree
      // (the SDK runtime plus every tool subprocess it spawned) with kill(-pid).
      detached: !IS_WINDOWS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    // A peer may close its pipe between the liveness check and write(). Node reports
    // EPIPE asynchronously on stdin, outside request()'s synchronous try/catch.
    // Reject the RPC waiters rather than leaving an unhandled stream error.
    child.stdin.on('error', (error) => {
      const message = `runtime stdin error: ${scrubText(error.message)}`;
      this.failAllPending(new RuntimeRpcError(message, null));
      this.emit({kind: 'stderr', text: message, at: new Date().toISOString()});
    });
    this.childPgid = IS_WINDOWS ? null : (readProcStat(child.pid ?? -1)?.pgid ?? null);
    createInterface({input: child.stdout}).on('line', (line) => this.onLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = scrubText(chunk.toString('utf8'));
      this.stderrLog = truncate(this.stderrLog + text, NOTIFICATION_MAX_CHARS).text;
      this.emit({kind: 'stderr', text: truncate(text, 2_000).text, at: new Date().toISOString()});
    });
    child.on('error', (error) => {
      this.exitInfo = {kind: 'exit', code: null, signal: null, at: new Date().toISOString()};
      this.failAllPending(new RuntimeRpcError(`runtime spawn error: ${scrubText(error.message)}`, null));
      this.emit({kind: 'stderr', text: `spawn error: ${scrubText(error.message)}`, at: new Date().toISOString()});
    });
    child.on('exit', (code, signal) => {
      this.exitInfo = {kind: 'exit', code, signal, at: new Date().toISOString()};
      this.failAllPending(new RuntimeRpcError(`runtime exited (code=${code} signal=${signal})`, null));
      this.emit(this.exitInfo);
    });
    return child.pid ?? -1;
  }

  async start(timeoutMs: number): Promise<StartResult> {
    // A continuation must reuse the live session. Spawning again here would silently start a
    // NEW session while the caller believes it is continuing the old one, so it is refused
    // outright rather than left to the model to notice.
    if (this.alive) return {serverInfo: this.serverInfoCache, raw: null, reused: true};
    if (this.child) {
      throw new RuntimeRpcError(
        'this task\'s runtime process has already exited; it cannot be resumed. Submit a new task instead.',
        null,
      );
    }
    // Preflight: refuse BEFORE spawning rather than letting the model call fail obscurely.
    // Skipped only when the entry is positively identified as a scripted test double; a real
    // DSH entry needs the credential even when it is not on the platform-default path.
    if (CLI_ENTRY_IS_REAL && credentialValue() === null) {
      throw new RuntimeRpcError(
        `no credential: ${describeCredential().error ?? API_KEY_ENV + ' is unavailable'}`,
        null,
      );
    }
    this.spawnOnly();
    const result = (await this.request('initialize', {
      cwd: this.options.workspace,
      provider: PROVIDER_ID,
      model: MODEL_ID,
      reasoningEffort: resolveReasoningEffort(this.options.reasoningEffort).sdkValue,
      maxTokens: this.options.maxTokens,
    }, timeoutMs)) as {serverInfo?: {name?: string; version?: string}} | undefined;
    const info = result?.serverInfo;
    this.serverInfoCache = info?.name ? {name: String(info.name), version: String(info.version ?? 'unknown')} : null;
    return {
      serverInfo: this.serverInfoCache,
      raw: result ?? null,
      reused: false,
    };
  }

  async prompt(sessionId: string, text: string, timeoutMs: number): Promise<{messageId: string}> {
    const result = (await this.request('session/prompt', {
      sessionId,
      contentBlocks: [{type: 'text', text}],
    }, timeoutMs)) as {messageId?: string} | undefined;
    if (!result?.messageId) throw new RuntimeRpcError('session/prompt returned no messageId', null);
    return {messageId: String(result.messageId)};
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.emit({kind: 'stderr', text: `non-protocol stdout: ${truncate(scrubText(trimmed), 1_000).text}`, at: new Date().toISOString()});
      return;
    }
    const id = message['id'];
    if (typeof id === 'number' && (message['result'] !== undefined || message['error'] !== undefined)) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        const error = message['error'];
        if (error && typeof error === 'object') {
          const err = error as {code?: number; message?: string};
          pending.reject(new RuntimeRpcError(scrubText(String(err.message ?? 'unknown RPC error')), err.code ?? null));
        } else {
          pending.resolve(message['result']);
        }
      }
      return;
    }
    const method = message['method'];
    if (typeof method !== 'string') return;
    const params = message['params'];
    const event = (params && typeof params === 'object' ? (params as {event?: {type?: string}}).event : undefined);
    const type = typeof event?.type === 'string' ? event.type : method;
    // `params` is passed through live (not JSON-re-serialised) so consumers can read fields;
    // scrubbing/truncation happens exactly once, at persist or return time.
    this.emit({kind: 'notification', method, type, params: params ?? null, at: new Date().toISOString()});
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child || !this.alive) {
      return Promise.reject(new RuntimeRpcError(`runtime is not running; cannot call ${method}`, null));
    }
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeRpcError(`RPC timeout after ${timeoutMs}ms: ${method}`, null));
      }, timeoutMs);
      this.pending.set(id, {method, resolve, reject, timer});
      try {
        child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RuntimeRpcError(`failed to write ${method}: ${scrubText((error as Error).message)}`, null));
      }
    });
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async waitForExit(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.exitInfo) return true;
      await sleep(50);
    }
    return this.exitInfo !== null;
  }

  /**
   * Stops this task's runtime so that nothing it started survives.
   *
   * The runtime pid exiting is NOT treated as proof that the task stopped: tool subprocesses
   * inherit the process group and can outlive their parent. The owned set is therefore captured
   * BEFORE the first signal is sent (so every process killed can be attributed to this task),
   * each member is pinned to its observed start time (so a recycled pid is never signalled), and
   * the sweep runs on every path - graceful shutdown, forced kill, and already-exited alike.
   *
   * `stopped` means the parent is gone and, where the platform can enumerate the tree, nothing
   * captured survived. `fullyStopped` additionally requires that the tree WAS enumerable AND that
   * at least one process was actually attributed to this task: an unverifiable platform, and an
   * empty capture, can never be reported as a fully stopped task.
   * The user's running DSH Desktop is never a target: only this task's own processes are used.
   */
  async stop(): Promise<StopEvidence> {
    const pid = this.pid;
    const child = this.child;
    if (!child) return this.evidence(true, 'never-started', null, true, [], 'no runtime process was ever started');
    if (this.stopping) {
      if (this.stopPromise) return this.stopPromise;
      return this.evidence(!isProcessAlive(pid), 'already-stopping', pid, false, null,
        'another stop is already in flight and left no result; the task tree is NOT claimed stopped');
    }
    this.stopping = true;
    this.stopPromise = this.performStop(child, pid);
    return this.stopPromise;
  }

  private evidence(
    parentStopped: boolean, method: string, pid: number | null,
    treeVerified: boolean, survivorPids: number[] | null, note: string,
  ): StopEvidence {
    const survivors = survivorPids ?? [];
    return {
      stopped: parentStopped && (treeVerified ? survivors.length === 0 : true),
      method, pid, stderrPreview: this.stderrLog,
      parentStopped, treeVerified, survivorPids,
      // Fail closed on the claim, not on the cleanup: an unknown capture (null) is never a pass,
      // even if a caller passes treeVerified: true alongside an empty set.
      fullyStopped: parentStopped && treeVerified && survivorPids !== null && survivors.length === 0,
      note,
    };
  }

  private async performStop(child: ChildProcessWithoutNullStreams, pid: number | null): Promise<StopEvidence> {
    const owned = (IS_WINDOWS || this.childPgid === null)
      ? null
      : new Map(collectOwnedProcesses(pid ?? 0, this.childPgid).map((p) => [p.pid, p]));
    const captured = owned ? owned.size : 0;

    let method = this.exitInfo ? 'already-exited' : 'none';
    if (!this.exitInfo) {
      try {
        await this.request('shutdown', {}, LIMITS.stopShutdownTimeoutMs);
        method = 'shutdown-rpc';
      } catch { /* fall through to escalation */ }
      try { child.stdin.end(); } catch { /* ignore */ }

      if (!(await this.waitForExit(LIMITS.stopGraceMs))) {
        try { child.kill(); method = `${method}+sigterm`; } catch { /* ignore */ }
      }
      if (!(await this.waitForExit(LIMITS.stopGraceMs))) {
        try { child.kill('SIGKILL'); method = `${method}+sigkill`; } catch { /* ignore */ }
      }
      // Windows tree kill. taskkill takes a bare pid and this platform gives us no way to prove
      // that pid has not been recycled, so it is issued only while our own child is still alive.
      if (IS_WINDOWS && pid !== null && pid > 0 && isProcessAlive(pid)) {
        try {
          spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
          method = `${method}+taskkill-tree`;
        } catch { /* ignore */ }
        await this.waitForExit(LIMITS.stopGraceMs);
      }
    }

    const parentStopped = !(pid !== null && pid > 0 && isProcessAlive(pid));
    if (!owned) {
      // Fail closed on the claim, not on the cleanup: the platform cannot enumerate the tree, so
      // descendants are never reported as verified.
      const why = IS_WINDOWS
        ? 'this platform cannot enumerate a task process tree'
        : 'the runtime process group could not be established when it was spawned';
      return this.evidence(parentStopped, method, pid, false, null,
        `${why}, so descendants of the runtime were NOT verified; only the runtime pid itself was checked`);
    }

    const survivorPids = await this.sweepOwned(owned);
    // An EMPTY capture is unknown, not a pass. Nothing was attributed to this task, so the tree was
    // NOT verified: reporting treeVerified with an empty survivor set would claim the whole tree is
    // gone on the strength of an empty set. A descendant that detached with setsid() and was
    // reparented before this capture leaves nothing /proc can attribute to this task.
    const treeVerified = captured > 0;
    if (survivorPids.length > 0) method = `${method}+sweep-survivors`;
    else if (captured > 0) method = `${method}+tree-swept(${captured})`;
    else method = `${method}+nothing-attributable`;
    const note = survivorPids.length > 0
      ? `${survivorPids.length} of ${captured} captured task process(es) are still alive: ${survivorPids.join(', ')}`
      : captured === 0
        ? 'no live process belonging to this task could be captured at stop time (it may have exited already, or detached itself with setsid), so the task tree is NOT verified'
        : `all ${captured} captured task process(es) were verified gone`;
    return this.evidence(parentStopped, method, pid, treeVerified, treeVerified ? survivorPids : null, note);
  }

  /**
   * Kills every captured process that is still the same process, re-collecting between rounds so
   * descendants forked during the sweep are included. The round count is bounded so a process
   * that keeps forking cannot turn this into an endless loop; whatever survives is reported.
   */
  private async sweepOwned(owned: Map<number, OwnedProcess>): Promise<number[]> {
    const survivors = new Map<number, OwnedProcess>();
    for (let round = 0; round < 3; round += 1) {
      const rootPid = this.pid;
      if (round > 0 && rootPid !== null) {
        for (const ref of collectOwnedProcesses(rootPid, this.childPgid)) {
          if (!owned.has(ref.pid)) owned.set(ref.pid, ref);
        }
      }
      survivors.clear();
      for (const ref of owned.values()) {
        const now = readProcStat(ref.pid);
        if (!now || now.state === 'Z') continue;          // already gone
        if (now.startTime !== ref.startTime) continue;     // pid recycled: not ours any more
        try { process.kill(ref.pid, 'SIGKILL'); } catch { /* raced with its own exit */ }
        survivors.set(ref.pid, ref);
      }
      if (survivors.size === 0) break;
      await sleep(round === 0 ? 250 : 150);
    }
    const still: number[] = [];
    for (const ref of survivors.values()) {
      const now = readProcStat(ref.pid);
      if (now && now.state !== 'Z' && now.startTime === ref.startTime) still.push(ref.pid);
    }
    return still;
  }

  /** Verification aid for cancel: is the recorded pid really gone? */
  static pidAlive(pid: number | null): boolean {
    return pid !== null && pid > 0 && isProcessAlive(pid);
  }
}
