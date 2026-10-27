/**
 * Bounded incremental event paging and recent live progress regressions.
 */
import assert from 'node:assert/strict';
import {appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {readEventPage, EventsError, EVENT_LIMITS} from '../src/events.js';
import {cleanupDir, connectBridge, jsonOf, makeWorkspace, scriptedBridgeEnv, textOf} from './helpers.js';

const line = (index: number): string => `${JSON.stringify({at: `2026-10-25T00:00:${String(index % 60).padStart(2, '0')}Z`, kind: 'notification', type: 'tool/call', params: {callId: `c-${index}`}})}\n`;

test('event paging is bounded, cursor-bound and leaves a partial final line unconsumed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-events-unit-'));
  try {
    const file = path.join(root, 'events.jsonl');
    let text = '';
    for (let index = 0; index < 150; index += 1) text += line(index);
    // Secret + reasoning shapes must be scrubbed at output, not just at storage time.
    text += `${JSON.stringify({kind: 'notification', params: {reasoning: 'DO_NOT_DISCLOSE_REASONING', text: 'key=sk-FAKE000000000000000000000000000000'}})}\n`;
    text += '{"kind":"partial"';
    writeFileSync(file, text);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let last: ReturnType<typeof readEventPage>;
    do {
      last = readEventPage({file, taskId: 'dsh-20261025000000-events', cursor, limit: 17, source: 'live', runtimeAttached: false});
      assert.ok(last.events.length <= 17);
      assert.ok(last.scannedBytes <= EVENT_LIMITS.maxScannedBytes);
      assert.ok(Buffer.byteLength(JSON.stringify(last), 'utf8') < 128 * 1024);
      seen.push(JSON.stringify(last.events));
      if (last.hasMore) assert.ok(last.nextCursor && last.nextCursor !== cursor);
      cursor = last.nextCursor ?? undefined;
      assert.ok(++pages < 40);
    } while (last!.hasMore);
    assert.equal(seen.join('').includes('DO_NOT_DISCLOSE_REASONING'), false);
    assert.equal(seen.join('').includes('sk-FAKE000000000000000000000000000000'), false);
    assert.ok(seen.join('').includes('c-149'), 'complete pagination must expose the 150th event');
    assert.equal(last!.partialLine, true);
    assert.ok((last!.pendingBytes ?? 0) > 0);

    // Completing the partial line makes it readable from the SAME cursor without re-reading old data.
    appendFileSync(file, ', "now":"complete"}\n');
    const resumed = readEventPage({file, taskId: 'dsh-20261025000000-events', cursor, limit: 5, source: 'live', runtimeAttached: false});
    assert.equal(resumed.partialLine, false);
    assert.equal(resumed.events.length, 1);
    assert.match(JSON.stringify(resumed.events[0]), /complete/);

    assert.throws(
      () => readEventPage({file, taskId: 'dsh-20261025000000-other', cursor, limit: 5, source: 'live', runtimeAttached: false}),
      (error: unknown) => error instanceof EventsError && error.code === 'invalid_cursor',
    );
    assert.throws(
      () => readEventPage({file, taskId: 'dsh-20261025000000-events', cursor: 'not-a-cursor', limit: 5, source: 'live', runtimeAttached: false}),
      (error: unknown) => error instanceof EventsError && error.code === 'invalid_cursor',
    );
    truncateSync(file, 0);
    assert.throws(
      () => readEventPage({file, taskId: 'dsh-20261025000000-events', cursor, limit: 5, source: 'live', runtimeAttached: false}),
      (error: unknown) => error instanceof EventsError && error.code === 'invalid_cursor',
    );
    assert.throws(
      () => readEventPage({file, taskId: 'dsh-20261025000000-events', limit: 101, source: 'live', runtimeAttached: false}),
      (error: unknown) => error instanceof EventsError,
    );
  } finally { rmSync(root, {recursive: true, force: true, maxRetries: 3}); }
});

test('an oversized single event becomes a bounded advancing placeholder instead of an empty loop', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-events-oversize-'));
  try {
    const file = path.join(root, 'events.jsonl');
    const big = JSON.stringify({values: Array.from({length: 50}, () => 'x'.repeat(4000))});
    assert.ok(Buffer.byteLength(big) > EVENT_LIMITS.maxReturnedBytes);
    assert.ok(Buffer.byteLength(big) < EVENT_LIMITS.maxLineBytes);
    writeFileSync(file, `${big}\n${JSON.stringify({kind: 'after-large-event'})}\n`);

    const page = readEventPage({file, taskId: 'dsh-20261025000000-oversize', limit: 25, source: 'live', runtimeAttached: false});
    assert.equal(page.events.length, 2, 'the oversized event must not consume the whole page or disappear');
    assert.equal((page.events[0] as {kind?: string}).kind, 'bridge/oversized-event');
    assert.equal(page.hasMore, false);
    assert.ok(page.nextCursor);
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') < EVENT_LIMITS.maxReturnedBytes + 64 * 1024);

    // An oversized LATER item must still advance without losing the following event, even when
    // the page limit is one event.
    const later = path.join(root, 'later-events.jsonl');
    writeFileSync(later, `${JSON.stringify({kind: 'first'})}\n${big}\n${JSON.stringify({kind: 'last'})}\n`);
    const first = readEventPage({file: later, taskId: 'dsh-20261025000000-oversize', limit: 1, source: 'live', runtimeAttached: false});
    assert.equal(first.events.length, 1);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);
    const middle = readEventPage({file: later, taskId: 'dsh-20261025000000-oversize', cursor: first.nextCursor!, limit: 1, source: 'live', runtimeAttached: false});
    assert.equal((middle.events[0] as {kind?: string}).kind, 'bridge/oversized-event');
    assert.equal(middle.hasMore, true);
    assert.ok(middle.nextCursor && middle.nextCursor !== first.nextCursor);
    const last = readEventPage({file: later, taskId: 'dsh-20261025000000-oversize', cursor: middle.nextCursor!, limit: 1, source: 'live', runtimeAttached: false});
    assert.equal((last.events[0] as {kind?: string}).kind, 'last');
    assert.equal(last.hasMore, false);
  } finally { rmSync(root, {recursive: true, force: true, maxRetries: 3}); }
});

