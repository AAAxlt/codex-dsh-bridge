/**
 * Permanent persistence-health regressions. Faults are injected in a subprocess by a test-only
 * `--import` preload; production has no environment-controlled bypass.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {BRIDGE_MAIN, REPO_ROOT, cleanupDir, jsonOf, makeWorkspace, scriptedBridgeEnv, textOf} from './helpers.js';

const PRELOAD = path.join(REPO_ROOT, 'test', 'fixtures', 'fs-fault-preload.mjs');
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function openFaulted(environment: Record<string, string>): Promise<{client: Client; close: () => Promise<void>}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', PRELOAD, BRIDGE_MAIN],
    env: scriptedBridgeEnv(environment),
    cwd: REPO_ROOT,
    stderr: 'pipe',
  });
  const client = new Client({name: 'persistence-regression', version: '1.0.7'}, {capabilities: {}});
  await client.connect(transport);
  return {client, close: async () => { try { await client.close(); } catch { /* already gone */ } }};
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{isError?: boolean; content?: Array<{type: string; text?: string}>}> {
  return (await client.callTool({name, arguments: args})) as unknown as {isError?: boolean; content?: Array<{type: string; text?: string}>};
}

test('initial task.json and checkpoint persistence failures return an error and send no prompt', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-persist-initial-'));
  try {
    for (const target of ['task.json', 'checkpoint.json']) {
      const workspace = makeWorkspace(`persist-${target.replace('.', '-')}`);
      const trace = path.join(root, `trace-${target}`);
      const opened = await openFaulted({
        FAKE_SCENARIO: 'success',
        DSH_BRIDGE_DATA_ROOT: path.join(root, `data-${target}`),
        FAKE_TRACE: trace,
        BRIDGE_PROBE_FAULT_TARGET: target,
      });
      try {
        const reply = await call(opened.client, 'dsh_submit_task', {
          workspace, goal: 'must never be sent', budgetMs: 10_000,
        });
        assert.equal(reply.isError, true, `initial ${target} fault must be an explicit error: ${textOf(reply)}`);
        assert.equal(existsSync(trace), false, `no runtime/turn may start when ${target} cannot be persisted`);
      } finally { await opened.close(); cleanupDir(workspace); }
    }
  } finally { rmSync(root, {recursive: true, force: true, maxRetries: 3}); }
});

test('a later checkpoint failure is exposed as degraded and preserves prior valid bytes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-persist-late-'));
  const workspace = makeWorkspace('persist-late');
  try {
    const data = path.join(root, 'data');
    const marker = path.join(root, 'enable-fault');
    const opened = await openFaulted({
      FAKE_SCENARIO: 'delayed_complete',
      DSH_BRIDGE_DATA_ROOT: data,
      BRIDGE_PROBE_FAULT_TARGET: 'checkpoint.json',
      BRIDGE_PROBE_FAULT_MARKER: marker,
    });
    try {
      const submitted = await call(opened.client, 'dsh_submit_task', {workspace, goal: 'later fault', budgetMs: 20_000});
      assert.notEqual(submitted.isError, true, textOf(submitted));
      const taskId = String(jsonOf<{taskId: string}>(submitted).taskId);
      const checkpointFile = path.join(data, 'tasks', taskId, 'checkpoint.json');
      assert.ok(existsSync(checkpointFile));
      const before = readFileSync(checkpointFile);
      writeFileSync(marker, 'on');
      await call(opened.client, 'dsh_wait_task', {taskId, timeoutMs: 20_000});
      const status = jsonOf<{persistence: {status: string; failures: Array<{file: string; code: string | null}>}}>(
        await call(opened.client, 'dsh_get_task', {taskId}),
      );
      const result = jsonOf<{persistence: {status: string}}>(await call(opened.client, 'dsh_get_result', {taskId}));
      assert.equal(status.persistence.status, 'degraded');
      assert.equal(result.persistence.status, 'degraded');
      assert.ok(status.persistence.failures.some((failure) => failure.file.endsWith('checkpoint.json') && failure.code === 'ENOSPC'));
      assert.equal(sha(readFileSync(checkpointFile)), sha(before), 'a failed atomic update must not replace prior good bytes');
      assert.ok(before.length > 0);
    } finally {
      if (existsSync(marker)) rmSync(marker, {force: true});
      await opened.close();
    }
  } finally {
    cleanupDir(workspace);
    rmSync(root, {recursive: true, force: true, maxRetries: 3});
  }
});

test('an event-log write failure degrades persistence without erasing earlier events', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-persist-events-'));
  const workspace = makeWorkspace('persist-events');
  try {
    const data = path.join(root, 'data');
    const marker = path.join(root, 'enable-fault');
    const opened = await openFaulted({
      FAKE_SCENARIO: 'delayed_complete',
      DSH_BRIDGE_DATA_ROOT: data,
      BRIDGE_PROBE_FAULT_TARGET: 'events.jsonl',
      BRIDGE_PROBE_FAULT_MARKER: marker,
    });
    try {
      const submitted = await call(opened.client, 'dsh_submit_task', {workspace, goal: 'event fault', budgetMs: 20_000});
      assert.notEqual(submitted.isError, true, textOf(submitted));
      const taskId = String(jsonOf<{taskId: string}>(submitted).taskId);
      const eventsFile = path.join(data, 'tasks', taskId, 'events.jsonl');
      const before = readFileSync(eventsFile);
      writeFileSync(marker, 'on');
      await call(opened.client, 'dsh_wait_task', {taskId, timeoutMs: 20_000});
      const status = jsonOf<{persistence: {status: string; failures: Array<{code: string | null}>}}>(await call(opened.client, 'dsh_get_task', {taskId}));
      assert.equal(status.persistence.status, 'degraded');
      assert.ok(status.persistence.failures.some((failure) => failure.code === 'ENOSPC'));
      assert.equal(sha(readFileSync(eventsFile)), sha(before), 'a failed append must not truncate or rewrite earlier events');
    } finally {
      if (existsSync(marker)) rmSync(marker, {force: true});
      await opened.close();
    }
  } finally {
    cleanupDir(workspace);
    rmSync(root, {recursive: true, force: true, maxRetries: 3});
  }
});
