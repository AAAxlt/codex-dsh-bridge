/**
 * In-flight cancellation against the REAL DSH SDK runtime and the REAL model route.
 *
 * Why this script exists: the earlier cancellations (`linux-04`, `linux-06`) were issued after the
 * turn had already finished, so the bridge's own evidence read `tree-swept(1)` — it stopped the
 * runtime and nothing else. That proves tidy post-turn cleanup, not that a task was torn down
 * *while it was working*. This script cancels while a tool subprocess is genuinely alive.
 *
 * How it proves that, without trusting the bridge:
 *   1. it reads /proc itself and finds a live DESCENDANT of the runtime pid (the tool subprocess),
 *      pinning its pid + start time — an independent witness the bridge never sees;
 *   2. it waits until that witness has been alive for a while, and until the bridge still reports the
 *      task as live, then calls dsh_cancel_task;
 *   3. immediately after, it re-probes /proc with its OWN implementation (not the bridge's sweep) and
 *      requires the witness, the runtime pid, and any other process started after the runtime and
 *      matching the command pattern to be gone;
 *   4. it also records what the bridge claims, and requires the bridge to have captured MORE than the
 *      runtime alone (`tree-swept(N)`, N >= 2) — the exact thing linux-04 could not show.
 *
 *   node scripts/e2e-cancel.mjs --run-id <id> [--pattern sleep] [--witness-wait-ms 180000]
 *                               [--witness-stable-ms 2000] [--goal-file <path>] [--self-test]
 *
 * `--self-test` exercises the /proc witness + survivor probe against a real `sleep` child of this
 * process, with no MCP client and no model, so the probe is proven before any paid run relies on it.
 *
 * This script costs a model request (one stage). It is therefore a script, not part of `npm test`.
 */
