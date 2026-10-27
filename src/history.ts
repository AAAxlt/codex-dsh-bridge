/**
 * Bounded READ-ONLY view of tasks that were persisted by an earlier bridge process.
 *
 * This module is deliberately separate from the live task-control map in `tasks.ts`:
 *  - it never creates a ManagedTask, DshRuntime, timer or waiter;
 *  - it never reattaches, resumes, starts, stops or probes a recorded PID;
 *  - it never executes a recorded argv or recaptures the current workspace;
 *  - every path it reads is derived from the configured DATA_ROOT/tasks plus a safe taskId,
 *    never from an absolute path stored inside task.json or delivery/index.json.
 *
 * A historical response is evidence of what was recorded on disk, not a live status. The fixed
 * envelope at the top of every response states that explicitly, and disk content cannot override
 * `source`, `runtimeAttached`, `runtimeAlive`, `canContinue` or `canCancel`.
 */
import {createHash} from 'node:crypto';
import {lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent} from 'node:fs';
import path from 'node:path';
import {DATA_ROOT} from './config.js';
import {exportDeliveryBundle, validateScopedDeliveryIndex} from './delivery.js';
import {scrubText} from './evidence.js';

export const HISTORY_LIMITS = {
  listDefault: 20,
  listMax: 100,
  taskDirectories: 1_000,
  stages: 100,
  taskRecordBytes: 8 * 1024 * 1024,
  checkpointBytes: 2 * 1024 * 1024,
  stageResultBytes: 8 * 1024 * 1024,
  deliveryIndexBytes: 8 * 1024 * 1024,
  stringChars: 512,
  reportPreviewChars: 4_000,
  verificationTailChars: 1_000,
  errorItems: 20,
  stageItems: 50,
  responseBytes: 512 * 1024,
  listResponseBytes: 256 * 1024,
} as const;

export const HISTORY_NOTE =
  'Read-only persisted history: this is recorded evidence, not a live task. Runtime liveness, '
  + 'the current product state and whether the old process still exists are NOT verified; the '
  + 'recorded PID is an old value and is never probed, signalled or reattached.';

const TASK_STATES: readonly string[] = [
  'accepted', 'starting', 'running', 'awaiting_review',
  'blocked', 'incomplete', 'failed', 'cancelled', 'timed_out',
];
const TASK_STATE_SET = new Set(TASK_STATES);
const LIVE_STATE_SET = new Set(['accepted', 'starting', 'running']);
const STAGE_CAUSES = new Set([
  'initial', 'manual-continuation', 'auto-repair', 'auto-continuation', 'review-repair',
]);
const EXTERNAL_REVIEW_STATUSES = new Set(['none', 'failed', 'blocked', 'awaiting-recheck', 'passed']);
const VERIFICATION_STATUSES = new Set([
  'pending', 'passed', 'failed', 'timed-out', 'errored', 'not-run', 'not-configured', 'cancelled-during-run',
]);

/** Bridge-generated ids only. No separators, drive letters, ADS, percent escapes or dot segments. */
const SAFE_TASK_ID = /^dsh-[0-9]{14}-[a-z0-9]{3,24}$/;

export type HistoryErrorCode =
  | 'invalid_history_query' | 'history_not_found' | 'history_invalid'
  | 'history_unsafe' | 'history_missing' | 'unknown_stage' | 'delivery_unavailable';

export class HistoryError extends Error {
  constructor(message: string, readonly code: HistoryErrorCode) {
    super(message);
    this.name = 'HistoryError';
  }
}

export interface HistoryRecoveredFrom {
  taskId: string;
  stage: number;
  sessionId: string;
  recordSha256: string;
  checkpointSha256: string;
  planToken: string;
  mode: 'checkpoint-new-session';
  unsettledSourceAcknowledged?: boolean;
}

export interface HistoryRecord {
  taskId: string;
  sessionId: string;
  workspace: string;
  state: string;
  recoveredFrom: HistoryRecoveredFrom | null;
  createdAt: string | null;
  updatedAt: string | null;
  runtimePid: number | null;
  deliveryStage: number | null;
  /** Configured argv from the native TaskRecord. Never executed by history. */
  verificationCommand: string[] | null;
  codexContinuationCount: number;
  totalAutoRepairs: number;
  totalAutoContinuations: number;
  totalReviewRepairs: number;
  autoRepair: {
    enabled: boolean;
    attempts: number;
    unchangedFailures: number;
    stopReason: string | null;
    totalBudgetMs: number | null;
  };
  /** Absent in pre-1.0.8 records; those project as disabled/unknown rather than invented. */
  autoContinue: {
    enabled: boolean;
    attempts: number;
    unchangedFailures: number;
    stopReason: string | null;
    totalBudgetMs: number | null;
  };
  externalReview: {
    status: string;
    reviewId: string | null;
    stage: number | null;
    outcome: string | null;
    repairStage: number | null;
    receiptCount: number;
    continuation: string | null;
  };
  stages: HistoryStage[];
  errors: string[];
}

export interface HistoryStage {
  index: number;
  state: string;
  cause: string | null;
  causeDetail: string | null;
  elapsedMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  finalisedAt: string | null;
  modelReport: string;
  verification: Record<string, unknown> | null;
  verificationNotRunReason: string | null;
  verificationCancelledDuringRun: boolean;
  verifierIntegrityErrors: string[];
  toolCallsTotal: number;
  toolErrorCount: number;
  fileChanges: {added: string[]; modified: string[]; removed: string[]} | null;
  errors: string[];
}

interface LoadedTask {
  taskId: string;
  taskDir: string;
  record: HistoryRecord;
}

/* ------------------------------------------------------------------ path safety */

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function relativeFile(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.includes(':') ||
      path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new HistoryError(`Unsafe history-relative path: ${value}`, 'history_unsafe');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new HistoryError(`Unsafe history-relative path: ${value}`, 'history_unsafe');
  }
  return parts.join('/');
}

/**
 * Resolve one descendant of a fixed root, rejecting links/junctions and any lexical or resolved
 * escape. Each segment is checked with lstat AND realpath; a string prefix test is not enough.
 */
function safeChild(root: string, relative: string, missingCode: HistoryErrorCode = 'history_invalid'): string {
  const rel = relativeFile(relative);
  const absolute = path.resolve(root, rel);
  if (!isWithin(root, absolute)) throw new HistoryError(`History path escapes its root: ${relative}`, 'history_unsafe');
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HistoryError(`Recorded history file is missing: ${relative}`, missingCode);
      }
      throw new HistoryError(`Cannot inspect recorded history path ${relative}: ${(error as Error).message}`, 'history_invalid');
    }
    if (info.isSymbolicLink()) throw new HistoryError(`Symbolic link or junction refused: ${relative}`, 'history_unsafe');
    let resolved: string;
    try {
      resolved = realpathSync.native(current);
    } catch (error) {
      throw new HistoryError(`Cannot resolve recorded history path ${relative}: ${(error as Error).message}`, 'history_invalid');
    }
    if (!samePath(resolved, current)) throw new HistoryError(`Symbolic link or junction refused: ${relative}`, 'history_unsafe');
    if (!isWithin(root, resolved)) throw new HistoryError(`Resolved history path escapes its root: ${relative}`, 'history_unsafe');
  }
  return absolute;
}

/**
 * Canonical trust anchor: the explicitly configured DATA_ROOT may itself be a canonicalized
 * path. The `tasks` child is NOT trusted just because realpath() follows it: inspect it with
 * lstat and require it to resolve to the literal child of that anchor. A tasks junction/symlink
 * could otherwise redefine the root and expose an unrelated external tree.
 */
