/**
 * Checkpoint-recovery regression tests. All tasks are driven by the scripted runtime
 * (test/fixtures/fake-runtime.mjs): no real model request, provider credential or pinned SDK
 * runtime is involved. The protected host runs the real cold-restart scenario separately.
 *
 * The two_phase fixture writes phase-1.txt on its first turn and phase-2.txt when it sees phase-1.
 * A checker requiring both therefore fails on the source stage and passes only after the recovered
 * NEW session completes phase2, which is exactly the checkpoint contract without a real provider.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';

import {
  applyScriptedEnv, cleanupDir, connectBridge, jsonOf, makeWorkspace, scriptedBridgeEnv,
  TEST_DATA_ROOT, TEST_ROOT, textOf,
} from './helpers.js';

applyScriptedEnv({FAKE_SCENARIO: 'two_phase'});
process.env['FAKE_SCENARIO'] = 'two_phase';

const {TaskManager, BridgeError} = await import('../src/tasks.js');
const {getHistory, listHistory} = await import('../src/history.js');
const {RecoveryError, RECOVERY_LIMITS, workspaceFingerprint} = await import('../src/recovery.js');

const managers: Array<InstanceType<typeof TaskManager>> = [];

after(async () => {
  for (const manager of managers.splice(0)) {
    try { await manager.shutdownAll(); } catch { /* already stopped */ }
  }
  cleanupDir(TEST_ROOT);
});

const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function hashTree(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(path.join(root, rel), {withFileTypes: true})) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, hashTree(root, next));
    else if (entry.isFile()) out[next] = sha(readFileSync(path.join(root, next)));
  }
  return out;
}

function checkerText(): string {
  return [
    "import {readFileSync} from 'node:fs';",
    "import path from 'node:path';",
    'const root = process.argv[2];',
    "for (const [name, text] of [['phase-1.txt', 'PHASE_ONE_DONE\\n'], ['phase-2.txt', 'PHASE_TWO_DONE\\n']]) {",
    "  try { if (readFileSync(path.join(root, name), 'utf8') !== text) throw Error('bytes'); }",
    "  catch { console.error('MISSING:' + name); process.exit(1); }",
    '}',
    "console.log('BOTH_PHASES_DONE');",
  ].join('\n');
}

interface SourceTask {
  manager: InstanceType<typeof TaskManager>;
  taskId: string;
  taskDir: string;
  workspace: string;
  checker: string;
  record: Record<string, any>;
  result: Record<string, any>;
}

/** Create a persisted two-phase source task and stop its runtime (simulating a bridge restart). */
async function makeSource(label: string, extra: Record<string, unknown> = {}): Promise<SourceTask> {
  const manager = new TaskManager();
  managers.push(manager);
  const workspace = makeWorkspace(`recovery-${label}`);
  // The protected checker lives outside the workspace, like the protected host fixture, so
  // changing its bytes is a verifier change rather than a workspace-fingerprint change.
  const checker = path.join(makeWorkspace(`recovery-checker-${label}`), 'checker.mjs');
  writeFileSync(checker, checkerText(), 'utf8');
  const record = await manager.submit({
    workspace,
    goal: `Recovery fixture ${label}: preserve phase1 and complete phase2 only.`,
    constraints: ['Do not modify the checker.'],
    acceptance: 'Both phase files exist with exact bytes.',
    verificationCommand: [process.execPath, checker, workspace, '--secret-argv-marker'],
    protectedVerificationFiles: [checker],
    ...extra,
  });
  const settled = await manager.wait(record.taskId, 30_000);
  assert.equal(settled.outcome, 'settled');
  const result = manager.result(record.taskId) as unknown as Record<string, any>;
  assert.equal(result.bridgeObserved.verification.status, 'failed', 'the first stage must fail the two-phase checker');
  assert.equal(readFileSync(path.join(workspace, 'phase-1.txt'), 'utf8'), 'PHASE_ONE_DONE\n');
  assert.equal(existsSync(path.join(workspace, 'phase-2.txt')), false);
  const taskDir = String(result.artifacts.taskDir);
  await manager.shutdownAll();
  return {manager, taskId: record.taskId, taskDir, workspace, checker, record: readJson(path.join(taskDir, 'task.json')), result};
}

