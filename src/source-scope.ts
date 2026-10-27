/**
 * Explicit delivery source scope and reproducible source manifests.
 *
 * Scope paths are workspace-relative files or directories. Traversal, absolute paths, wildcards,
 * drive/ADS syntax, sensitive names and every symbolic link/junction are refused. A complete
 * capture is all-or-nothing: exceeding the file/byte limits or observing a file change mid-read is
 * an error with evidence, never a truncated bundle labelled "complete".
 *
 * The manifest hash binds the canonical sorted descriptor JSON exactly:
 *   [{"path":..., "sha256":..., "bytes":...}, ...]
 * This is the same canonical shape used by the legacy delivery selectionSha256.
 */
import {createHash} from 'node:crypto';
import {closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync} from 'node:fs';
import path from 'node:path';

export type DeliverySourceMode = 'complete' | 'patch';

export interface DeliveryScope {
  paths: string[];
  exclude: string[];
}

export interface DeliverySourceInput extends DeliveryScope {
  mode: DeliverySourceMode;
}

export interface SourceDescriptor {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SourceManifest {
  files: SourceDescriptor[];
  manifestSha256: string;
  capturedAt: string;
}

export interface CapturedSource {
  manifest: SourceManifest;
  bytes: Map<string, Buffer>;
}

export const SOURCE_SCOPE_LIMITS = {
  pathItems: 64,
  pathChars: 4_096,
  files: 2_000,
  bytes: 64 * 1024 * 1024,
  manifestBytes: 8 * 1024 * 1024,
} as const;

export type SourceScopeErrorCode =
  | 'invalid_scope' | 'unsafe_path' | 'sensitive_path' | 'link_refused'
  | 'scope_missing' | 'scope_limit' | 'unstable_read' | 'malformed_manifest';

export class SourceScopeError extends Error {
  constructor(message: string, readonly code: SourceScopeErrorCode) {
    super(message);
    this.name = 'SourceScopeError';
  }
}

const FORBIDDEN_COMPONENT = /^(?:\.env(?:\..*)?|\.git|\.hg|\.svn|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.npmrc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const FORBIDDEN_EXTENSION = /\.(?:pem|p12|pfx|key|keystore)$/i;
const WILDCARD = /[*?[\]{}]/;

function within(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function sensitive(relative: string): boolean {
  return relative.split('/').some((part) => FORBIDDEN_COMPONENT.test(part)) || FORBIDDEN_EXTENSION.test(relative);
}

/** Normalise one declared workspace-relative file/directory path. Symlinks are checked later. */
export function normaliseScopePath(value: unknown, label = 'path'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > SOURCE_SCOPE_LIMITS.pathChars) {
    throw new SourceScopeError(`${label} must be a non-empty string of at most ${SOURCE_SCOPE_LIMITS.pathChars} characters`, 'invalid_scope');
  }
  let text: string = value;
  if (text !== text.trim() || text.includes('\0') || text.includes(':')) {
    throw new SourceScopeError(`${label} contains padding, NUL or drive/ADS syntax: ${JSON.stringify(text)}`, 'unsafe_path');
  }
  if (text.includes('\\')) {
    // Accept Windows separators but treat them as separators, never as an escape.
    text = text.replaceAll('\\', '/');
  }
  if (path.posix.isAbsolute(text) || /^[A-Za-z]:/.test(text)) {
    throw new SourceScopeError(`${label} must be workspace-relative: ${text}`, 'unsafe_path');
  }
  if (WILDCARD.test(text)) throw new SourceScopeError(`${label} must not contain wildcards: ${text}`, 'unsafe_path');
  if (text === '.') return '.';
  while (text.endsWith('/')) text = text.slice(0, -1);
  if (text.length === 0) throw new SourceScopeError(`${label} must not be the filesystem root`, 'unsafe_path');
  const parts = text.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new SourceScopeError(`${label} contains an empty, '.' or '..' component: ${text}`, 'unsafe_path');
  }
  const normalised = parts.join('/');
  if (sensitive(normalised)) throw new SourceScopeError(`${label} names a sensitive path: ${normalised}`, 'sensitive_path');
  if (Buffer.byteLength(normalised, 'utf8') > 4_096) {
    throw new SourceScopeError(`${label} is too long: ${normalised}`, 'unsafe_path');
  }
  return normalised;
}

/** Validate the optional submit/recover `deliverySource` object, or return null when omitted. */
export function parseDeliverySource(raw: unknown): DeliverySourceInput | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SourceScopeError('deliverySource must be an object', 'invalid_scope');
  }
  const value = raw as Record<string, unknown>;
  const mode = value['mode'];
  if (mode !== 'complete' && mode !== 'patch') {
    throw new SourceScopeError("deliverySource.mode must be 'complete' or 'patch'", 'invalid_scope');
  }
  const paths = value['paths'];
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > SOURCE_SCOPE_LIMITS.pathItems) {
    throw new SourceScopeError(`deliverySource.paths must contain 1 to ${SOURCE_SCOPE_LIMITS.pathItems} workspace-relative paths`, 'invalid_scope');
  }
  const excludes = value['exclude'];
  if (excludes !== undefined && (!Array.isArray(excludes) || excludes.length > SOURCE_SCOPE_LIMITS.pathItems)) {
    throw new SourceScopeError(`deliverySource.exclude must contain at most ${SOURCE_SCOPE_LIMITS.pathItems} workspace-relative paths`, 'invalid_scope');
  }
  const dedupe = (items: unknown[], label: string): string[] =>
    [...new Set(items.map((item) => normaliseScopePath(item, label)))].sort();
  const normalisedPaths = dedupe(paths as unknown[], 'deliverySource.paths[]');
  const normalisedExclude = excludes === undefined ? [] : dedupe(excludes as unknown[], 'deliverySource.exclude[]');
  // An excluded path that is not inside any declared path is harmless but ambiguous; keep it
  // explicit rather than silently widening the scope.
  return {mode, paths: normalisedPaths, exclude: normalisedExclude};
}