function trustedDataRoot(): string | null {
  const configured = path.resolve(DATA_ROOT);
  try {
    const resolved = realpathSync.native(configured);
    if (!statSync(resolved).isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

function tasksRoot(): string | null {
  const dataRoot = trustedDataRoot();
  if (dataRoot === null) return null;
  const lexical = path.join(dataRoot, 'tasks');
  let info;
  try {
    info = lstatSync(lexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new HistoryError(`Cannot inspect the configured tasks root: ${(error as Error).message}`, 'history_invalid');
  }
  if (info.isSymbolicLink()) {
    throw new HistoryError('The configured tasks root is a symbolic link or junction; refusing to treat it as a trust anchor', 'history_unsafe');
  }
  let resolved: string;
  try {
    resolved = realpathSync.native(lexical);
  } catch (error) {
    throw new HistoryError(`Cannot resolve the configured tasks root: ${(error as Error).message}`, 'history_invalid');
  }
  if (!samePath(resolved, lexical)) {
    throw new HistoryError('The configured tasks root resolves to a different path; junction or link refused', 'history_unsafe');
  }
  if (!isWithin(dataRoot, resolved)) {
    throw new HistoryError('The configured tasks root escapes its DATA_ROOT anchor; refused', 'history_unsafe');
  }
  let stat;
  try { stat = statSync(resolved); } catch (error) {
    throw new HistoryError(`Cannot stat the configured tasks root: ${(error as Error).message}`, 'history_invalid');
  }
  if (!stat.isDirectory()) throw new HistoryError('The configured tasks root is not a directory', 'history_invalid');
  return resolved;
}

export function isSafeHistoryTaskId(taskId: unknown): taskId is string {
  return typeof taskId === 'string' && taskId.length <= 64 && SAFE_TASK_ID.test(taskId);
}

function assertTaskId(taskId: unknown): string {
  if (!isSafeHistoryTaskId(taskId)) {
    throw new HistoryError(
      'taskId must be a bridge-generated id of the form dsh-<14 digits>-<lowercase alphanumeric>; paths, separators, dots, drive letters and ADS suffixes are refused',
      'invalid_history_query',
    );
  }
  return taskId;
}

function taskDirectory(taskId: unknown): string {
  const id = assertTaskId(taskId);
  const root = tasksRoot();
  if (root === null) throw new HistoryError('No persisted task root exists under the configured DATA_ROOT', 'history_not_found');
  try {
    return safeChild(root, id, 'history_not_found');
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_not_found') {
      throw new HistoryError(`No persisted history exists for taskId '${id}'`, 'history_not_found');
    }
    throw error;
  }
}

/**
 * Read-only recovery hook: the canonical directory of a persisted task, resolved through the same
 * tasks-root trust anchor as history. It never creates, resumes or probes anything. Callers that
 * need a file must still go through `readPersistedTaskFile`, so every component is checked with
 * lstat + realpath rather than trusted from task.json.
 */
export function persistedTaskDirectory(taskId: unknown): string {
  return taskDirectory(taskId);
}

/** Read one bounded, symlink-refusing file below a persisted task directory. */
export function readPersistedTaskFile(
  taskId: unknown,
  relative: string,
  maxBytes: number,
  label: string,
): Buffer {
  return readBounded(taskDirectory(taskId), relative, maxBytes, label);
}

/**
 * Resolve one persisted event-log path for the bounded incremental reader. The anchored task-dir
 * checks (tasks-root anchor, lstat, realpath, no links) are the same ones history uses; the caller
 * streams the file itself so it never has to load an unbounded log into memory.
 */
export function persistedTaskFilePath(taskId: unknown, relative: string): string | null {
  const directory = taskDirectory(taskId);
  try {
    const file = safeChild(directory, relative, 'history_missing');
    if (!statSync(file).isFile()) throw new HistoryError(`recorded ${relative} is not a regular file`, 'history_invalid');
    return file;
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_missing') return null;
    throw error;
  }
}

/** Cheap read-only existence test used to turn a control call on an old task into a clear refusal.
 *  An unsafe tasks root is propagated so callers can refuse it explicitly instead of treating it
 *  as an ordinary unknown task.
 */
export function historicalTaskExists(taskId: unknown): boolean {
  if (!isSafeHistoryTaskId(taskId)) return false;
  const root = tasksRoot();
  if (root === null) return false;
  try {
    const directory = safeChild(root, taskId, 'history_missing');
    return statSync(directory).isDirectory();
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_unsafe') throw error;
    return false;
  }
}

/* ------------------------------------------------------------------ bounded readers */

function readBounded(taskDir: string, relative: string, maxBytes: number, label: string): Buffer {
  const file = safeChild(taskDir, relative, 'history_missing');
  let info;
  try {
    info = statSync(file);
  } catch (error) {
    throw new HistoryError(`${label} cannot be read: ${(error as Error).message}`, 'history_invalid');
  }
  if (!info.isFile()) throw new HistoryError(`${label} is not a regular file`, 'history_invalid');
  if (info.size > maxBytes) {
    throw new HistoryError(`${label} is ${info.size} bytes, above the ${maxBytes}-byte history read limit`, 'history_invalid');
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new HistoryError(`${label} cannot be read: ${(error as Error).message}`, 'history_invalid');
  }
  if (bytes.length > maxBytes) {
    throw new HistoryError(`${label} grew above the ${maxBytes}-byte history read limit while reading`, 'history_invalid');
  }
  return bytes;
}

function optionalBounded(taskDir: string, relative: string, maxBytes: number, label: string): Buffer | null {
  try {
    return readBounded(taskDir, relative, maxBytes, label);
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_missing') return null;
    throw error;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HistoryError('Recorded history is not a JSON object', 'history_invalid');
  }
  return value as Record<string, unknown>;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new HistoryError(`${label} is not valid JSON`, 'history_invalid');
  }
}

function text(value: unknown, max: number = HISTORY_LIMITS.stringChars): string | null {
  if (typeof value !== 'string') return null;
  const clean = scrubText(value);
  return clean.length > max ? `${clean.slice(0, max)}\n... [TRUNCATED: ${clean.length - max} of ${clean.length} chars omitted]` : clean;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || scrubText(value) !== value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z$/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function signedInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function argvList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 512 || item.includes('\0')) return null;
    out.push(text(item, HISTORY_LIMITS.stringChars) ?? '[REDACTED]');
  }
  return out;
}

function stringList(value: unknown, limit = HISTORY_LIMITS.errorItems): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value.slice(0, limit)) {
    if (typeof item !== 'string') continue;
    const clean = text(item, HISTORY_LIMITS.stringChars);
    if (clean !== null) out.push(clean);
  }
  return out;
}

function relativeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value.slice(0, HISTORY_LIMITS.stageItems)) {
    if (typeof item !== 'string') continue;
    const clean = text(item, HISTORY_LIMITS.stringChars);
    if (clean !== null) out.push(clean);
  }
  return out;
}

/* ------------------------------------------------------------------ record validation */

function validateStage(raw: unknown, expectedIndex: number): HistoryStage {
  const stage = object(raw);
  if (stage['index'] !== expectedIndex) {
    throw new HistoryError(`Recorded stage index does not match the expected position ${expectedIndex}`, 'history_invalid');
  }
  const state = stage['state'];
  if (typeof state !== 'string' || !TASK_STATE_SET.has(state)) {
    throw new HistoryError(`Recorded stage ${expectedIndex} has an unknown state`, 'history_invalid');
  }
  const startedAt = stage['startedAt'] === undefined || stage['startedAt'] === null ? null : timestamp(stage['startedAt']);
  const endedAt = stage['endedAt'] === undefined || stage['endedAt'] === null ? null : timestamp(stage['endedAt']);
  const finalisedAt = stage['finalisedAt'] === undefined || stage['finalisedAt'] === null ? null : timestamp(stage['finalisedAt']);
  if ((stage['startedAt'] !== undefined && stage['startedAt'] !== null && startedAt === null) ||
      (stage['endedAt'] !== undefined && stage['endedAt'] !== null && endedAt === null) ||
      (stage['finalisedAt'] !== undefined && stage['finalisedAt'] !== null && finalisedAt === null)) {
    throw new HistoryError(`Recorded stage ${expectedIndex} has an invalid timestamp`, 'history_invalid');
  }
  const modelReport = typeof stage['modelReport'] === 'string' ? stage['modelReport'] : '';
  const verification = stage['verification'];
  if (verification !== undefined && verification !== null && (typeof verification !== 'object' || Array.isArray(verification))) {
    throw new HistoryError(`Recorded stage ${expectedIndex} has a non-object verification record`, 'history_invalid');
  }
  const errors = stringList(stage['errors']) ?? [];
  const verifierIntegrityErrors = stringList(stage['verifierIntegrityErrors']) ?? [];
  const changesRaw = stage['fileChanges'];
  let fileChanges: HistoryStage['fileChanges'] = null;
  if (changesRaw !== undefined && changesRaw !== null) {
    const changes = object(changesRaw);
    fileChanges = {
      added: relativeList(changes['added']),
      modified: relativeList(changes['modified']),
      removed: relativeList(changes['removed']),
    };
  }
  const causeRaw = stage['cause'];
  const cause = typeof causeRaw === 'string' && STAGE_CAUSES.has(causeRaw) ? causeRaw : null;
  const causeDetail = text(stage['causeDetail'], HISTORY_LIMITS.stringChars);
  const elapsedMs = stage['elapsedMs'] === undefined || stage['elapsedMs'] === null
    ? null : integer(stage['elapsedMs']);
  if (stage['elapsedMs'] !== undefined && stage['elapsedMs'] !== null && elapsedMs === null) {
    throw new HistoryError(`Recorded stage ${expectedIndex} has an invalid elapsedMs`, 'history_invalid');
  }
  return {
    index: expectedIndex,
    state,
    cause,
    causeDetail,
    elapsedMs,
    startedAt,
    endedAt,
    finalisedAt,
    modelReport,
    verification: verification === undefined || verification === null ? null : verification as Record<string, unknown>,
    verificationNotRunReason: text(stage['verificationNotRunReason']) ?? null,
    verificationCancelledDuringRun: stage['verificationCancelledDuringRun'] === true,
    verifierIntegrityErrors,
    toolCallsTotal: integer(stage['toolCallsTotal']) ?? 0,
    toolErrorCount: integer(stage['toolErrorCount']) ?? 0,
    fileChanges,
    errors,
  };
}