function recoveryRequest(source: SourceTask, planToken: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: source.taskId,
    workspace: source.workspace,
    planToken,
    instructions: 'This is the recovery stage. Phase1 is already complete and pinned. Preserve it and write ONLY phase-2.txt with exactly PHASE_TWO_DONE plus one newline. Then stop.',
    verificationCommand: [process.execPath, source.checker, source.workspace],
    protectedVerificationFiles: [source.checker],
    ...overrides,
  };
}

async function expectCode(fn: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof BridgeError || error instanceof RecoveryError, `expected BridgeError/RecoveryError, got ${String(error)}`);
    assert.equal((error as {code?: string}).code, code, (error as Error).message);
    return;
  }
  assert.fail(`expected refusal ${code}, but the call succeeded`);
}

describe('pre-prompt checkpoint durability', () => {
  test('a first stage that is still running already has a valid current-stage checkpoint', async () => {
    const manager = new TaskManager();
    managers.push(manager);
    const previous = process.env['FAKE_SCENARIO'];
    process.env['FAKE_SCENARIO'] = 'slow';
    try {
      const workspace = makeWorkspace('recovery-preprompt');
      const record = await manager.submit({workspace, goal: 'A slow scripted stage that is still in flight.'});
      try {
        const taskDir = path.join(TEST_DATA_ROOT, 'tasks', record.taskId);
        const checkpointFile = path.join(taskDir, 'checkpoint.json');
        assert.ok(existsSync(checkpointFile), 'the checkpoint must exist before the first turn can end');
        const checkpoint = readJson(checkpointFile);
        const persisted = readJson(path.join(taskDir, 'task.json'));
        assert.equal(persisted.state, 'running');
        assert.equal(checkpoint.taskId, record.taskId);
        assert.equal(checkpoint.sessionId, `session-${record.taskId}`);
        assert.equal(checkpoint.stage, 1);
        assert.equal(checkpoint.taskState, persisted.state);
        assert.equal(checkpoint.stageState, persisted.stages[0].state);
        assert.ok(['accepted', 'starting', 'running'].includes(checkpoint.stageState));
        assert.equal(existsSync(path.join(taskDir, 'evidence', 'stage-1-result.json')), false,
          'no stage result can exist before the first turn ends');
        assert.ok(existsSync(path.join(taskDir, 'checkpoints', 'stage-1.json')));
      } finally {
        await manager.shutdownAll();
      }
    } finally {
      if (previous === undefined) delete process.env['FAKE_SCENARIO'];
      else process.env['FAKE_SCENARIO'] = previous;
    }
  });

  test('recovers a partial unsettled source from a pre-prompt checkpoint after explicit acknowledgment', async () => {
    const source = await makeSource('partial-unsettled');
    const taskFile = path.join(source.taskDir, 'task.json');
    const checkpointFile = path.join(source.taskDir, 'checkpoint.json');
    // Simulate the crash window: the bridge had persisted a live record but only the checkpoint
    // written before the prompt. No stage result or delivery can exist yet.
    const record = readJson(taskFile);
    record.state = 'running';
    writeJson(taskFile, record);
    const checkpoint = readJson(checkpointFile);
    checkpoint.taskState = 'starting';
    checkpoint.stageState = 'accepted';
    checkpoint.reason = 'pre-prompt';
    writeJson(checkpointFile, checkpoint);
    rmSync(path.join(source.taskDir, 'evidence', 'stage-1-result.json'), {force: true});
    rmSync(path.join(source.taskDir, 'delivery'), {recursive: true, force: true});

    const manager = new TaskManager();
    managers.push(manager);
    const before = hashTree(source.taskDir);
    const phase1Sha = sha(readFileSync(path.join(source.workspace, 'phase-1.txt')));
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    assert.equal(plan.source.recordedState, 'running');
    assert.equal(plan.source.recordedStageState, 'awaiting_review');
    assert.equal(plan.source.checkpointReason, 'pre-prompt');
    assert.equal(plan.requires.allowUnsettledSource, true);
    await expectCode(() => manager.recoverTask(recoveryRequest(source, plan.planToken) as any), 'recovery_unsettled_source');
    assert.equal(manager.listTasks().length, 0);

    const recovered = await manager.recoverTask(recoveryRequest(source, plan.planToken, {allowUnsettledSource: true}) as any);
    assert.equal(recovered.recoveredFrom.unsettledSourceAcknowledged, true);
    const settled = await manager.wait(recovered.taskId, 30_000);
    assert.equal(settled.outcome, 'settled');
    const result = manager.result(recovered.taskId);
    assert.equal(result.bridgeObserved.verification.status, 'passed');
    assert.equal(sha(readFileSync(path.join(source.workspace, 'phase-1.txt'))), phase1Sha);
    assert.equal(readFileSync(path.join(source.workspace, 'phase-2.txt'), 'utf8'), 'PHASE_TWO_DONE\n');
    assert.deepEqual(hashTree(source.taskDir), before, 'the unsettled old task tree must remain byte-identical');
  });
});

