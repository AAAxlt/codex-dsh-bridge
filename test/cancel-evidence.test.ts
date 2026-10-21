/**
 * Cancelling a task must not erase the evidence of what its turn really changed.
 *
 * The bug this pins down: `task.snapshot` is advanced to the post-turn state by `finaliseStage()`
 * as soon as a turn ends, and the cancel path then recomputed the diff against that already
 * advanced base. The recomputed diff is always empty, and it was written back over
 * `evidence/stage-N-result.json` — so a real acceptance task that created `result.json` was
 * persisted as "the bridge observed no file changes in the workspace for this stage", and the
 * correct diff written at turn end was gone.
 *
 * The file diff must survive a cancel of a task that already settled. A cancel that really
 * interrupts a turn must still report the partial changes it found, so the second test guards the
 * behaviour the fix must not break.
 *
 * Both tests drive the scripted runtime, so neither spends a model request.
 */
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';

import {applyScriptedEnv, cleanupDir, makeWorkspace, TEST_ROOT, waitFor} from './helpers.js';

// Must run before ../src/config.js is first imported: config reads its environment once.
applyScriptedEnv();

const {TaskManager} = await import('../src/tasks.js');
type StatusView = import('../src/tasks.js').TaskStatusView;

interface StageResult {
  bridgeObserved: {filesChanged: {added: string[]; modified: string[]; removed: string[]; unchangedCount: number}};
  unresolved: string[];
}

function readStageResult(taskDir: string): StageResult {
  return JSON.parse(readFileSync(path.join(taskDir, 'evidence', 'stage-1-result.json'), 'utf8')) as StageResult;
}

const manager = new TaskManager();

after(async () => {
  await manager.shutdownAll();
  cleanupDir(TEST_ROOT);
});

describe('a cancel keeps the file-change evidence it did not produce', () => {
  test('a turn that created notes.md stays recorded after the settled task is cancelled', async () => {
    process.env['FAKE_SCENARIO'] = 'success';
    const workspace = makeWorkspace('cancel-settled');
    const record = await manager.submit({workspace, goal: 'Write notes.md.'});
    await waitFor<StatusView>(() => {
      const view = manager.status(record.taskId);
      return view.state === 'awaiting_review' ? view : null;
    }, 15_000, 25);

    const before = readStageResult(record.taskDir);
    assert.deepEqual(before.bridgeObserved.filesChanged.added, ['notes.md'], 'the scripted turn wrote notes.md');

    const reply = await manager.cancel(record.taskId);

    const after = readStageResult(record.taskDir);
    assert.deepEqual(
      after.bridgeObserved.filesChanged.added,
      ['notes.md'],
      'cancelling an already settled task must not rewrite the stage diff recorded at turn end',
    );
    assert.ok(
      !after.unresolved.some((item) => item.includes('no file changes')),
      `this stage changed a file, so no unresolved item may claim otherwise: ${after.unresolved.join(' | ')}`,
    );
    assert.deepEqual(
      reply.partialFileChanges?.added,
      ['notes.md'],
      'the reply must report the same diff that stays in the record',
    );
  });

  test('a cancel that interrupts a turn still reports the partial changes it found', async () => {
    process.env['FAKE_SCENARIO'] = 'no_turn_end';
    const workspace = makeWorkspace('cancel-in-flight');
    const record = await manager.submit({workspace, goal: 'Work that never ends.'});
    await waitFor<StatusView>(() => {
      const view = manager.status(record.taskId);
      return view.state === 'running' ? view : null;
    }, 15_000, 25);

    // What an interrupted turn leaves behind: a file that did not exist when the stage started.
    writeFileSync(path.join(workspace, 'half-written.txt'), 'partial\n', 'utf8');

    const reply = await manager.cancel(record.taskId);
    assert.deepEqual(
      reply.partialFileChanges?.added,
      ['half-written.txt'],
      'an interrupted turn must still report its partial file changes',
    );
    const after = readStageResult(record.taskDir);
    assert.deepEqual(
      after.bridgeObserved.filesChanged.added,
      ['half-written.txt'],
      'the partial diff is the stage evidence for a turn that was interrupted',
    );
  });
});
