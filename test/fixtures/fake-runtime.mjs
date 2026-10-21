/**
 * Scripted stand-in for the DSH SDK runtime, used only by the test suite via
 * DSH_BRIDGE_CLI_ENTRY. It speaks the same line-delimited JSON-RPC surface the bridge
 * relies on (initialize / session/prompt / shutdown + session/event notifications) so the
 * bridge's own state machine, evidence capture and failure handling can be exercised
 * without spending a real model request.
 *
 * Behaviour is chosen by FAKE_SCENARIO. This file is deliberately NOT part of dist/src.
 */
import {appendFileSync, writeFileSync} from 'node:fs';
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

  if ((scenario === 'max_tokens_then_complete' && current === 1) || scenario === 'max_tokens_no_text' || scenario === 'preview_only' || scenario === 'storage_only') {
    event(sessionId, 'turn/start', {turn:current});
    if(scenario !== 'max_tokens_no_text') event(sessionId,'assistant/message',{message:{content:[{type:'text',text:scenario === 'preview_only' ? 'x'.repeat(9000) : scenario === 'storage_only' ? 'x'.repeat(200100) : 'Partial report, not finished'}]},usage:{inputTokens:30,outputTokens:scenario==='preview_only'?2200:1200}});
    if(scenario !== 'preview_only') writeFileSync(`${workspace}/partial.txt`,'preserve this work','utf8');
    event(sessionId,'turn/end',{turn:current,reason:{kind:['preview_only','storage_only'].includes(scenario)?'completed':'max-tokens'}});
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
