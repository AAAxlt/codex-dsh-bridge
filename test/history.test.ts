/**
 * READ-ONLY persisted-history regression tests. No model request is made: every task record is
 * produced by the scripted runtime, then a fresh TaskManager (the "restarted bridge") is used to
 * prove that history is separate from the live task-control map.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {DeliverySnapshot} from '../src/delivery.js';
import {after, before, describe, test} from 'node:test';
import {applyScriptedEnv, makeWorkspace, TEST_DATA_ROOT, TEST_ROOT} from './helpers.js';

applyScriptedEnv();
process.env['FAKE_SCENARIO'] = 'success';

const {TaskManager} = await import('../src/tasks.js');
const {firstStagePrompt, continuationPrompt} = await import('../src/prompts.js');
const {
  HISTORY_LIMITS, HistoryError, exportHistoricalDelivery, getHistory, historicalTaskExists,
  isSafeHistoryTaskId, listHistory,
} = await import('../src/history.js');
const {writeDeliveryBundle} = await import('../src/delivery.js');

const TASKS_ROOT = path.join(TEST_DATA_ROOT, 'tasks');
const managers: Array<InstanceType<typeof TaskManager>> = [];

before(() => {
  rmSync(TEST_DATA_ROOT, {recursive: true, force: true, maxRetries: 3});
  mkdirSync(TASKS_ROOT, {recursive: true});
});

after(async () => {
  for (const manager of managers.splice(0)) await manager.shutdownAll();
  rmSync(TEST_DATA_ROOT, {recursive: true, force: true, maxRetries: 3});
});

function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
}

function saveJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Create a task with the scripted runtime, then stop its runtime to simulate a bridge restart. */
async function persistedTask(label: string, options: Record<string, unknown> = {}): Promise<{taskId: string; taskDir: string; workspace: string}> {
  const manager = new TaskManager();
  managers.push(manager);
  const workspace = makeWorkspace(`history-${label}`);
  const record = await manager.submit({workspace, goal: `Persisted history fixture ${label}.`, ...options});
  const settled = await manager.wait(record.taskId, 30_000);
  assert.equal(settled.outcome, 'settled');
  const taskDir = manager.result(record.taskId).artifacts.taskDir;
  await manager.shutdownAll();
  return {taskId: record.taskId, taskDir, workspace};
}

function bundleSnapshot(record: Record<string, any>, index: Record<string, any>, workspace: string,
  hostVerification: unknown, final: boolean): DeliverySnapshot {
  return {
    taskId: record.taskId,
    workspace,
    createdAt: record.createdAt,
    completedAt: final ? record.stages.at(-1).finalisedAt : null,
    stageCount: record.stages.length,
    codexContinuationCount: record.codexContinuationCount,
    autoRepairCount: record.totalAutoRepairs,
    firstVerificationPassed: false,
    hostVerification,
    changes: index.changes,
    unresolved: index.unresolved,
    sourceFiles: index.source.files.map((file: any) => file.path),
    dshUsage: index.metrics.dshUsage,
  };
}

function syntheticTaskId(suffix: string): string {
  return `dsh-20261024000000-${suffix}`;
}

function linkDirectory(target: string, link: string): void {
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32') {
      symlinkSync(target, link);
      return;
    }
    throw error;
  }
}

