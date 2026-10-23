#!/usr/bin/env node
// Real-provider smoke: deliberately seed a faulty first delivery, then exercise host feedback.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'evidence', `real-auto-repair-${Date.now()}`);
const workspace = path.join(output, 'work');
mkdirSync(workspace, {recursive: true});
process.env.DSH_BRIDGE_ALLOWED_ROOTS = output;
process.env.DSH_BRIDGE_DATA_ROOT = path.join(output, 'bridge-data');
const verifier = path.join(output, 'accept.cjs');
writeFileSync(verifier, "const assert=require('node:assert/strict'); const {add}=require(process.cwd()+'/calculator.cjs'); assert.equal(add(2,3),5,'add(2,3) must equal 5');assert.equal(add(-2,3),1);console.log('2 arithmetic checks passed');\n");
const expectedHash = createHash('sha256').update(readFileSync(verifier)).digest('hex');
const {TaskManager} = await import('../dist/src/tasks.js');
const manager = new TaskManager();
let record;
try {
  record = await manager.submit({
    workspace, deliveryPreset: 'complete', executionProfile: 'native', reasoningEffort: 'low', maxTokens: 4096,
    budgetMs: 180000, autoRepair: {maxAttempts: 2, totalBudgetMs: 480000},
    verificationCommand: ['node', verifier], protectedVerificationFiles: [verifier],
    goal: 'This is a controlled integration test of automatic repair. FIRST STAGE ONLY: create calculator.cjs exporting add(a,b) implemented as a-b (the intentionally faulty fixture). Do not fix this seeded defect or modify the external checker in the first stage. Finish your turn with a concise report. When a later Bridge feedback stage supplies a failed independent assertion, repair calculator.cjs to implement mathematical addition and run it, then deliver the corrected implementation. Do not run more than this tiny task.',
    constraints: ['Only edit calculator.cjs and optional short notes in this workspace. Never edit or replace external acceptance files.'],
  });
  const deadline = Date.now() + 500000;
  while (Date.now() < deadline && manager.status(record.taskId).awaiting) await manager.wait(record.taskId, 30000);
  const status = manager.status(record.taskId);
  const result = manager.result(record.taskId);
  const first = manager.result(record.taskId, 1);
  const evidence = {schema: 'bridge-real-auto-repair@1', taskId: record.taskId, status, firstVerification: first.bridgeObserved.verification, finalVerification: result.bridgeObserved.verification, metrics: {codexContinuations: record.codexContinuationCount, autoRepairs: record.totalAutoRepairs, usage: result.bridgeObserved.usageAccounting.task}, artifacts: result.artifacts};
  writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  assert.equal(status.state, 'awaiting_review');
  assert.equal(first.bridgeObserved.verification.status, 'failed', 'controlled first-stage defect must fail independently');
  assert.ok(status.stageCount >= 2);
  assert.equal(result.bridgeObserved.verification.status, 'passed');
  assert.equal(record.codexContinuationCount, 0);
  assert.ok(record.totalAutoRepairs >= 1);
  assert.equal(createHash('sha256').update(readFileSync(verifier)).digest('hex'), expectedHash);
  const exported = manager.exportDelivery(record.taskId, path.join(output, 'export'));
  assert.equal(JSON.parse(readFileSync(exported.indexJson)).hostVerification.latest.status, 'passed');
  console.log(JSON.stringify({ok: true, output, taskId: record.taskId, stages: status.stageCount, autoRepairs: record.totalAutoRepairs, codexContinuations: record.codexContinuationCount, export: exported.indexJson}));
} finally { await manager.shutdownAll(); }
