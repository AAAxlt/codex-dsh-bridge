import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as prompts from '../src/prompts.js';

const brief = {taskId:'dsh-fixture',stage:1,workspace:'/work',goal:'task-local check',verificationCommand:['node','/host/PRIVATE-CHECK','PRIVATE-ARG']};
test('first stage never sends host verifier argv to the model',()=>{
  const text=prompts.firstStagePrompt(brief);
  assert.ok(!text.includes('PRIVATE-'));
  assert.ok(text.includes('task-local check'));
});
test('continuation never sends host verifier argv to the model',()=>{
  const text=prompts.continuationPrompt({...brief,stage:2},'review','prior');
  assert.ok(!text.includes('PRIVATE-'));
  assert.ok(text.includes('review')&&text.includes('prior'));
});
const legacy=(header:string,argv='node /host/PRIVATE-CHECK PRIVATE-ARG')=>header+'\n\n## Goal\nkeep-goal\n\n## Verification command\nThe bridge will run this itself after you stop, in the workspace, and record the real exit code:\n    '+argv+'\n\n## Boundaries\nkeep-bounds';
for(const header of ['You are executing one delegated stage of work, stage 1, for task dsh-fixture.','Stage 2 of task dsh-fixture. This continues the SAME session, so your earlier work is in context.']){
  test('legacy cached Bridge prompt is redacted: '+header.slice(0,12),()=>{
    const fn=(prompts as unknown as {redactLegacyHostVerification:(text:string)=>string}).redactLegacyHostVerification;
    const text=fn(legacy(header));
    assert.ok(!text.includes('PRIVATE-'));
    assert.ok(text.startsWith(header)&&text.includes('keep-goal')&&text.includes('## Boundaries\nkeep-bounds'));
    assert.equal(fn(text),text);
  });
}
test('legacy multiline argv is completely removed',()=>{
  const fn=(prompts as unknown as {redactLegacyHostVerification:(text:string)=>string}).redactLegacyHostVerification;
  assert.ok(!fn(legacy('You are executing one delegated stage of work, stage 1, for task dsh-fixture.','node\nPRIVATE-ARG\nPRIVATE-CHECK')).includes('PRIVATE-'));
});
test('unrelated user content is not rewritten',()=>{
  const fn=(prompts as unknown as {redactLegacyHostVerification:(text:string)=>string}).redactLegacyHostVerification;
  const text=legacy('Ordinary user message');
  assert.equal(fn(text),text);
});
