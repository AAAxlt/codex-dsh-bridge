/**
 * Permanent regressions for the real-repair harness activity metadata. These tests extract the
 * pure helper and aggregate expressions from scripts/e2e-auto-repair.mjs and evaluate them in a
 * sandbox. They never start the harness, an SDK, a provider request, or a task.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, test} from 'node:test';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'e2e-auto-repair.mjs');
const source = readFileSync(SCRIPT, 'utf8');
const helper = source.slice(source.indexOf('const PRE_SDK_REFUSAL_CODES'), source.indexOf('async function waitForSettle'));
const aggregate = source.slice(source.indexOf('const activityValues ='), source.indexOf('const providerActivity ='));
assert.ok(helper.includes('function deriveProviderActivity'), 'activity helper must remain extractable');
assert.ok(aggregate.includes('const activityValues ='), 'aggregate expression must remain extractable');

function derive(events: Array<Record<string, unknown>>, task: Record<string, unknown> | null, attempted = true, submitErrorCode: string | null = null): Record<string, any> {
  const readFileSync = (): string => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  return vm.runInNewContext(
    `${helper}\n({value: deriveProviderActivity(task, 'synthetic-events', attempted, submitErrorCode)})`,
    {readFileSync, task, attempted, submitErrorCode},
  ).value as Record<string, any>;
}

function aggregateFor(requested: string[], scenes: Record<string, unknown>): {activityValues: Array<boolean | null>; modelRequested: boolean | null} {
  return vm.runInNewContext(
    `${aggregate}\n({activityValues, modelRequested})`,
    {requested, SCENES: scenes},
  ) as {activityValues: Array<boolean | null>; modelRequested: boolean | null};
}

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtimePid: 12_345,
    stages: [{toolCallsTotal: 0, usageAccumulator: {records: 0}, modelReport: ''}],
    ...overrides,
  };
}

describe('real-repair harness activity metadata', () => {
  test('accepted-only native ACK is SDK evidence, not provider activity', () => {
    const value = derive([{kind: 'stage/accepted', stage: 1}], task());
    assert.equal(value.sdkStarted, true);
    assert.equal(value.observed, false);
    assert.equal(value.modelRequested, null);
    assert.ok(value.basis.some((item: string) => /stage\/accepted/.test(item)));
    assert.ok(!value.basis.some((item: string) => /model\/tool\/usage event/.test(item)));
  });

  test('genuine native assistant/tool/usage/report evidence is positive', () => {
    const assistant = derive([{kind: 'notification', type: 'assistant/message'}], task());
    assert.equal(assistant.observed, true);
    assert.equal(assistant.modelRequested, true);

    const usage = derive([], task({stages: [{toolCallsTotal: 0, usageAccumulator: {records: 1}, modelReport: ''}]}));
    assert.equal(usage.observed, true);
    assert.equal(usage.modelRequested, true);

    const tool = derive([], task({stages: [{toolCallsTotal: 2, usageAccumulator: {records: 0}, modelReport: ''}]}));
    assert.equal(tool.observed, true);
    assert.equal(tool.modelRequested, true);

    const report = derive([], task({stages: [{toolCallsTotal: 0, usageAccumulator: {records: 0}, modelReport: 'model output'}]}));
    assert.equal(report.observed, true);
    assert.equal(report.modelRequested, true);
  });

  test('a definitively pre-SDK rejection is false', () => {
    const value = derive([], null, true, 'execution_profile_drift');
    assert.equal(value.sdkStarted, false);
    assert.equal(value.observed, false);
    assert.equal(value.modelRequested, false);
    assert.ok(value.basis.some((item: string) => /refused before an SDK runtime/.test(item)));
  });

  test('a submit failure after possible SDK start stays unknown', () => {
    const value = derive([], null, true, 'runtime_start_failed');
    assert.equal(value.observed, false);
    assert.equal(value.modelRequested, null);
    assert.ok(value.basis.some((item: string) => /provider activity is unknown/.test(item)));
  });

  test('aggregation preserves unknown and only turns false when every scene is definitive', () => {
    const unknown = aggregateFor(['success'], {success: {providerActivity: {modelRequested: null}}});
    assert.deepEqual(unknown.activityValues, [null]);
    assert.equal(unknown.modelRequested, null);

    const mixed = aggregateFor(['success', 'noProgress'], {
      success: {providerActivity: {modelRequested: false}},
      noProgress: {providerActivity: {modelRequested: null}},
    });
    assert.deepEqual(mixed.activityValues, [false, null]);
    assert.equal(mixed.modelRequested, null);

    const positive = aggregateFor(['success', 'noProgress'], {
      success: {providerActivity: {modelRequested: true}},
      noProgress: {providerActivity: {modelRequested: null}},
    });
    assert.equal(positive.modelRequested, true);

    const definitive = aggregateFor(['success', 'noProgress'], {
      success: {providerActivity: {modelRequested: false}},
      noProgress: {providerActivity: {modelRequested: false}},
    });
    assert.equal(definitive.modelRequested, false);

    const missing = aggregateFor(['success'], {});
    assert.deepEqual(missing.activityValues, [null]);
    assert.equal(missing.modelRequested, null);
  });
});