function validateRecoveredFrom(raw: unknown, taskId: string): HistoryRecoveredFrom | null {
  if (raw === undefined || raw === null) return null;
  const value = object(raw);
  if (value['mode'] !== 'checkpoint-new-session') {
    throw new HistoryError(`Recorded task '${taskId}' has an unsupported recovery mode`, 'history_invalid');
  }
  const sourceTaskId = value['taskId'];
  const sourceSessionId = value['sessionId'];
  const stage = positiveInteger(value['stage']);
  const recordSha256 = value['recordSha256'];
  const checkpointSha256 = value['checkpointSha256'];
  const planToken = value['planToken'];
  if (typeof sourceTaskId !== 'string' || !SAFE_TASK_ID.test(sourceTaskId) ||
      typeof sourceSessionId !== 'string' || sourceSessionId !== `session-${sourceTaskId}` ||
      stage === null ||
      typeof recordSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(recordSha256) ||
      typeof checkpointSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(checkpointSha256) ||
      typeof planToken !== 'string' || !/^[a-f0-9]{64}$/.test(planToken)) {
    throw new HistoryError(`Recorded task '${taskId}' has an invalid recovery lineage`, 'history_invalid');
  }
  if (sourceTaskId === taskId) {
    throw new HistoryError(`Recorded task '${taskId}' claims to be recovered from itself`, 'history_invalid');
  }
  if (value['unsettledSourceAcknowledged'] !== undefined && typeof value['unsettledSourceAcknowledged'] !== 'boolean') {
    throw new HistoryError(`Recorded task '${taskId}' has an invalid unsettled-source acknowledgment`, 'history_invalid');
  }
  return {
    taskId: sourceTaskId,
    stage,
    sessionId: sourceSessionId,
    recordSha256,
    checkpointSha256,
    planToken,
    mode: 'checkpoint-new-session',
    ...(value['unsettledSourceAcknowledged'] === true ? {unsettledSourceAcknowledged: true} : {}),
  };
}

function validateRecord(taskId: string, raw: unknown): HistoryRecord {
  const record = object(raw);
  if (record['taskId'] !== taskId) {
    throw new HistoryError(`Recorded taskId does not match its directory '${taskId}'`, 'history_invalid');
  }
  const state = record['state'];
  if (typeof state !== 'string' || !TASK_STATE_SET.has(state)) {
    throw new HistoryError(`Recorded task '${taskId}' has an unknown state`, 'history_invalid');
  }
  const sessionId = record['sessionId'];
  if (sessionId !== `session-${taskId}`) {
    throw new HistoryError(`Recorded task '${taskId}' has an invalid sessionId for its task identity`, 'history_invalid');
  }
  const workspace = record['workspace'];
  if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4_096) {
    throw new HistoryError(`Recorded task '${taskId}' has an invalid workspace string`, 'history_invalid');
  }
  const createdAt = timestamp(record['createdAt']);
  const updatedAt = timestamp(record['updatedAt']);
  if (createdAt === null || updatedAt === null) {
    throw new HistoryError(`Recorded task '${taskId}' has invalid creation/update timestamps`, 'history_invalid');
  }
  const runtimePid = record['runtimePid'];
  if (runtimePid !== undefined && runtimePid !== null && positiveInteger(runtimePid) === null) {
    throw new HistoryError(`Recorded task '${taskId}' has an invalid runtimePid`, 'history_invalid');
  }
  const deliveryStage = record['deliveryStage'];
  if (deliveryStage !== undefined && deliveryStage !== null && positiveInteger(deliveryStage) === null) {
    throw new HistoryError(`Recorded task '${taskId}' has an invalid deliveryStage`, 'history_invalid');
  }
  const stagesRaw = record['stages'];
  if (!Array.isArray(stagesRaw) || stagesRaw.length === 0 || stagesRaw.length > HISTORY_LIMITS.stages) {
    throw new HistoryError(`Recorded task '${taskId}' has an invalid stage list`, 'history_invalid');
  }
  const stages = stagesRaw.map((stage, index) => validateStage(stage, index + 1));
  const recoveredFrom = validateRecoveredFrom(record['recoveredFrom'], taskId);
  const verificationCommand = argvList(record['verificationCommand']);
  if (record['verificationCommand'] !== undefined && record['verificationCommand'] !== null && verificationCommand === null) {
    throw new HistoryError(`Recorded task '${taskId}' has an invalid verificationCommand`, 'history_invalid');
  }
  const autoRepairRaw = record['autoRepair'];
  let autoRepair: HistoryRecord['autoRepair'] = {
    enabled: false, attempts: 0, unchangedFailures: 0, stopReason: null, totalBudgetMs: null,
  };
  if (autoRepairRaw !== undefined && autoRepairRaw !== null) {
    const repair = object(autoRepairRaw);
    autoRepair = {
      enabled: repair['enabled'] === true,
      attempts: integer(repair['attempts']) ?? 0,
      unchangedFailures: integer(repair['unchangedFailures']) ?? 0,
      stopReason: text(repair['stopReason']) ?? null,
      totalBudgetMs: integer(repair['totalBudgetMs']),
    };
  }
  const autoContinueRaw = record['autoContinue'];
  let autoContinue: HistoryRecord['autoContinue'] = {
    enabled: false, attempts: 0, unchangedFailures: 0, stopReason: null, totalBudgetMs: null,
  };
  if (autoContinueRaw !== undefined && autoContinueRaw !== null) {
    const continuation = object(autoContinueRaw);
    autoContinue = {
      enabled: continuation['enabled'] === true,
      attempts: integer(continuation['attempts']) ?? 0,
      unchangedFailures: integer(continuation['unchangedFailures']) ?? 0,
      stopReason: text(continuation['stopReason']) ?? null,
      totalBudgetMs: integer(continuation['totalBudgetMs']),
    };
  }
  const externalRaw = record['externalReview'];
  let externalReview: HistoryRecord['externalReview'] = {
    status: 'none', reviewId: null, stage: null, outcome: null, repairStage: null,
    receiptCount: 0, continuation: null,
  };
  if (externalRaw !== undefined && externalRaw !== null) {
    const review = object(externalRaw);
    externalReview = {
      status: typeof review['status'] === 'string' && EXTERNAL_REVIEW_STATUSES.has(review['status'])
        ? review['status'] : 'none',
      reviewId: text(review['reviewId'], 128),
      stage: integer(review['stage']),
      outcome: typeof review['outcome'] === 'string' && ['pass', 'fail', 'blocked'].includes(review['outcome'])
        ? review['outcome'] : null,
      repairStage: integer(review['repairStage']),
      receiptCount: integer(review['receiptCount']) ?? 0,
      continuation: text(review['continuation'], 64),
    };
  }
  return {
    taskId,
    sessionId,
    workspace,
    state,
    recoveredFrom,
    createdAt,
    updatedAt,
    runtimePid: runtimePid === undefined || runtimePid === null ? null : positiveInteger(runtimePid),
    deliveryStage: deliveryStage === undefined || deliveryStage === null ? null : positiveInteger(deliveryStage),
    verificationCommand,
    codexContinuationCount: integer(record['codexContinuationCount']) ?? 0,
    totalAutoRepairs: integer(record['totalAutoRepairs']) ?? 0,
    totalAutoContinuations: integer(record['totalAutoContinuations']) ?? 0,
    totalReviewRepairs: integer(record['totalReviewRepairs']) ?? 0,
    autoRepair,
    autoContinue,
    externalReview,
    stages,
    errors: stringList(record['errors']) ?? [],
  };
}

