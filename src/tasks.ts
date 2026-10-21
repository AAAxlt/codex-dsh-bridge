/**
 * Task lifecycle: one task == one isolated DSH SDK runtime process + one DSH_HOME + one task dir.
 *
 * State machine (never collapses distinct facts into "success"):
 *   accepted -> starting -> running -> awaiting_review | incomplete | blocked | failed | timed_out
 *   any live state -> cancelled (runtime stopped and verified stopped)
 *
 * A stage ends ONLY on the runtime's own `turn/end` event for that stage's turn.
 * Process exit 0, a completed-looking message, or idle status are corroborating evidence,
 * never the success criterion.
 */
import {spawn, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DshRuntime, RuntimeRpcError, type RuntimeEvent} from './runtime.js';
import {checkWorkspace, COMMUNITY_APP_ROOT, CLI_ENTRY_IS_REAL, credentialValue, DATA_ROOT, describeCredential, DEFAULT_REASONING_EFFORT, LIMITS, MAX_CONCURRENT_TASKS, resolveReasoningEffort, type ReasoningEffort, type ReasoningPolicy} from './config.js';
import {parseExecutionProfile, renderOverlay, ExecutionProfileError, type ExecutionProfile} from './execution-profiles.js';
import {diffSnapshots, scrub, scrubText, snapshotWorkspace, truncate, type FileChanges, type WorkspaceSnapshot} from './evidence.js';
import {continuationPrompt, firstStagePrompt, type TaskBrief} from './prompts.js';

export type TaskState =
  | 'accepted' | 'starting' | 'running' | 'awaiting_review'
  | 'blocked' | 'incomplete' | 'failed' | 'cancelled' | 'timed_out';

/** States where the task still owns a live runtime that is doing work. */
export const LIVE_STATES: readonly TaskState[] = ['accepted', 'starting', 'running'];
/** States where the same session can accept another stage. Requires a live runtime too. */
export const RESUMABLE_STATES: readonly TaskState[] = ['awaiting_review', 'blocked', 'incomplete'];

/** Notification types whose payloads carry provider-internal reasoning; never persisted. */
const SKIP_EVENT_TYPES = new Set([
  'assistant/attempt', 'request/context', 'request/header', 'system/message', 'developer/message',
]);

interface ToolObservation {
  callId: string;
  tool: string;
  turn: number | null;
  step: number | null;
  startedAt: string;
  argumentsPreview: string;
  finishedAt: string | null;
  isError: boolean | null;
  outputPreview: string | null;
}

export interface CommandObservation {
  argv: string[];
  cwd: string;
  ranAt: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  error: string | null;
}

export interface StageRecord {
  index: number;
  state: TaskState;
  prompt: string;
  startedAt: string;
  endedAt: string | null;
  messageId: string | null;
  turn: number | null;
  turnEndReason: unknown;
  outputLimitReached: boolean;
  reportStorageTruncated: boolean;
  modelReport: string;
  modelReportPath: string | null;
  usage: unknown;
  toolObservations: ToolObservation[];
  toolCounts: Record<string, number>;
  toolErrorCount: number;
  approvals: unknown[];
  fileChanges: Omit<FileChanges, 'before' | 'after'> | null;
  verification: CommandObservation | null;
  errors: string[];
  resultPath: string | null;
}

interface TaskRecord {
  taskId: string;
  sessionId: string;
  workspace: string;
  taskDir: string;
  homeDir: string;
  overlayPath: string;
  /** Selected execution profile; null means the field was omitted (legacy overlay path). */
  executionProfile: ExecutionProfile | null;
  /** Digest of the verified critical-runtime baseline; null for the legacy/scripted path. */
  executionBaselineSha256: string | null;
  /** SHA-256 of the exact overlay bytes written to overlayPath for this task. */
  overlaySha256: string;
  state: TaskState;
  goal: string;
  acceptance: string | null;
  constraints: string[];
  context: string | null;
  verificationCommand: string[] | null;
  reasoningEffort: ReasoningEffort;
  reasoningPolicy: ReasoningPolicy;
  configurationWarnings: string[];
  maxTokens: number;
  budgetMs: number | null;
  createdAt: string;
  updatedAt: string;
  stages: StageRecord[];
  runtimePid: number | null;
  serverInfo: {name: string; version: string} | null;
  runtimeExit: {code: number | null; signal: string | null; at: string} | null;
  cancel: {at: string; stopped: boolean; method: string; pid: number | null; note: string} | null;
  timeout: {at: string; budgetMs: number} | null;
  /**
   * Recorded when this bridge discovers that a stage is still marked live although its runtime is
   * gone: an unexpected exit, or a teardown that never completed. It carries the process-tree
   * evidence of the cleanup, so "the task stopped" is an observation and not an intention. Without
   * this a dead task stayed persisted as `running` forever (linux-05).
   */
  cleanupAfterExit: {
    at: string;
    reason: 'runtime-exit' | 'liveness';
    method: string;
    stopped: boolean;
    treeVerified: boolean;
    survivorPids: number[] | null;
    note: string;
  } | null;
  errors: string[];
}

/** Shape returned by status(). Typed on purpose: the MCP layer must not guess field names. */
export interface TaskStatusView {
  taskId: string;
  effectiveParameters: {reasoningEffort: ReasoningEffort; maxTokens: number; budgetMs: number | null};
  reasoningPolicy: ReasoningPolicy;
  configurationWarnings: string[];
  state: TaskState;
  workspace: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  stageCount: number;
  currentStage: {
    index: number; state: TaskState; messageId: string | null; turn: number | null;
    startedAt: string; endedAt: string | null;
    toolCalls: number; toolErrors: number; modelReportChars: number;
  } | null;
  runtimePid: number | null;
  runtimeAlive: boolean;
  runtimeExit: {code: number | null; signal: string | null; at: string} | null;
  cancel: {at: string; stopped: boolean; method: string; pid: number | null; note: string} | null;
  timeout: {at: string; budgetMs: number} | null;
  cleanupAfterExit: TaskRecord['cleanupAfterExit'];
  errors: string[];
  awaiting: boolean;
  canContinue: boolean;
  note: string;
}

