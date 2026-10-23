#!/usr/bin/env node
/**
 * ONE minimal real-SDK smoke, explicitly authorized for this optimization task.
 *
 * It starts the candidate Bridge's own TaskManager against the selected real DSH runtime/GOAT
 * model, asks for a file with exact bytes, and has the BRIDGE run an independent node command that
 * checks those bytes. It records the real tool total, usage accounting, verification status and
 * checkpoint, then stops its own task/runtime. It never touches the running Bridge or desktop DSH.
 *
 * No credential value is read into output. If no credential/platform/runtime is available it writes
 * an explicit blocked record and exits 2 instead of inventing a result.
 *
 * Usage:
 *   node scripts/e2e-smoke.mjs
 */
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E = path.join(ROOT, 'evidence', 'e2e-smoke');
const WORKSPACE = path.join(E2E, 'workspace');
const DATA = path.join(E2E, 'data');
const EXPECTED = 'bridge-e2e-20261022\n';

process.env.DSH_BRIDGE_PROVIDER = process.env.DSH_BRIDGE_PROVIDER ?? 'commandcode-goat';
process.env.DSH_BRIDGE_RUNTIME_ROOT = process.env.DSH_BRIDGE_RUNTIME_ROOT ?? '/home/agent/dsh-runtimes/0.2.1-rc.2-20261017';
process.env.DSH_BRIDGE_DATA_ROOT = DATA;
process.env.DSH_BRIDGE_CLI_ENTRY = process.env.DSH_BRIDGE_CLI_ENTRY ?? path.join(
  process.env.DSH_BRIDGE_RUNTIME_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
);

mkdirSync(E2E, {recursive: true});
rmSync(WORKSPACE, {recursive: true, force: true});
rmSync(DATA, {recursive: true, force: true});
mkdirSync(WORKSPACE, {recursive: true});

const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
const recordPath = path.join(E2E, `smoke-${stamp}.json`);
const latestPath = path.join(E2E, 'latest.json');

function writeRecord(record) {
  const text = JSON.stringify(record, null, 2) + '\n';
  writeFileSync(recordPath, text, 'utf8');
  writeFileSync(latestPath, text, 'utf8');
}

const config = await import(pathToFileURL(path.join(ROOT, 'dist', 'src', 'config.js')).href);
const facts = config.readRuntimeFacts();
const credential = config.describeCredential();
const runtime = {
  root: facts.appRoot,
  appPackage: facts.appPackage,
  dshPackageVersion: facts.dshPackageVersion,
  cliEntry: facts.cliEntry,
  cliEntryKind: facts.cliEntryKind,
  cliEntryIsReal: facts.cliEntryIsReal,
  provider: config.PROVIDER_ID,
  model: config.MODEL_ID,
  bridgeVersion: config.BRIDGE_VERSION,
};

if (!credential.present) {
  writeRecord({
    schema: 'codex-dsh-bridge/e2e-smoke@1', status: 'blocked', startedAt,
    reason: 'credential absent in this process; no real SDK request was started',
    credential: {envVarName: credential.envVarName, present: false, source: credential.source},
    runtime,
    note: 'No credential value was read or printed. Supply the existing credential to the Bridge parent to run this smoke.',
  });
  console.error(`E2E_SMOKE_BLOCKED credential ${credential.envVarName} absent; no model request was made.`);
  process.exit(2);
}
if (!facts.cliEntryIsReal) {
  writeRecord({
    schema: 'codex-dsh-bridge/e2e-smoke@1', status: 'blocked', startedAt,
    reason: `configured CLI entry is not a real @deepseek-ai/dsh runtime: kind=${facts.cliEntryKind}`,
    runtime,
  });
  console.error(`E2E_SMOKE_BLOCKED runtime is not a real dsh package: ${facts.cliEntryKind}`);
  process.exit(2);
}

const {TaskManager} = await import(pathToFileURL(path.join(ROOT, 'dist', 'src', 'tasks.js')).href);
const manager = new TaskManager();
let taskId = null;
let finalRecord = null;

