/**
 * Explicit local import of a scoped delivery bundle.
 *
 * Dry run is the default and creates no directory, file or backup. `--apply` validates the ENTIRE
 * index, every artifact hash, the declared scope and the destination state before the first
 * mutation. Complete import needs a new/empty destination; patch import needs a destination whose
 * declared scope exactly matches the recorded pre-prompt baseline (presence, absence and bytes).
 *
 * Patch changes are backed up to a sibling transaction directory before writing. On a write
 * failure the importer attempts a restore and reports `rollback: complete|partial` honestly; it
 * never claims a rollback it did not verify. No task home, SDK state or model runtime is needed.
 */
import {createHash, randomBytes} from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {validateScopedDeliveryIndex, type DeliveryBundleIndex} from './delivery.js';
import {
  captureSourceScope, diffSourceManifests, sameManifestFiles,
  type SourceDescriptor, type SourceManifest,
} from './source-scope.js';
import {scrubText, truncate} from './evidence.js';

const IMPORT_LIMITS = {indexBytes: 8 * 1024 * 1024, artifactBytes: 64 * 1024 * 1024, artifacts: 4_000};

export class ImportError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportOptions {
  bundle: string;
  destination: string;
  apply: boolean;
}

export interface ImportReport {
  ok: true;
  mode: 'complete' | 'patch';
  applied: boolean;
  dryRun: boolean;
  bundle: string;
  destination: string;
  files: {written: string[]; removed: string[]; unchanged: number};
  backupDirectory: string | null;
  transactionPath: string | null;
  rollback: 'not-needed' | 'not-attempted' | 'complete' | 'partial';
  checks: {
    indexSha256: string;
    artifactsVerified: number;
    finalFiles: number;
    changedFiles: number;
    removedFiles: number;
    destinationExactBaseline: boolean;
  };
  note: string;
}

function sha(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function errorCode(error: unknown): string {
  return (error as {code?: string})?.code ?? 'import_failed';
}

function sanitise(error: unknown): string {
  return truncate(scrubText(error instanceof Error ? error.message : String(error)), 1_000).text;
}

/** POSIX-like relative path validation independent of the caller's platform. */
function relativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value.includes('\0')) {
    throw new ImportError(`${label} is invalid`, 'import_invalid');
  }
  const normalised = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalised) || /^[A-Za-z]:/.test(normalised) || normalised.includes(':')) {
    throw new ImportError(`${label} is not a safe relative path: ${value}`, 'import_invalid');
  }
  const parts = normalised.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new ImportError(`${label} contains an unsafe path component: ${value}`, 'import_invalid');
  }
  return parts.join('/');
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function within(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

/** Refuse a symlink or junction at the path itself and at every existing ancestor below `anchor`. */
function assertNoLinks(anchor: string, target: string): void {
  if (!within(anchor, target)) throw new ImportError('import path escapes its trust anchor', 'import_unsafe');
  let current = anchor;
  for (const part of path.relative(anchor, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw new ImportError(`cannot inspect import path ${current}: ${(error as Error).message}`, 'import_unsafe');
    }
    if (info.isSymbolicLink()) throw new ImportError(`symbolic link or junction refused: ${current}`, 'import_unsafe');
    let resolved;
    try { resolved = realpathSync.native(current); } catch (error) {
      throw new ImportError(`cannot resolve import path ${current}: ${(error as Error).message}`, 'import_unsafe');
    }
    if (!samePath(resolved, path.resolve(current))) {
      throw new ImportError(`symbolic link or junction refused: ${current}`, 'import_unsafe');
    }
  }
}

function resolveDirectory(value: string, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new ImportError(`${label} must be absolute`, 'import_invalid');
  const resolved = path.resolve(value);
  if (resolved.split(path.sep).includes('..')) throw new ImportError(`${label} must not contain traversal`, 'import_invalid');
  let info;
  try { info = lstatSync(resolved); } catch (error) {
    throw new ImportError(`${label} is not accessible: ${(error as Error).message}`, 'import_invalid');
  }
  if (info.isSymbolicLink()) throw new ImportError(`${label} must not be a symbolic link`, 'import_unsafe');
  if (!info.isDirectory()) throw new ImportError(`${label} is not a directory`, 'import_invalid');
  const real = realpathSync.native(resolved);
  if (!samePath(real, resolved)) throw new ImportError(`${label} resolves through a link`, 'import_unsafe');
  return real;
}

function atomicWrite(file: string, bytes: Buffer): void {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== null) try { closeSync(descriptor); } catch { /* best effort */ }
    try { unlinkSync(temporary); } catch { /* not created */ }
    throw error;
  }
}