describe('recovery delivery scope', () => {
  test('a recovered task captures a fresh patch baseline and never replays the source paths', async () => {
    const source = await makeSource('fresh-delivery-scope');
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    const recovered = await manager.recoverTask(recoveryRequest(source, plan.planToken, {
      deliverySource: {mode: 'patch', paths: ['.']},
    }) as any);
    const settled = await manager.wait(recovered.taskId, 30_000);
    assert.equal(settled.outcome, 'settled');
    const result = manager.result(recovered.taskId);
    const taskDir = String(result.artifacts.taskDir);
    const index = readJson(path.join(taskDir, 'delivery', 'index.json'));
    assert.equal(index.source.mode, 'patch');
    assert.deepEqual(index.source.scope, {paths: ['.'], exclude: []});
    assert.ok(index.source.baseline.files.some((file: any) => file.path === 'phase-1.txt'));
    assert.equal(index.source.baseline.files.some((file: any) => file.path === 'phase-2.txt'), false,
      'the recovered baseline is taken before its own first prompt');
    assert.ok(index.source.final.files.some((file: any) => file.path === 'phase-2.txt'));
    assert.deepEqual(index.source.files.map((file: any) => file.path), ['phase-2.txt']);
    assert.deepEqual(index.changes.added, ['phase-2.txt']);
    const record = readJson(path.join(taskDir, 'task.json'));
    assert.deepEqual(record.deliverySource, {mode: 'patch', paths: ['.'], exclude: []});
    assert.equal(record.deliveryBaselineSha256, index.source.baseline.manifestSha256);
  });
});

describe('workspace fingerprint fail-closed coverage', () => {
  test('stream-hashes a >2MiB regular file and detects same-size content mutation', () => {
    const workspace = makeWorkspace('fingerprint-large');
    const file = path.join(workspace, 'large.bin');
    const size = RECOVERY_LIMITS.workspaceFileBytes + 1;
    writeFileSync(file, Buffer.alloc(size, 0x41));
    const before = workspaceFingerprint(workspace);
    writeFileSync(file, Buffer.alloc(size, 0x42));
    const after = workspaceFingerprint(workspace);
    assert.notEqual(after, before, 'a same-size mutation beyond the old per-file cap must change the fingerprint');
    assert.equal(workspaceFingerprint(workspace), after, 'the fingerprint must stay deterministic for unchanged bytes');
  });

  test('refuses file-count overflow instead of returning a partial fingerprint', () => {
    const workspace = makeWorkspace('fingerprint-count');
    for (let n = 0; n <= RECOVERY_LIMITS.workspaceFiles; n += 1) {
      writeFileSync(path.join(workspace, `f${String(n).padStart(5, '0')}.txt`), 'x');
    }
    assert.throws(
      () => workspaceFingerprint(workspace),
      (error: unknown) => error instanceof RecoveryError
        && (error as {code?: string}).code === 'recovery_workspace_too_many_files',
    );
  });

  test('refuses a regular file above the total byte budget without a digest-null inventory', () => {
    const workspace = makeWorkspace('fingerprint-total');
    const file = path.join(workspace, 'oversize.bin');
    const fd = openSync(file, 'w');
    try { ftruncateSync(fd, RECOVERY_LIMITS.workspaceTotalBytes + 1); }
    finally { closeSync(fd); }
    assert.throws(
      () => workspaceFingerprint(workspace),
      (error: unknown) => error instanceof RecoveryError
        && (error as {code?: string}).code === 'recovery_workspace_too_large',
    );
  });

  test('the real MCP prepare refuses an unsupported workspace before any runtime or task exists', async () => {
    const source = await makeSource('fingerprint-prepare-refusal');
    for (let n = 0; n <= RECOVERY_LIMITS.workspaceFiles; n += 1) {
      writeFileSync(path.join(source.workspace, `extra-${String(n).padStart(5, '0')}.txt`), 'x');
    }
    const bridge = await connectBridge(scriptedBridgeEnv({FAKE_SCENARIO: 'two_phase'}));
    try {
      const refused = await bridge.client.callTool({
        name: 'dsh_prepare_recovery',
        arguments: {taskId: source.taskId, workspace: source.workspace},
      });
      assert.equal(refused.isError, true);
      assert.match(textOf(refused), /recovery_workspace_too_many_files/);
      const capabilities = jsonOf<Record<string, any>>(await bridge.client.callTool({
        name: 'dsh_get_capabilities', arguments: {},
      }));
      assert.equal(capabilities['liveTasks'].length, 0, 'a refused prepare must not leave a runtime or task');
    } finally {
      await bridge.close();
    }
  });
});

