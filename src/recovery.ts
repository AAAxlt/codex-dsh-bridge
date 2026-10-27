/**
 * Checkpoint recovery: a NEW task/runtime/session built from a persisted task's checkpoint.
 *
 * This module is deliberately read-only with respect to the old task. It loads exactly two files
 * (task.json and checkpoint.json) through the history module's anchored, symlink-refusing readers,
 * hashes their bytes, and builds a deterministic plan token bound to the source record/checkpoint
 * and to the current workspace state. It never probes, signals or reattaches the recorded PID and
 * it never executes the recorded verification argv.
 *
 * The only files this module writes are its own recovery claim files under
 * DATA_ROOT/recovery/claims, created with an atomic no-replace link. A claim is the durable
 * idempotency record for one plan token: after a bridge restart, the same request returns the
 * same new task instead of starting a second runtime.
 *
 * Native SDK `session/resume` is NOT used here and is not claimed. See docs/SDK-RESUME-ASSESSMENT.md.
 */
import {createHash, randomBytes} from 'node:crypto';
import {
  closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import {DATA_ROOT, isInside} from './config.js';
import {
  HistoryError, isSafeHistoryTaskId, persistedTaskDirectory, readPersistedTaskFile,
} from './history.js';
import {scrubText, truncate} from './evidence.js';

export const RECOVERY_LIMITS = {
  taskRecordBytes: 8 * 1024 * 1024,
  checkpointBytes: 2 * 1024 * 1024,
  claimBytes: 64 * 1024,
  instructionsChars: 40_000,
  protectedFiles: 64,
  stages: 100,
  errors: 20,
  warnings: 8,
  planStringChars: 1_024,
  workspaceFiles: 4_000,
  // Streaming read block for content hashing. A single file is bounded by workspaceTotalBytes,
  // not by this block size, so a >2 MiB file is hashed rather than silently skipped.
  workspaceFileBytes: 2 * 1024 * 1024,
  workspaceTotalBytes: 64 * 1024 * 1024,
} as const;

export class RecoveryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'RecoveryError';
  }
}

