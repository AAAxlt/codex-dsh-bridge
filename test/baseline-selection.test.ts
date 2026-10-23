/**
 * Runtime baseline selection. The selected 0.2.1-rc.2 runtime and the historic 0.2.0-rc.2 default
 * have different package/file hashes; selecting by canonical root is what prevents a false drift
 * (or a false pass against the wrong runtime).
 */
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, test} from 'node:test';

import {cleanupDir, makeWorkspace, REPO_ROOT, TEST_ROOT} from './helpers.js';

const {selectBaselineForRuntime} = await import(
  pathToFileURL(path.join(REPO_ROOT, 'maintenance', 'guard.mjs')).href
);

const SELECTED_ROOT = '/home/agent/dsh-runtimes/0.2.1-rc.2-20261017';
const DEFAULT_ROOT = '/home/agent/dsh-runtime';
const LINUX_RUNTIMES_PRESENT = existsSync(SELECTED_ROOT) && existsSync(DEFAULT_ROOT)
  && existsSync(path.join(REPO_ROOT, 'baseline', 'runtime-baselines.json'));

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