describe('dsh_prepare_recovery read-only plan', () => {
  test('returns a bounded token bound to source/checkpoint/workspace and starts no runtime', async () => {
    const source = await makeSource('plan');
    const manager = new TaskManager();
    managers.push(manager);
    assert.equal(manager.listTasks().length, 0, 'the restarted bridge has no live task');
    const before = hashTree(source.taskDir);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    assert.equal(manager.listTasks().length, 0, 'prepare must not create a live task');
    assert.match(plan.planToken, /^[a-f0-9]{64}$/);
    assert.equal(plan.mode, 'checkpoint-new-session');
    assert.equal(plan.source.taskId, source.taskId);
    assert.equal(plan.source.sessionId, `session-${source.taskId}`);
    assert.equal(plan.source.stage, 1);
    assert.equal(plan.source.recordedState, 'awaiting_review');
    assert.equal(plan.source.recordSha256, sha(readFileSync(path.join(source.taskDir, 'task.json'))));
    assert.equal(plan.source.checkpointSha256, sha(readFileSync(path.join(source.taskDir, 'checkpoint.json'))));
    assert.equal(plan.limits.fullConversationRestored, false);
    assert.equal(plan.limits.modelReasoningRestored, false);
    assert.equal(plan.limits.oldEvidenceReadOnly, true);
    assert.equal(plan.requires.freshVerificationCommand, true);
    assert.equal(plan.requires.freshProtectedVerificationFiles, true);
    assert.deepEqual(hashTree(source.taskDir), before, 'prepare must not touch the old task tree');
    const serialized = JSON.stringify(plan);
    assert.ok(!serialized.includes('--secret-argv-marker'), 'the recorded argv must not be exposed');
    assert.ok(!serialized.includes('Recovery fixture plan: preserve phase1'), 'the original prompt/goal must not be exposed');
    assert.ok(!serialized.includes('Do not modify the checker'), 'the original constraints must not be exposed');
  });

  test('refuses a source still in the live task map (use continue instead)', async () => {
    const manager = new TaskManager();
    managers.push(manager);
    const workspace = makeWorkspace('recovery-live');
    const record = await manager.submit({workspace, goal: 'live source'});
    await expectCode(() => manager.prepareRecovery({taskId: record.taskId, workspace}), 'recovery_source_live');
    assert.equal(manager.listTasks().length, 1);
  });

  test('refuses traversal ids and a non-matching workspace', async () => {
    const source = await makeSource('bad-workspace');
    const manager = new TaskManager();
    managers.push(manager);
    await expectCode(() => manager.prepareRecovery({taskId: '../dsh-20260101000000-abcdef', workspace: source.workspace}), 'recovery_not_found');
    await expectCode(() => manager.prepareRecovery({taskId: source.taskId, workspace: makeWorkspace('recovery-other')}), 'recovery_workspace_mismatch');
  });

  test('missing and corrupt checkpoints are explicit refusals', async () => {
    const missing = await makeSource('missing-checkpoint');
    unlinkSync(path.join(missing.taskDir, 'checkpoint.json'));
    const manager = new TaskManager();
    managers.push(manager);
    await expectCode(() => manager.prepareRecovery({taskId: missing.taskId, workspace: missing.workspace}), 'recovery_checkpoint_missing');

    const corrupt = await makeSource('corrupt-checkpoint');
    writeFileSync(path.join(corrupt.taskDir, 'checkpoint.json'), '{not json', 'utf8');
    await expectCode(() => manager.prepareRecovery({taskId: corrupt.taskId, workspace: corrupt.workspace}), 'recovery_checkpoint_invalid');

    const mismatch = await makeSource('mismatch-checkpoint');
    const checkpointFile = path.join(mismatch.taskDir, 'checkpoint.json');
    const checkpoint = readJson(checkpointFile);
    checkpoint.stage = 2;
    writeJson(checkpointFile, checkpoint);
    await expectCode(() => manager.prepareRecovery({taskId: mismatch.taskId, workspace: mismatch.workspace}), 'recovery_checkpoint_mismatch');
  });

  test('a linked recovery ledger root is refused, not followed', async () => {
    const source = await makeSource('ledger-link');
    const recoveryRoot = path.join(TEST_DATA_ROOT, 'recovery');
    rmSync(recoveryRoot, {recursive: true, force: true});
    const target = makeWorkspace('recovery-ledger-target');
    symlinkSync(target, recoveryRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    await expectCode(() => manager.recoverTask(recoveryRequest(source, plan.planToken) as any), 'recovery_ledger_unsafe');
    rmSync(recoveryRoot, {recursive: true, force: true});
    assert.equal(manager.listTasks().length, 0);
  });
});

  test('a linked tasks root cannot redefine the source trust anchor', async () => {
    const source = await makeSource('tasks-link');
    const tasks = path.join(TEST_DATA_ROOT, 'tasks');
    const real = path.join(TEST_DATA_ROOT, 'tasks-real');
    renameSync(tasks, real);
    symlinkSync(real, tasks, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const manager = new TaskManager();
      managers.push(manager);
      await expectCode(() => manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace}), 'recovery_unsafe');
    } finally {
      unlinkSync(tasks);
      renameSync(real, tasks);
    }
  });

  test('a linked claim file is refused instead of followed', async () => {
    const source = await makeSource('claim-link');
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    const claimDir = path.join(TEST_DATA_ROOT, 'recovery', 'claims');
    mkdirSync(claimDir, {recursive: true});
    const outside = path.join(makeWorkspace('recovery-claim-target'), 'claim.json');
    writeFileSync(outside, '{}', 'utf8');
    symlinkSync(outside, path.join(claimDir, `${plan.planToken}.json`));
    await expectCode(() => manager.recoverTask(recoveryRequest(source, plan.planToken) as any), 'recovery_ledger_unsafe');
    assert.equal(manager.listTasks().length, 0);
  });

  test('a record whose taskId does not match its directory is refused', async () => {
    const source = await makeSource('record-identity');
    const taskFile = path.join(source.taskDir, 'task.json');
    const record = readJson(taskFile);
    record.taskId = 'dsh-20260101000000-zzzzzz';
    writeJson(taskFile, record);
    const manager = new TaskManager();
    managers.push(manager);
    await expectCode(() => manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace}), 'recovery_invalid');
  });