function loadTask(taskId: unknown): LoadedTask {
  const id = assertTaskId(taskId);
  const taskDir = taskDirectory(id);
  const bytes = readBounded(taskDir, 'task.json', HISTORY_LIMITS.taskRecordBytes, 'recorded task.json');
  const record = validateRecord(id, parseJson(bytes, 'recorded task.json'));
  return {taskId: id, taskDir, record};
}

/* ------------------------------------------------------------------ projections */

const USAGE_NUMBER_FIELDS = [
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
  'totalTokens', 'componentSumTokens', 'records', 'stagesWithUsage', 'stagesTotal',
] as const;

function usageView(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of USAGE_NUMBER_FIELDS) {
    if (typeof source[field] === 'number' && Number.isFinite(source[field])) out[field] = source[field];
  }
  const cost = source['cost'];
  if (cost && typeof cost === 'object' && !Array.isArray(cost)) {
    const rawCost = cost as Record<string, unknown>;
    out['cost'] = {
      amount: typeof rawCost['amount'] === 'number' && Number.isFinite(rawCost['amount']) ? rawCost['amount'] : null,
      currency: text(rawCost['currency'], 32),
      source: text(rawCost['source'], 100),
    };
  }
  out['recordedOnly'] = true;
  return out;
}

function changeCounts(value: unknown): Record<string, number | null> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  return {
    added: integer(source['added']),
    modified: integer(source['modified']),
    removed: integer(source['removed']),
  };
}

function safeVerificationStatus(value: unknown): string {
  return typeof value === 'string' && VERIFICATION_STATUSES.has(value) ? value : 'unknown';
}

/** VerificationSummary as recorded in a stage result or checkpoint. Never raw status text. */
function verificationSummaryView(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  if (raw === null) return null;
  const status = safeVerificationStatus(raw['status']);
  const runRaw = raw['lastRun'];
  let lastRun: Record<string, unknown> | null = null;
  if (runRaw && typeof runRaw === 'object' && !Array.isArray(runRaw)) {
    const run = runRaw as Record<string, unknown>;
    lastRun = {
      exitCode: signedInteger(run['exitCode']),
      signal: text(run['signal'], 200),
      timedOut: run['timedOut'] === true,
      error: text(run['error'], HISTORY_LIMITS.verificationTailChars),
      stdoutTail: text(run['stdoutTail'], HISTORY_LIMITS.verificationTailChars),
      stderrTail: text(run['stderrTail'], HISTORY_LIMITS.verificationTailChars),
      durationMs: integer(run['durationMs']),
      recordedOnly: true,
    };
  }
  const acceptanceRaw = raw['acceptance'];
  const acceptance = typeof acceptanceRaw === 'string'
    && ['check-passed', 'check-failed', 'not-evaluated', 'not-applicable'].includes(acceptanceRaw)
    ? acceptanceRaw : null;
  return {
    source: 'recorded VerificationSummary (bridge-derived)',
    status,
    configured: raw['configured'] === true,
    attempts: integer(raw['attempts']) ?? 0,
    lastRun,
    notRunReason: text(raw['notRunReason']),
    cancelledDuringRun: raw['cancelledDuringRun'] === true,
    acceptance,
    trigger: raw['trigger'] && typeof raw['trigger'] === 'object' && !Array.isArray(raw['trigger'])
      ? {
        stageState: typeof (raw['trigger'] as Record<string, unknown>)['stageState'] === 'string'
          && TASK_STATE_SET.has((raw['trigger'] as Record<string, unknown>)['stageState'] as string)
          ? (raw['trigger'] as Record<string, unknown>)['stageState'] as string : null,
        turnEndKind: text((raw['trigger'] as Record<string, unknown>)['turnEndKind'], 200),
      }
      : null,
    note: 'Recorded VerificationSummary evidence only. The bridge did not rerun this command for history.',
    recordedOnly: true,
  };
}

/**
 * Native TaskRecord StageRecord.verification is a CommandObservation (argv/cwd/exitCode/...),
 * NOT a VerificationSummary. Derive a fixed status from that observation plus cancellation and
 * protected-integrity facts; never echo an arbitrary stored status string.
 */
function nativeVerificationView(stage: HistoryStage, configured: boolean): Record<string, unknown> {
  const run = stage.verification;
  let status: string;
  let acceptance: string;
  if (stage.verificationCancelledDuringRun) {
    status = 'cancelled-during-run';
    acceptance = 'not-evaluated';
  } else if (stage.verifierIntegrityErrors.length > 0) {
    status = 'errored';
    acceptance = 'check-failed';
  } else if (run !== null) {
    const exitCode = signedInteger(run['exitCode']);
    status = run['timedOut'] === true ? 'timed-out'
      : run['error'] !== null && run['error'] !== undefined ? 'errored'
        : exitCode === 0 ? 'passed'
          : exitCode !== null ? 'failed' : 'errored';
    acceptance = status === 'passed' ? 'check-passed' : 'check-failed';
  } else if (!configured) {
    status = 'not-configured';
    acceptance = 'not-evaluated';
  } else if (stage.finalisedAt === null) {
    status = 'pending';
    acceptance = 'not-evaluated';
  } else {
    status = 'not-run';
    acceptance = 'not-evaluated';
  }
  const runView = run === null ? null : {
    exitCode: signedInteger(run['exitCode']),
    signal: text(run['signal'], 200),
    timedOut: run['timedOut'] === true,
    error: text(run['error'], HISTORY_LIMITS.verificationTailChars),
    durationMs: integer(run['durationMs']),
    ranAt: timestamp(run['ranAt']),
    argv: argvList(run['argv']),
    cwd: text(run['cwd'], HISTORY_LIMITS.stringChars),
    stdoutTail: text(run['stdoutTail'], HISTORY_LIMITS.verificationTailChars),
    stderrTail: text(run['stderrTail'], HISTORY_LIMITS.verificationTailChars),
    recordedOnly: true,
  };
  const integrityReason = stage.verifierIntegrityErrors.length > 0
    ? `protected verifier integrity failure: ${stage.verifierIntegrityErrors.join('; ')}`
    : null;
  return {
    source: 'native TaskRecord StageRecord.verification (CommandObservation)',
    status,
    configured,
    attempts: run === null ? 0 : 1,
    lastRun: runView,
    notRunReason: integrityReason ?? stage.verificationNotRunReason,
    cancelledDuringRun: stage.verificationCancelledDuringRun,
    verifierIntegrityErrors: stage.verifierIntegrityErrors,
    acceptance,
    note: 'Status is derived by the bridge from the recorded native command observation, cancellation and protected-verifier integrity facts. It was not rerun and is not current acceptance.',
    recordedOnly: true,
  };
}

function stageSummary(stage: HistoryStage, configured: boolean): Record<string, unknown> {
  const native = nativeVerificationView(stage, configured);
  return {
    index: stage.index,
    recordedState: stage.state,
    recordedCause: stage.cause,
    recordedCauseDetail: stage.causeDetail,
    recordedElapsedMs: stage.elapsedMs,
    recordedStartedAt: stage.startedAt,
    recordedEndedAt: stage.endedAt,
    recordedFinalisedAt: stage.finalisedAt,
    finalised: stage.finalisedAt !== null,
    modelReportChars: stage.modelReport.length,
    modelReportTruncatedInRecord: stage.modelReport.length > HISTORY_LIMITS.reportPreviewChars,
    verificationStatus: native['status'],
    verificationConfigured: native['configured'],
    verificationExitCode: (native['lastRun'] as Record<string, unknown> | null)?.['exitCode'] ?? null,
    toolCallsTotal: stage.toolCallsTotal,
    toolErrorCount: stage.toolErrorCount,
    fileChangeCounts: stage.fileChanges
      ? {
        added: stage.fileChanges.added.length,
        modified: stage.fileChanges.modified.length,
        removed: stage.fileChanges.removed.length,
      }
      : null,
    recordedOnly: true,
  };
}

