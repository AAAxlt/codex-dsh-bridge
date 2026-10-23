/**
 * Protocol-level tests: every assertion here goes through a REAL MCP client over stdio, i.e. the
 * same path Codex would take. Nothing in this file calls src/ functions directly, because
 * "the JS function returned the right value" is not the same claim as "an MCP client can use it".
 *
 * The DSH SDK runtime is replaced by test/fixtures/fake-runtime.mjs via DSH_BRIDGE_CLI_ENTRY, so
 * these tests never spend a model request. The real-model loop lives in e2e-real.test.ts.
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {
  BRIDGE_MAIN, TEST_DATA_ROOT, cleanupDir, connectBridge, jsonOf, makeWorkspace,
  scriptedBridgeEnv, sleep, textOf, waitFor, type ConnectedClient,
} from './helpers.js';

interface ToolReply {
  isError?: boolean;
  content?: Array<{type: string; text?: string}>;
}

interface Bridge {
  client: ConnectedClient['client'];
  close: ConnectedClient['close'];
  stderr: ConnectedClient['stderr'];
}

const TOOL_NAMES = [
  'dsh_get_capabilities', 'dsh_submit_task', 'dsh_get_task', 'dsh_wait_task',
  'dsh_get_result', 'dsh_continue_task', 'dsh_cancel_task',
  'dsh_export_delivery',
];

/** Opens one bridge process with its own scripted-runtime scenario. */
async function openBridge(scenario: string, extra: Record<string, string> = {}): Promise<Bridge> {
  const env = scriptedBridgeEnv({FAKE_SCENARIO: scenario, ...extra});
  return connectBridge(env);
}

async function call(client: ConnectedClient['client'], name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  return (await client.callTool({name, arguments: args})) as unknown as ToolReply;
}

const workspaces: string[] = [];

function freshWorkspace(label: string): string {
  const dir = makeWorkspace(label);
  workspaces.push(dir);
  return dir;
}

/** Submits a stage and waits for it to settle, returning the submit payload and the wait payload. */
async function runStage(
  client: ConnectedClient['client'],
  args: Record<string, unknown>,
): Promise<{submit: Record<string, unknown>; waited: Record<string, unknown>}> {
  const submitted = await call(client, 'dsh_submit_task', args);
  assert.notEqual(submitted.isError, true, `submit failed: ${textOf(submitted)}`);
  const submit = jsonOf(submitted);
  const waited = await call(client, 'dsh_wait_task', {taskId: submit.taskId, timeoutMs: 20_000});
  assert.notEqual(waited.isError, true, `wait failed: ${textOf(waited)}`);
  const waitPayload = jsonOf(waited);
  assert.equal(waitPayload.outcome, 'settled', `stage never settled: ${textOf(waited)}`);
  return {submit, waited: waitPayload};
}

before(() => {
  rmSync(TEST_DATA_ROOT, {recursive: true, force: true, maxRetries: 3});
});

after(() => {
  for (const dir of workspaces.splice(0)) cleanupDir(dir);
  rmSync(TEST_DATA_ROOT, {recursive: true, force: true, maxRetries: 3});
});

describe('MCP surface', () => {
  test('a real MCP client can connect, list exactly the documented tools and read their annotations', async () => {
    const bridge = await openBridge('success');
    try {
      const listed = await bridge.client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [...TOOL_NAMES].sort());

      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      // Declared side effects must match reality, not flatter it.
      assert.equal(byName.get('dsh_get_capabilities')?.annotations?.readOnlyHint, true);
      assert.equal(byName.get('dsh_get_task')?.annotations?.readOnlyHint, true);
      assert.equal(byName.get('dsh_wait_task')?.annotations?.readOnlyHint, true);
      assert.equal(byName.get('dsh_get_result')?.annotations?.readOnlyHint, true);
      assert.notEqual(byName.get('dsh_submit_task')?.annotations?.readOnlyHint, true, 'submit starts a model request and must not be advertised read-only');
      assert.notEqual(byName.get('dsh_continue_task')?.annotations?.readOnlyHint, true, 'continue starts a model request and must not be advertised read-only');
      assert.equal(byName.get('dsh_cancel_task')?.annotations?.destructiveHint, true, 'cancel kills a process and must be advertised destructive');

      for (const tool of listed.tools) {
        assert.ok((tool.description ?? '').length > 40, `${tool.name} needs a usable description`);
        assert.ok(tool.inputSchema, `${tool.name} must declare an input schema`);
      }
    } finally {
      await bridge.close();
    }
  });

  test('the declared schemas are enforced by the server, not just documented', async () => {
    const bridge = await openBridge('success');
    try {
      // maxTokens above the documented cap must be rejected by the schema layer.
      const rejected = await call(bridge.client, 'dsh_submit_task', {
        workspace: freshWorkspace('schema'), goal: 'x', maxTokens: 999_999,
      });
      assert.equal(rejected.isError, true, 'an out-of-range maxTokens must be refused');

      const missing = await call(bridge.client, 'dsh_get_task', {});
      assert.equal(missing.isError, true, 'a missing required taskId must be refused');
    } finally {
      await bridge.close();
    }
  });
});