/**
 * Inspect the ACTUAL artifact before reading it. The index's declared size is untrusted: a
 * tampered oversized file whose record claims a tiny size must fail before any whole-file read or
 * allocation, and a file that grows after inspection must not bypass the budget.
 */
function readArtifactBounded(file: string, relative: string, declaredBytes: number, remaining: number): Buffer {
  let info;
  try { info = lstatSync(file); } catch (error) {
    throw new ImportError(`bundle artifact cannot be inspected: ${relative}: ${(error as Error).message}`, 'import_invalid');
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ImportError(`bundle artifact is not a regular file: ${relative}`, 'import_unsafe');
  }
  if (info.size !== declaredBytes) {
    throw new ImportError(`bundle artifact actual size ${info.size} does not match declared ${declaredBytes}: ${relative}`, 'artifact_tampered');
  }
  if (info.size > remaining) {
    throw new ImportError(`bundle artifacts exceed the byte limit at ${relative}`, 'import_invalid');
  }
  let descriptor: number;
  try { descriptor = openSync(file, 'r'); } catch (error) {
    throw new ImportError(`bundle artifact cannot be opened: ${relative}: ${(error as Error).message}`, 'import_invalid');
  }
  try {
    let opened;
    try { opened = fstatSync(descriptor); } catch (error) {
      throw new ImportError(`bundle artifact cannot be inspected after open: ${relative}: ${(error as Error).message}`, 'import_invalid');
    }
    if (!opened.isFile() || opened.size !== declaredBytes || opened.ino !== info.ino) {
      throw new ImportError(`bundle artifact identity changed during validation: ${relative}`, 'artifact_tampered');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < declaredBytes) {
      const want = Math.min(64 * 1024, declaredBytes - total);
      const chunk = Buffer.alloc(want);
      let read: number;
      try { read = readSync(descriptor, chunk, 0, want, total); } catch (error) {
        throw new ImportError(`bundle artifact cannot be read: ${relative}: ${(error as Error).message}`, 'import_invalid');
      }
      if (read === 0) throw new ImportError(`bundle artifact ended early: ${relative}`, 'artifact_tampered');
      total += read;
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    // Detect growth/identity drift after the bounded read instead of reading the extra bytes.
    let after;
    try { after = fstatSync(descriptor); } catch (error) {
      throw new ImportError(`bundle artifact disappeared during validation: ${relative}: ${(error as Error).message}`, 'artifact_tampered');
    }
    if (!after.isFile() || after.size !== declaredBytes || after.ino !== info.ino || after.mtimeMs !== opened.mtimeMs) {
      throw new ImportError(`bundle artifact changed during validation: ${relative}`, 'artifact_tampered');
    }
    // Also re-inspect the PATH: an atomic replacement during the read must not be accepted merely
    // because the already-open descriptor still yields the old bytes.
    let finalInfo;
    try { finalInfo = lstatSync(file); } catch (error) {
      throw new ImportError(`bundle artifact disappeared during validation: ${relative}: ${(error as Error).message}`, 'artifact_tampered');
    }
    if (finalInfo.isSymbolicLink() || !finalInfo.isFile() || finalInfo.size !== declaredBytes
        || finalInfo.ino !== info.ino || finalInfo.dev !== info.dev) {
      throw new ImportError(`bundle artifact path identity changed during validation: ${relative}`, 'artifact_tampered');
    }
    return Buffer.concat(chunks, total);
  } finally {
    try { closeSync(descriptor); } catch { /* best effort */ }
  }
}

function ensureDirectory(root: string, relative: string): string {
  let current = root;
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ImportError(`destination component is not a real directory: ${relative}`, 'import_unsafe');
      }
    } else {
      mkdirSync(current);
    }
  }
  return current;
}

