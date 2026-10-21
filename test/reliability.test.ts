import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {after,test} from 'node:test';
import {applyScriptedEnv,makeWorkspace,cleanupDir,TEST_ROOT} from './helpers.js';
applyScriptedEnv({DSH_BRIDGE_PROVIDER:'commandcode-goat'});
const {TaskManager}=await import('../src/tasks.js');
const manager=new TaskManager();
after(async()=>{await manager.shutdownAll();cleanupDir(TEST_ROOT);});
type Evidence={reasoningPolicy:{requested:string;effective:string;adjusted:boolean};configurationWarnings:string[];modelReport:{truncated:boolean;previewTruncated:boolean;upstreamTruncated:boolean;storageTruncated:boolean;fullReportPath:string;text:string};bridgeObserved:{output:{status:string;limitReached:boolean};filesChanged:{added:string[]}}};
for(const effort of ['off','none'] as const)test(`GOAT ${effort} is transparently mapped before the SDK rejects none`,async()=>{
  process.env['FAKE_SCENARIO']='reject_none';
  const t=await manager.submit({workspace:makeWorkspace('reasoning-'+effort),goal:'short reply',reasoningEffort:effort as 'off'});
  await manager.wait(t.taskId,5000);
  const r=manager.result(t.taskId) as unknown as Evidence;
  assert.equal(manager.status(t.taskId).state,'awaiting_review');
  assert.equal(r.reasoningPolicy.requested,effort);
  assert.equal(r.reasoningPolicy.effective,'low');
  assert.equal(r.reasoningPolicy.adjusted,true);
  assert.ok(r.configurationWarnings.some(w=>w.includes('low')));
  await manager.cancel(t.taskId);
});
test('output limit is incomplete, preserves partial files, and resumes the same live session',async()=>{
  process.env['FAKE_SCENARIO']='max_tokens_then_complete';
  const workspace=makeWorkspace('output-limit');
  const t=await manager.submit({workspace,goal:'finish work',maxTokens:1200});
  await manager.wait(t.taskId,5000);
  const first=manager.result(t.taskId) as unknown as Evidence;
  assert.equal(manager.status(t.taskId).state,'incomplete');
  assert.equal(manager.status(t.taskId).canContinue,true);
  assert.equal(first.bridgeObserved.output.status,'incomplete');
  assert.equal(first.modelReport.upstreamTruncated,true);
  assert.equal(first.modelReport.previewTruncated,false);
  assert.equal(first.modelReport.truncated,true);
  assert.ok(first.bridgeObserved.filesChanged.added.includes('partial.txt'));
  assert.equal(readFileSync(path.join(workspace,'partial.txt'),'utf8'),'preserve this work');
  const pid=manager.status(t.taskId).runtimePid;
  await manager.continue(t.taskId,'Finish the report concisely; preserve partial.txt.');
  await manager.wait(t.taskId,5000);
  assert.equal(manager.status(t.taskId).runtimePid,pid);
  assert.equal(manager.status(t.taskId).state,'awaiting_review');
  const second=manager.result(t.taskId) as unknown as Evidence;
  assert.equal(second.modelReport.upstreamTruncated,false);
  assert.equal((manager.result(t.taskId,1) as unknown as Evidence).modelReport.upstreamTruncated,true);
  await manager.cancel(t.taskId);
});
test('output limit with zero visible text is still incomplete',async()=>{
  process.env['FAKE_SCENARIO']='max_tokens_no_text';
  const t=await manager.submit({workspace:makeWorkspace('zero-text'),goal:'work',maxTokens:1200});
  await manager.wait(t.taskId,5000);
  assert.equal(manager.status(t.taskId).state,'incomplete');
  const r=manager.result(t.taskId) as unknown as Evidence;
  assert.equal(r.modelReport.text,'');assert.equal(r.modelReport.upstreamTruncated,true);
  await manager.cancel(t.taskId);
});
test('a display preview cutoff is not provider exhaustion; full recorded report remains on disk',async()=>{
  process.env['FAKE_SCENARIO']='preview_only';
  const t=await manager.submit({workspace:makeWorkspace('preview'),goal:'report'});
  await manager.wait(t.taskId,5000);
  const r=manager.result(t.taskId) as unknown as Evidence;
  assert.equal(manager.status(t.taskId).state,'awaiting_review');
  assert.equal(r.modelReport.previewTruncated,true);assert.equal(r.modelReport.upstreamTruncated,false);
  assert.equal(r.bridgeObserved.output.status,'finished');
  assert.equal(readFileSync(r.modelReport.fullReportPath,'utf8').length,9000);
  await manager.cancel(t.taskId);
});
test('an explicitly small budget is preserved and warned about without inventing a cutoff',async()=>{
  process.env['FAKE_SCENARIO']='success';
  const t=await manager.submit({workspace:makeWorkspace('small-budget'),goal:'short work',maxTokens:1200,reasoningEffort:'medium'});
  await manager.wait(t.taskId,5000);
  const r=manager.result(t.taskId) as unknown as Evidence;
  assert.equal(t.maxTokens,1200);assert.equal(manager.status(t.taskId).state,'awaiting_review');
  assert.equal(r.reasoningPolicy.effective,'medium');assert.equal(r.reasoningPolicy.adjusted,false);
  assert.ok(r.configurationWarnings.some(w=>w.includes('1200')));
  assert.equal(r.modelReport.upstreamTruncated,false);
  await manager.cancel(t.taskId);
});
test('bridge storage cutoff is incomplete even when the runtime reports completed',async()=>{
  process.env['FAKE_SCENARIO']='storage_only';
  const t=await manager.submit({workspace:makeWorkspace('storage'),goal:'large report'});
  await manager.wait(t.taskId,5000);
  const r=manager.result(t.taskId) as unknown as Evidence;
  assert.equal(manager.status(t.taskId).state,'incomplete');
  assert.equal(r.modelReport.storageTruncated,true);
  assert.equal(r.modelReport.upstreamTruncated,false);
  assert.equal(r.bridgeObserved.output.status,'incomplete');
  await manager.cancel(t.taskId);
});
test('OpenCode off retains none; invalid efforts are rejected rather than silently retried',()=>{
  const url=new URL('../src/config.js',import.meta.url).href;
  const result=spawnSync(process.execPath,['--input-type=module','-e',`const c=await import(${JSON.stringify(url)});console.log(JSON.stringify(c.resolveReasoningEffort('off')));try{c.resolveReasoningEffort('typo');process.exit(2)}catch{}`],{encoding:'utf8',env:{...process.env,DSH_BRIDGE_PROVIDER:'opencode-go'}});
  assert.equal(result.status,0,result.stderr);
  const policy=JSON.parse(result.stdout);
  assert.equal(policy.sdkValue,'none');assert.equal(policy.effective,'off');assert.equal(policy.adjusted,false);
});
test('omitted work parameters select medium, 16384 tokens, and a bounded 300-second stage',async()=>{
  process.env['FAKE_SCENARIO']='success';
  const t=await manager.submit({workspace:makeWorkspace('new-defaults'),goal:'work with defaults'});
  await manager.wait(t.taskId,5000);
  assert.equal(t.reasoningPolicy.requested,'medium');
  assert.equal(t.reasoningEffort,'medium');
  assert.equal(t.maxTokens,16384);assert.equal(t.budgetMs,300000);
  const status=manager.status(t.taskId) as unknown as {effectiveParameters:{reasoningEffort:string;maxTokens:number;budgetMs:number}};
  assert.deepEqual(status.effectiveParameters,{reasoningEffort:'medium',maxTokens:16384,budgetMs:300000});
  await manager.cancel(t.taskId);
});
test('explicit diagnostic and high-task budgets are never raised or lowered to the defaults',async()=>{
  for(const params of [{reasoningEffort:'low' as const,maxTokens:256,budgetMs:1200},{reasoningEffort:'high' as const,maxTokens:32768,budgetMs:600000}]){
    process.env['FAKE_SCENARIO']='success';
    const t=await manager.submit({workspace:makeWorkspace('explicit-parameters'),goal:'bounded work',...params});
    await manager.wait(t.taskId,5000);
    assert.equal(t.reasoningEffort,params.reasoningEffort);assert.equal(t.maxTokens,params.maxTokens);assert.equal(t.budgetMs,params.budgetMs);
    const result=manager.result(t.taskId) as unknown as {effectiveParameters:typeof params};
    assert.deepEqual(result.effectiveParameters,params);
    await manager.cancel(t.taskId);
  }
});
test('invalid explicit stage budgets are refused before a task is created',async()=>{
  const workspace=makeWorkspace('invalid-budget');const before=manager.listTasks().length;
  for(const budgetMs of [0,-1,Number.NaN,Number.POSITIVE_INFINITY]){
    await assert.rejects(manager.submit({workspace,goal:'must not start',budgetMs}),/budgetMs/);
    assert.equal(manager.listTasks().length,before);
  }
});