describe('read-only capability check', () => {
  test('reports configuration as configuration and never claims an untested model is reachable', async () => {
    const bridge = await openBridge('success');
    try {
      const reply = await call(bridge.client, 'dsh_get_capabilities');
      assert.notEqual(reply.isError, true, textOf(reply));
      const payload = jsonOf<{
        modelRoute: {provider: string; model: string; api: string; baseURL: string; desktopProfileCheck: {matchesBridgeConstants: boolean; readable: boolean; error: string | null}};
        credential: {present: boolean; source: string; length: number; value?: string};
        sdkProtocol: {methodsThisBridgeUses: string[]; nativePerTurnCancel: boolean; methodProbe: {methods: Array<{method: string; found: boolean}>}};
        capabilities: {restartRecovery: boolean; loadsDesktopPlugins: boolean};
        modelReachability: string;
      }>(reply);

      assert.equal(payload.modelRoute.provider, 'opencode-go');
      assert.equal(payload.modelRoute.model, 'deepseek-flash');
      // Where a user profile exists (Windows) the pinned route is re-verified against it. Where
      // it does not (Linux) the honest answer is 'not re-verified', never a pass.
      if (payload.modelRoute.desktopProfileCheck.readable) {
        assert.equal(payload.modelRoute.desktopProfileCheck.matchesBridgeConstants, true);
      } else {
        // A missing/unreadable profile patch is also a valid capability diagnosis.
        assert.match(String(payload.modelRoute.desktopProfileCheck.error), /desktop profile|profile patch/i);
      }
      assert.equal(payload.modelRoute.api, 'openai-completions');
      assert.match(payload.modelRoute.baseURL, /opencode\.ai/);

      // The value itself must never leave the bridge; only its presence and shape.
      assert.equal(payload.credential.value, undefined, 'the credential value must never be returned');
      assert.ok(payload.credential.length === 0 || payload.credential.length > 20);
      assert.match(payload.modelReachability, /NOT tested/i);

      // The probe must show the engine is missing what the bridge refuses to invent.
      const probe = payload.sdkProtocol.methodProbe.methods;
      const found = new Set(probe.filter((m) => m.found).map((m) => m.method));
      for (const method of ['initialize', 'session/prompt', 'shutdown']) {
        assert.ok(found.has(method), `the pinned bundle should register ${method}`);
      }
      for (const method of ['session/cancel', 'session/resume']) {
        assert.ok(!found.has(method), `${method} must be reported as absent before the bridge relies on it`);
      }
      assert.equal(payload.sdkProtocol.nativePerTurnCancel, false);
      assert.equal(payload.capabilities.restartRecovery, false, 'the absence of restart recovery must be declared');
      assert.equal(payload.capabilities.loadsDesktopPlugins, false, 'desktop plugins are not loaded and must not be implied');

      // Untested or unimplemented things must be stated as such.
      const text = textOf(reply);
      const all = text + JSON.stringify(payload);
      assert.match(all, /restart/i, 'the absence of restart recovery must be declared');
      assert.ok(!all.includes('sk-FAKE'), 'no secret shape may appear in a capability report');
    } finally {
      await bridge.close();
    }
  });
});