function fail(message: string, code: string): never {
  const bounded = truncate(scrubText(message), 1_500).text;
  throw new RecoveryError(bounded, code);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a JSON object`, 'recovery_invalid');
  }
  return value as Record<string, unknown>;
}

function textOf(value: unknown, label: string, max: number, optional = false): string | null {
  if (value === undefined || value === null) {
    if (optional) return null;
    fail(`${label} is missing`, 'recovery_invalid');
  }
  if (typeof value !== 'string' || value.includes('\0') || value.length > max) {
    fail(`${label} must be a string of at most ${max} characters`, 'recovery_invalid');
  }
  return scrubText(value);
}

function stringList(value: unknown, label: string, maxItems: number, maxChars: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    fail(`${label} must be an array of at most ${maxItems} strings`, 'recovery_invalid');
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.includes('\0') || item.length > maxChars) {
      fail(`${label}[${index}] must be a string of at most ${maxChars} characters`, 'recovery_invalid');
    }
    return scrubText(item);
  });
}

function sha256Hex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    fail(`${label} must be a lowercase SHA-256 hex digest`, 'recovery_invalid');
  }
  return value;
}

function positiveInt(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    fail(`${label} must be an integer from 1 to ${max}`, 'recovery_invalid');
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function canonicalOrResolve(value: string): string {
  try { return realpathSync.native(path.resolve(value)); } catch { return path.resolve(value); }
}

const TASK_STATES = new Set([
  'accepted', 'starting', 'running', 'awaiting_review',
  'blocked', 'incomplete', 'failed', 'cancelled', 'timed_out',
]);
const LIVE_STATES = new Set(['accepted', 'starting', 'running']);
/**
 * States that are valid for the checkpoint of a source whose record is still live. A pre-prompt
 * checkpoint is `accepted`/`starting`/`running`; a checkpoint from a stage that finished but was
 * never delivered can be `awaiting_review`/`blocked`/`incomplete`. Terminal failures stay refusals.
 */
const NONFINAL_CHECKPOINT_STATES = new Set([
  'accepted', 'starting', 'running', 'awaiting_review', 'blocked', 'incomplete',
]);
const VERIFICATION_STATUSES = new Set([
  'not-configured', 'pending', 'not-run', 'passed', 'failed', 'timed-out', 'errored', 'cancelled-during-run',
]);
const EXECUTION_PROFILES = new Set(['native', 'ptc']);

/* ------------------------------------------------------------------ source loading */

export interface RecoveryProtectedFile {
  path: string;
  realPath: string;
  sha256: string;
}

export interface RecoveryVerificationView {
  configured: boolean;
  status: string;
  attempts: number;
  exitCode: number | null;
  timedOut: boolean | null;
  notRunReason: string | null;
  protectedVerificationFiles: Array<{path: string; sha256: string}>;
}

export interface RecoverySource {
  taskId: string;
  sessionId: string;
  workspace: string;
  state: string;
  goal: string;
  acceptance: string | null;
  constraints: string[];
  executionProfile: 'native' | 'ptc' | null;
  executionBaselineSha256: string | null;
  verificationCommand: string[] | null;
  protectedVerificationFiles: RecoveryProtectedFile[];
  recordSha256: string;
  checkpointSha256: string;
  recordBytes: number;
  checkpointBytes: number;
  stage: number;
  stageCount: number;
  stageState: string;
  checkpointReason: string | null;
  verification: RecoveryVerificationView;
  changes: {added: number; modified: number; removed: number} | null;
  checkpointErrors: string[];
  stageErrors: string[];
  recordUpdatedAt: string | null;
}

function parseVerification(raw: unknown, configured: boolean, pins: RecoveryProtectedFile[]): RecoveryVerificationView {
  const base: RecoveryVerificationView = {
    configured,
    status: configured ? 'unknown' : 'not-configured',
    attempts: 0,
    exitCode: null,
    timedOut: null,
    notRunReason: null,
    protectedVerificationFiles: pins.map((file) => ({path: file.path, sha256: file.sha256})),
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const value = raw as Record<string, unknown>;
  const status = typeof value['status'] === 'string' && VERIFICATION_STATUSES.has(value['status'])
    ? value['status'] : base.status;
  const attempts = typeof value['attempts'] === 'number' && Number.isSafeInteger(value['attempts']) && value['attempts'] >= 0
    ? value['attempts'] : 0;
  const run = value['lastRun'] && typeof value['lastRun'] === 'object' && !Array.isArray(value['lastRun'])
    ? value['lastRun'] as Record<string, unknown> : null;
  const exitCode = typeof run?.['exitCode'] === 'number' && Number.isSafeInteger(run['exitCode'])
    ? run['exitCode'] : null;
  const timedOut = typeof run?.['timedOut'] === 'boolean' ? run['timedOut'] : null;
  const notRunReason = typeof value['notRunReason'] === 'string'
    ? truncate(scrubText(value['notRunReason']), 500).text : null;
  return {...base, status, attempts, exitCode, timedOut, notRunReason};
}

function parsePins(raw: unknown): RecoveryProtectedFile[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > RECOVERY_LIMITS.protectedFiles) {
    fail(`protectedVerificationFiles must contain at most ${RECOVERY_LIMITS.protectedFiles} pinned files`, 'recovery_invalid');
  }
  return raw.map((item, index) => {
    const value = object(item, `protectedVerificationFiles[${index}]`);
    const filePath = textOf(value['path'], `protectedVerificationFiles[${index}].path`, 4_096) as string;
    const realPath = textOf(value['realPath'], `protectedVerificationFiles[${index}].realPath`, 4_096) as string;
    if (!path.isAbsolute(filePath) || !path.isAbsolute(realPath)) {
      fail(`protectedVerificationFiles[${index}] must record absolute paths`, 'recovery_invalid');
    }
    return {path: filePath, realPath, sha256: sha256Hex(value['sha256'], `protectedVerificationFiles[${index}].sha256`)};
  });
}

function parseRawRecord(taskId: string, raw: unknown): Record<string, unknown> {
  const record = object(raw, 'recorded task.json');
  if (record['taskId'] !== taskId) fail('recorded taskId does not match its directory', 'recovery_invalid');
  if (record['sessionId'] !== `session-${taskId}`) fail('recorded sessionId does not match its task identity', 'recovery_invalid');
  if (typeof record['state'] !== 'string' || !TASK_STATES.has(record['state'])) {
    fail('recorded task state is unknown', 'recovery_invalid');
  }
  if (typeof record['workspace'] !== 'string' || record['workspace'].length === 0 ||
      record['workspace'].length > 4_096 || record['workspace'].includes('\0')) {
    fail('recorded workspace is invalid', 'recovery_invalid');
  }
  const stages = record['stages'];
  if (!Array.isArray(stages) || stages.length === 0 || stages.length > RECOVERY_LIMITS.stages) {
    fail('recorded stage list is invalid', 'recovery_invalid');
  }
  stages.forEach((stage, index) => {
    const value = object(stage, `recorded stage ${index + 1}`);
    if (value['index'] !== index + 1) fail(`recorded stage ${index + 1} has a mismatched index`, 'recovery_invalid');
    if (typeof value['state'] !== 'string' || !TASK_STATES.has(value['state'])) {
      fail(`recorded stage ${index + 1} has an unknown state`, 'recovery_invalid');
    }
  });
  return record;
}

/**
 * Load the exact persisted source. Read-only: two anchored reads plus hashing. A caller workspace
 * that does not canonically equal the recorded workspace is refused before any plan is produced.
 */
export function loadRecoverySource(taskId: unknown, callerWorkspace: string): RecoverySource {
  if (!isSafeHistoryTaskId(taskId)) {
    fail('taskId must be a bridge-generated dsh-<14 digits>-<alphanumeric> id', 'recovery_not_found');
  }
  if (typeof callerWorkspace !== 'string' || callerWorkspace.trim().length === 0 || !path.isAbsolute(callerWorkspace)) {
    fail('workspace must be a non-empty absolute path', 'recovery_workspace_mismatch');
  }
  try {
    persistedTaskDirectory(taskId);
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_unsafe') {
      fail(`persisted tasks root is unsafe: ${error.message}`, 'recovery_unsafe');
    }
    fail(`no persisted task exists for taskId ${taskId}`, 'recovery_not_found');
  }
  let recordBytes: Buffer;
  let checkpointBytes: Buffer;
  try {
    recordBytes = readPersistedTaskFile(taskId, 'task.json', RECOVERY_LIMITS.taskRecordBytes, 'recorded task.json');
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_unsafe') {
      fail(`recorded task.json is unsafe: ${error.message}`, 'recovery_unsafe');
    }
    fail(`recorded task.json cannot be read: ${(error as Error).message}`, 'recovery_invalid');
  }
  try {
    checkpointBytes = readPersistedTaskFile(taskId, 'checkpoint.json', RECOVERY_LIMITS.checkpointBytes, 'recorded checkpoint.json');
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_unsafe') {
      fail(`recorded checkpoint.json is unsafe: ${error.message}`, 'recovery_unsafe');
    }
    if (error instanceof HistoryError && error.code === 'history_missing') {
      fail(`task ${taskId} has no checkpoint.json; checkpoint recovery is refused (a missing checkpoint is not reconstructed)`, 'recovery_checkpoint_missing');
    }
    fail(`recorded checkpoint.json cannot be read: ${(error as Error).message}`, 'recovery_checkpoint_invalid');
  }

  let parsedRecord: unknown;
  let checkpoint: unknown;
  try { parsedRecord = JSON.parse(recordBytes.toString('utf8')) as unknown; }
  catch { fail('recorded task.json is not valid JSON', 'recovery_invalid'); }
  try { checkpoint = JSON.parse(checkpointBytes.toString('utf8')) as unknown; }
  catch { fail('recorded checkpoint.json is not valid JSON', 'recovery_checkpoint_invalid'); }

  const record = parseRawRecord(taskId, parsedRecord);
  const checkpointObject = object(checkpoint, 'recorded checkpoint.json');
  if (checkpointObject['schema'] !== 'codex-dsh-bridge/checkpoint@1') {
    fail('recorded checkpoint schema is not codex-dsh-bridge/checkpoint@1', 'recovery_checkpoint_invalid');
  }
  if (checkpointObject['taskId'] !== taskId) fail('checkpoint taskId does not match the task directory', 'recovery_checkpoint_mismatch');
  if (checkpointObject['sessionId'] !== record['sessionId']) fail('checkpoint sessionId does not match the task record', 'recovery_checkpoint_mismatch');
  if (checkpointObject['workspace'] !== record['workspace']) fail('checkpoint workspace does not match the task record', 'recovery_checkpoint_mismatch');

  const stages = record['stages'] as unknown[];
  const stageNumber = positiveInt(checkpointObject['stage'], 'checkpoint.stage', RECOVERY_LIMITS.stages);
  if (stageNumber !== stages.length) {
    fail('checkpoint is stale or mismatched: it does not describe the latest recorded stage', 'recovery_checkpoint_mismatch');
  }
  const stage = stages[stageNumber - 1] as Record<string, unknown>;
  const state = record['state'] as string;
  const checkpointStageState = checkpointObject['stageState'];
  const checkpointTaskState = checkpointObject['taskState'];
  if (LIVE_STATES.has(state)) {
    // An abruptly stopped source can legitimately pair a live record with the checkpoint written
    // before its first prompt (or between the record and checkpoint updates). Both sides must be
    // valid nonfinal states for the same source/session/latest stage; the caller still has to pass
    // allowUnsettledSource=true, so this is not an implicit trust of an unknown stop.
    if (typeof checkpointStageState !== 'string' || !NONFINAL_CHECKPOINT_STATES.has(checkpointStageState)) {
      fail('checkpoint stageState is not a nonfinal state for an unsettled source', 'recovery_checkpoint_mismatch');
    }
    if (typeof checkpointTaskState !== 'string' || !NONFINAL_CHECKPOINT_STATES.has(checkpointTaskState)) {
      fail('checkpoint taskState is not a nonfinal state for an unsettled source', 'recovery_checkpoint_mismatch');
    }
  } else {
    if (checkpointStageState !== stage['state']) {
      fail('checkpoint stageState does not match the recorded stage', 'recovery_checkpoint_mismatch');
    }
    if (checkpointTaskState !== record['state']) {
      fail('checkpoint taskState does not match the recorded task state', 'recovery_checkpoint_mismatch');
    }
  }

  const recordWorkspace = record['workspace'] as string;
  let recordedReal: string;
  try { recordedReal = realpathSync.native(recordWorkspace); }
  catch { fail('the recorded workspace no longer exists, so current bytes cannot be bound to the plan', 'recovery_workspace_mismatch'); }
  let callerReal: string;
  try { callerReal = realpathSync.native(callerWorkspace); }
  catch { fail('the caller workspace does not exist', 'recovery_workspace_mismatch'); }
  if (!statSync(callerReal).isDirectory()) fail('the caller workspace is not a directory', 'recovery_workspace_mismatch');
  if (!samePath(recordedReal, callerReal)) {
    fail('the caller workspace does not match the workspace recorded for this task', 'recovery_workspace_mismatch');
  }

  const goal = textOf(record['goal'], 'recorded goal', 20_000) as string;
  if (goal.trim().length === 0) fail('recorded goal is empty', 'recovery_invalid');
  const acceptance = textOf(record['acceptance'], 'recorded acceptance', 10_000, true);
  const constraints = stringList(record['constraints'], 'recorded constraints', 64, 2_000);
  const executionProfileRaw = record['executionProfile'];
  if (executionProfileRaw !== undefined && executionProfileRaw !== null &&
      (typeof executionProfileRaw !== 'string' || !EXECUTION_PROFILES.has(executionProfileRaw))) {
    fail('recorded executionProfile is invalid', 'recovery_invalid');
  }
  const executionProfile = typeof executionProfileRaw === 'string' ? executionProfileRaw as 'native' | 'ptc' : null;
  const baselineRaw = record['executionBaselineSha256'];
  const executionBaselineSha256 = baselineRaw === undefined || baselineRaw === null
    ? null : sha256Hex(baselineRaw, 'executionBaselineSha256');

  let verificationCommand: string[] | null = null;
  if (record['verificationCommand'] !== undefined && record['verificationCommand'] !== null) {
    const rawCommand = record['verificationCommand'];
    if (!Array.isArray(rawCommand) || rawCommand.length === 0 || rawCommand.length > 32) {
      fail('recorded verificationCommand is invalid', 'recovery_invalid');
    }
    verificationCommand = rawCommand.map((item, index) => {
      if (typeof item !== 'string' || item.length === 0 || item.length > 512 || item.includes('\0')) {
        fail(`recorded verificationCommand[${index}] is invalid`, 'recovery_invalid');
      }
      return item;
    });
  }
  const pins = parsePins(record['protectedVerificationFiles']);
  const checkpointVerification = checkpointObject['verification'];
  const verification = parseVerification(checkpointVerification, verificationCommand !== null, pins);

  let changes: RecoverySource['changes'] = null;
  const changesRaw = checkpointObject['changes'];
  if (changesRaw && typeof changesRaw === 'object' && !Array.isArray(changesRaw)) {
    const counts = (changesRaw as Record<string, unknown>)['counts'];
    if (counts && typeof counts === 'object' && !Array.isArray(counts)) {
      const c = counts as Record<string, unknown>;
      const read = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
      const added = read(c['added']);
      const modified = read(c['modified']);
      const removed = read(c['removed']);
      if (added !== null && modified !== null && removed !== null) changes = {added, modified, removed};
    }
  }

  const recordUpdatedAt = typeof record['updatedAt'] === 'string' && record['updatedAt'].length <= 64
    ? record['updatedAt'] : null;

  return {
    taskId: taskId as string,
    sessionId: record['sessionId'] as string,
    workspace: callerReal,
    state,
    goal: goal.trim(),
    acceptance: acceptance === null ? null : acceptance.trim(),
    constraints,
    executionProfile,
    executionBaselineSha256,
    verificationCommand,
    protectedVerificationFiles: pins,
    recordSha256: createHash('sha256').update(recordBytes).digest('hex'),
    checkpointSha256: createHash('sha256').update(checkpointBytes).digest('hex'),
    recordBytes: recordBytes.length,
    checkpointBytes: checkpointBytes.length,
    stage: stageNumber,
    stageCount: stages.length,
    stageState: stage['state'] as string,
    checkpointReason: textOf(checkpointObject['reason'], 'checkpoint.reason', 200, true),
    verification,
    changes,
    checkpointErrors: stringList(checkpointObject['errors'], 'checkpoint.errors', RECOVERY_LIMITS.errors, 500),
    stageErrors: stringList(stage['errors'], 'recorded stage.errors', RECOVERY_LIMITS.errors, 500),
    recordUpdatedAt,
  };
}

/* ------------------------------------------------------------------ workspace fingerprint */

function skipWorkspacePath(full: string, skippedRoots: readonly string[]): boolean {
  return skippedRoots.some((root) => full !== root && isInside(root, full));
}

/**
 * Content-hash one regular file with a bounded streaming read. The whole file is covered (up to
 * the workspace total budget); an unreadable, replaced, resized or concurrently modified file is
 * an explicit refusal instead of a null digest.
 */
function hashWorkspaceFile(
  full: string,
  rel: string,
  initial: {dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number},
): {size: number; sha256: string} {
  let fd: number;
  try { fd = openSync(full, 'r'); }
  catch { fail(`workspace file ${rel} cannot be opened for content hashing`, 'recovery_workspace_unreadable'); }
  try {
    let opened;
    try { opened = fstatSync(fd); }
    catch { fail(`workspace file ${rel} cannot be inspected while hashing`, 'recovery_workspace_unreadable'); }
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino
        || opened.size !== initial.size || opened.mtimeMs !== initial.mtimeMs || opened.ctimeMs !== initial.ctimeMs) {
      fail(`workspace file ${rel} changed before its bytes could be hashed`, 'recovery_workspace_unstable');
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(RECOVERY_LIMITS.workspaceFileBytes, Math.max(1, opened.size)));
    let readBytes = 0;
    for (;;) {
      let chunk: number;
      try { chunk = readSync(fd, buffer, 0, buffer.length, null); }
      catch { fail(`workspace file ${rel} cannot be read for content hashing`, 'recovery_workspace_unreadable'); }
      if (chunk === 0) break;
      readBytes += chunk;
      if (readBytes > opened.size) {
        fail(`workspace file ${rel} grew while its bytes were being hashed`, 'recovery_workspace_unstable');
      }
      digest.update(buffer.subarray(0, chunk));
    }
    if (readBytes !== opened.size) {
      fail(`workspace file ${rel} shrank while its bytes were being hashed`, 'recovery_workspace_unstable');
    }
    let finished;
    try { finished = fstatSync(fd); }
    catch { fail(`workspace file ${rel} cannot be inspected after hashing`, 'recovery_workspace_unreadable'); }
    if (finished.size !== opened.size || finished.mtimeMs !== opened.mtimeMs || finished.ctimeMs !== opened.ctimeMs) {
      fail(`workspace file ${rel} changed while its bytes were being hashed`, 'recovery_workspace_unstable');
    }
    let after;
    try { after = lstatSync(full); }
    catch { fail(`workspace file ${rel} disappeared while its bytes were being hashed`, 'recovery_workspace_unstable'); }
    if (!after.isFile() || after.dev !== initial.dev || after.ino !== initial.ino
        || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs) {
      fail(`workspace file ${rel} was replaced while its bytes were being hashed`, 'recovery_workspace_unstable');
    }
    return {size: readBytes, sha256: digest.digest('hex')};
  } finally {
    try { closeSync(fd); } catch { /* the bytes were already hashed or the failure reported above */ }
  }
}

/**
 * Deterministic content fingerprint of the admitted workspace. Coverage is all-or-nothing:
 * every included regular file is content-hashed, and an exceeded size/file-count/total budget,
 * an unreadable entry, an unsupported entry type or a file that changes during hashing refuses
 * the operation. There is no partial or null-digest fingerprint.
 *
 * Intentionally excluded subtrees: any `node_modules`/`.git`/`.hg`/`.svn` directory at any depth
 * (dependency and VCS state is not workspace source), and DATA_ROOT/tasks plus DATA_ROOT/recovery
 * (bridge-generated task evidence and recovery claims, so a recovery's own writes cannot
 * invalidate the plan). Symlinks are bound by their target string and are never followed.
 */
export function workspaceFingerprint(root: string): string {
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
    if (!statSync(realRoot).isDirectory()) fail('workspace is not a directory', 'recovery_workspace_mismatch');
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    fail('workspace cannot be resolved', 'recovery_workspace_mismatch');
  }
  const dataRoot = canonicalOrResolve(DATA_ROOT);
  const skippedRoots = [path.join(dataRoot, 'tasks'), path.join(dataRoot, 'recovery')]
    .map((item) => canonicalOrResolve(item));
  const entries: Array<{path: string; size: number; sha256: string}> = [];
  const stack: string[] = [realRoot];
  let hashedBytes = 0;
  const skipNames = new Set(['node_modules', '.git', '.hg', '.svn']);
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirents;
    try {
      dirents = readdirSync(dir, {withFileTypes: true}).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      fail('a workspace directory cannot be read for fingerprint coverage', 'recovery_workspace_unreadable');
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (skipNames.has(dirent.name) || skipWorkspacePath(full, skippedRoots)) continue;
      const rel = path.relative(realRoot, full).split(path.sep).join('/');
      if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
        fail('a workspace entry escaped the admitted root', 'recovery_workspace_unsupported');
      }
      let info;
      try { info = lstatSync(full); }
      catch { fail(`workspace entry ${rel} cannot be inspected`, 'recovery_workspace_unreadable'); }
      if (info.isSymbolicLink()) {
        if (entries.length >= RECOVERY_LIMITS.workspaceFiles) {
          fail(`workspace exceeds the ${RECOVERY_LIMITS.workspaceFiles}-file fingerprint limit`, 'recovery_workspace_too_many_files');
        }
        let target: string;
        try { target = readlinkSync(full); }
        catch { fail(`workspace symlink ${rel} cannot be read`, 'recovery_workspace_unreadable'); }
        entries.push({path: rel, size: Buffer.byteLength(target, 'utf8'), sha256: createHash('sha256').update(`symlink:${target}`).digest('hex')});
      } else if (info.isDirectory()) {
        stack.push(full);
      } else if (info.isFile()) {
        if (entries.length >= RECOVERY_LIMITS.workspaceFiles) {
          fail(`workspace exceeds the ${RECOVERY_LIMITS.workspaceFiles}-file fingerprint limit`, 'recovery_workspace_too_many_files');
        }
        if (info.size > RECOVERY_LIMITS.workspaceTotalBytes - hashedBytes) {
          fail(`workspace exceeds the ${RECOVERY_LIMITS.workspaceTotalBytes}-byte fingerprint limit`, 'recovery_workspace_too_large');
        }
        const hashed = hashWorkspaceFile(full, rel, info);
        hashedBytes += hashed.size;
        entries.push({path: rel, size: hashed.size, sha256: hashed.sha256});
      } else {
        fail(`workspace entry ${rel} is not a regular file, directory or symlink`, 'recovery_workspace_unsupported');
      }
    }
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return createHash('sha256').update(JSON.stringify({
    schema: 'codex-dsh-bridge/workspace-fingerprint@2',
    coverage: 'complete',
    files: entries,
    fileCount: entries.length,
    hashedBytes,
  })).digest('hex');
}

/* ------------------------------------------------------------------ plan */

export interface RecoveryPlan {
  ok: true;
  schema: 'codex-dsh-bridge/recovery-plan@1';
  mode: 'checkpoint-new-session';
  planToken: string;
  source: {
    taskId: string;
    sessionId: string;
    stage: number;
    stageCount: number;
    recordedState: string;
    recordedStageState: string;
    checkpointReason: string | null;
    recordSha256: string;
    checkpointSha256: string;
    workspace: string;
    workspaceFingerprint: string;
    verification: RecoveryVerificationView;
    changes: RecoverySource['changes'];
    errors: string[];
  };
  requires: {
    instructions: true;
    freshVerificationCommand: boolean;
    freshProtectedVerificationFiles: boolean;
    allowUnsettledSource: boolean;
  };
  warnings: string[];
  limits: {
    fullConversationRestored: false;
    modelReasoningRestored: false;
    oldStagesAppended: false;
    oldEvidenceReadOnly: true;
    newSession: true;
    maxInstructionsChars: number;
    sourceRecordBytes: number;
    checkpointBytes: number;
  };
  note: string;
}

export function planTokenFor(source: RecoverySource, workspaceFingerprintValue: string): string {
  return createHash('sha256').update(JSON.stringify({
    schema: 'codex-dsh-bridge/recovery-plan-token@1',
    taskId: source.taskId,
    sessionId: source.sessionId,
    stage: source.stage,
    recordSha256: source.recordSha256,
    checkpointSha256: source.checkpointSha256,
    workspace: source.workspace,
    workspaceFingerprint: workspaceFingerprintValue,
  })).digest('hex');
}

export function buildRecoveryPlan(source: RecoverySource): RecoveryPlan {
  const workspaceFingerprintValue = workspaceFingerprint(source.workspace);
  const unsettled = LIVE_STATES.has(source.state);
  const warnings: string[] = [];
  if (unsettled) {
    warnings.push(
      `source is recorded ${source.state}; the bridge cannot prove whether the old process is alive or dead. `
      + 'Recovery is refused unless the caller explicitly sets allowUnsettledSource=true, which is an acknowledgment, not bridge proof.',
    );
  }
  if (source.state === 'cancelled') {
    warnings.push('source was cancelled; its runtime stop was recorded before the bridge restart and is not revalidated here.');
  }
  warnings.push('The old prompt, context, environment and model-internal reasoning are not restored into the new session.');
  if (source.verificationCommand !== null) {
    warnings.push('The source configured verification. The recorded argv is never executed; recover requires a fresh caller-supplied verificationCommand.');
  }
  if (source.protectedVerificationFiles.length > 0) {
    warnings.push('The source pinned protected verification files. recover requires fresh pins for the same real paths and hashes; original pins cannot be dropped.');
  }
  return {
    ok: true,
    schema: 'codex-dsh-bridge/recovery-plan@1',
    mode: 'checkpoint-new-session',
    planToken: planTokenFor(source, workspaceFingerprintValue),
    source: {
      taskId: source.taskId,
      sessionId: source.sessionId,
      stage: source.stage,
      stageCount: source.stageCount,
      recordedState: source.state,
      recordedStageState: source.stageState,
      checkpointReason: source.checkpointReason,
      recordSha256: source.recordSha256,
      checkpointSha256: source.checkpointSha256,
      workspace: source.workspace,
      workspaceFingerprint: workspaceFingerprintValue,
      verification: source.verification,
      changes: source.changes,
      errors: source.stageErrors.slice(-5),
    },
    requires: {
      instructions: true,
      freshVerificationCommand: source.verificationCommand !== null,
      freshProtectedVerificationFiles: source.protectedVerificationFiles.length > 0,
      allowUnsettledSource: unsettled,
    },
    warnings: warnings.slice(0, RECOVERY_LIMITS.warnings),
    limits: {
      fullConversationRestored: false,
      modelReasoningRestored: false,
      oldStagesAppended: false,
      oldEvidenceReadOnly: true,
      newSession: true,
      maxInstructionsChars: RECOVERY_LIMITS.instructionsChars,
      sourceRecordBytes: source.recordBytes,
      checkpointBytes: source.checkpointBytes,
    },
    note: 'Bounded checkpoint-recovery plan. It is read-only and starts no runtime or model request. '
      + 'It is not native SDK conversation resume: the recovered task is a NEW session with its own stage list and evidence.',
  };
}

/* ------------------------------------------------------------------ durable claims */

export interface RecoveryClaimSource {
  taskId: string;
  sessionId: string;
  stage: number;
  recordSha256: string;
  checkpointSha256: string;
  workspace: string;
  workspaceFingerprint: string;
}

export interface RecoveryClaimFailure {
  code: string;
  message: string;
  taskCreated: boolean;
  runtimeStartBegan: boolean;
  uncertain: boolean;
}

export type RecoveryClaimState = 'starting' | 'task-created' | 'started' | 'failed';

export interface RecoveryClaim {
  schema: 'codex-dsh-bridge/recovery-claim@1';
  planToken: string;
  mode: 'checkpoint-new-session';
  state: RecoveryClaimState;
  createdAt: string;
  updatedAt: string;
  allowUnsettledSource: boolean;
  source: RecoveryClaimSource;
  recovery: {taskId: string | null; sessionId: string | null; runtimePid: number | null};
  failure: RecoveryClaimFailure | null;
  note: string;
}

const PLAN_TOKEN = /^[a-f0-9]{64}$/;

function claimToken(value: unknown): string {
  if (typeof value !== 'string' || !PLAN_TOKEN.test(value)) {
    fail('planToken must be a 64-character lowercase SHA-256 hex string', 'recovery_invalid_plan');
  }
  return value;
}

function trustedDirectory(candidate: string, label: string, create: boolean): string | null {
  const lexical = path.resolve(candidate);
  let info;
  try { info = lstatSync(lexical); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      fail(`${label} cannot be inspected: ${(error as Error).message}`, 'recovery_ledger_unsafe');
    }
    if (!create) return null;
    try { mkdirSync(lexical, {recursive: true, mode: 0o700}); }
    catch (mkdirError) { fail(`${label} cannot be created: ${(mkdirError as Error).message}`, 'recovery_ledger_unsafe'); }
    try { info = lstatSync(lexical); }
    catch (statError) { fail(`${label} cannot be inspected after creation: ${(statError as Error).message}`, 'recovery_ledger_unsafe'); }
  }
  if (info.isSymbolicLink()) fail(`${label} is a symbolic link or junction; refusing it as a trust anchor`, 'recovery_ledger_unsafe');
  let resolved: string;
  try { resolved = realpathSync.native(lexical); }
  catch (error) { fail(`${label} cannot be resolved: ${(error as Error).message}`, 'recovery_ledger_unsafe'); }
  if (!samePath(resolved, lexical)) fail(`${label} resolves to a different path; link refused`, 'recovery_ledger_unsafe');
  let stat;
  try { stat = statSync(resolved); }
  catch (error) { fail(`${label} cannot be read: ${(error as Error).message}`, 'recovery_ledger_unsafe'); }
  if (!stat.isDirectory()) fail(`${label} is not a directory`, 'recovery_ledger_unsafe');
  return resolved;
}

function claimsRoot(create: boolean): string | null {
  const data = trustedDirectory(DATA_ROOT, 'configured DATA_ROOT', false);
  if (data === null) {
    if (create) fail('configured DATA_ROOT does not exist, so no recovery ledger can be created', 'recovery_ledger_unsafe');
    return null;
  }
  const recovery = trustedDirectory(path.join(data, 'recovery'), 'recovery ledger root', create);
  if (recovery === null) return null;
  if (!isInside(data, recovery)) fail('recovery ledger root escapes DATA_ROOT', 'recovery_ledger_unsafe');
  const claims = trustedDirectory(path.join(recovery, 'claims'), 'recovery claims root', create);
  if (claims === null) return null;
  if (!isInside(recovery, claims)) fail('recovery claims root escapes its ledger root', 'recovery_ledger_unsafe');
  return claims;
}

function claimFile(claims: string, token: string): string {
  const file = path.join(claims, `${claimToken(token)}.json`);
  if (!isInside(claims, file)) fail('recovery claim path escapes its root', 'recovery_ledger_unsafe');
  return file;
}

function readClaimFile(claims: string, token: string): RecoveryClaim | null {
  const file = claimFile(claims, token);
  let info;
  try { info = lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    fail(`recovery claim cannot be inspected: ${(error as Error).message}`, 'recovery_ledger_unsafe');
  }
  if (info.isSymbolicLink()) fail('recovery claim file is a symbolic link; refused', 'recovery_ledger_unsafe');
  let resolved: string;
  try { resolved = realpathSync.native(file); }
  catch (error) { fail(`recovery claim cannot be resolved: ${(error as Error).message}`, 'recovery_ledger_unsafe'); }
  if (!samePath(resolved, file)) fail('recovery claim file resolves to a different path; link refused', 'recovery_ledger_unsafe');
  if (!info.isFile()) fail('recovery claim is not a regular file', 'recovery_ledger_unsafe');
  if (info.size > RECOVERY_LIMITS.claimBytes) fail('recovery claim is above the bounded size limit', 'recovery_ledger_unsafe');
  let bytes: Buffer;
  try { bytes = readFileSync(file); }
  catch (error) { fail(`recovery claim cannot be read: ${(error as Error).message}`, 'recovery_ledger_unsafe'); }
  if (bytes.length > RECOVERY_LIMITS.claimBytes) fail('recovery claim grew above the bounded size limit', 'recovery_ledger_unsafe');
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { fail('recovery claim is not valid JSON; refusing to guess its state', 'recovery_ledger_unsafe'); }
  return parseClaim(raw, token);
}

function parseClaim(raw: unknown, token: string): RecoveryClaim {
  const value = object(raw, 'recovery claim');
  if (value['schema'] !== 'codex-dsh-bridge/recovery-claim@1') fail('recovery claim schema is unsupported', 'recovery_ledger_unsafe');
  if (value['planToken'] !== token) fail('recovery claim planToken does not match the request', 'recovery_invalid_plan');
  if (value['mode'] !== 'checkpoint-new-session') fail('recovery claim mode is unsupported', 'recovery_ledger_unsafe');
  const state = value['state'];
  if (state !== 'starting' && state !== 'task-created' && state !== 'started' && state !== 'failed') {
    fail('recovery claim state is invalid', 'recovery_ledger_unsafe');
  }
  const sourceRaw = object(value['source'], 'recovery claim source');
  const source: RecoveryClaimSource = {
    taskId: textOf(sourceRaw['taskId'], 'claim source.taskId', 64) as string,
    sessionId: textOf(sourceRaw['sessionId'], 'claim source.sessionId', 128) as string,
    stage: positiveInt(sourceRaw['stage'], 'claim source.stage', RECOVERY_LIMITS.stages),
    recordSha256: sha256Hex(sourceRaw['recordSha256'], 'claim source.recordSha256'),
    checkpointSha256: sha256Hex(sourceRaw['checkpointSha256'], 'claim source.checkpointSha256'),
    workspace: textOf(sourceRaw['workspace'], 'claim source.workspace', 4_096) as string,
    workspaceFingerprint: sha256Hex(sourceRaw['workspaceFingerprint'], 'claim source.workspaceFingerprint'),
  };
  if (!isSafeHistoryTaskId(source.taskId) || source.sessionId !== `session-${source.taskId}`) {
    fail('recovery claim source identity is invalid', 'recovery_ledger_unsafe');
  }
  const recoveryRaw = value['recovery'] === null || value['recovery'] === undefined
    ? {} : object(value['recovery'], 'recovery claim recovery');
  const recoveryTaskId = recoveryRaw['taskId'] === undefined || recoveryRaw['taskId'] === null ? null : recoveryRaw['taskId'];
  const recoverySessionId = recoveryRaw['sessionId'] === undefined || recoveryRaw['sessionId'] === null ? null : recoveryRaw['sessionId'];
  if (recoveryTaskId !== null && !isSafeHistoryTaskId(recoveryTaskId)) fail('recovery claim taskId is invalid', 'recovery_ledger_unsafe');
  if (recoverySessionId !== null && (typeof recoverySessionId !== 'string' || recoveryTaskId === null || recoverySessionId !== `session-${recoveryTaskId}`)) {
    fail('recovery claim sessionId is invalid', 'recovery_ledger_unsafe');
  }
  const runtimePid = recoveryRaw['runtimePid'];
  if (runtimePid !== undefined && runtimePid !== null && (typeof runtimePid !== 'number' || !Number.isSafeInteger(runtimePid) || runtimePid <= 0)) {
    fail('recovery claim runtimePid is invalid', 'recovery_ledger_unsafe');
  }
  let failure: RecoveryClaimFailure | null = null;
  if (value['failure'] !== null && value['failure'] !== undefined) {
    const rawFailure = object(value['failure'], 'recovery claim failure');
    failure = {
      code: textOf(rawFailure['code'], 'claim failure.code', 100) as string,
      message: textOf(rawFailure['message'], 'claim failure.message', 1_000) as string,
      taskCreated: rawFailure['taskCreated'] === true,
      runtimeStartBegan: rawFailure['runtimeStartBegan'] === true,
      uncertain: rawFailure['uncertain'] === true,
    };
  }
  const createdAt = textOf(value['createdAt'], 'claim createdAt', 64) as string;
  const updatedAt = textOf(value['updatedAt'], 'claim updatedAt', 64) as string;
  return {
    schema: 'codex-dsh-bridge/recovery-claim@1',
    planToken: token,
    mode: 'checkpoint-new-session',
    state,
    createdAt,
    updatedAt,
    allowUnsettledSource: value['allowUnsettledSource'] === true,
    source,
    recovery: {
      taskId: recoveryTaskId === null ? null : recoveryTaskId as string,
      sessionId: recoverySessionId === null ? null : recoverySessionId as string,
      runtimePid: typeof runtimePid === 'number' ? runtimePid : null,
    },
    failure,
    note: typeof value['note'] === 'string' ? truncate(scrubText(value['note']), 1_000).text : '',
  };
}

function claimText(claim: RecoveryClaim): string {
  return `${JSON.stringify(claim, null, 2)}\n`;
}

function fsyncDirectory(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch { /* directory fsync is best-effort and unsupported on some platforms */ }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } } }
}

/** Read the durable claim for a plan. A missing ledger or claim is null; a linked one is refused. */
export function readRecoveryClaim(token: string): RecoveryClaim | null {
  const valid = claimToken(token);
  const claims = claimsRoot(false);
  if (claims === null) return null;
  return readClaimFile(claims, valid);
}

/**
 * Create the claim atomically without replacing an existing one. Returns created=false with the
 * existing claim when another caller won the race.
 */
export function createRecoveryClaim(claim: RecoveryClaim): {claim: RecoveryClaim; created: boolean} {
  const token = claimToken(claim.planToken);
  const claims = claimsRoot(true);
  if (claims === null) fail('recovery claims root is unavailable', 'recovery_ledger_unsafe');
  const final = claimFile(claims, token);
  const temporary = path.join(claims, `.${token}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  if (!isInside(claims, temporary)) fail('recovery claim temporary path escapes its root', 'recovery_ledger_unsafe');
  let fd: number | null = null;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeSync(fd, claimText(claim));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      linkSync(temporary, final);
      fsyncDirectory(claims);
      return {claim, created: true};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        fail(`recovery claim cannot be published atomically: ${(error as Error).message}`, 'recovery_ledger_unsafe');
      }
      const existing = readClaimFile(claims, token);
      if (existing === null) fail('recovery claim raced but cannot be read back', 'recovery_ledger_unsafe');
      return {claim: existing, created: false};
    }
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { unlinkSync(temporary); } catch { /* already published or never created */ }
  }
}

