#!/usr/bin/env node
/**
 * Controlled REAL-SDK automatic-repair drill.
 *
 * This script spends model requests, so it is never imported by the package, never part of
 * `npm test`, and refuses to start unless the caller supplies BOTH:
 *
 *   node scripts/e2e-auto-repair.mjs --output <new-absolute-directory> --scenario all
 *
 * Supported scenarios: all (the two scenes below), success, no-progress.
 *
 * The evidence contract is host-owned: write <output>/summary.json with schema
 * `bridge-real-auto-repair@2` and verify the actual native task records, event streams,
 * protected verifier hashes, export artifacts and cleanup. Assertions here are mechanism
 * drills only; they are not a business-quality, savings or cross-process-resume claim.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output' || arg === '--scenario') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      values[arg.slice(2)] = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      values.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return values;
}

function usage(message) {
  console.error(`ERROR: ${message}`);
  console.error('usage: node scripts/e2e-auto-repair.mjs --output <new-absolute-directory> --scenario <all|success|no-progress>');
}

const options = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error) {
    usage(error.message);
    process.exit(2);
  }
})();

if (options.help) {
  usage('explicit invocation is required');
  process.exit(0);
}
if (!options.output) {
  usage('--output is required; the script never picks a default evidence directory');
  process.exit(2);
}
if (!options.scenario) {
  usage('--scenario is required; model requests are never started by an unattended default');
  process.exit(2);
}
if (!path.isAbsolute(options.output)) {
  usage('--output must be an absolute path');
  process.exit(2);
}
if (!['all', 'success', 'no-progress'].includes(options.scenario)) {
  usage(`unsupported --scenario '${options.scenario}'`);
  process.exit(2);
}
const OUTPUT = path.resolve(options.output);
if (existsSync(OUTPUT)) {
  usage('--output must be a NEW directory; old evidence is never replaced');
  process.exit(2);
}
const requested = options.scenario === 'all' ? ['success', 'noProgress'] : [options.scenario === 'success' ? 'success' : 'noProgress'];

// Configuration must be local to this run and set BEFORE importing src/config.js.
mkdirSync(OUTPUT, {recursive: true});
process.env.DSH_BRIDGE_ALLOWED_ROOTS = OUTPUT;
process.env.DSH_BRIDGE_DATA_ROOT = path.join(OUTPUT, 'bridge-data');
process.env.DSH_BRIDGE_MAX_TASKS = '1';
// Honor inherited provider/runtime credentials and runtime root. Do not print or dump process.env.

const {TaskManager} = await import(pathToFileURL(path.join(REPO, 'dist', 'src', 'tasks.js')).href);

const NO_PROGRESS_STDERR = 'CONTROLLED_NO_PROGRESS: fixed independent fixture remains false';
const SCENES = {};

function workspaceAndVerifier(sceneDir, scenario) {
  const workspace = path.join(sceneDir, 'work');
  mkdirSync(workspace, {recursive: true});
  const verifier = path.join(sceneDir, 'accept.cjs');
  if (scenario === 'success') {
    writeFileSync(verifier, [
      "const assert=require('node:assert/strict');",
      "const {add}=require(require('node:path').join(process.cwd(),'calculator.cjs'));",
      "for (const [a,b] of [[2,3],[-2,3],[0,9],[7,0],[-8,-9],[1.5,2.25]]) assert.equal(add(a,b),a+b,`addition fixture (${a},${b})`);",
      "console.log('controlled positive/negative/zero/fractional addition checks passed');",
    ].join('\n') + '\n', 'utf8');
  } else {
    writeFileSync(verifier, `process.stderr.write(${JSON.stringify(NO_PROGRESS_STDERR + '\n')}); process.exit(7);\n`, 'utf8');
  }
  return {workspace, verifier};
}

function scenePrompts(scenario) {
  if (scenario === 'success') {
    return {
      goal: [
        'Controlled Bridge automatic-repair integration drill. FIRST STAGE ONLY: create calculator.cjs exporting add(a,b) implemented as a-b (the deliberately faulty fixture).',
        'Do not correct that seeded defect in stage 1. Do not edit, replace or bypass any external verifier. Finish the turn normally with a brief report.',
        'When a later Bridge acceptance-failure stage arrives in this SAME session, repair calculator.cjs to implement mathematical addition and self-check it.',
        'Only this tiny synthetic task is requested. Do not modify dependencies, configuration, accounts or system settings.',
      ].join(' '),
      constraints: ['Only edit calculator.cjs and optional short notes.md inside the provided workspace. Never modify external acceptance files, the harness, dependencies, configuration, accounts or system settings.'],
    };
  }
  return {
    goal: [
      'Controlled Bridge no-progress stopping drill. Create or update notes.md with a one-line report, then finish this stage normally.',
      'An immutable external checker deliberately always reports CONTROLLED_NO_PROGRESS and exits 7, independently of workspace contents.',
      'On any automatic review, do not attempt to defeat or modify the checker: record that the fixed independent fixture remains unsatisfied, and finish normally again.',
      'Do not request an approval or a blocked turn. The Bridge must notice identical failures and stop. Only this tiny synthetic task is requested.',
    ].join(' '),
    constraints: ['Only edit notes.md inside the provided workspace. Never modify external acceptance files, harness, dependencies, configuration, accounts or system settings.'],
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function verificationOf(stage) {
  assert.ok(stage && typeof stage === 'object', 'stage record missing');
  assert.ok(stage.verification && typeof stage.verification === 'object', `stage ${stage.index}: native verification record missing`);
  return stage.verification;
}

function assertProtectedBytes(task) {
  const workspace = task.workspace;
  assert.ok(Array.isArray(task.protectedVerificationFiles) && task.protectedVerificationFiles.length > 0, 'protected verifier files missing');
  let external = 0;
  for (const file of task.protectedVerificationFiles) {
    assert.ok(path.isAbsolute(file.path), 'protected file path must be absolute');
    assert.equal(realpathSync.native(file.path), file.realPath, `protected verifier target changed: ${file.path}`);
    assert.equal(hash(readFileSync(file.path)), file.sha256, `protected verifier bytes changed: ${file.path}`);
    const relative = path.relative(workspace, file.path);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) external += 1;
  }
  assert.ok(external > 0, 'at least one protected verifier must be outside the model workspace');
  assert.ok(Array.isArray(task.verificationCommand) && task.verificationCommand.length >= 2, 'verificationCommand is missing');
  assert.ok(task.protectedVerificationFiles.some((file) => task.verificationCommand.some((arg) =>
    typeof arg === 'string' && path.isAbsolute(arg) && path.resolve(arg) === path.resolve(file.path))),
  'the external verifier file must itself be protected');
}

function assertNativeEvidence(task, result, scenario) {
  const stages = task.stages;
  assert.ok(Array.isArray(stages) && stages.length >= 2, `${scenario}: expected at least two stages`);
  assert.equal(task.codexContinuationCount, 0, `${scenario}: no manual continuation is permitted`);
  assert.ok(task.totalAutoRepairs >= 1, `${scenario}: at least one automatic repair is required`);
  assert.equal(task.totalAutoRepairs, stages.length - 1, `${scenario}: repair count must match added stages`);
  for (const stage of stages) {
    assert.equal(stage.state, 'awaiting_review', `${scenario}: every stage must end normally`);
    assert.ok(stage.endedAt && stage.finalisedAt, `${scenario}: every stage must be finalised`);
    assert.equal(stage.verificationCancelledDuringRun, false);
    assert.deepEqual(stage.verifierIntegrityErrors, []);
    const verification = verificationOf(stage);
    assert.equal(verification.timedOut, false);
    assert.equal(verification.error, null);
  }
  assert.notEqual(stages[0].verification.exitCode, 0, `${scenario}: the first controlled delivery must fail independently`);

  const events = readFileSync(path.join(result.artifacts.taskDir, 'events.jsonl'), 'utf8')
    .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const runtimeEvents = events.filter((event) => ['runtime/started', 'runtime/reused'].includes(event.kind));
  assert.equal(runtimeEvents.filter((event) => event.kind === 'runtime/started').length, 1, `${scenario}: exactly one runtime start`);
  assert.equal(runtimeEvents.filter((event) => event.kind === 'runtime/reused').length, stages.length - 1, `${scenario}: every repair must reuse the same runtime`);
  assert.ok(runtimeEvents.every((event) => event.pid === task.runtimePid), `${scenario}: runtime pid changed`);
  const notifications = events.filter((event) => event.kind === 'notification' && typeof event.params?.sessionId === 'string');
  assert.ok(notifications.length > 0, `${scenario}: native session notifications missing`);
  assert.ok(notifications.every((event) => event.params.sessionId === task.sessionId), `${scenario}: sessionId changed`);
  const accepted = events.filter((event) => event.kind === 'stage/accepted');
  assert.deepEqual(accepted.map((event) => event.stage), stages.map((stage) => stage.index));
  const repairs = events.filter((event) => event.kind === 'repair/started');
  assert.equal(repairs.length, task.totalAutoRepairs, `${scenario}: repair/started count mismatch`);
  assert.ok(repairs.every((event) => /^[a-f0-9]{64}$/.test(event.fingerprint)), `${scenario}: repair fingerprint missing`);

  assert.equal(result.bridgeObserved.verification.status, scenario === 'success' ? 'passed' : 'failed');
  assert.equal(result.deliverySummary.productAcceptance, scenario === 'success' ? 'check-passed' : 'failed');
}

function assertExport(indexPath, task, scenario) {
  const index = readJson(indexPath);
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.taskId, task.taskId);
  assert.equal(index.metrics.firstVerificationPassed, false);
  assert.equal(index.metrics.codexContinuationCount, 0);
  assert.equal(index.metrics.autoRepairCount, task.totalAutoRepairs);
  assert.equal(index.metrics.stageCount, task.stages.length);
  assert.ok(Array.isArray(index.artifacts) && index.artifacts.length > 0);
  const root = path.dirname(indexPath);
  for (const artifact of index.artifacts) {
    assert.ok(typeof artifact.path === 'string' && !path.isAbsolute(artifact.path));
    const file = path.resolve(root, artifact.path);
    const relative = path.relative(root, file);
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    const bytes = readFileSync(file);
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(hash(bytes), artifact.sha256, `${scenario}: exported artifact hash mismatch ${artifact.path}`);
  }
  assert.ok(Array.isArray(index.hostVerification.stages));
  assert.equal(index.hostVerification.stages.length, task.stages.length);
  assert.equal(index.hostVerification.stages[0].verification.status, 'failed');
  if (scenario === 'success') {
    assert.equal(index.hostVerification.latest.status, 'passed');
    assert.equal(index.hostVerification.latest.acceptance, 'check-passed');
  } else {
    assert.equal(index.hostVerification.latest.status, 'failed');
    assert.equal(index.hostVerification.latest.acceptance, 'check-failed');
    assert.ok(index.hostVerification.stages.every((item) => item.verification.status === 'failed'));
  }
}

function assertCleanup(cancelView, taskRecordPath, expectedPid, scenario) {
  assert.ok(cancelView && typeof cancelView === 'object', `${scenario}: cancel view missing`);
  assert.equal(cancelView.taskId, SCENES[scenario].taskId);
  assert.equal(cancelView.pid, expectedPid);
  assert.equal(cancelView.runtimeStopped, true, `${scenario}: runtime stop not verified`);
  assert.equal(cancelView.fullyStopped, true, `${scenario}: process tree stop not verified`);
  assert.equal(cancelView.treeVerified, true, `${scenario}: process tree could not be enumerated`);
  assert.deepEqual(cancelView.survivorPids, [], `${scenario}: task processes survived`);
  const stoppedTask = readJson(taskRecordPath);
  assert.equal(stoppedTask.taskId, SCENES[scenario].taskId);
  assert.equal(stoppedTask.state, 'cancelled');
  assert.equal(stoppedTask.cancel?.pid, expectedPid);
  assert.equal(stoppedTask.cancel?.stopped, true, `${scenario}: task record does not prove the stop`);
  let alive = false;
  try { process.kill(expectedPid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
  assert.equal(alive, false, `${scenario}: SDK process still alive after cleanup`);
}

const PRE_SDK_REFUSAL_CODES = new Set([
  'shutting_down', 'invalid_budget', 'invalid_delivery_settings', 'workspace_rejected', 'invalid_goal',
  'invalid_execution_profile', 'execution_profile_drift', 'concurrency_limit', 'missing_credential',
  'invalid_protected_verifier',
]);

function deriveProviderActivity(task, eventsPath, attempted, submitErrorCode = null) {
  if (!task) {
    const beforeSdk = attempted && PRE_SDK_REFUSAL_CODES.has(submitErrorCode);
    return {
      modelRequestAttempted: attempted,
      sdkStarted: false,
      observed: false,
      modelRequested: beforeSdk ? false : attempted ? null : false,
      submitErrorCode,
      basis: [
        beforeSdk
          ? 'submit was refused before an SDK runtime or task record was created'
          : attempted
            ? 'submit failed without a returned task record; provider activity is unknown'
            : 'no submit was attempted',
      ],
      note: 'No model request is inferred from an accepted submit attempt alone.',
    };
  }
  let events = [];
  try {
    events = readFileSync(eventsPath, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch { /* the task record is still usable; activity then stays unknown unless records prove it */ }
  const runtimeEvents = events.filter((event) => ['runtime/started', 'runtime/reused'].includes(event.kind));
  const accepted = events.some((event) => event.kind === 'stage/accepted');
  // stage/accepted means the SDK acknowledged a prompt, NOT that a provider ran. It is SDK/submit
  // evidence only; it must never become positive provider activity by itself.
  const sdkStarted = runtimeEvents.length > 0 || (Number.isSafeInteger(task.runtimePid) && task.runtimePid > 0) || accepted;
  const sdkMessage = events.some((event) => event.kind === 'notification'
    && ['assistant/message', 'tool/call', 'tool/result', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(event.type));
  const stages = Array.isArray(task.stages) ? task.stages : [];
  const toolActivity = stages.some((stage) => (stage.toolCallsTotal ?? 0) > 0);
  const usageActivity = stages.some((stage) => (stage.usageAccumulator?.records ?? 0) > 0);
  const reportActivity = stages.some((stage) => typeof stage.modelReport === 'string' && stage.modelReport.length > 0);
  const observed = sdkMessage || toolActivity || usageActivity || reportActivity;
  const basis = [];
  if (accepted) basis.push('stage/accepted SDK prompt acknowledgment (not provider activity)');
  if (sdkMessage) basis.push('native assistant/tool notification');
  if (toolActivity) basis.push('recorded tool-call total');
  if (usageActivity) basis.push('recorded usage event');
  if (reportActivity) basis.push('recorded model report text');
  if (!observed && sdkStarted) basis.push('SDK may have started but no provider assistant/tool/usage/report evidence is recorded');
  if (!sdkStarted) basis.push('no SDK runtime event or pid is recorded');
  return {
    modelRequestAttempted: attempted,
    sdkStarted,
    observed,
    modelRequested: observed ? true : sdkStarted ? null : false,
    basis,
    note: 'Derived from native task stages and events, never from the fact that the harness tried to submit.',
  };
}

