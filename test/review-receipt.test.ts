/**
 * Structured external acceptance receipt regressions. Everything here runs against the scripted
 * runtime: no model request is spent and no caller-supplied command is ever executed.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs, {existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {after, beforeEach, describe, test} from 'node:test';

import {applyScriptedEnv, cleanupDir, makeWorkspace, sleep, TEST_DATA_ROOT, TEST_ROOT, waitFor} from './helpers.js';

applyScriptedEnv();

const {TaskManager} = await import('../src/tasks.js');

const manager = new TaskManager();
const workspaces: string[] = [];

beforeEach(() => {
  process.env['FAKE_SCENARIO'] = 'success';
});

after(async () => {
  await manager.shutdownAll();
  for (const workspace of workspaces) cleanupDir(workspace);
  cleanupDir(TEST_ROOT);
});

function workspace(label: string): string {
  const dir = makeWorkspace(label);
  workspaces.push(dir);
  return dir;
}

function sha(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function failReceipt(taskId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId, stage: 1, reviewId: 'review-fail-1', outcome: 'fail',
    summary: 'Independent acceptance failed: the requested implementation is missing.',
    findings: [{
      id: 'F1', title: 'Implementation missing', expected: 'working source', actual: 'only a report',
      reproduction: ['run the project check', 'observe the missing behavior'],
    }],
    checks: [{
      name: 'acceptance', status: 'fail', exitCode: 1,
      stdout: 'expected working behavior', stderr: 'not implemented',
      platform: 'linux', command: ['node', 'accept.mjs'],
    }],
    ...overrides,
  };
}

async function settledTask(label: string, extra: Record<string, unknown> = {}) {
  const dir = workspace(label);
  const record = await manager.submit({workspace: dir, goal: 'Implement the feature.', ...extra});
  await manager.wait(record.taskId, 30_000);
  return {record, dir};
}

/** A settled stage with an explicit deliverySource and a passing host command. */
async function settledDeliveryTask(label: string) {
  const dir = workspace(label);
  writeFileSync(path.join(dir, 'work.txt'), 'stable delivered source\n');
  const check = path.join(dir, 'accept.cjs');
  writeFileSync(check, 'process.exit(0)');
  const record = await manager.submit({
    workspace: dir, goal: 'Produce a scoped delivery.',
    deliverySource: {mode: 'complete', paths: ['work.txt'], exclude: []},
    verificationCommand: [process.execPath, check], protectedVerificationFiles: [check],
  });
  await manager.wait(record.taskId, 30_000);
  return {record, dir, check};
}