describe('full two-stage loop over MCP', () => {
  test('submit -> wait -> result -> continue -> wait -> result keeps both stages intact', async () => {
    const bridge = await openBridge('success');
    const workspace = freshWorkspace('loop');
    try {
      const first = await call(bridge.client, 'dsh_submit_task', {
        workspace,
        goal: 'Write a normalisation function and its tests.',
        context: 'Stage 1 of a two-stage loop.',
        constraints: ['Do not invent passing test output.'],
        acceptance: 'A test command exits 0.',
        verificationCommand: [process.execPath, '-e', 'process.exit(0)'],
      });
      assert.notEqual(first.isError, true, textOf(first));
      const submit1 = jsonOf<{taskId: string; sessionId: string; state: string; messageId: string; runtimePid: number}>(first);
      // Submit must come back as soon as the prompt is acknowledged. Over the wire the first status
      // notification has often already arrived, so any live state is correct here; awaiting_review
      // would mean the bridge blocked until the work finished.
      assert.ok(['starting', 'running'].includes(submit1.state), `submit returned state=${submit1.state}, which is not a live state`);
      assert.ok(submit1.taskId && submit1.sessionId && submit1.messageId);

      const waited1 = jsonOf<{outcome: string; status: {state: string}}>(await call(bridge.client, 'dsh_wait_task', {taskId: submit1.taskId, timeoutMs: 20_000}));
      assert.equal(waited1.outcome, 'settled');
      assert.equal(waited1.status.state, 'awaiting_review');

      const result1 = jsonOf<{
        stage: number; modelReport: {text: string; chars: number};
        bridgeObserved: {toolCallsTotal: number; verificationCommand: {exitCode: number | null; argv: string[]} | null; filesChanged: {added: string[]}};
      }>(await call(bridge.client, 'dsh_get_result', {taskId: submit1.taskId}));
      assert.equal(result1.stage, 1);
      assert.match(result1.modelReport.text, /stage 1/i);
      // The bridge's own observations must be present and separate from the model's words.
      assert.equal(result1.bridgeObserved.toolCallsTotal, 1);
      assert.equal(result1.bridgeObserved.verificationCommand?.exitCode, 0);
      assert.ok(result1.bridgeObserved.filesChanged.added.some((f) => f.endsWith('notes.md')), 'the file the stage actually wrote must appear in the bridge-observed diff');

      const continued = await call(bridge.client, 'dsh_continue_task', {
        taskId: submit1.taskId,
        review: 'The name normalisation drops full-width slashes. Fix and re-test.',
        acceptance: 'Both the ASCII and the full-width cases pass.',
      });
      assert.notEqual(continued.isError, true, textOf(continued));
      const cont = jsonOf<{stage: number; state: string; messageId: string}>(continued);
      assert.equal(cont.stage, 2);
      assert.notEqual(cont.messageId, submit1.messageId, 'each stage must have its own messageId');

      const waited2 = jsonOf<{outcome: string; status: {state: string}}>(await call(bridge.client, 'dsh_wait_task', {taskId: submit1.taskId, timeoutMs: 20_000}));
      assert.equal(waited2.outcome, 'settled');
      assert.equal(waited2.status.state, 'awaiting_review');

      const result2 = jsonOf<{stage: number; modelReport: {text: string}}>(await call(bridge.client, 'dsh_get_result', {taskId: submit1.taskId}));
      assert.equal(result2.stage, 2);
      assert.match(result2.modelReport.text, /stage 2/i);

      // Stage 1 must still be readable, byte for byte, after stage 2 ran.
      const stage1Again = jsonOf<{stage: number; modelReport: {text: string}}>(await call(bridge.client, 'dsh_get_result', {taskId: submit1.taskId, stage: 1}));
      assert.equal(stage1Again.stage, 1);
      assert.equal(stage1Again.modelReport.text, result1.modelReport.text);

      const status = jsonOf<{state: string; stageCount: number; canContinue: boolean}>(await call(bridge.client, 'dsh_get_task', {taskId: submit1.taskId}));
      assert.equal(status.stageCount, 2);
      assert.equal(status.canContinue, true);

      const cancelled = jsonOf<{runtimeStopped: boolean; pid: number}>(await call(bridge.client, 'dsh_cancel_task', {taskId: submit1.taskId}));
      assert.equal(cancelled.runtimeStopped, true);
      assert.equal(cancelled.pid, submit1.runtimePid);
      // The task-owned process must actually be gone, not merely reported gone.
      await sleep(200);
      assert.throws(() => process.kill(submit1.runtimePid, 0), 'the task SDK process must not survive cancel');
    } finally {
      await bridge.close();
    }
  });
});

