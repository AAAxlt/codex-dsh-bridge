/**
 * Delivery-observability contract tests.
 *
 * Every expectation below is a fixed, independently hand-calculated value from a scripted SDK
 * event sequence. Nothing here reads the bridge's own numbers back as the expected answer, and
 * nothing here starts a model request.
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';

import {applyScriptedEnv, cleanupDir, makeWorkspace, TEST_ROOT, waitFor} from './helpers.js';

applyScriptedEnv();

const {TaskManager} = await import('../src/tasks.js');
type StageResultView = import('../src/tasks.js').StageResultView;
type TaskStatusView = import('../src/tasks.js').TaskStatusView;

const manager = new TaskManager();

after(async () => {
  await manager.shutdownAll();
  cleanupDir(TEST_ROOT);
});

function scenario(name: string): void {
  process.env['FAKE_SCENARIO'] = name;
}

function checkpointOf(taskDir: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(taskDir, 'checkpoint.json'), 'utf8')) as Record<string, any>;
}

function markerCommand(marker: string): string[] {
  return [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
}

describe('tool-call totals are independent of retained evidence', () => {
  test('a fixed 75-call sequence reports 75 total while retaining at most 60 observations', async () => {
    scenario('many_tools');
    const workspace = makeWorkspace('many-tools');
    const record = await manager.submit({workspace, goal: 'Run a fixed 75-call sequence.'});
    await manager.wait(record.taskId, 30_000);

    const status = manager.status(record.taskId) as TaskStatusView;
    assert.equal(status.state, 'awaiting_review');
    assert.equal(status.currentStage?.toolCalls, 75, 'the true stage total must not stop at 60');
    assert.equal(status.currentStage?.toolCallsRetained, 60);
    assert.equal(status.currentStage?.toolCallsDropped, 15);
    assert.equal(status.currentStage?.toolCallsTaskTotal, 75);

    const normal = manager.result(record.taskId) as StageResultView;
    assert.equal(normal.bridgeObserved.toolCallsTotal, 75);
    assert.equal(normal.bridgeObserved.toolCallsRetained, 60);
    assert.equal(normal.bridgeObserved.toolCallsShown, 25, 'the default reply shows a bounded preview, not the total');
    assert.equal(normal.bridgeObserved.toolCallsDropped, 15);
    assert.equal(normal.bridgeObserved.toolCallsTaskTotal, 75);
    assert.equal(normal.bridgeObserved.toolResultsTotal, 75);
    assert.equal(normal.bridgeObserved.toolResultsTaskTotal, 75);
    assert.equal(normal.bridgeObserved.toolErrorCount, 2, 'exactly calls 25 and 50 were flagged isError');
    assert.equal(normal.bridgeObserved.toolCounts['read'], 72);
    assert.equal(normal.bridgeObserved.toolCounts['bash'], 3);
    assert.equal(
      Object.values(normal.bridgeObserved.toolCounts).reduce((sum, n) => sum + n, 0),
      75,
      'per-tool counts must cover every call, including dropped observations',
    );

    const verbose = manager.result(record.taskId, undefined, true) as StageResultView;
    assert.equal(verbose.bridgeObserved.toolCallsTotal, 75);
    assert.equal(verbose.bridgeObserved.toolCallsShown, 60);
    assert.equal(verbose.bridgeObserved.toolCalls.length, 60);
  });
});

describe('resends are deduplicated honestly', () => {
  test('a resent usage event with the same message id replaces, not adds', async () => {
    scenario('usage_resend');
    const record = await manager.submit({workspace: makeWorkspace('usage-resend'), goal: 'Resend usage.'});
    await manager.wait(record.taskId, 30_000);
    const result = manager.result(record.taskId) as StageResultView;
    const usage = result.bridgeObserved.usageAccounting;
    assert.equal(usage.records.stageUsageEvents, 1, 'one distinct usage record');
    assert.equal(usage.records.stageUsageEventsObserved, 2, 'two events actually arrived');
    assert.equal(usage.records.resendsDeduplicated, 1);
    assert.equal(usage.stage.inputTokens, 20, 'the corrected counters replace the first draft');
    assert.equal(usage.stage.totalTokens, 227);
    assert.deepEqual(usage.latest, {
      inputTokens: 20, outputTokens: 3, cacheReadTokens: 200, cacheWriteTokens: 4, totalTokens: 227,
    });
    assert.equal(result.deliverySummary.productAcceptance, 'unverified');
  });

  test('a resent tool start/result with the same call id is not counted twice', async () => {
    scenario('tool_resend');
    const record = await manager.submit({workspace: makeWorkspace('tool-resend'), goal: 'Resend tool events.'});
    await manager.wait(record.taskId, 30_000);
    const result = manager.result(record.taskId) as StageResultView;
    assert.equal(result.bridgeObserved.toolCallsTotal, 1);
    assert.equal(result.bridgeObserved.toolResultsTotal, 1);
    assert.equal(result.bridgeObserved.toolErrorCount, 1);
    assert.equal(result.bridgeObserved.toolCounts['bash'], 1);
    assert.equal(result.bridgeObserved.toolCalls.length, 1);
  });
});

describe('usage accounting is hand-calculated, scoped and never invents zero', () => {
  test('two stages with different event counts produce exact latest/stage/task sums', async () => {
    scenario('usage_two_stage');
    const workspace = makeWorkspace('usage-two-stage');
    const record = await manager.submit({workspace, goal: 'Emit known usage events.'});
    await manager.wait(record.taskId, 30_000);

    const stage1 = manager.result(record.taskId, 1) as StageResultView;
    assert.equal(stage1.bridgeObserved.usageAccounting.stage.records, 2);
    assert.deepEqual(stage1.bridgeObserved.usageAccounting.latest, {
      input: 200, output: 30, cacheRead: 2000, cacheWrite: 60, total: 2290,
    });
    // Stage 1: (100+200, 20+30, 1000+2000, 50+60, 1170+2290)
    assert.equal(stage1.bridgeObserved.usageAccounting.stage.inputTokens, 300);
    assert.equal(stage1.bridgeObserved.usageAccounting.stage.outputTokens, 50);
    assert.equal(stage1.bridgeObserved.usageAccounting.stage.cacheReadTokens, 3_000);
    assert.equal(stage1.bridgeObserved.usageAccounting.stage.cacheWriteTokens, 110);
    assert.equal(stage1.bridgeObserved.usageAccounting.stage.totalTokens, 3_460);
    assert.equal(stage1.bridgeObserved.usageAccounting.stage.totalSource, 'reported');

    // `usage` stays the compatibility field: only the LAST raw event, not a total.
    assert.deepEqual(stage1.bridgeObserved.usage, {
      input: 200, output: 30, cacheRead: 2000, cacheWrite: 60, total: 2290,
    });

    await manager.continue(record.taskId, 'Continue with a single known usage event.');
    await manager.wait(record.taskId, 30_000);

    const stage2 = manager.result(record.taskId, 2) as StageResultView;
    assert.equal(stage2.bridgeObserved.usageAccounting.stage.records, 1);
    assert.equal(stage2.bridgeObserved.usageAccounting.stage.inputTokens, 7);
    assert.equal(stage2.bridgeObserved.usageAccounting.stage.outputTokens, 3);
    assert.equal(stage2.bridgeObserved.usageAccounting.stage.cacheReadTokens, 10);
    assert.equal(stage2.bridgeObserved.usageAccounting.stage.cacheWriteTokens, 0);
    assert.equal(stage2.bridgeObserved.usageAccounting.stage.totalTokens, 20);

    // Task scope: stage 1 + stage 2, exactly once. (307, 53, 3010, 110, 3480)
    for (const view of [manager.result(record.taskId, 1) as StageResultView, stage2]) {
      assert.equal(view.bridgeObserved.usageAccounting.task.inputTokens, 307);
      assert.equal(view.bridgeObserved.usageAccounting.task.outputTokens, 53);
      assert.equal(view.bridgeObserved.usageAccounting.task.cacheReadTokens, 3_010);
      assert.equal(view.bridgeObserved.usageAccounting.task.cacheWriteTokens, 110);
      assert.equal(view.bridgeObserved.usageAccounting.task.totalTokens, 3_480);
      assert.equal(view.bridgeObserved.usageAccounting.task.records, 3);
      assert.equal(view.bridgeObserved.usageAccounting.task.stagesWithUsage, 2);
      assert.equal(view.bridgeObserved.usageAccounting.task.stagesTotal, 2);
      assert.equal(view.bridgeObserved.usageAccounting.records.stageUsageEvents, view.stage === 1 ? 2 : 1);
      assert.equal(view.bridgeObserved.usageAccounting.records.taskUsageEvents, 3);
    }
  });

  test('a stage with no usage event reports null, not fabricated zeros', async () => {
    scenario('usage_missing');
    const record = await manager.submit({workspace: makeWorkspace('usage-missing'), goal: 'No usage event.'});
    await manager.wait(record.taskId, 30_000);
    const result = manager.result(record.taskId) as StageResultView;
    assert.equal(result.bridgeObserved.usageAccounting.stage.records, 0);
    assert.equal(result.bridgeObserved.usageAccounting.stage.inputTokens, null);
    assert.equal(result.bridgeObserved.usageAccounting.stage.outputTokens, null);
    assert.equal(result.bridgeObserved.usageAccounting.stage.totalTokens, null);
    assert.equal(result.bridgeObserved.usageAccounting.task.records, 0);
    assert.equal(result.bridgeObserved.usageAccounting.task.totalTokens, null);
    assert.equal(result.bridgeObserved.usage, null);
  });

  test('a partially reported field becomes unknown for the whole scope, never 0', async () => {
    scenario('usage_partial');
    const record = await manager.submit({workspace: makeWorkspace('usage-partial'), goal: 'Partial usage.'});
    await manager.wait(record.taskId, 30_000);
    const result = manager.result(record.taskId) as StageResultView;
    const stage = result.bridgeObserved.usageAccounting.stage;
    assert.equal(stage.records, 2);
    assert.equal(stage.inputTokens, 15);
    assert.equal(stage.outputTokens, null, 'the first event omitted output, so the sum is unknown');
    assert.equal(stage.cacheReadTokens, null);
    assert.equal(stage.totalTokens, null, 'one event omitted total, so no total is claimed');
    assert.ok(stage.unknownFields.includes('outputTokens'));
  });

  test('generic component aliases without a reported total never become totalTokens', async () => {
    scenario('usage_generic_no_total');
    const record = await manager.submit({workspace: makeWorkspace('usage-generic'), goal: 'Generic aliases only.'});
    await manager.wait(record.taskId, 30_000);
    const result = manager.result(record.taskId) as StageResultView;
    const stage = result.bridgeObserved.usageAccounting.stage;
    assert.equal(stage.inputTokens, 100);
    assert.equal(stage.outputTokens, 10);
    assert.equal(stage.cacheReadTokens, 60);
    assert.equal(stage.cacheWriteTokens, 0);
    assert.equal(stage.totalTokens, null, 'no SDK-reported total exists');
    assert.equal(stage.totalSource, 'unknown');
    assert.equal(stage.componentSumTokens, 170, 'arithmetic sum is available only as a labeled component sum');
    assert.match(stage.componentSumNote, /NOT a total or billable amount/i);
    assert.equal(result.bridgeObserved.usageAccounting.task.totalTokens, null);
    assert.equal(result.bridgeObserved.usageAccounting.task.componentSumTokens, 170);
  });
});

describe('verification status is explicit and triggered only by a normal turn end', () => {
  test('a normally completed turn runs the command once and reports passed', async () => {
    scenario('success');
    const record = await manager.submit({
      workspace: makeWorkspace('verify-pass'), goal: 'Pass a real host check.',
      verificationCommand: [process.execPath, '-e', 'process.exit(0)'],
    });
    await manager.wait(record.taskId, 30_000);
    const result = manager.result(record.taskId) as StageResultView;
    assert.equal(result.bridgeObserved.verification.status, 'passed');
    assert.equal(result.bridgeObserved.verification.attempts, 1);
    assert.equal(result.bridgeObserved.verification.lastRun?.exitCode, 0);
    assert.equal(result.bridgeObserved.verification.acceptance, 'check-passed');
    assert.equal(result.deliverySummary.productAcceptance, 'check-passed');
    assert.match(result.deliverySummary.note, /not a product acceptance/i);
  });

  test('a failing verification command clearly fails delivery', async () => {
    scenario('success');
    const record = await manager.submit({
      workspace: makeWorkspace('verify-fail'), goal: 'Fail a real host check.',
      verificationCommand: [process.execPath, '-e', 'process.exit(7)'],
    });
    await manager.wait(record.taskId, 30_000);
    const result = manager.result(record.taskId) as StageResultView;
    assert.equal(result.bridgeObserved.verification.status, 'failed');
    assert.equal(result.bridgeObserved.verification.attempts, 1);
    assert.equal(result.bridgeObserved.verification.lastRun?.exitCode, 7);
    assert.equal(result.deliverySummary.productAcceptance, 'failed');
    assert.equal(result.deliverySummary.verification.exitCode, 7);
    assert.ok(result.unresolved.some((line) => /verification command exited 7/.test(line)));
  });

  test('a timeout never executes the command and records why', async () => {
    scenario('no_turn_end');
    const workspace = makeWorkspace('verify-timeout');
    const marker = path.join(workspace, 'timeout-marker.txt');
    const record = await manager.submit({
      workspace, goal: 'Time out before verification.', budgetMs: 1_200,
      verificationCommand: markerCommand(marker),
    });
    await manager.wait(record.taskId, 30_000);
    const result = manager.result(record.taskId) as StageResultView;
    assert.equal(result.taskState, 'timed_out');
    assert.equal(result.bridgeObserved.verification.status, 'not-run');
    assert.equal(result.bridgeObserved.verification.attempts, 0);
    assert.match(result.bridgeObserved.verification.notRunReason ?? '', /budget/i);
    assert.equal(existsSync(marker), false, 'the host command must not run after a timeout');
    assert.equal(result.deliverySummary.productAcceptance, 'failed');
  });

  test('a cancel never executes the command and records why', async () => {
    scenario('slow');
    const workspace = makeWorkspace('verify-cancel');
    const marker = path.join(workspace, 'cancel-marker.txt');
    const record = await manager.submit({
      workspace, goal: 'Cancel before verification.',
      verificationCommand: markerCommand(marker),
    });
    await waitFor(() => (manager.status(record.taskId).state === 'running' ? true : null), 15_000, 25);
    await manager.cancel(record.taskId);
    const result = manager.result(record.taskId) as StageResultView;
    assert.equal(result.taskState, 'cancelled');
    assert.equal(result.bridgeObserved.verification.status, 'not-run');
    assert.equal(result.bridgeObserved.verification.attempts, 0);
    assert.match(result.bridgeObserved.verification.notRunReason ?? '', /cancelled/i);
    assert.equal(existsSync(marker), false, 'the host command must not run after a cancel');
  });

  test('a failed turn never executes the command and does not look accepted', async () => {
    scenario('turn_end_failed');
    const workspace = makeWorkspace('verify-failed-turn');
    const marker = path.join(workspace, 'failed-marker.txt');
    const record = await manager.submit({
      workspace, goal: 'Fail the turn before verification.',
      verificationCommand: markerCommand(marker),
    });
    await manager.wait(record.taskId, 30_000);
    const result = manager.result(record.taskId) as StageResultView;
    assert.equal(result.stageState, 'failed');
    assert.equal(result.bridgeObserved.verification.status, 'not-run');
    assert.equal(result.bridgeObserved.verification.attempts, 0);
    assert.match(result.bridgeObserved.verification.notRunReason ?? '', /failed/i);
    assert.equal(existsSync(marker), false, 'the host command must not run after a failed turn');
    assert.equal(result.deliverySummary.productAcceptance, 'failed');
  });

  test('a cancel during verification keeps the task cancelled and never reports a pass as acceptance', async () => {
    scenario('success');
    const workspace = makeWorkspace('verify-cancel-running');
    const marker = path.join(workspace, 'verification-started.txt');
    const command = [
      process.execPath, '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setTimeout(() => {}, 1500)`,
    ];
    const record = await manager.submit({workspace, goal: 'Cancel while verification runs.', verificationCommand: command});
    await waitFor(() => (existsSync(marker) ? true : null), 15_000, 25);
    await manager.cancel(record.taskId);
    const result = await waitFor<StageResultView>(() => {
      const view = manager.result(record.taskId) as StageResultView;
      return view.bridgeObserved.verification.status === 'cancelled-during-run' ? view : null;
    }, 15_000, 100);

    assert.equal(result.taskState, 'cancelled');
    assert.equal(result.stageState, 'cancelled');
    assert.equal(result.bridgeObserved.verification.attempts, 1);
    const stoppedCommand = result.bridgeObserved.verification.lastRun!;
    assert.ok(stoppedCommand.exitCode !== null || stoppedCommand.signal !== null, 'record the actual command termination');
    assert.ok(stoppedCommand.exitCode !== 0 || stoppedCommand.signal !== null, 'cancellation interrupts the host verifier as well');
    assert.equal(result.bridgeObserved.verification.cancelledDuringRun, true);
    assert.equal(result.bridgeObserved.verification.acceptance, 'not-evaluated');
    assert.equal(result.deliverySummary.productAcceptance, 'failed');
    assert.ok(result.unresolved.some((line) => /cancelled/i.test(line)));
    const checkpoint = checkpointOf(record.taskDir);
    assert.equal(checkpoint.taskState, 'cancelled');
    assert.equal(checkpoint.verification.status, 'cancelled-during-run');
  });

  test('an incomplete output cutoff does not execute the command', async () => {
    scenario('max_tokens_then_complete');
    const workspace = makeWorkspace('verify-incomplete');
    const marker = path.join(workspace, 'incomplete-marker.txt');
    const record = await manager.submit({
      workspace, goal: 'Cut output off.', maxTokens: 1_200,
      verificationCommand: markerCommand(marker),
    });
    await manager.wait(record.taskId, 30_000);
    const result = manager.result(record.taskId) as StageResultView;
    assert.equal(result.stageState, 'incomplete');
    assert.equal(result.bridgeObserved.verification.status, 'not-run');
    assert.match(result.bridgeObserved.verification.notRunReason ?? '', /incomplete/i);
    assert.equal(existsSync(marker), false);
    assert.equal(result.deliverySummary.productAcceptance, 'unverified');
  });

  test('an omitted command is not-configured, not a pass', async () => {
    scenario('success');
    const record = await manager.submit({workspace: makeWorkspace('verify-none'), goal: 'No host check.'});
    await manager.wait(record.taskId, 30_000);
    const result = manager.result(record.taskId) as StageResultView;
    assert.equal(result.bridgeObserved.verification.status, 'not-configured');
    assert.equal(result.bridgeObserved.verification.attempts, 0);
    assert.equal(result.deliverySummary.productAcceptance, 'unverified');
    assert.ok(result.unresolved.some((line) => /no verificationCommand/.test(line)));
  });
});

describe('machine checkpoints are durable on every terminal path', () => {
  test('normal completion writes an atomic checkpoint with machine facts only', async () => {
    scenario('success');
    const record = await manager.submit({workspace: makeWorkspace('checkpoint-ok'), goal: 'Write notes.'});
    await manager.wait(record.taskId, 30_000);
    const result = manager.result(record.taskId) as StageResultView;
    assert.equal(result.artifacts.checkpoint, path.join(record.taskDir, 'checkpoint.json'));
    const checkpoint = checkpointOf(record.taskDir);
    assert.equal(checkpoint.schema, 'codex-dsh-bridge/checkpoint@1');
    assert.equal(checkpoint.taskId, record.taskId);
    assert.equal(checkpoint.stage, 1);
    assert.equal(checkpoint.stageState, 'awaiting_review');
    assert.equal(checkpoint.taskState, 'awaiting_review');
    assert.deepEqual(checkpoint.changes.added, ['notes.md']);
    assert.equal(checkpoint.verification.status, 'not-configured');
    assert.equal(checkpoint.modelReport.isModelSelfReport, true);
    assert.match(checkpoint.modelReport.path, /stage-1-report\.md$/);
    assert.equal(checkpoint.resume.sdkCrossProcessResume, false);
    assert.match(checkpoint.resume.note, /NOT SDK cross-process session recovery/i);
    assert.ok(existsSync(path.join(record.taskDir, 'checkpoints', 'stage-1.json')));
    assert.deepEqual(
      readdirSync(record.taskDir).filter((name) => name.endsWith('.tmp')),
      [],
      'the checkpoint must be renamed into place, leaving no partial temp file',
    );
  });

  test('cancel, timeout and error each write a checkpoint naming the real state', async () => {
    const cases: Array<{scenario: string; expected: string; run: (record: {taskId: string}) => Promise<void>}> = [
      {
        scenario: 'slow', expected: 'cancelled',
        run: async (record) => {
          await waitFor(() => (manager.status(record.taskId).state === 'running' ? true : null), 15_000, 25);
          await manager.cancel(record.taskId);
        },
      },
      {
        scenario: 'no_turn_end', expected: 'timed_out',
        run: async () => { /* the short budget settles it */ },
      },
      {
        scenario: 'turn_end_failed', expected: 'failed',
        run: async () => { /* the turn/end error settles it */ },
      },
    ];
    for (const item of cases) {
      scenario(item.scenario);
      const workspace = makeWorkspace(`checkpoint-${item.expected}`);
      const record = await manager.submit({workspace, goal: `checkpoint ${item.expected}`, budgetMs: 1_200});
      await item.run(record);
      if (item.expected === 'timed_out' || item.expected === 'failed') await manager.wait(record.taskId, 30_000);
      const checkpoint = checkpointOf(record.taskDir);
      assert.equal(checkpoint.taskState, item.expected, `${item.scenario} checkpoint state`);
      assert.equal(checkpoint.stage, 1);
      assert.ok(checkpoint.resume, 'every checkpoint must state its resume limits');
      assert.equal(checkpoint.resume.sdkCrossProcessResume, false);
      assert.ok(existsSync(path.join(record.taskDir, 'events.jsonl')), 'the original event log is still there');
      assert.ok(existsSync(path.join(record.taskDir, 'evidence', 'stage-1-result.json')));
    }
  });
});

describe('runtime-exit checkpoints preserve the observed failure', () => {
  test('a runtime that dies mid-stage writes a failed checkpoint with its real exit code', async () => {
    scenario('crash_after_ack');
    const record = await manager.submit({workspace: makeWorkspace('checkpoint-crash'), goal: 'Crash mid-stage.'});
    await manager.wait(record.taskId, 30_000);
    const checkpoint = checkpointOf(record.taskDir);
    assert.equal(checkpoint.taskState, 'failed');
    assert.equal(checkpoint.stageState, 'failed');
    assert.equal(checkpoint.runtimeExit.code, 3);
    assert.ok(checkpoint.errors.some((line: string) => /runtime exited \(code=3/.test(line)));
    assert.equal(checkpoint.resume.sdkCrossProcessResume, false);
  });
});