async function waitForSettle(manager, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (manager.status(taskId).awaiting) {
    if (Date.now() > deadline) throw new Error(`task ${taskId} did not settle within ${timeoutMs}ms`);
    await manager.wait(taskId, Math.min(30_000, Math.max(1_000, deadline - Date.now())));
  }
  return manager.status(taskId);
}

async function runScene(name, scenario) {
  const sceneDir = path.join(OUTPUT, name);
  mkdirSync(sceneDir, {recursive: true});
  const {workspace, verifier} = workspaceAndVerifier(sceneDir, scenario);
  const verifierHashBefore = hash(readFileSync(verifier));
  const prompts = scenePrompts(scenario);
  const manager = new TaskManager();
  const scene = {
    scene: scenario,
    taskId: null,
    sessionId: null,
    runtimePid: null,
    taskSnapshotPath: null,
    eventsPath: null,
    exportIndexPath: null,
    stopped: null,
    providerActivity: {
      modelRequestAttempted: false,
      sdkStarted: false,
      observed: false,
      modelRequested: false,
      basis: ['no submit was attempted'],
      note: 'No model request is inferred from an accepted submit attempt alone.',
    },
    checks: [],
    ok: false,
    error: null,
  };
  SCENES[name] = scene;
  let record = null;
  let taskDir = null;
  let submitErrorCode = null;
  try {
    scene.providerActivity.modelRequestAttempted = true;
    record = await manager.submit({
      workspace,
      deliveryPreset: 'complete',
      executionProfile: 'native',
      reasoningEffort: 'low',
      maxTokens: 8_192,
      budgetMs: 180_000,
      verificationTimeoutMs: 20_000,
      autoRepair: {
        enabled: true,
        maxAttempts: 3,
        noProgressLimit: scenario === 'success' ? 2 : 1,
        totalBudgetMs: 480_000,
      },
      verificationCommand: [process.execPath, verifier],
      protectedVerificationFiles: [verifier],
      goal: prompts.goal,
      constraints: prompts.constraints,
    });
    scene.taskId = record.taskId;
    const status = await waitForSettle(manager, record.taskId, 300_000);
    const result = manager.result(record.taskId);
    taskDir = result.artifacts.taskDir;
    scene.eventsPath = result.artifacts.eventsLog;

    // Exact task.json bytes BEFORE cancel changes the state or autoRepair stop reason.
    scene.taskSnapshotPath = path.join(sceneDir, 'task-snapshot.json');
    copyFileSync(path.join(taskDir, 'task.json'), scene.taskSnapshotPath);
    const task = readJson(scene.taskSnapshotPath);
    scene.sessionId = task.sessionId;
    scene.runtimePid = task.runtimePid;
    scene.providerActivity = deriveProviderActivity(task, scene.eventsPath, true);

    const exported = manager.exportDelivery(record.taskId, path.join(sceneDir, 'export'));
    scene.exportIndexPath = exported.indexJson;

    assert.equal(status.state, 'awaiting_review', `${scenario}: final state must be awaiting_review`);
    assert.equal(task.state, 'awaiting_review');
    assert.equal(task.sessionId, record.sessionId, `${scenario}: sessionId changed`);
    assert.equal(task.executionProfile, 'native', `${scenario}: explicit native profile must be recorded`);
    assert.ok(typeof task.executionBaselineSha256 === 'string' && /^[a-f0-9]{64}$/.test(task.executionBaselineSha256),
      `${scenario}: a real non-empty execution baseline hash must be recorded`);
    assert.ok(task.serverInfo && typeof task.serverInfo.name === 'string' && task.serverInfo.name.length > 0
      && typeof task.serverInfo.version === 'string' && task.serverInfo.version.length > 0,
    `${scenario}: actual SDK serverInfo evidence must be recorded`);
    assert.ok(Number.isSafeInteger(task.runtimePid) && task.runtimePid > 0);
    assert.equal(hash(readFileSync(verifier)), verifierHashBefore, `${scenario}: protected verifier bytes changed`);
    assertProtectedBytes(task);
    assertNativeEvidence(task, result, scenario);
    assertExport(scene.exportIndexPath, task, scenario);

    if (scenario === 'success') {
      assert.ok(task.stages.length >= 2);
      assert.equal(task.autoRepair.stopReason, 'passed');
      assert.equal(task.stages.at(-1).verification.exitCode, 0);
    } else {
      assert.equal(task.stages.length, 2, 'no-progress: exactly two normally completed stages');
      assert.equal(task.totalAutoRepairs, 1);
      assert.equal(task.autoRepair.noProgressLimit, 1);
      assert.equal(task.autoRepair.stopReason, 'no-progress');
      assert.equal(task.autoRepair.unchangedFailures, 1);
      assert.ok(task.stages.every((stage) => stage.verification.exitCode === 7));
      assert.ok(task.stages.every((stage) => String(stage.verification.stderrTail).trim() === NO_PROGRESS_STDERR));
    }
    scene.checks.push('native task record', 'event stream', 'protected verifier bytes', 'export artifact hashes');
  } catch (error) {
    submitErrorCode = typeof error?.code === 'string' ? error.code : null;
    scene.error = {name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack ?? null};
  } finally {
    if (record) {
      try {
        const cancelView = await manager.cancel(record.taskId);
        const taskRecordPath = taskDir ? path.join(taskDir, 'task.json') : null;
        scene.stopped = {cancelView, taskRecordPath};
        if (taskRecordPath) {
          try {
            assertCleanup(cancelView, taskRecordPath, scene.runtimePid, name);
            scene.checks.push('cancel/process-tree cleanup');
          } catch (error) {
            scene.error ??= {name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack ?? null};
          }
        }
      } catch (error) {
        scene.error ??= {name: error?.name ?? 'Error', message: `cleanup failed: ${error?.message ?? String(error)}`, stack: error?.stack ?? null};
      }
      try { await manager.shutdownAll(); } catch (error) {
        scene.error ??= {name: error?.name ?? 'Error', message: `shutdown failed: ${error?.message ?? String(error)}`, stack: error?.stack ?? null};
      }
    } else {
      try { await manager.shutdownAll(); } catch { /* no task was created */ }
      scene.providerActivity = deriveProviderActivity(null, null, scene.providerActivity.modelRequestAttempted, submitErrorCode);
    }
  }
  scene.ok = scene.error === null && scene.stopped !== null &&
    Array.isArray(scene.stopped.cancelView?.survivorPids) && scene.stopped.cancelView.survivorPids.length === 0;
  return scene;
}

