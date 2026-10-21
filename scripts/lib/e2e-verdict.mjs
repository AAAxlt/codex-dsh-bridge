/**
 * The two-stage real loop's summary and verdict, as pure functions.
 *
 * This lives outside the driver on purpose. `node --check` and `tsc` prove syntax; they never
 * execute a branch, and a real model run is far too expensive to be the first thing that ever
 * executes this one. The driver imports exactly these functions, the suite calls them with
 * recorded-shaped facts, and `scripts/e2e-real.mjs --self-check` drives the driver's own path with
 * synthetic facts and no MCP connection at all.
 *
 * A verdict is a DECISION, not a record: `ok === false` must lead to a non-zero exit code, or a
 * failed run is indistinguishable from a passing one.
 */

const CRITERIA = [
  'stage2-verification-exit-0',
  'stage2-tool-errors-zero',
  'same-live-session',
  'stage1-artifacts-unchanged',
  'stage1-report-unchanged',
  'cleanup-fully-verified',
  'review-written-after-stage1',
];

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stageFacts(raw) {
  const s = raw ?? {};
  return {
    messageId: s.messageId ?? null,
    state: s.state ?? null,
    verificationExitCode: num(s.verificationExitCode),
    toolCallsTotal: num(s.toolCallsTotal),
    toolErrorCount: num(s.toolErrorCount),
    modelReportChars: num(s.modelReportChars) ?? 0,
    continuedStage: num(s.continuedStage),
    settledAt: s.settledAt ?? null,
    unresolved: Array.isArray(s.unresolved) ? s.unresolved : [],
  };
}

/**
 * Normalises the facts the driver collected into the envelope written to summary.json. Every
 * field is defaulted so a missing observation becomes null instead of throwing, and the derived
 * comparisons (same pid / same session) are computed in one place rather than at each call site.
 */
export function buildSummary(facts) {
  const f = facts ?? {};
  const session = f.session ?? {};
  const preservation = f.preservation ?? {};
  const cancel = f.cancel ?? {};
  const review = f.review ?? {};
  const stage1Pid = num(session.stage1RuntimePid);
  const stage2Pid = num(session.stage2RuntimePid);
  const stage1Session = typeof session.stage1SessionId === 'string' ? session.stage1SessionId : null;
  const stage2Session = typeof session.stage2SessionId === 'string' ? session.stage2SessionId : null;
  return {
    runId: String(f.runId ?? 'unknown'),
    workspace: String(f.workspace ?? ''),
    evidenceDir: String(f.evidenceDir ?? ''),
    taskId: String(f.taskId ?? ''),
    generatedAt: new Date().toISOString(),
    session: {
      stage1RuntimePid: stage1Pid,
      stage2RuntimePid: stage2Pid,
      sameRuntimePid: stage1Pid !== null && stage1Pid === stage2Pid,
      stage1SessionId: stage1Session,
      stage2SessionId: stage2Session,
      sameSessionId: stage1Session !== null && stage1Session === stage2Session,
      stage1Turn: num(session.stage1Turn) ?? 0,
      stage2Turn: num(session.stage2Turn) ?? 0,
    },
    stage1: stageFacts(f.stage1),
    stage2: stageFacts(f.stage2),
    preservation: {
      allArtifactHashesMatch: preservation.allArtifactHashesMatch === true,
      comparedArtifacts: num(preservation.comparedArtifacts) ?? 0,
      changedArtifacts: Array.isArray(preservation.changedArtifacts) ? preservation.changedArtifacts : [],
      stage1Hashes: preservation.stage1Hashes ?? null,
      afterStage2Hashes: preservation.afterStage2Hashes ?? null,
      reportTextUnchanged: preservation.reportTextUnchanged === true,
      reportCharsBefore: num(preservation.reportCharsBefore) ?? 0,
      reportCharsAfter: num(preservation.reportCharsAfter) ?? 0,
    },
    review: {
      path: review.path ?? null,
      receivedAt: review.receivedAt ?? null,
      writtenAfterStage1: review.writtenAfterStage1 === true,
      chars: num(review.chars) ?? 0,
    },
    cancel: {
      runtimeStopped: cancel.runtimeStopped === true,
      fullyStopped: cancel.fullyStopped === true,
      treeVerified: cancel.treeVerified === true,
      survivorPids: Array.isArray(cancel.survivorPids) ? cancel.survivorPids : null,
      method: cancel.method ?? null,
      pidStillAlive: cancel.pidStillAlive ?? null,
    },
    waitTimeoutsObserved: f.waitTimeoutsObserved === true,
  };
}

