/**
 * R2/R3 regression, and it spends no model request.
 *
 * R2's defect was an undefined identifier in the driver's summary branch - a branch that
 * `node --check` and `tsc` both accept because neither of them ever runs it, and that a real
 * two-stage model run would only have discovered after paying for both stages.
 *
 * So the branch is executed here twice over: the pure summary/verdict functions are called with
 * recorded-shaped facts, and the DRIVER ITSELF is spawned with `--self-check`, which drives its
 * own summary-construction, verdict and exit-code path against synthetic facts with no MCP client
 * and no model request.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dist/test -> dist -> repo root */
const REPO_ROOT = path.resolve(HERE, '..', '..');
const LIB = path.join(REPO_ROOT, 'scripts', 'lib', 'e2e-verdict.mjs');
const DRIVER = path.join(REPO_ROOT, 'scripts', 'e2e-real.mjs');
const SELF_CHECK_RUN_ID = `self-check-${process.pid}`;

const {buildSummary, buildVerdict} = await import(pathToFileURL(LIB).href);

const E2E_ROOT = process.env['DSH_BRIDGE_E2E_ROOT'] ??
  (process.platform === 'win32'
    ? 'D:\\AGENTS\\temp'
    : path.join(REPO_ROOT, 'evidence', 'e2e-root'));
// The driver is a separate process: give it the same writable root this test asserts against.
// This is a test-environment adaptation, not a weaker assertion.
process.env['DSH_BRIDGE_E2E_ROOT'] = E2E_ROOT;
const SELF_CHECK_EVIDENCE = path.join(E2E_ROOT, 'codex-dsh-bridge-e2e', `${SELF_CHECK_RUN_ID}-evidence`);

after(() => {
  rmSync(SELF_CHECK_EVIDENCE, {recursive: true, force: true, maxRetries: 3});
});

const CLEAN_FACTS = {
  runId: 'unit-clean',
  workspace: '/w',
  evidenceDir: '/e',
  taskId: 't-1',
  session: {stage1RuntimePid: 101, stage2RuntimePid: 101, stage1SessionId: 's-1', stage2SessionId: 's-1', stage1Turn: 1, stage2Turn: 2},
  stage1: {messageId: 'm1', state: 'awaiting_review', verificationExitCode: 0, toolCallsTotal: 5, toolErrorCount: 0, modelReportChars: 120, settledAt: '2026-01-01T00:00:00.000Z'},
  stage2: {messageId: 'm2', state: 'awaiting_review', verificationExitCode: 0, toolCallsTotal: 4, toolErrorCount: 0, modelReportChars: 90, continuedStage: 2},
  preservation: {allArtifactHashesMatch: true, comparedArtifacts: 2, changedArtifacts: [], reportTextUnchanged: true},
  review: {path: '/e/stage-2-review.txt', receivedAt: '2026-01-01T00:10:00.000Z', writtenAfterStage1: true, chars: 42},
  cancel: {runtimeStopped: true, fullyStopped: true, treeVerified: true, survivorPids: [], method: 'shutdown-rpc', pidStillAlive: false},
  waitTimeoutsObserved: false,
};

describe('R3: the loop decides acceptance instead of only recording it', () => {
  test('a fully evidenced run is accepted and needs every criterion', () => {
    const verdict = buildVerdict(buildSummary(CLEAN_FACTS));
    assert.equal(verdict.ok, true, JSON.stringify(verdict.failed));
    assert.equal(verdict.stage1Outcome, 'clean');
    assert.equal(verdict.criteria.length, verdict.knownCriteria.length);
    assert.deepEqual(verdict.failed, []);
  });

  test('every criterion can actually fail, and a failure is never reported as accepted', () => {
    const broken = buildVerdict(buildSummary({
      ...CLEAN_FACTS,
      session: {stage1RuntimePid: 101, stage2RuntimePid: 202, stage1SessionId: 's-1', stage2SessionId: 's-2', stage1Turn: 2, stage2Turn: 2},
      stage2: {messageId: 'm2', state: 'failed', verificationExitCode: 1, toolCallsTotal: 4, toolErrorCount: 3, modelReportChars: 10, continuedStage: 2},
      preservation: {allArtifactHashesMatch: false, comparedArtifacts: 2, changedArtifacts: ['stage1Result'], reportTextUnchanged: false},
      review: {path: '/e/stage-2-review.txt', receivedAt: '2026-01-01T00:00:00.000Z', writtenAfterStage1: false, chars: 0},
      cancel: {runtimeStopped: true, fullyStopped: false, treeVerified: true, survivorPids: [4242], method: 'shutdown-rpc+tree-swept(1)', pidStillAlive: true},
    }));
    assert.equal(broken.ok, false);
    for (const id of ['stage2-verification-exit-0', 'stage2-tool-errors-zero', 'same-live-session',
      'stage1-artifacts-unchanged', 'stage1-report-unchanged', 'cleanup-fully-verified',
      'review-written-after-stage1']) {
      assert.ok(broken.failed.includes(id), `${id} must be able to fail; failed=${JSON.stringify(broken.failed)}`);
    }
  });

  test('a stage 1 that needed correction is classified as a correction flow', () => {
    const verdict = buildVerdict(buildSummary({
      ...CLEAN_FACTS,
      stage1: {...CLEAN_FACTS.stage1, verificationExitCode: 1, toolErrorCount: 2},
    }));
    assert.equal(verdict.stage1Outcome, 'correction-flow');
    assert.equal(verdict.ok, true);
    assert.match(verdict.note, /CORRECTION FLOW/);
  });

  test('a missing observation is rejected, not assumed to have passed', () => {
    const verdict = buildVerdict(buildSummary({runId: 'empty'}));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.failed.length, verdict.knownCriteria.length);
  });
});

describe('R2: the driver summary branch is executed, not merely parsed', () => {
  test('node scripts/e2e-real.mjs --self-check runs the real branch and exits 0', () => {
    const stdout = execFileSync(process.execPath, [DRIVER, '--self-check', '--run-id', SELF_CHECK_RUN_ID], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    });
    assert.match(stdout, /E2E_VERDICT_SELF_CHECK_OK/, `self-check did not report success:\n${stdout.slice(-2000)}`);
    assert.ok(existsSync(path.join(SELF_CHECK_EVIDENCE, 'self-check-verdict.json')), 'the self-check must write its verdict');
    const verdict = JSON.parse(readFileSync(path.join(SELF_CHECK_EVIDENCE, 'self-check-verdict.json'), 'utf8'));
    assert.equal(verdict.ok, true);
    assert.equal(verdict.stage1Outcome, 'clean');
    // The driver's OWN summary-fact constructor must have been evaluated, not merely parsed. The
    // defect this pins (`pidStillAlive` where the variable is `pidAlive`) sat in an inline literal
    // that every other check - tsc, node --check, and the pure-function tests - accepted.
    const summary = JSON.parse(readFileSync(path.join(SELF_CHECK_EVIDENCE, 'self-check-summary.json'), 'utf8'));
    assert.equal(summary.cancel.pidStillAlive, false,
      'the self-check must evaluate the driver\'s cancel facts, not skip them');
    assert.equal(summary.cancel.treeVerified, true);
    assert.equal(summary.cancel.fullyStopped, true);
  });
});
