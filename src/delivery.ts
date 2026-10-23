/** Host-owned delivery snapshots. Never imports tasks.ts or serializes process.env. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {scrubText, DROP_KEYS} from './evidence.js';

export interface DeliverySnapshot {
  taskId: string;
  workspace: string;
  createdAt: string;
  completedAt?: string | null;
  stageCount: number;
  codexContinuationCount?: number | null;
  autoRepairCount?: number | null;
  firstVerificationPassed?: boolean | null;
  modelReport?: {source: string; text: string};
  hostVerification: unknown;
  changes?: {added: string[]; modified: string[]; removed: string[]};
  unresolved: string[];
  evidence?: Record<string, string | null>;
  dshUsage?: unknown;
  /** Workspace-relative selection. Defaults to observed added and modified files. */
  sourceFiles?: string[];
}

export interface DeliveryFile {
  path: string;
  artifactPath: string;
  bytes: number;
  sha256: string;
}

export interface DeliveryBundleIndex {
  schemaVersion: 1;
  taskId: string;
  generatedAt: string;
  source: {
    workspace: string;
    captureStartedAt: string;
    capturedAt: string;
    gitHead: string | null;
    gitHeadAfterCapture: string | null;
    gitDirty: boolean | null;
    selection: 'explicit' | 'observed-changes';
    files: DeliveryFile[];
    omitted: Array<{path: string; reason: string}>;
    selectionSha256: string;
    note: string;
  };
  changes: {added: string[]; modified: string[]; removed: string[]} | null;
  hostVerification: unknown;
  modelReport: {source: string; text: string; note: string} | null;
  unresolved: string[];
  evidence: Array<{key: string; originalPath: string; artifactPath: string | null; sha256: string | null; error: string | null}>;
  metrics: {
    codexContinuationCount: number | null;
    autoRepairCount: number | null;
    firstVerificationPassed: boolean | null;
    totalDeliveryMs: number | null;
    measurementEndedAt: string;
    final: boolean;
    stageCount: number;
    dshUsage: unknown;
    codexTokens: null;
    codexReviewAndReworkCost: null;
    unknown: string[];
    note: string;
  };
  artifacts: Array<{path: string; bytes: number; sha256: string}>;
  note: string;
}

export interface DeliveryBundlePaths {
  directory: string;
  indexJson: string;
  indexMarkdown: string;
  index: DeliveryBundleIndex;
}