/**
 * The acceptance decision. Every criterion is a fact the driver observed on disk or over the
 * protocol - never the model's own summary of itself.
 */
export function buildVerdict(summary) {
  const s = summary ?? {};
  const s1 = s.stage1 ?? {};
  const s2 = s.stage2 ?? {};
  const session = s.session ?? {};
  const preservation = s.preservation ?? {};
  const cancel = s.cancel ?? {};
  const review = s.review ?? {};

  const criteria = [];
  const add = (id, pass, detail) => criteria.push({id, pass: pass === true, detail: String(detail)});

  const stage1Clean = s1.verificationExitCode === 0 && s1.toolErrorCount === 0;
  const stage1Outcome = stage1Clean ? 'clean' : 'correction-flow';

  add('stage2-verification-exit-0', s2.verificationExitCode === 0,
    `stage 2 verificationCommand exitCode = ${JSON.stringify(s2.verificationExitCode)}`);
  add('stage2-tool-errors-zero', s2.toolErrorCount === 0,
    `stage 2 toolErrorCount = ${JSON.stringify(s2.toolErrorCount)} (stage 1 = ${JSON.stringify(s1.toolErrorCount)})`);
  add('same-live-session',
    session.sameRuntimePid === true && session.sameSessionId === true && session.stage2Turn > session.stage1Turn,
    `runtimePid ${JSON.stringify(session.stage1RuntimePid)} -> ${JSON.stringify(session.stage2RuntimePid)}; ` +
    `sessionId ${JSON.stringify(session.stage1SessionId)} -> ${JSON.stringify(session.stage2SessionId)}; ` +
    `turn ${JSON.stringify(session.stage1Turn)} -> ${JSON.stringify(session.stage2Turn)}; ` +
    `stage2 continuedStage = ${JSON.stringify(s2.continuedStage)}`);
  add('stage1-artifacts-unchanged', preservation.allArtifactHashesMatch === true,
    `${preservation.comparedArtifacts ?? 0} persisted stage-1 artifact(s) hashed before and after stage 2; ` +
    `changed = ${JSON.stringify(preservation.changedArtifacts ?? [])}`);
  add('stage1-report-unchanged', preservation.reportTextUnchanged === true,
    `stage 1 model report text identical after stage 2 = ${preservation.reportTextUnchanged === true}`);
  add('cleanup-fully-verified', cancel.fullyStopped === true,
    `cancel fullyStopped=${JSON.stringify(cancel.fullyStopped)} treeVerified=${JSON.stringify(cancel.treeVerified)} ` +
    `survivorPids=${JSON.stringify(cancel.survivorPids)} method=${JSON.stringify(cancel.method)} pidStillAlive=${JSON.stringify(cancel.pidStillAlive)}`);
  add('review-written-after-stage1', review.writtenAfterStage1 === true,
    `review ${JSON.stringify(review.path)} received at ${JSON.stringify(review.receivedAt)}; stage 1 settled at ${JSON.stringify(s1.settledAt)}`);

  const failed = criteria.filter((c) => !c.pass).map((c) => c.id);
  const ok = failed.length === 0;
  const note = ok
    ? (stage1Clean
      ? 'both stages passed their own verification on the same live session, the persisted stage-1 evidence is unchanged, and the task cleaned up fully'
      : 'stage 1 needed correction and stage 2 passed: this is a CORRECTION FLOW, not a clean two-stage pass')
    : `NOT ACCEPTED: ${failed.join(', ')}`;

  return {ok, stage1Outcome, criteria, failed, note, criteriaCount: criteria.length, knownCriteria: [...CRITERIA]};
}
