import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {exportDeliveryBundle, writeDeliveryBundle, type DeliverySnapshot} from '../src/delivery.js';
import {cleanupDir, makeWorkspace} from './helpers.js';

function fixture(): {root: string; workspace: string; taskDir: string; exportRoot: string; snapshot: DeliverySnapshot} {
  const root = makeWorkspace('delivery');
  const workspace = path.join(root, 'workspace');
  const taskDir = path.join(root, 'task');
  const exportRoot = path.join(root, 'exports');
  for (const dir of [workspace, taskDir, exportRoot]) mkdirSync(dir);
  mkdirSync(path.join(workspace, 'src'));
  writeFileSync(path.join(workspace, 'src', 'answer.ts'), 'export const answer = 42;\n');
  writeFileSync(path.join(taskDir, 'result.json'), JSON.stringify({status: 'failed', output: 'secret=supersecretvalue'}));
  return {
    root, workspace, taskDir, exportRoot,
    snapshot: {
      taskId: 'test-task', workspace, createdAt: '2026-10-22T23:00:00Z', completedAt: '2026-10-22T23:01:00Z',
      stageCount: 3, codexContinuationCount: 1, autoRepairCount: 1, firstVerificationPassed: false,
      hostVerification: {status: 'failed', attempts: 2, exitCode: 7},
      modelReport: {source: 'model', text: 'All tests passed.'},
      changes: {added: ['src/answer.ts'], modified: [], removed: ['obsolete.ts']},
      unresolved: ['host command failed'], evidence: {result: path.join(taskDir, 'result.json')},
      dshUsage: {inputTokens: 321, outputTokens: 78, totalTokens: null},
    },
  };
}

test('delivery preserves captured source bytes and keeps model claims separate from failed host verification', () => {
  const f = fixture();
  try {
    const bundle = writeDeliveryBundle(f.taskDir, f.snapshot);
    const bytes = readFileSync(path.join(f.workspace, 'src', 'answer.ts'));
    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(bundle.index.source.files[0]?.sha256, expected);
    assert.deepEqual(bundle.index.hostVerification, {status: 'failed', attempts: 2, exitCode: 7});
    assert.equal(bundle.index.modelReport?.text, 'All tests passed.');
    assert.equal(bundle.index.metrics.codexContinuationCount, 1);
    assert.equal(bundle.index.metrics.autoRepairCount, 1);
    assert.equal(bundle.index.metrics.firstVerificationPassed, false);
    assert.equal(bundle.index.metrics.totalDeliveryMs, 60_000);
    assert.equal(bundle.index.metrics.codexTokens, null);
    assert.equal(bundle.index.metrics.codexReviewAndReworkCost, null);
    assert.equal(readFileSync(bundle.indexJson, 'utf8').includes('supersecretvalue'), false);
    const evidence = readFileSync(path.join(bundle.directory, 'evidence/0-result.json'), 'utf8');
    assert.equal(evidence.includes('supersecretvalue'), false);
    writeFileSync(path.join(f.workspace, 'src', 'answer.ts'), 'changed after capture');
    const exported = exportDeliveryBundle(f.taskDir, path.join(f.exportRoot, 'final'), {allowedExportRoots: [f.exportRoot]});
    assert.deepEqual(readFileSync(path.join(exported.directory, 'source/src/answer.ts')), bytes);
    assert.equal(exported.fileCount, 4);
    assert.match(readFileSync(exported.indexMarkdown, 'utf8'), /Host verification/);
    assert.equal(JSON.parse(readFileSync(exported.indexJson, 'utf8')).source.files[0].sha256, expected);
  } finally { cleanupDir(f.root); }
});

test('delivery unknown metrics stay unknown and missing evidence is explicit', () => {
  const f = fixture();
  try {
    delete f.snapshot.codexContinuationCount;
    delete f.snapshot.autoRepairCount;
    delete f.snapshot.firstVerificationPassed;
    delete f.snapshot.completedAt;
    delete f.snapshot.dshUsage;
    f.snapshot.evidence = {missing: path.join(f.taskDir, 'not-recorded.json')};
    const bundle = writeDeliveryBundle(f.taskDir, f.snapshot);
    assert.equal(bundle.index.metrics.codexContinuationCount, null);
    assert.equal(bundle.index.metrics.autoRepairCount, null);
    assert.equal(bundle.index.metrics.firstVerificationPassed, null);
    assert.equal(bundle.index.metrics.dshUsage, null);
    assert.equal(bundle.index.metrics.final, false);
    assert.ok(bundle.index.metrics.unknown.includes('dshUsage'));
    assert.match(bundle.index.evidence[0]?.error ?? '', /Missing delivery file/);
    assert.equal(bundle.index.evidence[0]?.artifactPath, null);
  } finally { cleanupDir(f.root); }
});

test('delivery refuses traversal, private environment files, and evidence outside task storage', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.workspace, '.env'), 'API_KEY=private-value');
    for (const sourceFile of ['../escape.ts', 'src/../../escape.ts', 'src\\..\\escape.ts', '.env', 'config/.env.local', '.git/config', 'id_ed25519', 'src/a.ts:stream']) {
      assert.throws(() => writeDeliveryBundle(f.taskDir, {...f.snapshot, sourceFiles: [sourceFile]}), /Unsafe|Sensitive/);
    }
    assert.throws(() => writeDeliveryBundle(f.taskDir, {...f.snapshot, evidence: {bad: path.join(f.workspace, 'src', 'answer.ts')}}), /Unsafe/);
    assert.throws(() => writeDeliveryBundle(f.taskDir, {...f.snapshot, evidence: {bad: path.join(f.taskDir, '.env')}}), /Sensitive/);
  } finally { cleanupDir(f.root); }
});

