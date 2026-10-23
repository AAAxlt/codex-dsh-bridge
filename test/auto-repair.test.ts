import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {after, test} from 'node:test';
import {applyScriptedEnv, makeWorkspace, cleanupDir, TEST_ROOT, waitFor} from './helpers.js';
applyScriptedEnv();
const {TaskManager} = await import('../src/tasks.js');
const manager = new TaskManager();
after(async () => { await manager.shutdownAll(); cleanupDir(TEST_ROOT); });

async function run(checker: string, extra = {}) {
  process.env['FAKE_SCENARIO'] = 'success';
  const workspace = makeWorkspace('auto-repair');
  const check = path.join(workspace, 'accept.cjs');
  writeFileSync(check, checker);
  const record = await manager.submit({workspace, goal: 'Implement and verify.', verificationCommand: ['node', check], protectedVerificationFiles: [check], autoRepair: {enabled: true}, ...extra});
  await manager.wait(record.taskId, 30_000);
  return {record, result: manager.result(record.taskId), status: manager.status(record.taskId), workspace, check};
}

test('failed host check repairs in the same session, preserves stages and exports final evidence', async () => {
  const {record, result, status, workspace} = await run("const fs=require('fs'); if(!fs.readFileSync('notes.md','utf8').includes('stage 2')){console.error('expected stage 2');process.exit(7)}");
  assert.equal(status.stageCount, 2);
  assert.equal(result.bridgeObserved.verification.status, 'passed');
  assert.equal(result.autoRepair.stopReason, 'passed');
  assert.equal(record.totalAutoRepairs, 1);
  assert.equal(record.codexContinuationCount, 0);
  assert.match(record.stages[1]!.prompt, /exitCode=7/);
  assert.match(record.stages[1]!.prompt, /expected stage 2/);
  assert.equal(manager.result(record.taskId, 1).bridgeObserved.verification.lastRun?.exitCode, 7);
  const events = readFileSync(path.join(record.taskDir, 'events.jsonl'), 'utf8');
  assert.match(events, /runtime\/reused/);
  assert.equal((events.match(/runtime\/started/g) ?? []).length, 1);
  const index = JSON.parse(readFileSync(path.join(record.taskDir, 'delivery/index.json'), 'utf8'));
  assert.equal(index.metrics.autoRepairCount, 1);
  assert.equal(index.metrics.firstVerificationPassed, false);
  assert.equal(index.metrics.codexTokens, null);
  const destination = path.join(workspace, 'exported');
  const exported = manager.exportDelivery(record.taskId, destination);
  assert.ok(existsSync(exported.indexJson));
  assert.equal(JSON.parse(readFileSync(exported.indexJson, 'utf8')).hostVerification.latest.status, 'passed');
});

test('unchanged failures stop without Codex intervention and never become a pass', async () => {
  const {status, result} = await run("console.error('fixed failure'); process.exit(9)", {autoRepair: {enabled: true, maxAttempts: 5, noProgressLimit: 2}});
  assert.equal(status.stageCount, 3);
  assert.equal(result.autoRepair.stopReason, 'no-progress');
  assert.equal(result.deliverySummary.productAcceptance, 'failed');
});

test('attempt limit stops even when failures differ', async () => {
  const {status, result} = await run("console.error(require('fs').readFileSync('notes.md','utf8'));process.exit(1)", {autoRepair: {enabled: true, maxAttempts: 1}});
  assert.equal(status.stageCount, 2);
  assert.equal(result.autoRepair.stopReason, 'attempt-limit');
});

test('changed acceptance file after model work prevents command execution', async () => {
  process.env['FAKE_SCENARIO'] = 'success';
  const workspace = makeWorkspace('protected');
  const check = path.join(workspace, 'accept.cjs');
  writeFileSync(check, 'process.exit(9)');
  const record = await manager.submit({workspace, goal: 'Work', verificationCommand: ['node', check], protectedVerificationFiles: [check], autoRepair: {enabled: true}});
  writeFileSync(check, 'process.exit(0)');
  await manager.wait(record.taskId, 30_000);
  const result = manager.result(record.taskId);
  assert.equal(result.stageState, 'blocked');
  assert.equal(result.bridgeObserved.verification.attempts, 0);
  assert.equal(result.bridgeObserved.verification.acceptance, 'check-failed');
  assert.equal(result.autoRepair.stopReason, 'protected-verifier-changed');
});

test('a verifier that changes itself and exits zero is rejected after execution', async () => {
  const {result} = await run("require('fs').appendFileSync(__filename,'\\n// changed'); process.exit(0)");
  assert.equal(result.bridgeObserved.verification.lastRun?.exitCode, 0);
  assert.equal(result.bridgeObserved.verification.acceptance, 'check-failed');
  assert.equal(result.stageState, 'blocked');
});

test('whole loop budget includes host verification and stops further repair', async () => {
  const {result, status} = await run("setTimeout(()=>process.exit(1),5000)", {autoRepair: {enabled: true, totalBudgetMs: 1000}});
  assert.equal(status.stageCount, 1);
  assert.equal(result.bridgeObserved.verification.status, 'timed-out');
  assert.equal(result.autoRepair.stopReason, 'total-budget-exhausted');
});

test('cancellation during verification prevents automatic continuation', async () => {
  process.env['FAKE_SCENARIO'] = 'success';
  const workspace = makeWorkspace('cancel-auto');
  const check = path.join(workspace, 'accept.cjs');
  writeFileSync(check, "require('fs').writeFileSync('checking','1');setTimeout(()=>process.exit(1),500)");
  const record = await manager.submit({workspace, goal: 'Work', verificationCommand: ['node', check], protectedVerificationFiles: [check], autoRepair: {enabled: true}});
  await waitFor(() => existsSync(path.join(workspace, 'checking')));
  assert.equal(manager.status(record.taskId).awaiting, true);
  await manager.cancel(record.taskId);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(manager.status(record.taskId).state, 'cancelled');
  assert.equal(record.stages.length, 1);
  assert.equal(manager.result(record.taskId).bridgeObserved.verification.status, 'cancelled-during-run');
});