/** Shape returned by result(). modelReport and bridgeObserved are never merged. */
export interface StageResultView {
  taskId: string;
  effectiveParameters: {reasoningEffort: ReasoningEffort; maxTokens: number; budgetMs: number | null};
  reasoningPolicy: ReasoningPolicy;
  configurationWarnings: string[];
  stage: number;
  stageState: TaskState;
  taskState: TaskState;
  turn: number | null;
  messageId: string | null;
  startedAt: string;
  endedAt: string | null;
  modelReport: {source: string; text: string; chars: number; truncated: boolean; previewTruncated: boolean; upstreamTruncated: boolean; storageTruncated: boolean; fullReportPath: string | null};
  bridgeObserved: {
    source: string;
    turnEndReason: unknown;
    output: {status: 'pending' | 'finished' | 'incomplete' | 'unknown'; limitReached: boolean; reportStorageTruncated: boolean; maxTokens: number; note: string};
    toolCalls: Array<{
      tool: string; step: number | null; callId: string; startedAt: string; finishedAt: string | null;
      isError: boolean | null; argumentsPreview: string; outputPreview: string | null;
    }>;
    toolCallsTotal: number;
    toolCounts: Record<string, number>;
    toolErrorCount: number;
    filesChanged: {added: string[]; modified: string[]; removed: string[]; unchangedCount: number; truncatedAt: number; snapshotTruncated: boolean; note: string} | null;
    verificationCommand: CommandObservation | null;
    verificationNote: string;
    approvalsRequested: unknown[];
    runtimeExit: {code: number | null; signal: string | null; at: string} | null;
    runtimePid: number | null;
    usage: unknown;
  };
  errors: string[];
  claimsVsEvidence: {claimOnly: string[]; supported: string[]};
  unresolved: string[];
  artifacts: {taskDir: string; eventsLog: string; taskRecord: string; stageResult: string | null; modelReport: string | null};
}

/** Shape returned by cancel(). There is no native per-turn cancel; this closes the task SDK. */
export interface CancelView {
  taskId: string;
  cancelled: boolean;
  alreadyCancelled?: boolean;
  runtimeStopped?: boolean;
  /** true only when the runtime pid AND every captured task process were verified gone */
  fullyStopped?: boolean;
  /** false when this platform cannot enumerate a task process tree */
  treeVerified?: boolean;
  /** captured task pids still alive after the sweep; null when unverifiable */
  survivorPids?: number[] | null;
  method?: string;
  pid?: number | null;
  runtimeStderrPreview?: string;
  partialFileChanges?: {added: string[]; modified: string[]; removed: string[]; unchangedCount: number} | null;
  note: string;
  evidence?: {taskDir: string; eventsLog: string; stageResult: string | null};
}

export interface SubmitInput {
  workspace: string;
  goal: string;
  context?: string | undefined;
  constraints?: string[] | undefined;
  acceptance?: string | undefined;
  verificationCommand?: string[] | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  /** `native` / `ptc`; omit for the legacy (no-preset) overlay. Any other value is refused. */
  executionProfile?: ExecutionProfile | undefined;
  maxTokens?: number | undefined;
  budgetMs?: number | undefined;
}

export class BridgeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

interface Waiter {
  resolve: (task: TaskRecord) => void;
  timer: NodeJS.Timeout;
}

interface ManagedTask {
  record: TaskRecord;
  runtime: DshRuntime;
  snapshot: WorkspaceSnapshot;
  waiters: Set<Waiter>;
  budgetTimer: NodeJS.Timeout | null;
  unsubscribe: () => void;
  activeIndex: number;
  /**
   * Who is tearing this task's runtime down, if anyone. `null` means nobody: an exit observed in
   * that state is an unexpected one and must be recorded as a failure. This used to be a boolean,
   * and a plain bridge shutdown then looked exactly like a cancel, which is how a task whose runtime
   * had exited was left persisted as `running` (linux-05).
   */
  teardown: 'cancel' | 'shutdown' | null;
}

/* ------------------------------------------------------------------ command observation */

function runCommand(argv: readonly string[], cwd: string, timeoutMs: number): Promise<CommandObservation> {
  const resolved = argv.map((part, index) =>
    index === 0 && (part === 'node' || part === 'node.exe') ? process.execPath : part);
  const started = Date.now();
  return new Promise<CommandObservation>((resolve) => {
    const base: CommandObservation = {
      argv: [...resolved], cwd, ranAt: new Date().toISOString(),
      exitCode: null, signal: null, timedOut: false, durationMs: 0,
      stdoutTail: '', stderrTail: '', error: null,
    };
    let child: ChildProcess;
    try {
      child = spawn(resolved[0]!, resolved.slice(1), {cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    } catch (error) {
      resolve({...base, durationMs: Date.now() - started, error: scrubText((error as Error).message)});
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = truncate(stdout + chunk.toString('utf8'), 20_000).text; });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = truncate(stderr + chunk.toString('utf8'), 20_000).text; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({...base, durationMs: Date.now() - started, timedOut, stdoutTail: tail(stdout), stderrTail: tail(stderr), error: scrubText(error.message)});
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ...base, durationMs: Date.now() - started, exitCode: code, signal, timedOut,
        stdoutTail: tail(stdout), stderrTail: tail(stderr), error: null,
      });
    });
  });
}

function tail(text: string, max = 4_000): string {
  return truncate(text, max).text;
}

/* ------------------------------------------------------------------ manager */

export class TaskManager {
  private readonly tasks = new Map<string, ManagedTask>();
  private shuttingDown = false;

  /* ------------- helpers ------------- */