import {appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

/* ------------------------------------------------------------------ args */

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const RUN_ID = arg('run-id', `cancel-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const PATTERN = arg('pattern', 'sleep');
const WITNESS_WAIT_MS = Number(arg('witness-wait-ms', '180000'));
const WITNESS_STABLE_MS = Number(arg('witness-stable-ms', '2000'));
const SELF_TEST = process.argv.includes('--self-test');
const RECHECK = process.argv.includes('--recheck');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_MAIN = path.join(REPO_ROOT, 'dist', 'src', 'main.js');
const E2E_ROOT = process.env['DSH_BRIDGE_E2E_ROOT'] ??
  (process.platform === 'win32' ? 'D:\\AGENTS\\temp' : path.join(os.homedir(), 'projects', '_e2e'));
const WORKSPACE = path.join(E2E_ROOT, 'codex-dsh-bridge-e2e', RUN_ID);
const EVIDENCE = path.join(E2E_ROOT, 'codex-dsh-bridge-e2e', `${RUN_ID}-evidence`);
const TIMELINE = path.join(EVIDENCE, 'timeline.jsonl');
mkdirSync(WORKSPACE, {recursive: true});
mkdirSync(EVIDENCE, {recursive: true});

function stamp(kind, detail = {}) {
  const entry = {at: new Date().toISOString(), kind, ...detail};
  appendFileSync(TIMELINE, `${JSON.stringify(entry)}\n`);
  console.log(`[${entry.at}] ${kind} ${JSON.stringify(detail).slice(0, 400)}`);
  return entry;
}

function save(name, value) {
  writeFileSync(path.join(EVIDENCE, name), `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonIfPresent(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result) => (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
function jsonOf(result) {
  const block = (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').find((t) => t.startsWith('```json'));
  if (!block) throw new Error(`no JSON payload in reply: ${textOf(result).slice(0, 300)}`);
  return JSON.parse(block.replace(/^```json\n/, '').replace(/\n```$/, ''));
}

/* ------------------------------------------------- independent /proc probe */

/**
 * Deliberately a separate implementation from the bridge's: this is the witness the bridge is
 * checked against, so it must not share code, state or assumptions with it.
 */
function procStat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    // state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime
    // cstime priority nice num_threads itrealvalue starttime
    return {state: rest[0], ppid: Number(rest[1]), pgrp: Number(rest[2]), starttime: rest[19]};
  } catch {
    return null;
  }
}

function cmdlineOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

function allPids() {
  try {
    return readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
  } catch {
    return [];
  }
}

/** pid -> parent pid, from a single snapshot. */
function parentMap() {
  const map = new Map();
  for (const pid of allPids()) {
    const stat = procStat(pid);
    if (stat) map.set(pid, stat.ppid);
  }
  return map;
}

function ancestorsOf(pid) {
  const map = parentMap();
  const chain = new Set([pid]);
  let cursor = pid;
  for (let hops = 0; hops < 64; hops += 1) {
    const parent = map.get(cursor);
    if (!parent || parent <= 1 || chain.has(parent)) break;
    chain.add(parent);
    cursor = parent;
  }
  return chain;
}

function descendantsOf(rootPid) {
  const map = parentMap();
  const children = new Map();
  for (const [pid, ppid] of map) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Alive AND still the same process (a recycled pid has a different start time). */
function stillTheSameProcess(pid, starttime) {
  const stat = procStat(pid);
  return stat !== null && stat.state !== 'Z' && stat.starttime === starttime;
}

function findWitness(rootPid, pattern) {
  const hits = [];
  for (const pid of descendantsOf(rootPid)) {
    const cmdline = cmdlineOf(pid);
    const stat = procStat(pid);
    if (!stat || stat.state === 'Z') continue;
    if (!cmdline.includes(pattern)) continue;
    hits.push({pid, ppid: stat.ppid, pgrp: stat.pgrp, starttime: stat.starttime, cmdline: cmdline.slice(0, 300)});
  }
  return hits;
}

/**
 * Every process that looks like the cancelled command and started AFTER the runtime did, excluding
 * this probe's own process chain (which legitimately mentions the pattern in its argv).
 */
function commandSurvivors(runtimeStarttime, pattern) {
  const exempt = ancestorsOf(process.pid);
  const out = [];
  for (const pid of allPids()) {
    if (exempt.has(pid)) continue;
    const stat = procStat(pid);
    if (!stat || stat.state === 'Z') continue;
    if (runtimeStarttime !== null && Number(stat.starttime) <= Number(runtimeStarttime)) continue;
    const cmdline = cmdlineOf(pid);
    if (!cmdline.includes(pattern)) continue;
    out.push({pid, ppid: stat.ppid, starttime: stat.starttime, cmdline: cmdline.slice(0, 200)});
  }
  return out;
}

/* ---------------------------------------------------------------- self-test */

if (SELF_TEST) {
  // A real child, found by the same witness search, then proven gone by the same survivor scan.
  const child = spawn('sleep', ['45'], {stdio: 'ignore'});
  const rootPid = process.pid;
  let witness = null;
  for (let i = 0; i < 40 && witness === null; i += 1) {
    await sleep(100);
    [witness] = findWitness(rootPid, 'sleep');
  }
  const runtimeStart = procStat(rootPid)?.starttime ?? null;
  const before = witness === null ? [] : [
    {pid: witness.pid, alive: stillTheSameProcess(witness.pid, witness.starttime)},
  ];
  child.kill('SIGKILL');
  await sleep(400);
  const after = witness === null ? [] : [
    {pid: witness.pid, alive: stillTheSameProcess(witness.pid, witness.starttime)},
  ];
  const leftovers = commandSurvivors(runtimeStart, 'sleep');
  const ok = witness !== null && before[0].alive === true && after[0].alive === false && leftovers.length === 0;
  const report = {
    ok,
    witness,
    before,
    after,
    survivorsByScan: leftovers,
    checks: {
      'witness-found': witness !== null,
      'witness-was-alive': before[0]?.alive === true,
      'witness-gone-after-kill': after[0]?.alive === false,
      'scan-found-no-survivors': leftovers.length === 0,
      'probe-exempts-its-own-chain': ancestorsOf(process.pid).has(process.pid),
    },
  };
  save('self-test.json', report);
  console.log(JSON.stringify(report, null, 2));
  console.log(ok ? 'CANCEL_PROBE_SELF_TEST_OK' : 'CANCEL_PROBE_SELF_TEST_FAILED');
  process.exit(ok ? 0 : 1);
}

/* ------------------------------------------------------------ the verdict */

function capturedFrom(method) {
  return Number(/tree-swept\((\d+)\)/.exec(String(method ?? ''))?.[1] ?? '0');
}

/**
 * The whole decision, as a pure function of the recorded evidence, so the verdict can be recomputed
 * from disk (`--recheck`) without spending another model request. Field names come from the bridge's
 * actual replies: dsh_cancel_task reports `cancelled`/`runtimeStopped`/`fullyStopped`/`treeVerified`/
 * `survivorPids`/`method`/`pid` — NOT `stopped`/`pidStillAlive` (those live in the persisted record's
 * `cancel` object, which is why both are checked).
 */
function evaluateCriteria(d) {
  const captured = capturedFrom(d.cancelled.method);
  const onDiskStopped = d.persisted?.cancel?.stopped === true;
  return [
    ['witness-alive-before-cancel', d.witness !== null && d.witnessAliveBeforeCancel === true,
      d.witness === null ? 'no live tool subprocess was found in /proc before the cancel' : `pid ${d.witness.pid} alive for >= ${WITNESS_STABLE_MS}ms: ${d.witness.cmdline}`],
    ['task-was-live-at-cancel', ['accepted', 'starting', 'running'].includes(d.preStatus.state),
      `bridge reported state=${d.preStatus.state}, runtimeAlive=${d.preStatus.runtimeAlive}`],
    ['bridge-reported-stopped', d.cancelled.cancelled === true && d.cancelled.runtimeStopped === true && onDiskStopped,
      `cancelled=${d.cancelled.cancelled} runtimeStopped=${d.cancelled.runtimeStopped} on-disk cancel.stopped=${onDiskStopped}`],
    ['bridge-verified-the-tree', d.cancelled.treeVerified === true && Array.isArray(d.cancelled.survivorPids) && d.cancelled.survivorPids.length === 0,
      `treeVerified=${d.cancelled.treeVerified} survivorPids=${JSON.stringify(d.cancelled.survivorPids)}`],
    ['bridge-fully-stopped', d.cancelled.fullyStopped === true, `fullyStopped=${d.cancelled.fullyStopped} method=${d.cancelled.method}`],
    ['captured-more-than-the-runtime', captured >= 2,
      `the bridge's own method says tree-swept(${captured}); in-flight means the tool subprocess must have been captured too`],
    ['witness-gone-after-cancel', d.witness !== null && d.probes.length > 0 && d.probes.every((p) => p.witnessAlive === false),
      `witness ${d.witness?.pid ?? 'n/a'} alive states: ${JSON.stringify(d.probes.map((p) => p.witnessAlive))}`],
    ['runtime-gone-after-cancel', d.runtimePid !== null && d.probes.length > 0 && d.probes.every((p) => p.runtimeAlive === false),
      `runtime ${d.runtimePid} alive states: ${JSON.stringify(d.probes.map((p) => p.runtimeAlive))}`],
    ['independent-scan-found-no-survivors', d.probes.length > 0 && d.probes.every((p) => p.survivorsByScan.length === 0),
      `this script's own /proc scan (not the bridge's sweep): ${JSON.stringify(d.probes.at(-1)?.survivorsByScan ?? null)}`],
    ['task-record-not-live', !['accepted', 'starting', 'running'].includes(d.postStatus.state) && d.persisted !== null && d.persisted.state === 'cancelled',
      `wire state=${d.postStatus.state}, on-disk state=${d.persisted?.state ?? 'unread'}`],
  ].map(([id, ok, detail]) => ({id, ok: ok === true, detail}));
}

/* ---------------------------------------------------------------- recheck */

if (RECHECK) {
  // Recompute the verdict from the evidence already on disk. A bug in this script's checker must not
  // force another paid run, and anyone must be able to re-derive the verdict from the files alone.
  const flight = readJsonIfPresent(path.join(EVIDENCE, 'cancel-flight.json'));
  const cancelled = readJsonIfPresent(path.join(EVIDENCE, 'cancel.json'));
  const probes = readJsonIfPresent(path.join(EVIDENCE, 'independent-probe.json'));
  const preStatus = readJsonIfPresent(path.join(EVIDENCE, 'pre-cancel-status.json'));
  const postStatus = readJsonIfPresent(path.join(EVIDENCE, 'post-cancel-status.json'));
  const persisted = readJsonIfPresent(path.join(EVIDENCE, 'persisted-task.json'));
  const submit = readJsonIfPresent(path.join(EVIDENCE, 'submit.json'));
  const missing = [
    ['cancel.json', cancelled], ['independent-probe.json', probes], ['pre-cancel-status.json', preStatus],
    ['post-cancel-status.json', postStatus], ['cancel-flight.json', flight], ['submit.json', submit],
  ].filter(([, value]) => value === null).map(([name]) => name);
  if (missing.length > 0) throw new Error(`cannot recheck ${EVIDENCE}: missing or unreadable ${missing.join(', ')}`);

  const criteria = evaluateCriteria({
    witness: flight.witness,
    witnessAliveBeforeCancel: flight.witnessAliveBeforeCancel,
    preStatus, cancelled, probes, postStatus, persisted,
    runtimePid: submit.runtimePid ?? flight.runtimePid ?? null,
  });
  const failed = criteria.filter((c) => !c.ok).map((c) => c.id);
  const out = {
    runId: RUN_ID, recheckedAt: new Date().toISOString(), evidenceDir: EVIDENCE,
    recomputedFrom: ['cancel.json', 'independent-probe.json', 'pre-cancel-status.json', 'post-cancel-status.json', 'persisted-task.json', 'cancel-flight.json', 'submit.json'],
    capturedProcesses: capturedFrom(cancelled.method), criteria, ok: failed.length === 0, failed,
  };
  save('recheck.json', out);
  for (const c of criteria) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.detail}`);
  console.log(out.ok
    ? `CANCEL_IN_FLIGHT_ACCEPTED (recomputed from disk: witness=${flight.witness?.pid ?? 'n/a'}, captured=${out.capturedProcesses})`
    : `CANCEL_IN_FLIGHT_NOT_ACCEPTED (recomputed from disk) failed=${failed.join(',')}`);
  process.exit(out.ok ? 0 : 1);
}

/* ------------------------------------------------------------------ the run */

function goalFileText() {
  const file = arg('goal-file');
  return file ? readFileSync(file, 'utf8') : null;
}

const GOAL = goalFileText() ?? [
  'Run exactly one shell command and wait for it to finish.',
  '',
  'Use your shell/command tool to run this in the current working directory:',
  '',
  '    sleep 600',
  '',
  'Run it in the FOREGROUND: do not add "&", do not background it, do not add a timeout, and do not',
  'split it into smaller sleeps. Do not create, read or modify any file. Wait for the command to',
  'return before you answer, then report the exit code you observed.',
].join('\n');

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('refusing to run: the independent witness reads /proc, and the bridge only verifies a task process tree on Linux');
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE_MAIN],
    env: {...process.env, DSH_BRIDGE_ALLOWED_ROOTS: E2E_ROOT},
    cwd: WORKSPACE,
    stderr: 'pipe',
  });
  let stderrText = '';
  transport.stderr?.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });
  const client = new Client({name: 'codex-cancel-in-flight', version: '1.0.0'}, {capabilities: {}});
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({name, arguments: args}, {timeout: 180_000});
    if (result.isError === true) throw new Error(`${name} failed: ${textOf(result)}`);
    return result;
  };

  const caps = jsonOf(await call('dsh_get_capabilities', {}));
  save('capabilities.json', caps);
  stamp('capabilities', {
    cliEntry: caps.communityEdition?.cliEntry,
    cliEntryKind: caps.communityEdition?.cliEntryKind,
    provider: caps.modelRoute?.provider,
    model: caps.modelRoute?.model,
    credentialPresent: caps.credential?.present,
  });
  if (caps.communityEdition?.cliEntryKind !== 'real-dsh') {
    throw new Error(`refusing to run: this must exercise the real runtime (cliEntryKind=${caps.communityEdition?.cliEntryKind})`);
  }

  const submitted = jsonOf(await call('dsh_submit_task', {
    workspace: WORKSPACE,
    goal: GOAL,
    context: 'This stage is cancelled on purpose while it is working. It is not expected to finish.',
    constraints: ['Only work inside the working directory.', 'Do not create files.'],
    reasoningEffort: 'low',
    maxTokens: 1024,
    budgetMs: 600_000,
  }));
  save('submit.json', submitted);
  stamp('submitted', {taskId: submitted.taskId, sessionId: submitted.sessionId, runtimePid: submitted.runtimePid});

  const taskId = submitted.taskId;
  const runtimePid = submitted.runtimePid;
  const runtimeStarttime = runtimePid === null ? null : (procStat(runtimePid)?.starttime ?? null);

  /* ---- find a live tool subprocess, and wait until it is genuinely working ---- */
  let witness = null;
  let stableSince = null;
  const deadline = Date.now() + WITNESS_WAIT_MS;
  while (Date.now() < deadline) {
    const [hit] = findWitness(runtimePid, PATTERN);
    if (hit && (witness === null || hit.pid !== witness.pid)) {
      witness = hit;
      stableSince = Date.now();
      stamp('witness-appeared', {...hit, stableForMs: 0});
    } else if (hit && witness !== null && hit.pid === witness.pid) {
      if (Date.now() - stableSince >= WITNESS_STABLE_MS) break;
    } else if (!hit && witness !== null) {
      stamp('witness-disappeared-before-cancel', {pid: witness.pid, note: 'the tool subprocess ended on its own; cannot prove an in-flight cancel'});
      witness = null;
      stableSince = null;
    }
    await sleep(150);
  }

  const witnessAliveBeforeCancel = witness !== null && stillTheSameProcess(witness.pid, witness.starttime);
  const preStatus = jsonOf(await call('dsh_get_task', {taskId}));
  save('pre-cancel-status.json', preStatus);
  stamp('pre-cancel', {
    witnessPid: witness?.pid ?? null,
    witnessCmdline: witness?.cmdline ?? null,
    witnessStarttime: witness?.starttime ?? null,
    witnessAlive: witnessAliveBeforeCancel,
    stableForMs: stableSince === null ? 0 : Date.now() - stableSince,
    bridgeState: preStatus.state,
    bridgeRuntimeAlive: preStatus.runtimeAlive,
  });

  /* ---- cancel, while it is working ---- */
  const cancelled = jsonOf(await call('dsh_cancel_task', {taskId}));
  save('cancel.json', cancelled);
  stamp('cancelled', {
    runtimeStopped: cancelled.runtimeStopped, stopped: cancelled.stopped, method: cancelled.method,
    treeVerified: cancelled.treeVerified, survivorPids: cancelled.survivorPids,
    fullyStopped: cancelled.fullyStopped, pidStillAlive: cancelled.pidStillAlive, note: cancelled.note,
  });

  /* ---- independent verification, twice, with our own implementation ---- */
  const probes = [];
  for (const delayMs of [0, 1200]) {
    if (delayMs > 0) await sleep(delayMs);
    probes.push({
      at: new Date().toISOString(),
      delayMs,
      witnessAlive: witness === null ? null : stillTheSameProcess(witness.pid, witness.starttime),
      runtimeAlive: runtimePid === null ? null : (procStat(runtimePid) !== null),
      survivorsByScan: commandSurvivors(runtimeStarttime, PATTERN),
    });
  }
  save('independent-probe.json', probes);
  stamp('independent-probe', {
    witnessAliveNow: probes.at(-1).witnessAlive,
    runtimeAliveNow: probes.at(-1).runtimeAlive,
    survivorsByScan: probes.at(-1).survivorsByScan,
  });

  const postStatus = jsonOf(await call('dsh_get_task', {taskId}));
  save('post-cancel-status.json', postStatus);

  // The durable record the bridge wrote to disk, not just the reply over the wire.
  const taskRoot = typeof caps.persistentRuns?.root === 'string' ? caps.persistentRuns.root : null;
  const persisted = taskRoot === null ? null : readJsonIfPresent(path.join(taskRoot, taskId, 'task.json'));
  if (persisted !== null) save('persisted-task.json', persisted);

  const captured = capturedFrom(cancelled.method);
  const criteria = evaluateCriteria({witness, witnessAliveBeforeCancel, preStatus, cancelled, probes, runtimePid, persisted});

  const failed = criteria.filter((c) => !c.ok).map((c) => c.id);
  const report = {
    runId: RUN_ID, at: new Date().toISOString(),
    taskId, sessionId: submitted.sessionId, runtimePid,
    witness, witnessAliveBeforeCancel, capturedProcesses: captured,
    bridgeCancel: cancelled, probes, postCancelState: postStatus.state, persistedState: persisted?.state ?? null,
    criteria, ok: failed.length === 0, failed,
    bridgeStderr: stderrText.slice(-2000),
    evidenceDir: EVIDENCE,
  };
  save('cancel-flight.json', report);

  try { await client.close(); } catch { /* the bridge may already be gone */ }

  for (const c of criteria) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.detail}`);
  if (report.ok) {
    console.log(`CANCEL_IN_FLIGHT_ACCEPTED  witness=${witness.pid} captured=${captured} method=${cancelled.method}`);
  } else {
    console.log(`CANCEL_IN_FLIGHT_NOT_ACCEPTED  failed=${failed.join(',')}`);
  }
  process.exit(report.ok ? 0 : 1);
}

await main();
