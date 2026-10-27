/**
 * Bounded incremental paging over the bridge's own append-only JSONL event log.
 *
 * The reader never loads the whole file: it seeks to the cursor's byte offset and reads bounded
 * chunks until `limit` events or the byte caps are reached. A trailing partial JSONL line is left
 * for the next call; the returned cursor points at its first byte so it is not consumed early.
 *
 * Cursors are opaque base64url JSON bound to the task id, the file's device/inode identity and the
 * next byte position. A malformed, cross-task or stale cursor (file replaced/truncated past the
 * position) is refused explicitly. This module performs no process control and no model calls.
 */
import {createHash} from 'node:crypto';
import {closeSync, openSync, readSync, statSync} from 'node:fs';
import {scrub, scrubText, truncate} from './evidence.js';

export const EVENT_LIMITS = {
  defaultLimit: 25,
  maxLimit: 100,
  chunkBytes: 64 * 1024,
  maxScannedBytes: 1024 * 1024,
  maxLineBytes: 256 * 1024,
  maxReturnedBytes: 192 * 1024,
} as const;

export interface EventPage {
  taskId: string;
  events: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
  partialLine: boolean;
  pendingBytes: number;
  source: 'live' | 'persisted-history';
  runtimeAttached: boolean;
  returned: number;
  scannedBytes: number;
  limits: {limit: number; maxLimit: number; maxScannedBytes: number; maxReturnedBytes: number};
  note: string;
}

export type EventsErrorCode = 'invalid_cursor' | 'event_log_invalid' | 'event_log_too_large';

export class EventsError extends Error {
  constructor(message: string, readonly code: EventsErrorCode) {
    super(message);
    this.name = 'EventsError';
  }
}

interface CursorPayload {
  v: 1;
  taskId: string;
  offset: number;
  identity: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CursorPayload {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new EventsError('cursor is not a valid opaque bridge event cursor', 'invalid_cursor');
  }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { throw new EventsError('cursor payload is not valid JSON', 'invalid_cursor'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EventsError('cursor payload is not an object', 'invalid_cursor');
  const value = raw as Record<string, unknown>;
  if (value['v'] !== 1 || typeof value['taskId'] !== 'string' || typeof value['offset'] !== 'number'
      || !Number.isSafeInteger(value['offset']) || value['offset'] < 0
      || typeof value['identity'] !== 'string' || value['identity'].length > 100) {
    throw new EventsError('cursor payload has an unsupported shape or version', 'invalid_cursor');
  }
  return {v: 1, taskId: value['taskId'], offset: value['offset'], identity: value['identity']};
}

export function validateEventLimit(limit: unknown): number {
  if (limit === undefined) return EVENT_LIMITS.defaultLimit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > EVENT_LIMITS.maxLimit) {
    throw new EventsError(`limit must be an integer from 1 to ${EVENT_LIMITS.maxLimit}`, 'event_log_invalid');
  }
  return limit;
}

interface FileIdentity {
  identity: string;
  size: number;
}

function fileIdentity(file: string): FileIdentity {
  try {
    const info = statSync(file);
    if (!info.isFile()) throw new EventsError('event log is not a regular file', 'event_log_invalid');
    return {identity: `${info.dev}:${info.ino}`, size: info.size};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {identity: 'absent', size: 0};
    if (error instanceof EventsError) throw error;
    throw new EventsError(`event log cannot be inspected: ${(error as Error).message}`, 'event_log_invalid');
  }
}

function malformed(offset: number, message: string): Record<string, unknown> {
  return {
    kind: 'bridge/malformed-event',
    offset,
    error: truncate(scrubText(message), 500).text,
  };
}

/**
 * Read one bounded page. `file` may be null for a persisted task with no event log yet; that is an
 * empty page, not an error.
 */
export function readEventPage(input: {
  file: string | null;
  taskId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
  source: 'live' | 'persisted-history';
  runtimeAttached: boolean;
}): EventPage {
  const limit = validateEventLimit(input.limit);
  const file = input.file;
  const identity = file === null ? {identity: 'absent', size: 0} : fileIdentity(file);
  let offset = 0;
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    if (cursor.taskId !== input.taskId) {
      throw new EventsError('cursor belongs to a different task; cross-task cursors are refused', 'invalid_cursor');
    }
    if (cursor.identity !== identity.identity) {
      throw new EventsError('cursor is stale: the event log identity changed (replaced or rotated)', 'invalid_cursor');
    }
    if (cursor.offset > identity.size) {
      throw new EventsError('cursor is stale: its byte offset is beyond the current event log', 'invalid_cursor');
    }
    offset = cursor.offset;
  }
  const base: EventPage = {
    taskId: input.taskId,
    events: [],
    nextCursor: null,
    hasMore: false,
    partialLine: false,
    pendingBytes: 0,
    source: input.source,
    runtimeAttached: input.runtimeAttached,
    returned: 0,
    scannedBytes: 0,
    limits: {
      limit, maxLimit: EVENT_LIMITS.maxLimit,
      maxScannedBytes: EVENT_LIMITS.maxScannedBytes, maxReturnedBytes: EVENT_LIMITS.maxReturnedBytes,
    },
    note: 'Bounded page over the recorded event log. Polling is read-only: it never probes or controls a recorded PID, starts no runtime and makes no model request.',
  };
  if (file === null || identity.size === 0 || offset === identity.size) {
    if (input.cursor !== undefined && offset === identity.size && identity.size > 0) {
      return {
        ...base,
        nextCursor: encodeCursor({v: 1, taskId: input.taskId, offset, identity: identity.identity}),
      };
    }
    return base;
  }