function stageDetail(stage: HistoryStage, record: HistoryRecord): Record<string, unknown> {
  const report = scrubText(stage.modelReport);
  const preview = report.length > HISTORY_LIMITS.reportPreviewChars
    ? `${report.slice(0, HISTORY_LIMITS.reportPreviewChars)}\n... [TRUNCATED: ${report.length - HISTORY_LIMITS.reportPreviewChars} of ${report.length} chars omitted]`
    : report;
  return {
    index: stage.index,
    recordedState: stage.state,
    recordedCause: stage.cause,
    recordedCauseDetail: stage.causeDetail,
    recordedElapsedMs: stage.elapsedMs,
    recordedStartedAt: stage.startedAt,
    recordedEndedAt: stage.endedAt,
    recordedFinalisedAt: stage.finalisedAt,
    finalised: stage.finalisedAt !== null,
    modelReport: {
      source: 'persisted model self-report; a claim only, never independent acceptance',
      text: preview,
      chars: stage.modelReport.length,
      truncated: preview.length !== report.length,
      recordedOnly: true,
    },
    observed: {
      toolCallsTotal: stage.toolCallsTotal,
      toolErrorCount: stage.toolErrorCount,
      fileChanges: stage.fileChanges
        ? {
          added: stage.fileChanges.added,
          modified: stage.fileChanges.modified,
          removed: stage.fileChanges.removed,
          counts: {
            added: stage.fileChanges.added.length,
            modified: stage.fileChanges.modified.length,
            removed: stage.fileChanges.removed.length,
          },
          recordedOnly: true,
        }
        : null,
      verification: nativeVerificationView(stage, record.verificationCommand !== null),
      verificationNotRunReason: stage.verificationNotRunReason,
      verificationCancelledDuringRun: stage.verificationCancelledDuringRun,
      verifierIntegrityErrors: stage.verifierIntegrityErrors,
      recordedOnly: true,
    },
    resolvedInRecord: stage.finalisedAt !== null,
    errors: stage.errors,
  };
}

function stageResultView(taskDir: string, record: HistoryRecord, stage: HistoryStage): Record<string, unknown> {
  let bytes: Buffer | null;
  try {
    bytes = optionalBounded(
      taskDir,
      `evidence/stage-${stage.index}-result.json`,
      HISTORY_LIMITS.stageResultBytes,
      `recorded stage-${stage.index} result`,
    );
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_unsafe') throw error;
    return {status: 'invalid', error: text((error as Error).message), recordedOnly: true};
  }
  if (bytes === null) {
    return {
      status: 'missing',
      note: 'No recorded result JSON exists for this stage. The response does not fall back to an earlier stage.',
      recordedOnly: true,
    };
  }
  let raw: Record<string, unknown>;
  try {
    raw = object(parseJson(bytes, `recorded stage-${stage.index} result`));
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_unsafe') throw error;
    return {status: 'invalid', error: text((error as Error).message), recordedOnly: true};
  }
  if (raw['taskId'] !== record.taskId) {
    return {
      status: 'corrupt',
      error: 'recorded result taskId does not match the task directory; content is not exposed',
      recordedOnly: true,
    };
  }
  if (raw['stage'] !== stage.index) {
    return {
      status: 'corrupt',
      error: `recorded result stage does not match requested stage ${stage.index}; content is not exposed`,
      recordedOnly: true,
    };
  }
  const observedRaw = raw['bridgeObserved'];
  const observed = observedRaw && typeof observedRaw === 'object' && !Array.isArray(observedRaw)
    ? observedRaw as Record<string, unknown>
    : {};
  const deliverySummaryRaw = raw['deliverySummary'];
  const deliverySummary = deliverySummaryRaw && typeof deliverySummaryRaw === 'object' && !Array.isArray(deliverySummaryRaw)
    ? deliverySummaryRaw as Record<string, unknown>
    : {};
  const reportRaw = raw['modelReport'];
  const report = reportRaw && typeof reportRaw === 'object' && !Array.isArray(reportRaw)
    ? reportRaw as Record<string, unknown>
    : {};
  const reportText = typeof report['text'] === 'string' ? scrubText(report['text']) : '';
  const reportPreview = reportText.length > HISTORY_LIMITS.reportPreviewChars
    ? `${reportText.slice(0, HISTORY_LIMITS.reportPreviewChars)}\n... [TRUNCATED: ${reportText.length - HISTORY_LIMITS.reportPreviewChars} of ${reportText.length} chars omitted]`
    : reportText;
  return {
    status: 'available',
    recordedTaskId: record.taskId,
    recordedStage: stage.index,
    recordedState: typeof raw['stageState'] === 'string' && TASK_STATE_SET.has(raw['stageState'])
      ? raw['stageState'] : stage.state,
    recordedTaskState: typeof raw['taskState'] === 'string' && TASK_STATE_SET.has(raw['taskState'])
      ? raw['taskState'] : record.state,
    modelReport: {
      source: 'persisted model self-report; a claim only',
      text: reportPreview,
      chars: reportText.length,
      truncated: reportPreview.length !== reportText.length,
      recordedOnly: true,
    },
    verification: verificationSummaryView(
      observed['verification'] && typeof observed['verification'] === 'object' && !Array.isArray(observed['verification'])
        ? observed['verification'] as Record<string, unknown>
        : null,
    ),
    observations: {
      toolCallsTotal: integer(observed['toolCallsTotal']) ?? 0,
      toolErrorCount: integer(observed['toolErrorCount']) ?? 0,
      filesChanged: observed['filesChanged'] && typeof observed['filesChanged'] === 'object' && !Array.isArray(observed['filesChanged'])
        ? {
          added: relativeList((observed['filesChanged'] as Record<string, unknown>)['added']),
          modified: relativeList((observed['filesChanged'] as Record<string, unknown>)['modified']),
          removed: relativeList((observed['filesChanged'] as Record<string, unknown>)['removed']),
          recordedOnly: true,
        }
        : null,
    },
    deliverySummary: {
      productAcceptance: typeof deliverySummary['productAcceptance'] === 'string'
        && ['check-passed', 'failed', 'blocked', 'unverified'].includes(deliverySummary['productAcceptance'])
        ? deliverySummary['productAcceptance'] : null,
      recordedOnly: true,
    },
    unresolved: stringList(raw['unresolved']) ?? [],
    note: 'Projected and scrubbed from the recorded result JSON. No acceptance command was rerun.',
    recordedOnly: true,
  };
}

function checkpointView(taskDir: string, record: HistoryRecord): Record<string, unknown> {
  let bytes: Buffer | null;
  try {
    bytes = optionalBounded(taskDir, 'checkpoint.json', HISTORY_LIMITS.checkpointBytes, 'recorded checkpoint.json');
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_unsafe') throw error;
    return {status: 'invalid', error: text((error as Error).message), recordedOnly: true};
  }
  if (bytes === null) return {status: 'missing', recordedOnly: true};
  let raw: Record<string, unknown>;
  try {
    raw = object(parseJson(bytes, 'recorded checkpoint.json'));
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_unsafe') throw error;
    return {status: 'invalid', error: text((error as Error).message), recordedOnly: true};
  }
  if (raw['schema'] !== 'codex-dsh-bridge/checkpoint@1') {
    return {
      status: 'unsupported-schema',
      schema: text(raw['schema'], 200),
      note: 'Only checkpoint@1 is projected; unknown schemas are reported, not interpreted.',
      recordedOnly: true,
    };
  }
  if (raw['taskId'] !== record.taskId) {
    return {
      status: 'corrupt',
      error: 'recorded checkpoint taskId does not match the task directory; content is not exposed',
      recordedOnly: true,
    };
  }
  const resumeRaw = raw['resume'];
  const resume = resumeRaw && typeof resumeRaw === 'object' && !Array.isArray(resumeRaw)
    ? resumeRaw as Record<string, unknown>
    : {};
  const usageRaw = raw['usage'];
  const usage = usageRaw && typeof usageRaw === 'object' && !Array.isArray(usageRaw)
    ? usageRaw as Record<string, unknown>
    : {};
  return {
    status: 'available',
    schema: 'codex-dsh-bridge/checkpoint@1',
    recordedGeneratedAt: timestamp(raw['generatedAt']),
    recordedReason: text(raw['reason'], 200),
    recordedStage: integer(raw['stage']),
    recordedStageState: typeof raw['stageState'] === 'string' && TASK_STATE_SET.has(raw['stageState']) ? raw['stageState'] : null,
    recordedTaskState: typeof raw['taskState'] === 'string' && TASK_STATE_SET.has(raw['taskState']) ? raw['taskState'] : null,
    verification: verificationSummaryView(
      raw['verification'] && typeof raw['verification'] === 'object' && !Array.isArray(raw['verification'])
        ? raw['verification'] as Record<string, unknown>
        : null,
    ),
    changes: raw['changes'] && typeof raw['changes'] === 'object' && !Array.isArray(raw['changes'])
      ? {
        counts: changeCounts((raw['changes'] as Record<string, unknown>)['counts']),
        recordedOnly: true,
      }
      : null,
    usage: {
      stage: usageView(usage['stage']),
      task: usageView(usage['task']),
      recordedOnly: true,
    },
    automation: raw['automation'] && typeof raw['automation'] === 'object' && !Array.isArray(raw['automation'])
      ? {
        autoContinuationAttempts: integer(((raw['automation'] as Record<string, unknown>)['autoContinue'] as Record<string, unknown> | undefined)?.['attempts']),
        autoContinuationStopReason: text(((raw['automation'] as Record<string, unknown>)['autoContinue'] as Record<string, unknown> | undefined)?.['stopReason']),
        recordedOnly: true,
      }
      : null,
    externalReview: raw['externalReview'] && typeof raw['externalReview'] === 'object' && !Array.isArray(raw['externalReview'])
      ? {
        status: (() => {
          const value = (raw['externalReview'] as Record<string, unknown>)['status'];
          return typeof value === 'string' && EXTERNAL_REVIEW_STATUSES.has(value) ? value : 'none';
        })(),
        stage: integer((raw['externalReview'] as Record<string, unknown>)['stage']),
        repairStage: integer((raw['externalReview'] as Record<string, unknown>)['repairStage']),
        source: 'caller-reported',
        recordedOnly: true,
      }
      : null,
    recordedResumeClaim: {
      canContinueWhileRuntimeAlive: resume['canContinueWhileRuntimeAlive'] === true,
      sdkCrossProcessResume: false,
      note: 'This was an observation at checkpoint time, not a current capability. History never reattaches or continues the recorded process.',
    },
    errors: stringList(raw['errors']) ?? [],
    note: 'Recorded checkpoint evidence. It is not SDK cross-process session recovery and does not establish current runtime liveness.',
    recordedOnly: true,
  };
}