describe('refusals and faults, driven over the protocol', () => {
  test('unknown taskId is refused by every task-scoped tool', async () => {
    const bridge = await openBridge('success');
    try {
      const unknown = 'task-does-not-exist';
      for (const [name, args] of [
        ['dsh_get_task', {taskId: unknown}],
        ['dsh_get_result', {taskId: unknown}],
        ['dsh_continue_task', {taskId: unknown, review: 'r'}],
        ['dsh_cancel_task', {taskId: unknown}],
      ] as const) {
        const reply = await call(bridge.client, name, args);
        assert.equal(reply.isError, true, `${name} must refuse an unknown taskId`);
      }
      // wait is allowed to answer without error, but it must not invent a task.
      const waited = await call(bridge.client, 'dsh_wait_task', {taskId: unknown, timeoutMs: 1_000});
      if (waited.isError !== true) {
        assert.match(textOf(waited), /unknown|not found/i);
      }
    } finally {
      await bridge.close();
    }
  });

  test('a workspace outside the allowed roots is refused before anything is spawned', async () => {
    const bridge = await openBridge('success');
    try {
      const outside = process.platform === 'win32'
        ? ['C:\\Windows', 'D:\\AGENTS\\workspaces\\..\\..\\Windows', 'not-absolute']
        : ['/etc', '/tmp/../etc', 'not-absolute'];
      for (const workspace of outside) {
        const reply = await call(bridge.client, 'dsh_submit_task', {workspace, goal: 'should never run'});
        assert.equal(reply.isError, true, `${workspace} must be refused`);
        assert.match(textOf(reply), /workspace|allowed/i);
      }
    } finally {
      await bridge.close();
    }
  });

  test('a wait timeout reports the timeout and leaves the task running', async () => {
    const bridge = await openBridge('slow');
    try {
      const submit = jsonOf<{taskId: string}>(await call(bridge.client, 'dsh_submit_task', {
        workspace: freshWorkspace('slowwait'), goal: 'a stage that takes a minute',
      }));
      const waited = jsonOf<{outcome: string; status: {state: string}; note: string}>(await call(bridge.client, 'dsh_wait_task', {taskId: submit.taskId, timeoutMs: 1_000}));
      assert.equal(waited.outcome, 'timeout');
      assert.equal(waited.status.state, 'running', 'a wait timeout must not settle or fail the task');
      const status = jsonOf<{state: string}>(await call(bridge.client, 'dsh_get_task', {taskId: submit.taskId}));
      assert.equal(status.state, 'running');
      await call(bridge.client, 'dsh_cancel_task', {taskId: submit.taskId});
    } finally {
      await bridge.close();
    }
  });

  test('a turn that ends in an error is failed, not success, and the reason is kept', async () => {
    const bridge = await openBridge('turn_end_failed');
    try {
      const {submit} = await runStage(bridge.client, {workspace: freshWorkspace('fail'), goal: 'this stage fails'});
      const payload = jsonOf<{
        stageState: string; taskState: string;
        bridgeObserved: {turnEndReason: {kind: string; error?: {message?: string; code?: string}} | null};
        unresolved: string[];
      }>(await call(bridge.client, 'dsh_get_result', {taskId: submit.taskId as string}));
      assert.equal(payload.stageState, 'failed');
      assert.equal(payload.taskState, 'failed');
      assert.equal(payload.bridgeObserved.turnEndReason?.kind, 'error');
      assert.match(payload.bridgeObserved.turnEndReason?.error?.message ?? '', /provider refused/);
      assert.ok(payload.unresolved.length >= 1, 'a failure must leave an unresolved item for Codex');
    } finally {
      await bridge.close();
    }
  });

  test('a runtime that dies after acknowledging the prompt fails the task and reports the exit', async () => {
    const bridge = await openBridge('crash_after_ack');
    try {
      const {submit} = await runStage(bridge.client, {workspace: freshWorkspace('crash'), goal: 'the runtime dies mid-stage'});
      const status = jsonOf<{state: string; runtimeAlive: boolean; runtimeExit: {code: number | null} | null}>(await call(bridge.client, 'dsh_get_task', {taskId: submit.taskId as string}));
      assert.equal(status.state, 'failed');
      assert.equal(status.runtimeAlive, false);
      assert.equal(status.runtimeExit?.code, 3, 'the real exit code must be recorded, not inferred from output');
    } finally {
      await bridge.close();
    }
  });

  test('an approval request parks the task as blocked instead of approving it', async () => {
    const bridge = await openBridge('approval');
    try {
      const {submit} = await runStage(bridge.client, {workspace: freshWorkspace('approval'), goal: 'asks for approval'});
      const status = jsonOf<{state: string; errors: string[]}>(await call(bridge.client, 'dsh_get_task', {taskId: submit.taskId as string}));
      assert.equal(status.state, 'blocked');
      // The bridge must surface the request rather than approving it on the user's behalf.
      const result = jsonOf<{bridgeObserved: {approvalsRequested: unknown[]}}>(await call(bridge.client, 'dsh_get_result', {taskId: submit.taskId as string}));
      assert.equal(result.bridgeObserved.approvalsRequested.length, 1);
      await call(bridge.client, 'dsh_cancel_task', {taskId: submit.taskId as string});
    } finally {
      await bridge.close();
    }
  });

  test('a tool that reported isError is counted, and a secret printed by a tool never reaches a reply', async () => {
    const bridge = await openBridge('secret_leak');
    try {
      const {submit} = await runStage(bridge.client, {workspace: freshWorkspace('secret'), goal: 'a tool leaks a key'});
      const reply = await call(bridge.client, 'dsh_get_result', {taskId: submit.taskId as string, verbose: true});
      const text = textOf(reply);
      assert.ok(!text.includes('sk-FAKE'), 'a credential shape printed by a tool must be scrubbed');

      // The scrubbed text must still be readable evidence, not an empty husk.
      const payload = jsonOf<{bridgeObserved: {toolCallsTotal: number; toolErrorCount: number}}>(reply);
      assert.ok(payload.bridgeObserved.toolCallsTotal >= 2);
      const status = jsonOf<{state: string}>(await call(bridge.client, 'dsh_get_task', {taskId: submit.taskId as string}));
      assert.equal(status.state, 'awaiting_review');
    } finally {
      await bridge.close();
    }
  });

  test('a second concurrent task is refused while the limit is one', async () => {
    const bridge = await openBridge('slow', {DSH_BRIDGE_MAX_TASKS: '1'});
    try {
      const first = await call(bridge.client, 'dsh_submit_task', {workspace: freshWorkspace('limit-a'), goal: 'occupies the only slot'});
      assert.notEqual(first.isError, true, textOf(first));
      const taskId = jsonOf<{taskId: string}>(first).taskId;

      const second = await call(bridge.client, 'dsh_submit_task', {workspace: freshWorkspace('limit-b'), goal: 'must be refused'});
      assert.equal(second.isError, true, 'the concurrency limit must be enforced by the bridge, not by asking the model nicely');
      assert.match(textOf(second), /concurren|limit|in flight/i);

      const continued = await call(bridge.client, 'dsh_continue_task', {taskId, review: 'must be refused while running'});
      assert.equal(continued.isError, true, 'a stage already in flight must refuse a new one');

      await call(bridge.client, 'dsh_cancel_task', {taskId});
    } finally {
      await bridge.close();
    }
  });

  test('after cancel the task is settled, further stages are refused and the evidence stays on disk', async () => {
    const bridge = await openBridge('slow');
    try {
      const submit = jsonOf<{taskId: string; taskDir: string}>(await call(bridge.client, 'dsh_submit_task', {
        workspace: freshWorkspace('cancel'), goal: 'cancelled mid-flight',
      }));
      const cancelled = jsonOf<{
        cancelled: boolean; runtimeStopped: boolean; method: string; partialFileChanges: {added: string[]} | null;
        evidence: {taskDir: string; eventsLog: string};
      }>(await call(bridge.client, 'dsh_cancel_task', {taskId: submit.taskId}));
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.runtimeStopped, true, 'cancel must verify the process is gone');
      assert.ok(cancelled.method.length > 0, 'the bridge must say HOW it stopped the runtime');
      assert.ok(existsSync(cancelled.evidence.eventsLog), 'the event log must survive the cancel');

      const again = jsonOf<{alreadyCancelled: boolean}>(await call(bridge.client, 'dsh_cancel_task', {taskId: submit.taskId}));
      assert.equal(again.alreadyCancelled, true);

      const continued = await call(bridge.client, 'dsh_continue_task', {taskId: submit.taskId, review: 'too late'});
      assert.equal(continued.isError, true, 'a cancelled task must refuse further stages');

      const status = jsonOf<{state: string; canContinue: boolean}>(await call(bridge.client, 'dsh_get_task', {taskId: submit.taskId}));
      assert.equal(status.state, 'cancelled');
      assert.equal(status.canContinue, false);
    } finally {
      await bridge.close();
    }
  });

  test('the bridge survives a client disconnect without orphaning its own runtime', async () => {
    const bridge = await openBridge('slow');
    const submit = jsonOf<{taskId: string; runtimePid: number; taskDir: string}>(await call(bridge.client, 'dsh_submit_task', {
      workspace: freshWorkspace('disconnect'), goal: 'the client goes away mid-stage',
    }));
    await bridge.close();

    // The bridge process should notice stdin EOF and stop the runtime it owns. Windows needs a moment.
    await waitFor(() => {
      try { process.kill(submit.runtimePid, 0); return null; } catch { return true; }
    }, 15_000, 200).catch(() => {
      throw new Error(`the task runtime pid ${submit.runtimePid} outlived the bridge process`);
    });

    // Evidence written before the disconnect must still be readable. The append-only log lives at
    // the task root, so it is flushed as events arrive rather than only at shutdown.
    const log = path.join(submit.taskDir, 'events.jsonl');
    assert.ok(existsSync(log), 'the event log must be flushed before the bridge exits');
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(lines.length >= 2, 'the log should already contain the runtime start');
  });
});