  let descriptor: number;
  try { descriptor = openSync(file, 'r'); } catch (error) {
    throw new EventsError(`event log cannot be opened: ${(error as Error).message}`, 'event_log_invalid');
  }
  let position = offset;
  let consumed = offset;
  let bufferStart = offset;
  let scanned = 0;
  let carry = Buffer.alloc(0);
  let returnedBytes = 0;
  let stopped = false;
  const events: unknown[] = [];
  try {
    while (!stopped && position < identity.size && scanned < EVENT_LIMITS.maxScannedBytes) {
      const room = Math.min(EVENT_LIMITS.chunkBytes, identity.size - position, EVENT_LIMITS.maxScannedBytes - scanned);
      if (room <= 0) break;
      const chunk = Buffer.alloc(room);
      let read: number;
      try { read = readSync(descriptor, chunk, 0, room, position); } catch (error) {
        throw new EventsError(`event log cannot be read: ${(error as Error).message}`, 'event_log_invalid');
      }
      if (read <= 0) break;
      scanned += read;
      const buffer = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      let start = 0;
      while (start < buffer.length) {
        const newline = buffer.indexOf(10, start);
        if (newline < 0) break;
        const lineStart = bufferStart + start;
        const line = buffer.subarray(start, newline);
        start = newline + 1;
        if (line.length === 0) { consumed = bufferStart + start; continue; }
        if (events.length >= limit) {
          // The next complete line was not consumed; the cursor points at its first byte.
          consumed = lineStart;
          stopped = true;
          break;
        }
        let parsed: unknown;
        if (line.length > EVENT_LIMITS.maxLineBytes) {
          parsed = malformed(lineStart, `event line is ${line.length} bytes, above the ${EVENT_LIMITS.maxLineBytes}-byte limit`);
        } else {
          try { parsed = scrub(JSON.parse(line.toString('utf8')), 4_000); }
          catch (error) { parsed = malformed(lineStart, `malformed JSONL event: ${(error as Error).message}`); }
        }
        let size = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
        if (size > EVENT_LIMITS.maxReturnedBytes) {
          // A single valid event can be below maxLineBytes but above the page byte budget. Replace
          // it with a bounded, explicit placeholder and CONSUME the line so paging advances; an
          // empty hasMore=true page with nextCursor=null would be a non-advancing loop.
          parsed = {
            kind: 'bridge/oversized-event',
            offset: lineStart,
            bytes: line.length,
            sha256: createHash('sha256').update(line).digest('hex'),
            note: `event serialized size ${size} exceeds the ${EVENT_LIMITS.maxReturnedBytes}-byte page budget; bytes are not returned`,
          };
          size = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
          if (size > EVENT_LIMITS.maxReturnedBytes) {
            throw new EventsError('oversized-event placeholder exceeds the page byte budget', 'event_log_too_large');
          }
          if (returnedBytes + size > EVENT_LIMITS.maxReturnedBytes && events.length > 0) {
            // Return the current page; the next cursor still points at this line, and the next page
            // will begin with the placeholder.
            consumed = lineStart;
            stopped = true;
            break;
          }
        } else if (returnedBytes + size > EVENT_LIMITS.maxReturnedBytes) {
          // Do not consume this line; a later page with the same cursor can return it.
          consumed = lineStart;
          stopped = true;
          break;
        }
        returnedBytes += size;
        events.push(parsed);
        consumed = bufferStart + start;
      }
      if (stopped) break;
      bufferStart += start;
      carry = Buffer.from(buffer.subarray(start));
      position += read;
      if (carry.length > EVENT_LIMITS.maxLineBytes) {
        throw new EventsError(
          `event log contains an unterminated line above ${EVENT_LIMITS.maxLineBytes} bytes at or after byte ${consumed}`,
          'event_log_too_large',
        );
      }
    }
    // Bytes after `consumed` exist either as a complete unread line, a partial final line, or a
    // chunk boundary we did not attempt (scan cap). The same expression covers all three.
    const trailing = identity.size > consumed;
    return {
      ...base,
      events,
      returned: events.length,
      scannedBytes: scanned,
      hasMore: trailing && (stopped || events.length >= limit || carry.length === 0),
      partialLine: carry.length > 0,
      pendingBytes: carry.length,
      nextCursor: consumed > 0
        ? encodeCursor({v: 1, taskId: input.taskId, offset: consumed, identity: identity.identity})
        : null,
    };
  } finally {
    try { closeSync(descriptor); } catch { /* best effort */ }
  }
}
