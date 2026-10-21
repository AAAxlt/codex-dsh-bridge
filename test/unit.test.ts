/**
 * Unit tests for the boundary guard, the read-only probes and the evidence scrubber.
 * Uses temporary package metadata and SDK method strings, not an installed DSH runtime.
 * Real installation assertions live in installed-runtime.test.ts and are opt-in.
 */
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {after, describe, test} from 'node:test';

const TEST_ROOT = process.platform === 'win32'
  ? 'D:\\AGENTS\\temp\\codex-dsh-bridge-tests'
  : path.join(os.tmpdir(), 'codex-dsh-bridge-tests');
const SECOND_ROOT = process.platform === 'win32'
  ? 'D:\\AGENTS\\workspaces'
  : path.join(os.tmpdir(), 'codex-dsh-bridge-second-root');
/** A real directory that is NOT under any allowed root: the parent of the test root. */
const OUTSIDE = path.dirname(TEST_ROOT);

// Set configuration before importing its module-level constants. This sample is
// deliberately not executable: it tests metadata discovery and text scanning only.
mkdirSync(TEST_ROOT, {recursive: true});
const UNIT_RUNTIME_ROOT = mkdtempSync(path.join(TEST_ROOT, 'probe-package-'));
const packageRoot = path.join(UNIT_RUNTIME_ROOT, 'node_modules', '@deepseek-ai');
const launcherRoot = path.join(packageRoot, 'dsh');
const sdkRoot = path.join(packageRoot, 'dsh-sdk-protocol', 'lib');
mkdirSync(path.join(launcherRoot, 'lib'), {recursive: true});
mkdirSync(sdkRoot, {recursive: true});
writeFileSync(path.join(launcherRoot, 'package.json'), JSON.stringify({name: '@deepseek-ai/dsh', version: '0.0.0-unit-test'}));
writeFileSync(path.join(launcherRoot, 'lib', 'bin.js'), 'throw new Error("metadata sample must never execute");\n');
writeFileSync(path.join(sdkRoot, 'registered-methods.js'), 'export const methods = ["initialize", "session/prompt", "shutdown"];\n');
process.env['DSH_BRIDGE_RUNTIME_ROOT'] = UNIT_RUNTIME_ROOT;
process.env['DSH_BRIDGE_CLI_ENTRY'] = path.join(launcherRoot, 'lib', 'bin.js');
process.env['DSH_BRIDGE_ALLOWED_ROOTS'] = [TEST_ROOT, SECOND_ROOT].join(path.delimiter);
process.env['DSH_BRIDGE_DESKTOP_PROFILE_PATCH'] = path.join(UNIT_RUNTIME_ROOT, 'no-desktop-profile.yml');

const config = await import('../src/config.js');
const evidence = await import('../src/evidence.js');
const prompts = await import('../src/prompts.js');

/** The scripted test double this repo ships; used to prove the entry classifier tells it apart. */
const FAKE_RUNTIME = fileURLToPath(new URL('../../test/fixtures/fake-runtime.mjs', import.meta.url));