const startedAt = new Date().toISOString();
try {
  for (const name of requested) {
    const scenario = name === 'success' ? 'success' : 'no-progress';
    const scene = await runScene(name, scenario);
    if (!scene.ok) break;
  }
} catch (error) {
  // A top-level failure still preserves whatever scene evidence exists.
  SCENES.__topLevelError = {name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack ?? null};
}

const activityValues = requested.map((name) => {
  const value = SCENES[name]?.providerActivity?.modelRequested;
  return value === true || value === false || value === null ? value : null;
});
const allScenesPresent = requested.every((name) => Boolean(SCENES[name]?.providerActivity));
const modelRequested = requested.length === 0
  ? null
  : activityValues.includes(true)
    ? true
    : activityValues.some((value) => value === null) || !allScenesPresent
      ? null
      : activityValues.every((value) => value === false) ? false : null;
const providerActivity = {
  modelRequestAttempted: requested.some((name) => SCENES[name]?.providerActivity?.modelRequestAttempted === true),
  modelActivityObserved: activityValues.includes(true),
  modelRequested,
  sdkStarted: requested.some((name) => SCENES[name]?.providerActivity?.sdkStarted === true),
  basis: requested.flatMap((name) => (SCENES[name]?.providerActivity?.basis ?? []).map((item) => `${name}: ${item}`)),
  note: 'Separates a submit attempt from observed native SDK/model activity. Unknown is null, never a false positive.',
};