describe('prompt contract and repair-budget scope', () => {
  test('first and continuation prompts state admission/configuration without claiming OS isolation', () => {
    const brief = {
      taskId: 'dsh-20261024000000-prompt', stage: 1, workspace: path.join(TEST_DATA_ROOT, 'prompt-workspace'),
      goal: 'Inspect the controlled fixture.', constraints: ['Only use the fixture.'],
    };
    const prompts = [firstStagePrompt(brief), continuationPrompt({...brief, stage: 2}, 'Review the fixture.', 'Prior report.')];
    for (const prompt of prompts) {
      assert.doesNotMatch(prompt, /Nothing outside the workspace is writable|outside.{0,40}(?:cannot|can't|can not|not) be written/i);
      assert.match(prompt, /Workspace admission/i);
      assert.match(prompt, /workspace-write/i);
      assert.match(prompt, /(?:not|no|cannot|does not|is not).{0,90}(?:OS|system|filesystem|file.system).{0,70}(?:isolation|sandbox|boundar|guarantee)/i);
    }
  });
});

describe('bounded read-only history', () => {
  test('a restarted bridge lists and reads persisted evidence with a fixed non-live envelope', async () => {
    const created = await persistedTask('envelope');
    const restarted = new TaskManager();
    managers.push(restarted);
    assert.equal(restarted.listTasks().length, 0, 'disk history must not enter the live map');
    assert.equal(historicalTaskExists(created.taskId), true);

    const listed = listHistory({limit: 100});
    assert.equal(listed['source'], 'persisted-history');
    assert.equal(listed['runtimeAttached'], false);
    assert.equal(listed['runtimeAlive'], null);
    assert.equal(listed['canContinue'], false);
    assert.equal(listed['canCancel'], false);
    const item = (listed['tasks'] as Array<Record<string, unknown>>).find((entry) => entry['taskId'] === created.taskId);
    assert.ok(item);
    assert.equal(item['valid'], true);
    assert.equal(item['recordedState'], 'awaiting_review');
    assert.equal(item['recordedRuntimePid'] !== undefined, true);

    const detail = getHistory(created.taskId);
    assert.equal(detail['source'], 'persisted-history');
    assert.equal(detail['runtimeAttached'], false);
    assert.equal(detail['runtimeAlive'], null);
    assert.equal(detail['canContinue'], false);
    assert.equal(detail['canCancel'], false);
    assert.equal(detail['recordedState'], 'awaiting_review');
    assert.equal(detail['lastRecordedState'], 'awaiting_review');
    assert.equal((detail['stage'] as any).recordedResult.status, 'available');
    assert.equal((detail['delivery'] as any).exportable, true);
    assert.ok(String(detail['note']).includes('NOT verified'));
  });

  test('list limits are bounded and invalid identifiers never reach the filesystem', async () => {
    assert.throws(() => listHistory({limit: 0}), HistoryError);
    assert.throws(() => listHistory({limit: 101}), HistoryError);
    assert.throws(() => listHistory({limit: 1.5}), HistoryError);
    assert.equal((listHistory() as any).limit, HISTORY_LIMITS.listDefault);
    for (const taskId of ['../outside', '..\\outside', '/tmp/x', 'C:\\foo', 'dsh-20261024000000-ok:stream', '%2e%2e', '\\server\\share', 'dsh-20261024000000-ok/../x']) {
      assert.equal(isSafeHistoryTaskId(taskId), false);
      assert.throws(() => getHistory(taskId), HistoryError);
    }
  });

  test('one corrupt task record is reported without hiding a valid entry', async () => {
    const valid = await persistedTask('list-valid');
    const corruptId = syntheticTaskId('corrupt');
    const corruptDir = path.join(TASKS_ROOT, corruptId);
    mkdirSync(corruptDir, {recursive: true});
    writeFileSync(path.join(corruptDir, 'task.json'), '{not valid JSON');
    const listed = listHistory({limit: 100});
    const rows = listed['tasks'] as Array<Record<string, unknown>>;
    assert.ok(rows.some((row) => row['taskId'] === valid.taskId && row['valid'] === true));
    const corrupt = rows.find((row) => row['taskId'] === corruptId);
    assert.ok(corrupt, 'the corrupt entry must be visible');
    assert.equal(corrupt!['valid'], false);
    assert.match(String(corrupt!['error']), /not valid JSON/i);
  });

  test('malformed, oversized, identity-mismatched and linked task directories are refused', async () => {
    const malformedId = syntheticTaskId('malformed');
    mkdirSync(path.join(TASKS_ROOT, malformedId), {recursive: true});
    writeFileSync(path.join(TASKS_ROOT, malformedId, 'task.json'), '{broken');
    assert.throws(() => getHistory(malformedId), (error: unknown) => error instanceof HistoryError && error.code === 'history_invalid');

    const oversizedId = syntheticTaskId('oversized');
    mkdirSync(path.join(TASKS_ROOT, oversizedId), {recursive: true});
    writeFileSync(path.join(TASKS_ROOT, oversizedId, 'task.json'), Buffer.alloc(HISTORY_LIMITS.taskRecordBytes + 1, 0x20));
    assert.throws(() => getHistory(oversizedId), (error: unknown) => error instanceof HistoryError && error.code === 'history_invalid');

    const mismatch = await persistedTask('mismatch');
    const mismatchFile = path.join(mismatch.taskDir, 'task.json');
    const mismatchRecord = readJson(mismatchFile);
    mismatchRecord.taskId = syntheticTaskId('other');
    saveJson(mismatchFile, mismatchRecord);
    assert.throws(() => getHistory(mismatch.taskId), (error: unknown) => error instanceof HistoryError && error.code === 'history_invalid');

    const target = await persistedTask('link-target');
    const linkedId = syntheticTaskId('link01');
    linkDirectory(target.taskDir, path.join(TASKS_ROOT, linkedId));
    assert.throws(() => getHistory(linkedId), (error: unknown) => error instanceof HistoryError && error.code === 'history_unsafe');
    assert.throws(() => historicalTaskExists(linkedId), (error: unknown) => error instanceof HistoryError && error.code === 'history_unsafe');
  });

  test('malicious live fields on disk cannot override the history envelope or leak secrets/reasoning', async () => {
    const created = await persistedTask('malicious');
    const secret = 'sk-INDEPENDENTHISTORYSECRET000000000000000000000000';
    const reasoning = 'HIDDEN_REASONING_PAYLOAD_SHOULD_BE_EXCLUDED_829';
    for (const relative of ['task.json', 'checkpoint.json', 'evidence/stage-1-result.json']) {
      const file = path.join(created.taskDir, relative);
      if (!existsSync(file)) continue;
      const value = readJson(file);
      Object.assign(value, {source: 'live', runtimeAttached: true, runtimeAlive: true, canContinue: true, canCancel: true});
      value['api_key'] = secret;
      value['reasoning'] = reasoning;
      value['environment'] = {OPENCODE_GO_API_KEY: secret};
      if (typeof value['goal'] === 'string') value['goal'] += ` ${secret}`;
      if (value['modelReport'] && typeof value['modelReport'] === 'object' && typeof value['modelReport'].text === 'string') value['modelReport'].text += ` ${secret}`;
      saveJson(file, value);
    }
    const detail = getHistory(created.taskId);
    assert.equal(detail['source'], 'persisted-history');
    assert.equal(detail['runtimeAttached'], false);
    assert.equal(detail['runtimeAlive'], null);
    assert.equal(detail['canContinue'], false);
    assert.equal(detail['canCancel'], false);
    const serialized = JSON.stringify(detail);
    assert.ok(!serialized.includes(secret), 'a secret must be scrubbed from projected history');
    assert.ok(!serialized.includes(reasoning), 'reasoning fields must not be projected');
    assert.ok(!serialized.includes('"environment"'), 'environment objects must not be projected');
  });

  test('a missing stage result is explicit and never falls back to an earlier stage', async () => {
    const manager = new TaskManager();
    managers.push(manager);
    const workspace = makeWorkspace('history-missing-result');
    const record = await manager.submit({workspace, goal: 'Create two recorded stages.', verificationCommand: [process.execPath, '-e', 'process.exit(0)']});
    await manager.wait(record.taskId, 30_000);
    await manager.continue(record.taskId, 'Produce the second stage.');
    await manager.wait(record.taskId, 30_000);
    assert.equal(manager.status(record.taskId).stageCount, 2);
    const taskDir = manager.result(record.taskId).artifacts.taskDir;
    rmSync(path.join(taskDir, 'evidence', 'stage-2-result.json'), {force: true});

    const first = getHistory(record.taskId, 1);
    assert.equal((first['stage'] as any).recordedResult.status, 'available');
    const second = getHistory(record.taskId, 2);
    assert.equal((second['stage'] as any).index, 2);
    assert.equal((second['stage'] as any).recordedResult.status, 'missing');
    assert.match(String((second['stage'] as any).recordedResult.note), /does not fall back/i);
  });

  test('native command observations are projected faithfully, not as an empty VerificationSummary', async () => {
    const created = await persistedTask('native-verification', {
      verificationCommand: [process.execPath, '-e', 'console.error("REVIEW_EXPECTED_FAILURE");process.exit(7)'],
    });
    const detail = getHistory(created.taskId);
    const stage = detail['stage'] as any;
    assert.equal(stage.observed.verification.status, 'failed');
    assert.equal(stage.observed.verification.configured, true);
    assert.equal(stage.observed.verification.attempts, 1);
    assert.equal(stage.observed.verification.lastRun.exitCode, 7);
    assert.match(String(stage.observed.verification.lastRun.stderrTail), /REVIEW_EXPECTED_FAILURE/);
    assert.equal(stage.observed.verification.acceptance, 'check-failed');
    assert.equal(stage.recordedResult.verification.status, 'failed');
    assert.equal(stage.recordedResult.verification.attempts, 1);
    assert.equal(stage.recordedResult.verification.lastRun.exitCode, 7);
    assert.equal((detail['stages'] as any)[0].verificationStatus, 'failed');
    assert.equal((detail['stages'] as any)[0].verificationExitCode, 7);
  });

  test('untrusted status, workspace text and session identity cannot leak into a bounded response', async () => {
    const created = await persistedTask('untrusted-fields');
    const taskFile = path.join(created.taskDir, 'task.json');
    const saved = readFileSync(taskFile);
    const secret = 'sk-NESTEDVERIFICATIONSECRET000000000000000000';
    try {
      const record = JSON.parse(saved.toString());
      const hugeStatus = secret + 'x'.repeat(2 * 1024 * 1024);
      record.stages[0].verification = {status: hugeStatus, exitCode: 7, lastRun: {status: hugeStatus, exitCode: 7}};
      record.workspace = `${secret} /tmp/recorded-workspace`;
      writeFileSync(taskFile, JSON.stringify(record));
      const detail = getHistory(created.taskId);
      const serialized = JSON.stringify(detail);
      assert.ok(!serialized.includes(secret), 'untrusted status/workspace text must be scrubbed');
      assert.ok((detail['responseBytes'] as number) <= HISTORY_LIMITS.responseBytes, 'response must be bounded');
      assert.ok(Buffer.byteLength(serialized) <= HISTORY_LIMITS.responseBytes + 1024);
      const status = (detail['stages'] as any)[0].verificationStatus;
      assert.ok(['pending', 'passed', 'failed', 'timed-out', 'errored', 'not-run', 'not-configured', 'cancelled-during-run']
        .includes(status), `derived status must be a safe enum, got ${String(status)}`);
      assert.equal((detail['stage'] as any).observed.verification.status, 'failed');
    } finally {
      writeFileSync(taskFile, saved);
    }
    try {
      const record = JSON.parse(saved.toString());
      record.sessionId = secret;
      writeFileSync(taskFile, JSON.stringify(record));
      assert.throws(() => getHistory(created.taskId), (error: unknown) => error instanceof HistoryError && error.code === 'history_invalid');
    } finally {
      writeFileSync(taskFile, saved);
    }
  });

  test('a stage result with a different recorded identity is corrupt, not displayed', async () => {
    const created = await persistedTask('result-identity');
    const resultFile = path.join(created.taskDir, 'evidence/stage-1-result.json');
    const result = readJson(resultFile);
    result.taskId = syntheticTaskId('other');
    saveJson(resultFile, result);
    const detail = getHistory(created.taskId);
    assert.equal((detail['stage'] as any).recordedResult.status, 'corrupt');
    assert.equal((detail['stage'] as any).recordedResult.modelReport, undefined, 'corrupt result content is not displayed');
  });

  test('a checkpoint with an unknown schema is reported without being interpreted', async () => {
    const created = await persistedTask('checkpoint-schema');
    const checkpoint = path.join(created.taskDir, 'checkpoint.json');
    const value = readJson(checkpoint);
    value.schema = 'unknown/checkpoint@99';
    saveJson(checkpoint, value);
    const detail = getHistory(created.taskId);
    assert.equal((detail['checkpoint'] as any).status, 'unsupported-schema');
    const serialized = JSON.stringify(detail);
    assert.ok(!serialized.includes('canContinueWhileRuntimeAlive":true'), 'no recorded resume claim is promoted to actionable state');
  });
});

describe('historical export and control separation', () => {
  test('historical export copies captured source bytes after the workspace changed and starts no runtime', async () => {
    const trace = path.join(TEST_DATA_ROOT, 'history-export.trace');
    process.env['FAKE_TRACE'] = trace;
    const created = await persistedTask('export');
    const taskRecordBefore = hash(readFileSync(path.join(created.taskDir, 'task.json')));
    const index = readJson(path.join(created.taskDir, 'delivery/index.json'));
    const sourceFile = index.source.files[0] as {path: string; artifactPath: string; sha256: string};
    const originalBytes = readFileSync(path.join(created.taskDir, 'delivery', sourceFile.artifactPath));
    writeFileSync(path.join(created.workspace, sourceFile.path), 'workspace changed after the recorded delivery');
    const traceBefore = existsSync(trace) ? readFileSync(trace, 'utf8') : '';

    const restarted = new TaskManager();
    managers.push(restarted);
    assert.equal(restarted.listTasks().length, 0);
    const destination = path.join(created.workspace, 'historical-export');
    const exported = restarted.exportDelivery(created.taskId, destination);
    assert.equal(hash(readFileSync(path.join(exported.directory, sourceFile.artifactPath))), sourceFile.sha256);
    assert.deepEqual(readFileSync(path.join(exported.directory, sourceFile.artifactPath)), originalBytes);
    assert.equal(hash(readFileSync(path.join(created.taskDir, 'task.json'))), taskRecordBefore, 'export must not rewrite the record');
    assert.equal(existsSync(trace) ? readFileSync(trace, 'utf8') : '', traceBefore, 'historical export must not start a runtime');
  });

  test('a stale earlier bundle after a failed later capture is refused', async () => {
    const created = await persistedTask('stale');
    const taskFile = path.join(created.taskDir, 'task.json');
    const record = readJson(taskFile);
    record.deliveryStage = null;
    saveJson(taskFile, record);
    const destination = path.join(created.workspace, 'must-not-export-stale');
    assert.throws(() => exportHistoricalDelivery(created.taskId, destination, {allowedExportRoots: [created.workspace]}),
      (error: unknown) => error instanceof HistoryError && error.code === 'delivery_unavailable');
    assert.equal(existsSync(destination), false);
  });

  test('a delivery index whose stageCount is not the latest stage is refused', async () => {
    const created = await persistedTask('index-mismatch');
    const indexFile = path.join(created.taskDir, 'delivery/index.json');
    const index = readJson(indexFile);
    index.metrics.stageCount = 99;
    saveJson(indexFile, index);
    const destination = path.join(created.workspace, 'must-not-export-index');
    const restarted = new TaskManager();
    managers.push(restarted);
    assert.throws(() => restarted.exportDelivery(created.taskId, destination),
      (error: unknown) => error instanceof HistoryError && error.code === 'delivery_unavailable');
    assert.equal(existsSync(destination), false);
  });

  test('a historical id is never a live control target', async () => {
    const created = await persistedTask('control');
    const restarted = new TaskManager();
    managers.push(restarted);
    await assert.rejects(restarted.continue(created.taskId, 'must not resume'), /unknown taskId/i);
    await assert.rejects(restarted.cancel(created.taskId), /unknown taskId/i);
    await assert.rejects(restarted.wait(created.taskId, 1_000), /unknown taskId/i);
    assert.equal(restarted.listTasks().length, 0);
  });

  test('strict delivery-index binding rejects malformed, wrong-stage, pending and non-final bundles', async () => {
    const manager = new TaskManager();
    managers.push(manager);
    const workspace = makeWorkspace('history-binding');
    const record = await manager.submit({
      workspace,
      goal: 'Create a two-stage delivery index used for binding regression tests.',
      verificationCommand: [process.execPath, '-e', 'console.error("EXPECTED_BINDING_FAILURE");process.exit(7)'],
    });
    await manager.wait(record.taskId, 30_000);
    await manager.continue(record.taskId, 'Produce the second stage in the same live session.');
    await manager.wait(record.taskId, 30_000);
    const taskDir = manager.result(record.taskId).artifacts.taskDir;
    const taskFile = path.join(taskDir, 'task.json');
    const indexFile = path.join(taskDir, 'delivery/index.json');
    const originalRecord = readJson(taskFile);
    const originalIndex = readJson(indexFile);
    assert.equal(originalRecord.stages.length, 2);
    assert.equal(originalRecord.deliveryStage, 2);
    assert.equal(originalIndex.metrics.final, true);
    const backup = path.join(TEST_ROOT, `history-binding-backup-${process.pid}`);
    cpSync(taskDir, backup, {recursive: true});
    const restarted = new TaskManager();
    managers.push(restarted);
    const restore = () => {
      rmSync(taskDir, {recursive: true, force: true});
      cpSync(backup, taskDir, {recursive: true});
    };
    try {
      const baselineDestination = path.join(workspace, 'export-baseline');
      const baseline = getHistory(record.taskId);
      assert.equal((baseline['delivery'] as any).exportable, true);
      const baselineExport = restarted.exportDelivery(record.taskId, baselineDestination);
      assert.ok(existsSync(baselineExport.indexJson));

      const scenarios: Array<{label: string; mutate: () => void}> = [
        {label: 'array', mutate: () => {
          writeDeliveryBundle(taskDir, bundleSnapshot(originalRecord, originalIndex, workspace, [], true));
        }},
        {label: 'objectstages', mutate: () => {
          writeDeliveryBundle(taskDir, bundleSnapshot(originalRecord, originalIndex, workspace,
            {...originalIndex.hostVerification, stages: {first: {stage: 1}}}, true));
        }},
        {label: 'wrongindices', mutate: () => {
          writeDeliveryBundle(taskDir, bundleSnapshot(originalRecord, originalIndex, workspace,
            {...originalIndex.hostVerification, stages: originalIndex.hostVerification.stages.map((item: any) => ({...item, stage: 1}))}, true));
        }},
        {label: 'pending', mutate: () => {
          const pending = {...originalRecord, state: 'running'};
          saveJson(taskFile, pending);
        }},
        {label: 'notfinal', mutate: () => {
          writeDeliveryBundle(taskDir, bundleSnapshot(originalRecord, originalIndex, workspace, originalIndex.hostVerification, false));
        }},
      ];
      for (const scenario of scenarios) {
        restore();
        scenario.mutate();
        const history = getHistory(record.taskId);
        assert.equal((history['delivery'] as any).exportable, false, `${scenario.label}: history must not advertise exportable`);
        const destination = path.join(workspace, `export-${scenario.label}`);
        assert.throws(
          () => restarted.exportDelivery(record.taskId, destination),
          (error: unknown) => error instanceof HistoryError && error.code === 'delivery_unavailable',
          `${scenario.label}: export must refuse`,
        );
        assert.equal(existsSync(destination), false, `${scenario.label}: refusal must not create a destination`);
      }
    } finally {
      restore();
      rmSync(backup, {recursive: true, force: true});
    }
  });

  test('a linked tasks root cannot redefine the persisted-history trust anchor', async () => {
    const created = await persistedTask('tasks-root-link');
    const outsideWorkspace = makeWorkspace('outside-tasks-root');
    const outsideTasks = path.join(outsideWorkspace, 'outside-tasks');
    mkdirSync(outsideTasks, {recursive: true});
    cpSync(created.taskDir, path.join(outsideTasks, created.taskId), {recursive: true});
    const marker = 'OUTSIDE_TASKS_JUNCTION_MARKER_739';
    const externalRecord = path.join(outsideTasks, created.taskId, 'task.json');
    const record = readJson(externalRecord);
    record.workspace = marker;
    saveJson(externalRecord, record);

    const movedTasks = path.join(TEST_DATA_ROOT, 'tasks-real');
    renameSync(TASKS_ROOT, movedTasks);
    linkDirectory(outsideTasks, TASKS_ROOT);
    try {
      assert.throws(() => listHistory(), (error: unknown) => error instanceof HistoryError && error.code === 'history_unsafe');
      assert.throws(() => getHistory(created.taskId), (error: unknown) => error instanceof HistoryError && error.code === 'history_unsafe');
      assert.throws(() => historicalTaskExists(created.taskId), (error: unknown) => error instanceof HistoryError && error.code === 'history_unsafe');
      const restarted = new TaskManager();
      managers.push(restarted);
      assert.throws(
        () => restarted.exportDelivery(created.taskId, path.join(outsideWorkspace, 'must-not-export')),
        (error: unknown) => error instanceof HistoryError && error.code === 'history_unsafe',
      );
      assert.equal(existsSync(path.join(outsideWorkspace, 'must-not-export')), false);
    } finally {
      if (process.platform === 'win32') rmdirSync(TASKS_ROOT);
      else unlinkSync(TASKS_ROOT);
      renameSync(movedTasks, TASKS_ROOT);
    }
  });
});