interface DeliveryView {
  status: 'available' | 'missing' | 'invalid';
  exportable: boolean;
  reason: string | null;
  indexSha256: string | null;
  taskId: string | null;
  generatedAt: string | null;
  stageCount: number | null;
  codexContinuationCount: number | null;
  autoRepairCount: number | null;
  autoContinuationCount: number | null;
  reviewRepairCount: number | null;
  externalReviewCount: number | null;
  manualCodexContinuationCount: number | null;
  externalReviewStatus: string | null;
  externalReviews: Array<Record<string, unknown>>;
  firstVerificationPassed: boolean | null;
  latestVerificationStatus: string | null;
  sourceFileCount: number | null;
  sourceMode: 'complete' | 'patch' | null;
  sourceScope: {paths: string[]; exclude: string[]} | null;
  sourceFinalFiles: number | null;
  sourceBaselineFiles: number | null;
  artifactCount: number | null;
  final: boolean | null;
  recordedOnly: true;
}

function emptyDelivery(reason: string, status: DeliveryView['status'] = 'missing'): DeliveryView {
  return {
    status, exportable: false, reason, indexSha256: null, taskId: null, generatedAt: null,
    stageCount: null, codexContinuationCount: null, autoRepairCount: null,
    autoContinuationCount: null, reviewRepairCount: null, externalReviewCount: null,
    manualCodexContinuationCount: null, externalReviewStatus: null, externalReviews: [],
    firstVerificationPassed: null, latestVerificationStatus: null, sourceFileCount: null,
    sourceMode: null, sourceScope: null, sourceFinalFiles: null, sourceBaselineFiles: null,
    artifactCount: null, final: null, recordedOnly: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function verificationRecordShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (typeof value['status'] !== 'string' || !VERIFICATION_STATUSES.has(value['status'])) return false;
  if (typeof value['attempts'] !== 'number' || !Number.isSafeInteger(value['attempts']) || value['attempts'] < 0) return false;
  const run = value['lastRun'];
  if (run !== undefined && run !== null) {
    if (!isRecord(run)) return false;
    if (run['exitCode'] !== undefined && run['exitCode'] !== null
        && (typeof run['exitCode'] !== 'number' || !Number.isSafeInteger(run['exitCode']))) return false;
  }
  return true;
}

function verificationExit(value: Record<string, unknown>): number | null {
  const run = value['lastRun'];
  return isRecord(run) ? signedInteger(run['exitCode']) : null;
}

interface DeliveryIndexValidation {
  ok: boolean;
  reason: string | null;
  metrics: Record<string, unknown> | null;
  hostVerification: Record<string, unknown> | null;
  latest: Record<string, unknown> | null;
  source: Record<string, unknown> | null;
}

/**
 * The single delivery-index predicate shared by `dsh_get_history.delivery.exportable` and the
 * actual historical export. It is pure and checks the exact stage binding, finalisation state and
 * required evidence shape; a wrong type is a failure, never a reason to skip a check. It does not
 * hash artifacts, which `exportDeliveryBundle` still does before creating any destination.
 */
function validateDeliveryIndex(record: HistoryRecord, raw: Record<string, unknown>): DeliveryIndexValidation {
  const fail = (reason: string): DeliveryIndexValidation => ({
    ok: false, reason, metrics: null, hostVerification: null, latest: null, source: null,
  });
  if (raw['schemaVersion'] !== 1) return fail('unsupported delivery index schema');
  if (raw['taskId'] !== record.taskId) return fail('delivery index taskId does not match the task directory');
  if (LIVE_STATE_SET.has(record.state)) return fail(`recorded task state '${record.state}' is not settled`);
  if (record.deliveryStage !== record.stages.length) {
    return fail('the task record has no delivery bound to its latest stage (a later capture failed or never completed)');
  }
  if (record.stages.length === 0) return fail('the task record has no stages');
  if (!record.stages.every((stage) => stage.finalisedAt !== null)) return fail('not every recorded stage is finalised');
  const latestStage = record.stages.at(-1)!;
  if (latestStage.finalisedAt === null) return fail('the latest recorded stage is not finalised');

  const metrics = raw['metrics'];
  if (!isRecord(metrics)) return fail('delivery index metrics is not an object');
  if (typeof metrics['stageCount'] !== 'number' || !Number.isSafeInteger(metrics['stageCount'])) {
    return fail('delivery index metrics.stageCount is not an integer');
  }
  if (metrics['stageCount'] !== record.stages.length) {
    return fail(`delivery index stageCount ${metrics['stageCount']} does not match the latest recorded stage ${record.stages.length}`);
  }
  if (metrics['final'] !== true) return fail('delivery index metrics.final is not true for a finalised task');

  const hostVerification = raw['hostVerification'];
  if (!isRecord(hostVerification)) return fail('delivery index hostVerification is not an object');
  const stages = hostVerification['stages'];
  if (!Array.isArray(stages)) return fail('delivery index hostVerification.stages is not an array');
  if (stages.length !== record.stages.length) {
    return fail(`delivery index hostVerification has ${stages.length} stage(s), but the task record has ${record.stages.length}`);
  }
  const seen = new Set<number>();
  const stageVerifications: Array<Record<string, unknown>> = [];
  for (let index = 0; index < stages.length; index += 1) {
    const entry = stages[index];
    if (!isRecord(entry)) return fail(`delivery index hostVerification.stages[${index}] is not an object`);
    if (entry['stage'] !== index + 1) {
      return fail(`delivery index hostVerification.stages[${index}].stage is not ${index + 1}`);
    }
    if (seen.has(entry['stage'] as number)) return fail('delivery index hostVerification repeats a stage identity');
    seen.add(entry['stage'] as number);
    const verification = entry['verification'];
    if (!verificationRecordShape(verification)) {
      return fail(`delivery index verification for stage ${index + 1} has an invalid verification summary`);
    }
    stageVerifications.push(verification);
  }
  const latest = hostVerification['latest'];
  if (!isRecord(latest)) return fail('delivery index hostVerification.latest is not an object');
  if (!verificationRecordShape(latest)) return fail('delivery index hostVerification.latest is not a valid verification summary');
  const latestBound = stageVerifications.at(-1)!;
  if (latest['status'] !== latestBound['status']
      || latest['attempts'] !== latestBound['attempts']
      || verificationExit(latest) !== verificationExit(latestBound)) {
    return fail('delivery index latest verification is not bound to the latest recorded stage');
  }
  const source = raw['source'];
  if (source !== undefined && source !== null && !isRecord(source)) {
    return fail('delivery index source is not an object');
  }
  if (isRecord(source)) {
    try {
      validateScopedDeliveryIndex(source as never, isRecord(raw['changes']) ? raw['changes'] as never : null);
    } catch (error) {
      return fail(`delivery index scoped source is invalid: ${(error as Error).message}`);
    }
  }
  return {
    ok: true, reason: null, metrics, hostVerification, latest,
    source: isRecord(source) ? source : null,
  };
}

function deliveryView(taskDir: string, record: HistoryRecord): DeliveryView {
  let bytes: Buffer | null;
  try {
    bytes = optionalBounded(taskDir, 'delivery/index.json', HISTORY_LIMITS.deliveryIndexBytes, 'recorded delivery/index.json');
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_unsafe') throw error;
    return emptyDelivery(text((error as Error).message) ?? 'invalid recorded delivery index', 'invalid');
  }
  if (bytes === null) return emptyDelivery('no recorded delivery index exists for this task');
  let raw: Record<string, unknown>;
  try {
    raw = object(parseJson(bytes, 'recorded delivery/index.json'));
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_unsafe') throw error;
    return emptyDelivery(text((error as Error).message) ?? 'invalid recorded delivery index', 'invalid');
  }
  const indexSha256 = createHash('sha256').update(bytes).digest('hex');
  const validation = validateDeliveryIndex(record, raw);
  if (!validation.ok) {
    return {...emptyDelivery(validation.reason ?? 'recorded delivery index is not exportable', 'invalid'), indexSha256};
  }
  const metrics = validation.metrics!;
  const rawReviews = raw['externalReviews'];
  const externalReviews: Array<Record<string, unknown>> = Array.isArray(rawReviews)
    ? rawReviews.slice(0, 20).flatMap((item) => {
      if (!isRecord(item)) return [];
      return [{
        reviewId: text(item['reviewId'], 128),
        stage: integer(item['stage']),
        outcome: typeof item['outcome'] === 'string' && ['pass', 'fail', 'blocked'].includes(item['outcome']) ? item['outcome'] : null,
        status: typeof item['status'] === 'string' && EXTERNAL_REVIEW_STATUSES.has(item['status']) ? item['status'] : null,
        source: 'caller-reported',
        recordedAt: timestamp(item['recordedAt']),
        repairStage: integer(item['repairStage']),
        continuation: text(item['continuation'], 64),
        receiptSha256: typeof item['receiptSha256'] === 'string' && /^[a-f0-9]{64}$/.test(item['receiptSha256']) ? item['receiptSha256'] : null,
        recordedOnly: true,
      }];
    })
    : [];
  const hostReview = validation.hostVerification && isRecord(validation.hostVerification['externalReview'])
    ? validation.hostVerification['externalReview'] as Record<string, unknown>
    : null;
  const externalReviewStatus = hostReview && typeof hostReview['status'] === 'string' && EXTERNAL_REVIEW_STATUSES.has(hostReview['status'])
    ? hostReview['status'] as string
    : (externalReviews[0]?.['status'] as string | null | undefined) ?? null;
  return {
    status: 'available',
    exportable: true,
    reason: null,
    indexSha256,
    taskId: record.taskId,
    generatedAt: timestamp(raw['generatedAt']),
    stageCount: metrics['stageCount'] as number,
    codexContinuationCount: integer(metrics['codexContinuationCount']),
    autoRepairCount: integer(metrics['autoRepairCount']),
    autoContinuationCount: integer(metrics['autoContinuationCount']),
    reviewRepairCount: integer(metrics['reviewRepairCount']),
    externalReviewCount: integer(metrics['externalReviewCount']),
    manualCodexContinuationCount: integer(metrics['manualCodexContinuationCount']),
    externalReviewStatus,
    externalReviews,
    firstVerificationPassed: typeof metrics['firstVerificationPassed'] === 'boolean' ? metrics['firstVerificationPassed'] as boolean : null,
    latestVerificationStatus: safeVerificationStatus(validation.latest!['status']),
    sourceFileCount: validation.source && Array.isArray(validation.source['files']) ? validation.source['files'].length : null,
    sourceMode: validation.source && (validation.source['mode'] === 'complete' || validation.source['mode'] === 'patch')
      ? validation.source['mode'] as 'complete' | 'patch' : null,
    sourceScope: validation.source && isRecord(validation.source['scope'])
      ? {
        paths: Array.isArray((validation.source['scope'] as Record<string, unknown>)['paths'])
          ? ((validation.source['scope'] as Record<string, unknown>)['paths'] as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 64)
          : [],
        exclude: Array.isArray((validation.source['scope'] as Record<string, unknown>)['exclude'])
          ? ((validation.source['scope'] as Record<string, unknown>)['exclude'] as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 64)
          : [],
      } : null,
    sourceFinalFiles: validation.source && isRecord(validation.source['final']) && Array.isArray((validation.source['final'] as Record<string, unknown>)['files'])
      ? ((validation.source['final'] as Record<string, unknown>)['files'] as unknown[]).length : null,
    sourceBaselineFiles: validation.source && isRecord(validation.source['baseline']) && Array.isArray((validation.source['baseline'] as Record<string, unknown>)['files'])
      ? ((validation.source['baseline'] as Record<string, unknown>)['files'] as unknown[]).length : null,
    artifactCount: Array.isArray(raw['artifacts']) ? raw['artifacts'].length : null,
    final: true,
    recordedOnly: true,
  };
}

function responseBytes(value: unknown): number {
  try {
    // Match the MCP reply's pretty-printed JSON size, not a compact estimate.
    return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function baseHistoryEnvelope(record: HistoryRecord, readAt: string): Record<string, unknown> {
  return {
    ok: true,
    source: 'persisted-history',
    runtimeAttached: false,
    runtimeAlive: null,
    canContinue: false,
    canCancel: false,
    note: HISTORY_NOTE,
    readAt,
    observedAt: record.updatedAt,
    taskId: record.taskId,
    recordedState: record.state,
    lastRecordedState: record.state,
    recordedSessionId: record.sessionId,
    recordedRuntimePid: record.runtimePid,
    runtimeAliveNote: 'null means NOT CHECKED. History never probes, signals, reattaches or restarts the recorded PID.',
    recordedWorkspace: text(record.workspace),
    recordedTimestamps: {
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      observedAt: record.updatedAt,
      note: 'recorded on disk at the time the bridge wrote the record; these are not timestamps observed now',
    },
    stageCount: record.stages.length,
    recoveredFrom: record.recoveredFrom,
    recordedDeliveryStage: record.deliveryStage,
    recordedMetrics: {
      codexContinuationCount: record.codexContinuationCount,
      totalAutoRepairs: record.totalAutoRepairs,
      totalAutoContinuations: record.totalAutoContinuations,
      totalReviewRepairs: record.totalReviewRepairs,
      codexDirectEditCount: null,
      recordedOnly: true,
    },
    automationMetrics: {
      autoContinuationCount: record.totalAutoContinuations,
      reviewRepairCount: record.totalReviewRepairs,
      externalReviewCount: record.externalReview.receiptCount,
      manualCodexContinuationCount: record.codexContinuationCount,
      automaticHostRepairCount: record.totalAutoRepairs,
      providerExhaustionContinuationCount: record.totalAutoContinuations,
      reviewTriggeredRepairCount: record.totalReviewRepairs,
      codexDirectEditCount: null,
      recordedOnly: true,
    },
    autoRepair: {...record.autoRepair, recordedOnly: true},
    autoContinue: {...record.autoContinue, recordedOnly: true},
    externalReview: {
      ...record.externalReview,
      source: record.externalReview.status === 'none' ? 'none' : 'caller-reported',
      recordedOnly: true,
    },
    recordedOnly: true,
  };
}

/* ------------------------------------------------------------------ public API */

function validateLimit(raw: unknown): number {
  if (raw === undefined) return HISTORY_LIMITS.listDefault;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > HISTORY_LIMITS.listMax) {
    throw new HistoryError(`limit must be an integer from 1 to ${HISTORY_LIMITS.listMax}`, 'invalid_history_query');
  }
  return raw;
}

function listItem(loaded: LoadedTask): Record<string, unknown> {
  const {record} = loaded;
  return {
    taskId: record.taskId,
    valid: true,
    recordedState: record.state,
    lastRecordedState: record.state,
    stageCount: record.stages.length,
    recordedCreatedAt: record.createdAt,
    recordedUpdatedAt: record.updatedAt,
    recordedRuntimePid: record.runtimePid,
    recordedSessionId: record.sessionId,
    recordedWorkspace: text(record.workspace),
    recoveredFrom: record.recoveredFrom,
    deliveryAvailable: record.deliveryStage === record.stages.length
      && record.stages.at(-1)?.finalisedAt != null,
    autoRepair: {
      enabled: record.autoRepair.enabled,
      attempts: record.autoRepair.attempts,
      stopReason: record.autoRepair.stopReason,
      recordedOnly: true,
    },
    recordedOnly: true,
  };
}

export function listHistory(input: {limit?: unknown} = {}): Record<string, unknown> {
  const limit = validateLimit(input.limit);
  const readAt = new Date().toISOString();
  const root = tasksRoot();
  const items: Array<Record<string, unknown>> = [];
  let discovered = 0;
  let ignoredNames = 0;
  let scanTruncated = false;
  if (root !== null) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, {withFileTypes: true});
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!SAFE_TASK_ID.test(entry.name)) { ignoredNames += 1; continue; }
      if (discovered >= HISTORY_LIMITS.taskDirectories) { scanTruncated = true; break; }
      discovered += 1;
      try {
        items.push(listItem(loadTask(entry.name)));
      } catch (error) {
        // One corrupt/linked task directory must never hide the other valid entries.
        items.push({
          taskId: entry.name,
          valid: false,
          recordedState: null,
          lastRecordedState: null,
          error: text(error instanceof Error ? error.message : String(error), HISTORY_LIMITS.stringChars),
          recordedOnly: true,
        });
      }
    }
  }
  items.sort((left, right) => {
    const leftValid = left['valid'] === true;
    const rightValid = right['valid'] === true;
    if (leftValid !== rightValid) return leftValid ? -1 : 1;
    const updated = String(right['recordedUpdatedAt'] ?? '').localeCompare(String(left['recordedUpdatedAt'] ?? ''));
    return updated !== 0 ? updated : String(left['taskId']).localeCompare(String(right['taskId']));
  });
  const make = (rows: Array<Record<string, unknown>>): Record<string, unknown> => ({
    ok: true,
    source: 'persisted-history',
    runtimeAttached: false,
    runtimeAlive: null,
    canContinue: false,
    canCancel: false,
    readAt,
    note: HISTORY_NOTE,
    tasks: rows,
    total: items.length,
    returned: rows.length,
    limit,
    truncated: items.length > rows.length || scanTruncated,
    scan: {discovered, ignoredNames, truncated: scanTruncated, limit: HISTORY_LIMITS.taskDirectories},
    responseLimitBytes: HISTORY_LIMITS.listResponseBytes,
    recordedOnly: true,
  });
  let returned = items.slice(0, limit);
  let payload = make(returned);
  while (returned.length > 0 && responseBytes(payload) > HISTORY_LIMITS.listResponseBytes - 256) {
    returned = returned.slice(0, -1);
    payload = make(returned);
  }
  if (responseBytes(payload) > HISTORY_LIMITS.listResponseBytes - 256) {
    payload = {...make([]), responseTruncated: true, responseBytes: responseBytes(payload)};
  }
  return {...payload, responseBytes: responseBytes(payload)};
}

