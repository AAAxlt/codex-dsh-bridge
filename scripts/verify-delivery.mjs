#!/usr/bin/env node
/**
 * Independent delivery check for this candidate.
 *
 * It locates the candidate root from its own URL (never from the caller's cwd), verifies the
 * source-hash manifest and the delivery manifest, resolves npm to a real npm-cli.js invoked by
 * node (never an unshelled npm.cmd), runs the real TypeScript build, then the complete package
 * test script in three explicitly controlled route contexts:
 *
 *   inherited  - exactly the environment the Bridge parent supplied (GOAT in the real run)
 *   opencode   - the default route, forced explicitly
 *   goat       - the GOAT route, forced explicitly
 *
 * It selects the trusted execution-profile baseline registered for the canonical
 * DSH_BRIDGE_RUNTIME_ROOT; an unregistered runtime is refused, never silently checked against a
 * different runtime's baseline. Every child exit code is preserved. Missing/empty manifests and a
 * zero-suite or zero-test run are failures, not passes.
 *
 * Usage (from any directory):
 *   node /abs/path/optimization-20261022/scripts/verify-delivery.mjs
 */
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {selectBaselineForRuntime} from '../maintenance/guard.mjs';
import {resolveNpmInvocation} from './lib/npm-invocation.mjs';
import {parseNodeTestResults, parseSourceManifest, validateDeliveryManifest, validateTestCounts, summarizeVerification} from './lib/verify-checks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = path.join(ROOT, 'evidence');
const LOG = path.join(EVIDENCE, 'verify-delivery.log');
const RESULT = path.join(EVIDENCE, 'verify-delivery-last.json');
const HASHES = path.join(ROOT, 'SOURCE-HASHES.sha256');
const DELIVERY = path.join(ROOT, 'delivery.json');
const NODE = process.execPath;

mkdirSync(EVIDENCE, {recursive: true});
const startedAt = new Date().toISOString();
const steps = [];
let failed = null;
let npmInvocation = null;
let baselineSelection = null;
let sourceManifestSha256 = null;

function append(text) {
  process.stdout.write(text);
  writeFileSync(LOG, text, {encoding: 'utf8', flag: 'a'});
}

function header(title) {
  append(`\n===== ${title} @ ${new Date().toISOString()} =====\n`);
}

function fail(id, status, error) {
  if (failed === null) failed = {id, status, error};
}

function runStep(id, command, args, extraEnv = {}, meta = {}) {
  header(`${id}: ${command} ${args.join(' ')}`);
  const env = {
    ...process.env,
    // The E2E self-check writes under this root. The repository default lives outside the
    // candidate and can be non-writable on a locked-down host; this is an explicit test seam,
    // not a skipped or faked assertion.
    DSH_BRIDGE_E2E_ROOT: path.join(EVIDENCE, 'e2e-root'),
    ...extraEnv,
  };
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = result.stdout ?? '';
  if (stdout) append(stdout);
  if (result.stderr) append(result.stderr);
  const status = result.status;
  const testStats = id.startsWith('test-') ? parseNodeTestResults(stdout) : null;
  const testCount = testStats?.tests ?? null;
  append(`\n[${id}] exit=${String(status)}${testStats === null ? '' : ` tests=${testCount} pass=${testStats.pass} fail=${testStats.fail} cancelled=${testStats.cancelled} skipped=${testStats.skipped} todo=${testStats.todo} verdict=${testStats.status}`}${result.error ? ` error=${result.error.message}` : ''}\n`);
  steps.push({
    id, command, args, exitCode: status, testCount, testStats,
    error: result.error ? result.error.message : null,
    completedAt: new Date().toISOString(),
    ...meta,
  });
  if (status !== 0) fail(id, status, result.error?.message ?? null);
  return {status, stdout};
}

