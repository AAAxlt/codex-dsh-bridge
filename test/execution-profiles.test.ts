/**
 * Execution-profile contract tests.
 *
 * These cover the parts of the profile feature that can be verified without a
 * model or a live DSH runtime:
 *
 *   * strict parsing (omitted vs unknown),
 *   * the generated overlay for each profile and the byte-for-byte legacy path,
 *   * the minimal preset templates (no Web/UI/planning/subagent rows),
 *   * TaskManager recording of the selection + overlay SHA-256,
 *   * a continuation keeping the same profile and overlay bytes.
 *
 * They start no model request: TaskManager is driven by the scripted runtime.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, realpathSync} from 'node:fs';
import {after, describe, test} from 'node:test';

import {applyScriptedEnv, cleanupDir, makeWorkspace, TEST_ROOT} from './helpers.js';

// Must run before src/config.js is first imported: config reads its environment once.
applyScriptedEnv();

const ep = await import('../src/execution-profiles.js');
const {ExecutionProfileError, parseExecutionProfile, renderOverlay, presetPluginTemplateFile} = ep;
const {TaskManager, BridgeError} = await import('../src/tasks.js');
const {
  API_KEY_ENV, MODEL_ID, PROVIDER_API, PROVIDER_BASE_URL, PROVIDER_HEADER_NAME, PROVIDER_HEADER_VALUE, PROVIDER_ID,
} = await import('../src/config.js');

const MANAGER = new TaskManager();

after(async () => {
  await MANAGER.shutdownAll();
  cleanupDir(TEST_ROOT);
});

function setScenario(name: string): void {
  process.env['FAKE_SCENARIO'] = name;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Independent copy of the overlay generator that existed before execution
 * profiles (tasks.ts renderOverlay). If the shared module ever changes the
 * legacy bytes, this test fails.
 */
