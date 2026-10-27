/**
 * Runtime baseline selection. The selected 0.2.1-rc.2 runtime and the historic 0.2.0-rc.2 default
 * have different package/file hashes; selecting by canonical root is what prevents a false drift
 * (or a false pass against the wrong runtime).
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, test} from 'node:test';

import {cleanupDir, makeWorkspace, REPO_ROOT, TEST_ROOT} from './helpers.js';

const {ASSETS, selectBaselineForRuntime} = await import(
  pathToFileURL(path.join(REPO_ROOT, 'maintenance', 'guard.mjs')).href
);

const SELECTED_ROOT = '/home/agent/dsh-runtimes/0.2.1-rc.2-20261017';
const DEFAULT_ROOT = '/home/agent/dsh-runtime';
const LINUX_RUNTIMES_PRESENT = existsSync(SELECTED_ROOT) && existsSync(DEFAULT_ROOT)
  && existsSync(path.join(REPO_ROOT, 'baseline', 'runtime-baselines.json'));

const REGISTRY_FILE = path.join(REPO_ROOT, 'baseline', 'runtime-baselines.json');
const LOCAL_BASELINES: string[] = (() => {
  if (!existsSync(REGISTRY_FILE)) return [];
  try {
    const registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as {baselines?: Array<{baselineFile?: unknown}>};
    return (registry.baselines ?? [])
      .map((entry) => typeof entry.baselineFile === 'string' ? path.resolve(REPO_ROOT, entry.baselineFile) : '')
      .filter((file) => file.length > 0 && existsSync(file));
  } catch { return []; }
})();

describe('trusted runtime baseline selection', () => {
  test('selects the explicit 0.2.1-rc.2 baseline for the actual selected runtime', {skip: !LINUX_RUNTIMES_PRESENT}, () => {
    const selected = selectBaselineForRuntime(SELECTED_ROOT, REPO_ROOT);
    assert.equal(selected.id, 'selected-0.2.1-rc.2-20261017');
    assert.equal(selected.dshVersion, '0.2.1-rc.2');
    assert.match(selected.baselineFile, /execution-profiles-baseline-0\.2\.1-rc\.2-20261017\.json$/);
    assert.match(selected.baselineSha256, /^[a-f0-9]{64}$/);
  });

  test('keeps the historic default baseline explicit and separate', {skip: !LINUX_RUNTIMES_PRESENT}, () => {
    const legacy = selectBaselineForRuntime(DEFAULT_ROOT, REPO_ROOT);
    assert.equal(legacy.id, 'legacy-default-0.2.0-rc.2');
    assert.equal(legacy.dshVersion, '0.2.0-rc.2');
    assert.match(legacy.baselineFile, /execution-profiles-baseline\.json$/);
    assert.notEqual(legacy.baselineFile, selectBaselineForRuntime(SELECTED_ROOT, REPO_ROOT).baselineFile);
  });

  test('guard ASSETS include the history projection and every configured asset exists', () => {
    assert.ok(ASSETS.includes('dist/src/history.js'),
      'history.js projects review/automation facts and must be guarded');
    for (const rel of ASSETS) {
      assert.ok(existsSync(path.join(REPO_ROOT, rel)), `guarded asset is missing: ${rel}`);
    }
    assert.match(readFileSync(path.join(REPO_ROOT, 'src/history.ts'), 'utf8'), /externalReview/,
      'the guarded history module must be the review-aware source');
  });

  test('local runtime baselines bind every guarded asset, including history.js', {skip: LOCAL_BASELINES.length === 0}, () => {
    for (const file of LOCAL_BASELINES) {
      const baseline = JSON.parse(readFileSync(file, 'utf8')) as {files?: Record<string, string>};
      assert.ok(baseline.files && typeof baseline.files === 'object', `baseline has no files map: ${file}`);
      for (const rel of ASSETS) {
        const key = `assets/${rel}`;
        assert.ok(typeof baseline.files[key] === 'string', `baseline ${path.basename(file)} does not guard ${key}`);
        const actual = createHash('sha256').update(readFileSync(path.join(REPO_ROOT, rel))).digest('hex');
        assert.equal(baseline.files[key], actual, `baseline ${path.basename(file)} is stale for ${key}`);
      }
    }
  });

  test('refuses an unregistered runtime instead of falling back to another baseline', () => {
    mkdirSync(TEST_ROOT, {recursive: true});
    const unknown = makeWorkspace('unknown-runtime');
    try {
      // A public checkout contains no installation-specific registry. Exercise refusal
      // against an explicitly empty local registry rather than the developer's machine.
      mkdirSync(path.join(unknown, 'baseline'));
      writeFileSync(path.join(unknown, 'baseline', 'runtime-baselines.json'), JSON.stringify({
        schema: 'codex-dsh-bridge/runtime-baselines@1', baselines: [],
      }));
      assert.throws(
        () => selectBaselineForRuntime(unknown, unknown),
        /no trusted baseline registered.*refusing to reuse another runtime's baseline/s,
      );
    } finally {
      cleanupDir(unknown);
    }
  });
});
