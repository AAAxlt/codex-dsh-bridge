/** Opt-in read-only checks against the actual, separately installed DSH bundle.
 * No fixture fallback, no model requests, and no skip-on-missing-runtime behavior.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as config from '../src/config.js';

test('configured installed CLI entry belongs to the real DSH package', () => {
  const identity = config.CLI_ENTRY_IDENTITY;
  assert.equal(identity.path, config.CLI_ENTRY);
  assert.equal(identity.exists, true, `configured CLI entry is missing: ${identity.path}`);
  assert.equal(identity.kind, 'real-dsh', `the pinned runtime entry must identify as a real DSH package: ${identity.reason}`);
  assert.equal(identity.packageName, '@deepseek-ai/dsh');
  assert.ok(typeof identity.packageVersion === 'string' && identity.packageVersion.length > 0, 'the DSH package version must be reported');
  assert.equal(config.CLI_ENTRY_IS_REAL, true);
});

test('installed SDK contains all three methods used by the bridge', () => {
  const probe = config.probeSdkMethods();
  assert.equal(probe.available, true, 'the pinned runtime must be readable');
  assert.equal(probe.error, null, `probe reported: ${probe.error}`);
  assert.equal(probe.truncated, false, 'the scan must complete within its byte budget');
  assert.ok(probe.scannedFiles > 0, 'the pinned runtime must be readable');
  assert.ok(probe.scannedBytes > 0);
  for (const method of config.SDK_METHODS) {
    const found = probe.methods.find(m => m.method === method);
    assert.ok(found, `${method} must appear in the probe list`);
    assert.equal(found.found, true, `${method} was not found in the installed bundle`);
    assert.ok(found.files.length > 0);
  }
});