function verifySourceHashes() {
  header(`source-hashes: ${HASHES}`);
  let entries;
  try {
    const manifestBytes = readFileSync(HASHES);
    sourceManifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
    entries = parseSourceManifest(manifestBytes.toString('utf8'));
  } catch (error) {
    append(`[source-hashes] FAIL: ${error.message}\n`);
    steps.push({id: 'source-hashes', command: NODE, args: [HASHES], exitCode: 1, error: error.message});
    fail('source-hashes', 1, error.message);
    return;
  }
  const bad = [];
  let checked = 0;
  for (const [rel, expected] of entries) {
    const file = path.join(ROOT, rel);
    if (!existsSync(file)) { bad.push(`${rel}: missing`); continue; }
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    checked += 1;
    if (actual !== expected) bad.push(`${rel}: expected ${expected}, actual ${actual}`);
  }
  append(`[source-hashes] checked=${checked} entries=${entries.size} mismatches=${bad.length}\n`);
  for (const item of bad) append(`  ${item}\n`);
  steps.push({id: 'source-hashes', command: NODE, args: [HASHES], exitCode: bad.length === 0 ? 0 : 1, checked, entries: entries.size, mismatches: bad.length, manifestSha256: sourceManifestSha256});
  if (bad.length > 0) fail('source-hashes', 1, bad.join('; '));
}

function verifyDeliveryManifest() {
  header(`delivery-manifest: ${DELIVERY}`);
  let validation;
  try {
    validation = validateDeliveryManifest(JSON.parse(readFileSync(DELIVERY, 'utf8')), sourceManifestSha256);
  } catch (error) {
    validation = {ok: false, errors: [error.message], total: null};
  }
  append(`[delivery-manifest] ok=${validation.ok} total=${String(validation.total)} errors=${JSON.stringify(validation.errors)}\n`);
  steps.push({id: 'delivery-manifest', command: NODE, args: [DELIVERY], exitCode: validation.ok ? 0 : 1, expectedTests: validation.total, errors: validation.errors, actualManifestSha256: sourceManifestSha256});
  if (!validation.ok) fail('delivery-manifest', 1, validation.errors.join('; '));
  return validation.total;
}

function resolveNpm() {
  header('npm-resolution');
  try {
    npmInvocation = resolveNpmInvocation({
      execPath: process.execPath,
      env: process.env,
      platform: process.platform,
      exists: existsSync,
    });
    append(`[npm-resolution] command=${npmInvocation.command} prefix=${JSON.stringify(npmInvocation.prefixArgs)} source=${npmInvocation.source} shell=false\n`);
    steps.push({
      id: 'npm-resolution', command: npmInvocation.command, args: npmInvocation.prefixArgs,
      exitCode: 0, source: npmInvocation.source, npmCliPath: npmInvocation.npmCliPath,
    });
    return npmInvocation;
  } catch (error) {
    append(`[npm-resolution] FAIL: ${error.message}\n`);
    steps.push({id: 'npm-resolution', command: NODE, args: [], exitCode: 1, error: error.message});
    fail('npm-resolution', 1, error.message);
    return null;
  }
}

function verifyRuntimeBaseline() {
  const explicitRoot = Object.hasOwn(process.env, 'DSH_BRIDGE_RUNTIME_ROOT');
  const runtimeRoot = process.env.DSH_BRIDGE_RUNTIME_ROOT ?? path.join(os.homedir(), 'dsh-runtime');
  const dshPkg = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  header(`runtime-baseline: ${runtimeRoot}`);
  if (!existsSync(dshPkg)) {
    if (explicitRoot) {
      const message = `explicit DSH_BRIDGE_RUNTIME_ROOT has no pinned dsh package: ${dshPkg}`;
      append(`[runtime-baseline] FAIL: ${message}\n`);
      steps.push({id: 'runtime-baseline', command: NODE, args: [], exitCode: 1, error: message});
      fail('runtime-baseline', 1, message);
    } else {
      const message = `no pinned runtime at ${dshPkg}`;
      append(`[runtime-baseline] SKIPPED: ${message}. This is reported, not counted as a pass.\n`);
      steps.push({id: 'runtime-baseline', command: NODE, args: [], exitCode: null, skipped: true, reason: message});
    }
    return;
  }
  try {
    baselineSelection = selectBaselineForRuntime(runtimeRoot, ROOT);
    append(`[runtime-baseline] selected=${baselineSelection.id} dsh=${baselineSelection.dshVersion} baseline=${baselineSelection.baselineFile} sha256=${baselineSelection.baselineSha256}\n`);
    steps.push({
      id: 'runtime-baseline', command: NODE, args: [], exitCode: 0,
      baselineId: baselineSelection.id, dshVersion: baselineSelection.dshVersion,
      baselineFile: baselineSelection.baselineFile, baselineSha256: baselineSelection.baselineSha256,
    });
  } catch (error) {
    append(`[runtime-baseline] FAIL: ${error.message}\n`);
    steps.push({id: 'runtime-baseline', command: NODE, args: [], exitCode: 1, error: error.message});
    fail('runtime-baseline', 1, error.message);
    return;
  }
  if (baselineSelection) {
    runStep('execution-profile-guard', NODE, [
      path.join(ROOT, 'maintenance', 'guard.mjs'), 'check',
      '--runtime-root', runtimeRoot,
      '--assets-root', ROOT,
      '--baseline', baselineSelection.baselineFile,
    ], {}, {baselineId: baselineSelection.id});
  }
}