export function isExcluded(relative: string, exclude: readonly string[]): boolean {
  return exclude.some((item) => item === relative || (item !== '.' && relative.startsWith(`${item}/`)));
}

/** True when a file path is covered by at least one declared scope path and not excluded. */
export function isWithinScope(relative: string, scope: DeliveryScope): boolean {
  const filePath = normaliseScopePath(relative, 'file path');
  if (filePath === '.' || isExcluded(filePath, scope.exclude)) return false;
  return scope.paths.some((item) => item === '.' || item === filePath || filePath.startsWith(`${item}/`));
}

export interface CaptureOptions {
  /**
   * Patch final capture may observe a declared file or whole directory that the task deleted.
   * Only this explicit mode treats ENOENT as absence; complete capture and patch baseline capture
   * remain strict.
   */
  allowMissing?: boolean;
}

/** Resolve a declared scope path with lstat + realpath at every component. */
function resolveDeclared(root: string, relative: string, allowMissing: boolean): string | null {
  if (relative === '.') return root;
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let info;
    try { info = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (allowMissing) return null;
        throw new SourceScopeError(`declared delivery source path is missing: ${relative}`, 'scope_missing');
      }
      throw new SourceScopeError(`cannot inspect delivery source path ${relative}: ${(error as Error).message}`, 'invalid_scope');
    }
    if (info.isSymbolicLink()) throw new SourceScopeError(`symbolic link refused in delivery scope: ${relative}`, 'link_refused');
    let resolved: string;
    try { resolved = realpathSync.native(current); } catch (error) {
      throw new SourceScopeError(`cannot resolve delivery source path ${relative}: ${(error as Error).message}`, 'invalid_scope');
    }
    const expected = path.resolve(current);
    if ((process.platform === 'win32' ? resolved.toLowerCase() !== expected.toLowerCase() : resolved !== expected)) {
      throw new SourceScopeError(`symbolic link or junction refused in delivery scope: ${relative}`, 'link_refused');
    }
    if (!within(root, resolved)) throw new SourceScopeError(`delivery source path escapes the workspace: ${relative}`, 'unsafe_path');
  }
  return current;
}

