/**
 * Pure delivery-policy resolution. This module performs no filesystem, process,
 * environment or model operations: callers validate it before allocating a task.
 * File existence, canonical paths and immutable acceptance hashes are the host's
 * responsibility; a supplied pathname is never itself proof of independent checks.
 */
import type {ReasoningEffort} from './config.js';

export type DeliveryPreset = 'complete';

export interface AutoRepairPolicy {
  enabled: boolean;
  /** Maximum additional repair stages after the initial stage. */
  maxAttempts: number;
  /** Stop after this many consecutive unchanged failed verifications. */
  noProgressLimit: number;
  /** Whole delivery-loop budget, including every stage and host verification. */
  totalBudgetMs: number;
}

/**
 * Bounded same-live-session continuation after real provider output exhaustion. It is a
 * separate policy from automatic repair: an output cut-off is not a failed acceptance check,
 * and a repair decision must never be re-labelled as a continuation (or vice versa).
 */
export interface AutoContinuePolicy {
  enabled: boolean;
  /** Maximum additional stages after the initial stage. */
  maxAttempts: number;
  /** Stop after this many consecutive exhausted stages with no source progress. */
  noProgressLimit: number;
  /** Whole continuation-cycle budget, including the initial generation. */
  totalBudgetMs: number;
}

export interface DeliveryPresetInput {
  deliveryPreset?: DeliveryPreset | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  maxTokens?: number | undefined;
  budgetMs?: number | undefined;
  verificationCommand?: readonly string[] | undefined;
  verificationTimeoutMs?: number | undefined;
  protectedVerificationFiles?: readonly string[] | undefined;
  autoRepair?: Partial<AutoRepairPolicy> | undefined;
  autoContinue?: Partial<AutoContinuePolicy> | undefined;
}

export interface ResolvedDeliverySettings {
  deliveryPreset: DeliveryPreset | undefined;
  reasoningEffort: ReasoningEffort;
  maxTokens: number;
  budgetMs: number;
  verificationCommand: string[] | undefined;
  verificationTimeoutMs: number;
  protectedVerificationFiles: string[];
  autoRepair: AutoRepairPolicy;
  /**
   * Resolved separately for compatibility: older callers deep-compare this object and the
   * 1.0.7 shape must keep resolving byte-for-byte. Submit/recover call
   * `resolveAutoContinuePolicy` alongside this function.
   */
  autoContinue?: AutoContinuePolicy;
}

export const COMPLETE_DELIVERY_REQUIREMENTS = [
  'Deliver the requested implementation and a concise final report with changed files, verification results, unresolved issues and evidence paths.',
  'Run the specified checks and repair implementation failures before declaring completion. Report passed, failed and skipped checks explicitly; skipped checks are not full acceptance.',
  'The host owns acceptance. Do not modify protected verification files, weaken assertions, remove tests, bypass checks or claim model self-report as independent verification.',
  'If permissions, unavailable credentials or another external dependency blocks progress, report the exact blocker and evidence so Codex can act.',
].join('\n');

/** Immutable defaults; explicit caller values always take precedence. */
export const COMPLETE_DELIVERY_DEFAULTS = Object.freeze({
  reasoningEffort: 'high' as const,
  maxTokens: 32_768,
  budgetMs: 1_800_000,
  verificationTimeoutMs: 600_000,
  autoRepair: Object.freeze({enabled: true, maxAttempts: 3, noProgressLimit: 2, totalBudgetMs: 3_600_000}),
  autoContinue: Object.freeze({enabled: true, maxAttempts: 2, noProgressLimit: 2, totalBudgetMs: 3_600_000}),
});

export class DeliveryPresetError extends Error {
  readonly code = 'invalid_delivery_settings';
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryPresetError';
  }
}

