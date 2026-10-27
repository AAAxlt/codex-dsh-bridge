/**
 * Scripted stand-in for the DSH SDK runtime, used only by the test suite via
 * DSH_BRIDGE_CLI_ENTRY. It speaks the same line-delimited JSON-RPC surface the bridge
 * relies on (initialize / session/prompt / shutdown + session/event notifications) so the
 * bridge's own state machine, evidence capture and failure handling can be exercised
 * without spending a real model request.
 *
 * Behaviour is chosen by FAKE_SCENARIO. This file is deliberately NOT part of dist/src.
 */
import {appendFileSync, existsSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';

const scenario = process.env.FAKE_SCENARIO ?? 'success';
const workspace = process.cwd();
const trace = process.env.FAKE_TRACE;

function note(line) {
  if (trace) appendFileSync(trace, `${new Date().toISOString()} ${line}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function event(sessionId, type, data) {
  send({jsonrpc: '2.0', method: 'session.event', params: {sessionId, event: {type, seq: ++seq, data}}});
}

function status(sessionId, value) {
  send({jsonrpc: '2.0', method: 'session.status', params: {sessionId, status: value}});
}

let seq = 0;
let turn = 0;
let sessionId = 'unknown';
const timers = [];

function later(ms, fn) {
  timers.push(setTimeout(fn, ms));
}

/** A plausible secret shape, to prove the bridge scrubs credentials out of evidence. */
const FAKE_SECRET = 'sk-FAKE000000000000000000000000000000000000000000';

function runTurn() {
  turn += 1;
  const current = turn;
  note(`turn ${current} start scenario=${scenario}`);
  status(sessionId, 'running');

  if (scenario === 'usage_generic_no_total') {
    event(sessionId, 'turn/start', {turn:current});
    // Generic aliases with no reported total: 100+10+60+0 is arithmetic only. It may overlap and
    // must never be promoted to totalTokens.
    event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:'generic usage without total'}]},usage:{input_tokens:100,output_tokens:10,cacheReadTokens:60,cacheWriteTokens:0}});
    event(sessionId, 'turn/end', {turn:current, reason:{kind:'completed'}});
    return;
  }

  if (scenario === 'usage_resend') {
    event(sessionId, 'turn/start', {turn:current});
    // The same message id is sent twice with corrected counters. Only the correction counts.
    event(sessionId, 'assistant/message', {message:{id:'usage-resend-1',content:[{type:'text',text:'first usage draft'}]},usage:{inputTokens:10,outputTokens:1,cacheReadTokens:100,cacheWriteTokens:2,totalTokens:113}});
    event(sessionId, 'assistant/message', {message:{id:'usage-resend-1',content:[{type:'text',text:'corrected usage draft'}]},usage:{inputTokens:20,outputTokens:3,cacheReadTokens:200,cacheWriteTokens:4,totalTokens:227}});
    event(sessionId, 'turn/end', {turn:current, reason:{kind:'completed'}});
    return;
  }

  if (scenario === 'tool_resend') {
    event(sessionId, 'turn/start', {turn:current});
    event(sessionId, 'tool/call', {callId:'dup-call-1', name:'bash', turn:current, step:1, arguments:'{"command":"false"}'});
    event(sessionId, 'tool/call', {callId:'dup-call-1', name:'bash', turn:current, step:1, arguments:'{"command":"false"}'});
    event(sessionId, 'tool/result', {toolCallId:'dup-call-1', message:{content:[{type:'text',text:'command failed'}], isError:true}});
    event(sessionId, 'tool/result', {toolCallId:'dup-call-1', message:{content:[{type:'text',text:'command failed'}], isError:true}});
    event(sessionId, 'turn/end', {turn:current, reason:{kind:'completed'}});
    return;
  }

  if (scenario === 'many_tools' && current === 1) {
    event(sessionId, 'turn/start', {turn:current});
    event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:'stage 1 draft complete after many tool calls'}]},usage:{inputTokens:10,outputTokens:5}});
    // A fixed sequence, deliberately above the bridge's 60-observation retention cap.
    for (let i = 1; i <= 75; i += 1) {
      const callId = `many-${current}-${i}`;
      event(sessionId, 'tool/call', {callId, name: i % 25 === 0 ? 'bash' : 'read', turn:current, step:i, arguments:JSON.stringify({file_path:`f${i}.txt`})});
      event(sessionId, 'tool/result', {toolCallId: callId, message:{content:[{type:'text',text:`result ${i}`}], isError: i === 25 || i === 50}});
    }
    writeFileSync(`${workspace}/many-tools.txt`, '75 calls\n', 'utf8');
    event(sessionId, 'turn/end', {turn:current, reason:{kind:'completed'}});
    return;
  }

  if (scenario === 'usage_two_stage' || scenario === 'usage_missing' || scenario === 'usage_partial') {
    event(sessionId, 'turn/start', {turn:current});
    if (scenario === 'usage_two_stage') {
      const first = current === 1
        ? {inputTokens:100, outputTokens:20, cacheReadTokens:1000, cacheWriteTokens:50, totalTokens:1170}
        : {inputTokens:7, outputTokens:3, cacheReadTokens:10, cacheWriteTokens:0, totalTokens:20, cost:0.0012, currency:'USD'};
      const second = {input:200, output:30, cacheRead:2000, cacheWrite:60, total:2290};
      event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:`stage ${current} draft complete`}]},usage:first});
      if (current === 1) {
        event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:'stage 1 self-review complete'}]},usage:second});
      }
    } else if (scenario === 'usage_partial') {
      event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:'partial usage event'}]},usage:{inputTokens:10}});
      event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:'complete usage event'}]},usage:{inputTokens:5,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:7}});
    } else {
      event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:'stage 1 draft complete with no usage event'}]}});
    }
    event(sessionId, 'turn/end', {turn:current, reason:{kind:'completed'}});
    return;
  }

  if (scenario === 'log_only_exhaustion') {
    event(sessionId, 'turn/start', {turn:current});
    // The declared source stays byte-identical; only an explicitly declared log changes.
    if (!existsSync(`${workspace}/work.txt`)) writeFileSync(`${workspace}/work.txt`, 'stable source\n', 'utf8');
    appendFileSync(`${workspace}/activity.log`, `turn ${current} log-only change\n`, 'utf8');
    event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:`logs only on turn ${current}`}]},usage:{inputTokens:10,outputTokens:4}});
    event(sessionId, 'turn/end', {turn:current, reason:{kind:'max-tokens'}});
    return;
  }

  if (scenario === 'max_tokens_no_write') {
    event(sessionId, 'turn/start', {turn:current});
    event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:'No source edit was made before exhaustion.'}]},usage:{inputTokens:30,outputTokens:20}});
    event(sessionId, 'turn/end', {turn:current, reason:{kind:'max-tokens'}});
    return;
  }

  if (scenario === 'max_tokens_always_progress') {
    event(sessionId, 'turn/start', {turn:current});
    writeFileSync(`${workspace}/progress-${current}.txt`, `unique content for turn ${current}\n`, 'utf8');
    event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:`partial progress turn ${current}`}]},usage:{inputTokens:30,outputTokens:20}});
    event(sessionId, 'turn/end', {turn:current, reason:{kind:'max-tokens'}});
    return;
  }

  if (scenario === 'max_tokens_then_slow') {
    event(sessionId, 'turn/start', {turn:current});
    if (current === 1) {
      writeFileSync(`${workspace}/partial.txt`, 'partial before exhaustion\n', 'utf8');
      event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:'Partial report, not finished'}]},usage:{inputTokens:30,outputTokens:20}});
      event(sessionId, 'turn/end', {turn:current, reason:{kind:'max-tokens'}});
      return;
    }
    later(5_000, () => {
      writeFileSync(`${workspace}/slow-continuation.txt`, 'continuation work\n', 'utf8');
      event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:'slow continuation finished'}]},usage:{inputTokens:10,outputTokens:5}});
      event(sessionId, 'turn/end', {turn:current, reason:{kind:'completed'}});
    });
    return;
  }

  if (scenario === 'complete_then_slow') {
    event(sessionId, 'turn/start', {turn:current});
    if (current === 1) {
      writeFileSync(`${workspace}/notes.md`, '# notes\n\nwritten by stage 1\n', 'utf8');
      event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:'stage 1 complete'}]},usage:{inputTokens:10,outputTokens:5}});
      event(sessionId, 'turn/end', {turn:current, reason:{kind:'completed'}});
      return;
    }
    later(5_000, () => {
      writeFileSync(`${workspace}/notes.md`, '# notes\n\nwritten by stage 2\n', 'utf8');
      event(sessionId, 'assistant/message', {message:{content:[{type:'text',text:'stage 2 complete'}]},usage:{inputTokens:10,outputTokens:5}});
      event(sessionId, 'turn/end', {turn:current, reason:{kind:'completed'}});
    });
    return;
  }

  if ((scenario === 'max_tokens_then_complete' && current === 1) || scenario === 'max_tokens_no_text' || scenario === 'preview_only' || scenario === 'storage_only') {
    event(sessionId, 'turn/start', {turn:current});
    if(scenario !== 'max_tokens_no_text') event(sessionId,'assistant/message',{message:{content:[{type:'text',text:scenario === 'preview_only' ? 'x'.repeat(9000) : scenario === 'storage_only' ? 'x'.repeat(200100) : 'Partial report, not finished'}]},usage:{inputTokens:30,outputTokens:scenario==='preview_only'?2200:1200}});
    if(scenario !== 'preview_only') writeFileSync(`${workspace}/partial.txt`,'preserve this work','utf8');
    event(sessionId,'turn/end',{turn:current,reason:{kind:['preview_only','storage_only'].includes(scenario)?'completed':'max-tokens'}});
    return;
  }

  if (scenario === 'two_phase') {
    event(sessionId, 'turn/start', {turn: current});
    const firstPhase = !existsSync(`${workspace}/phase-1.txt`);
    const file = firstPhase ? 'phase-1.txt' : 'phase-2.txt';
    const text = firstPhase ? 'PHASE_ONE_DONE\n' : 'PHASE_TWO_DONE\n';
    writeFileSync(`${workspace}/${file}`, text, 'utf8');
    event(sessionId, 'assistant/message', {
      message: {content: [{type: 'text', text: `scripted two-phase stage ${current}: wrote ${file}`}]},
      usage: {inputTokens: 40, outputTokens: 8},
    });
    event(sessionId, 'tool/call', {callId: `phase-${current}`, name: 'write', turn: current, step: 1, arguments: JSON.stringify({path: file})});
    event(sessionId, 'tool/result', {toolCallId: `phase-${current}`, message: {content: [{type: 'text', text: `wrote ${file}`}], isError: false}});
    event(sessionId, 'turn/end', {turn: current, reason: {kind: 'completed'}});
    return;
  }

  if (scenario === 'ptc_error_caught') {
    const outer = 'ptc-outer-' + current, child = outer + ':ptc:1';
    event(sessionId, 'turn/start', {turn: current});
    event(sessionId, 'tool/call', {callId:outer,name:'run_code',turn:current,step:1,arguments:'{}'});
    event(sessionId, 'tool/ptc-dispatch-start', {rootCallId:outer,parentCallId:outer,subCallId:child,name:'read',arguments:{file_path:'missing.txt'}});
    event(sessionId, 'tool/ptc-dispatch', {rootCallId:outer,parentCallId:outer,subCallId:child,name:'read',arguments:{file_path:'missing.txt'},isError:true,content:[{type:'text',text:'missing file '+FAKE_SECRET}]});
    event(sessionId, 'tool/result', {toolCallId:outer,message:{toolCallId:outer,isError:false,content:[{type:'text',text:'program caught the child failure'}]}});
    event(sessionId, 'turn/end', {turn:current,reason:{kind:'completed'}});
    return;
  }

  if (scenario === 'no_turn_end') {
    event(sessionId, 'turn/start', {turn: current});
    event(sessionId, 'assistant/message', {message: {content: [{type: 'text', text: 'working, never finishing'}]}});
    return;
  }

  if (scenario === 'silent_after_ack') {
    event(sessionId, 'turn/start', {turn: current});
    return;
  }

  if (scenario === 'slow') {
    event(sessionId, 'turn/start', {turn: current});
    later(60_000, () => event(sessionId, 'turn/end', {turn: current, reason: {kind: 'completed'}}));
    return;
  }

  if (scenario === 'delayed_complete') {
    // A deterministic window in which a test can enable a later-persistence fault before the
    // turn ends. This is scripted test behaviour, not a production seam.
    event(sessionId, 'turn/start', {turn: current});
    event(sessionId, 'assistant/message', {message: {content: [{type: 'text', text: 'delayed stage complete'}]}, usage: {inputTokens: 3, outputTokens: 2}});
    later(600, () => event(sessionId, 'turn/end', {turn: current, reason: {kind: 'completed'}}));
    return;
  }

  event(sessionId, 'turn/start', {turn: current});
  event(sessionId, 'assistant/message', {
    message: {content: [{type: 'text', text: `stage ${current} draft complete. Files: notes.md`}]},
    usage: {inputTokens: 120, outputTokens: 40},
  });

  event(sessionId, 'tool/call', {
    callId: `call-${current}-1`, name: 'write', turn: current, step: 1,
    arguments: JSON.stringify({path: 'notes.md', content: 'stage ' + current}),
  });
  writeFileSync(`${workspace}/notes.md`, `# notes\n\nwritten by stage ${current}\n`, 'utf8');

  event(sessionId, 'tool/result', {
    toolCallId: `call-${current}-1`,
    message: {content: [{type: 'text', text: 'wrote notes.md'}], isError: false},
  });

  if (scenario === 'tool_error') {
    event(sessionId, 'tool/call', {callId: `call-${current}-2`, name: 'bash', turn: current, step: 2, arguments: '{"command":"false"}'});
    event(sessionId, 'tool/result', {
      toolCallId: `call-${current}-2`,
      message: {content: [{type: 'text', text: 'command exited with code 1'}], isError: true},
    });
  }

  if (scenario === 'secret_leak') {
    event(sessionId, 'tool/call', {callId: `call-${current}-3`, name: 'bash', turn: current, step: 3, arguments: `{"command":"env | grep KEY"}`});
    event(sessionId, 'tool/result', {
      toolCallId: `call-${current}-3`,
      message: {content: [{type: 'text', text: `OPENCODE_GO_API_KEY=${FAKE_SECRET}`}], isError: false},
    });
  }

  if (scenario === 'approval') {
    event(sessionId, 'approval/asked', {id: 'approval-1', tool: 'bash', arguments: '{"command":"rm -rf /"}'});
    return;
  }

  if (scenario === 'provider_retry') {
    event(sessionId, 'llm/retry', {failure: {message: 'upstream 429', code: 'rate_limit'}});
  }

  if (scenario === 'turn_end_failed') {
    status(sessionId, 'idle');
    event(sessionId, 'turn/end', {turn: current, reason: {kind: 'error', error: {message: 'provider refused the request', code: 'provider_error'}}});
    return;
  }

  if (scenario === 'crash_after_ack') {
    later(60, () => process.exit(3));
    return;
  }

  status(sessionId, 'idle');
  event(sessionId, 'turn/end', {turn: current, reason: {kind: 'completed'}});
}

const rl = createInterface({input: process.stdin});
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const {id, method, params} = message;
  note(`<- ${method} id=${id}`);

  if (method === 'initialize') {
    if(scenario==='reject_none' && (params?.reasoningEffort==='none' || params?.reasoningEffort===undefined)){
      send({jsonrpc:'2.0',id,error:{code:-32000,message:'provider "commandcode-goat" model "deepseek/deepseek-v4.1-flash" does not support reasoning effort "none"'}});
      return;
    }
    if (scenario === 'bad_handshake') {
      send({jsonrpc: '2.0', id, error: {code: -32000, message: 'scripted handshake failure'}});
      return;
    }
    if (scenario === 'no_initialize') return;
    sessionId = `fake-session-${process.pid}`;
    send({jsonrpc: '2.0', id, result: {serverInfo: {name: 'fake-dsh-sdk', version: '0.0.0-test'}}});
    return;
  }

  if (method === 'session/prompt') {
    sessionId = params?.sessionId ?? sessionId;
    send({jsonrpc: '2.0', id, result: {messageId: `msg-${turn + 1}`}});
    if (scenario === 'crash_after_ack') {
      later(40, () => process.exit(3));
      return;
    }
    later(30, runTurn);
    return;
  }

  if (method === 'shutdown') {
    send({jsonrpc: '2.0', id, result: {ok: true}});
    later(20, () => {
      for (const timer of timers) clearTimeout(timer);
      process.exit(0);
    });
    return;
  }

  send({jsonrpc: '2.0', id, error: {code: -32601, message: `unknown method ${method}`}});
});

if (scenario === 'noisy_stdout') {
  const noise = setInterval(() => process.stdout.write('this is not JSON\n'), 25);
  noise.unref();
}

process.on('SIGTERM', () => {
  note('SIGTERM');
  process.exit(0);
});