function collectFiles(
  root: string, relative: string, exclude: readonly string[], out: Map<string, string>, allowMissing: boolean,
): void {
  const absolute = resolveDeclared(root, relative, allowMissing);
  if (absolute === null) return; // explicitly absent in patch final capture only
  if (isExcluded(relative, exclude)) return;
  let info;
  try { info = lstatSync(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) return;
    throw new SourceScopeError(`cannot inspect delivery source path ${relative}: ${(error as Error).message}`, 'unstable_read');
  }
  if (info.isSymbolicLink()) throw new SourceScopeError(`symbolic link refused in delivery scope: ${relative}`, 'link_refused');
  if (info.isFile()) {
    out.set(relative, absolute);
    if (out.size > SOURCE_SCOPE_LIMITS.files) {
      throw new SourceScopeError(`delivery scope exceeds the ${SOURCE_SCOPE_LIMITS.files}-file complete-capture limit`, 'scope_limit');
    }
    return;
  }
  if (!info.isDirectory()) {
    throw new SourceScopeError(`delivery scope contains a non-regular entry: ${relative}`, 'invalid_scope');
  }
  const entries = readdirSync(absolute, {withFileTypes: true})
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
    if (isExcluded(child, exclude)) continue;
    if (sensitive(child)) throw new SourceScopeError(`sensitive path refused in delivery scope: ${child}`, 'sensitive_path');
    const childAbsolute = path.join(absolute, entry.name);
    if (entry.isSymbolicLink()) throw new SourceScopeError(`symbolic link refused in delivery scope: ${child}`, 'link_refused');
    if (entry.isDirectory()) {
      collectFiles(root, child, exclude, out, allowMissing);
    } else if (entry.isFile()) {
      out.set(child, childAbsolute);
      if (out.size > SOURCE_SCOPE_LIMITS.files) {
        throw new SourceScopeError(`delivery scope exceeds the ${SOURCE_SCOPE_LIMITS.files}-file complete-capture limit`, 'scope_limit');
      }
    } else {
      throw new SourceScopeError(`delivery scope contains a non-regular entry: ${child}`, 'invalid_scope');
    }
  }
}

/**
 * Read at most `maxBytes` through a file descriptor. A file that grows past the remaining budget is
 * rejected before another allocation, so a size race cannot turn into an unbounded read.
 */