describe('workspace boundary guard', () => {
  test('accepts a directory inside an allowed root and returns its real path', () => {
    const inside = path.join(TEST_ROOT, 'guard-accept');
    mkdirSync(inside, {recursive: true});
    const check = config.checkWorkspace(inside);
    assert.equal(check.ok, true, JSON.stringify(check));
    if (check.ok) {
      assert.equal(check.realPath, realpathSync(inside));
      assert.equal(config.checkWorkspace(inside).ok, true, 'must be stable across repeated calls');
    }
  });

  test('rejects a directory outside every allowed root', () => {
    const check = config.checkWorkspace(OUTSIDE);
    assert.equal(check.ok, false);
    if (!check.ok) assert.match(check.reason, /outside the allowed roots/);
  });

  test('rejects traversal that climbs out of an allowed root', () => {
    const check = config.checkWorkspace(path.join(TEST_ROOT, '..', '..'));
    assert.equal(check.ok, false);
  });

  test('rejects a relative path', () => {
    const check = config.checkWorkspace(['relative', 'dir'].join(path.sep));
    assert.equal(check.ok, false);
    if (!check.ok) assert.match(check.reason, /absolute/);
  });

  test('rejects a path that does not exist rather than creating it', () => {
    const check = config.checkWorkspace(path.join(TEST_ROOT, 'does-not-exist-9f3a'));
    assert.equal(check.ok, false);
    if (!check.ok) assert.match(check.reason, /does not exist/);
  });

  test('rejects a file where a directory is required', () => {
    const file = path.join(TEST_ROOT, 'a-file.txt');
    writeFileSync(file, 'not a directory');
    const check = config.checkWorkspace(file);
    assert.equal(check.ok, false);
    if (!check.ok) assert.match(check.reason, /not a directory/);
  });

  test('rejects non-string and empty input', () => {
    assert.equal(config.checkWorkspace(undefined).ok, false);
    assert.equal(config.checkWorkspace('').ok, false);
    assert.equal(config.checkWorkspace(42).ok, false);
  });

  test('isInside is relative-path based, not a string prefix test', () => {
    const root = TEST_ROOT;
    assert.equal(config.isInside(root, path.join(root, 'x')), true);
    assert.equal(config.isInside(root, root), true);
    // The prefix case is the whole point: '<root>-evil' must not count as inside '<root>'.
    assert.equal(config.isInside(root, `${root}-evil`), false);
    assert.equal(config.isInside(root, path.dirname(root)), false);
  });
});

describe('CLI entry identification', () => {
  test('identifies package metadata in a temporary tree, distinct from an executable runtime check', () => {
    // A package-name classification is not proof that this synthetic tree is a working SDK.
    const identity = config.CLI_ENTRY_IDENTITY;
    assert.equal(identity.path, config.CLI_ENTRY);
    assert.equal(identity.exists, true, `sample CLI entry is missing: ${identity.path}`);
    assert.equal(identity.kind, 'real-dsh', `package metadata classification failed: ${identity.reason}`);
    assert.equal(identity.packageName, '@deepseek-ai/dsh');
    assert.equal(identity.packageVersion, '0.0.0-unit-test');
    assert.equal(config.CLI_ENTRY_IS_REAL, true);

    // The scripted double must be recognised as one, so the real-DSH credential gate stays open.
    const double = config.identifyCliEntry(FAKE_RUNTIME);
    assert.equal(double.kind, 'test-double', `got '${double.kind}' (${double.reason})`);
    assert.equal(double.exists, true);
    // The double rule is directory-based, so any entry inside a fixtures directory is a double.
    assert.equal(config.identifyCliEntry(path.join(path.dirname(FAKE_RUNTIME), 'anything.js')).kind, 'test-double');

    // Neither a real runtime nor a recognised double must report as unknown, naming the package it
    // was actually found in - i.e. the classifier states why it did not accept the entry.
    const unrelated = config.identifyCliEntry(path.join(path.dirname(path.dirname(FAKE_RUNTIME)), 'not-a-runtime.js'));
    assert.equal(unrelated.kind, 'unknown', `got '${unrelated.kind}' (${unrelated.reason})`);
    assert.equal(unrelated.packageName, 'codex-dsh-bridge');
  });
});

describe('read-only SDK method probe', () => {
  test('finds registered method strings in a synthetic SDK package without executing it', () => {
    const probe = config.probeSdkMethods();
    assert.equal(probe.available, true, 'the synthetic package must be readable');
    assert.equal(probe.error, null, `probe reported: ${probe.error}`);
    assert.equal(probe.truncated, false, 'the scan must complete within its byte budget, not silently stop early');
    assert.ok(probe.scannedFiles > 0, 'the synthetic package must be readable');
    assert.ok(probe.scannedBytes > 0);
    for (const method of config.SDK_METHODS) {
      const found = probe.methods.find((m) => m.method === method);
      assert.ok(found, `${method} must appear in the probe list`);
      assert.equal(found.found, true, `${method} was not found in the synthetic package`);
      assert.ok(found.files.length > 0);
    }
  });

  test('probes for the capabilities it does NOT claim', () => {
    const probe = config.probeSdkMethods();
    for (const method of ['session/cancel', 'session/resume']) {
      assert.ok(probe.methods.some((m) => m.method === method), `${method} must be probed`);
    }
  });
});

