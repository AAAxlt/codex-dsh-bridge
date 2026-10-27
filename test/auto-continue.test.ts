/**
 * Bounded provider-exhaustion continuation regressions. The scripted runtime is used so these
 * tests never spend a model request; they prove the state machine and evidence, not real-model
 * quality or any token/time saving.
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';

import {applyScriptedEnv, cleanupDir, makeWorkspace, TEST_ROOT, waitFor} from './helpers.js';

applyScriptedEnv();

const {TaskManager} = await import('../src/tasks.js');
const {resolveAutoContinuePolicy} = await import('../src/delivery-preset.js');

const manager = new TaskManager();
after(async () => {
  await manager.shutdownAll();
  cleanupDir(TEST_ROOT);
});

function setScenario(name: string): void {
  process.env['FAKE_SCENARIO'] = name;
}

function autoContinue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {enabled: true, maxAttempts: 2, noProgressLimit: 2, totalBudgetMs: 60_000, ...overrides};
}

describe('autoContinue policy', () => {
  test('legacy omission is disabled and the complete preset enables the agreed bounds', () => {
    assert.deepEqual(resolveAutoContinuePolicy(undefined), {enabled: false, maxAttempts: 2, noProgressLimit: 2, totalBudgetMs: 3_600_000});
    assert.deepEqual(resolveAutoContinuePolicy(undefined, {complete: true}), {enabled: true, maxAttempts: 2, noProgressLimit: 2, totalBudgetMs: 3_600_000});
    assert.deepEqual(
      resolveAutoContinuePolicy({maxAttempts: 1, noProgressLimit: 1, totalBudgetMs: 5_000}, {complete: true}),
      {enabled: true, maxAttempts: 1, noProgressLimit: 1, totalBudgetMs: 5_000},
    );
    assert.equal(resolveAutoContinuePolicy({enabled: false}, {complete: true}).enabled, false);
  });

  test('invalid inputs are refused before a task directory exists', async () => {
    const workspace = makeWorkspace('auto-continue-invalid');
    for (const invalid of [
      {enabled: 'yes'}, {maxAttempts: 0}, {maxAttempts: 11}, {noProgressLimit: 0},
      {totalBudgetMs: 999}, {totalBudgetMs: 86_400_001}, {maxAttempts: 1.5},
    ]) {
      await assert.rejects(
        () => manager.submit({workspace, goal: 'x', autoContinue: invalid as never}),
        (error: unknown) => (error as {code?: string}).code === 'invalid_delivery_settings',
      );
    }
  });
});

describe('provider exhaustion continuation', () => {
  test('legacy omission leaves an exhausted stage incomplete and starts no continuation', async () => {
    setScenario('max_tokens_then_complete');
    const workspace = makeWorkspace('auto-continue-legacy');
    const record = await manager.submit({workspace, goal: 'Exhaust once.'});
    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId);
    assert.equal(status.state, 'incomplete');
    assert.equal(status.stageCount, 1);
    assert.equal(status.autoContinue.enabled, false);
    assert.equal(status.autoContinue.attempts, 0);
    assert.equal(manager.result(record.taskId).deliverySummary.productAcceptance, 'unverified');
  });

  test('a real max_tokens end continues in the same live session and labels the cause', async () => {
    setScenario('max_tokens_then_complete');
    const workspace = makeWorkspace('auto-continue-hop');
    const record = await manager.submit({workspace, goal: 'Exhaust once then finish.', autoContinue: autoContinue() as never});
    const firstPid = record.runtimePid;
    const settled = await manager.wait(record.taskId, 30_000);
    assert.equal(settled.outcome, 'settled');

    const status = manager.status(record.taskId);
    assert.equal(status.state, 'awaiting_review');
    assert.equal(status.stageCount, 2);
    assert.equal(status.runtimePid, firstPid, 'the continuation must reuse the same live runtime');
    assert.equal(status.autoContinue.attempts, 1);
    assert.equal(status.autoContinue.stopReason, 'completed');
    assert.equal(status.automationMetrics.autoContinuationCount, 1);
    assert.equal(status.automationMetrics.manualCodexContinuationCount, 0);
    assert.equal(status.automationMetrics.codexDirectEditCount, null);

    const stage1 = manager.result(record.taskId, 1);
    const stage2 = manager.result(record.taskId, 2);
    assert.equal(stage1.stageState, 'incomplete');
    assert.equal(stage1.stageCause, 'initial');
    assert.equal(stage2.stageState, 'awaiting_review');
    assert.equal(stage2.stageCause, 'auto-continuation');
    assert.equal(stage1.taskId, stage2.taskId);
    assert.notEqual(stage1.artifacts.stageResult, stage2.artifacts.stageResult);
    assert.ok(existsSync(stage1.artifacts.stageResult!));
    assert.match(readFileSync(stage1.artifacts.stageResult!, 'utf8'), /incomplete/);

    const events = readFileSync(path.join(record.taskDir, 'events.jsonl'), 'utf8');
    assert.match(events, /runtime\/reused/);
    assert.match(events, /auto-continue\/started/);
    const checkpoint = JSON.parse(readFileSync(path.join(record.taskDir, 'checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.automation.autoContinue.attempts, 1);
    assert.equal(checkpoint.automation.metrics.autoContinuationCount, 1);
  });

  test('maxAttempts bounds additional stages', async () => {
    setScenario('max_tokens_always_progress');
    const workspace = makeWorkspace('auto-continue-attempts');
    const record = await manager.submit({
      workspace, goal: 'Always exhaust but keep changing source.',
      autoContinue: autoContinue({maxAttempts: 2, noProgressLimit: 10}) as never,
    });
    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId);
    assert.equal(status.stageCount, 3, 'initial stage plus two bounded continuations');
    assert.equal(status.autoContinue.attempts, 2);
    assert.equal(status.autoContinue.stopReason, 'attempt-limit');
    assert.equal(status.state, 'incomplete');
    assert.equal(status.automationMetrics.autoContinuationCount, 2);
  });

  test('one initial no-change continuation is allowed, then repeated no-progress stops', async () => {
    setScenario('max_tokens_no_write');
    const workspace = makeWorkspace('auto-continue-progress');
    const record = await manager.submit({
      workspace, goal: 'Never edit source.', autoContinue: autoContinue({maxAttempts: 5, noProgressLimit: 2}) as never,
    });
    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId);
    assert.equal(status.stageCount, 2);
    assert.equal(status.autoContinue.attempts, 1);
    assert.equal(status.autoContinue.unchangedFailures, 2);
    assert.equal(status.autoContinue.stopReason, 'no-progress');
    assert.equal(manager.result(record.taskId).sourceProgress.changed, false);
  });

  test('byte-identical staging copies are not source progress', async () => {
    setScenario('max_tokens_no_text');
    const workspace = makeWorkspace('auto-continue-staging');
    const record = await manager.submit({
      workspace, goal: 'Re-write the same bytes.', autoContinue: autoContinue({maxAttempts: 3, noProgressLimit: 2}) as never,
    });
    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId);
    // Stage 1 creates partial.txt (progress), stages 2 and 3 write identical bytes (no progress).
    assert.equal(status.stageCount, 3);
    assert.equal(status.autoContinue.attempts, 2);
    assert.equal(status.autoContinue.stopReason, 'no-progress');
    assert.equal(manager.result(record.taskId, 2).sourceProgress.changed, false);
  });

  test('declared log growth is not source progress', async () => {
    setScenario('log_only_exhaustion');
    const workspace = makeWorkspace('auto-continue-declared-log');
    writeFileSync(path.join(workspace, 'work.txt'), 'stable source\n', 'utf8');
    writeFileSync(path.join(workspace, 'activity.log'), 'initial log\n', 'utf8');
    const check = path.join(workspace, 'accept.cjs');
    writeFileSync(check, 'process.exit(0)');
    const record = await manager.submit({
      workspace, goal: 'Only touch an explicitly declared log.',
      deliverySource: {mode: 'complete', paths: ['work.txt', 'activity.log'], exclude: []},
      verificationCommand: [process.execPath, check], protectedVerificationFiles: [check],
      autoContinue: autoContinue({maxAttempts: 4, noProgressLimit: 2}) as never,
    });
    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId);
    // Declaring activity.log must not let log growth reset the source-progress check.
    assert.equal(status.autoContinue.stopReason, 'no-progress');
    assert.equal(status.autoContinue.attempts, 1);
    assert.ok(status.stageCount <= 3, `log-only edits spent too many stages: ${status.stageCount}`);
    assert.equal(manager.result(record.taskId, 2).sourceProgress.changed, false);
  });

  test('bridge storage truncation is incomplete but never eligible for this path', async () => {
    setScenario('storage_only');
    const workspace = makeWorkspace('auto-continue-storage');
    const record = await manager.submit({workspace, goal: 'Exceed storage.', autoContinue: autoContinue() as never});
    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId);
    assert.equal(status.state, 'incomplete');
    assert.equal(status.stageCount, 1);
    assert.equal(status.autoContinue.attempts, 0);
    assert.equal(status.autoContinue.stopReason, 'bridge-storage-truncation');
  });

  test('preview truncation is not provider exhaustion', async () => {
    setScenario('preview_only');
    const workspace = makeWorkspace('auto-continue-preview');
    const record = await manager.submit({workspace, goal: 'Large report.', autoContinue: autoContinue() as never});
    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId);
    assert.equal(status.state, 'awaiting_review');
    assert.equal(status.stageCount, 1);
    assert.equal(status.autoContinue.attempts, 0);
  });

  test('the initial generation is clamped to the remaining automation budget', async () => {
    setScenario('slow');
    const workspace = makeWorkspace('auto-continue-budget');
    const started = Date.now();
    const record = await manager.submit({
      workspace, goal: 'Hang.', budgetMs: 5_000,
      autoContinue: autoContinue({totalBudgetMs: 1_000}) as never,
    });
    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId);
    assert.equal(status.state, 'timed_out');
    assert.equal(status.runtimeAlive, false);
    assert.ok(Date.now() - started < 4_500, 'the 1s automation budget must clamp the 5s stage budget');
  });

  test('wait does not settle between automatic hops and cancel stops the continuation', async () => {
    setScenario('max_tokens_then_slow');
    const workspace = makeWorkspace('auto-continue-cancel');
    const record = await manager.submit({workspace, goal: 'Hop then hang.', autoContinue: autoContinue({maxAttempts: 2}) as never});
    const inSecondStage = await waitFor(() => {
      const status = manager.status(record.taskId);
      return status.stageCount === 2 && status.state === 'running' ? status : null;
    }, 20_000);

    const waited = await manager.wait(record.taskId, 700);
    assert.equal(waited.outcome, 'timeout', 'a wait must not report settled between automatic hops');
    assert.equal(inSecondStage.autoContinue.attempts, 1);

    const cancelled = await manager.cancel(record.taskId);
    assert.equal(cancelled.cancelled, true);
    const status = manager.status(record.taskId);
    assert.equal(status.state, 'cancelled');
    assert.equal(status.stageCount, 2);
    assert.equal(status.currentStage?.state, 'cancelled');
    assert.equal(status.autoContinue.stopReason, 'continuation-started');
  });

  test('the complete preset enables autoContinue while explicit values still win', async () => {
    setScenario('max_tokens_then_complete');
    const workspace = makeWorkspace('auto-continue-complete');
    const check = path.join(workspace, 'accept.cjs');
    writeFileSync(check, 'process.exit(0)');
    const record = await manager.submit({
      workspace, goal: 'Complete delivery after exhaustion.',
      deliveryPreset: 'complete', verificationCommand: ['node', check], protectedVerificationFiles: [check],
    });
    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId);
    assert.equal(status.autoContinue.enabled, true);
    assert.equal(status.autoContinue.maxAttempts, 2);
    assert.equal(status.autoContinue.noProgressLimit, 2);
    assert.equal(status.stageCount, 2);
    assert.equal(status.state, 'awaiting_review');
    assert.equal(status.externalReview.status, 'none');
  });

  test('a manual continuation starts a fresh cycle but preserves cumulative automation counts', async () => {
    setScenario('max_tokens_always_progress');
    const workspace = makeWorkspace('auto-continue-manual');
    const record = await manager.submit({
      workspace, goal: 'Exhaust twice.', autoContinue: autoContinue({maxAttempts: 1, noProgressLimit: 10}) as never,
    });
    await manager.wait(record.taskId, 30_000);
    assert.equal(manager.status(record.taskId).autoContinue.stopReason, 'attempt-limit');
    assert.equal(manager.status(record.taskId).stageCount, 2);

    await manager.continue(record.taskId, 'Manual intervention for the same unit.');
    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId);
    assert.equal(status.automationMetrics.manualCodexContinuationCount, 1);
    assert.equal(status.autoContinue.attempts, 1, 'a manual continuation resets the cycle counter');
    assert.equal(status.autoContinue.stopReason, 'attempt-limit');
    assert.equal(status.automationMetrics.autoContinuationCount, 2, 'cumulative hops are not erased by the reset');
    assert.equal(status.automationMetrics.manualCodexContinuationCount, 1);
    assert.equal(status.stageCount, 4);
  });

  test('combined automation budgets clamp the hop generation, not just the initial stage', async () => {
    setScenario('max_tokens_then_slow');
    const workspace = makeWorkspace('auto-continue-combined');
    const check = path.join(workspace, 'accept.cjs');
    writeFileSync(check, 'process.exit(1)');
    const started = Date.now();
    const record = await manager.submit({
      workspace, goal: 'Exhaust then hang under a tight combined budget.', budgetMs: 60_000,
      verificationCommand: [process.execPath, check], protectedVerificationFiles: [check],
      autoRepair: {enabled: true, totalBudgetMs: 60_000},
      autoContinue: autoContinue({totalBudgetMs: 1_500, maxAttempts: 2}) as never,
    });
    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId);
    assert.equal(status.stageCount, 2, 'the exhausted stage was continued once');
    assert.equal(status.state, 'timed_out', 'the continuation generation was clamped to the remaining 1.5s budget');
    assert.ok(Date.now() - started < 4_500, 'the hop must not receive a fresh 60s stage budget');
    assert.equal(status.runtimeAlive, false);
  });
});