try {
  const verifyCode = [
    "const fs=require('node:fs');",
    "const b=fs.readFileSync('smoke.txt','utf8');",
    `const e=${JSON.stringify(EXPECTED)};`,
    "if(b!==e){console.error('unexpected bytes '+JSON.stringify(b));process.exit(7);}",
    "console.log('smoke-bytes-ok');",
  ].join('');
  const record = await manager.submit({
    workspace: WORKSPACE,
    goal: `Create a file named smoke.txt containing exactly the bytes of this string: ${JSON.stringify(EXPECTED)}. `
      + 'Nothing else is required. Run your own check before reporting.',
    acceptance: 'smoke.txt contains exactly the requested bytes; the Bridge\'s independent command exits 0.',
    constraints: ['Create or modify only smoke.txt in the workspace.'],
    verificationCommand: [process.execPath, '-e', verifyCode],
    reasoningEffort: 'low',
    maxTokens: 4_096,
    budgetMs: 180_000,
  });
  taskId = record.taskId;

  let outcome = 'timeout';
  for (let attempt = 0; attempt < 3 && outcome !== 'settled'; attempt += 1) {
    const waited = await manager.wait(taskId, 120_000);
    outcome = waited.outcome;
  }
  if (outcome !== 'settled') {
    await manager.cancel(taskId);
    throw new Error('task did not settle within the bounded smoke window');
  }

  const result = manager.result(taskId);
  const checkpointText = existsSync(result.artifacts.checkpoint)
    ? readFileSync(result.artifacts.checkpoint, 'utf8') : null;
  const checkpoint = checkpointText ? JSON.parse(checkpointText) : null;
  if (checkpointText) writeFileSync(path.join(E2E, 'checkpoint-normal.json'), checkpointText, 'utf8');
  const filePath = path.join(WORKSPACE, 'smoke.txt');
  const fileText = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  const verification = result.bridgeObserved.verification;
  const ok = result.taskState === 'awaiting_review'
    && fileText === EXPECTED
    && verification.status === 'passed'
    && verification.attempts === 1
    && verification.lastRun?.exitCode === 0;

  finalRecord = {
    schema: 'codex-dsh-bridge/e2e-smoke@1',
    status: ok ? 'passed' : 'failed',
    startedAt,
    finishedAt: new Date().toISOString(),
    reason: ok ? null : 'the real SDK run did not satisfy the fixed file/verification expectation',
    runtime,
    taskId,
    sessionId: record.sessionId,
    stage: result.stage,
    taskState: result.taskState,
    stageState: result.stageState,
    expectedFile: {name: 'smoke.txt', bytes: Buffer.byteLength(EXPECTED), sha256: createHash('sha256').update(EXPECTED).digest('hex'), actualTextMatches: fileText === EXPECTED},
    toolCalls: {
      total: result.bridgeObserved.toolCallsTotal,
      retained: result.bridgeObserved.toolCallsRetained,
      shown: result.bridgeObserved.toolCallsShown,
      dropped: result.bridgeObserved.toolCallsDropped,
      taskTotal: result.bridgeObserved.toolCallsTaskTotal,
      results: result.bridgeObserved.toolResultsTotal,
      errors: result.bridgeObserved.toolErrorCount,
      counts: result.bridgeObserved.toolCounts,
    },
    usageAccounting: result.bridgeObserved.usageAccounting,
    verification: {
      status: verification.status,
      attempts: verification.attempts,
      exitCode: verification.lastRun?.exitCode ?? null,
      timedOut: verification.lastRun?.timedOut ?? null,
      stdoutTail: verification.lastRun?.stdoutTail ?? null,
      stderrTail: verification.lastRun?.stderrTail ?? null,
      notRunReason: verification.notRunReason,
      acceptance: verification.acceptance,
    },
    deliverySummary: {
      productAcceptance: result.deliverySummary.productAcceptance,
      acceptanceBasis: result.deliverySummary.acceptanceBasis,
      unresolved: result.deliverySummary.unresolved,
    },
    checkpoint: {
      path: result.artifacts.checkpoint,
      normalCopy: checkpointText ? path.join(E2E, 'checkpoint-normal.json') : null,
      taskState: checkpoint?.taskState ?? null,
      stageState: checkpoint?.stageState ?? null,
      verificationStatus: checkpoint?.verification?.status ?? null,
      usageTaskRecords: checkpoint?.usage?.task?.records ?? null,
      sdkCrossProcessResume: checkpoint?.resume?.sdkCrossProcessResume ?? null,
    },
    artifacts: result.artifacts,
    note: 'Real SDK request using the selected runtime and original GOAT route. No credential value is recorded.',
  };
} catch (error) {
  finalRecord = {
    schema: 'codex-dsh-bridge/e2e-smoke@1',
    status: 'failed',
    startedAt,
    finishedAt: new Date().toISOString(),
    reason: error instanceof Error ? error.message : String(error),
    runtime,
    taskId,
    note: 'A failure is recorded as a failure; no model result is invented.',
  };
} finally {
  if (taskId) {
    try {
      const status = manager.status(taskId);
      if (!['cancelled', 'failed', 'timed_out'].includes(status.state)) await manager.cancel(taskId);
    } catch { /* best-effort cleanup of this smoke's own task */ }
  }
  try { await manager.shutdownAll(); } catch { /* best-effort */ }
}

writeRecord(finalRecord);
console.log(JSON.stringify({
  status: finalRecord.status,
  reason: finalRecord.reason,
  taskId: finalRecord.taskId,
  toolCalls: finalRecord.toolCalls,
  verification: finalRecord.verification,
  checkpoint: finalRecord.checkpoint,
  record: recordPath,
}, null, 2));
process.exit(finalRecord.status === 'passed' ? 0 : 1);