export function getHistory(taskId: unknown, stage?: unknown): Record<string, unknown> {
  if (stage !== undefined && (typeof stage !== 'number' || !Number.isSafeInteger(stage) || stage < 1 || stage > HISTORY_LIMITS.stages)) {
    throw new HistoryError(`stage must be an integer from 1 to ${HISTORY_LIMITS.stages}`, 'invalid_history_query');
  }
  const loaded = loadTask(taskId);
  const {record, taskDir} = loaded;
  const selected = stage === undefined ? record.stages.at(-1)! : record.stages.find((item) => item.index === stage);
  if (!selected) {
    throw new HistoryError(
      `task ${record.taskId} has no recorded stage ${String(stage)}; recorded stages are [${record.stages.map((item) => item.index).join(', ')}]`,
      'unknown_stage',
    );
  }
  const readAt = new Date().toISOString();
  const configured = record.verificationCommand !== null;
  const delivery = deliveryView(taskDir, record);
  const payload: Record<string, unknown> = {
    ...baseHistoryEnvelope(record, readAt),
    stages: record.stages.map((item) => stageSummary(item, configured)),
    stage: {
      ...stageDetail(selected, record),
      recordedResult: stageResultView(taskDir, record, selected),
    },
    checkpoint: checkpointView(taskDir, record),
    delivery,
    recordErrors: record.errors,
    limits: {
      taskRecordBytes: HISTORY_LIMITS.taskRecordBytes,
      checkpointBytes: HISTORY_LIMITS.checkpointBytes,
      stageResultBytes: HISTORY_LIMITS.stageResultBytes,
      deliveryIndexBytes: HISTORY_LIMITS.deliveryIndexBytes,
      stages: HISTORY_LIMITS.stages,
      reportPreviewChars: HISTORY_LIMITS.reportPreviewChars,
      responseBytes: HISTORY_LIMITS.responseBytes,
    },
    recordedOnly: true,
  };
  const size = responseBytes(payload);
  if (size <= HISTORY_LIMITS.responseBytes - 256) return {...payload, responseBytes: size};
  const fallback: Record<string, unknown> = {
    ...baseHistoryEnvelope(record, readAt),
    stages: record.stages.slice(0, 10).map((item) => stageSummary(item, configured)),
    stage: {
      index: selected.index,
      recordedState: selected.state,
      recordedStartedAt: selected.startedAt,
      recordedEndedAt: selected.endedAt,
      recordedFinalisedAt: selected.finalisedAt,
      finalised: selected.finalisedAt !== null,
      modelReport: {
        source: 'persisted model self-report; a claim only',
        text: '[OMITTED: projected history exceeded the bounded response size]',
        chars: selected.modelReport.length,
        truncated: true,
        recordedOnly: true,
      },
      observed: {
        toolCallsTotal: selected.toolCallsTotal,
        toolErrorCount: selected.toolErrorCount,
        verification: nativeVerificationView(selected, configured),
        recordedOnly: true,
      },
      recordedOnly: true,
    },
    checkpoint: {status: 'omitted', reason: 'projected history exceeded the bounded response size', recordedOnly: true},
    delivery: {status: delivery.status, exportable: delivery.exportable, reason: delivery.reason, recordedOnly: true},
    recordErrors: [],
    responseBytes: size,
    responseLimitBytes: HISTORY_LIMITS.responseBytes,
    responseTruncated: true,
    note: `${HISTORY_NOTE} The full projected response exceeded the byte limit; detailed arrays and text were omitted.`,
    recordedOnly: true,
  };
  const fallbackSize = responseBytes(fallback);
  if (fallbackSize <= HISTORY_LIMITS.responseBytes - 256) return {...fallback, responseBytes: fallbackSize, originalResponseBytes: size};
  return {
    ...baseHistoryEnvelope(record, readAt),
    stages: [],
    stage: {index: selected.index, recordedState: selected.state, recordedOnly: true},
    checkpoint: {status: 'omitted', recordedOnly: true},
    delivery: {status: delivery.status, exportable: delivery.exportable, recordedOnly: true},
    recordErrors: [],
    responseBytes: fallbackSize,
    originalResponseBytes: size,
    responseLimitBytes: HISTORY_LIMITS.responseBytes,
    responseTruncated: true,
    note: `${HISTORY_NOTE} The full projected response exceeded the byte limit; only the fixed envelope is returned.`,
    recordedOnly: true,
  };
}