describe('credential reporting never leaks the value', () => {
  test('describeCredential returns provenance and length only', () => {
    const description = config.describeCredential();
    const serialised = JSON.stringify(description);
    assert.deepEqual(Object.keys(description).sort(), ['envVarName', 'error', 'length', 'present', 'source'].sort());
    assert.equal(description.envVarName, 'OPENCODE_GO_API_KEY');
    if (description.present) {
      assert.ok(description.length > 0);
      assert.match(serialised, /"length":\d+/);
      const raw = config.credentialValue();
      assert.ok(raw, 'present description must correspond to a resolvable value');
      assert.ok(!serialised.includes(raw), 'the serialised description must not contain the credential');
    } else {
      assert.equal(description.length, 0);
      assert.match(description.error ?? '', /OPENCODE_GO_API_KEY/);
    }
  });

  test('buildChildEnv sets DSH_HOME and strips proxies in direct mode', () => {
    const env = config.buildChildEnv('D:\\AGENTS\\temp\\fake-home');
    assert.equal(env['DSH_HOME'], 'D:\\AGENTS\\temp\\fake-home');
    if (config.PROXY_MODE === 'direct') {
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
        assert.equal(env[name], undefined, `${name} must be stripped in direct mode`);
      }
    }
  });
});

describe('desktop route inspection', () => {
  test('reports drift instead of assuming the pinned route still matches', () => {
    const route = config.inspectDesktopRoute();
    assert.equal(typeof route.path, 'string');
    assert.ok(Array.isArray(route.drift));
    if (route.available) {
      assert.equal(route.route?.api, config.PROVIDER_API);
      assert.equal(route.route?.baseURL, config.PROVIDER_BASE_URL);
      assert.equal(route.route?.apiKeyEnv, config.API_KEY_ENV);
      assert.ok(route.route?.models.includes('deepseek-flash'), 'the desktop profile should still declare deepseek-flash');
      assert.equal(route.matchesBridgeConstants, true, `pinned route drifted: ${route.drift.join('; ')}`);
    } else {
      assert.ok(route.error, 'an unreadable profile must report why');
    }
  });
});

describe('evidence scrubber', () => {
  test('redacts credential shapes', () => {
    assert.equal(evidence.scrubText('token sk-abcdefghijklmnop1234567890'), 'token [REDACTED]');
    assert.equal(evidence.scrubText('Authorization: Bearer abcdefghijklmnopqrst'), '[REDACTED]');
    assert.match(evidence.scrubText('"api_key": "abcdefghijklmnop"'), /\[REDACTED\]/);
    assert.match(evidence.scrubText('password=hunter2hunter2'), /\[REDACTED\]/);
  });

  test('leaves ordinary text alone', () => {
    assert.equal(evidence.scrubText('wrote notes.md in 12ms'), 'wrote notes.md in 12ms');
  });

  test('drops reasoning-bearing keys and blocks', () => {
    const scrubbed = evidence.scrub({
      reasoning: 'private chain of thought',
      replayState: {secret: 'x'},
      message: {content: [{type: 'reasoning', text: 'inner'}, {type: 'text', text: 'visible'}]},
      nested: {thinking: 'also private', keep: 'ok'},
    });
    const text = JSON.stringify(scrubbed);
    assert.ok(!text.includes('private chain of thought'));
    assert.ok(!text.includes('also private'));
    assert.ok(!text.includes('inner'));
    assert.ok(text.includes('visible'));
    assert.ok(text.includes('ok'));
  });

  test('truncate states exactly how much was dropped', () => {
    const short = evidence.truncate('abc', 10);
    assert.equal(short.truncated, false);
    assert.equal(short.text, 'abc');
    const long = evidence.truncate('a'.repeat(50), 10);
    assert.equal(long.truncated, true);
    assert.match(long.text, /TRUNCATED: 40 of 50 chars omitted/);
  });

  test('caps recursion depth instead of hanging on a hostile payload', () => {
    let deep: Record<string, unknown> = {value: 'bottom'};
    for (let i = 0; i < 40; i += 1) deep = {child: deep};
    const text = JSON.stringify(evidence.scrub(deep));
    assert.ok(text.includes('[TRUNCATED: depth]'));
  });
});