function integer(value: unknown, fallback: number, min: number, max: number, field: string): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== 'number' || !Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new DeliveryPresetError(`${field} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

function command(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 ||
      value.some((arg: unknown) => typeof arg !== 'string' || arg.length > 512 || arg.includes('\0')) ||
      !(value[0] as string).trim()) {
    throw new DeliveryPresetError('verificationCommand must contain 1 to 32 string arguments (maximum 512 characters each) and a non-empty executable');
  }
  // Preserve arguments exactly, including meaningful whitespace and empty argv entries.
  return [...value] as string[];
}

function protectedFiles(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 ||
      value.some((file: unknown) => typeof file !== 'string' || !file.trim() || file.length > 4_096 || file.includes('\0'))) {
    throw new DeliveryPresetError('protectedVerificationFiles must contain at most 64 non-empty file paths (maximum 4096 characters each)');
  }
  return [...value] as string[];
}

/**
 * Resolve the bounded output-exhaustion continuation policy. Omission is disabled for legacy
 * compatibility; the complete preset enables maxAttempts=2/noProgressLimit=2/one-hour budget.
 * Explicit fields always win, and every field is validated before a task directory is allocated.
 */
export function resolveAutoContinuePolicy(
  raw: unknown,
  options: {complete?: boolean; defaults?: AutoContinuePolicy} = {},
): AutoContinuePolicy {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new DeliveryPresetError('autoContinue must be an object');
  }
  const value = (raw ?? {}) as Partial<AutoContinuePolicy>;
  const defaults = options.defaults ?? {
    enabled: options.complete === true,
    maxAttempts: 2,
    noProgressLimit: 2,
    totalBudgetMs: 3_600_000,
  };
  const enabled = value.enabled === undefined ? defaults.enabled : value.enabled;
  if (typeof enabled !== 'boolean') throw new DeliveryPresetError('autoContinue.enabled must be a boolean');
  return {
    enabled,
    maxAttempts: integer(value.maxAttempts, defaults.maxAttempts, 1, 10, 'autoContinue.maxAttempts'),
    noProgressLimit: integer(value.noProgressLimit, defaults.noProgressLimit, 1, 10, 'autoContinue.noProgressLimit'),
    totalBudgetMs: integer(value.totalBudgetMs, defaults.totalBudgetMs, 1_000, 86_400_000, 'autoContinue.totalBudgetMs'),
  };
}

/**
 * Omission retains legacy defaults. `complete` opts into longer budgets and bounded
 * automatic repair, but every explicit value (even short diagnostic budgets) wins.
 * Acceptance inputs are mandatory for either complete delivery or automatic repair.
 */
export function resolveDeliverySettings(input: DeliveryPresetInput = {}): ResolvedDeliverySettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DeliveryPresetError('delivery settings must be an object');
  }
  const preset = input.deliveryPreset;
  if (preset !== undefined && preset !== 'complete') {
    throw new DeliveryPresetError('deliveryPreset must be "complete", or omit the field');
  }
  const complete = preset === 'complete';
  const effort = input.reasoningEffort ?? (complete ? 'high' : 'medium');
  if (input.reasoningEffort === null || !['none', 'off', 'low', 'medium', 'high'].includes(effort)) {
    throw new DeliveryPresetError('reasoningEffort must be none, off, low, medium or high');
  }
  const rawRepair = input.autoRepair;
  if (rawRepair !== undefined && (!rawRepair || typeof rawRepair !== 'object' || Array.isArray(rawRepair))) {
    throw new DeliveryPresetError('autoRepair must be an object');
  }
  const enabled = rawRepair?.enabled === undefined ? complete : rawRepair.enabled;
  if (typeof enabled !== 'boolean') throw new DeliveryPresetError('autoRepair.enabled must be a boolean');
  const autoRepair: AutoRepairPolicy = {
    enabled,
    maxAttempts: integer(rawRepair?.maxAttempts, 3, 1, 10, 'autoRepair.maxAttempts'),
    noProgressLimit: integer(rawRepair?.noProgressLimit, 2, 1, 10, 'autoRepair.noProgressLimit'),
    totalBudgetMs: integer(rawRepair?.totalBudgetMs, 3_600_000, 1_000, 86_400_000, 'autoRepair.totalBudgetMs'),
  };
  const verificationCommand = command(input.verificationCommand);
  const protectedVerificationFiles = protectedFiles(input.protectedVerificationFiles);
  if ((complete || autoRepair.enabled) && (!verificationCommand || protectedVerificationFiles.length === 0)) {
    throw new DeliveryPresetError('complete delivery and automatic repair require verificationCommand and non-empty protectedVerificationFiles for independent host acceptance');
  }
  return {
    deliveryPreset: preset,
    reasoningEffort: effort,
    maxTokens: integer(input.maxTokens, complete ? 32_768 : 16_384, 256, 32_768, 'maxTokens'),
    budgetMs: integer(input.budgetMs, complete ? 1_800_000 : 300_000, 1_000, 86_400_000, 'budgetMs'),
    verificationCommand,
    verificationTimeoutMs: integer(input.verificationTimeoutMs, complete ? 600_000 : 300_000, 1_000, 86_400_000, 'verificationTimeoutMs'),
    protectedVerificationFiles,
    autoRepair,
  };
}
