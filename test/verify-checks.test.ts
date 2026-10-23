/**
 * Pure checks behind verify-delivery. Their failure modes are the ones that used to look like a
 * pass: no suites, zero tests, a missing/empty source manifest, or a missing delivery total.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, test} from 'node:test';

import {REPO_ROOT, cleanupDir, makeWorkspace} from './helpers.js';

const {
  countNodeTests, parseNodeTestResults, parseSourceManifest, validateDeliveryManifest, validateTestCounts, summarizeVerification,
} = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'verify-checks.mjs')).href);

const HASH = 'a'.repeat(64);
const summary = (tests: number, pass = tests, skipped = 0, fail = 0, cancelled = 0, todo = 0, prefix = 'ℹ') =>
  `${prefix} tests ${tests}\n${prefix} pass ${pass}\n${prefix} fail ${fail}\n${prefix} cancelled ${cancelled}\n${prefix} skipped ${skipped}\n${prefix} todo ${todo}\n`;
const suite = (id: string, tests: number) => ({id, testCount: tests, testStats: parseNodeTestResults(summary(tests))});

describe('test-count reading', () => {
  test('counts every node-test summary and returns 0 for no output', () => {
    assert.equal(countNodeTests(''), 0);
    assert.equal(countNodeTests('no summaries here\n'), 0);
    assert.equal(countNodeTests('ℹ tests 22\nℹ tests 12\n'), 34);
    assert.equal(countNodeTests('# tests 22\n# tests 12\n'), 34);
  });

  test('aggregates both spec and TAP outcomes in a multi-command npm script', () => {
    const result = parseNodeTestResults(summary(22) + summary(12, 12, 0, 0, 0, 0, '#'));
    assert.equal(result.status, 'pass');
    assert.equal(result.tests, 34);
    assert.equal(result.pass, 34);
    assert.equal(result.summaryCount, 2);
  });

  test('all 143 tests skipped cannot claim full acceptance', () => {
    const stats = parseNodeTestResults(summary(143, 0, 143));
    assert.equal(stats.status, 'partial');
    const result = validateTestCounts([{id: 'all-skipped', testCount: 143, testStats: stats}], 143);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'partial');
    assert.equal(result.observed[0].pass, 0);
    assert.equal(result.observed[0].skipped, 143);
  });

  test('failures and cancellations fail even when all tests were collected', () => {
    for (const text of [summary(143, 142, 0, 1), summary(143, 142, 0, 0, 1)]) {
      const stats = parseNodeTestResults(text);
      assert.equal(stats.status, 'fail');
      assert.equal(validateTestCounts([{id: 'broken', testStats: stats}], 143).status, 'fail');
    }
  });

  test('a todo remains partial and a declared total alone is missing evidence', () => {
    assert.equal(parseNodeTestResults(summary(3, 2, 0, 0, 0, 1)).status, 'partial');
    assert.equal(parseNodeTestResults('ℹ tests 143\n').status, 'fail');
    assert.equal(validateTestCounts([{id: 'collected-only', testCount: 143}], 143).status, 'fail');
  });

  test('missing counters, duplicate counters, contradictory totals and empty runs fail closed', () => {
    for (const text of ['', summary(0), summary(3, 4), summary(3) + 'ℹ pass 3\n',
      summary(3).replace('ℹ skipped 0\n', ''), summary(3) + 'ℹ tests 2\n']) {
      assert.equal(parseNodeTestResults(text).status, 'fail', text);
    }
  });

  test('strips ANSI colours and handles Windows line endings', () => {
    const text = summary(3).split('\n').map((line) => `\u001b[34m${line}\u001b[39m`).join('\r\n');
    assert.equal(parseNodeTestResults(text).status, 'pass');
  });

  test('reads actual Node TAP and spec reporters, including their skipped outcome', () => {
    for (const reporter of ['tap', 'spec']) {
      const child = spawnSync(process.execPath, [`--test-reporter=${reporter}`, '--input-type=module', '--eval',
        "import {test} from 'node:test'; test('passed', () => {}); test('skipped', {skip: true}, () => {});"],
      {encoding: 'utf8', windowsHide: true});
      assert.equal(child.status, 0, child.stderr);
      const stats = parseNodeTestResults(child.stdout);
      assert.equal(stats.status, 'partial', JSON.stringify(stats));
      assert.equal(stats.tests, 2);
      assert.equal(stats.pass, 1);
      assert.equal(stats.skipped, 1);
    }
  });
});

describe('source manifest validation', () => {
  test('rejects a missing or empty manifest', () => {
    assert.throws(() => parseSourceManifest(''), /missing or empty/i);
    assert.throws(() => parseSourceManifest('   \n'), /missing or empty/i);
  });

  test('rejects malformed lines and unsafe paths', () => {
    assert.throws(() => parseSourceManifest('not-a-hash  src/a.ts\n'), /malformed/i);
    assert.throws(() => parseSourceManifest(`${HASH}  ../escape.ts\n`), /relative and contained/i);
  });

  test('parses a valid manifest', () => {
    const entries = parseSourceManifest(`${HASH}  src/a.ts\n${'b'.repeat(64)}  test/a.ts\n`);
    assert.equal(entries.size, 2);
    assert.equal(entries.get('src/a.ts'), HASH);
  });
});

describe('delivery manifest validation', () => {
  test('rejects missing, empty and zero-test manifests', () => {
    for (const doc of [null, {}, {finalTests: {}}, {finalTests: {total: 0}}]) {
      const result = validateDeliveryManifest(doc, HASH);
      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0);
    }
  });

  test('accepts a positive total with a final source hash', () => {
    const result = validateDeliveryManifest({
      finalTests: {total: 124},
      sourceHashes: {final: {manifestSha256: HASH}},
    }, HASH);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.total, 124);
  });

  test('a syntactically valid but false manifest hash fails its actual bytes binding', () => {
    const bytes = Buffer.from(`${HASH}  src/a.ts\r\n`, 'utf8');
    const actual = createHash('sha256').update(bytes).digest('hex');
    const doc = {finalTests: {total: 124}, sourceHashes: {final: {manifestSha256: HASH}}};
    assert.equal(validateDeliveryManifest(doc, actual).ok, false);
    assert.match(validateDeliveryManifest(doc, actual).errors.join(' '), /does not match actual/i);
    doc.sourceHashes.final.manifestSha256 = actual;
    assert.equal(validateDeliveryManifest(doc, actual).ok, true);
    assert.equal(validateDeliveryManifest(doc).ok, false, 'an absent actual digest must fail closed');
    const normalized = createHash('sha256').update(bytes.toString().replace(/\r\n/g, '\n')).digest('hex');
    assert.equal(validateDeliveryManifest(doc, normalized).ok, false, 'hash the exact manifest bytes');
  });
});

describe('test-count validation', () => {
  test('no suites never passes', () => {
    const result = validateTestCounts([], 124);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /no test suites/i);
  });

  test('a zero-test suite never passes', () => {
    const result = validateTestCounts([{id: 'test-x', testCount: 0}], 124);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /zero tests/i);
  });

  test('a mismatch fails and an exact three-suite matrix passes', () => {
    assert.equal(validateTestCounts([suite('a', 124), suite('b', 0)], 124).ok, false);
    const ok = validateTestCounts([
      suite('inherited', 124), suite('opencode', 124), suite('goat', 124),
    ], 124);
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  });

  test('exact counts still fail when the expected total or outcome evidence is invalid', () => {
    assert.equal(validateTestCounts([suite('x', 124)], 0).status, 'fail');
    const forged = {...suite('x', 124), testStats: {...parseNodeTestResults(summary(124, 123, 1)), status: 'pass', ok: true}};
    assert.equal(validateTestCounts([forged], 124).status, 'partial');
  });
});

describe('overall verification verdict', () => {
  test('a skipped runtime check converts otherwise passing steps to partial and exit 2', () => {
    const result = summarizeVerification([{id: 'build', exitCode: 0}, {id: 'runtime-baseline', skipped: true, exitCode: null}]);
    assert.deepEqual(result, {status: 'partial', ok: false, exitCode: 2});
  });

  test('a partial test matrix uses exit 2; failure takes precedence over partial checks', () => {
    const partial = {id: 'test-count', status: 'partial', exitCode: 2};
    assert.equal(summarizeVerification([partial]).status, 'partial');
    assert.deepEqual(summarizeVerification([partial, {id: 'build', exitCode: 1}]), {status: 'fail', ok: false, exitCode: 1});
  });

  test('unknown child exit 2, no checks and missing exit evidence are failures', () => {
    for (const steps of [[], [{id: 'build', exitCode: 2}], [{id: 'build', exitCode: null}]]) {
      assert.deepEqual(summarizeVerification(steps), {status: 'fail', ok: false, exitCode: 1});
    }
  });

  test('only entirely executed successful checks return exit 0', () => {
    assert.deepEqual(summarizeVerification([{id: 'build', exitCode: 0}, {id: 'runtime-baseline', exitCode: 0}]),
      {status: 'pass', ok: true, exitCode: 0});
  });

  test('actual verifier CLI reports partial skips and rejects false manifest binding', () => {
    const workspace = makeWorkspace('verify-cli');
    try {
      for (const dir of ['scripts/lib', 'maintenance']) mkdirSync(path.join(workspace, dir), {recursive: true});
      for (const file of ['scripts/verify-delivery.mjs', 'scripts/lib/verify-checks.mjs',
        'scripts/lib/npm-invocation.mjs', 'maintenance/guard.mjs']) {
        copyFileSync(path.join(REPO_ROOT, file), path.join(workspace, file));
      }
      writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({name: 'verifier-counterexample',
        version: '0.0.0', type: 'module', scripts: {build: 'node --check fixture.mjs', test: 'node fixture.mjs'}}));
      const env: NodeJS.ProcessEnv = {...process.env, USERPROFILE: workspace, HOME: workspace};
      delete env.DSH_BRIDGE_RUNTIME_ROOT;
      for (const scenario of [
        {name: 'runtime-missing', skipped: false, falseHash: false, status: 'partial', exit: 2},
        {name: 'all-skipped', skipped: true, falseHash: false, status: 'partial', exit: 2},
        {name: 'wrong-hash', skipped: false, falseHash: true, status: 'fail', exit: 1},
      ]) {
        const fixture = `import {test} from 'node:test'; test('fixture', {skip: ${scenario.skipped}}, () => {});\n`;
        writeFileSync(path.join(workspace, 'fixture.mjs'), fixture);
        const manifest = `${createHash('sha256').update(fixture).digest('hex')}  fixture.mjs\n`;
        writeFileSync(path.join(workspace, 'SOURCE-HASHES.sha256'), manifest);
        const actualHash = createHash('sha256').update(manifest).digest('hex');
        writeFileSync(path.join(workspace, 'delivery.json'), JSON.stringify({finalTests: {total: 1},
          sourceHashes: {final: {manifestSha256: scenario.falseHash ? HASH : actualHash}}}));
        const child = spawnSync(process.execPath, [path.join(workspace, 'scripts', 'verify-delivery.mjs')],
          {env, cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, timeout: 30_000});
        assert.equal(child.status, scenario.exit, `${scenario.name}: ${child.stderr}\n${child.stdout}`);
        const verdict = JSON.parse(readFileSync(path.join(workspace, 'evidence', 'verify-delivery-last.json'), 'utf8'));
        assert.equal(verdict.status, scenario.status, scenario.name);
        assert.equal(verdict.ok, false, scenario.name);
        if (!scenario.falseHash) {
          assert.ok(verdict.steps.some((step: {id: string; skipped?: boolean}) => step.id === 'runtime-baseline' && step.skipped));
        }
        if (scenario.skipped) {
          const stats = verdict.steps.find((step: {id: string}) => step.id === 'test-inherited').testStats;
          assert.equal(stats.pass, 0);
          assert.equal(stats.skipped, 1);
        }
      }
    } finally {
      cleanupDir(workspace);
    }
  });
});