test('delivery export refuses tampered bytes, malicious index paths, unauthorized roots, and overwrite', () => {
  const f = fixture();
  try {
    const bundle = writeDeliveryBundle(f.taskDir, f.snapshot);
    const destination = path.join(f.exportRoot, 'final');
    assert.throws(() => exportDeliveryBundle(f.taskDir, path.join(f.root, 'unauthorized'), {allowedExportRoots: [f.exportRoot]}), /outside allowed/);
    assert.throws(() => exportDeliveryBundle(f.taskDir, f.exportRoot + path.sep + '..' + path.sep + 'escape', {allowedExportRoots: [f.exportRoot]}), /without traversal/);
    writeFileSync(path.join(bundle.directory, 'source/src/answer.ts'), 'tampered');
    assert.throws(() => exportDeliveryBundle(f.taskDir, destination, {allowedExportRoots: [f.exportRoot]}), /hash mismatch/);
    assert.equal(existsSync(destination), false, 'validation fails before any destination is created');
    writeDeliveryBundle(f.taskDir, f.snapshot);
    const index = JSON.parse(readFileSync(bundle.indexJson, 'utf8'));
    index.artifacts[0].path = '../result.json';
    writeFileSync(bundle.indexJson, JSON.stringify(index));
    assert.throws(() => exportDeliveryBundle(f.taskDir, destination, {allowedExportRoots: [f.exportRoot]}), /Unsafe/);
    writeDeliveryBundle(f.taskDir, f.snapshot);
    const identityMismatch = JSON.parse(readFileSync(bundle.indexJson, 'utf8'));
    identityMismatch.source.files[0].sha256 = 'a'.repeat(64);
    writeFileSync(bundle.indexJson, JSON.stringify(identityMismatch));
    assert.throws(() => exportDeliveryBundle(f.taskDir, destination, {allowedExportRoots: [f.exportRoot]}), /binding mismatch/);
    writeDeliveryBundle(f.taskDir, f.snapshot);
    writeFileSync(bundle.indexMarkdown, 'All tests passed (tampered report)');
    assert.throws(() => exportDeliveryBundle(f.taskDir, destination, {allowedExportRoots: [f.exportRoot]}), /Markdown does not match/);
    writeDeliveryBundle(f.taskDir, f.snapshot);
    exportDeliveryBundle(f.taskDir, destination, {allowedExportRoots: [f.exportRoot]});
    assert.throws(() => exportDeliveryBundle(f.taskDir, destination, {allowedExportRoots: [f.exportRoot]}), /new directory/);
  } finally { cleanupDir(f.root); }
});

test('delivery refuses source and export junction escape', () => {
  const f = fixture();
  try {
    const link = path.join(f.workspace, 'outside');
    symlinkSync(f.taskDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => writeDeliveryBundle(f.taskDir, {...f.snapshot, sourceFiles: ['outside/result.json']}), /Symbolic link/);
    writeDeliveryBundle(f.taskDir, f.snapshot);
    const exportLink = path.join(f.exportRoot, 'linked');
    symlinkSync(f.workspace, exportLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => exportDeliveryBundle(f.taskDir, path.join(exportLink, 'final'), {allowedExportRoots: [f.exportRoot]}), /Symbolic link/);
    symlinkSync(f.workspace, path.join(f.taskDir, 'evidence-link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => writeDeliveryBundle(f.taskDir, {...f.snapshot, evidence: {bad: path.join(f.taskDir, 'evidence-link', 'src', 'answer.ts')}}), /Symbolic link/);
  } finally { cleanupDir(f.root); }
});

test('delivery strips environment and reasoning from structured snapshots', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.taskDir, 'result.json'), JSON.stringify({status: 'failed', environment: {API_KEY: 'never-copy-evidence-env'}, reasoning: 'never-copy-evidence-reasoning'}));
    const bundle = writeDeliveryBundle(f.taskDir, {...f.snapshot,
      hostVerification: {status: 'failed', environment: {PRIVATE_VALUE: 'never-copy-this'}, reasoning: 'internal-thought', output: 'Bearer qwertyuiopasdfghjkl1234'},
      dshUsage: {inputTokens: 9, apiKey: 'never-copy-key', processEnv: {OTHER: 'never-copy-env'}},
    });
    const serialized = readFileSync(bundle.indexJson, 'utf8');
    for (const secret of ['never-copy-this', 'internal-thought', 'qwertyuiopasdfghjkl1234', 'never-copy-key', 'never-copy-env']) assert.equal(serialized.includes(secret), false);
    assert.deepEqual(bundle.index.metrics.dshUsage, {inputTokens: 9});
    const evidence = readFileSync(path.join(bundle.directory, 'evidence/0-result.json'), 'utf8');
    assert.equal(evidence.includes('never-copy-evidence-env'), false);
    assert.equal(evidence.includes('never-copy-evidence-reasoning'), false);
  } finally { cleanupDir(f.root); }
});