const summary = {
  schema: 'bridge-real-auto-repair@2',
  kind: 'controlled-integration-test',
  startedAt,
  finishedAt: new Date().toISOString(),
  output: OUTPUT,
  scenario: options.scenario,
  modelRequested,
  providerActivity,
  implementationEditedByCodex: false,
  note: 'Controlled mechanism drills only. They do not establish business quality, token/cost savings, product acceptance, or native cross-process SDK resume.',
  requested,
  scenes: SCENES,
  ok: requested.every((name) => SCENES[name]?.ok === true && SCENES[name]?.error === null) && !SCENES.__topLevelError,
};
writeFileSync(path.join(OUTPUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

const compact = Object.fromEntries(requested.map((name) => [name, {
  ok: SCENES[name]?.ok ?? false,
  taskId: SCENES[name]?.taskId ?? null,
  stages: SCENES[name]?.taskSnapshotPath ? readJson(SCENES[name].taskSnapshotPath).stages.length : null,
  providerActivity: SCENES[name]?.providerActivity ?? null,
  error: SCENES[name]?.error?.message ?? null,
}]));
console.log(JSON.stringify({
  ok: summary.ok,
  output: OUTPUT,
  summary: path.join(OUTPUT, 'summary.json'),
  scenes: compact,
  note: 'controlled mechanism drills; no product or cost claim',
}));
if (!summary.ok) process.exitCode = 1;