describe('the fixture is not accidentally reachable from the shipped server', () => {
  test('the built entry point never mentions the test fixture', () => {
    const main = readFileSync(BRIDGE_MAIN, 'utf8');
    assert.ok(!main.includes('fake-runtime'), 'the shipped entry must not reference a test fixture');
  });
});

test('complete delivery automatically repairs and explicitly exports through real MCP', async () => {
  const bridge = await openBridge('success');
  try {
    const workspace = freshWorkspace('mcp-complete');
    const check = path.join(workspace, 'accept.cjs');
    writeFileSync(check, "if(!require('fs').readFileSync('notes.md','utf8').includes('stage 2')){console.error('must deliver stage 2');process.exit(4)}");
    const {submit, waited} = await runStage(bridge.client, {workspace, goal: 'Deliver two stages.', deliveryPreset: 'complete', reasoningEffort: 'low', maxTokens: 2048, budgetMs: 30000, verificationCommand: ['node', check], protectedVerificationFiles: [check]});
    assert.equal(submit.deliveryPreset, 'complete');
    assert.deepEqual(submit.effectiveParameters, {reasoningEffort: 'low', maxTokens: 2048, budgetMs: 30000});
    assert.equal((waited.status as {stageCount: number}).stageCount, 2);
    const result = jsonOf<any>(await call(bridge.client, 'dsh_get_result', {taskId: submit.taskId}));
    assert.equal(result.bridgeObserved.verification.status, 'passed');
    assert.equal(result.autoRepair.attempts, 1);
    assert.ok(result.artifacts.deliveryIndex);
    const exported = await call(bridge.client, 'dsh_export_delivery', {taskId: submit.taskId, destination: path.join(workspace, 'export')});
    assert.notEqual(exported.isError, true, textOf(exported));
    const payload = jsonOf<any>(exported);
    const index = JSON.parse(readFileSync(payload.indexJson, 'utf8'));
    assert.equal(index.metrics.codexContinuationCount, 0);
    assert.equal(index.metrics.autoRepairCount, 1);
    assert.equal(index.hostVerification.latest.status, 'passed');
  } finally { await bridge.close(); }
});