/** Atomically replace an owned claim after a state transition. */
export function updateRecoveryClaim(claim: RecoveryClaim): void {
  const token = claimToken(claim.planToken);
  const claims = claimsRoot(true);
  if (claims === null) fail('recovery claims root is unavailable', 'recovery_ledger_unsafe');
  const final = claimFile(claims, token);
  const temporary = path.join(claims, `.${token}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  if (!isInside(claims, temporary)) fail('recovery claim temporary path escapes its root', 'recovery_ledger_unsafe');
  let fd: number | null = null;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeSync(fd, claimText(claim));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, final);
    fsyncDirectory(claims);
  } catch (error) {
    fail(`recovery claim cannot be updated atomically: ${(error as Error).message}`, 'recovery_ledger_unsafe');
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

/** Remove a claim only when a retry is provably safe (no task and no runtime start began). */
export function removePreStartClaim(token: string): void {
  const valid = claimToken(token);
  const claims = claimsRoot(false);
  if (claims === null) return;
  const file = claimFile(claims, valid);
  try { unlinkSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      fail(`pre-start recovery claim cannot be cleared: ${(error as Error).message}`, 'recovery_ledger_unsafe');
    }
  }
}

export function newRecoveryClaim(
  token: string,
  source: RecoverySource,
  workspaceFingerprintValue: string,
  plannedTaskId: string,
  allowUnsettledSource: boolean,
): RecoveryClaim {
  const now = new Date().toISOString();
  return {
    schema: 'codex-dsh-bridge/recovery-claim@1',
    planToken: token,
    mode: 'checkpoint-new-session',
    state: 'starting',
    createdAt: now,
    updatedAt: now,
    allowUnsettledSource,
    source: {
      taskId: source.taskId,
      sessionId: source.sessionId,
      stage: source.stage,
      recordSha256: source.recordSha256,
      checkpointSha256: source.checkpointSha256,
      workspace: source.workspace,
      workspaceFingerprint: workspaceFingerprintValue,
    },
    recovery: {taskId: plannedTaskId, sessionId: `session-${plannedTaskId}`, runtimePid: null},
    failure: null,
    note: 'Atomic checkpoint-recovery idempotency claim. Written before the new task or runtime exists.',
  };
}
