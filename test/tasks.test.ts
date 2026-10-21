/**
 * State-machine and failure-handling tests. These drive the TaskManager against the
 * scripted runtime (test/fixtures/fake-runtime.mjs) so every branch below is exercised
 * without spending a model request and without depending on a live provider.
 *
 * What is deliberately NOT here: any claim that a real model did the work. The real-model
 * closed loop lives in e2e-real.test.ts and is opt-in.
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';

import {applyScriptedEnv, cleanupDir, makeWorkspace, TEST_ROOT, waitFor} from './helpers.js';

// Must run before ../src/config.js is first imported: config reads its environment once.
applyScriptedEnv();

const {TaskManager, BridgeError, LIVE_STATES} = await import('../src/tasks.js');
type TaskStatusView = import('../src/tasks.js').TaskStatusView;
type StageResultView = import('../src/tasks.js').StageResultView;

interface StatusView extends TaskStatusView {}
interface ResultView extends StageResultView {}

function setScenario(name: string): void {
  process.env['FAKE_SCENARIO'] = name;
}

const manager = new TaskManager();

after(async () => {
  await manager.shutdownAll();
  cleanupDir(TEST_ROOT);
});

describe('eight-state task machine (scripted runtime)', () => {
  test('accepted/starting/running are the live states; the rest are settled', () => {
    assert.deepEqual([...LIVE_STATES], ['accepted', 'starting', 'running']);
  });

  test('submit exposes starting synchronously, then runs the stage to awaiting_review', async () => {
    setScenario('success');
    const workspace = makeWorkspace('ok');
    const pending = manager.submit({workspace, goal: 'Write notes.md and report it.'});

    // submit() runs synchronously as far as the runtime handshake, so the caller can observe
    // that a live slot is taken before the model is ever prompted.
    const during = manager.listTasks().find((t) => t.workspace === workspace);
    assert.ok(during, 'the task must be registered before the handshake completes');
    assert.equal(during.state, 'starting');

    const record = await pending;
    assert.ok(['running', 'awaiting_review'].includes(record.state), `unexpected state ${record.state}`);

    const settled = await manager.wait(record.taskId, 30_000);
    assert.equal(settled.outcome, 'settled');

    const status = manager.status(record.taskId) as StatusView;
    assert.equal(status.state, 'awaiting_review');
    assert.equal(status.currentStage!.state, 'awaiting_review');
    assert.equal(status.currentStage!.turn, 1);
    assert.ok(status.currentStage!.messageId, 'the prompt acknowledgement messageId must be recorded');

    const result = manager.result(record.taskId) as ResultView;
    assert.equal(result.taskState, 'awaiting_review');
    assert.match(result.modelReport.text, /stage 1 draft complete/);
    assert.equal(result.bridgeObserved.toolCounts['write'], 1);
    assert.equal(result.bridgeObserved.toolErrorCount, 0);
    assert.ok(result.bridgeObserved.filesChanged, 'file changes must be observed, not implied');
    assert.deepEqual(result.bridgeObserved.filesChanged?.added, ['notes.md']);
    assert.ok(existsSync(path.join(workspace, 'notes.md')), 'the model really did write the file');
    assert.deepEqual(result.errors, []);
  });

  test('the bridge runs its own verification command and reports its own exit code', async () => {
    setScenario('success');
    const workspace = makeWorkspace('verify');
    const record = await manager.submit({
      workspace,
      goal: 'Write notes.md.',
      verificationCommand: [process.execPath, '-e', 'process.stdout.write("bridge-ran-me")'],
    });
    await manager.wait(record.taskId, 30_000);

    const result = manager.result(record.taskId) as ResultView;
    assert.equal(result.bridgeObserved.verificationCommand?.exitCode, 0);
    assert.equal(result.bridgeObserved.verificationCommand?.timedOut, false);
    // Platform-neutral: the recorded argv[0] must be the node binary that actually ran, whether
    // that is 'node.exe' on Windows or a bare 'node' on POSIX.
    assert.equal(result.bridgeObserved.verificationCommand?.argv[0], process.execPath);
    // A run verification must not be reported as "no check was run"; the honesty disclaimer stays.
    assert.ok(!result.unresolved.some((line) => /no verificationCommand/.test(line)));
    assert.ok(result.unresolved.some((line) => /cannot confirm the model obeyed/.test(line)));
  });

  test('a tool that reports isError is counted as an error even when the turn completes', async () => {
    setScenario('tool_error');
    const workspace = makeWorkspace('toolerr');
    const record = await manager.submit({workspace, goal: 'Run a failing command.'});
    await manager.wait(record.taskId, 30_000);

    const result = manager.result(record.taskId) as ResultView;
    assert.equal(result.taskState, 'awaiting_review', 'a failing tool is not by itself a failed task');
    assert.equal(result.bridgeObserved.toolErrorCount, 1);
    assert.equal(result.bridgeObserved.toolCounts['bash'], 1);
  });

  test('turn/end with reason kind=error settles the task as failed and keeps the reason', async () => {
    setScenario('turn_end_failed');
    const workspace = makeWorkspace('turnfail');
    const record = await manager.submit({workspace, goal: 'Fail on purpose.'});
    await manager.wait(record.taskId, 30_000);

    const status = manager.status(record.taskId) as StatusView;
    assert.equal(status.state, 'failed');
    const result = manager.result(record.taskId) as ResultView;
    assert.match(result.errors.join(' '), /provider refused the request/);
    assert.match(result.errors.join(' '), /provider_error/);
    assert.deepEqual(
      result.bridgeObserved.turnEndReason,
      {kind: 'error', error: {message: 'provider refused the request', code: 'provider_error'}},
    );
  });

  test('a runtime that dies mid-stage fails the task and records the exit', async () => {
    setScenario('crash_after_ack');
    const workspace = makeWorkspace('crash');
    const record = await manager.submit({workspace, goal: 'Die mid-stage.'});
    await manager.wait(record.taskId, 30_000);

    const status = manager.status(record.taskId) as StatusView;
    assert.equal(status.state, 'failed');
    assert.equal(status.runtimeAlive, false);
    const result = manager.result(record.taskId) as ResultView;
    assert.match(result.errors.join(' '), /runtime exited \(code=3/);
    const exit = result.bridgeObserved.runtimeExit as {code: number | null; signal: string | null; at: string};
    assert.equal(exit.code, 3);
    assert.equal(exit.signal, null);
    assert.ok(exit.at, 'the exit must be timestamped from the bridge\'s own observation');
  });

  test('budget expiry is timed_out, not success, and the runtime is stopped', async () => {
    setScenario('no_turn_end');
    const workspace = makeWorkspace('budget');
    const record = await manager.submit({workspace, goal: 'Never finish.', budgetMs: 1_200});
    const settled = await manager.wait(record.taskId, 30_000);
    assert.equal(settled.outcome, 'settled');

    const status = manager.status(record.taskId) as StatusView;
    assert.equal(status.state, 'timed_out');
    assert.equal(status.runtimeAlive, false, 'a timed-out task must not leave its SDK process running');
    const result = manager.result(record.taskId) as ResultView;
    assert.match(result.errors.join(' '), /budget of 1200ms exceeded/);
  });

  test('dsh_wait_task timing out does not change the task state', async () => {
    setScenario('no_turn_end');
    const workspace = makeWorkspace('waitbudget');
    const record = await manager.submit({workspace, goal: 'Hang for a while.', budgetMs: 30_000});
    const waited = await manager.wait(record.taskId, 700);
    assert.equal(waited.outcome, 'timeout');
    const status = manager.status(record.taskId) as StatusView;
    assert.ok(['running', 'awaiting_review'].includes(status.state), `state moved to ${status.state} on a wait timeout`);
    await manager.cancel(record.taskId);
  });

  test('approval/asked parks the task as blocked instead of silently approving', async () => {
    setScenario('approval');
    const workspace = makeWorkspace('approval');
    const record = await manager.submit({workspace, goal: 'Do something that needs approval.'});
    const status = await waitFor(() => {
      const view = manager.status(record.taskId) as StatusView;
      return view.state === 'blocked' ? view : null;
    }, 20_000);

    assert.equal(status.state, 'blocked');
    const result = manager.result(record.taskId) as ResultView;
    assert.equal(result.bridgeObserved.approvalsRequested.length, 1);
    const unresolved = result.unresolved.join(' ');
    assert.match(unresolved, /approval/i, 'an unanswered approval must be reported as unresolved');
    await manager.cancel(record.taskId);
  });

  test('cancel stops the task-owned SDK process and verifies it is gone', async () => {
    setScenario('slow');
    const workspace = makeWorkspace('cancel');
    const record = await manager.submit({workspace, goal: 'Take a long time.'});
    const pid = (manager.status(record.taskId) as StatusView).runtimePid;
    assert.ok(pid && pid > 0, 'the task must own a real process to cancel');

    const cancelled = await manager.cancel(record.taskId);
    assert.equal(cancelled.runtimeStopped, true, 'cancel must be verified, not merely requested');
    assert.equal(cancelled.pid, pid);
    // The method string now records the whole ladder, sweep included, so the claim is "the
    // cooperative path was taken and no forced kill was needed".
    assert.match(cancelled.method ?? '', /^shutdown-rpc/, 'a cooperative shutdown is preferred over a kill');
    assert.ok(!/sigterm|sigkill|taskkill/.test(cancelled.method ?? ''),
      `no forced kill should have been needed: ${cancelled.method}`);
    if (process.platform === 'win32') {
      // Windows cannot enumerate a task tree: the platform must report a PARTIAL claim, never a pass.
      assert.equal(cancelled.treeVerified, false, 'Windows must not claim a verified task tree');
      assert.equal(cancelled.survivorPids, null);
      assert.equal(cancelled.fullyStopped, false, 'an unverifiable platform must not claim a fully stopped task');
    } else {
      assert.equal(cancelled.treeVerified, true, 'this platform must be able to verify the task tree');
      assert.deepEqual(cancelled.survivorPids, [], 'the sweep must leave nothing behind');
      assert.equal(cancelled.fullyStopped, true, 'the fully-stopped claim requires a verified tree');
    }

    let alive = true;
    try { process.kill(pid!, 0); } catch { alive = false; }
    assert.equal(alive, false, `pid ${pid} must be gone after cancel`);

    const status = manager.status(record.taskId) as StatusView;
    assert.equal(status.state, 'cancelled');
    const result = manager.result(record.taskId) as ResultView;
    assert.match(result.errors.join(' '), /cancelled/);
  });

  test('a failed handshake is reported as failed, not as a running task', async () => {
    setScenario('bad_handshake');
    const workspace = makeWorkspace('badstart');
    await assert.rejects(
      () => manager.submit({workspace, goal: 'Never handshakes.'}),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, 'runtime_start_failed');
        assert.match(error.message, /scripted handshake failure/);
        return true;
      },
    );
    const listed = manager.listTasks().find((t) => t.workspace === workspace);
    assert.ok(listed, 'the failed task must remain inspectable');
    assert.equal(listed.state, 'failed');
  });

  test('a runtime that never answers initialize times out rather than hanging forever', async () => {
    setScenario('no_initialize');
    const workspace = makeWorkspace('noinit');
    await assert.rejects(
      () => manager.submit({workspace, goal: 'Stay silent.'}),
      (error: unknown) => error instanceof BridgeError && error.code === 'runtime_start_failed',
    );
  });

  test('a runtime that never acknowledges the prompt fails the stage', async () => {
    setScenario('silent_after_ack');
    const workspace = makeWorkspace('silent');
    // silent_after_ack does answer session/prompt, so the ack still arrives; the turn simply
    // never ends. A short budget is what proves the ack path is not treated as completion.
    const record = await manager.submit({workspace, goal: 'Acknowledge then do nothing.', budgetMs: 1_000});
    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId) as StatusView;
    assert.equal(status.state, 'timed_out');
  });
});

describe('bridge refusals (no model required)', () => {
  test('unknown taskId is refused with the known-task list', () => {
    assert.throws(
      () => manager.status('task-does-not-exist'),
      (error: unknown) => error instanceof BridgeError && error.code === 'unknown_task',
    );
  });

  test('a workspace outside the allowed roots is refused before anything is spawned', async () => {
    setScenario('success');
    await assert.rejects(
      () => manager.submit({workspace: 'C:\\Windows', goal: 'Escape.'}),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, 'workspace_rejected');
        return true;
      },
    );
  });

  test('traversal out of an allowed root is refused', async () => {
    setScenario('success');
    await assert.rejects(
      () => manager.submit({workspace: path.join(TEST_ROOT, '..', '..'), goal: 'Escape by ..'}),
      (error: unknown) => error instanceof BridgeError && error.code === 'workspace_rejected',
    );
  });

  test('the concurrency limit refuses a second live task', async () => {
    setScenario('slow');
    const first = await manager.submit({workspace: makeWorkspace('conc1'), goal: 'Hold the only slot.'});
    setScenario('success');
    await assert.rejects(
      () => manager.submit({workspace: makeWorkspace('conc2'), goal: 'Should not start.'}),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, 'concurrency_limit');
        assert.match(error.message, /concurrency limit reached \(1\)/);
        return true;
      },
    );
    await manager.cancel(first.taskId);
  });

  test('continuing a cancelled task is refused', async () => {
    setScenario('slow');
    const record = await manager.submit({workspace: makeWorkspace('contcancel'), goal: 'Then get cancelled.'});
    await manager.cancel(record.taskId);
    await assert.rejects(
      () => manager.continue(record.taskId, 'please redo it'),
      (error: unknown) => error instanceof BridgeError && error.code === 'task_cancelled',
    );
  });

  test('result for a stage that does not exist is refused', () => {
    const task = manager.listTasks()[0];
    assert.ok(task, 'at least one task must exist by now');
    assert.throws(
      () => manager.result(task.taskId, 99),
      (error: unknown) => error instanceof BridgeError && error.code === 'unknown_stage',
    );
  });

  test('an over-long verificationCommand is refused', async () => {
    setScenario('success');
    await assert.rejects(
      () => manager.submit({
        workspace: makeWorkspace('badcmd'),
        goal: 'x',
        verificationCommand: Array.from({length: 40}, (_v, i) => `arg${i}`),
      }),
      (error: unknown) => error instanceof BridgeError && error.code === 'invalid_command',
    );
  });
});

describe('two-stage continuation in one live session', () => {
  test('stage 2 reuses the same session and keeps stage 1 evidence separate', async () => {
    setScenario('success');
    const workspace = makeWorkspace('continue');
    const first = await manager.submit({workspace, goal: 'Stage one goal.', acceptance: 'notes.md exists.'});
    await manager.wait(first.taskId, 30_000);

    const stage1 = manager.result(first.taskId) as ResultView;
    assert.equal(stage1.stage, 1);
    assert.equal(stage1.bridgeObserved.filesChanged?.added.length, 1);

    const second = await manager.continue(first.taskId, 'Codex review: notes.md is wrong, rewrite it.', 'notes.md now says stage 2.');
    assert.equal(second.sessionId, first.sessionId, 'continuation must reuse the live session');
    assert.equal(second.runtimePid, first.runtimePid, 'continuation must reuse the live process');
    await manager.wait(first.taskId, 30_000);

    const stage2 = manager.result(first.taskId) as ResultView;
    assert.equal(stage2.stage, 2);
    assert.equal(stage2.taskState, 'awaiting_review');
    assert.match(stage2.modelReport.text, /stage 2 draft complete/);
    assert.equal(stage2.bridgeObserved.toolCallsTotal, 1, 'stage 2 evidence must be its own, not stage 1 plus stage 2');

    // Stage 1 must still be readable and unchanged: rewriting history is the failure mode here.
    const stage1Again = manager.result(first.taskId, 1) as ResultView;
    assert.equal(stage1Again.stage, 1);
    assert.match(stage1Again.modelReport.text, /stage 1 draft complete/);
    assert.notEqual(stage1Again.artifacts.stageResult, stage2.artifacts.stageResult);
    assert.ok(stage1Again.artifacts.stageResult && existsSync(stage1Again.artifacts.stageResult));
    assert.ok(stage2.artifacts.stageResult && existsSync(stage2.artifacts.stageResult));

    const record = JSON.parse(readFileSync(path.join(first.taskDir, 'task.json'), 'utf8')) as {stages: unknown[]};
    assert.equal(record.stages.length, 2, 'the durable task record must accumulate stages, not overwrite them');
  });

  test('continuing while a stage is in flight is refused', async () => {
    setScenario('slow');
    const workspace = makeWorkspace('continflight');
    const record = await manager.submit({workspace, goal: 'Slow stage.'});
    await assert.rejects(
      () => manager.continue(record.taskId, 'too early'),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, 'stage_in_flight');
        return true;
      },
    );
    await manager.cancel(record.taskId);
  });
});

describe('evidence hygiene', () => {
  test('a credential printed by a tool never reaches the result', async () => {
    setScenario('secret_leak');
    const workspace = makeWorkspace('secret');
    const record = await manager.submit({workspace, goal: 'Print the environment.'});
    await manager.wait(record.taskId, 30_000);

    const result = manager.result(record.taskId, undefined, true) as ResultView;
    const serialised = JSON.stringify(result);
    assert.ok(!serialised.includes('sk-FAKE'), 'the raw secret must not appear anywhere in the result');
    assert.ok(serialised.includes('[REDACTED]'), 'the redaction must be visible rather than silently dropping the line');

    const log = readFileSync(result.artifacts.eventsLog, 'utf8');
    assert.ok(!log.includes('sk-FAKE'), 'the on-disk event log must be scrubbed too');
  });

  test('no persisted evidence carries model-internal reasoning', async () => {
    setScenario('success');
    const workspace = makeWorkspace('noreason');
    const record = await manager.submit({workspace, goal: 'Write notes.md.'});
    await manager.wait(record.taskId, 30_000);

    const view = manager.result(record.taskId) as ResultView;
    const raw = readFileSync(view.artifacts.eventsLog, 'utf8');
    assert.ok(!raw.includes('"reasoning"'), 'reasoning keys must be dropped before persistence');
    assert.ok(!raw.includes('replayState'), 'replayState must be dropped before persistence');
    const stage = JSON.parse(readFileSync(view.artifacts.stageResult!, 'utf8'));
    assert.ok(!JSON.stringify(stage).includes('"reasoning"'));
  });
});
