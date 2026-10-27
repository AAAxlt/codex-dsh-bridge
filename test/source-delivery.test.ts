/**
 * Explicit source scope, reproducible complete/patch export and import regressions.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {exportDeliveryBundle, writeDeliveryBundle, type DeliverySnapshot} from '../src/delivery.js';
import {importDelivery, ImportError} from '../src/delivery-import.js';
import {captureSourceScope, parseDeliverySource, SOURCE_SCOPE_LIMITS, SourceScopeError} from '../src/source-scope.js';
import {REPO_ROOT, cleanupDir} from './helpers.js';

const IMPORT = path.join(REPO_ROOT, 'scripts', 'import-delivery.mjs');
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, {withFileTypes: true, recursive: true})) {
    if (entry.isFile()) {
      const full = path.join(entry.parentPath, entry.name);
      out[path.relative(root, full).split(path.sep).join('/')] = sha(readFileSync(full));
    }
  }
  return out;
}

function fixture(): {root: string; workspace: string; taskDir: string; exports: string; snapshot: DeliverySnapshot} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-scope-'));
  const workspace = path.join(root, 'workspace');
  const taskDir = path.join(root, 'task');
  const exports = path.join(root, 'exports');
  for (const dir of [workspace, taskDir, exports]) mkdirSync(dir, {recursive: true});
  mkdirSync(path.join(workspace, 'src'));
  writeFileSync(path.join(workspace, 'package.json'), '{"name":"scope"}\n');
  writeFileSync(path.join(workspace, 'src', 'keep.txt'), 'BEFORE\n');
  writeFileSync(path.join(workspace, 'src', 'obsolete.txt'), 'OLD\n');
  writeFileSync(path.join(workspace, 'src', 'unchanged.txt'), 'PRESERVE\n');
  const snapshot: DeliverySnapshot = {
    taskId: 'dsh-20261025000000-scope01', workspace,
    createdAt: '2026-10-25T00:00:00Z', completedAt: '2026-10-25T00:01:00Z',
    stageCount: 1, hostVerification: {status: 'not-configured'},
    changes: {added: ['src/new.txt'], modified: ['src/keep.txt'], removed: ['src/obsolete.txt']},
    unresolved: [],
  };
  return {root, workspace, taskDir, exports, snapshot};
}

function runImport(bundle: string, destination: string, apply = false) {
  return spawnSync(process.execPath, [IMPORT, '--bundle', bundle, '--destination', destination, ...(apply ? ['--apply'] : [])], {
    encoding: 'utf8', timeout: 20_000,
  });
}

test('complete scope captures unchanged and new files and imports into a clean directory', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.workspace, 'src', 'keep.txt'), 'AFTER\n');
    writeFileSync(path.join(f.workspace, 'src', 'new.txt'), 'NEW\n');
    rmSync(path.join(f.workspace, 'src', 'obsolete.txt'));
    const bundle = writeDeliveryBundle(f.taskDir, {
      ...f.snapshot,
      sourceScope: {mode: 'complete', scope: {paths: ['package.json', 'src'], exclude: []}},
    });
    assert.equal(bundle.index.source.mode, 'complete');
    assert.ok(bundle.index.source.final?.files.some((file) => file.path === 'src/unchanged.txt'));
    assert.deepEqual(bundle.index.source.files.map((file) => file.path), bundle.index.source.final?.files.map((file) => file.path));
    const exported = exportDeliveryBundle(f.taskDir, path.join(f.exports, 'complete'), {allowedExportRoots: [f.exports]});
    const imported = path.join(f.root, 'imported');
    const dry = runImport(exported.directory, imported);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.equal(existsSync(imported), false, 'dry run must not create the destination');
    const applied = runImport(exported.directory, imported, true);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.deepEqual(tree(imported), tree(f.workspace), 'complete import must reproduce every final descriptor');
  } finally { cleanupDir(f.root); }
});

test('patch scope binds a pre-prompt baseline, exports only changed bytes, and imports atomically', () => {
  const f = fixture();
  try {
    const baseline = captureSourceScope(f.workspace, {paths: ['package.json', 'src'], exclude: []}).manifest;
    writeFileSync(path.join(f.workspace, 'src', 'keep.txt'), 'AFTER\n');
    writeFileSync(path.join(f.workspace, 'src', 'new.txt'), 'NEW\n');
    rmSync(path.join(f.workspace, 'src', 'obsolete.txt'));
    const bundle = writeDeliveryBundle(f.taskDir, {
      ...f.snapshot,
      sourceScope: {mode: 'patch', scope: {paths: ['package.json', 'src'], exclude: []}, baseline},
    });
    assert.equal(bundle.index.source.mode, 'patch');
    assert.equal(bundle.index.source.baseline?.manifestSha256, baseline.manifestSha256);
    assert.deepEqual(bundle.index.source.files.map((file) => file.path).sort(), ['src/keep.txt', 'src/new.txt']);
    assert.deepEqual(bundle.index.changes?.removed, ['src/obsolete.txt']);
    const exported = exportDeliveryBundle(f.taskDir, path.join(f.exports, 'patch'), {allowedExportRoots: [f.exports]});

    const destination = path.join(f.root, 'patched');
    cpSync(f.workspace, destination, {recursive: true});
    // Restore the pre-prompt baseline in the destination, plus an unrelated out-of-scope file.
    writeFileSync(path.join(destination, 'src', 'keep.txt'), 'BEFORE\n');
    writeFileSync(path.join(destination, 'src', 'obsolete.txt'), 'OLD\n');
    rmSync(path.join(destination, 'src', 'new.txt'));
    writeFileSync(path.join(destination, 'outside.txt'), 'OUTSIDE\n');

    const conflict = path.join(f.root, 'conflict');
    cpSync(destination, conflict, {recursive: true});
    writeFileSync(path.join(conflict, 'src', 'unchanged.txt'), 'CONFLICT\n');
    const before = tree(conflict);
    const rejected = runImport(exported.directory, conflict, true);
    assert.notEqual(rejected.status, 0);
    assert.deepEqual(tree(conflict), before, 'a baseline conflict must make zero destination mutations');

    const applied = runImport(exported.directory, destination, true);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.equal(readFileSync(path.join(destination, 'src', 'keep.txt'), 'utf8'), 'AFTER\n');
    assert.equal(readFileSync(path.join(destination, 'src', 'new.txt'), 'utf8'), 'NEW\n');
    assert.equal(readFileSync(path.join(destination, 'src', 'unchanged.txt'), 'utf8'), 'PRESERVE\n');
    assert.equal(readFileSync(path.join(destination, 'outside.txt'), 'utf8'), 'OUTSIDE\n');
    assert.equal(existsSync(path.join(destination, 'src', 'obsolete.txt')), false);
    const report = JSON.parse(applied.stdout);
    assert.equal(report.mode, 'patch');
    assert.ok(report.transactionPath && existsSync(report.transactionPath));
    const transaction = JSON.parse(readFileSync(report.transactionPath, 'utf8'));
    assert.equal(transaction.status, 'applied');
  } finally { cleanupDir(f.root); }
});

test('tampered artifacts and a non-empty complete destination are refused before mutation', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.workspace, 'src', 'keep.txt'), 'AFTER\n');
    const bundle = writeDeliveryBundle(f.taskDir, {
      ...f.snapshot,
      sourceScope: {mode: 'complete', scope: {paths: ['package.json', 'src'], exclude: []}},
    });
    const exported = exportDeliveryBundle(f.taskDir, path.join(f.exports, 'complete'), {allowedExportRoots: [f.exports]});
    const artifact = path.join(exported.directory, bundle.index.source.files[0]!.artifactPath);
    const original = readFileSync(artifact);
    writeFileSync(artifact, 'TAMPERED');
    try {
      const target = path.join(f.root, 'tampered-target');
      const rejected = runImport(exported.directory, target, true);
      assert.notEqual(rejected.status, 0);
      assert.equal(existsSync(target), false);
    } finally { writeFileSync(artifact, original); }

    const nonEmpty = path.join(f.root, 'non-empty');
    mkdirSync(nonEmpty);
    writeFileSync(path.join(nonEmpty, 'keep-me.txt'), 'x');
    const before = tree(nonEmpty);
    const refused = runImport(exported.directory, nonEmpty, true);
    assert.notEqual(refused.status, 0);
    assert.deepEqual(tree(nonEmpty), before);
  } finally { cleanupDir(f.root); }
});

test('scope validation refuses sensitive paths, traversal, wildcards and links', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.workspace, '.env'), 'SECRET=1\n');
    assert.throws(() => parseDeliverySource({mode: 'complete', paths: ['../escape']}), SourceScopeError);
    assert.throws(() => parseDeliverySource({mode: 'complete', paths: ['src/*.ts']}), SourceScopeError);
    assert.throws(() => parseDeliverySource({mode: 'complete', paths: ['/etc/passwd']}), SourceScopeError);
    assert.throws(() => parseDeliverySource({mode: 'complete', paths: ['.env']}), SourceScopeError);
    assert.throws(
      () => captureSourceScope(f.workspace, {paths: ['.'], exclude: []}),
      (error: unknown) => error instanceof SourceScopeError && error.code === 'sensitive_path',
    );
    symlinkSync(path.join(f.workspace, 'package.json'), path.join(f.workspace, 'src', 'link.json'));
    assert.throws(
      () => captureSourceScope(f.workspace, {paths: ['src'], exclude: []}),
      (error: unknown) => error instanceof SourceScopeError && error.code === 'link_refused',
    );
  } finally { cleanupDir(f.root); }
});

test('a backup failure before any apply preserves every destination original', () => {
  const f = fixture();
  try {
    const scope = {paths: ['package.json', 'src'], exclude: []};
    const baseline = captureSourceScope(f.workspace, scope).manifest;
    writeFileSync(path.join(f.workspace, 'src', 'keep.txt'), 'UPDATED\n');
    writeFileSync(path.join(f.workspace, 'src', 'obsolete.txt'), 'UPDATED OLD\n');
    const bundle = writeDeliveryBundle(f.taskDir, {
      ...f.snapshot,
      sourceScope: {mode: 'patch', scope, baseline},
    });
    const destination = path.join(f.root, 'backup-failure-dest');
    cpSync(f.workspace, destination, {recursive: true});
    // Restore the pre-prompt baseline so the patch preflight succeeds.
    writeFileSync(path.join(destination, 'src', 'keep.txt'), 'BEFORE\n');
    writeFileSync(path.join(destination, 'src', 'obsolete.txt'), 'OLD\n');
    const before = tree(destination);

    const mutable = fs as unknown as {copyFileSync: (...args: any[]) => void};
    const original = mutable.copyFileSync;
    let faultReached = false;
    mutable.copyFileSync = function (from: any, to: any, ...rest: any[]) {
      if (String(to).includes('.bridge-import-backup-') && path.basename(String(to)) === 'obsolete.txt') {
        faultReached = true;
        const error = new Error('test backup failure') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      }
      return original.call(fs, from, to, ...rest);
    };
    syncBuiltinESMExports();
    let error: unknown;
    try {
      importDelivery({bundle: bundle.directory, destination, apply: true});
    } catch (caught) { error = caught; } finally {
      mutable.copyFileSync = original;
      syncBuiltinESMExports();
    }
    assert.ok(faultReached);
    assert.ok(error instanceof ImportError);
    assert.equal((error as ImportError).code, 'import_backup_failed');
    assert.equal((error as ImportError & {rollback?: string}).rollback, 'not-needed');
    assert.deepEqual(tree(destination), before, 'a preparation failure must never run apply rollback');
  } finally { cleanupDir(f.root); }
});

test('a mid-apply write failure restores only touched files and reports verified rollback', () => {
  const f = fixture();
  try {
    const scope = {paths: ['package.json', 'src'], exclude: []};
    const baseline = captureSourceScope(f.workspace, scope).manifest;
    writeFileSync(path.join(f.workspace, 'src', 'keep.txt'), 'UPDATED\n');
    writeFileSync(path.join(f.workspace, 'src', 'obsolete.txt'), 'UPDATED OLD\n');
    const bundle = writeDeliveryBundle(f.taskDir, {
      ...f.snapshot,
      sourceScope: {mode: 'patch', scope, baseline},
    });
    const destination = path.join(f.root, 'mid-apply-dest');
    cpSync(f.workspace, destination, {recursive: true});
    writeFileSync(path.join(destination, 'src', 'keep.txt'), 'BEFORE\n');
    writeFileSync(path.join(destination, 'src', 'obsolete.txt'), 'OLD\n');
    const before = tree(destination);

    const mutable = fs as unknown as {renameSync: (...args: any[]) => void};
    const original = mutable.renameSync;
    mutable.renameSync = function (from: any, to: any, ...rest: any[]) {
      if (path.basename(String(to)) === 'obsolete.txt' && String(from).includes('.tmp')) {
        const error = new Error('test mid-apply rename failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return original.call(fs, from, to, ...rest);
    };
    syncBuiltinESMExports();
    let error: unknown;
    try {
      importDelivery({bundle: bundle.directory, destination, apply: true});
    } catch (caught) { error = caught; } finally {
      mutable.renameSync = original;
      syncBuiltinESMExports();
    }
    assert.ok(error instanceof ImportError);
    assert.equal((error as ImportError & {rollback?: string}).rollback, 'complete');
    assert.deepEqual(tree(destination), before, 'rollback must restore touched bytes and never remove untouched originals');
  } finally { cleanupDir(f.root); }
});

test('known oversize source and misdeclared artifact are rejected before whole-file reads', () => {
  const f = fixture();
  try {
    const large = path.join(f.workspace, 'src', 'large.bin');
    const fd = fs.openSync(large, 'w');
    fs.ftruncateSync(fd, SOURCE_SCOPE_LIMITS.bytes + 1);
    fs.closeSync(fd);
    const mutable = fs as unknown as {readFileSync: (...args: any[]) => any};
    const originalRead = mutable.readFileSync;
    let sourceReads = 0;
    mutable.readFileSync = function (file: any, ...rest: any[]) {
      if (typeof file !== 'number' && path.resolve(String(file)) === large) {
        sourceReads += 1;
        throw new Error('whole-file-read-observed');
      }
      return originalRead.call(fs, file, ...rest);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => captureSourceScope(f.workspace, {paths: ['src'], exclude: []}),
        (error: unknown) => error instanceof SourceScopeError && error.code === 'scope_limit',
      );
    } finally {
      mutable.readFileSync = originalRead;
      syncBuiltinESMExports();
    }
    assert.equal(sourceReads, 0);

    rmSync(large);
    const bundle = writeDeliveryBundle(f.taskDir, {
      ...f.snapshot,
      sourceScope: {mode: 'complete', scope: {paths: ['package.json', 'src'], exclude: []}},
    });
    const exported = exportDeliveryBundle(f.taskDir, path.join(f.exports, 'oversize-artifact'), {allowedExportRoots: [f.exports]});
    const artifact = path.join(exported.directory, bundle.index.source.files[0]!.artifactPath);
    const artifactFd = fs.openSync(artifact, 'w');
    fs.ftruncateSync(artifactFd, SOURCE_SCOPE_LIMITS.bytes + 1);
    fs.closeSync(artifactFd);
    const destination = path.join(f.root, 'oversize-artifact-dest');
    let artifactReads = 0;
    const mutable2 = fs as unknown as {readFileSync: (...args: any[]) => any};
    const originalRead2 = mutable2.readFileSync;
    mutable2.readFileSync = function (file: any, ...rest: any[]) {
      if (typeof file !== 'number' && path.resolve(String(file)) === artifact) {
        artifactReads += 1;
        throw new Error('whole-artifact-read-observed');
      }
      return originalRead2.call(fs, file, ...rest);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => importDelivery({bundle: exported.directory, destination, apply: true}),
        (error: unknown) => error instanceof ImportError && error.code === 'artifact_tampered',
      );
    } finally {
      mutable2.readFileSync = originalRead2;
      syncBuiltinESMExports();
    }
    assert.equal(artifactReads, 0);
    assert.equal(existsSync(destination), false);
  } finally { cleanupDir(f.root); }
});

test('a directly declared file can be deleted and round-trips through patch import', () => {
  const f = fixture();
  try {
    const scope = {paths: ['src/keep.txt', 'src/obsolete.txt'], exclude: []};
    const baseline = captureSourceScope(f.workspace, scope).manifest;
    writeFileSync(path.join(f.workspace, 'src', 'keep.txt'), 'AFTER\n');
    rmSync(path.join(f.workspace, 'src', 'obsolete.txt'));
    const bundle = writeDeliveryBundle(f.taskDir, {
      ...f.snapshot,
      sourceScope: {mode: 'patch', scope, baseline},
    });
    assert.deepEqual(bundle.index.changes?.removed, ['src/obsolete.txt']);
    assert.deepEqual(bundle.index.source.final?.files.map((file) => file.path), ['src/keep.txt']);
    const exported = exportDeliveryBundle(f.taskDir, path.join(f.exports, 'direct-delete'), {allowedExportRoots: [f.exports]});

    const destination = path.join(f.root, 'direct-delete-dest');
    cpSync(f.workspace, destination, {recursive: true});
    writeFileSync(path.join(destination, 'src', 'keep.txt'), 'BEFORE\n');
    writeFileSync(path.join(destination, 'src', 'obsolete.txt'), 'OLD\n');
    const applied = importDelivery({bundle: exported.directory, destination, apply: true});
    assert.equal(applied.ok, true);
    assert.equal(readFileSync(path.join(destination, 'src', 'keep.txt'), 'utf8'), 'AFTER\n');
    assert.equal(existsSync(path.join(destination, 'src', 'obsolete.txt')), false);

    const conflict = path.join(f.root, 'direct-delete-conflict');
    cpSync(f.workspace, conflict, {recursive: true});
    writeFileSync(path.join(conflict, 'src', 'keep.txt'), 'BEFORE\n');
    writeFileSync(path.join(conflict, 'src', 'obsolete.txt'), 'OLD\n');
    writeFileSync(path.join(conflict, 'src', 'keep.txt'), 'CONFLICT\n');
    const before = tree(conflict);
    assert.throws(
      () => importDelivery({bundle: exported.directory, destination: conflict, apply: true}),
      (error: unknown) => error instanceof ImportError && error.code === 'destination_conflict',
    );
    assert.deepEqual(tree(conflict), before);
  } finally { cleanupDir(f.root); }
});

test('a wholly deleted declared directory is an explicit patch absence, not scope_missing', () => {
  const f = fixture();
  try {
    const scope = {paths: ['src'], exclude: []};
    const baseline = captureSourceScope(f.workspace, scope).manifest;
    rmSync(path.join(f.workspace, 'src'), {recursive: true});
    const bundle = writeDeliveryBundle(f.taskDir, {
      ...f.snapshot,
      sourceScope: {mode: 'patch', scope, baseline},
    });
    assert.deepEqual(bundle.index.source.final?.files, []);
    assert.deepEqual(bundle.index.source.files, []);
    assert.deepEqual(bundle.index.changes?.removed, ['src/keep.txt', 'src/obsolete.txt', 'src/unchanged.txt']);
    const destination = path.join(f.root, 'whole-dir-dest');
    cpSync(f.workspace, destination, {recursive: true});
    // Restore the pre-prompt directory for the destination baseline.
    mkdirSync(path.join(destination, 'src'));
    writeFileSync(path.join(destination, 'src', 'keep.txt'), 'BEFORE\n');
    writeFileSync(path.join(destination, 'src', 'obsolete.txt'), 'OLD\n');
    writeFileSync(path.join(destination, 'src', 'unchanged.txt'), 'PRESERVE\n');
    const applied = importDelivery({bundle: bundle.directory, destination, apply: true});
    assert.equal(applied.ok, true);
    for (const name of ['keep.txt', 'obsolete.txt', 'unchanged.txt']) {
      assert.equal(existsSync(path.join(destination, 'src', name)), false);
    }
  } finally { cleanupDir(f.root); }
});

test('legacy observed-changes indexes remain readable and are explicitly not importable', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.workspace, 'src', 'keep.txt'), 'AFTER\n');
    const bundle = writeDeliveryBundle(f.taskDir, {...f.snapshot, sourceFiles: ['src/keep.txt']});
    assert.equal(bundle.index.source.selection, 'explicit');
    assert.equal((bundle.index.source as {mode?: string}).mode, undefined);
    assert.equal((bundle.index.source as {final?: unknown}).final, undefined);
    const exported = exportDeliveryBundle(f.taskDir, path.join(f.exports, 'legacy'), {allowedExportRoots: [f.exports]});
    const destination = path.join(f.root, 'legacy-import');
    const refused = runImport(exported.directory, destination, true);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /legacy_bundle/);
    assert.equal(existsSync(destination), false);
  } finally { cleanupDir(f.root); }
});