interface LoadedBundle {
  bundleDir: string;
  index: DeliveryBundleIndex;
  indexBytes: Buffer;
  indexSha256: string;
  scopeView: NonNullable<ReturnType<typeof validateScopedDeliveryIndex>>;
  artifactBytes: Map<string, Buffer>;
  baseline: SourceManifest | null;
  final: SourceManifest;
  changed: SourceDescriptor[];
  removed: string[];
}

function loadBundle(bundle: string): LoadedBundle {
  const bundleDir = resolveDirectory(bundle, 'bundle');
  const indexPath = path.join(bundleDir, 'index.json');
  let info;
  try { info = lstatSync(indexPath); } catch (error) {
    throw new ImportError(`bundle index.json is missing: ${(error as Error).message}`, 'import_invalid');
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new ImportError('bundle index.json is not a regular file', 'import_unsafe');
  if (info.size > IMPORT_LIMITS.indexBytes) throw new ImportError('bundle index.json exceeds the size limit', 'import_invalid');
  const indexBytes = readFileSync(indexPath);
  let index: DeliveryBundleIndex;
  try { index = JSON.parse(indexBytes.toString('utf8')) as DeliveryBundleIndex; }
  catch (error) { throw new ImportError(`bundle index.json is not valid JSON: ${(error as Error).message}`, 'import_invalid'); }
  if (index.schemaVersion !== 1 || !index.source || !Array.isArray(index.source.files)
      || !Array.isArray(index.artifacts) || !Array.isArray(index.evidence)) {
    throw new ImportError('unsupported or invalid delivery index', 'import_invalid');
  }
  if ((index.source as {mode?: unknown}).mode === undefined) {
    throw new ImportError(
      'legacy observed-changes bundles have no deliverySource mode and are evidence exports, not reproducible scoped deliveries',
      'legacy_bundle',
    );
  }
  let scopeView: NonNullable<ReturnType<typeof validateScopedDeliveryIndex>>;
  try { scopeView = validateScopedDeliveryIndex(index.source, index.changes)!; }
  catch (error) { throw new ImportError(`delivery index scope validation failed: ${sanitise(error)}`, 'import_invalid'); }
  if (!scopeView) throw new ImportError('delivery index has no scoped source metadata', 'import_invalid');
  if (index.source.omitted.length > 0) throw new ImportError('scoped bundle declares omitted source files; it is not complete', 'import_incomplete');

  const artifacts = new Map<string, Buffer>();
  const seen = new Set<string>();
  let total = 0;
  for (const artifact of index.artifacts) {
    if (!artifact || typeof artifact.path !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) {
      throw new ImportError('delivery index has an invalid artifact record', 'import_invalid');
    }
    const rel = relativePath(artifact.path, 'artifact path');
    if (!/^(source|evidence)\//.test(rel) || seen.has(rel)) throw new ImportError(`unsafe or repeated artifact path: ${rel}`, 'import_unsafe');
    seen.add(rel);
    const remaining = IMPORT_LIMITS.artifactBytes - total;
    if (artifact.bytes > remaining) throw new ImportError('bundle artifacts exceed the byte limit', 'import_invalid');
    total += artifact.bytes;
    if (seen.size > IMPORT_LIMITS.artifacts) throw new ImportError('bundle has too many artifacts', 'import_invalid');
    assertNoLinks(bundleDir, path.join(bundleDir, rel));
    const bytes = readArtifactBounded(path.join(bundleDir, rel), rel, artifact.bytes, remaining);
    if (sha(bytes) !== artifact.sha256) {
      throw new ImportError(`bundle artifact hash mismatch: ${rel}`, 'artifact_tampered');
    }
    artifacts.set(rel, bytes);
  }
  // Bind source descriptors and evidence to checked artifacts; every artifact must be used.
  const bound = new Set<string>();
  for (const file of index.source.files) {
    const rel = relativePath(file.path, 'source path');
    if (file.artifactPath !== `source/${rel}`) throw new ImportError(`invalid source artifact binding: ${rel}`, 'import_invalid');
    const bytes = artifacts.get(file.artifactPath);
    if (!bytes || sha(bytes) !== file.sha256 || bytes.length !== file.bytes || bound.has(file.artifactPath)) {
      throw new ImportError(`source artifact binding mismatch: ${rel}`, 'import_invalid');
    }
    bound.add(file.artifactPath);
  }
  for (const item of index.evidence) {
    if (item.artifactPath === null) continue;
    const rel = relativePath(item.artifactPath, 'evidence path');
    if (!rel.startsWith('evidence/')) throw new ImportError('evidence artifact is outside evidence/', 'import_invalid');
    const bytes = artifacts.get(rel);
    if (!bytes || (item.sha256 !== null && sha(bytes) !== item.sha256) || bound.has(rel)) {
      throw new ImportError('evidence artifact binding mismatch', 'import_invalid');
    }
    bound.add(rel);
  }
  if (bound.size !== index.artifacts.length) throw new ImportError('bundle has unbound artifacts', 'import_invalid');
  const baseline = scopeView.baseline;
  const diff = baseline === null ? null : diffSourceManifests(baseline, scopeView.final);
  return {
    bundleDir, index, indexBytes, indexSha256: sha(indexBytes), scopeView,
    artifactBytes: artifacts, baseline, final: scopeView.final,
    changed: [...scopeView.changed],
    removed: diff?.removed ?? [],
  };
}

interface DestinationState {
  destination: string;
  exists: boolean;
  createdByImport: boolean;
  baselineVerified: boolean;
}

function preflightDestination(loaded: LoadedBundle, destinationInput: string, apply: boolean): DestinationState {
  if (typeof destinationInput !== 'string' || !path.isAbsolute(destinationInput) || destinationInput.includes('\0')) {
    throw new ImportError('destination must be an absolute path', 'import_invalid');
  }
  const destination = path.resolve(destinationInput);
  if (destination.split(path.sep).includes('..')) throw new ImportError('destination must not contain traversal', 'import_invalid');
  const parent = path.dirname(destination);
  if (destination === parent) throw new ImportError('destination must not be the filesystem root', 'import_invalid');
  let parentInfo;
  try { parentInfo = lstatSync(parent); } catch (error) {
    throw new ImportError(`destination parent does not exist: ${(error as Error).message}`, 'import_invalid');
  }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new ImportError('destination parent is not a real directory', 'import_unsafe');
  }
  const realParent = realpathSync.native(parent);
  if (!samePath(realParent, path.resolve(parent))) throw new ImportError('destination parent resolves through a link', 'import_unsafe');
  assertNoLinks(realParent, destination);

  let exists = false;
  try {
    const info = lstatSync(destination);
    exists = true;
    if (info.isSymbolicLink()) throw new ImportError('destination must not be a symbolic link', 'import_unsafe');
    if (!info.isDirectory()) throw new ImportError('destination exists and is not a directory', 'import_invalid');
    const real = realpathSync.native(destination);
    if (!samePath(real, destination)) throw new ImportError('destination resolves through a link', 'import_unsafe');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }

  if (loaded.scopeView.mode === 'complete') {
    if (exists && readdirSync(destination).length > 0) {
      throw new ImportError('complete import requires a new or empty destination directory', 'destination_not_empty');
    }
    return {destination, exists, createdByImport: apply && !exists, baselineVerified: false};
  }

  if (!exists) throw new ImportError('patch import requires an existing destination to verify the exact baseline', 'destination_missing');
  assertNoLinks(destination, destination);
  let current;
  try { current = captureSourceScope(destination, loaded.scopeView.scope, {allowMissing: true}); }
  catch (error) { throw new ImportError(`destination does not match the delivery scope baseline: ${sanitise(error)}`, 'destination_conflict'); }
  if (loaded.baseline === null || !sameManifestFiles(current.manifest, loaded.baseline)) {
    throw new ImportError('destination scope does not exactly match the recorded pre-prompt baseline (presence, absence and bytes)', 'destination_conflict');
  }
  return {destination, exists, createdByImport: false, baselineVerified: true};
}

function backupDirectoryName(destination: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  return `${destination}.bridge-import-backup-${stamp}-${randomBytes(4).toString('hex')}`;
}

function applyComplete(loaded: LoadedBundle, state: DestinationState): ImportReport['files'] {
  const written: string[] = [];
  try {
    if (!state.exists) { mkdirSync(state.destination); state.createdByImport = true; }
    for (const descriptor of loaded.final.files) {
      const parent = ensureDirectory(state.destination, path.posix.dirname(descriptor.path));
      const target = path.join(parent, path.posix.basename(descriptor.path));
      let info = null;
      try { info = lstatSync(target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (info !== null) throw new ImportError(`complete import would overwrite an unexpected file: ${descriptor.path}`, 'destination_conflict');
      const bytes = loaded.artifactBytes.get(`source/${descriptor.path}`);
      if (!bytes || sha(bytes) !== descriptor.sha256) throw new ImportError(`missing source artifact: ${descriptor.path}`, 'import_invalid');
      atomicWrite(target, bytes);
      written.push(descriptor.path);
    }
    return {written, removed: [], unchanged: 0};
  } catch (error) {
    for (const relative of written.reverse()) {
      try { unlinkSync(path.join(state.destination, ...relative.split('/'))); } catch { /* best effort */ }
    }
    if (state.createdByImport) {
      try { rmSync(state.destination, {recursive: true, force: true}); } catch { /* partial cleanup is reported by the caller */ }
    }
    throw error;
  }
}

function applyPatch(loaded: LoadedBundle, state: DestinationState): {files: ImportReport['files']; backup: string; transaction: string} {
  const destination = state.destination;
  // A final baseline re-check narrows the race between preflight and the first mutation.
  let current;
  try { current = captureSourceScope(destination, loaded.scopeView.scope, {allowMissing: true}); }
  catch (error) { throw new ImportError(`destination changed before apply: ${sanitise(error)}`, 'destination_conflict'); }
  if (loaded.baseline === null || !sameManifestFiles(current.manifest, loaded.baseline)) {
    throw new ImportError('destination changed before apply and no longer matches the exact baseline', 'destination_conflict');
  }
  const backup = backupDirectoryName(destination);
  try { mkdirSync(backup); } catch (error) {
    throw new ImportError(`cannot create the patch backup directory: ${(error as Error).message}`, 'import_backup_failed');
  }
  const baselineMap = new Map(loaded.baseline.files.map((file) => [file.path, file]));
  const changedPaths = new Set(loaded.changed.map((file) => file.path));
  const backupEntries: Array<{path: string; action: 'modified' | 'deleted'; sha256: string}> = [];
  const transactionPath = path.join(backup, 'transaction.json');
  const transaction = (status: string, extra: Record<string, unknown> = {}): void => {
    atomicWrite(transactionPath, Buffer.from(JSON.stringify({
      schema: 'codex-dsh-bridge/import-transaction@1',
      at: new Date().toISOString(),
      bundle: loaded.bundleDir,
      indexSha256: loaded.indexSha256,
      destination,
      mode: 'patch',
      status,
      backup,
      backups: backupEntries,
      changed: [...changedPaths].sort(),
      removed: [...loaded.removed].sort(),
      ...extra,
    }, null, 2)));
  };
  const attach = (wrapped: ImportError, rollback: string): ImportError => {
    (wrapped as ImportError & {backupDirectory?: string; transactionPath?: string; rollback?: string}).backupDirectory = backup;
    (wrapped as ImportError & {backupDirectory?: string; transactionPath?: string; rollback?: string}).transactionPath = transactionPath;
    (wrapped as ImportError & {backupDirectory?: string; transactionPath?: string; rollback?: string}).rollback = rollback;
    return wrapped;
  };

  // PREPARATION: copy and verify EVERY original that could be modified or deleted before the
  // destination is touched. A backup failure here must preserve all originals; it must never run
  // the apply-rollback path (which may delete files that were never written).
  const requiredBackup = [...changedPaths, ...loaded.removed].filter((relative) => baselineMap.has(relative));
  try {
    for (const relative of requiredBackup) {
      const baseline = baselineMap.get(relative)!;
      const source = path.join(destination, ...relative.split('/'));
      const target = path.join(backup, ...relative.split('/'));
      ensureDirectory(backup, path.posix.dirname(relative));
      copyFileSync(source, target);
      const copied = readFileSync(target);
      if (sha(copied) !== baseline.sha256) throw new ImportError(`backup hash mismatch for ${relative}`, 'import_backup_failed');
      backupEntries.push({path: relative, action: changedPaths.has(relative) ? 'modified' : 'deleted', sha256: baseline.sha256});
    }
  } catch (error) {
    try { transaction('backup-failed', {error: sanitise(error)}); } catch { /* transaction report is best effort */ }
    throw attach(new ImportError(
      `patch preparation failed before any destination mutation; every original is preserved: ${sanitise(error)}`,
      'import_backup_failed',
    ), 'not-needed');
  }

  const written: string[] = [];
  const removedDone: string[] = [];
  try {
    transaction('prepared');
    for (const descriptor of loaded.changed) {
      const parent = ensureDirectory(destination, path.posix.dirname(descriptor.path));
      const target = path.join(parent, path.posix.basename(descriptor.path));
      const baseline = baselineMap.get(descriptor.path);
      if (!baseline && existsSync(target)) {
        throw new ImportError(`patch would overwrite an unexpected new file: ${descriptor.path}`, 'destination_conflict');
      }
      const bytes = loaded.artifactBytes.get(`source/${descriptor.path}`);
      if (!bytes || sha(bytes) !== descriptor.sha256) throw new ImportError(`missing changed artifact: ${descriptor.path}`, 'import_invalid');
      atomicWrite(target, bytes);
      written.push(descriptor.path);
      if (sha(readFileSync(target)) !== descriptor.sha256) throw new ImportError(`written file failed verification: ${descriptor.path}`, 'import_write_failed');
    }
    for (const relative of loaded.removed) {
      const target = path.join(destination, ...relative.split('/'));
      try {
        unlinkSync(target);
        removedDone.push(relative);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    for (const relative of loaded.removed) {
      if (existsSync(path.join(destination, ...relative.split('/')))) {
        throw new ImportError(`deletion was not applied: ${relative}`, 'import_write_failed');
      }
    }
    transaction('applied');
    return {
      files: {written, removed: [...loaded.removed], unchanged: Math.max(0, loaded.final.files.length - changedPaths.size)},
      backup,
      transaction: transactionPath,
    };
  } catch (error) {
    // APPLY ROLLBACK: restore only paths this run actually wrote or removed. A baseline path that
    // was never touched is left alone; a missing backup entry is never evidence of "new file".
    const restoreErrors: string[] = [];
    const byPath = new Map(backupEntries.map((entry) => [entry.path, entry]));
    for (const relative of written) {
      const target = path.join(destination, ...relative.split('/'));
      try {
        if (baselineMap.has(relative)) {
          const entry = byPath.get(relative);
          if (!entry) throw new ImportError(`no verified backup for touched path ${relative}`, 'import_backup_failed');
          ensureDirectory(destination, path.posix.dirname(relative));
          atomicWrite(target, readFileSync(path.join(backup, ...relative.split('/'))));
        } else if (existsSync(target)) {
          unlinkSync(target);
        }
      } catch (restoreError) { restoreErrors.push(`${relative}: ${sanitise(restoreError)}`); }
    }
    for (const relative of removedDone) {
      const entry = byPath.get(relative);
      try {
        if (!entry) throw new ImportError(`no verified backup for removed path ${relative}`, 'import_backup_failed');
        ensureDirectory(destination, path.posix.dirname(relative));
        atomicWrite(path.join(destination, ...relative.split('/')), readFileSync(path.join(backup, ...relative.split('/'))));
      } catch (restoreError) { restoreErrors.push(`${relative}: ${sanitise(restoreError)}`); }
    }
    let verified = true;
    try {
      const restored = captureSourceScope(destination, loaded.scopeView.scope, {allowMissing: true});
      verified = loaded.baseline !== null && sameManifestFiles(restored.manifest, loaded.baseline);
    } catch { verified = false; }
    const rollback = restoreErrors.length === 0 && verified ? 'complete' : 'partial';
    try { transaction(rollback, {rollback, restoreErrors, touched: [...new Set([...written, ...removedDone])].sort()}); } catch { /* best effort */ }
    const wrapped = new ImportError(
      `patch apply failed: ${sanitise(error)}; rollback=${rollback}`
      + (restoreErrors.length > 0 ? `; restore errors=${restoreErrors.slice(0, 3).join(' | ')}` : ''),
      'import_write_failed',
    );
    throw attach(wrapped, rollback);
  }
}

/** Validate everything, then (and only with apply=true) mutate the destination. */
export function importDelivery(options: ImportOptions): ImportReport {
  const loaded = loadBundle(options.bundle);
  const state = preflightDestination(loaded, options.destination, options.apply);
  const baseChecks = {
    indexSha256: loaded.indexSha256,
    artifactsVerified: loaded.index.artifacts.length,
    finalFiles: loaded.final.files.length,
    changedFiles: loaded.changed.length,
    removedFiles: loaded.removed.length,
    destinationExactBaseline: state.baselineVerified,
  };
  if (!options.apply) {
    return {
      ok: true, mode: loaded.scopeView.mode, applied: false, dryRun: true,
      bundle: loaded.bundleDir, destination: state.destination,
      files: {
        written: loaded.scopeView.mode === 'complete' ? loaded.final.files.map((file) => file.path) : loaded.changed.map((file) => file.path),
        removed: [...loaded.removed],
        unchanged: loaded.scopeView.mode === 'complete' ? 0 : Math.max(0, loaded.final.files.length - loaded.changed.length),
      },
      backupDirectory: null, transactionPath: null, rollback: 'not-attempted',
      checks: baseChecks,
      note: 'Dry run only: all index/artifact/scope/destination checks passed and no directory or file was created or modified.',
    };
  }
  if (loaded.scopeView.mode === 'complete') {
    const files = applyComplete(loaded, state);
    return {
      ok: true, mode: 'complete', applied: true, dryRun: false,
      bundle: loaded.bundleDir, destination: state.destination, files,
      backupDirectory: null, transactionPath: null, rollback: 'not-needed',
      checks: baseChecks,
      note: 'Complete import wrote every final descriptor into a new/empty destination.',
    };
  }
  const applied = applyPatch(loaded, state);
  return {
    ok: true, mode: 'patch', applied: true, dryRun: false,
    bundle: loaded.bundleDir, destination: state.destination, files: applied.files,
    backupDirectory: applied.backup, transactionPath: applied.transaction, rollback: 'not-needed',
    checks: baseChecks,
    note: 'Patch import preserved out-of-scope files, replaced only recorded changed bytes, deleted the truthful removed list, and retained a sibling backup transaction.',
  };
}

/** CLI entry used by scripts/import-delivery.mjs. Returns a process exit code. */
export function runImportCli(argv: readonly string[]): number {
  const options: {bundle?: string; destination?: string; apply: boolean} = {apply: false};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      if (options.apply) { process.stderr.write('duplicate --apply\n'); return 2; }
      options.apply = true;
      continue;
    }
    if (arg !== '--bundle' && arg !== '--destination') {
      process.stderr.write(`unknown argument: ${String(arg)}\n`);
      return 2;
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      process.stderr.write(`missing value for ${arg}\n`);
      return 2;
    }
    if (arg === '--bundle') {
      if (options.bundle !== undefined) { process.stderr.write('duplicate --bundle\n'); return 2; }
      options.bundle = value;
    } else {
      if (options.destination !== undefined) { process.stderr.write('duplicate --destination\n'); return 2; }
      options.destination = value;
    }
    index += 1;
  }
  if (options.bundle === undefined || options.destination === undefined) {
    process.stderr.write('usage: import-delivery.mjs --bundle <exportDirectory> --destination <directory> [--apply]\n');
    return 2;
  }
  try {
    const report = importDelivery({bundle: options.bundle, destination: options.destination, apply: options.apply});
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const extra = error as ImportError & {backupDirectory?: string; transactionPath?: string; rollback?: string};
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: errorCode(error),
      error: sanitise(error),
      applied: false,
      mutationsAttempted: extra.rollback !== undefined,
      rollback: extra.rollback ?? 'not-attempted',
      backupDirectory: extra.backupDirectory ?? null,
      transactionPath: extra.transactionPath ?? null,
    }, null, 2)}\n`);
    return 1;
  }
}