/**
 * Export a bundle already recorded on disk when no live ManagedTask exists. Only alignment and
 * identity are checked here; `exportDeliveryBundle` performs the artifact path/hash validation
 * and copies the recorded source bytes. No workspace capture and no acceptance command runs.
 */
export function exportHistoricalDelivery(
  taskId: unknown,
  destination: string,
  options: {allowedExportRoots: readonly string[]},
): ReturnType<typeof exportDeliveryBundle> {
  const loaded = loadTask(taskId);
  const {record, taskDir} = loaded;
  let bytes: Buffer | null;
  try {
    bytes = optionalBounded(taskDir, 'delivery/index.json', HISTORY_LIMITS.deliveryIndexBytes, 'recorded delivery/index.json');
  } catch (error) {
    if (error instanceof HistoryError && error.code === 'history_unsafe') throw error;
    throw new HistoryError((error as Error).message, 'delivery_unavailable');
  }
  if (bytes === null) throw new HistoryError('no delivery index is recorded for this task', 'delivery_unavailable');
  let index: Record<string, unknown>;
  try {
    index = object(parseJson(bytes, 'recorded delivery/index.json'));
  } catch (error) {
    throw new HistoryError((error as Error).message, 'delivery_unavailable');
  }
  const validation = validateDeliveryIndex(record, index);
  if (!validation.ok) {
    throw new HistoryError(
      `recorded delivery index is not exportable: ${validation.reason ?? 'unknown validation failure'}`,
      'delivery_unavailable',
    );
  }
  return exportDeliveryBundle(taskDir, destination, options);
}