function legacyOverlay(workspace: string): string {
  const quoted = workspace.replace(/\\/g, '/').replace(/'/g, "''");
  return [
    '- id: sandbox-policy',
    '  config:',
    '    mode: workspace-write',
    `    workspaceRoot: '${quoted}'`,
    '- id: sdk-jsonrpc-server',
    '  config:',
    '    maxTokensAsSuccess: false',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      ' + PROVIDER_ID + ':',
    '        displayName: ' + (PROVIDER_ID === 'commandcode-goat' ? 'CommandCode GOAT' : 'OpenCode Go'),
    '        apiKeyEnv: ' + API_KEY_ENV,
    '        api: ' + PROVIDER_API,
    '        baseURL: ' + PROVIDER_BASE_URL,
    ...(PROVIDER_HEADER_NAME ? ['        headers:', '          ' + PROVIDER_HEADER_NAME + ': ' + PROVIDER_HEADER_VALUE] : []),
    '        models:',
    '          - id: ' + MODEL_ID,
    '            name: ' + MODEL_ID,
    ...(PROVIDER_ID === 'commandcode-goat' ? ['            contextWindow: 1000000'] : []),
    '            reasoningEfforts:',
    "              'off': none",
    '              low: low',
    '              medium: medium',
    '              high: high',
    '',
  ].join('\n');
}

describe('execution profile parsing', () => {
  test('undefined means omitted', () => {
    assert.equal(parseExecutionProfile(undefined), undefined);
  });

  test('native and ptc are the only accepted values', () => {
    assert.equal(parseExecutionProfile('native'), 'native');
    assert.equal(parseExecutionProfile('ptc'), 'ptc');
  });

  test('every other type or value throws instead of falling back to legacy', () => {
    for (const bad of ['legacy', 'Native', 'NATIVE', 'ptc ', '', 0, 1, null, {}, [], true, false]) {
      assert.throws(
        () => parseExecutionProfile(bad),
        (error: unknown) => error instanceof ExecutionProfileError,
        `expected ${JSON.stringify(bad)} to be refused`,
      );
    }
  });
});

describe('execution profile overlay generation', () => {
  test('omitted profile is byte-identical to the legacy generator', () => {
    for (const workspace of ["/tmp/some workspace/it's", 'D:\\AGENTS\\ws\\task', '/tmp/plain']) {
      assert.equal(renderOverlay(workspace), legacyOverlay(workspace));
    }
  });

  test('native overlay mounts the preset and disables only the moved root rows', () => {
    const text = renderOverlay('/tmp/ws', 'native');
    assert.match(text, /- insert:\n {4}- id: agent-preset-registry\n {6}name: '@deepseek-ai\/dsh-agent-preset-registry'\n {6}config:\n {8}default: native\n/);
    assert.match(text, /- id: preset-native\n {6}name: '@deepseek-ai\/dsh-agent-preset'/);
    assert.match(text, /- id: dsh-candidate-preset-sdk-server\n/);
    assert.match(text, /- id: tool-presentation\n {12}name: '@deepseek-ai\/dsh-agent-tool-presentation'\n {12}config:\n {14}mode: native\n/);
    for (const id of ep.ROOT_AGENT_PLANE_DISABLES) {
      assert.match(text, new RegExp(`- id: ${id}\\n {2}disabled: true`), `root row ${id} must be disabled`);
    }
    // native keeps the workflow tooling from the root base: it must not disable it.
    assert.ok(!text.includes('- id: workflow-ptc'), 'native must keep workflow-ptc');
    assert.ok(!text.includes('- id: tool-workflow'), 'native must keep tool-workflow');
  });

  test('ptc overlay additionally disables the workflow rows and presents through ptc', () => {
    const text = renderOverlay('/tmp/ws', 'ptc');
    assert.match(text, /- id: workflow-ptc\n {2}disabled: true/);
    assert.match(text, /- id: tool-workflow\n {2}disabled: true/);
    assert.match(text, /- id: tool-presentation\n {12}name: '@deepseek-ai\/dsh-agent-tool-presentation'\n {12}config:\n {14}mode: ptc\n/);
    assert.match(text, /default: ptc/);
  });

  test('preset templates carry exactly the minimal rows and no Web/UI/planning rows', () => {
    const expectedIds = [
      'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
      'tool-jobs', 'skill-filesystem', 'tool-skill', 'tool-presentation',
    ];
    for (const profile of ['native', 'ptc'] as const) {
      const text = readFileSync(presetPluginTemplateFile(profile), 'utf8');
      const ids = [...text.matchAll(/^- id: (\S+)$/gm)].map((match) => match[1]);
      assert.deepEqual(ids, expectedIds, `${profile} template row ids drifted`);
      for (const bad of [
        'tool-ask-user', 'tool-todo', 'tool-web', 'tool-subagent', 'tool-goal',
        'plan-mode', 'tool-plugin-manager', 'tool-ralph', 'persona', 'present',
        'compaction-basic', 'command-compact', 'tool-result-pruner', 'workflow-ptc', 'tool-workflow',
      ]) {
        assert.ok(!ids.includes(bad), `${profile} template must not carry ${bad}`);
      }
    }
  });
});

describe('execution profile recorded by TaskManager', () => {
  test('a PTC child failure remains evidence even when its outer program succeeds', async () => {
    setScenario('ptc_error_caught');
    const workspace = makeWorkspace('profile-ptc-error');
    const record = await MANAGER.submit({workspace, goal:'Record the real PTC event contract.', executionProfile:'ptc'});
    await MANAGER.wait(record.taskId, 30_000);
    const result = MANAGER.result(record.taskId, undefined, true);
    assert.equal(result.bridgeObserved.toolCounts['run_code'], 1);
    assert.equal(result.bridgeObserved.toolCounts['read'], 1);
    assert.equal(result.bridgeObserved.toolErrorCount, 1);
    const child = result.bridgeObserved.toolCalls.find(x=>x.callId.endsWith(':ptc:1'));
    assert.equal(child?.isError, true);
    assert.match(child?.argumentsPreview ?? '', /missing.txt/);
    assert.ok(!(child?.outputPreview ?? '').includes('sk-FAKE'));
    const outer = result.bridgeObserved.toolCalls.find(x=>x.tool==='run_code');
    assert.equal(outer?.isError, false);
  });
  test('omitted profile keeps the legacy overlay and records null + matching SHA-256', async () => {
    setScenario('success');
    const workspace = makeWorkspace('profile-legacy');
    const record = await MANAGER.submit({workspace, goal: 'legacy overlay path'});
    const expected = legacyOverlay(realpathSync.native(workspace));
    const bytes = readFileSync(record.overlayPath, 'utf8');
    assert.equal(record.executionProfile, null);
    assert.equal(bytes, expected, 'omitting executionProfile must not change the overlay bytes');
    assert.equal(record.overlaySha256, sha256(bytes));
    await MANAGER.wait(record.taskId, 30_000);
  });

  test('native profile records the selection, the preset overlay and its SHA-256', async () => {
    setScenario('success');
    const workspace = makeWorkspace('profile-native');
    const record = await MANAGER.submit({workspace, goal: 'native overlay path', executionProfile: 'native'});
    const bytes = readFileSync(record.overlayPath, 'utf8');
    assert.equal(record.executionProfile, 'native');
    assert.equal(bytes, renderOverlay(record.workspace, 'native'));
    assert.equal(record.overlaySha256, sha256(bytes));
    assert.match(bytes, /default: native/);
    await MANAGER.wait(record.taskId, 30_000);
  });

  test('an unknown profile is refused before any task directory is created', async () => {
    setScenario('success');
    const workspace = makeWorkspace('profile-invalid');
    const before = MANAGER.listTasks().length;
    await assert.rejects(
      () => MANAGER.submit({workspace, goal: 'bad profile', executionProfile: 'legacy' as never}),
      (error: unknown) => error instanceof BridgeError && error.code === 'invalid_execution_profile',
    );
    assert.equal(MANAGER.listTasks().length, before, 'no task may be registered for a rejected profile');
  });

  test('continuation keeps the same profile and the same overlay bytes', async () => {
    setScenario('success');
    const workspace = makeWorkspace('profile-continue');
    const first = await MANAGER.submit({workspace, goal: 'stage one', executionProfile: 'ptc'});
    const bytesBefore = readFileSync(first.overlayPath, 'utf8');
    await MANAGER.wait(first.taskId, 30_000);

    const second = await MANAGER.continue(first.taskId, 'Codex review: keep going.');
    assert.equal(second.executionProfile, 'ptc', 'continuation must reuse the profile');
    assert.equal(second.overlaySha256, first.overlaySha256, 'continuation must not rewrite the overlay');
    assert.equal(readFileSync(second.overlayPath, 'utf8'), bytesBefore);
    await MANAGER.wait(first.taskId, 30_000);
  });
});