append(`\n########## verify-delivery ${startedAt} ##########\n`);
append(`candidateRoot=${ROOT}\nnode=${process.version} platform=${process.platform} arch=${process.arch}\n`);
try {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  append(`package=${String(pkg.name)} version=${String(pkg.version)}\n`);
} catch (error) {
  append(`package.json unreadable: ${error.message}\n`);
  fail('package-read', 1, error.message);
}

verifySourceHashes();
const expectedTests = verifyDeliveryManifest();
const npm = resolveNpm();

let buildFailed = false;
if (npm) {
  const build = runStep('build', npm.command, [...npm.prefixArgs, 'run', 'build']);
  buildFailed = build.status !== 0;
}

// The build already ran. --ignore-scripts suppresses only the pretest build, not the test body.
// All three suites run even if one fails, so the transcript records the full route matrix.
if (npm && !buildFailed) {
  runStep('test-inherited', npm.command, [...npm.prefixArgs, '--ignore-scripts', 'test']);
  runStep('test-opencode', npm.command, [...npm.prefixArgs, '--ignore-scripts', 'test'], {DSH_BRIDGE_PROVIDER: 'opencode-go'});
  runStep('test-goat', npm.command, [...npm.prefixArgs, '--ignore-scripts', 'test'], {DSH_BRIDGE_PROVIDER: 'commandcode-goat'});
}

if (npm && !buildFailed) {
  const suites = steps.filter((step) => step.id.startsWith('test-'));
  const check = validateTestCounts(suites, expectedTests);
  append(`\n[test-count] expected=${String(expectedTests)} observed=${JSON.stringify(check.observed)} status=${check.status} errors=${JSON.stringify(check.errors)} partialReasons=${JSON.stringify(check.partialReasons)}\n`);
  steps.push({
    id: 'test-count', command: NODE, args: [], exitCode: check.status === 'pass' ? 0 : check.status === 'partial' ? 2 : 1,
    status: check.status, expected: expectedTests, observed: check.observed, errors: check.errors, partialReasons: check.partialReasons,
  });
  if (check.status === 'fail') fail('test-count', 1, check.errors.join('; '));
}

if (npm && !buildFailed && failed === null) {
  verifyRuntimeBaseline();
}

const finishedAt = new Date().toISOString();
const verdict = summarizeVerification(failed ? [...steps, {id: failed.id, exitCode: 1}] : steps);
const {ok, status, exitCode} = verdict;
append(`\n########## verify-delivery ${status.toUpperCase()} ${finishedAt} ##########\n`);
writeFileSync(RESULT, JSON.stringify({
  schema: 'codex-dsh-bridge/verify-delivery@2',
  candidateRoot: ROOT,
  package: (() => {
    try { return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name; } catch { return null; }
  })(),
  startedAt, finishedAt, ok, status, exitCode, steps, failed: failed ?? null,
  partialReasons: steps.filter((step) => step.skipped || step.status === 'partial')
    .flatMap((step) => step.partialReasons ?? [step.reason ?? `${step.id} was not fully verified`]),
  routeMatrix: ['inherited', 'opencode-go', 'commandcode-goat'],
  expectedTests,
  npmInvocation: npmInvocation ? {
    command: npmInvocation.command, prefixArgs: npmInvocation.prefixArgs,
    source: npmInvocation.source, shell: false,
  } : null,
  baselineSelection,
  logPath: LOG,
  note: 'Generated by actually running the build and the full test script in three controlled route contexts with node + npm-cli.js (no shell). E2E writes are redirected to evidence/e2e-root. The execution-profile baseline is selected by canonical runtime root from baseline/runtime-baselines.json; unknown runtimes are refused. No model request was made.',
}, null, 2) + '\n', 'utf8');
process.exit(exitCode);