function readBoundedStable(absolute: string, relative: string, maxBytes: number): Buffer {
  let descriptor: number;
  try { descriptor = openSync(absolute, 'r'); } catch (error) {
    throw new SourceScopeError(`delivery source cannot be opened: ${relative}: ${(error as Error).message}`, 'unstable_read');
  }
  try {
    let opened;
    try { opened = fstatSync(descriptor); } catch (error) {
      throw new SourceScopeError(`delivery source cannot be inspected after open: ${relative}: ${(error as Error).message}`, 'unstable_read');
    }
    if (!opened.isFile() || opened.isSymbolicLink()) {
      throw new SourceScopeError(`delivery source is not a regular file: ${relative}`, 'unstable_read');
    }
    if (opened.size > maxBytes) {
      throw new SourceScopeError(
        `delivery source is ${opened.size} bytes, above the remaining ${maxBytes}-byte scope budget: ${relative}`,
        'scope_limit',
      );
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const want = Math.min(64 * 1024, maxBytes - total + 1);
      if (want <= 0) throw new SourceScopeError(`delivery source exceeds the remaining scope budget: ${relative}`, 'scope_limit');
      const chunk = Buffer.alloc(want);
      let read: number;
      try { read = readSync(descriptor, chunk, 0, want, total); } catch (error) {
        throw new SourceScopeError(`delivery source cannot be read: ${relative}: ${(error as Error).message}`, 'unstable_read');
      }
      if (read === 0) break;
      total += read;
      if (total > maxBytes) {
        throw new SourceScopeError(`delivery source exceeds the remaining scope budget: ${relative}`, 'scope_limit');
      }
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    try { closeSync(descriptor); } catch { /* best effort */ }
  }
}

function descriptorBytes(files: readonly SourceDescriptor[]): string {
  return JSON.stringify(files.map(({path: filePath, sha256, bytes}) => ({path: filePath, sha256, bytes})));
}

export function sourceManifestSha256(files: readonly SourceDescriptor[]): string {
  return createHash('sha256').update(descriptorBytes(files)).digest('hex');
}

export function validateSourceDescriptors(raw: unknown, label: string): SourceDescriptor[] {
  if (!Array.isArray(raw) || raw.length > SOURCE_SCOPE_LIMITS.files) {
    throw new SourceScopeError(`${label} must be an array of at most ${SOURCE_SCOPE_LIMITS.files} file descriptors`, 'malformed_manifest');
  }
  let totalBytes = 0;
  const seen = new Set<string>();
  const files: SourceDescriptor[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new SourceScopeError(`${label}[${index}] is not an object`, 'malformed_manifest');
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry['path'] !== 'string' || entry['path'].length === 0 || entry['path'].length > 4_096) {
      throw new SourceScopeError(`${label}[${index}].path is invalid`, 'malformed_manifest');
    }
    let filePath: string;
    try { filePath = normaliseScopePath(entry['path'], `${label}[${index}].path`); }
    catch (error) { throw new SourceScopeError((error as Error).message, 'malformed_manifest'); }
    if (filePath === '.') throw new SourceScopeError(`${label}[${index}].path must name a file`, 'malformed_manifest');
    if (seen.has(filePath)) throw new SourceScopeError(`${label} repeats ${filePath}`, 'malformed_manifest');
    seen.add(filePath);
    if (typeof entry['bytes'] !== 'number' || !Number.isSafeInteger(entry['bytes']) || entry['bytes'] < 0) {
      throw new SourceScopeError(`${label}[${index}].bytes is invalid`, 'malformed_manifest');
    }
    if (typeof entry['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(entry['sha256'])) {
      throw new SourceScopeError(`${label}[${index}].sha256 is invalid`, 'malformed_manifest');
    }
    totalBytes += entry['bytes'] as number;
    if (totalBytes > SOURCE_SCOPE_LIMITS.bytes) throw new SourceScopeError(`${label} exceeds the ${SOURCE_SCOPE_LIMITS.bytes}-byte limit`, 'scope_limit');
    files.push({path: filePath, bytes: entry['bytes'] as number, sha256: entry['sha256'] as string});
  }
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1]!.path >= files[index]!.path) {
      throw new SourceScopeError(`${label} descriptors must be sorted by strictly ascending path`, 'malformed_manifest');
    }
  }
  return files;
}

export function validateSourceManifest(raw: unknown, label: string): SourceManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SourceScopeError(`${label} is not an object`, 'malformed_manifest');
  }
  const value = raw as Record<string, unknown>;
  const files = validateSourceDescriptors(value['files'], `${label}.files`);
  const expected = sourceManifestSha256(files);
  if (value['manifestSha256'] !== expected) {
    throw new SourceScopeError(`${label}.manifestSha256 does not bind the sorted descriptor list`, 'malformed_manifest');
  }
  if (value['capturedAt'] !== undefined && typeof value['capturedAt'] !== 'string') {
    throw new SourceScopeError(`${label}.capturedAt is invalid`, 'malformed_manifest');
  }
  return {
    files,
    manifestSha256: expected,
    capturedAt: typeof value['capturedAt'] === 'string' ? value['capturedAt'] : new Date(0).toISOString(),
  };
}