test('a 75-call stage exposes the newest calls in progress and all events, while first60 compatibility stays bounded', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-events-live-'));
  const workspace = makeWorkspace('events-live');
  const data = path.join(root, 'data');
  const env = scriptedBridgeEnv({FAKE_SCENARIO: 'many_tools', DSH_BRIDGE_DATA_ROOT: data});
  let bridge = await connectBridge(env);
  try {
    const submitted = await bridge.client.callTool({name: 'dsh_submit_task', arguments: {workspace, goal: 'many calls', budgetMs: 20_000}});
    assert.notEqual(submitted.isError, true, textOf(submitted));
    const taskId = String(jsonOf<{taskId: string}>(submitted).taskId);
    await bridge.client.callTool({name: 'dsh_wait_task', arguments: {taskId, timeoutMs: 20_000}});

    const status = jsonOf<any>(await bridge.client.callTool({name: 'dsh_get_task', arguments: {taskId}}));
    const result = jsonOf<any>(await bridge.client.callTool({name: 'dsh_get_result', arguments: {taskId}}));
    assert.ok(status.progress.lastActivityAt);
    assert.ok(JSON.stringify(status.progress.recentTools).includes('many-1-75'), JSON.stringify(status.progress));
    assert.ok(JSON.stringify(result.progress.recentTools).includes('many-1-75'));
    assert.equal(result.bridgeObserved.toolCallsTotal, 75);
    assert.equal(result.bridgeObserved.toolCallsRetained, 60);
    assert.equal(result.bridgeObserved.toolCalls.length, 25, 'the compatibility toolCalls list stays first-60 and displayed-preview bounded');
    assert.equal(JSON.stringify(result.bridgeObserved.toolCalls).includes('many-1-75'), false);

    let cursor: string | undefined;
    let seen = '';
    let last: any;
    let pages = 0;
    do {
      const page = jsonOf<any>(await bridge.client.callTool({
        name: 'dsh_get_events', arguments: {taskId, limit: 11, ...(cursor ? {cursor} : {})},
      }));
      assert.ok(page.events.length <= 11);
      assert.equal(page.source, 'live');
      seen += JSON.stringify(page.events);
      if (page.hasMore) assert.ok(page.nextCursor && page.nextCursor !== cursor);
      cursor = page.nextCursor ?? undefined;
      last = page;
      assert.ok(++pages < 100);
    } while (last.hasMore);
    assert.ok(seen.includes('many-1-75'));

    const cancelled = jsonOf<any>(await bridge.client.callTool({name: 'dsh_cancel_task', arguments: {taskId}}));
    assert.equal(cancelled.cancelled, true);
    await bridge.close();
    bridge = await connectBridge(env);
    const historical = jsonOf<any>(await bridge.client.callTool({name: 'dsh_get_events', arguments: {taskId, limit: 5}}));
    assert.equal(historical.source, 'persisted-history');
    assert.equal(historical.runtimeAttached, false);
    assert.ok(historical.events.length <= 5);
  } finally {
    await bridge.close();
    cleanupDir(workspace);
    rmSync(root, {recursive: true, force: true, maxRetries: 3});
  }
});

test('live event pages scrub secret-shaped tool output', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-events-secret-'));
  const workspace = makeWorkspace('events-secret');
  const data = path.join(root, 'data');
  const bridge = await connectBridge(scriptedBridgeEnv({FAKE_SCENARIO: 'secret_leak', DSH_BRIDGE_DATA_ROOT: data}));
  try {
    const submitted = await bridge.client.callTool({name: 'dsh_submit_task', arguments: {workspace, goal: 'secret', budgetMs: 20_000}});
    const taskId = String(jsonOf<{taskId: string}>(submitted).taskId);
    await bridge.client.callTool({name: 'dsh_wait_task', arguments: {taskId, timeoutMs: 20_000}});
    let cursor: string | undefined;
    let seen = '';
    let more = true;
    while (more) {
      const page = jsonOf<any>(await bridge.client.callTool({name: 'dsh_get_events', arguments: {taskId, limit: 100, ...(cursor ? {cursor} : {})}}));
      seen += JSON.stringify(page.events);
      more = page.hasMore;
      cursor = page.nextCursor ?? undefined;
    }
    assert.equal(seen.includes('sk-FAKE000000000000000000000000000000000000000000'), false);
    assert.match(seen, /REDACTED/);
    await bridge.client.callTool({name: 'dsh_cancel_task', arguments: {taskId}});
  } finally {
    await bridge.close();
    cleanupDir(workspace);
    rmSync(root, {recursive: true, force: true, maxRetries: 3});
  }
});
