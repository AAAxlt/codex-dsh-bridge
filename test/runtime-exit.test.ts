/**
 * A task whose runtime died must never stay persisted as `running`.
 *
 * linux-05 left exactly that behind: the bridge's own shutdown flagged the teardown like a cancel,
 * so the exit that followed was not treated as a failure, and the record still claimed a live stage
 * long after the process was gone. A task that looks live but cannot be resumed is worse than one
 * that is honestly dead: it invites a resume that silently starts over.
 *
 * Both tests drive the scripted runtime, so neither spends a model request.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';

import {applyScriptedEnv, cleanupDir, makeWorkspace, TEST_ROOT, waitFor} from './helpers.js';

// Must run before ../src/config.js is first imported: config reads its environment once.
applyScriptedEnv();

const {TaskManager, LIVE_STATES} = await import('../src/tasks.js');
type StatusView = import('../src/tasks.js').TaskStatusView;

interface Persisted {
  state: string;
  runtimePid: number | null;
  runtimeExit: {code: number | null; signal: string | null; at: string} | null;
  cleanupAfterExit: {
    at: string; reason: string; method: string; stopped: boolean;
    treeVerified: boolean; survivorPids: number[] | null; note: string;
  } | null;
  errors: string[];
}

function persisted(taskDir: string): Persisted {
  return JSON.parse(readFileSync(path.join(taskDir, 'task.json'), 'utf8')) as Persisted;
}

const manager = new TaskManager();

after(async () => {
  await manager.shutdownAll();
  cleanupDir(TEST_ROOT);
});

describe('an abnormally exited runtime leaves no live-looking task behind', () => {
  test('killing the runtime mid-stage settles the record and records the cleanup sweep', async () => {
    process.env['FAKE_SCENARIO'] = 'no_turn_end';
    const workspace = makeWorkspace('runtime-killed');
    const record = await manager.submit({workspace, goal: 'Work that never ends.'});
    assert.ok(record.runtimePid, 'the runtime pid must be recorded before the stage can be inspected');
    await waitFor(() => LIVE_STATES.includes(manager.status(record.taskId).state), 15_000, 25);

    // The runtime dies under the bridge, exactly like the process that vanished in linux-05.
    process.kill(record.runtimePid!, 'SIGKILL');

    // Two mechanisms can notice this, and which one wins is a race: the runtime's own exit event, or
    // the read-path guard in this very call. Both must land in the same place, so the assertions
    // below are about the outcome; the exit itself is required to have been observed.
    const status = await waitFor<StatusView>(() => {
      const view = manager.status(record.taskId);
      return LIVE_STATES.includes(view.state) ? null : view;
    }, 15_000, 25);
    const settled = await waitFor<StatusView>(() => {
      const view = manager.status(record.taskId);
      return view.runtimeExit === null ? null : view;
    }, 15_000, 25);

    assert.equal(status.state, 'failed', 'a record must not stay in a live state once its runtime is gone');
    assert.equal(settled.state, 'failed', 'the corrected state must be stable, not a transient view');
    assert.equal(settled.awaiting, false, 'awaiting must follow the corrected state');
    assert.equal(settled.canContinue, false, 'a task with a dead runtime must not look resumable');
    assert.ok(settled.runtimeExit, 'the exit must be recorded, not inferred later');
    assert.match(settled.errors.join(' | '), /runtime exited|is gone/, 'the reason must be legible to a reviewer');

    // The cleanup evidence is a sweep of the process tree, so its result is written asynchronously.
    const cleanup = await waitFor<Persisted['cleanupAfterExit']>(() => {
      const rec = persisted(record.taskDir);
      return rec.cleanupAfterExit && rec.cleanupAfterExit.method !== 'sweep-pending' ? rec.cleanupAfterExit : null;
    }, 15_000, 25);
    assert.ok(
      cleanup!.reason === 'runtime-exit' || cleanup!.reason === 'liveness',
      `reason must name the mechanism that noticed: ${cleanup!.reason}`,
    );
    assert.ok(cleanup!.method.length > 0 && cleanup!.method !== 'sweep-pending', `method=${cleanup!.method}`);
    assert.ok(cleanup!.note.length > 0, 'the sweep must explain itself');
    assert.ok(Array.isArray(cleanup!.survivorPids) || cleanup!.survivorPids === null);
    assert.equal(typeof cleanup!.treeVerified, 'boolean');
  });

  test('a bridge shutdown is not a cancel and must settle the stage it interrupted', async () => {
    // A separate manager: shutdownAll() latches shuttingDown, and this test is the one that uses it.
    const shutting = new TaskManager();
    process.env['FAKE_SCENARIO'] = 'no_turn_end';
    const workspace = makeWorkspace('bridge-shutdown');
    const record = await shutting.submit({workspace, goal: 'Work that never ends.'});
    await waitFor(() => LIVE_STATES.includes(shutting.status(record.taskId).state), 15_000, 25);

    await shutting.shutdownAll();

    const status = await waitFor<StatusView>(() => {
      const view = shutting.status(record.taskId);
      return LIVE_STATES.includes(view.state) ? null : view;
    }, 15_000, 25);

    assert.equal(status.state, 'failed', 'the shutdown interrupted real work; the record must say so');
    assert.match(status.errors.join(' | '), /shutting down/, 'the reason must name the shutdown, not a cancel');
    assert.equal(persisted(record.taskDir).state, 'failed', 'the persisted record is the one a later reader sees');
  });

  test('continuing a task whose runtime died is refused with a named reason', async () => {
    process.env['FAKE_SCENARIO'] = 'no_turn_end';
    const workspace = makeWorkspace('resume-refusal');
    const record = await manager.submit({workspace, goal: 'Work that never ends.'});
    assert.ok(record.runtimePid);
    await waitFor(() => LIVE_STATES.includes(manager.status(record.taskId).state), 15_000, 25);
    process.kill(record.runtimePid!, 'SIGKILL');
    await waitFor(() => (LIVE_STATES.includes(manager.status(record.taskId).state) ? null : true), 15_000, 25);

    await assert.rejects(
      () => manager.continue(record.taskId, 'keep going'),
      (error: unknown) => {
        const code = (error as {code?: string}).code;
        assert.ok(
          code === 'runtime_not_alive' || code === 'task_not_resumable',
          `expected a named refusal, got code=${String(code)} message=${(error as Error).message}`,
        );
        return true;
      },
    );
  });
});
