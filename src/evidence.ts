/**
 * Evidence hygiene: secret scrubbing, reasoning stripping, truncation with explicit markers,
 * and workspace file snapshots used to report OBSERVED file changes.
 */
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';

/**
 * Keys dropped before any SDK payload is persisted or returned.
 * `reasoning`/`thinkingSignature`/`replayState`/`stream` carry the model's internal
 * reasoning; they must never reach a result payload or the durable event log.
 */
export const DROP_KEYS = new Set([
  'reasoning', 'reasoning_content', 'reasoningContent', 'thinking', 'thinkingSignature',
  'replayState', 'stream', 'blocks',
]);

/**
 * Content-block types dropped from `assistant/message.data.message.content`.
 * Confirmed on the live runtime: the assistant message carries `{type:'reasoning', text}` blocks
 * plus `source.replayState`. Both are model-internal and must never be persisted or returned.
 */
export const DROP_BLOCK_TYPES = new Set(['reasoning', 'thinking', 'redacted_thinking']);

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /"(?:api[_-]?key|apikey|token|password|secret|authorization)"\s*:\s*"[^"]{6,}"/gi,
  /\b(?:api[_-]?key|apikey|password|secret|authorization)\s*[:=]\s*[^\s"'`,;}]{8,}/gi,
];

export function scrubText(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

export function truncate(input: string, max: number): {text: string; truncated: boolean} {
  if (input.length <= max) return {text: input, truncated: false};
  return {text: `${input.slice(0, max)}\n... [TRUNCATED: ${input.length - max} of ${input.length} chars omitted]`, truncated: true};
}

/**
 * Recursively scrubs an SDK payload: drops reasoning-bearing keys, redacts secret shapes,
 * truncates long strings. Depth- and width-capped so a hostile payload cannot blow up memory.
 */
export function scrub(value: unknown, maxString = 1_500, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED: depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(scrubText(value), maxString).text;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .filter((item) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return true;
        const type = (item as {type?: unknown}).type;
        return !(typeof type === 'string' && DROP_BLOCK_TYPES.has(type));
      })
      .slice(0, 60)
      .map((item) => scrub(item, maxString, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.has(key)) continue;
      if (++count > 80) { out['...'] = '[TRUNCATED: keys]'; break; }
      out[key] = scrub(item, maxString, depth + 1);
    }
    return out;
  }
  return String(value);
}

/* ------------------------------------------------------------------ file snapshots */

export const SNAPSHOT_LIMITS = {
  maxFiles: 2_000,
  maxHashBytes: 32 * 1024 * 1024,
  maxHashFileBytes: 512 * 1024,
} as const;

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);

export interface FileEntry {
  size: number;
  mtimeMs: number;
  sha256: string | null;
}

export interface WorkspaceSnapshot {
  root: string;
  takenAt: string;
  files: Record<string, FileEntry>;
  fileCount: number;
  truncated: boolean;
  hashedBytes: number;
  errors: string[];
}

export function snapshotWorkspace(root: string): WorkspaceSnapshot {
  const files: Record<string, FileEntry> = {};
  const errors: string[] = [];
  let truncated = false;
  let hashedBytes = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      errors.push(`${dir}: ${(error as Error).message}`);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (Object.keys(files).length >= SNAPSHOT_LIMITS.maxFiles) { truncated = true; break; }
      let stat;
      try {
        stat = statSync(full);
      } catch (error) {
        errors.push(`${rel}: ${(error as Error).message}`);
        continue;
      }
      let sha256: string | null = null;
      if (stat.size <= SNAPSHOT_LIMITS.maxHashFileBytes && hashedBytes + stat.size <= SNAPSHOT_LIMITS.maxHashBytes) {
        try {
          sha256 = createHash('sha256').update(readFileSync(full)).digest('hex');
          hashedBytes += stat.size;
        } catch { sha256 = null; }
      } else {
        truncated = true;
      }
      files[rel] = {size: stat.size, mtimeMs: Math.round(stat.mtimeMs), sha256};
    }
    if (truncated) break;
  }
  return {
    root, takenAt: new Date().toISOString(), files,
    fileCount: Object.keys(files).length, truncated, hashedBytes, errors,
  };
}

export interface FileChanges {
  added: string[];
  modified: string[];
  removed: string[];
  unchangedCount: number;
  before: WorkspaceSnapshot;
  after: WorkspaceSnapshot;
}

export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): FileChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  let unchangedCount = 0;
  for (const [rel, entry] of Object.entries(after.files)) {
    const prev = before.files[rel];
    if (!prev) { added.push(rel); continue; }
    if (prev.sha256 !== null && entry.sha256 !== null) {
      if (prev.sha256 !== entry.sha256) modified.push(rel); else unchangedCount++;
    } else if (prev.size !== entry.size || prev.mtimeMs !== entry.mtimeMs) {
      modified.push(rel);
    } else {
      unchangedCount++;
    }
  }
  for (const rel of Object.keys(before.files)) if (!after.files[rel]) removed.push(rel);
  added.sort(); modified.sort(); removed.sort();
  return {added, modified, removed, unchangedCount, before, after};
}
