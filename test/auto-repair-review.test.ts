/** Independent state-machine review cases. All execution uses the scripted runtime. */
import assert from 'node:assert/strict';
import {existsSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {applyScriptedEnv, cleanupDir, makeWorkspace, TEST_ROOT, waitFor} from './helpers.js';

applyScriptedEnv();
const {TaskManager, BridgeError} = await import('../src/tasks.js');
const managers: InstanceType<typeof TaskManager>[] = [];
function manager(): InstanceType<typeof TaskManager> {
  process.env['FAKE_SCENARIO'] = 'success';
  const value = new TaskManager();
  managers.push(value);
  return value;
}
after(async () => {
  for (const value of managers) await value.shutdownAll();
  cleanupDir(TEST_ROOT);
});

function gatedVerifier(workspace: string): string {
  const script = path.join(workspace, 'accept.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    "fs.writeFileSync('verifier-started.txt', 'started');",
    "const timer = setInterval(() => { if (fs.existsSync('release.txt')) { clearInterval(timer); process.exit(0); } }, 10);",
  ].join('\n'));
  return script;
}

describe('independent automatic repair review', () => {
  test('verification owns the concurrency slot and wait only settles after verification', async () => {
    const value = manager();
    const workspace = makeWorkspace('repair-review-wait');
    const script = gatedVerifier(workspace);
    const record = await value.submit({workspace, goal: 'Complete normally, then verify.',
      verificationCommand: ['node', script], protectedVerificationFiles: [script], autoRepair: {enabled: true}});
    await waitFor(() => existsSync(path.join(workspace, 'verifier-started.txt')), 10_000, 10);
    assert.equal(value.status(record.taskId).state, 'running');
    await assert.rejects(value.submit({workspace, goal: 'Must not compete with verification.'}),
      (error: unknown) => error instanceof BridgeError && error.code === 'concurrency_limit');
    let settled = false;
    const waiting = value.wait(record.taskId, 5_000).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(settled, false, 'wait must not expose an early review handoff');
    writeFileSync(path.join(workspace, 'release.txt'), 'release');
    assert.equal((await waiting).outcome, 'settled');
    assert.equal(value.status(record.taskId).autoRepair.stopReason, 'passed');
    assert.equal(value.status(record.taskId).stageCount, 1);
    await value.cancel(record.taskId);
  });

  test('an explicit permission blocker hands off without an automatic continuation', async () => {
    const value = manager();
    const workspace = makeWorkspace('repair-review-permission');
    const script = path.join(workspace, 'accept.cjs');
    writeFileSync(script, "console.error('EACCES: permission denied accessing external resource'); process.exit(1);\n");
    const record = await value.submit({workspace, goal: 'Stop if access is denied.',
      verificationCommand: ['node', script], protectedVerificationFiles: [script], autoRepair: {enabled: true}});
    await value.wait(record.taskId, 5_000);
    assert.equal(value.status(record.taskId).autoRepair.stopReason, 'external-blocker');
    assert.equal(value.status(record.taskId).stageCount, 1);
    assert.equal(value.result(record.taskId).bridgeObserved.verification.status, 'failed');
    assert.equal(value.result(record.taskId).deliverySummary.productAcceptance, 'failed');
    await value.cancel(record.taskId);
  });

  test('hash protection covers declared files, so callers must include verifier dependencies', async () => {
    // This documents the guard boundary rather than claiming sandbox isolation:
    // unlisted local verifier dependencies are writable and not hash-checked.
    for (const protectDependency of [false, true]) {
      const value = manager();
      const workspace = makeWorkspace('repair-review-dependency');
      const script = path.join(workspace, 'accept.cjs');
      const dependency = path.join(workspace, 'assertion.cjs');
      writeFileSync(script, "process.exit(require('./assertion.cjs')() ? 0 : 1);\n");
      writeFileSync(dependency, 'module.exports = () => false;\n');
      const record = await value.submit({workspace, goal: 'A dependency must not redefine acceptance.',
        verificationCommand: ['node', script], protectedVerificationFiles: protectDependency ? [script, dependency] : [script],
        autoRepair: {enabled: true}});
      // The fake runtime acknowledges immediately, then starts its turn 30 ms later.
      writeFileSync(dependency, 'module.exports = () => true;\n');
      await value.wait(record.taskId, 5_000);
      assert.equal(value.status(record.taskId).state, protectDependency ? 'blocked' : 'awaiting_review');
      assert.equal(value.result(record.taskId).bridgeObserved.verification.status, protectDependency ? 'errored' : 'passed');
      await value.cancel(record.taskId);
    }
  });

  test('a late integrity failure cannot replace a completed cancellation with blocked', async () => {
    const value = manager();
    const workspace = makeWorkspace('repair-review-cancel-integrity');
    const script = gatedVerifier(workspace);
    const record = await value.submit({workspace, goal: 'Cancel while independent verification waits.',
      verificationCommand: ['node', script], protectedVerificationFiles: [script], autoRepair: {enabled: true}});
    await waitFor(() => existsSync(path.join(workspace, 'verifier-started.txt')), 10_000, 10);
    await value.cancel(record.taskId);
    assert.equal(value.status(record.taskId).state, 'cancelled');
    writeFileSync(script, '// modified after cancellation, before verification returned\n');
    writeFileSync(path.join(workspace, 'release.txt'), 'release');
    await waitFor(() => value.result(record.taskId).bridgeObserved.verification.lastRun !== null, 10_000, 10);
    assert.equal(value.status(record.taskId).state, 'cancelled');
    assert.equal(value.result(record.taskId).stageState, 'cancelled');
    assert.notEqual(value.result(record.taskId).deliverySummary.productAcceptance, 'check-passed');
    assert.equal(value.status(record.taskId).stageCount, 1);
  });

  test('a late integrity failure cannot replace a shutdown failure with blocked', async () => {
    const value = manager();
    const workspace = makeWorkspace('repair-review-shutdown-integrity');
    const script = gatedVerifier(workspace);
    const record = await value.submit({workspace, goal: 'Shut down during independent verification.',
      verificationCommand: ['node', script], protectedVerificationFiles: [script], autoRepair: {enabled: true}});
    await waitFor(() => existsSync(path.join(workspace, 'verifier-started.txt')), 10_000, 10);
    await value.shutdownAll();
    assert.equal(value.status(record.taskId).state, 'failed');
    writeFileSync(script, '// modified after shutdown, before verification returned\n');
    writeFileSync(path.join(workspace, 'release.txt'), 'release');
    await waitFor(() => value.result(record.taskId).bridgeObserved.verification.lastRun !== null, 10_000, 10);
    assert.equal(value.status(record.taskId).state, 'failed');
    assert.equal(value.result(record.taskId).stageState, 'failed');
    assert.equal(value.result(record.taskId).deliverySummary.productAcceptance, 'failed');
    assert.equal(value.status(record.taskId).stageCount, 1);
  });

  test('verification timeout bounds finalisation even when a descendant inherits output pipes', async () => {
    const value = manager();
    const workspace = makeWorkspace('repair-review-descendant-timeout');
    const script = path.join(workspace, 'accept.cjs');
    writeFileSync(script, [
      "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 3000)'], {stdio: 'inherit', windowsHide: true});",
      'setTimeout(() => process.exit(1), 10000);',
    ].join('\n'));
    const record = await value.submit({workspace, goal: 'Honor the verification and whole-loop deadlines.',
      verificationCommand: ['node', script], verificationTimeoutMs: 1_000,
      protectedVerificationFiles: [script], autoRepair: {enabled: true, totalBudgetMs: 1_000}});
    await value.wait(record.taskId, 5_000);
    const verification = value.result(record.taskId).bridgeObserved.verification;
    assert.equal(verification.status, 'timed-out');
    assert.ok(verification.lastRun!.durationMs < 2_000,
      `host verification took ${verification.lastRun!.durationMs}ms despite its 1000ms timeout`);
    assert.equal(value.status(record.taskId).stageCount, 1);
    await value.cancel(record.taskId);
  });
});
