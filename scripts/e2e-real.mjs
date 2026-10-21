/**
 * Real end-to-end loop against the REAL DSH SDK runtime and the REAL opencode-go/deepseek-flash
 * route. This one costs model requests, so it is a script and not part of `npm test`.
 *
 * It deliberately pauses between stage 1 and stage 2 and waits for a review file to appear, so the
 * second stage is driven by a review that was actually written after reading stage 1's evidence
 * rather than by a canned string baked into this script.
 *
 *   node scripts/e2e-real.mjs --run-id <id> [--review-file <path>] [--review-wait-ms <ms>]
 *
 * Everything it observes is written under <dataRoot>/e2e/<run-id>/.
 */
import {appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {buildSummary, buildVerdict} from './lib/e2e-verdict.mjs';

/* ------------------------------------------------------------------ args */

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const RUN_ID = arg('run-id', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_MAIN = path.join(REPO_ROOT, 'dist', 'src', 'main.js');
/**
 * The run's workspace must live inside one of the bridge's allowed roots. It is derived
 * per-platform and then STATED to the bridge explicitly, so this run can never inherit a
 * shell's allowed-roots list and quietly test something other than what it reports.
 */
const E2E_ROOT = process.env['DSH_BRIDGE_E2E_ROOT'] ??
  (process.platform === 'win32' ? 'D:\\AGENTS\\temp' : path.join(os.homedir(), 'projects', '_e2e'));
const WORKSPACE = path.join(E2E_ROOT, 'codex-dsh-bridge-e2e', RUN_ID);
const EVIDENCE = path.join(E2E_ROOT, 'codex-dsh-bridge-e2e', `${RUN_ID}-evidence`);
const REVIEW_FILE = arg('review-file', path.join(EVIDENCE, 'stage-2-review.txt'));
const REVIEW_WAIT_MS = Number(arg('review-wait-ms', '900000'));
let WAIT_PER_CALL_MS = 120_000;
/**
 * Per-request timeout this driver gives the MCP client. It must exceed the bridge's wait window
 * (limits.waitTimeoutMaxMs) or the client aborts a long wait with "Request timed out" while the
 * bridge is still perfectly healthy. Replaced by the published floor once capabilities are read.
 */
let CLIENT_REQUEST_TIMEOUT_MS = 90_000;
const STAGE_DEADLINE_MS = 600_000;
/** Runs the driver's own summary + verdict branch with synthetic facts, no MCP client, no model. */
const SELF_CHECK = process.argv.includes('--self-check');

function sha256File(file) {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return null; }
}

function readJsonIfPresent(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * The evidence the BRIDGE persisted for this task, read straight off disk. Comparing what the
 * bridge wrote before and after stage 2 is what proves stage 1 was not overwritten; comparing the
 * model's text and an exit code over the wire does not.
 */
function taskEvidence(taskRoot, taskId) {
  const dir = path.join(taskRoot, taskId);
  const record = readJsonIfPresent(path.join(dir, 'task.json'));
  const stageFile = (n) => path.join(dir, 'evidence', `stage-${n}-result.json`);
  const reportFile = (n) => path.join(dir, 'evidence', `stage-${n}-report.md`);
  return {
    dir,
    sessionId: record?.sessionId ?? null,
    runtimePid: record?.runtimePid ?? null,
    recordedStages: Array.isArray(record?.stages) ? record.stages.length : 0,
    hashes: {
      stage1Result: sha256File(stageFile(1)),
      stage1Report: sha256File(reportFile(1)),
      stage2Result: sha256File(stageFile(2)),
      stage2Report: sha256File(reportFile(2)),
    },
  };
}

mkdirSync(WORKSPACE, {recursive: true});
mkdirSync(EVIDENCE, {recursive: true});
const TIMELINE = path.join(EVIDENCE, 'timeline.jsonl');

function stamp(kind, detail = {}) {
  const entry = {at: new Date().toISOString(), kind, ...detail};
  appendFileSync(TIMELINE, `${JSON.stringify(entry)}\n`);
  console.log(`[${entry.at}] ${kind} ${JSON.stringify(detail).slice(0, 400)}`);
  return entry;
}

function save(name, value) {
  const file = path.join(EVIDENCE, name);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
  return file;
}

/**
 * The cancel facts the run summary consumes.
 *
 * This is a named function rather than an inline object literal on purpose. The defect it replaces
 * (`pidStillAlive` used as a shorthand where the variable is `pidAlive`) sat in an inline literal:
 * `node --check`, `tsc` and even `--self-check` all accepted it, because not one of them ever
 * EVALUATED that expression, and only a paid two-stage run ever did. Routing the literal through a
 * function that the self-check also calls means the same expression is evaluated for free on every
 * build, and `test/e2e-verdict.test.ts` asserts the value it produced.
 */
function cancelFacts(cancelled, probePidAlive) {
  return {
    runtimeStopped: cancelled.runtimeStopped,
    fullyStopped: cancelled.fullyStopped === true,
    treeVerified: cancelled.treeVerified,
    survivorPids: cancelled.survivorPids,
    method: cancelled.method,
    pidStillAlive: probePidAlive,
  };
}

/* ------------------------------------------------------------------ MCP plumbing */

function textOf(result) {
  return (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
}

function jsonOf(result) {
  const blocks = (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '');
  const fenced = blocks.find((b) => b.startsWith('```json'));
  if (!fenced) throw new Error(`no JSON payload: ${blocks.join(' | ').slice(0, 500)}`);
  return JSON.parse(fenced.replace(/^```json\n/, '').replace(/\n```$/, ''));
}

let client;
let stderrText = '';

async function call(name, args) {
  // The client's own per-request timeout, NOT the bridge's wait window, is what killed linux-05:
  // the driver asked the bridge to block for 120s while the MCP client aborted at its 60s SDK
  // default. The bridge publishes the floor a client must use; until capabilities have been read,
  // assume the SDK default plus margin rather than the default itself.
  const result = await client.callTool({name, arguments: args}, {timeout: CLIENT_REQUEST_TIMEOUT_MS});
  if (result.isError === true) throw new Error(`${name} failed: ${textOf(result)}`);
  return result;
}

async function waitForStage(taskId) {
  const started = Date.now();
  for (;;) {
    const outcome = jsonOf(await call('dsh_wait_task', {taskId, timeoutMs: WAIT_PER_CALL_MS}));
    stamp('wait', {taskId, outcome: outcome.outcome, state: outcome.status.state, waitedMs: outcome.waitedMs});
    if (outcome.outcome === 'settled') return outcome;
    if (Date.now() - started > STAGE_DEADLINE_MS) throw new Error(`stage did not settle within ${STAGE_DEADLINE_MS}ms`);
  }
}

/* ------------------------------------------------------------------ the run */

const GOAL = [
  'Create two files in the current working directory.',
  '',
  '1. normalize.mjs - export a function normalizeTrackName(name) that turns a messy audio file name',
  '   into a clean one: trim, NFKC-normalise, replace every character that Windows forbids in a',
  '   file name ( < > : " / \\ | ? * and control characters ) with a single hyphen, collapse runs of',
  '   whitespace into one space, drop leading and trailing dots and spaces, and preserve the original',
  '   extension exactly. If the resulting stem is empty, use "untitled".',
  '2. normalize.test.mjs - a node:test file with at least 8 assertions covering ordinary ASCII cases,',
  '   a forbidden character, repeated whitespace, a missing extension and an empty stem.',
  '',
  'Run the tests yourself and make sure they pass. Report only what you actually observed.',
].join('\n');

(async () => {
  if (SELF_CHECK) {
    // This executes the same summary + verdict code the real run executes. `node --check` and
    // `tsc` prove syntax, never that a branch runs, and a real two-stage model run is far too
    // expensive to be the first thing that ever exercises it.
    const accepted = buildVerdict(buildSummary({
      runId: `${RUN_ID}-self-check`,
      workspace: WORKSPACE,
      evidenceDir: EVIDENCE,
      taskId: 'self-check-task',
      session: {stage1RuntimePid: 101, stage2RuntimePid: 101, stage1SessionId: 's', stage2SessionId: 's', stage1Turn: 1, stage2Turn: 2},
      stage1: {messageId: 'm1', state: 'awaiting_review', verificationExitCode: 0, toolCallsTotal: 5, toolErrorCount: 0, modelReportChars: 100, settledAt: '2026-01-01T00:00:00.000Z'},
      stage2: {messageId: 'm2', state: 'awaiting_review', verificationExitCode: 0, toolCallsTotal: 4, toolErrorCount: 0, modelReportChars: 90, continuedStage: 2},
      preservation: {allArtifactHashesMatch: true, comparedArtifacts: 2, changedArtifacts: [], reportTextUnchanged: true},
      review: {path: REVIEW_FILE, receivedAt: '2026-01-01T00:10:00.000Z', writtenAfterStage1: true, chars: 42},
      cancel: cancelFacts({runtimeStopped: true, fullyStopped: true, treeVerified: true, survivorPids: [], method: 'shutdown-rpc'}, false),
      waitTimeoutsObserved: false,
    }));
    const rejected = buildVerdict(buildSummary({
      runId: `${RUN_ID}-self-check-negative`,
      session: {stage1RuntimePid: 1, stage2RuntimePid: 2, stage1SessionId: 's1', stage2SessionId: 's2', stage1Turn: 1, stage2Turn: 1},
      stage1: {verificationExitCode: 0, toolErrorCount: 0},
      stage2: {verificationExitCode: 1, toolErrorCount: 3},
      preservation: {allArtifactHashesMatch: false, changedArtifacts: ['stage1Result'], reportTextUnchanged: false},
      review: {writtenAfterStage1: false},
      cancel: {runtimeStopped: true, fullyStopped: false, treeVerified: true, survivorPids: [9]},
    }));
    // Built through the SAME fact constructor the real run uses, so the written file proves that
    // the expression was evaluated rather than merely parsed - and the suite asserts its value.
    save('self-check-summary.json', buildSummary({
      runId: `${RUN_ID}-self-check`,
      cancel: cancelFacts({runtimeStopped: true, fullyStopped: true, treeVerified: true, survivorPids: [], method: 'shutdown-rpc'}, false),
    }));
    save('self-check-verdict.json', accepted);
    save('self-check-negative-verdict.json', rejected);
    const selfCheckOk = accepted.ok === true && accepted.stage1Outcome === 'clean'
      && rejected.ok === false && rejected.failed.length >= 5;
    console.log(JSON.stringify({selfCheck: true, accepted: {ok: accepted.ok, stage1Outcome: accepted.stage1Outcome}, rejected: {ok: rejected.ok, failed: rejected.failed}}, null, 2));
    console.log(selfCheckOk ? 'E2E_VERDICT_SELF_CHECK_OK' : 'E2E_VERDICT_SELF_CHECK_FAILED');
    process.exitCode = selfCheckOk ? 0 : 1;
    return;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE_MAIN],
    env: {...process.env, DSH_BRIDGE_ALLOWED_ROOTS: E2E_ROOT},
    cwd: WORKSPACE,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });

  client = new Client({name: 'codex-role-e2e', version: '1.0.0'}, {capabilities: {}});
  await client.connect(transport);
  stamp('connected', {bridge: BRIDGE_MAIN, workspace: WORKSPACE, runId: RUN_ID});

  const caps = jsonOf(await call('dsh_get_capabilities', {}));
  save('capabilities.json', caps);
  // Alignment, from the bridge's published contract rather than from a guess: the client timeout
  // must exceed the bridge's wait window, and the wait window must not exceed the bridge's cap.
  const publishedFloor = Number(caps?.limits?.clientRequestTimeoutFloorMs);
  const publishedMax = Number(caps?.limits?.waitTimeoutMaxMs);
  if (Number.isFinite(publishedFloor) && publishedFloor > 0) CLIENT_REQUEST_TIMEOUT_MS = publishedFloor;
  if (Number.isFinite(publishedMax) && publishedMax > 0) WAIT_PER_CALL_MS = Math.min(WAIT_PER_CALL_MS, publishedMax);
  if (CLIENT_REQUEST_TIMEOUT_MS <= WAIT_PER_CALL_MS) {
    throw new Error(
      `refusing to run: the MCP client timeout (${CLIENT_REQUEST_TIMEOUT_MS}ms) must exceed the wait window ` +
      `(${WAIT_PER_CALL_MS}ms) or a long wait is aborted client-side; the bridge publishes ` +
      `limits.clientRequestTimeoutFloorMs for exactly this. Read: ${JSON.stringify(caps?.limits ?? null)}`,
    );
  }
  stamp('capabilities', {
    cliEntry: caps.communityEdition?.cliEntry,
    cliEntryOverridden: caps.communityEdition?.cliEntryOverridden,
    cliEntryKind: caps.communityEdition?.cliEntryKind,
    cliEntryPackage: caps.communityEdition?.cliEntryPackage,
    provider: caps.modelRoute?.provider,
    model: caps.modelRoute?.model,
    credentialPresent: caps.credential?.present,
    credentialSource: caps.credential?.source,
    methodProbe: (caps.sdkProtocol?.methodProbe?.methods ?? []).filter((m) => m.found).map((m) => m.method),
    waitWindowMs: WAIT_PER_CALL_MS,
    clientRequestTimeoutMs: CLIENT_REQUEST_TIMEOUT_MS,
    alignment: `client timeout ${CLIENT_REQUEST_TIMEOUT_MS}ms > wait window ${WAIT_PER_CALL_MS}ms`,
  });
  // Authenticity gate: the entry must be POSITIVELY identified as the @deepseek-ai/dsh package,
  // not merely different from a hard-coded default path. A scripted test double fails this, and
  // so does an arbitrary binary placed on the default path.
  const entryKind = caps.communityEdition?.cliEntryKind;
  if (entryKind !== 'real-dsh') {
    throw new Error(
      'refusing to run the real loop: the configured CLI entry is not a positively identified ' +
      `@deepseek-ai/dsh runtime (cliEntryKind=${String(entryKind)}, reason=${String(caps.communityEdition?.cliEntryReason)})`,
    );
  }
  // Where the bridge persists durable evidence. This run reads and hashes those files itself.
  const TASK_ROOT = typeof caps.persistentRuns?.root === 'string' ? caps.persistentRuns.root : null;
  if (TASK_ROOT === null) throw new Error('the bridge did not report persistentRuns.root; the stage-1 evidence could not be hashed');

  /* ---- stage 1 ---- */
  const submitted = jsonOf(await call('dsh_submit_task', {
    workspace: WORKSPACE,
    goal: GOAL,
    context: 'This is stage 1 of a two-stage Codex review loop. Codex will review your work and may ask for a revision.',
    constraints: [
      'Only create files inside the working directory.',
      'Do not claim a test passed unless you ran it.',
    ],
    acceptance: 'normalize.mjs and normalize.test.mjs exist and node --test normalize.test.mjs exits 0.',
    verificationCommand: [process.execPath, '--test', 'normalize.test.mjs'],
    reasoningEffort: 'low',
    maxTokens: 8192,
    budgetMs: 600_000,
  }));
  save('stage-1-submit.json', submitted);
  stamp('stage-1-submitted', {taskId: submitted.taskId, sessionId: submitted.sessionId, messageId: submitted.messageId, runtimePid: submitted.runtimePid});

  const taskId = submitted.taskId;
  const settled1 = await waitForStage(taskId);
  const result1 = jsonOf(await call('dsh_get_result', {taskId, verbose: true}));
  save('stage-1-result.json', result1);
  stamp('stage-1-result', {
    stageState: result1.stageState, taskState: result1.taskState,
    modelReportChars: result1.modelReport?.chars,
    toolCallsTotal: result1.bridgeObserved?.toolCallsTotal,
    toolErrorCount: result1.bridgeObserved?.toolErrorCount,
    verificationExitCode: result1.bridgeObserved?.verificationCommand?.exitCode,
    filesAdded: result1.bridgeObserved?.filesChanged?.added,
    turnEndReason: result1.bridgeObserved?.turnEndReason?.kind,
    unresolved: result1.unresolved,
  });
  const stage1SettledAt = new Date().toISOString();
  const evidence1 = taskEvidence(TASK_ROOT, taskId);
  save('stage-1-persisted-evidence.json', evidence1);
  stamp('stage-1-persisted', {taskRoot: TASK_ROOT, sessionId: evidence1.sessionId, runtimePid: evidence1.runtimePid, recordedStages: evidence1.recordedStages, hashes: evidence1.hashes});

  /* ---- hand off to the Codex role ---- */
  const handoff = [
    `STAGE 1 SETTLED: stageState=${result1.stageState} taskState=${result1.taskState}`,
    `verificationCommand exitCode (bridge's own observation) = ${result1.bridgeObserved?.verificationCommand?.exitCode}`,
    `files added by the bridge-observed diff: ${JSON.stringify(result1.bridgeObserved?.filesChanged?.added ?? [])}`,
    '',
    `Write the stage-2 review to: ${REVIEW_FILE}`,
    `Then this process will call dsh_continue_task on the SAME live session (taskId=${taskId}).`,
  ].join('\n');
  save('AWAITING-REVIEW.txt', handoff);
  console.log(handoff);

  // Review barrier. The review must be written by the orchestrator AFTER stage 1 settled. A file
  // that already exists is a pre-generated review, and calling that "independent" would be a lie.
  if (existsSync(REVIEW_FILE)) {
    throw new Error(`refusing to continue: ${REVIEW_FILE} already exists before the review barrier; a pre-generated review is not an independent review`);
  }
  stamp('awaiting-review', {reviewFile: REVIEW_FILE, waitMs: REVIEW_WAIT_MS, stage1SettledAt});
  const reviewDeadline = Date.now() + REVIEW_WAIT_MS;
  while (!existsSync(REVIEW_FILE)) {
    if (Date.now() > reviewDeadline) throw new Error(`no review file at ${REVIEW_FILE} after ${REVIEW_WAIT_MS}ms`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const reviewStat = statSync(REVIEW_FILE);
  const review = readFileSync(REVIEW_FILE, 'utf8');
  const reviewWrittenAfterStage1 = reviewStat.mtimeMs >= Date.parse(stage1SettledAt);
  stamp('review-received', {chars: review.length, reviewFile: REVIEW_FILE, mtime: reviewStat.mtime.toISOString(), writtenAfterStage1: reviewWrittenAfterStage1});

  /* ---- stage 2: the same live session ---- */
  const continued = jsonOf(await call('dsh_continue_task', {
    taskId,
    review,
    acceptance: 'The tests cover the cases the review lists and node --test exits 0 again.',
  }));
  save('stage-2-continue.json', continued);
  stamp('stage-2-continued', {stage: continued.stage, state: continued.state, messageId: continued.messageId});

  const settled2 = await waitForStage(taskId);
  const result2 = jsonOf(await call('dsh_get_result', {taskId, verbose: true}));
  save('stage-2-result.json', result2);
  stamp('stage-2-result', {
    stageState: result2.stageState, taskState: result2.taskState,
    modelReportChars: result2.modelReport?.chars,
    toolCallsTotal: result2.bridgeObserved?.toolCallsTotal,
    toolErrorCount: result2.bridgeObserved?.toolErrorCount,
    verificationExitCode: result2.bridgeObserved?.verificationCommand?.exitCode,
    turnEndReason: result2.bridgeObserved?.turnEndReason?.kind,
    unresolved: result2.unresolved,
  });

  /* ---- stage 1 evidence must be unchanged after stage 2: compare the PERSISTED bytes ---- */
  const result1Again = jsonOf(await call('dsh_get_result', {taskId, stage: 1}));
  const evidenceAfter = taskEvidence(TASK_ROOT, taskId);
  const comparedArtifacts = Object.keys(evidence1.hashes).filter((key) => evidence1.hashes[key] !== null);
  const changedArtifacts = comparedArtifacts.filter((key) => evidence1.hashes[key] !== evidenceAfter.hashes[key]);
  const reportTextUnchanged = result1Again.modelReport?.text === result1.modelReport?.text;
  const preservation = {
    allArtifactHashesMatch: comparedArtifacts.length > 0 && changedArtifacts.length === 0,
    comparedArtifacts: comparedArtifacts.length,
    changedArtifacts,
    stage1Hashes: evidence1.hashes,
    afterStage2Hashes: evidenceAfter.hashes,
    reportTextUnchanged,
    reportCharsBefore: result1.modelReport?.chars ?? 0,
    reportCharsAfter: result1Again.modelReport?.chars ?? 0,
  };
  save('preservation.json', preservation);
  stamp('preservation', preservation);

  const status = jsonOf(await call('dsh_get_task', {taskId}));
  save('final-status.json', status);

  /* ---- cleanup: the bridge must not leave the task's processes behind ---- */
  const cancelled = jsonOf(await call('dsh_cancel_task', {taskId}));
  save('cancel.json', cancelled);
  await new Promise((resolve) => setTimeout(resolve, 500));
  let pidAlive = null;
  if (submitted.runtimePid) {
    try { process.kill(submitted.runtimePid, 0); pidAlive = true; } catch { pidAlive = false; }
  }
  stamp('cancelled', {
    runtimeStopped: cancelled.runtimeStopped, fullyStopped: cancelled.fullyStopped,
    treeVerified: cancelled.treeVerified, survivorPids: cancelled.survivorPids,
    method: cancelled.method, pid: cancelled.pid, pidStillAlive: pidAlive,
  });

  const summary = buildSummary({
    runId: RUN_ID,
    workspace: WORKSPACE,
    evidenceDir: EVIDENCE,
    taskId,
    session: {
      stage1RuntimePid: evidence1.runtimePid ?? submitted.runtimePid ?? null,
      stage2RuntimePid: evidenceAfter.runtimePid,
      stage1SessionId: evidence1.sessionId ?? submitted.sessionId ?? null,
      stage2SessionId: evidenceAfter.sessionId,
      stage1Turn: result1.turn ?? null,
      stage2Turn: result2.turn ?? null,
    },
    stage1: {
      messageId: submitted.messageId,
      state: result1.stageState,
      verificationExitCode: result1.bridgeObserved?.verificationCommand?.exitCode ?? null,
      modelReportChars: result1.modelReport?.chars ?? 0,
      toolCallsTotal: result1.bridgeObserved?.toolCallsTotal ?? 0,
      toolErrorCount: result1.bridgeObserved?.toolErrorCount ?? null,
      settledAt: stage1SettledAt,
      unresolved: result1.unresolved ?? [],
    },
    stage2: {
      messageId: continued.messageId,
      state: result2.stageState,
      verificationExitCode: result2.bridgeObserved?.verificationCommand?.exitCode ?? null,
      modelReportChars: result2.modelReport?.chars ?? 0,
      toolCallsTotal: result2.bridgeObserved?.toolCallsTotal ?? 0,
      toolErrorCount: result2.bridgeObserved?.toolErrorCount ?? null,
      continuedStage: continued.stage ?? null,
      unresolved: result2.unresolved ?? [],
    },
    preservation,
    review: {
      path: REVIEW_FILE,
      receivedAt: reviewStat.mtime.toISOString(),
      writtenAfterStage1: reviewWrittenAfterStage1,
      chars: review.length,
    },
    cancel: cancelFacts(cancelled, pidAlive),
    waitTimeoutsObserved: settled1.outcome === 'timeout' || settled2.outcome === 'timeout',
  });
  save('summary.json', summary);

  // The loop decides acceptance instead of only recording it: a run that failed a criterion must
  // not exit 0, or the orchestrator cannot tell it apart from a run that passed.
  const verdict = buildVerdict(summary);
  save('verdict.json', verdict);
  save('bridge-stderr.txt', stderrText);
  await client.close();
  console.log(`\nEVIDENCE: ${EVIDENCE}`);
  console.log(JSON.stringify({ok: verdict.ok, stage1Outcome: verdict.stage1Outcome, failed: verdict.failed, note: verdict.note}, null, 2));
  console.log(verdict.ok ? 'REAL_LOOP_ACCEPTED' : 'REAL_LOOP_NOT_ACCEPTED');
  process.exitCode = verdict.ok ? 0 : 1;
})().catch(async (error) => {
  stamp('fatal', {message: String(error?.message ?? error)});
  save('fatal.txt', String(error?.stack ?? error));
  save('bridge-stderr.txt', stderrText);
  try { await client?.close(); } catch { /* already gone */ }
  process.exitCode = 1;
});
