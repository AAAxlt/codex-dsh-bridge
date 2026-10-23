import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {
  COMPLETE_DELIVERY_DEFAULTS, COMPLETE_DELIVERY_REQUIREMENTS, DeliveryPresetError, resolveDeliverySettings,
} from '../src/delivery-preset.js';
import type {DeliveryPresetInput} from '../src/delivery-preset.js';

const acceptance = {verificationCommand: ['node', 'accept.mjs'], protectedVerificationFiles: ['accept.mjs']};

describe('delivery preset policy', () => {
  test('omission retains legacy work defaults and does not require host verification', () => {
    assert.deepEqual(resolveDeliverySettings(), {
      deliveryPreset: undefined, reasoningEffort: 'medium', maxTokens: 16_384, budgetMs: 300_000,
      verificationCommand: undefined, verificationTimeoutMs: 300_000, protectedVerificationFiles: [],
      autoRepair: {enabled: false, maxAttempts: 3, noProgressLimit: 2, totalBudgetMs: 3_600_000},
    });
  });

  test('complete opts into ample budgets, bounded repair and independent delivery requirements', () => {
    const resolved = resolveDeliverySettings({deliveryPreset: 'complete', ...acceptance});
    assert.equal(resolved.reasoningEffort, 'high');
    assert.equal(resolved.maxTokens, 32_768);
    assert.equal(resolved.budgetMs, 1_800_000);
    assert.equal(resolved.verificationTimeoutMs, 600_000);
    assert.deepEqual(resolved.autoRepair, {enabled: true, maxAttempts: 3, noProgressLimit: 2, totalBudgetMs: 3_600_000});
    assert.match(COMPLETE_DELIVERY_REQUIREMENTS, /Do not modify protected verification files/);
    assert.match(COMPLETE_DELIVERY_REQUIREMENTS, /skipped checks are not full acceptance/);
  });

  test('explicit diagnostic budgets and partial repair settings override complete defaults', () => {
    const resolved = resolveDeliverySettings({
      deliveryPreset: 'complete', ...acceptance, reasoningEffort: 'off', maxTokens: 256,
      budgetMs: 1_000, verificationTimeoutMs: 1_000,
      autoRepair: {enabled: false, maxAttempts: 1, totalBudgetMs: 1_000},
    });
    assert.equal(resolved.reasoningEffort, 'off');
    assert.equal(resolved.maxTokens, 256);
    assert.equal(resolved.budgetMs, 1_000);
    assert.equal(resolved.verificationTimeoutMs, 1_000);
    assert.deepEqual(resolved.autoRepair, {enabled: false, maxAttempts: 1, noProgressLimit: 2, totalBudgetMs: 1_000});
  });

  test('legacy explicit parameters are retained and repair may be independently enabled', () => {
    const resolved = resolveDeliverySettings({...acceptance, reasoningEffort: 'none', budgetMs: 900_000, autoRepair: {enabled: true, noProgressLimit: 1}});
    assert.equal(resolved.deliveryPreset, undefined);
    assert.equal(resolved.reasoningEffort, 'none');
    assert.equal(resolved.budgetMs, 900_000);
    assert.equal(resolved.maxTokens, 16_384);
    assert.equal(resolved.autoRepair.enabled, true);
    assert.equal(resolved.autoRepair.noProgressLimit, 1);
  });

  test('complete requires command and protected files even when repairs are disabled', () => {
    for (const missing of [{}, {verificationCommand: ['node', 'accept.mjs']}, {protectedVerificationFiles: ['accept.mjs']}]) {
      assert.throws(() => resolveDeliverySettings({deliveryPreset: 'complete', autoRepair: {enabled: false}, ...missing}), DeliveryPresetError);
      assert.throws(() => resolveDeliverySettings({autoRepair: {enabled: true}, ...missing}), DeliveryPresetError);
    }
  });

  test('pure resolution neither mutates frozen inputs nor shares mutable output arrays', () => {
    const input = Object.freeze({deliveryPreset: 'complete' as const,
      verificationCommand: Object.freeze(['node', '--title= two words ', '']),
      protectedVerificationFiles: Object.freeze(['accept.mjs']), autoRepair: Object.freeze({maxAttempts: 2})});
    const first = resolveDeliverySettings(input);
    const second = resolveDeliverySettings(input);
    assert.deepEqual(first.verificationCommand, ['node', '--title= two words ', '']);
    first.verificationCommand!.push('mutated');
    first.protectedVerificationFiles.push('mutated');
    first.autoRepair.enabled = false;
    assert.deepEqual(second.verificationCommand, ['node', '--title= two words ', '']);
    assert.deepEqual(second.protectedVerificationFiles, ['accept.mjs']);
    assert.equal(second.autoRepair.enabled, true);
    assert.equal(COMPLETE_DELIVERY_DEFAULTS.autoRepair.enabled, true);
  });

  test('rejects malformed input before filesystem or runtime work', () => {
    const invalid: unknown[] = [null, [], 'complete', {deliveryPreset: null}, {deliveryPreset: 'COMPLETE'},
      {reasoningEffort: null}, {reasoningEffort: 'highest'}, {maxTokens: 255}, {maxTokens: 32_769},
      {maxTokens: NaN}, {budgetMs: 999}, {budgetMs: Infinity}, {budgetMs: 86_400_001},
      {verificationTimeoutMs: 1.2}, {verificationCommand: []}, {verificationCommand: [' ']},
      {verificationCommand: ['node', null]}, {verificationCommand: ['node\0other']},
      {verificationCommand: new Array(33).fill('a')}, {verificationCommand: ['a'.repeat(513)]},
      {protectedVerificationFiles: ['']}, {protectedVerificationFiles: [null]},
      {protectedVerificationFiles: ['a\0b']}, {protectedVerificationFiles: new Array(65).fill('x')},
      {autoRepair: null}, {autoRepair: false}, {autoRepair: []}, {autoRepair: {enabled: 'yes'}},
      {autoRepair: {maxAttempts: 0}}, {autoRepair: {maxAttempts: 11}},
      {autoRepair: {noProgressLimit: 0}}, {autoRepair: {totalBudgetMs: 999}},
    ];
    for (const input of invalid) {
      const before = JSON.stringify(input);
      assert.throws(() => resolveDeliverySettings(input as DeliveryPresetInput), DeliveryPresetError, before);
      assert.equal(JSON.stringify(input), before);
    }
  });
});
