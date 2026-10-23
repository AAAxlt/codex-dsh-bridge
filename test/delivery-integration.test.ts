import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {applyScriptedEnv, cleanupDir, makeWorkspace} from './helpers.js';

applyScriptedEnv();
const {TaskManager} = await import('../src/tasks.js');

test('a failed second-stage delivery capture cannot expose or export the previous stage bundle', async () => {
  process.env['FAKE_SCENARIO'] = 'success';
  const manager = new TaskManager();
  const workspace = makeWorkspace('delivery-integration');
  let taskDir: string | null = null;
  try {
    const record = await manager.submit({workspace, goal: 'Deliver an implementation, then revise it.'});
    taskDir = record.taskDir;
    await manager.wait(record.taskId, 30_000);

    const first = manager.result(record.taskId);
    assert.equal(record.stages.length, 1);
    assert.equal(record.deliveryStage, 1);
    assert.ok(first.artifacts.deliveryIndex, 'first-stage delivery capture succeeds');
    const indexPath = first.artifacts.deliveryIndex;
    const firstIndex = readFileSync(indexPath, 'utf8');
    assert.equal(JSON.parse(firstIndex).metrics.stageCount, 1);
    const firstExport = manager.exportDelivery(record.taskId, path.join(workspace, 'first-export'));
    assert.equal(JSON.parse(readFileSync(firstExport.indexJson, 'utf8')).metrics.stageCount, 1);

    // A harmless local fixture causes the second observed source selection to include .env.
    // The real delivery guard must reject this capture without falling back to the old bundle.
    writeFileSync(path.join(workspace, '.env'), 'DELIVERY_REGRESSION_FIXTURE=not-a-credential\n');
    await manager.continue(record.taskId, 'Revise the implementation in the same session.');
    assert.equal(record.deliveryStage, null, 'starting a new stage invalidates its predecessor');
    assert.equal(manager.result(record.taskId).artifacts.deliveryIndex, null);
    await manager.wait(record.taskId, 30_000);

    const second = manager.result(record.taskId);
    assert.equal(record.stages.length, 2);
    assert.equal(second.stage, 2);
    assert.ok(record.stages[1]?.fileChanges?.added.includes('.env'), 'exercise the actual observed source capture');
    assert.ok(record.errors.some((message) => /delivery export failed: Sensitive source file refused: \.env/.test(message)));
    assert.equal(record.deliveryStage, null);
    assert.equal(second.artifacts.deliveryIndex, null, 'the latest result must not advertise a stale index');
    // Even if old evidence remains available on disk for review, it is not a current delivery.
    assert.equal(readFileSync(indexPath, 'utf8'), firstIndex);
    const destination = path.join(workspace, 'must-not-export-old-stage');
    assert.throws(() => manager.exportDelivery(record.taskId, destination), /no delivery bundle is recorded for the latest stage/);
    assert.equal(existsSync(destination), false);
  } finally {
    await manager.shutdownAll();
    cleanupDir(workspace);
    if (taskDir !== null) cleanupDir(taskDir);
  }
});