/** Bounded, stable, all-or-nothing capture of every regular file in the declared scope. */
export function captureSourceScope(root: string, scope: DeliveryScope, options: CaptureOptions = {}): CapturedSource {
  const realRoot = realpathSync.native(root);
  const allowMissing = options.allowMissing === true;
  const selected = new Map<string, string>();
  for (const declared of scope.paths) {
    const normalised = normaliseScopePath(declared, 'deliverySource.paths[]');
    if (isExcluded(normalised, scope.exclude)) continue;
    collectFiles(realRoot, normalised === '.' ? '.' : normalised, scope.exclude, selected, allowMissing);
  }
  if (selected.size > SOURCE_SCOPE_LIMITS.files) {
    throw new SourceScopeError(
      `delivery scope contains ${selected.size} files, above the ${SOURCE_SCOPE_LIMITS.files}-file complete-capture limit`,
      'scope_limit',
    );
  }
  const paths = [...selected.keys()].sort();
  const files: SourceDescriptor[] = [];
  const bytes = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const relative of paths) {
    const absolute = selected.get(relative)!;
    let before;
    try { before = lstatSync(absolute); } catch (error) {
      throw new SourceScopeError(`delivery source became unreadable during capture: ${relative}: ${(error as Error).message}`, 'unstable_read');
    }
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new SourceScopeError(`delivery source is not a regular file during capture: ${relative}`, 'unstable_read');
    }
    const remaining = SOURCE_SCOPE_LIMITS.bytes - totalBytes;
    if (before.size > remaining) {
      // Known-size rejection happens BEFORE any whole-file allocation.
      throw new SourceScopeError(
        `delivery source is ${before.size} bytes, above the remaining ${remaining}-byte scope budget: ${relative}`,
        'scope_limit',
      );
    }
    const contents = readBoundedStable(absolute, relative, remaining);
    let after;
    try { after = lstatSync(absolute); } catch (error) {
      throw new SourceScopeError(`delivery source disappeared during capture: ${relative}: ${(error as Error).message}`, 'unstable_read');
    }
    if (!after.isFile() || after.isSymbolicLink()
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino
        || contents.length !== after.size) {
      throw new SourceScopeError(`delivery source changed while it was being captured: ${relative}`, 'unstable_read');
    }
    totalBytes += contents.length;
    if (totalBytes > SOURCE_SCOPE_LIMITS.bytes) {
      throw new SourceScopeError(`delivery scope exceeds the ${SOURCE_SCOPE_LIMITS.bytes}-byte complete-capture limit`, 'scope_limit');
    }
    files.push({path: relative, bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex')});
    bytes.set(relative, contents);
  }
  return {
    manifest: {files, manifestSha256: sourceManifestSha256(files), capturedAt: new Date().toISOString()},
    bytes,
  };
}

export interface SourceDiff {
  added: string[];
  modified: string[];
  removed: string[];
  unchanged: string[];
}

export function diffSourceManifests(baseline: SourceManifest, final: SourceManifest): SourceDiff {
  const before = new Map(baseline.files.map((file) => [file.path, file.sha256]));
  const after = new Map(final.files.map((file) => [file.path, file.sha256]));
  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  for (const [filePath, sha256] of after) {
    const previous = before.get(filePath);
    if (previous === undefined) added.push(filePath);
    else if (previous !== sha256) modified.push(filePath);
    else unchanged.push(filePath);
  }
  const removed: string[] = [];
  for (const filePath of before.keys()) if (!after.has(filePath)) removed.push(filePath);
  added.sort(); modified.sort(); removed.sort(); unchanged.sort();
  return {added, modified, removed, unchanged};
}

export function sameManifestFiles(left: SourceManifest, right: SourceManifest): boolean {
  return sourceManifestSha256(left.files) === sourceManifestSha256(right.files);
}