describe('workspace snapshot diff', () => {
  test('separates added, modified and removed files', () => {
    const root = path.join(TEST_ROOT, 'snapshot-diff');
    // Start from a clean directory: a leftover new.txt from an earlier run would already be in the
    // "before" snapshot and the file would read as unchanged instead of added.
    rmSync(root, {recursive: true, force: true});
    mkdirSync(root, {recursive: true});
    writeFileSync(path.join(root, 'keep.txt'), 'same');
    writeFileSync(path.join(root, 'change.txt'), 'before');
    writeFileSync(path.join(root, 'gone.txt'), 'bye');

    const before = evidence.snapshotWorkspace(root);
    writeFileSync(path.join(root, 'change.txt'), 'after');
    writeFileSync(path.join(root, 'new.txt'), 'hello');
    unlinkSync(path.join(root, 'gone.txt'));
    const after = evidence.snapshotWorkspace(root);

    const diff = evidence.diffSnapshots(before, after);
    assert.deepEqual(diff.added.map((f) => path.basename(f)), ['new.txt']);
    assert.deepEqual(diff.modified.map((f) => path.basename(f)), ['change.txt']);
    assert.deepEqual(diff.removed.map((f) => path.basename(f)), ['gone.txt']);
    assert.ok(!diff.added.concat(diff.modified, diff.removed).some((f) => f.includes('keep.txt')));
  });
});

describe('stage prompts', () => {
  test('carry the goal, constraints and acceptance, and never a credential', () => {
    const first = prompts.firstStagePrompt({
      taskId: 't-1', stage: 1, workspace: 'D:\\AGENTS\\workspaces\\x',
      goal: 'GOAL-MARKER', context: 'CONTEXT-MARKER', constraints: ['CONSTRAINT-MARKER'],
      acceptance: 'ACCEPTANCE-MARKER', verificationCommand: ['node', '--test'],
    });
    for (const marker of ['GOAL-MARKER', 'CONTEXT-MARKER', 'CONSTRAINT-MARKER', 'ACCEPTANCE-MARKER']) {
      assert.ok(first.includes(marker), `first stage prompt must include ${marker}`);
    }
    assert.ok(!first.includes('node --test'), 'host verifier argv stays outside model context');
    const credential = config.credentialValue();
    if (credential) assert.ok(!first.includes(credential), 'a credential must never reach a model prompt');

    const next = prompts.continuationPrompt(
      {
        taskId: 't-1', stage: 2, workspace: 'D:\\AGENTS\\workspaces\\x',
        goal: 'GOAL-MARKER', acceptance: 'ACCEPTANCE-MARKER',
      },
      'REVIEW-MARKER',
      'PRIOR-REPORT-MARKER',
    );
    assert.ok(next.includes('REVIEW-MARKER'));
    assert.ok(next.includes('GOAL-MARKER'));
    assert.ok(next.includes('PRIOR-REPORT-MARKER'));
    assert.ok(next.includes('SAME session'), 'the continuation must tell the model to stay in the same session');
  });
});

after(() => {
  assert.equal(path.dirname(realpathSync(UNIT_RUNTIME_ROOT)), realpathSync(TEST_ROOT));
  rmSync(UNIT_RUNTIME_ROOT, {recursive: true, force: true});
});