  private require(taskId: string): ManagedTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new BridgeError(
        `unknown taskId '${taskId}'. Known live tasks: [${[...this.tasks.keys()].join(', ') || 'none'}]`,
        'unknown_task',
      );
    }
    // Every read path goes through here, so a record that a crash left claiming a live stage is
    // corrected before any caller can see it. Cheap: two field reads and (usually) no syscall.
    this.reconcileDeadRuntime(task);
    return task;
  }

  /**
   * A task whose runtime is gone must never stay in a live state: a record persisted as `running`
   * with a dead pid looks resumable forever, which is exactly what linux-05 left behind. The state
   * correction is synchronous so it lands before any reader sees the record; the process-tree sweep
   * that backs it with evidence is async and overwrites the placeholder when it finishes, so
   * "the task stopped" is an observation rather than an intention.
   */
  private reconcileDeadRuntime(task: ManagedTask): void {
    const {record} = task;
    if (!LIVE_STATES.includes(record.state)) return;
    if (record.runtimePid === null) return; // no runtime was ever recorded: nothing to reconcile
    if (record.runtimeExit === null && DshRuntime.pidAlive(record.runtimePid)) return;
    const stage = record.stages[task.activeIndex - 1];
    const reason = record.runtimeExit === null ? 'liveness' : 'runtime-exit';
    // Name who was tearing this task down, if anyone: it is the difference between "the runtime
    // crashed" and "we stopped it and never recorded the outcome", and a reviewer reads this line.
    const why = task.teardown === 'shutdown'
      ? '; the bridge was shutting down and the work never finished'
      : task.teardown === 'cancel'
        ? '; a cancel was in progress and never completed'
        : '';
    const message = (record.runtimeExit === null
      ? `runtime pid ${record.runtimePid} is gone but the record still claimed ${record.state}: the outcome was never observed`
      : `runtime exited (code=${record.runtimeExit.code} signal=${record.runtimeExit.signal}) at ${record.runtimeExit.at} while stage ${stage?.index ?? '?'} was in flight`) + why;
    if (stage) {
      stage.errors.push(message);
      stage.state = 'failed';
      stage.endedAt ??= new Date().toISOString();
    }
    record.errors.push(message);
    record.state = 'failed';
    record.cleanupAfterExit = {
      at: new Date().toISOString(), reason, method: 'sweep-pending', stopped: false,
      treeVerified: false, survivorPids: null,
      note: 'the process-tree sweep has not finished yet; this placeholder is replaced by its result',
    };
    this.clearBudget(task);
    this.settleWaiters(task);
    this.touch(task);
    void this.sweepAfterExit(task, reason);
  }

  /** Sweeps what is left of a dead runtime and records it. Never throws: evidence, not control flow. */
  private async sweepAfterExit(task: ManagedTask, reason: 'runtime-exit' | 'liveness'): Promise<void> {
    let evidence: Awaited<ReturnType<DshRuntime['stop']>> | null = null;
    try {
      evidence = await task.runtime.stop();
    } catch {
      evidence = null;
    }
    task.record.cleanupAfterExit = {
      at: new Date().toISOString(), reason,
      method: evidence?.method ?? 'unavailable',
      stopped: evidence?.stopped ?? false,
      treeVerified: evidence?.treeVerified ?? false,
      survivorPids: evidence?.survivorPids ?? null,
      note: evidence?.note ?? 'the process tree could not be swept, so no cleanup evidence was obtainable',
    };
    const cleanup = task.record.cleanupAfterExit;
    this.appendEvent(task, {
      at: cleanup.at, kind: 'runtime/cleanup-after-exit', reason: cleanup.reason, method: cleanup.method,
      stopped: cleanup.stopped, treeVerified: cleanup.treeVerified, survivorPids: cleanup.survivorPids,
      note: cleanup.note,
    });
    this.touch(task);
  }

  private touch(task: ManagedTask): void {
    task.record.updatedAt = new Date().toISOString();
    try {
      writeFileSync(path.join(task.record.taskDir, 'task.json'), JSON.stringify(task.record, null, 2));
    } catch { /* durable status is best-effort; never break execution over it */ }
  }

  private appendEvent(task: ManagedTask, entry: Record<string, unknown>): void {
    try {
      appendFileSync(path.join(task.record.taskDir, 'events.jsonl'), `${JSON.stringify(entry)}\n`);
    } catch { /* ignore */ }
  }

  private settleWaiters(task: ManagedTask): void {
    for (const waiter of task.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(task.record);
    }
    task.waiters.clear();
  }

  private liveTaskCount(): number {
    let n = 0;
    for (const task of this.tasks.values()) if (LIVE_STATES.includes(task.record.state)) n++;
    return n;
  }

  listTasks(): Array<{taskId: string; state: TaskState; workspace: string; stages: number; updatedAt: string}> {
    return [...this.tasks.values()].map((task) => ({
      taskId: task.record.taskId, state: task.record.state, workspace: task.record.workspace,
      stages: task.record.stages.length, updatedAt: task.record.updatedAt,
    }));
  }

  /* ------------- submit ------------- */

  async submit(input: SubmitInput): Promise<TaskRecord> {
    if (this.shuttingDown) throw new BridgeError('bridge is shutting down; not accepting new tasks', 'shutting_down');
    const check = checkWorkspace(input.workspace);
    if (!check.ok) throw new BridgeError(`workspace rejected: ${check.reason}`, 'workspace_rejected');
    if (typeof input.goal !== 'string' || input.goal.trim().length === 0) {
      throw new BridgeError('goal must be a non-empty string', 'invalid_goal');
    }
    // Strict profile validation BEFORE any task directory exists, so a bad value can never
    // leave a half-created task behind. Omitted stays undefined (legacy overlay).
    let executionProfile: ExecutionProfile | undefined;
    try {
      executionProfile = parseExecutionProfile(input.executionProfile);
    } catch (error) {
      if (error instanceof ExecutionProfileError) {
        throw new BridgeError(error.message, 'invalid_execution_profile');
      }
      throw error;
    }
    // Fail closed for real explicit profiles before a task directory or SDK can exist.
    // Scripted fixtures are not real DSH installations and exercise the unchanged test seam.
    let executionBaselineSha256: string | null = null;
    if (executionProfile !== undefined && CLI_ENTRY_IS_REAL) {
      const assetRoot = fileURLToPath(new URL('../../', import.meta.url));
      const runtimeRoot = COMMUNITY_APP_ROOT;
      const guard = await import(pathToFileURL(path.join(assetRoot, 'maintenance/guard.mjs')).href);
      try {
        const baseline = guard.enforceBaseline(runtimeRoot, assetRoot, path.join(assetRoot, 'baseline/execution-profiles-baseline.json'));
        executionBaselineSha256 = baseline.baselineSha256;
      } catch (error) {
        throw new BridgeError((error as Error).message, 'execution_profile_drift');
      }
    }
    // Render before creating anything: a missing/invalid template must also refuse cleanly.
    const overlayText = renderOverlay(check.realPath, executionProfile);
    const overlaySha256 = createHash('sha256').update(overlayText, 'utf8').digest('hex');
    if (this.liveTaskCount() >= MAX_CONCURRENT_TASKS) {
      const running = [...this.tasks.values()].filter((t) => LIVE_STATES.includes(t.record.state)).map((t) => t.record.taskId);
      throw new BridgeError(
        `concurrency limit reached (${MAX_CONCURRENT_TASKS}). Live tasks: [${running.join(', ')}]. ` +
        'Wait for one to reach awaiting_review, or cancel it.',
        'concurrency_limit',
      );
    }
    // Refuse before creating any task record, so a missing credential never leaves a zombie task.
    if (CLI_ENTRY_IS_REAL && credentialValue() === null) {
      throw new BridgeError(
        `refusing to start a model stage: ${describeCredential().error ?? 'no credential available'}`,
        'missing_credential',
      );
    }
    const verificationCommand = normaliseCommand(input.verificationCommand);
    const maxTokens = clampInt(input.maxTokens ?? LIMITS.maxTokensDefault, 256, LIMITS.maxTokensMax);
    const reasoningPolicy = resolveReasoningEffort(input.reasoningEffort ?? DEFAULT_REASONING_EFFORT);
    const budgetMs = input.budgetMs ?? LIMITS.stageBudgetMsDefault;
    if (!Number.isInteger(budgetMs) || budgetMs < 1000 || budgetMs > 86_400_000) {
      throw new BridgeError('budgetMs must be an integer from 1000 to 86400000 milliseconds', 'invalid_budget');
    }
    const configurationWarnings: string[] = [];
    if (reasoningPolicy.adjusted) configurationWarnings.push(reasoningPolicy.reason!);
    if (maxTokens < 2048) configurationWarnings.push(`Explicit maxTokens=${maxTokens} is a small per-response budget, including model reasoning; it is preserved, but may truncate output. Omit it for the ${LIMITS.maxTokensDefault} default or choose a larger budget.`);

    const taskId = `dsh-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
    const taskDir = path.join(DATA_ROOT, 'tasks', taskId);
    const homeDir = path.join(taskDir, 'home');
    mkdirSync(path.join(taskDir, 'evidence'), {recursive: true});
    mkdirSync(homeDir, {recursive: true});

    const sessionId = `session-${taskId}`;
    const profileName = `bridge-${taskId}`;
    const overlayPath = path.join(taskDir, 'overlay.yml');
    writeFileSync(overlayPath, overlayText, 'utf8');

    const now = new Date().toISOString();
    const record: TaskRecord = {
      taskId, sessionId, workspace: check.realPath, taskDir, homeDir, overlayPath,
      executionProfile: executionProfile ?? null, executionBaselineSha256, overlaySha256,
      state: 'accepted', goal: input.goal.trim(), acceptance: input.acceptance?.trim() ?? null,
      constraints: (input.constraints ?? []).map((c) => String(c)),
      context: input.context?.trim() ?? null,
      verificationCommand, reasoningEffort: reasoningPolicy.effective, reasoningPolicy, configurationWarnings, maxTokens,
      budgetMs,
      createdAt: now, updatedAt: now, stages: [], runtimePid: null, serverInfo: null,
      runtimeExit: null, cancel: null, timeout: null, cleanupAfterExit: null, errors: [],
    };

    const runtime = new DshRuntime({
      workspace: check.realPath, homeDir, overlayPath, profileName,
      reasoningEffort: record.reasoningEffort, maxTokens,
    });
    const managed: ManagedTask = {
      record, runtime, snapshot: snapshotWorkspace(check.realPath),
      waiters: new Set(), budgetTimer: null, unsubscribe: () => {}, activeIndex: -1, teardown: null,
    };
    managed.unsubscribe = runtime.onEvent((event) => this.onRuntimeEvent(managed, event));
    this.tasks.set(taskId, managed);
    this.touch(managed);

    const brief: TaskBrief = {
      taskId, stage: 1, workspace: check.realPath, goal: record.goal,
      context: record.context ?? undefined, constraints: record.constraints,
      acceptance: record.acceptance ?? undefined, verificationCommand: verificationCommand ?? undefined,
    };
    const stage = this.newStage(1, firstStagePrompt(brief));
    record.stages.push(stage);
    this.touch(managed);
    await this.startStage(managed, stage);
    return record;
  }

  /* ------------- continue ------------- */

  async continue(taskId: string, review: string, acceptance?: string | undefined, goalOverride?: string | undefined): Promise<TaskRecord> {
    const task = this.require(taskId);
    const {record, runtime} = task;
    if (LIVE_STATES.includes(record.state)) {
      throw new BridgeError(
        `task ${taskId} is still ${record.state}; a stage is already in flight. Wait for it to settle before continuing.`,
        'stage_in_flight',
      );
    }
    if (record.state === 'cancelled') {
      throw new BridgeError(`task ${taskId} was cancelled and its runtime was stopped; it cannot be continued.`, 'task_cancelled');
    }
    if (record.state === 'timed_out' || record.state === 'failed') {
      throw new BridgeError(
        `task ${taskId} ended as ${record.state}; its runtime is not usable for a new stage. Submit a new task instead.`,
        'task_not_resumable',
      );
    }
    if (!RESUMABLE_STATES.includes(record.state) || !runtime.alive) {
      throw new BridgeError(
        `task ${taskId} is ${record.state} but its runtime is not alive; continuing would silently start over, so it is refused.`,
        'runtime_not_alive',
      );
    }
    if (typeof review !== 'string' || review.trim().length === 0) {
      throw new BridgeError('review must be a non-empty string', 'invalid_review');
    }
    const prior = record.stages[record.stages.length - 1]!;
    const index = record.stages.length + 1;
    const brief: TaskBrief = {
      taskId, stage: index, workspace: record.workspace,
      goal: goalOverride?.trim() ?? record.goal,
      context: record.context ?? undefined, constraints: record.constraints,
      acceptance: acceptance?.trim() ?? record.acceptance ?? undefined,
      verificationCommand: record.verificationCommand ?? undefined,
    };
    const stage = this.newStage(index, continuationPrompt(brief, review, prior.modelReport));
    record.stages.push(stage);
    this.touch(task);
    await this.startStage(task, stage);
    return record;
  }

  private newStage(index: number, prompt: string): StageRecord {
    return {
      index, state: 'accepted', prompt, startedAt: new Date().toISOString(), endedAt: null,
      messageId: null, turn: index, turnEndReason: null, outputLimitReached: false, reportStorageTruncated: false, modelReport: '', modelReportPath: null,
      usage: null, toolObservations: [], toolCounts: {}, toolErrorCount: 0, approvals: [],
      fileChanges: null, verification: null, errors: [], resultPath: null,
    };
  }

  private async startStage(task: ManagedTask, stage: StageRecord): Promise<void> {
    const {record, runtime} = task;
    task.activeIndex = stage.index;
    record.state = record.stages.length === 1 ? 'starting' : 'running';
    this.touch(task);
    try {
      const start = await runtime.start(LIMITS.submitTimeoutMs);
      if (start.serverInfo) record.serverInfo = start.serverInfo;
      record.runtimePid = runtime.pid;
      this.appendEvent(task, {
        at: new Date().toISOString(),
        kind: start.reused ? 'runtime/reused' : 'runtime/started',
        serverInfo: record.serverInfo, pid: runtime.pid,
      });
    } catch (error) {
      const message = error instanceof RuntimeRpcError ? error.message : (error as Error).message;
      this.failStage(task, stage, `runtime start failed: ${message}`);
      throw new BridgeError(`runtime start failed for task ${record.taskId}: ${message}`, 'runtime_start_failed');
    }
    record.state = 'running';
    stage.state = 'running';
    this.touch(task);

    if (record.budgetMs !== null) {
      task.budgetTimer = setTimeout(() => {
        void this.onBudgetExceeded(task);
      }, record.budgetMs);
    }

    try {
      const ack = await runtime.prompt(record.sessionId, stage.prompt, LIMITS.promptAckTimeoutMs);
      stage.messageId = ack.messageId;
      this.appendEvent(task, {at: new Date().toISOString(), kind: 'stage/accepted', stage: stage.index, messageId: ack.messageId});
      this.touch(task);
    } catch (error) {
      const message = error instanceof RuntimeRpcError ? error.message : (error as Error).message;
      this.failStage(task, stage, `stage ${stage.index} was never acknowledged: ${message}`);
    }
  }

  private failStage(task: ManagedTask, stage: StageRecord, message: string): void {
    stage.errors.push(message);
    stage.state = 'failed';
    stage.endedAt = new Date().toISOString();
    task.record.state = 'failed';
    task.record.errors.push(message);
    this.clearBudget(task);
    this.touch(task);
    this.settleWaiters(task);
  }

  private clearBudget(task: ManagedTask): void {
    if (task.budgetTimer) { clearTimeout(task.budgetTimer); task.budgetTimer = null; }
  }

  private async onBudgetExceeded(task: ManagedTask): Promise<void> {
    const stage = task.record.stages[task.activeIndex - 1];
    if (!stage || !LIVE_STATES.includes(task.record.state)) return;
    task.record.timeout = {at: new Date().toISOString(), budgetMs: task.record.budgetMs ?? 0};
    const message = `budget of ${task.record.budgetMs}ms exceeded during stage ${stage.index}; the task's SDK process was stopped`;
    stage.errors.push(message);
    stage.state = 'timed_out';
    stage.endedAt = new Date().toISOString();
    task.record.errors.push(message);
    task.record.state = 'timed_out';
    const stopped = await task.runtime.stop();
    task.record.runtimePid = stopped.pid;
    this.appendEvent(task, {at: new Date().toISOString(), kind: 'runtime/stopped', reason: 'budget_exceeded', ...stopped});
    this.touch(task);
    this.settleWaiters(task);
  }

  /* ------------- event handling ------------- */

  private onRuntimeEvent(task: ManagedTask, event: RuntimeEvent): void {
    const {record} = task;
    if (event.kind === 'stderr') {
      this.appendEvent(task, {at: event.at, kind: 'runtime/stderr', text: event.text});
      return;
    }
    if (event.kind === 'exit') {
      record.runtimeExit = {code: event.code, signal: event.signal, at: event.at};
      this.appendEvent(task, {at: event.at, kind: 'runtime/exit', code: event.code, signal: event.signal});
      if (LIVE_STATES.includes(record.state) && task.teardown !== 'cancel') {
        const stage = record.stages[task.activeIndex - 1];
        const why = task.teardown === 'shutdown'
          ? 'the bridge was shutting down and the work never finished'
          : 'nobody asked it to stop';
        const message = `runtime exited (code=${event.code} signal=${event.signal}) while stage ${stage?.index ?? '?'} was in flight; ${why}`;
        if (stage) {
          stage.errors.push(message);
          stage.state = 'failed';
          stage.endedAt = event.at;
        }
        record.errors.push(message);
        record.state = 'failed';
        this.clearBudget(task);
        this.settleWaiters(task);
        // The runtime is gone; sweep and record what is left so the failure carries evidence.
        void this.sweepAfterExit(task, 'runtime-exit');
      }
      this.touch(task);
      return;
    }

    const raw = event.params as {sessionId?: string; status?: string; event?: {type?: string; seq?: number; data?: Record<string, unknown>}} | null;
    const inner = raw?.event;
    const type = inner?.type ?? event.type;
    const data = (inner?.data ?? {}) as Record<string, unknown>;

    if (!SKIP_EVENT_TYPES.has(type)) {
      this.appendEvent(task, {at: event.at, kind: 'notification', method: event.method, type, params: scrub(event.params)});
    }

    const stage = record.stages[task.activeIndex - 1];
    if (type === 'session.status') {
      this.appendEvent(task, {at: event.at, kind: 'session/status', status: raw?.status ?? null});
      return;
    }
    if (!stage) return;

    switch (type) {
      case 'turn/start': {
        const turn = typeof data['turn'] === 'number' ? data['turn'] : null;
        if (turn !== null) stage.turn = turn;
        break;
      }
      case 'assistant/message': {
        const message = data['message'] as {content?: Array<{type?: string; text?: string}>} | undefined;
        const text = (message?.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('');
        if (text.length > 0) {
          const report = truncate(stage.modelReport + (stage.modelReport ? '\n' : '') + text, 200_000);
          stage.reportStorageTruncated ||= report.truncated;
          stage.modelReport = report.text;
        }
        if (data['usage']) stage.usage = scrub(data['usage']);
        break;
      }
      case 'tool/ptc-dispatch-start':
      case 'tool/call': {
        const callId = String((type === 'tool/ptc-dispatch-start' ? data['subCallId'] : data['callId']) ?? '');
        const args = data['arguments'];
        if (stage.toolObservations.length < LIMITS.toolEvidenceMax) {
          stage.toolObservations.push({
            callId, tool: String(data['name'] ?? 'unknown'),
            turn: typeof data['turn'] === 'number' ? data['turn'] : null,
            step: typeof data['step'] === 'number' ? data['step'] : null,
            startedAt: event.at,
            argumentsPreview: truncate(scrubText(typeof args === 'string' ? args : JSON.stringify(scrub(args ?? null))), LIMITS.toolPreviewMaxChars).text,
            finishedAt: null, isError: null, outputPreview: null,
          });
        }
        const tool = String(data['name'] ?? 'unknown');
        stage.toolCounts[tool] = (stage.toolCounts[tool] ?? 0) + 1;
        break;
      }
      case 'tool/ptc-dispatch':
      case 'tool/result': {
        const ptc = type === 'tool/ptc-dispatch';
        const callId = String((ptc ? data['subCallId'] : data['toolCallId'] ?? (data['message'] as {toolCallId?: string} | undefined)?.toolCallId) ?? '');
        const message = (ptc ? data : data['message']) as {content?: Array<{type?: string; text?: string}>; isError?: boolean} | undefined;
        const text = (message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
        const isError = message?.isError === true;
        const observation = stage.toolObservations.find((o) => o.callId === callId && o.finishedAt === null);
        if (observation) {
          observation.finishedAt = event.at;
          observation.isError = isError;
          observation.outputPreview = truncate(scrubText(text), LIMITS.toolPreviewMaxChars).text;
        }
        if (isError) stage.toolErrorCount++;
        break;
      }
      case 'approval/asked': {
        if (stage.approvals.length < 20) stage.approvals.push(scrub(data));
        break;
      }
      case 'llm/retry': {
        const failure = data['failure'] as {message?: string; code?: string} | undefined;
        if (stage.errors.length < 20) {
          stage.errors.push(`provider retry: ${scrubText(String(failure?.message ?? 'unknown'))} [${String(failure?.code ?? '?')}]`);
        }
        break;
      }
      case 'turn/end': {
        void this.onTurnEnd(task, stage, data, event.at);
        break;
      }
      default:
        break;
    }

    if (type === 'approval/asked') {
      record.state = 'blocked';
      // Wake anyone waiting on this stage. Without this the wait would block for its entire
      // timeout and only then report that the task had already settled as blocked.
      this.settleWaiters(task);
    }
    this.touch(task);
  }

  private async onTurnEnd(task: ManagedTask, stage: StageRecord, data: Record<string, unknown>, at: string): Promise<void> {
    const turn = typeof data['turn'] === 'number' ? data['turn'] : null;
    if (turn !== null && stage.turn !== null && turn !== stage.turn) return;
    if (stage.endedAt !== null) return;

    stage.turnEndReason = scrub(data['reason'] ?? null);
    stage.endedAt = at;
    this.clearBudget(task);

    const reason = data['reason'] as {kind?: string; error?: {message?: string; code?: string}} | undefined;
    const kind = reason?.kind ?? 'unknown';
    stage.outputLimitReached = ['max-tokens', 'max_tokens', 'length'].includes(kind);
    if (stage.outputLimitReached || stage.reportStorageTruncated) {
      stage.state = 'incomplete';
      task.record.state = 'incomplete';
    } else if (kind === 'completed') {
      stage.state = 'awaiting_review';
      task.record.state = 'awaiting_review';
    } else {
      const message = `turn ended with reason '${kind}': ${scrubText(String(reason?.error?.message ?? 'no error detail'))} [${String(reason?.error?.code ?? '?')}]`;
      stage.errors.push(message);
      stage.state = 'failed';
      task.record.errors.push(message);
      task.record.state = 'failed';
    }

    await this.finaliseStage(task, stage);
    this.settleWaiters(task);
  }

  /** Post-stage bridge observations: file diff first, then the optional real command. */
  private async finaliseStage(task: ManagedTask, stage: StageRecord): Promise<void> {
    const before = task.snapshot;
    const after = snapshotWorkspace(task.record.workspace);
    const changes = diffSnapshots(before, after);
    task.snapshot = after;
    stage.fileChanges = {
      added: changes.added.slice(0, LIMITS.fileChangeMax),
      modified: changes.modified.slice(0, LIMITS.fileChangeMax),
      removed: changes.removed.slice(0, LIMITS.fileChangeMax),
      unchangedCount: changes.unchangedCount,
    };

    if (task.record.verificationCommand && task.record.state !== 'cancelled') {
      stage.verification = await runCommand(
        task.record.verificationCommand, task.record.workspace, LIMITS.shutdownGraceMs * 20,
      );
    }

    if (stage.modelReport.length > 0) {
      const reportPath = path.join(task.record.taskDir, 'evidence', `stage-${stage.index}-report.md`);
      try { writeFileSync(reportPath, stage.modelReport, 'utf8'); stage.modelReportPath = reportPath; } catch { stage.modelReportPath = null; }
    }
    const resultPath = path.join(task.record.taskDir, 'evidence', `stage-${stage.index}-result.json`);
    try {
      writeFileSync(resultPath, JSON.stringify(this.buildStageResult(task, stage, true), null, 2), 'utf8');
      stage.resultPath = resultPath;
    } catch { stage.resultPath = null; }
    this.touch(task);
  }

  /* ------------- read APIs ------------- */

  status(taskId: string): TaskStatusView {
    const {record} = this.require(taskId);
    const stage = record.stages[record.stages.length - 1];
    return {
      taskId: record.taskId,
      state: record.state,
      reasoningPolicy: record.reasoningPolicy,
      effectiveParameters: {reasoningEffort: record.reasoningEffort, maxTokens: record.maxTokens, budgetMs: record.budgetMs},
      configurationWarnings: [...record.configurationWarnings],
      workspace: record.workspace,
      goal: record.goal,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      stageCount: record.stages.length,
      currentStage: stage
        ? {
          index: stage.index, state: stage.state, messageId: stage.messageId, turn: stage.turn,
          startedAt: stage.startedAt, endedAt: stage.endedAt,
          toolCalls: stage.toolObservations.length,
          toolErrors: stage.toolErrorCount,
          modelReportChars: stage.modelReport.length,
        }
        : null,
      runtimePid: record.runtimePid,
      runtimeAlive: this.tasks.get(taskId)!.runtime.alive,
      runtimeExit: record.runtimeExit,
      cancel: record.cancel,
      timeout: record.timeout,
      cleanupAfterExit: record.cleanupAfterExit,
      errors: record.errors.slice(-10),
      awaiting: LIVE_STATES.includes(record.state),
      canContinue: RESUMABLE_STATES.includes(record.state) && this.tasks.get(taskId)!.runtime.alive,
      note: 'awaiting_review means the runtime ended normally, NOT acceptance. incomplete means output was cut off; review partial work and continue the same live session explicitly.',
    };
  }

  async wait(taskId: string, timeoutMs: number): Promise<{outcome: 'settled' | 'timeout'; status: unknown; waitedMs: number}> {
    const task = this.require(taskId);
    const capped = Math.min(Math.max(1_000, timeoutMs), LIMITS.waitTimeoutMaxMs);
    const started = Date.now();
    if (!LIVE_STATES.includes(task.record.state)) {
      return {outcome: 'settled', status: this.status(taskId), waitedMs: 0};
    }
    await new Promise<void>((resolve) => {
      const waiter: Waiter = {
        resolve: () => resolve(),
        timer: setTimeout(() => { task.waiters.delete(waiter); resolve(); }, capped),
      };
      task.waiters.add(waiter);
    });
    const settled = !LIVE_STATES.includes(task.record.state);
    return {
      outcome: settled ? 'settled' : 'timeout',
      status: this.status(taskId),
      waitedMs: Date.now() - started,
    };
  }

  result(taskId: string, stageIndex?: number | undefined, verbose = false): StageResultView {
    const task = this.require(taskId);
    const {record} = task;
    const index = stageIndex ?? record.stages.length;
    const stage = record.stages.find((s) => s.index === index);
    if (!stage) {
      throw new BridgeError(
        `task ${taskId} has no stage ${index}; it has stages [${record.stages.map((s) => s.index).join(', ')}]`,
        'unknown_stage',
      );
    }
    return this.buildStageResult(task, stage, verbose);
  }

  private buildStageResult(task: ManagedTask, stage: StageRecord, verbose: boolean): StageResultView {
    const {record} = task;
    const report = truncate(stage.modelReport, LIMITS.modelReportMaxChars);
    const toolLimit = verbose ? LIMITS.toolEvidenceMax : 25;
    const observedTools = stage.toolObservations.slice(0, toolLimit).map((o) => ({
      tool: o.tool, step: o.step, callId: o.callId, startedAt: o.startedAt, finishedAt: o.finishedAt,
      isError: o.isError, argumentsPreview: o.argumentsPreview, outputPreview: o.outputPreview,
    }));
    const claims = claimVsEvidence(stage);
    return {
      taskId: record.taskId,
      stage: stage.index,
      reasoningPolicy: record.reasoningPolicy,
      effectiveParameters: {reasoningEffort: record.reasoningEffort, maxTokens: record.maxTokens, budgetMs: record.budgetMs},
      configurationWarnings: [...record.configurationWarnings],
      stageState: stage.state,
      taskState: record.state,
      turn: stage.turn,
      messageId: stage.messageId,
      startedAt: stage.startedAt,
      endedAt: stage.endedAt,

      modelReport: {
        source: 'model self-report, verbatim text blocks only; internal reasoning is never included',
        text: report.text,
        chars: stage.modelReport.length,
        truncated: report.truncated || stage.outputLimitReached || stage.reportStorageTruncated,
        previewTruncated: report.truncated,
        upstreamTruncated: stage.outputLimitReached,
        storageTruncated: stage.reportStorageTruncated,
        fullReportPath: stage.modelReportPath,
      },

      bridgeObserved: {
        source: 'recorded by the bridge from the SDK event stream and its own filesystem/command checks',
        turnEndReason: stage.turnEndReason,
        output: {
          status: stage.endedAt === null ? 'pending' : stage.outputLimitReached || stage.reportStorageTruncated ? 'incomplete' : (stage.turnEndReason as {kind?:string} | null)?.kind === 'completed' ? 'finished' : 'unknown',
          limitReached: stage.outputLimitReached, reportStorageTruncated: stage.reportStorageTruncated, maxTokens: record.maxTokens,
          note: 'finished describes generation only, never task acceptance; preview truncation is separate from provider output exhaustion',
        },
        toolCalls: observedTools,
        toolCallsTotal: stage.toolObservations.length,
        toolCounts: stage.toolCounts,
        toolErrorCount: stage.toolErrorCount,
        filesChanged: stage.fileChanges
          ? {
            ...stage.fileChanges,
            truncatedAt: LIMITS.fileChangeMax,
            snapshotTruncated: false,
            note: 'hash-based diff of the task workspace, taken before the stage and after turn/end',
          }
          : null,
        verificationCommand: stage.verification,
        verificationNote:
          'exitCode is the bridge\'s own observation of the verification command it ran itself. It is not model output and not acceptance.',
        approvalsRequested: stage.approvals,
        runtimeExit: record.runtimeExit,
        runtimePid: record.runtimePid,
        usage: stage.usage,
      },

      errors: stage.errors,
      claimsVsEvidence: claims,

      unresolved: buildUnresolved(task, stage, claims),
      artifacts: {
        taskDir: record.taskDir,
        eventsLog: path.join(record.taskDir, 'events.jsonl'),
        taskRecord: path.join(record.taskDir, 'task.json'),
        stageResult: stage.resultPath,
        modelReport: stage.modelReportPath,
      },
    };
  }

  /* ------------- cancel / shutdown ------------- */

  async cancel(taskId: string): Promise<CancelView> {
    const task = this.require(taskId);
    const {record} = task;
    if (record.state === 'cancelled') {
      return {
        taskId, cancelled: true, alreadyCancelled: true, method: record.cancel?.method, pid: record.cancel?.pid,
        note: 'evidence is preserved under the task dir',
        evidence: {taskDir: record.taskDir, eventsLog: path.join(record.taskDir, 'events.jsonl'), stageResult: null},
      };
    }
    const stage = record.stages[task.activeIndex - 1] ?? record.stages[record.stages.length - 1];
    const wasLive = stage !== undefined && LIVE_STATES.includes(record.state);
    this.clearBudget(task);
    // Flag the teardown BEFORE stopping: the exit that follows is this bridge's own doing and must
    // not later be read back as "the runtime crashed mid-stage".
    task.teardown = 'cancel';
    const stopped = await task.runtime.stop();
    task.unsubscribe();

    // Verify the stop, do not just record the intent.
    const pidAlive = DshRuntime.pidAlive(stopped.pid);
    // A gone parent pid is NOT proof that the task stopped: tool subprocesses share the process
    // group and can outlive their parent. The sweep result decides the full claim.
    const verified = stopped.stopped && !pidAlive;
    const fullyVerified = verified && stopped.treeVerified && (stopped.survivorPids ?? []).length === 0;

    if (stage && wasLive) {
      stage.state = 'cancelled';
      stage.endedAt = new Date().toISOString();
      stage.errors.push(
        'cancelled: this SDK build exposes no per-turn cancel, so the bridge stopped the task\'s own SDK process. ' +
        'The turn may have been interrupted part-way through.',
      );
    }
    record.state = 'cancelled';
    record.runtimePid = stopped.pid;
    record.cancel = {
      at: new Date().toISOString(), stopped: fullyVerified, method: stopped.method, pid: stopped.pid,
      note: fullyVerified
        ? 'verified: the SDK process for this task and every process captured from it are gone'
        : !verified
          ? 'NOT verified: the SDK process could not be confirmed gone; check the pid manually'
          : !stopped.treeVerified
            ? 'PARTIAL: the SDK process is gone, but this platform cannot enumerate the task process tree, so descendants are UNVERIFIED'
            : `PARTIAL: the SDK process is gone but ${(stopped.survivorPids ?? []).length} captured task process(es) survived the sweep`,
    };
    if (!verified && stopped.pid !== null) {
      record.errors.push(`cancel could not verify that pid ${stopped.pid} exited`);
    }

    // Partial modifications must be reported, not implied. Only a turn that is still in flight has
    // partial modifications to report: once finaliseStage() has run, task.snapshot already IS the
    // post-turn state, so a diff recomputed here is always empty — and writing it back would erase
    // the stage's real diff from evidence/stage-N-result.json, which is exactly what happened to a
    // real acceptance task that created a file and was cancelled after it settled.
    if (stage && stage.fileChanges === null) {
      const after = snapshotWorkspace(record.workspace);
      const changes = diffSnapshots(task.snapshot, after);
      task.snapshot = after;
      stage.fileChanges = {
        added: changes.added.slice(0, LIMITS.fileChangeMax),
        modified: changes.modified.slice(0, LIMITS.fileChangeMax),
        removed: changes.removed.slice(0, LIMITS.fileChangeMax),
        unchangedCount: changes.unchangedCount,
      };
    }
    const resultPath = stage ? path.join(record.taskDir, 'evidence', `stage-${stage.index}-result.json`) : null;
    if (stage && resultPath) {
      try { writeFileSync(resultPath, JSON.stringify(this.buildStageResult(task, stage, true), null, 2), 'utf8'); stage.resultPath = resultPath; } catch { /* ignore */ }
    }
    this.touch(task);
    this.settleWaiters(task);

    return {
      taskId,
      cancelled: true,
      runtimeStopped: verified,
      fullyStopped: fullyVerified,
      treeVerified: stopped.treeVerified,
      survivorPids: stopped.survivorPids,
      method: stopped.method,
      pid: stopped.pid,
      runtimeStderrPreview: stopped.stderrPreview.slice(-1_000),
      partialFileChanges: stage?.fileChanges ?? null,
      note:
        'Files may already have been modified before the stop. The diff above is what the bridge actually observed: ' +
        `${wasLive ? 'the partial changes of the turn this stop interrupted' : 'the diff this stage recorded at its own turn end'}. ` +
        `Process tree: ${stopped.note}`,
      evidence: {
        taskDir: record.taskDir,
        eventsLog: path.join(record.taskDir, 'events.jsonl'),
        stageResult: resultPath,
      },
    };
  }

  async shutdownAll(): Promise<Array<{taskId: string; stopped: boolean; method: string}>> {
    this.shuttingDown = true;
    const out: Array<{taskId: string; stopped: boolean; method: string}> = [];
    for (const task of this.tasks.values()) {
      if (!task.runtime.alive && !LIVE_STATES.includes(task.record.state)) continue;
      this.clearBudget(task);
      // A shutdown is NOT a cancel. It used to reuse the cancel flag, which suppressed the failure
      // marking for a stage still in flight and left the record persisted as `running` (linux-05).
      task.teardown = 'shutdown';
      const stopped = await task.runtime.stop();
      out.push({taskId: task.record.taskId, stopped: stopped.stopped, method: stopped.method});
    }
    return out;
  }
}

/* ------------------------------------------------------------------ helpers */

function normaliseCommand(input: string[] | undefined): string[] | null {
  if (!input || input.length === 0) return null;
  if (input.length > 32) throw new BridgeError('verificationCommand has too many elements (max 32)', 'invalid_command');
  const parts = input.map((part) => String(part));
  if (parts.some((part) => part.length === 0)) throw new BridgeError('verificationCommand elements must be non-empty', 'invalid_command');
  if (parts[0]!.length > 512) throw new BridgeError('verificationCommand[0] is too long', 'invalid_command');
  return parts;
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

/**
 * Flags the classic "the model says it passed" gap. It never upgrades a claim to a fact —
 * it only points out when the bridge saw no supporting tool evidence at all.
 */
function claimVsEvidence(stage: StageRecord): {claimOnly: string[]; supported: string[]} {
  const text = stage.modelReport.toLowerCase();
  const claimOnly: string[] = [];
  const supported: string[] = [];
  const claimsTests = /\b(test|tests|pass|passed|green|通过|测试)\b/.test(text);
  if (claimsTests) {
    if (stage.toolObservations.length === 0) {
      claimOnly.push('the report talks about tests but the bridge recorded zero tool calls in this stage');
    } else {
      supported.push(`the report talks about tests and the bridge recorded ${stage.toolObservations.length} tool call(s); read toolErrorCount and the verification command before trusting it`);
    }
  }
  if (stage.toolErrorCount > 0) {
    claimOnly.push(`the bridge recorded ${stage.toolErrorCount} tool result(s) flagged isError=true in this stage`);
  }
  if (stage.approvals.length > 0) {
    claimOnly.push(`${stage.approvals.length} approval request(s) were raised; the bridge did not auto-approve anything`);
  }
  return {claimOnly, supported};
}

function buildUnresolved(task: ManagedTask, stage: StageRecord, claims: {claimOnly: string[]}): string[] {
  const out: string[] = [...claims.claimOnly];
  if (stage.outputLimitReached) out.push(`model output hit maxTokens=${task.record.maxTokens}; the stage is incomplete, partial files are preserved, and a live session may be continued explicitly`);
  if (stage.reportStorageTruncated) out.push('bridge report storage limit reached; the recorded report is incomplete');
  if (stage.modelReport.length > LIMITS.modelReportMaxChars) out.push('the displayed report is a preview; read fullReportPath for the complete recorded text');
  out.push(...task.record.configurationWarnings);
  if (task.record.verificationCommand === null) {
    out.push('no verificationCommand was supplied, so the bridge ran no independent check of this stage');
  }
  if (stage.verification && stage.verification.exitCode !== 0) {
    out.push(`the bridge's own verification command exited ${stage.verification.exitCode ?? stage.verification.signal ?? 'unknown'}`);
  }
  if (stage.fileChanges && stage.fileChanges.added.length === 0 && stage.fileChanges.modified.length === 0) {
    out.push('the bridge observed no file changes in the workspace for this stage');
  }
  if (task.record.runtimeExit) {
    out.push(`the runtime exited (code=${task.record.runtimeExit.code} signal=${task.record.runtimeExit.signal})`);
  }
  if (stage.state !== 'awaiting_review') {
    out.push(`stage state is ${stage.state}, not awaiting_review`);
  }
  out.push('the bridge cannot confirm the model obeyed any constraint that it did not enforce programmatically');
  return out;
}

/** Informational only: this bridge does NOT restore tasks across restarts. */
export function previousRunDirs(): {count: number; root: string; resumable: boolean; note: string} {
  const root = path.join(DATA_ROOT, 'tasks');
  let count = 0;
  try {
    count = existsSync(root) ? readdirSync(root, {withFileTypes: true}).filter((d) => d.isDirectory()).length : 0;
  } catch { count = 0; }
  return {
    count, root, resumable: false,
    note: 'Each run writes a fresh task record. This build does NOT restore or resume tasks from disk after a restart; do not read a previous task dir as a live task.',
  };
}

export function canonicalWorkspace(p: string): string {
  return realpathSync.native(p);
}