describe('dsh_recover_task success and idempotency', () => {
  test('starts a NEW task/session, passes fresh verification, preserves phase1 and leaves the old tree immutable', async () => {
    const source = await makeSource('success');
    const sourceBefore = hashTree(source.taskDir);
    const phase1Sha = sha(readFileSync(path.join(source.workspace, 'phase-1.txt')));
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    const recovered = await manager.recoverTask(recoveryRequest(source, plan.planToken) as any);
    assert.equal(recovered.alreadyRecovered, false);
    assert.notEqual(recovered.taskId, source.taskId);
    assert.notEqual(recovered.sessionId, `session-${source.taskId}`);
    assert.equal(recovered.recoveredFrom.mode, 'checkpoint-new-session');
    assert.equal(recovered.recoveredFrom.taskId, source.taskId);
    assert.equal(recovered.recoveredFrom.stage, 1);
    assert.equal(recovered.recoveredFrom.sessionId, `session-${source.taskId}`);
    assert.equal(recovered.recoveredFrom.recordSha256, sourceBefore['task.json']);
    assert.equal(recovered.recoveredFrom.checkpointSha256, sourceBefore['checkpoint.json']);
    assert.equal(recovered.recoveredFrom.planToken, plan.planToken);

    const settled = await manager.wait(recovered.taskId, 30_000);
    assert.equal(settled.outcome, 'settled');
    const result = manager.result(recovered.taskId);
    assert.equal(result.bridgeObserved.verification.status, 'passed');
    assert.equal(result.bridgeObserved.verification.lastRun?.exitCode, 0);
    assert.equal(result.recoveredFrom?.taskId, source.taskId);
    assert.equal(sha(readFileSync(path.join(source.workspace, 'phase-1.txt'))), phase1Sha);
    assert.equal(readFileSync(path.join(source.workspace, 'phase-2.txt'), 'utf8'), 'PHASE_TWO_DONE\n');
    assert.deepEqual(hashTree(source.taskDir), sourceBefore, 'the old task tree must remain byte-identical');

    const status = manager.status(recovered.taskId);
    assert.equal(status.recoveredFrom?.taskId, source.taskId);
    const history = getHistory(recovered.taskId) as Record<string, any>;
    assert.equal(history.recoveredFrom.taskId, source.taskId);
    assert.equal(history.recoveredFrom.mode, 'checkpoint-new-session');
    assert.equal(history.recoveredFrom.stage, 1);
    const listed = listHistory({limit: 100}) as Record<string, any>;
    const row = (listed.tasks as Array<Record<string, any>>).find((item) => item.taskId === recovered.taskId);
    assert.ok(row);
    assert.equal(row!.recoveredFrom.taskId, source.taskId);

    // Old evidence still says failed; the recovery did not rewrite it.
    const oldResult = readJson(path.join(source.taskDir, 'evidence', 'stage-1-result.json'));
    assert.equal(oldResult.bridgeObserved.verification.status, 'failed');
  });

  test('same-plan retry returns the same taskId and starts no second runtime', async () => {
    const source = await makeSource('retry');
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    const first = await manager.recoverTask(recoveryRequest(source, plan.planToken) as any);
    const second = await manager.recoverTask(recoveryRequest(source, plan.planToken) as any);
    assert.equal(second.taskId, first.taskId);
    assert.equal(second.alreadyRecovered, true);
    assert.equal(manager.listTasks().length, 1, 'the retry must not create a second live task');
    await manager.wait(first.taskId, 30_000);
  });

  test('same-plan retry wins over a now-unsupported workspace fingerprint', async () => {
    const source = await makeSource('retry-unsupported-workspace');
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    const first = await manager.recoverTask(recoveryRequest(source, plan.planToken) as any);
    const settled = await manager.wait(first.taskId, 30_000);
    assert.equal(settled.outcome, 'settled');
    for (let n = 0; n <= RECOVERY_LIMITS.workspaceFiles; n += 1) {
      writeFileSync(path.join(source.workspace, `retry-extra-${String(n).padStart(5, '0')}.txt`), 'x');
    }
    const second = await manager.recoverTask(recoveryRequest(source, plan.planToken) as any);
    assert.equal(second.taskId, first.taskId);
    assert.equal(second.alreadyRecovered, true);
    assert.equal(manager.listTasks().length, 1, 'the idempotent retry must not start another runtime');
  });

  test('concurrent attempts resolve to one task without duplicating work', async () => {
    const source = await makeSource('concurrent');
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    const request = recoveryRequest(source, plan.planToken) as any;
    const [left, right] = await Promise.all([manager.recoverTask(request), manager.recoverTask(request)]);
    assert.equal(left.taskId, right.taskId);
    assert.equal([left, right].filter((item) => item.alreadyRecovered === false).length, 1);
    assert.equal(manager.listTasks().length, 1);
    await manager.wait(left.taskId, 30_000);
  });

  test('post-restart retry is idempotent through the real MCP stdio surface', async () => {
    const source = await makeSource('mcp-restart');
    const env = scriptedBridgeEnv({FAKE_SCENARIO: 'two_phase'});
    const first = await connectBridge(env);
    let recoveredTaskId = '';
    let request: Record<string, unknown> | null = null;
    try {
      const tools = await first.client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      assert.ok(names.includes('dsh_prepare_recovery'));
      assert.ok(names.includes('dsh_recover_task'));
      const prepared = jsonOf<Record<string, any>>(await first.client.callTool({name: 'dsh_prepare_recovery', arguments: {taskId: source.taskId, workspace: source.workspace}}));
      request = recoveryRequest(source, String(prepared['planToken']));
      const recovered = jsonOf<Record<string, any>>(await first.client.callTool({name: 'dsh_recover_task', arguments: request as any}));
      recoveredTaskId = String(recovered['taskId']);
      assert.notEqual(recoveredTaskId, source.taskId);
      for (let i = 0; i < 40; i += 1) {
        const waited = jsonOf<Record<string, any>>(await first.client.callTool({name: 'dsh_wait_task', arguments: {taskId: recoveredTaskId, timeoutMs: 5_000}}));
        if (waited['outcome'] === 'settled') break;
      }
      const result = jsonOf<Record<string, any>>(await first.client.callTool({name: 'dsh_get_result', arguments: {taskId: recoveredTaskId}}));
      assert.equal(result['bridgeObserved'].verification.status, 'passed');
      const cancelled = jsonOf<Record<string, any>>(await first.client.callTool({name: 'dsh_cancel_task', arguments: {taskId: recoveredTaskId, reason: 'test cleanup'}}));
      assert.equal(cancelled['runtimeStopped'], true);
    } finally {
      try {
        if (recoveredTaskId) await first.client.callTool({name: 'dsh_cancel_task', arguments: {taskId: recoveredTaskId, reason: 'test cleanup'}});
      } catch { /* cleanup must not mask the assertion */ }
      await first.close();
    }

    assert.ok(request, 'the first bridge must have built the recovery request');
    const second = await connectBridge(env);
    try {
      const repeated = jsonOf<Record<string, any>>(await second.client.callTool({
        name: 'dsh_recover_task',
        arguments: request as any,
      }));
      assert.equal(repeated['taskId'], recoveredTaskId);
      assert.equal(repeated['alreadyRecovered'], true);
      const caps = jsonOf<Record<string, any>>(await second.client.callTool({name: 'dsh_get_capabilities', arguments: {}}));
      assert.equal(caps['liveTasks'].length, 0, 'idempotent post-restart recovery must not start another runtime');
    } finally {
      await second.close();
    }
  });
});