const LIMITS = {sourceFiles: 2_000, sourceBytes: 64 * 1024 * 1024, evidenceBytes: 64 * 1024 * 1024, indexBytes: 8 * 1024 * 1024};
const FORBIDDEN_COMPONENT = /^(?:\.env(?:\..*)?|\.git|\.hg|\.svn|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.npmrc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const FORBIDDEN_EXTENSION = /\.(?:pem|p12|pfx|key|keystore)$/i;
const FORBIDDEN_KEYS = /^(?:env|environment|processEnv|env[_-]?vars|api[_-]?key|apikey|authorization|password|secret|token|access[_-]?token|refresh[_-]?token)$/i;

function hash(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function relativeFile(value: string): string {
  if (!value || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /[:]/.test(value)) throw new Error(`Unsafe relative file path: ${value}`);
  const components = value.replaceAll('\\', '/').split('/');
  if (components.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe relative file path: ${value}`);
  return components.join('/');
}
function sensitive(value: string): boolean {
  return value.replaceAll('\\', '/').split('/').some((part) => FORBIDDEN_COMPONENT.test(part)) || FORBIDDEN_EXTENSION.test(value);
}
function within(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
/** Resolve only descendants; reject every link/junction rather than following an escaping link. */
function safeChild(root: string, relative: string, mustExist = true): string {
  const rel = relativeFile(relative);
  const absolute = path.resolve(root, rel);
  if (!within(root, absolute)) throw new Error(`Path escapes root: ${relative}`);
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    if (!existsSync(current)) {
      // existsSync is false for dangling links; lstat still detects those.
      try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic link refused: ${relative}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (mustExist) throw new Error(`Missing delivery file: ${relative}`);
      continue;
    }
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic link refused: ${relative}`);
    // Windows junctions with a Global device prefix can appear as ordinary directories to
    // lstatSync and JS realpathSync. The native resolver still reveals their actual target.
    const resolved = realpathSync.native(current);
    if ((process.platform === 'win32' ? resolved.toLowerCase() !== current.toLowerCase() : resolved !== current)) throw new Error(`Symbolic link or junction refused: ${relative}`);
    if (!within(root, resolved)) throw new Error(`Resolved path escapes root: ${relative}`);
  }
  return absolute;
}
function safeDirectory(root: string, relative: string): string {
  const target = safeChild(root, relative, false);
  mkdirSync(target, {recursive: true});
  return safeChild(root, relative);
}
function persist(root: string, relative: string, contents: Buffer | string): string {
  const target = safeChild(root, relative, false);
  const parent = path.dirname(relative).split(path.sep).join('/');
  if (parent !== '.') safeDirectory(root, parent);
  // A temporary sibling and rename prevents following an existing file symlink.
  const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, contents, {flag: 'wx'});
  safeChild(root, relative, false);
  renameSync(temporary, target);
  return target;
}
function clean(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[TRUNCATED: depth]';
  if (typeof value === 'string') return scrubText(value).slice(0, 200_000);
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 2_000).map((item) => clean(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !DROP_KEYS.has(key) && !FORBIDDEN_KEYS.test(key)).slice(0, 200).map(([key, item]) => [key, clean(item, depth + 1)]));
  return String(value);
}
function cleanEvidenceText(text: string): string {
  const redactAssignments = (value: string): string => scrubText(value).replace(/\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTHORIZATION)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/g, '[REDACTED ENV]');
  try { return JSON.stringify(clean(JSON.parse(text)), null, 2) + '\n'; }
  catch {
    // JSONL event streams retain one event per line, with sensitive fields removed.
    return text.split('\n').map((line) => {
      try { return JSON.stringify(clean(JSON.parse(line))); }
      catch { return redactAssignments(line); }
    }).join('\n');
  }
}
function count(value: number | null | undefined): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function git(workspace: string, args: string[]): string | null {
  try { return execFileSync('git', ['-C', workspace, ...args], {encoding: 'utf8', timeout: 5_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']}).trim(); }
  catch { return null; }
}
function md(value: string): string { return scrubText(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\\`*_[\]#|]/g, '\\$&').replaceAll('\r', '').replaceAll('\n', ' '); }
function render(index: DeliveryBundleIndex): string {
  const verification = clean(index.hostVerification);
  const serialized = JSON.stringify(verification, null, 2).replaceAll('`', '\\u0060');
  return [
    `# Delivery ${md(index.taskId)}`, '',
    `Captured: ${index.generatedAt}`, '',
    '## Source identity', '',
    `Workspace: ${md(index.source.workspace)}`, '',
    `Git HEAD: ${index.source.gitHead ?? 'unknown'}; dirty: ${String(index.source.gitDirty)}`, '',
    `Selected source SHA-256: ${index.source.selectionSha256}`, '',
    index.source.note, '',
    ...index.source.files.map((file) => `- ${md(file.path)} — ${file.sha256}`),
    ...index.source.omitted.map((file) => `- Omitted ${md(file.path)}: ${md(file.reason)}`), '',
    '## Host verification', '', '```json', serialized, '```', '',
    '## Model conclusion (claim only)', '',
    index.modelReport ? md(index.modelReport.text) : 'No model conclusion recorded.', '',
    '## Changes', '',
    ...(index.changes ? (['added', 'modified', 'removed'] as const).map((kind) => `- ${kind}: ${index.changes![kind].map(md).join(', ') || 'none'}`) : ['Changes were not observed.']), '',
    '## Unresolved', '',
    ...(index.unresolved.length ? index.unresolved.map((item) => `- ${md(item)}`) : ['No unresolved items were recorded; this does not establish product acceptance.']), '',
    '## Evidence', '',
    ...index.evidence.map((item) => `- ${md(item.key)}: ${md(item.artifactPath ?? item.originalPath)}${item.error ? ` (${md(item.error)})` : ` — ${item.sha256}`}`), '',
    '## Measurements', '',
    `- Codex continuations: ${index.metrics.codexContinuationCount ?? 'unknown'}`,
    `- Automatic repairs: ${index.metrics.autoRepairCount ?? 'unknown'}`,
    `- First verification passed: ${index.metrics.firstVerificationPassed ?? 'unknown'}`,
    `- Total delivery time: ${index.metrics.totalDeliveryMs ?? 'unknown'} ms${index.metrics.final ? '' : ' (elapsed at capture; task has not ended)'}`,
    '- Codex tokens / review and rework cost: unknown',
    `- DSH usage: ${md(JSON.stringify(index.metrics.dshUsage))}`, '',
    index.metrics.note, '', index.note, '',
  ].join('\n');
}

/** Capture actual selected bytes now, not model-reported hashes or a later workspace state. */
export function writeDeliveryBundle(taskDir: string, snapshot: DeliverySnapshot): DeliveryBundlePaths {
  const taskRoot = realpathSync.native(taskDir);
  const workspace = realpathSync.native(snapshot.workspace);
  const directory = safeDirectory(taskRoot, 'delivery');
  const captureStartedAt = new Date().toISOString();
  const gitHead = git(workspace, ['rev-parse', 'HEAD']);
  const gitStatus = git(workspace, ['status', '--porcelain', '--untracked-files=normal']);
  const files: DeliveryFile[] = [];
  const omitted: DeliveryBundleIndex['source']['omitted'] = [];
  const artifacts: DeliveryBundleIndex['artifacts'] = [];
  const selected = [...new Set(snapshot.sourceFiles ?? [...snapshot.changes?.added ?? [], ...snapshot.changes?.modified ?? []])].sort();
  let sourceBytes = 0;
  for (const selectedFile of selected) {
    // Unsafe or sensitive explicit selections are refused, never silently marked as exported.
    const rel = relativeFile(selectedFile);
    if (sensitive(rel)) throw new Error(`Sensitive source file refused: ${rel}`);
    const source = safeChild(workspace, rel);
    if (!statSync(source).isFile()) throw new Error(`Source selection is not a regular file: ${rel}`);
    if (files.length >= LIMITS.sourceFiles || sourceBytes + statSync(source).size > LIMITS.sourceBytes) {
      omitted.push({path: rel, reason: 'source capture limit exceeded'});
      continue;
    }
    const bytes = readFileSync(source);
    safeChild(workspace, rel);
    if (sourceBytes + bytes.length > LIMITS.sourceBytes) throw new Error('Source changed while capturing and exceeded size limit');
    sourceBytes += bytes.length;
    const artifactPath = `source/${rel}`;
    persist(directory, artifactPath, bytes);
    files.push({path: rel, artifactPath, bytes: bytes.length, sha256: hash(bytes)});
    artifacts.push({path: artifactPath, bytes: bytes.length, sha256: hash(bytes)});
  }
  let evidenceBytes = 0;
  const evidence: DeliveryBundleIndex['evidence'] = [];
  for (const [key, originalPath] of Object.entries(snapshot.evidence ?? {})) {
    if (originalPath === null) continue;
    const rel = path.relative(taskRoot, path.resolve(originalPath)).split(path.sep).join('/');
    relativeFile(rel);
    if (sensitive(rel)) throw new Error(`Sensitive evidence file refused: ${rel}`);
    const entry: DeliveryBundleIndex['evidence'][number] = {key, originalPath, artifactPath: null, sha256: null, error: null};
    try {
      const source = safeChild(taskRoot, rel);
      if (!statSync(source).isFile()) throw new Error('not a regular file');
      if (evidenceBytes + statSync(source).size > LIMITS.evidenceBytes) throw new Error('evidence capture limit exceeded');
      // Task evidence is already scrubbed by its producer. Scrub again when taking a public snapshot.
      const bytes = Buffer.from(cleanEvidenceText(readFileSync(source, 'utf8')));
      safeChild(taskRoot, rel);
      if (evidenceBytes + bytes.length > LIMITS.evidenceBytes) throw new Error('evidence capture limit exceeded');
      evidenceBytes += bytes.length;
      const artifactPath = `evidence/${evidence.length}-${path.basename(rel)}`;
      persist(directory, artifactPath, bytes);
      entry.artifactPath = artifactPath;
      entry.sha256 = hash(bytes);
      artifacts.push({path: artifactPath, bytes: bytes.length, sha256: entry.sha256});
    } catch (error) {
      // Missing evidence is explicit; escaping links must fail the entire requested capture.
      if (/Symbolic link|escapes root/.test((error as Error).message)) throw error;
      entry.error = scrubText((error as Error).message);
    }
    evidence.push(entry);
  }
  const generatedAt = new Date().toISOString();
  const endedAt = snapshot.completedAt ?? generatedAt;
  const elapsed = Date.parse(endedAt) - Date.parse(snapshot.createdAt);
  const codexContinuationCount = count(snapshot.codexContinuationCount);
  const autoRepairCount = count(snapshot.autoRepairCount);
  const firstVerificationPassed = typeof snapshot.firstVerificationPassed === 'boolean' ? snapshot.firstVerificationPassed : null;
  const unknown = ['codexTokens', 'codexReviewAndReworkCost'];
  if (codexContinuationCount === null) unknown.push('codexContinuationCount');
  if (autoRepairCount === null) unknown.push('autoRepairCount');
  if (firstVerificationPassed === null) unknown.push('firstVerificationPassed');
  if (snapshot.dshUsage === undefined || snapshot.dshUsage === null) unknown.push('dshUsage');
  const index: DeliveryBundleIndex = {
    schemaVersion: 1, taskId: scrubText(snapshot.taskId), generatedAt,
    source: {
      workspace, captureStartedAt, capturedAt: generatedAt,
      gitHead, gitHeadAfterCapture: git(workspace, ['rev-parse', 'HEAD']),
      gitDirty: gitStatus === null ? null : gitStatus.length > 0,
      selection: snapshot.sourceFiles ? 'explicit' : 'observed-changes', files, omitted,
      selectionSha256: hash(JSON.stringify(files.map(({path: filePath, sha256, bytes}) => ({path: filePath, sha256, bytes})))),
      note: 'Hashes bind only the listed bytes captured during this interval, not every workspace file or the exact instant of verification. Selected source bytes are preserved under source/. Git HEAD alone does not identify uncommitted content.',
    },
    changes: snapshot.changes ? clean(snapshot.changes) as DeliveryBundleIndex['changes'] : null,
    hostVerification: clean(snapshot.hostVerification),
    modelReport: snapshot.modelReport ? {...clean(snapshot.modelReport) as {source: string; text: string}, note: 'Model text is a claim, independent of host verification.'} : null,
    unresolved: clean(snapshot.unresolved) as string[], evidence,
    metrics: {
      codexContinuationCount, autoRepairCount, firstVerificationPassed,
      totalDeliveryMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
      measurementEndedAt: endedAt, final: Boolean(snapshot.completedAt), stageCount: count(snapshot.stageCount) ?? 0,
      dshUsage: clean(snapshot.dshUsage), codexTokens: null, codexReviewAndReworkCost: null, unknown,
      note: 'Counts are host observations when supplied. DSH usage retains SDK accounting semantics and is not a provider invoice. Codex review cost and token savings cannot be inferred from DSH usage or continuation counts; comparisons require real task baselines.',
    }, artifacts,
    note: 'This local delivery index records a host snapshot. Export reuses these bytes and validates every recorded artifact hash; it does not rerun verification or promote model claims into acceptance.',
  };
  const json = JSON.stringify(index, null, 2) + '\n';
  if (Buffer.byteLength(json) > LIMITS.indexBytes) throw new Error('Delivery index exceeds size limit');
  const indexMarkdown = persist(directory, 'index.md', render(index));
  const indexJson = persist(directory, 'index.json', json);
  return {directory, indexJson, indexMarkdown, index};
}

/** Explicit local export. Destination must be a new directory under an authorized export root. */
export function exportDeliveryBundle(taskDir: string, destination: string, options: {allowedExportRoots: readonly string[]}): {
  directory: string; indexJson: string; indexMarkdown: string; fileCount: number; indexSha256: string;
} {
  if (!path.isAbsolute(destination) || destination.split(/[\\/]/).includes('..')) throw new Error('Export destination must be absolute without traversal');
  const target = path.resolve(destination);
  let exportRoot: string | null = null;
  let targetRelative = '';
  for (const allowed of options.allowedExportRoots) {
    const lexicalRoot = path.resolve(allowed);
    if (within(lexicalRoot, target) && target !== lexicalRoot) {
      exportRoot = realpathSync.native(lexicalRoot);
      targetRelative = path.relative(lexicalRoot, target).split(path.sep).join('/');
      break;
    }
  }
  if (exportRoot === null) throw new Error('Export destination is outside allowed export roots');
  if (sensitive(targetRelative)) throw new Error('Sensitive export destination refused');
  const resolvedTarget = safeChild(exportRoot, targetRelative, false);
  if (existsSync(resolvedTarget)) throw new Error('Export destination must be a new directory');
  const taskRoot = realpathSync.native(taskDir);
  const directory = safeChild(taskRoot, 'delivery');
  if (within(directory, resolvedTarget) || within(resolvedTarget, directory)) throw new Error('Export destination overlaps the recorded delivery bundle');
  const jsonPath = safeChild(directory, 'index.json');
  if (statSync(jsonPath).size > LIMITS.indexBytes) throw new Error('Delivery index exceeds size limit');
  const json = readFileSync(jsonPath);
  const index = JSON.parse(json.toString('utf8')) as DeliveryBundleIndex;
  if (index.schemaVersion !== 1 || !Array.isArray(index.artifacts) || index.artifacts.length > 4_000 || !Array.isArray(index.source?.files) || !Array.isArray(index.evidence)) throw new Error('Unsupported or invalid delivery index');
  const recorded: Array<{relative: string; source: string}> = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const artifact of index.artifacts) {
    if (!artifact || typeof artifact.path !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) throw new Error('Invalid delivery artifact record');
    const rel = relativeFile(artifact.path);
    if (!/^(source|evidence)\//.test(rel) || sensitive(rel) || seen.has(rel.toLowerCase())) throw new Error(`Unsafe delivery artifact: ${rel}`);
    seen.add(rel.toLowerCase());
    totalBytes += artifact.bytes;
    if (totalBytes > LIMITS.sourceBytes + LIMITS.evidenceBytes) throw new Error('Delivery artifact total exceeds size limit');
    const source = safeChild(directory, rel);
    if (!statSync(source).isFile() || statSync(source).size !== artifact.bytes || hash(readFileSync(source)) !== artifact.sha256) throw new Error(`Delivery artifact hash mismatch: ${rel}`);
    recorded.push({relative: rel, source});
  }
  const bound = new Set<string>();
  for (const file of index.source.files) {
    const rel = relativeFile(file.path);
    if (file.artifactPath !== `source/${rel}`) throw new Error(`Invalid source artifact binding: ${rel}`);
    const entry = index.artifacts.find((artifact) => artifact.path === file.artifactPath);
    if (!entry || entry.sha256 !== file.sha256 || entry.bytes !== file.bytes || bound.has(entry.path)) throw new Error(`Source artifact binding mismatch: ${rel}`);
    bound.add(entry.path);
  }
  if (hash(JSON.stringify(index.source.files.map(({path: filePath, sha256, bytes}) => ({path: filePath, sha256, bytes})))) !== index.source.selectionSha256) throw new Error('Selected source identity mismatch');
  for (const item of index.evidence) {
    if (item.artifactPath === null) continue;
    const entry = index.artifacts.find((artifact) => artifact.path === item.artifactPath);
    if (!entry || !entry.path.startsWith('evidence/') || entry.sha256 !== item.sha256 || bound.has(entry.path)) throw new Error('Evidence artifact binding mismatch');
    bound.add(entry.path);
  }
  if (bound.size !== index.artifacts.length) throw new Error('Unbound delivery artifact refused');
  const markdownPath = safeChild(directory, 'index.md');
  if (!statSync(markdownPath).isFile() || statSync(markdownPath).size > LIMITS.indexBytes) throw new Error('Invalid delivery Markdown index');
  const markdown = readFileSync(markdownPath);
  if (!markdown.equals(Buffer.from(render(index)))) throw new Error('Delivery Markdown does not match recorded index');
  // Validate every source and destination before creating any output.
  safeDirectory(exportRoot, targetRelative);
  for (const artifact of recorded) {
    const output = safeChild(resolvedTarget, artifact.relative, false);
    safeDirectory(resolvedTarget, path.dirname(artifact.relative).split(path.sep).join('/'));
    copyFileSync(artifact.source, output);
  }
  const indexJson = persist(resolvedTarget, 'index.json', json);
  const indexMarkdown = persist(resolvedTarget, 'index.md', markdown);
  return {directory: resolvedTarget, indexJson, indexMarkdown, fileCount: recorded.length + 2, indexSha256: hash(json)};
}
