/**
 * The wait contract, end to end and with no model.
 *
 * linux-05 died exactly here: the driver asked the bridge to block a wait for 120s while the MCP
 * client aborted at its own 60s SDK default, so the run lost its verdict to a client-side
 * "Request timed out" on a bridge that was still perfectly healthy. These tests pin both halves of
 * the fix: the bridge publishes the window it may block for and the floor a client must use, the
 * schema cannot exceed that window, and a wait longer than the window is survivable only by a client
 * that honours the published floor.
 *
 * The client timeout in step 1 is deliberately shortened instead of waiting a real 60s, so the
 * failure mode is reproduced at test speed. Nothing here spends a model request.
 */
import assert from 'node:assert/strict';
import {after, describe, test} from 'node:test';

import {
  cleanupDir, connectBridge, jsonOf, makeWorkspace, scriptedBridgeEnv, TEST_ROOT, textOf,
  type ConnectedClient,
} from './helpers.js';

const WAIT_MAX_MS = 1_500;
const CLIENT_FLOOR_MS = WAIT_MAX_MS + 5_000;
const env = scriptedBridgeEnv({
  DSH_BRIDGE_WAIT_MAX_MS: String(WAIT_MAX_MS),
  FAKE_SCENARIO: 'no_turn_end',
});

let bridge: ConnectedClient | null = null;

async function connected(): Promise<ConnectedClient> {
  bridge ??= await connectBridge(env);
  return bridge;
}

after(async () => {
  await bridge?.close();
  cleanupDir(TEST_ROOT);
});

describe('wait contract (scripted runtime, no model)', () => {
  test('capabilities publish the wait window and the client timeout floor', async () => {
    const {client} = await connected();
    const caps = jsonOf<{limits: {waitTimeoutMs: number; waitTimeoutMaxMs: number; clientRequestTimeoutFloorMs: number}}>(
      await client.callTool({name: 'dsh_get_capabilities', arguments: {}}),
    );
    assert.equal(caps.limits.waitTimeoutMaxMs, WAIT_MAX_MS, 'the published window must be the effective one');
    assert.equal(caps.limits.clientRequestTimeoutFloorMs, CLIENT_FLOOR_MS);
    assert.ok(
      caps.limits.clientRequestTimeoutFloorMs > caps.limits.waitTimeoutMaxMs,
      'the floor a client must use has to exceed the window the bridge may block for',
    );
  });

  test('a wait window above the published cap is refused, not silently clamped', async () => {
    const {client} = await connected();
    let refused = false;
    let message = '';
    try {
      const result = await client.callTool({
        name: 'dsh_wait_task',
        arguments: {taskId: 'task-that-does-not-matter', timeoutMs: WAIT_MAX_MS + 1},
      });
      refused = result.isError === true;
      message = textOf(result);
    } catch (error) {
      refused = true;
      message = error instanceof Error ? error.message : String(error);
    }
    assert.ok(refused, 'a timeoutMs above limits.waitTimeoutMaxMs must be refused');
    assert.match(message, new RegExp(String(WAIT_MAX_MS)), `the refusal should name the cap: ${message}`);
  });

  test('a wait longer than the window is lost only by a client that ignores the floor', async () => {
    const {client} = await connected();
    const workspace = makeWorkspace('wait-contract');
    const submitted = jsonOf<{taskId: string; state: string}>(
      await client.callTool({name: 'dsh_submit_task', arguments: {workspace, goal: 'Hold the stage open.'}}),
    );
    const {taskId} = submitted;

    // 1. The linux-05 shape: a client timeout below the window the bridge is allowed to block for.
    //    The bridge is healthy; the CALL is what dies. Shortened to 300ms so the test stays fast.
    await assert.rejects(
      () => client.callTool(
        {name: 'dsh_wait_task', arguments: {taskId, timeoutMs: WAIT_MAX_MS}},
        {timeout: 300},
      ),
      /timed out|timeout/i,
      'a client that ignores the published floor must lose the call: that is what killed linux-05',
    );

    // 2. The same wait with the aligned timeout: the bridge answers instead of the transport dying.
    const outcome = jsonOf<{outcome: string; waitedMs: number; status: {state: string}}>(
      await client.callTool(
        {name: 'dsh_wait_task', arguments: {taskId, timeoutMs: WAIT_MAX_MS}},
        {timeout: CLIENT_FLOOR_MS},
      ),
    );
    assert.equal(outcome.outcome, 'timeout', 'this scenario never ends its turn, so the wait must time out cleanly');
    assert.ok(
      outcome.waitedMs >= WAIT_MAX_MS - 250,
      `the bridge must actually have blocked for the window (waitedMs=${outcome.waitedMs})`,
    );
    assert.equal(outcome.status.state, 'running', 'a timed-out wait is not a failure and must not change the state');
  });
});
