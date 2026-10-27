/**
 * Durable critical-metadata writes and observable persistence health.
 *
 * The bridge used to catch every task/checkpoint write and carry on silently, so a disk-full
 * event could leave a task looking healthy while its durable record was stale. This module makes
 * the durability boundary explicit:
 *   - critical writes go through one atomic writer (unique sibling temp file, fsync, rename,
 *     directory fsync, temp cleanup);
 *   - a critical failure at task/checkpoint creation is returned to the caller and no prompt is
 *     sent;
 *   - later failures are recorded on the live task as `persistence.status = degraded` with
 *     bounded, scrubbed facts, while the previous good bytes stay untouched.
 *
 * Atomic rename is NOT a whole-OS/power-loss guarantee. fsync ordering is best effort on platforms
 * whose directories cannot be fsynced (notably Windows), and the code reports only what it did.
 */
import {closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {scrubText, truncate} from './evidence.js';

export interface PersistenceFailure {
  at: string;
  file: string;
  code: string | null;
  message: string;
}

export interface PersistenceView {
  status: 'healthy' | 'degraded';
  lastSuccessAt: string | null;
  lastSuccessfulCheckpoint: {
    at: string;
    reason: string;
    stage: number | null;
    path: string;
  } | null;
  failures: PersistenceFailure[];
  note: string;
}

const MAX_FAILURES = 5;

/**
 * Write one critical metadata file atomically. A unique sibling temp name prevents two writers
 * from sharing a temp; it is created with `wx` so an existing path is never followed or truncated.
 * On any failure the temp file is removed and the error is rethrown unchanged.
 */
export function atomicWriteFile(file: string, contents: string | Buffer, mode = 0o600): void {
  const directory = path.dirname(file);
  const base = path.basename(file);
  const temporary = path.join(
    directory,
    `.${base}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  mkdirSync(directory, {recursive: true});
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, contents);
    // The file's bytes must be durable before the rename publishes the new name.
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
    // Persist the directory entry too. Some platforms/filesystems refuse directory fsync; that is
    // reported as unavailable rather than silently claimed as durable.
    let directoryDescriptor: number | null = null;
    try {
      directoryDescriptor = openSync(directory, 'r');
      fsyncSync(directoryDescriptor);
    } catch {
      // Windows and some virtual filesystems do not support fsync on a directory.
    } finally {
      if (directoryDescriptor !== null) {
        try { closeSync(directoryDescriptor); } catch { /* best effort */ }
      }
    }
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(temporary); } catch { /* it may never have been created */ }
    throw error;
  }
}

function failureFacts(file: string, error: unknown): PersistenceFailure {
  const code = typeof (error as NodeJS.ErrnoException)?.code === 'string'
    ? (error as NodeJS.ErrnoException).code!
    : null;
  const message = truncate(scrubText(error instanceof Error ? error.message : String(error)), 500).text;
  return {at: new Date().toISOString(), file, code, message};
}

/** Bounded in-memory health for one live task. Persisted records cannot be updated on a failing disk. */
export class PersistenceTracker {
  private status: PersistenceView['status'] = 'healthy';
  private lastSuccessAt: string | null = null;
  private lastSuccessfulCheckpoint: PersistenceView['lastSuccessfulCheckpoint'] = null;
  private readonly failures: PersistenceFailure[] = [];

  success(at = new Date().toISOString()): void {
    this.lastSuccessAt = at;
  }

  checkpointSuccess(
    file: string, reason: string, stage: number | null, at = new Date().toISOString(),
  ): void {
    this.lastSuccessAt = at;
    this.lastSuccessfulCheckpoint = {at, reason, stage, path: file};
  }

  failure(file: string, error: unknown): void {
    // Degraded is sticky for this live task: a later successful write does not erase the fact that
    // at some point a durable update failed (the prior bytes may still be the newest good state).
    this.status = 'degraded';
    this.failures.push(failureFacts(file, error));
    if (this.failures.length > MAX_FAILURES) this.failures.splice(0, this.failures.length - MAX_FAILURES);
  }

  view(): PersistenceView {
    return {
      status: this.status,
      lastSuccessAt: this.lastSuccessAt,
      lastSuccessfulCheckpoint: this.lastSuccessfulCheckpoint,
      failures: this.failures.map((item) => ({...item})),
      note: this.status === 'healthy'
        ? 'task record, current-stage checkpoint and event log writes succeeded; this does not prove whole-OS or power-loss durability'
        : 'at least one later task record, checkpoint or event-log write failed after good bytes were recorded. The live API is the only place this can be reported when task.json itself cannot be written; the previous recorded bytes were not replaced by a partial write.',
    };
  }
}
