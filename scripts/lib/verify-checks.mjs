/**
 * Pure checks used by scripts/verify-delivery.mjs. Keeping them here makes the "missing/empty
 * manifest" and "no test suite" failures directly testable instead of being asserted only by a
 * shell exit code.
 */

const TEST_FIELDS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

/**
 * Read the actual outcomes from every Node TAP or spec summary in a multi-command npm script.
 * Missing/duplicate counters and inconsistent totals fail closed. A collected or skipped test
 * is not a passed test. Strip reporter colour codes before parsing piped output.
 */
export function parseNodeTestResults(stdout) {
  const clean = typeof stdout === 'string' ? stdout.replace(/\u001b\[[0-9;]*m/g, '') : '';
  const summaries = [];
  const errors = [];
  let current = null;
  for (const line of clean.split(/\r?\n/)) {
    const match = /^(?:ℹ|#)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const [, field, raw] = match;
    if (field === 'tests') {
      current = {};
      summaries.push(current);
    }
    if (!current) {
      errors.push(`outcome ${field} appeared before a tests summary`);
      continue;
    }
    if (Object.hasOwn(current, field)) errors.push(`summary ${summaries.length} repeats ${field}`);
    current[field] = Number(raw);
  }
  if (summaries.length === 0) errors.push('no complete Node test summaries were reported');
  const totals = Object.fromEntries(TEST_FIELDS.map((key) => [key, 0]));
  for (const [index, summary] of summaries.entries()) {
    for (const key of TEST_FIELDS) {
      if (!Number.isSafeInteger(summary[key]) || summary[key] < 0) {
        errors.push(`summary ${index + 1} has missing or invalid ${key}`);
      } else {
        totals[key] += summary[key];
      }
    }
    if (TEST_FIELDS.every((key) => Number.isSafeInteger(summary[key])) &&
        summary.tests !== TEST_FIELDS.slice(1).reduce((sum, key) => sum + summary[key], 0)) {
      errors.push(`summary ${index + 1} outcome counts do not add up to tests`);
    }
  }
  if (totals.tests <= 0) errors.push('zero tests ran');
  if (totals.fail > 0 || totals.cancelled > 0) errors.push('tests failed or were cancelled');
  const status = errors.length > 0 ? 'fail' : totals.skipped > 0 || totals.todo > 0 ? 'partial' : 'pass';
  return {...totals, testCount: totals.tests, summaryCount: summaries.length, summaries, errors, status, ok: status === 'pass'};
}

// Kept for callers that only display collected totals; this is never an acceptance verdict.
export function countNodeTests(stdout) {
  return parseNodeTestResults(stdout).testCount;
}

/**
 * Parses the sha256sum-compatible manifest. A missing, empty, malformed or zero-entry manifest is
 * an error: a complete delivery check must not report PASS without declared source hashes.
 */
export function parseSourceManifest(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('source hash manifest is missing or empty');
  }
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error(`source hash manifest has a malformed line: ${line.slice(0, 120)}`);
    const [, hash, rel] = match;
    if (rel.startsWith('/') || rel.includes('..')) throw new Error(`source hash manifest path must be relative and contained: ${rel}`);
    if (entries.has(rel)) throw new Error(`source hash manifest repeats ${rel}`);
    entries.set(rel, hash);
  }
  if (entries.size === 0) throw new Error('source hash manifest has no entries');
  return entries;
}

/**
 * The delivery manifest must declare a positive final test total. Missing/empty/zero is never a
 * "nothing to check, therefore pass" case.
 */
export function validateDeliveryManifest(doc, actualManifestSha256) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return {ok: false, errors: ['delivery manifest is missing or not an object'], total: null};
  }
  const total = doc.finalTests?.total;
  const errors = [];
  if (!Number.isInteger(total) || total <= 0) errors.push('finalTests.total must be a positive integer');
  if (!doc.sourceHashes?.final?.manifestSha256 || !/^[a-f0-9]{64}$/.test(String(doc.sourceHashes.final.manifestSha256))) {
    errors.push('sourceHashes.final.manifestSha256 is missing or invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(String(actualManifestSha256))) {
    errors.push('actual SOURCE-HASHES.sha256 digest is missing or invalid');
  } else if (doc.sourceHashes?.final?.manifestSha256 !== actualManifestSha256) {
    errors.push('sourceHashes.final.manifestSha256 does not match actual SOURCE-HASHES.sha256');
  }
  return {ok: errors.length === 0, errors, total: Number.isInteger(total) ? total : null, actualManifestSha256};
}

/**
 * A suite list that ran nothing can never match a positive expected total, and an empty list is
 * itself an error. This is what prevents `test-count: 0 == 0` from looking like a pass.
 */
export function validateTestCounts(suiteCounts, expectedTotal) {
  const errors = [];
  const partialReasons = [];
  if (!Array.isArray(suiteCounts) || suiteCounts.length === 0) {
    return {ok: false, status: 'fail', errors: ['no test suites ran'], partialReasons, observed: []};
  }
  if (!Number.isInteger(expectedTotal) || expectedTotal <= 0) {
    errors.push('expected test total is not a positive integer');
  }
  const observed = [];
  for (const suite of suiteCounts) {
    const id = String(suite?.id ?? 'unknown');
    const stats = suite?.testStats;
    const count = stats?.tests ?? suite?.testCount ?? 0;
    observed.push({id, testCount: count, pass: stats?.pass ?? null, fail: stats?.fail ?? null,
      cancelled: stats?.cancelled ?? null, skipped: stats?.skipped ?? null, todo: stats?.todo ?? null});
    if (!Number.isSafeInteger(count) || count <= 0) errors.push(`${id} ran zero tests or reported an invalid total`);
    if (Number.isInteger(expectedTotal) && expectedTotal > 0 && count !== expectedTotal) {
      errors.push(`${id} ran ${count}, expected ${expectedTotal}`);
    }
    // Re-derive the verdict from counters rather than trusting a caller-supplied status/ok flag.
    const validCounters = stats && TEST_FIELDS.every((key) => Number.isSafeInteger(stats[key]) && stats[key] >= 0);
    if (!validCounters || !Number.isSafeInteger(stats?.summaryCount) || stats.summaryCount <= 0 ||
        !Array.isArray(stats.errors) || stats.errors.length > 0) {
      errors.push(`${id} has incomplete or invalid outcome evidence`);
    } else if (stats.tests !== TEST_FIELDS.slice(1).reduce((sum, key) => sum + stats[key], 0) ||
               stats.fail > 0 || stats.cancelled > 0) {
      errors.push(`${id} has failing, cancelled or inconsistent outcomes`);
    } else if (stats.skipped > 0 || stats.todo > 0) {
      partialReasons.push(`${id} skipped ${stats.skipped} and left ${stats.todo} todo tests`);
    }
  }
  const status = errors.length > 0 ? 'fail' : partialReasons.length > 0 ? 'partial' : 'pass';
  return {ok: status === 'pass', status, errors, partialReasons, observed};
}

/** Only a fully executed, successful matrix can produce exit 0. */
export function summarizeVerification(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return {status: 'fail', ok: false, exitCode: 1};
  const failed = steps.some((step) => step.status === 'fail' ||
    (!step.skipped && step.exitCode !== 0 && !(step.exitCode === 2 && step.status === 'partial')));
  const partial = steps.some((step) => step.skipped || step.status === 'partial');
  const status = failed ? 'fail' : partial ? 'partial' : 'pass';
  return {status, ok: status === 'pass', exitCode: status === 'pass' ? 0 : status === 'partial' ? 2 : 1};
}