describe('dsh_recover_task negative cases', () => {
  test('source drift after planning refuses before any runtime or task', async () => {
    const source = await makeSource('source-drift');
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    const taskFile = path.join(source.taskDir, 'task.json');
    writeFileSync(taskFile, `${readFileSync(taskFile, 'utf8')}\n`, 'utf8');
    await expectCode(() => manager.recoverTask(recoveryRequest(source, plan.planToken) as any), 'recovery_plan_stale');
    assert.equal(manager.listTasks().length, 0, 'no model request or runtime may start after drift');
  });

  test('workspace drift after planning refuses before any runtime or task', async () => {
    const source = await makeSource('workspace-drift');
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    writeFileSync(path.join(source.workspace, 'late-change.txt'), 'drift', 'utf8');
    await expectCode(() => manager.recoverTask(recoveryRequest(source, plan.planToken) as any), 'recovery_plan_stale');
    assert.equal(manager.listTasks().length, 0);
  });

  test('a changed protected verifier is refused even when its bytes are re-pinned by the caller', async () => {
    const source = await makeSource('verifier-change');
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    writeFileSync(source.checker, `${checkerText()}\n// changed\n`, 'utf8');
    await expectCode(() => manager.recoverTask(recoveryRequest(source, plan.planToken) as any), 'recovery_verifier_changed');
    assert.equal(manager.listTasks().length, 0);
  });

  test('fresh verification and the original pins are required when the source configured them', async () => {
    const source = await makeSource('fresh-verification');
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    const noCommand = recoveryRequest(source, plan.planToken);
    delete (noCommand as any).verificationCommand;
    await expectCode(() => manager.recoverTask(noCommand as any), 'recovery_verification_required');
    const noPins = recoveryRequest(source, plan.planToken);
    delete (noPins as any).protectedVerificationFiles;
    await expectCode(() => manager.recoverTask(noPins as any), 'recovery_verification_required');
    assert.equal(manager.listTasks().length, 0);
  });

  test('an unsettled source is refused by default and allowed only with explicit acknowledgment', async () => {
    const source = await makeSource('unsettled');
    const recordFile = path.join(source.taskDir, 'task.json');
    const checkpointFile = path.join(source.taskDir, 'checkpoint.json');
    const record = readJson(recordFile);
    record.state = 'running';
    writeJson(recordFile, record);
    const checkpoint = readJson(checkpointFile);
    checkpoint.taskState = 'running';
    writeJson(checkpointFile, checkpoint);

    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    assert.equal(plan.source.recordedState, 'running');
    assert.equal(plan.requires.allowUnsettledSource, true);
    assert.ok(plan.warnings.some((warning) => /allowUnsettledSource/.test(warning)));
    await expectCode(() => manager.recoverTask(recoveryRequest(source, plan.planToken) as any), 'recovery_unsettled_source');
    assert.equal(manager.listTasks().length, 0);

    const recovered = await manager.recoverTask(recoveryRequest(source, plan.planToken, {allowUnsettledSource: true}) as any);
    assert.equal(recovered.recoveredFrom.unsettledSourceAcknowledged, true);
    const newRecord = readJson(path.join(recovered.taskDir!, 'task.json'));
    assert.equal(newRecord.recoveredFrom.unsettledSourceAcknowledged, true);
    assert.ok(newRecord.configurationWarnings.some((warning: string) => /allowUnsettledSource=true/.test(warning)));
    await manager.wait(recovered.taskId, 30_000);
  });

  test('an in-progress claim is refused without starting a duplicate task', async () => {
    const source = await makeSource('in-progress-claim');
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    const claimDir = path.join(TEST_DATA_ROOT, 'recovery', 'claims');
    mkdirSync(claimDir, {recursive: true});
    const claim = {
      schema: 'codex-dsh-bridge/recovery-claim@1',
      planToken: plan.planToken,
      mode: 'checkpoint-new-session',
      state: 'starting',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      allowUnsettledSource: false,
      source: {
        taskId: source.taskId,
        sessionId: `session-${source.taskId}`,
        stage: 1,
        recordSha256: plan.source.recordSha256,
        checkpointSha256: plan.source.checkpointSha256,
        workspace: source.workspace,
        workspaceFingerprint: plan.source.workspaceFingerprint,
      },
      recovery: {taskId: 'dsh-20260101000000-abcdef', sessionId: 'session-dsh-20260101000000-abcdef', runtimePid: null},
      failure: null,
      note: 'synthetic in-progress claim',
    };
    writeFileSync(path.join(claimDir, `${plan.planToken}.json`), JSON.stringify(claim, null, 2));
    await expectCode(() => manager.recoverTask(recoveryRequest(source, plan.planToken) as any), 'recovery_in_progress');
    assert.equal(manager.listTasks().length, 0);
  });

  test('a safe pre-start failure claim can be cleared, while an uncertain one is refused', async () => {
    const source = await makeSource('failed-claim');
    const manager = new TaskManager();
    managers.push(manager);
    const plan = manager.prepareRecovery({taskId: source.taskId, workspace: source.workspace});
    const claimDir = path.join(TEST_DATA_ROOT, 'recovery', 'claims');
    mkdirSync(claimDir, {recursive: true});
    const claimFile = path.join(claimDir, `${plan.planToken}.json`);
    const base = {
      schema: 'codex-dsh-bridge/recovery-claim@1', planToken: plan.planToken, mode: 'checkpoint-new-session',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), allowUnsettledSource: false,
      source: {
        taskId: source.taskId, sessionId: `session-${source.taskId}`, stage: 1,
        recordSha256: plan.source.recordSha256, checkpointSha256: plan.source.checkpointSha256,
        workspace: source.workspace, workspaceFingerprint: plan.source.workspaceFingerprint,
      },
      recovery: {taskId: null, sessionId: null, runtimePid: null}, note: 'synthetic failed claim',
    };
    writeJson(claimFile, {...base, state: 'failed', failure: {code: 'preflight', message: 'no task', taskCreated: false, runtimeStartBegan: false, uncertain: false}});
    const recovered = await manager.recoverTask(recoveryRequest(source, plan.planToken) as any);
    assert.equal(recovered.alreadyRecovered, false);
    await manager.wait(recovered.taskId, 30_000);

    const second = await makeSource('uncertain-claim');
    const secondManager = new TaskManager();
    managers.push(secondManager);
    const secondPlan = secondManager.prepareRecovery({taskId: second.taskId, workspace: second.workspace});
    writeJson(path.join(claimDir, `${secondPlan.planToken}.json`), {
      ...base,
      planToken: secondPlan.planToken,
      source: {
        taskId: second.taskId, sessionId: `session-${second.taskId}`, stage: 1,
        recordSha256: secondPlan.source.recordSha256, checkpointSha256: secondPlan.source.checkpointSha256,
        workspace: second.workspace, workspaceFingerprint: secondPlan.source.workspaceFingerprint,
      },
      state: 'failed',
      failure: {code: 'uncertain', message: 'startup unknown', taskCreated: true, runtimeStartBegan: true, uncertain: true},
    });
    await expectCode(() => secondManager.recoverTask(recoveryRequest(second, secondPlan.planToken) as any), 'recovery_start_uncertain');
    assert.equal(secondManager.listTasks().length, 0);
  });
});