describe('structured external acceptance receipts', () => {
  test('a fail with actionable findings repairs in the same session and stays awaiting-recheck', async () => {
    const {record, dir} = await settledTask('review-repair', {
      verificationCommand: [process.execPath, '-e', 'process.exit(0)'],
    });
    const stage1 = manager.result(record.taskId, 1);
    const stage1Bytes = readFileSync(stage1.artifacts.stageResult!);
    const stage1CheckpointBytes = readFileSync(path.join(record.taskDir, 'checkpoints/stage-1.json'));
    const runtimePid = manager.status(record.taskId).runtimePid;

    const receipt = await manager.submitReview(failReceipt(record.taskId) as never);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.source, 'caller-reported');
    assert.equal(receipt.alreadyRecorded, false);
    assert.equal(receipt.continued, true);
    assert.equal(receipt.repairStage, 2);
    assert.ok(existsSync(receipt.receiptPath));
    const persisted = JSON.parse(readFileSync(receipt.receiptPath, 'utf8'));
    assert.equal(persisted.source, 'caller-reported');
    assert.equal(persisted.status, 'continuation-started');
    assert.equal(persisted.repairStage, 2);

    await manager.wait(record.taskId, 30_000);
    const status = manager.status(record.taskId);
    assert.equal(status.stageCount, 2);
    assert.equal(status.runtimePid, runtimePid, 'review repair must reuse the same live session');
    assert.equal(status.externalReview.status, 'awaiting-recheck');
    assert.equal(status.externalReview.reviewId, 'review-fail-1');
    assert.equal(status.externalReview.repairStage, 2);
    assert.equal(status.automationMetrics.reviewRepairCount, 1);
    assert.equal(status.automationMetrics.externalReviewCount, 1);
    assert.equal(status.automationMetrics.codexDirectEditCount, null);

    const stage2 = manager.result(record.taskId, 2);
    assert.equal(stage2.stageCause, 'review-repair');
    assert.equal(stage2.bridgeObserved.verification.status, 'passed');
    assert.equal(stage2.deliverySummary.productAcceptance, 'unverified',
      'a local command pass after an external fail is not product acceptance');

    // First-turn evidence is not rewritten by the receipt or the repair stage.
    assert.deepEqual(readFileSync(stage1.artifacts.stageResult!), stage1Bytes);
    assert.deepEqual(readFileSync(path.join(record.taskDir, 'checkpoints/stage-1.json')), stage1CheckpointBytes,
      'a review repair must not rewrite the prior stage checkpoint');
    assert.equal(manager.result(record.taskId, 1).stageState, 'awaiting_review');

    const pass = await manager.submitReview({
      taskId: record.taskId, stage: 2, reviewId: 'review-pass-2', outcome: 'pass',
      summary: 'External recheck passed against the new stage.', findings: [], checks: [], reviewedSource: [],
    });
    assert.equal(pass.continued, false);
    assert.equal(pass.repairStage, null);
    assert.equal(pass.externalReview.status, 'passed');
    assert.equal(manager.result(record.taskId, 2).deliverySummary.productAcceptance, 'check-passed');

    // The receipt that clears the gate is reflected in the already-recorded bundle, and the
    // earlier fail summary/counter is preserved rather than replaced by a single stale entry.
    const exported = manager.exportDelivery(record.taskId, path.join(dir, 'export-after-recheck'));
    const index = JSON.parse(readFileSync(exported.indexJson, 'utf8'));
    assert.equal(index.metrics.externalReviewCount, 2);
    assert.equal(index.hostVerification.externalReview.status, 'passed');
    assert.equal(index.externalReviews.length, 2);
    assert.ok(index.externalReviews.some((item: {reviewId: string; status: string}) =>
      item.reviewId === 'review-fail-1' && item.status === 'awaiting-recheck'));
    assert.ok(index.externalReviews.some((item: {reviewId: string; status: string}) =>
      item.reviewId === 'review-pass-2' && item.status === 'passed'));
    const receiptEvidence = index.evidence.find((item: {key: string}) => item.key === 'reviewReceipt');
    assert.equal(receiptEvidence.originalPath, pass.receiptPath);
    assert.match(readFileSync(path.join(exported.directory, receiptEvidence.artifactPath), 'utf8'), /review-pass-2/);

    const duplicate = await manager.submitReview({
      taskId: record.taskId, stage: 2, reviewId: 'review-pass-2', outcome: 'pass',
      summary: 'External recheck passed against the new stage.', findings: [], checks: [], reviewedSource: [],
    });
    assert.equal(duplicate.alreadyRecorded, true);
    assert.equal(manager.status(record.taskId).stageCount, 2, 'a duplicate receipt must not start a stage');
  });

  test('a caller pass cannot turn a failing host command into a pass', async () => {
    const {record} = await settledTask('review-pass-conflict', {
      verificationCommand: [process.execPath, '-e', 'process.exit(7)'],
    });
    const before = manager.result(record.taskId);
    assert.equal(before.bridgeObserved.verification.status, 'failed');
    const receipt = await manager.submitReview({
      taskId: record.taskId, stage: 1, reviewId: 'caller-pass-1', outcome: 'pass',
      summary: 'The caller says this passed.', findings: [], checks: [], reviewedSource: [],
    });
    assert.equal(receipt.externalReview.outcome, 'pass');
    assert.equal(receipt.externalReview.status, 'failed', 'a caller pass cannot override a failed host command');
    assert.equal(receipt.continued, false);
    assert.equal(manager.result(record.taskId).deliverySummary.productAcceptance, 'failed');
  });

  test('a manual stage after an external pass requires its own external recheck', async () => {
    const {record} = await settledTask('review-after-pass', {
      verificationCommand: [process.execPath, '-e', 'process.exit(0)'],
    });
    await manager.submitReview({
      taskId: record.taskId, stage: 1, reviewId: 'pass-before-manual', outcome: 'pass',
      summary: 'Stage 1 passed external review.', findings: [], checks: [], reviewedSource: [],
    });
    assert.equal(manager.result(record.taskId).externalReview.status, 'passed');

    await manager.continue(record.taskId, 'Start the next bounded stage.');
    await manager.wait(record.taskId, 30_000);
    const view = manager.result(record.taskId);
    assert.equal(manager.status(record.taskId).stageCount, 2);
    assert.equal(view.externalReview.status, 'awaiting-recheck',
      'a new stage may not inherit an earlier external pass');
    assert.equal(view.externalReview.reviewId, 'pass-before-manual');
    assert.equal(view.externalReview.receiptCount, 1, 'old receipt facts are preserved');
    assert.equal(view.externalReview.passCount, 1, 'old pass counter is preserved');
    assert.equal(view.deliverySummary.productAcceptance, 'unverified',
      'a local command pass for the new stage is not the missing external pass');
  });

  test('a pass receipt with a failed, blocked or not-run check is refused before any write', async () => {
    const {record} = await settledTask('review-contradictory');
    for (const [index, status] of (['fail', 'blocked', 'not-run'] as const).entries()) {
      await assert.rejects(
        () => manager.submitReview({
          taskId: record.taskId, stage: 1, reviewId: `contradictory-${index}`, outcome: 'pass',
          summary: `claimed pass with a ${status} check`,
          checks: [{name: `${status} check`, status, exitCode: 1, stdout: '', stderr: '', platform: null, command: null}],
        }) as never,
        (error: unknown) => (error as {code?: string}).code === 'review_contradictory',
      );
    }
    assert.equal(manager.status(record.taskId).stageCount, 1);
    assert.equal(existsSync(path.join(record.taskDir, 'reviews')), false,
      'a contradictory receipt must be refused before persistence');

    // A non-zero exit code is data, not a failure verdict: an expected CLI exit 2 may be a pass.
    const accepted = await manager.submitReview({
      taskId: record.taskId, stage: 1, reviewId: 'expected-exit-2', outcome: 'pass',
      summary: 'The documented CLI contract treats exit 2 as a successful business result.',
      checks: [{name: 'documented exit2 contract', status: 'pass', exitCode: 2, stdout: '', stderr: '', platform: null, command: null}],
    });
    assert.equal(accepted.externalReview.status, 'passed');
  });

  test('different raw receipt bodies cannot alias after secret scrubbing', async () => {
    const {record} = await settledTask('review-raw-body');
    const base = {
      taskId: record.taskId, stage: 1, reviewId: 'raw-body-binding', outcome: 'blocked' as const,
      findings: [], checks: [], reviewedSource: [],
    };
    const first = await manager.submitReview({
      ...base,
      summary: 'API_KEY=sk-SYNTHETICA1234567890123456789012345678901234567890',
    });
    const firstBytes = readFileSync(first.receiptPath);
    await assert.rejects(
      () => manager.submitReview({
        ...base,
        summary: 'API_KEY=sk-SYNTHETICB1234567890123456789012345678901234567890',
      }) as never,
      (error: unknown) => (error as {code?: string}).code === 'review_conflict',
      'two different raw bodies scrub to the same text and must still conflict',
    );
    assert.deepEqual(readFileSync(first.receiptPath), firstBytes, 'the original receipt is preserved');

    // Key order is not semantic: the same body in another object order stays idempotent.
    const duplicate = await manager.submitReview({
      summary: 'API_KEY=sk-SYNTHETICA1234567890123456789012345678901234567890',
      outcome: 'blocked', reviewId: 'raw-body-binding', stage: 1, taskId: record.taskId,
      reviewedSource: [], checks: [], findings: [],
    });
    assert.equal(duplicate.alreadyRecorded, true);
  });

  test('review IDs map to distinct portable receipt filenames and preserve the exact ID', async () => {
    const {record} = await settledTask('review-portable-id');
    const first = await manager.submitReview({
      taskId: record.taskId, stage: 1, reviewId: 'Audit:Case', outcome: 'blocked',
      summary: 'first portable identifier', findings: [], checks: [], reviewedSource: [],
    });
    const firstBytes = readFileSync(first.receiptPath);
    assert.equal(path.basename(first.receiptPath).includes(':'), false,
      'a colon would create a Windows alternate data stream filename');
    const second = await manager.submitReview({
      taskId: record.taskId, stage: 1, reviewId: 'audit:case', outcome: 'blocked',
      summary: 'second case-only identifier', findings: [], checks: [], reviewedSource: [],
    });
    assert.notEqual(first.receiptPath.toLowerCase(), second.receiptPath.toLowerCase(),
      'case-only IDs must not alias on case-folding filesystems');
    assert.deepEqual(readFileSync(first.receiptPath), firstBytes, 'the first receipt was overwritten');
    assert.equal(JSON.parse(readFileSync(second.receiptPath, 'utf8')).reviewId, 'audit:case',
      'the public ID is preserved inside the receipt');
  });

  test('reviewedSource hashing is bounded and never reads an oversized file whole', async () => {
    const {record, dir} = await settledTask('review-source-bound');
    const large = path.join(dir, 'large.bin');
    const descriptor = fs.openSync(large, 'wx');
    fs.ftruncateSync(descriptor, 70 * 1024 * 1024);
    fs.closeSync(descriptor);

    const mutable = fs as unknown as {readFileSync: typeof fs.readFileSync};
    const native = mutable.readFileSync;
    let attemptedWholeRead = false;
    mutable.readFileSync = ((file: unknown, ...args: unknown[]): unknown => {
      if (String(file) === large) {
        attemptedWholeRead = true;
        throw new Error('whole-file read of an oversized reviewedSource');
      }
      return (native as (...inner: unknown[]) => unknown)(file, ...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => manager.submitReview({
          taskId: record.taskId, stage: 1, reviewId: 'large-source', outcome: 'blocked',
          summary: 'size bound', reviewedSource: [{path: 'large.bin', sha256: '0'.repeat(64)}],
        }) as never,
        (error: unknown) => (error as {code?: string}).code === 'review_source_too_large',
      );
    } finally {
      mutable.readFileSync = native;
      syncBuiltinESMExports();
    }
    assert.equal(attemptedWholeRead, false, 'reviewedSource must be rejected by preflight size');
  });

  test('a new explicit review after idle time starts a fresh bounded automation cycle', async () => {
    const {record} = await settledTask('review-fresh-cycle', {
      verificationCommand: [process.execPath, '-e', 'process.exit(0)'],
      autoContinue: {enabled: true, maxAttempts: 1, noProgressLimit: 2, totalBudgetMs: 1_000},
    });
    const before = manager.status(record.taskId);
    assert.equal(before.automationMetrics.manualCodexContinuationCount, 0);
    await sleep(1_200);
    const receipt = await manager.submitReview(failReceipt(record.taskId, {
      reviewId: 'review-after-idle', summary: 'New explicit review after human review time.',
    }) as never);
    assert.equal(receipt.continued, true);
    await manager.wait(record.taskId, 30_000);
    const after = manager.status(record.taskId);
    assert.equal(after.stageCount, 2);
    assert.equal(after.state, 'awaiting_review',
      'the repair stage must not inherit an expired automation budget');
    assert.equal(after.externalReview.status, 'awaiting-recheck');
    assert.equal(after.automationMetrics.manualCodexContinuationCount, 0,
      'a review repair is not a manual Codex continuation');
    assert.equal(manager.result(record.taskId, 2).bridgeObserved.verification.status, 'passed');
  });

  test('a blocked receipt surfaces the external issue and starts no model request', async () => {
    const {record} = await settledTask('review-blocked');
    const receipt = await manager.submitReview({
      taskId: record.taskId, stage: 1, reviewId: 'blocked-1', outcome: 'blocked',
      summary: 'External dependency unavailable.', findings: [], checks: [], reviewedSource: [],
    });
    assert.equal(receipt.externalReview.status, 'blocked');
    assert.equal(receipt.continued, false);
    assert.equal(manager.status(record.taskId).stageCount, 1);
    assert.match(manager.result(record.taskId).unresolved.join(' '), /blocked/i);
  });

  test('concurrent duplicates record once and never send a second prompt; conflicting reuse is refused', async () => {
    const {record} = await settledTask('review-duplicate');
    const body = failReceipt(record.taskId, {reviewId: 'review-concurrent'});
    const [first, second] = await Promise.all([
      manager.submitReview(body as never),
      manager.submitReview(body as never),
    ]);
    assert.equal([first, second].filter((item) => item.alreadyRecorded === false).length, 1);
    assert.equal([first, second].filter((item) => item.alreadyRecorded === true).length, 1);
    assert.equal([first, second].filter((item) => item.continued).length, 1);
    assert.equal(manager.status(record.taskId).stageCount, 2);

    const events = readFileSync(path.join(record.taskDir, 'events.jsonl'), 'utf8');
    assert.equal((events.match(/"kind":"stage\/accepted","stage":2/g) ?? []).length, 1,
      'the duplicate must not send a second stage-2 prompt');

    await manager.wait(record.taskId, 30_000);
    await assert.rejects(
      () => manager.submitReview(failReceipt(record.taskId, {reviewId: 'review-concurrent', summary: 'different body'}) as never),
      (error: unknown) => (error as {code?: string}).code === 'review_conflict',
    );
    assert.equal(manager.status(record.taskId).stageCount, 2);
  });

  test('stale, in-flight, cancelled and historical controls are refused without new stages', async () => {
    process.env['FAKE_SCENARIO'] = 'slow';
    const inflight = await manager.submit({workspace: workspace('review-inflight'), goal: 'Hold.'});
    await assert.rejects(
      () => manager.submitReview(failReceipt(inflight.taskId) as never),
      (error: unknown) => (error as {code?: string}).code === 'review_stage_in_flight',
    );
    await manager.cancel(inflight.taskId);
    await assert.rejects(
      () => manager.submitReview(failReceipt(inflight.taskId) as never),
      (error: unknown) => (error as {code?: string}).code === 'task_cancelled',
    );

    process.env['FAKE_SCENARIO'] = 'success';
    const {record} = await settledTask('review-stale');
    const second = await manager.continue(record.taskId, 'Manual stage 2.');
    assert.equal(second.stages.length, 2);
    await manager.wait(record.taskId, 30_000);
    await assert.rejects(
      () => manager.submitReview(failReceipt(record.taskId, {reviewId: 'stale-1', stage: 1}) as never),
      (error: unknown) => (error as {code?: string}).code === 'review_stage_stale',
    );
    assert.equal(manager.status(record.taskId).stageCount, 2);

    const historical = 'dsh-20260101000000-hist01';
    mkdirSync(path.join(TEST_DATA_ROOT, 'tasks', historical), {recursive: true});
    await assert.rejects(
      () => manager.submitReview({
        taskId: historical, stage: 1, reviewId: 'historical-1', outcome: 'blocked',
        summary: 'history only', findings: [], checks: [], reviewedSource: [],
      }),
      (error: unknown) => (error as {code?: string}).code === 'historical_not_live',
    );
    assert.equal(existsSync(path.join(TEST_DATA_ROOT, 'tasks', historical, 'reviews')), false);
  });

  test('reviewedSource binds current bytes and refuses traversal, absolute paths, links and mismatch', async () => {
    const {record, dir} = await settledTask('review-source');
    writeFileSync(path.join(dir, 'answer.ts'), 'export const answer = 42;\n');
    const digest = sha(readFileSync(path.join(dir, 'answer.ts')));
    const base = {
      taskId: record.taskId, stage: 1, reviewId: 'source-1', outcome: 'pass',
      summary: 'source checked', findings: [], checks: [],
    };
    for (const badPath of ['../escape.ts', '/etc/passwd', 'answer.ts:stream', '*.ts']) {
      await assert.rejects(
        () => manager.submitReview({...base, reviewedSource: [{path: badPath, sha256: digest}]} as never),
        (error: unknown) => ['invalid_review_source', 'invalid_review'].includes((error as {code?: string}).code ?? ''),
      );
    }
    await assert.rejects(
      () => manager.submitReview({...base, reviewedSource: [{path: 'answer.ts', sha256: 'a'.repeat(64)}]} as never),
      (error: unknown) => (error as {code?: string}).code === 'review_source_mismatch',
    );
    if (process.platform !== 'win32') {
      symlinkSync(path.join(dir, 'answer.ts'), path.join(dir, 'answer-link.ts'));
      await assert.rejects(
        () => manager.submitReview({...base, reviewedSource: [{path: 'answer-link.ts', sha256: digest}]} as never),
        (error: unknown) => (error as {code?: string}).code === 'invalid_review_source',
      );
    }
    assert.equal(manager.status(record.taskId).stageCount, 1);
    assert.equal(existsSync(path.join(record.taskDir, 'reviews')), false, 'no refused receipt may be persisted');

    const accepted = await manager.submitReview({...base, reviewedSource: [{path: 'answer.ts', sha256: digest}]} as never);
    assert.equal(accepted.alreadyRecorded, false);
    assert.deepEqual(accepted.externalReview.status, 'passed');
  });

  test('diagnostic text is scrubbed and supplied commands are data, never executed', async () => {
    const marker = path.join(workspace('review-marker'), 'EXECUTED');
    const {record} = await settledTask('review-scrub', {context: 'secret check'});
    const secret = 'sk-FAKE000000000000000000000000000000000000000000';
    const receipt = await manager.submitReview(failReceipt(record.taskId, {
      reviewId: 'scrub-1',
      summary: `external failure with ${secret}`,
      checks: [{
        name: 'leaky', status: 'fail', exitCode: 1,
        stdout: `OPENCODE_GO_API_KEY=${secret}`, stderr: `Bearer ${secret}`,
        platform: 'linux', command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
      }],
    }) as never);
    assert.equal(existsSync(marker), false, 'a caller-supplied check command must never be executed');
    const serialized = JSON.stringify(receipt) + readFileSync(receipt.receiptPath, 'utf8');
    assert.equal(serialized.includes(secret), false, 'the secret shape must be scrubbed from receipt and reply');
    assert.match(serialized, /\[REDACTED\]/);
    assert.match(readFileSync(path.join(record.taskDir, 'reviews/events.jsonl'), 'utf8'), /caller-reported/);
    await manager.wait(record.taskId, 30_000);
  });

  test('cancel during a review repair preserves the receipt fact and does not claim completion', async () => {
    process.env['FAKE_SCENARIO'] = 'complete_then_slow';
    const {record} = await settledTask('review-cancel');
    const receipt = await manager.submitReview(failReceipt(record.taskId, {reviewId: 'cancel-review'}) as never);
    assert.equal(receipt.continued, true);
    assert.equal(receipt.repairStage, 2);
    await waitFor(() => {
      const status = manager.status(record.taskId);
      return status.stageCount === 2 && status.state === 'running' ? status : null;
    }, 20_000);
    const cancelled = await manager.cancel(record.taskId);
    assert.equal(cancelled.cancelled, true);
    const status = manager.status(record.taskId);
    assert.equal(status.state, 'cancelled');
    assert.equal(status.stageCount, 2);
    const persisted = JSON.parse(readFileSync(receipt.receiptPath, 'utf8'));
    assert.equal(persisted.status, 'continuation-started');
    assert.equal(persisted.continued, true);
    assert.notEqual(status.externalReview.status, 'passed');
  });

  test('delivery exports the caller-reported receipt and separate automation counters', async () => {
    const {record, dir} = await settledTask('review-delivery', {
      verificationCommand: [process.execPath, '-e', 'process.exit(0)'],
    });
    await manager.submitReview(failReceipt(record.taskId, {reviewId: 'delivery-review'}) as never);
    await manager.wait(record.taskId, 30_000);
    const destination = path.join(dir, 'exported');
    const exported = manager.exportDelivery(record.taskId, destination);
    const index = JSON.parse(readFileSync(exported.indexJson, 'utf8'));
    assert.equal(index.metrics.reviewRepairCount, 1);
    assert.equal(index.metrics.externalReviewCount, 1);
    assert.equal(index.metrics.autoContinuationCount, 0);
    assert.equal(index.metrics.manualCodexContinuationCount, 0);
    assert.equal(index.metrics.codexDirectEditCount, null);
    assert.equal(index.externalReviews[0].source, 'caller-reported');
    assert.equal(index.externalReviews[0].status, 'awaiting-recheck');
    assert.equal(index.hostVerification.externalReview.status, 'awaiting-recheck');
    const receiptEvidence = index.evidence.find((item: {key: string}) => item.key === 'reviewReceipt');
    assert.ok(receiptEvidence, 'the receipt must be captured as delivery evidence');
    assert.ok(existsSync(path.join(exported.directory, receiptEvidence.artifactPath)));
    assert.match(readFileSync(path.join(exported.directory, receiptEvidence.artifactPath), 'utf8'), /caller-reported/);
  });

  test('a pass receipt refreshes delivery gate/count/checkpoint without touching sealed stage evidence', async () => {
    const {record, dir} = await settledDeliveryTask('review-delivery-pass-sync');
    const before = manager.result(record.taskId);
    const resultPath = before.artifacts.stageResult!;
    const stageCheckpoint = path.join(record.taskDir, 'checkpoints/stage-1.json');
    const resultSha = sha(readFileSync(resultPath));
    const stageSha = sha(readFileSync(stageCheckpoint));
    const input = {
      taskId: record.taskId, stage: 1, reviewId: 'pass-export', outcome: 'pass',
      summary: 'External acceptance passed.',
    };
    await manager.submitReview(input as never);

    const exported = manager.exportDelivery(record.taskId, path.join(dir, 'export-pass'));
    const index = JSON.parse(readFileSync(exported.indexJson, 'utf8'));
    assert.equal(index.metrics.externalReviewCount, 1);
    assert.equal(index.hostVerification.externalReview.status, 'passed');
    assert.ok(index.externalReviews.some((item: {reviewId: string; status: string}) =>
      item.reviewId === 'pass-export' && item.status === 'passed'));
    assert.equal(JSON.parse(readFileSync(path.join(record.taskDir, 'checkpoint.json'), 'utf8')).externalReview.status,
      'passed');
    assert.equal(sha(readFileSync(resultPath)), resultSha, 'sealed stage result was rewritten');
    assert.equal(sha(readFileSync(stageCheckpoint)), stageSha, 'sealed stage checkpoint was rewritten');

    const indexSha = sha(readFileSync(path.join(record.taskDir, 'delivery/index.json')));
    const duplicate = await manager.submitReview(input as never);
    assert.equal(duplicate.alreadyRecorded, true);
    assert.equal(sha(readFileSync(path.join(record.taskDir, 'delivery/index.json'))), indexSha,
      'a duplicate same-body receipt rewrote delivery metadata');
  });

  test('a blocked receipt is exported without recapturing changed live workspace source', async () => {
    const {record, dir} = await settledDeliveryTask('review-delivery-blocked-sync');
    const originalIndex = JSON.parse(readFileSync(path.join(record.taskDir, 'delivery/index.json'), 'utf8'));
    const frozenSource = structuredClone(originalIndex.source);
    const originalBytes = readFileSync(path.join(dir, 'work.txt'));
    // A caller may change the live workspace after the stage settled. Export must keep the
    // recorded stage snapshot, not silently capture this newer, unreviewed state.
    writeFileSync(path.join(dir, 'work.txt'), 'UNVERIFIED_EXTERNAL_MUTATION');

    await manager.submitReview({
      taskId: record.taskId, stage: 1, reviewId: 'blocked-export', outcome: 'blocked',
      summary: 'External environment blocker',
    });
    const exported = manager.exportDelivery(record.taskId, path.join(dir, 'export-blocked'));
    const index = JSON.parse(readFileSync(exported.indexJson, 'utf8'));
    assert.equal(index.metrics.externalReviewCount, 1);
    assert.equal(index.hostVerification.externalReview.status, 'blocked');
    assert.ok(index.externalReviews.some((item: {reviewId: string; status: string}) =>
      item.reviewId === 'blocked-export' && item.status === 'blocked'));
    assert.deepEqual(index.source, frozenSource, 'receipt refresh recaptured live source');
    assert.deepEqual(readFileSync(path.join(exported.directory, index.source.files[0].artifactPath)), originalBytes);
    assert.equal(JSON.parse(readFileSync(path.join(record.taskDir, 'checkpoint.json'), 'utf8')).externalReview.status,
      'blocked');
    assert.equal(manager.status(record.taskId).stageCount, 1);
  });

  test('a non-actionable failure is exported without a prompt or stale host-only pass packet', async () => {
    const {record, dir} = await settledDeliveryTask('review-delivery-fail-sync');
    const receipt = await manager.submitReview({
      taskId: record.taskId, stage: 1, reviewId: 'fail-export', outcome: 'fail',
      summary: 'External unresolved failure; no additional reproduction available',
    });
    assert.equal(receipt.continued, false);
    const exported = manager.exportDelivery(record.taskId, path.join(dir, 'export-fail'));
    const index = JSON.parse(readFileSync(exported.indexJson, 'utf8'));
    assert.equal(index.metrics.externalReviewCount, 1);
    assert.equal(index.hostVerification.externalReview.status, 'failed');
    assert.ok(index.externalReviews.some((item: {reviewId: string; status: string}) =>
      item.reviewId === 'fail-export' && item.status === 'failed'));
    assert.equal(JSON.parse(readFileSync(path.join(record.taskDir, 'checkpoint.json'), 'utf8')).externalReview.status,
      'failed');
    assert.equal(manager.status(record.taskId).stageCount, 1);
  });

  test('pre-1.0.8 records without automation or review fields still project honestly', async () => {
    const local = new TaskManager();
    const dir = workspace('review-old-history');
    const record = await local.submit({workspace: dir, goal: 'Legacy record.'});
    await local.wait(record.taskId, 30_000);
    await local.shutdownAll();
    const file = path.join(record.taskDir, 'task.json');
    const legacy = JSON.parse(readFileSync(file, 'utf8'));
    delete legacy.autoContinue;
    delete legacy.totalAutoContinuations;
    delete legacy.totalReviewRepairs;
    delete legacy.externalReview;
    for (const stage of legacy.stages) {
      delete stage.cause;
      delete stage.causeDetail;
      delete stage.elapsedMs;
      delete stage.progressFingerprintBefore;
      delete stage.progressFingerprintAfter;
    }
    writeFileSync(file, JSON.stringify(legacy, null, 2));
    const {getHistory} = await import('../src/history.js');
    const viewed = getHistory(record.taskId) as Record<string, any>;
    assert.equal(viewed.autoContinue.enabled, false);
    assert.equal(viewed.autoContinue.attempts, 0);
    assert.equal(viewed.recordedMetrics.totalAutoContinuations, 0);
    assert.equal(viewed.recordedMetrics.totalReviewRepairs, 0);
    assert.equal(viewed.recordedMetrics.codexDirectEditCount, null);
    assert.equal(viewed.externalReview.status, 'none');
    assert.equal(viewed.automationMetrics.autoContinuationCount, 0);
    assert.equal(viewed.stage.recordedCause, null);
  });
});
