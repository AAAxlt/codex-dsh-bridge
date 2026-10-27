# Bridge 1.0.8 — bounded exhaustion continuation, structured external receipts, honest automation metrics

1.0.8 is one bounded work unit implementing the three accepted improvements. It preserves the
1.0.7 persistence, source-scope/import, event-paging, history, recovery, cancel and delivery
surfaces, the pinned SDK/runtime and every old tool schema. Ubuntu-DSH remains the execution target;
native Windows execution and native SDK conversation resume are still not claimed.

No real-model run is claimed by the scripted suite. Continuation and receipt tests prove bridge
state transitions and evidence, not model quality, provider availability or token/time savings.

## A. Bounded same-live-session continuation after provider output exhaustion

`dsh_submit_task` and `dsh_recover_task` accept an additive `autoContinue` object:

```json
{
  "autoContinue": {
    "enabled": true,
    "maxAttempts": 2,
    "noProgressLimit": 2,
    "totalBudgetMs": 3600000
  }
}
```

- Legacy omission is **disabled**. `deliveryPreset: "complete"` enables the agreed defaults:
  `maxAttempts=2`, `noProgressLimit=2`, `totalBudgetMs=3600000`. Explicit fields always win, and
  invalid values are refused before a task directory or runtime is allocated.
- Only an actual provider `max_tokens` / `max_tokens` / `length` turn end is eligible. Bridge
  report-storage truncation, display preview truncation, cancellation, permission/credential
  blockers, a failed or dead runtime, bridge shutdown and protected-verifier integrity failure do
  not trigger this path. The exhausted stage stays `incomplete`; host verification is **not** run
  on it.
- The next stage starts in the same live SDK/session with a continuation prompt labelled
  `auto-continuation`. No new runtime is started and no native `session/resume` claim is made.
- Attempts, monotonic remaining budget and source progress are counted. Source progress is the set
  of content hashes in the declared `deliverySource` scope (exclusions applied), or in the legacy
  workspace snapshot with logs and bridge evidence ignored. Paths are not part of the digest, so a
  byte-identical staging copy is not progress. Model self-report, tool counts and log growth never
  count as progress.
- One initial no-change continuation is allowed at `noProgressLimit=2`; repeated exhausted stages
  without source progress stop with `stopReason="no-progress"`. Other stable stop reasons include
  `attempt-limit`, `total-budget-exhausted`, `runtime-unavailable`,
  `cancelled`, `completed`, and `continuation-failed`.
- Generation and verification are clamped to the tightest enabled automation budget, including the
  initial generation and every automatic repair/continuation stage. Automatic hops never reset the
  clocks. A manual `dsh_continue_task` starts a fresh repair/continuation cycle (documented legacy
  semantics) while cumulative counters are preserved.
- A wait does not report `settled` between automatic hops. Cancel during a hop leaves honest
  cancelled/incomplete evidence, and duplicate turn/end or late finalisation cannot restart work.

## B. Structured external acceptance receipt

New MCP tool `dsh_submit_review` and `TaskManager.submitReview(input)`:

```json
{
  "taskId": "dsh-...",
  "stage": 2,
  "reviewId": "review-2026-10-26-1",
  "outcome": "fail",
  "summary": "External acceptance failed.",
  "findings": [{"id": "F1", "title": "...", "expected": "...", "actual": "...", "reproduction": ["..."]}],
  "checks": [{"name": "acceptance", "status": "fail", "exitCode": 1, "stdout": "...", "stderr": "...", "platform": "linux", "command": ["node", "accept.mjs"]}],
  "reviewedSource": [{"path": "src/tasks.ts", "sha256": "..."}]
}
```

- Arrays, strings and total input are bounded; the runtime API validates the same rules as the zod
  schema. All diagnostic text is scrubbed before reply and persistence. Supplied commands and check
  outputs are **data only** and are never executed.
- `source="caller-reported"` is explicit. `reviewedSource` must name workspace-relative regular,
  no-link files whose current SHA-256 matches; absolute paths, traversal, drive/ADS syntax,
  wildcards, links, sensitive names and hash mismatches are refused. Hash pinning binds bytes, not
  proof that any external check ran.
- A receipt binds the exact latest **settled** stage. Stale, in-flight, cancelled, historical and
  dead-runtime controls are refused without modifying files and without a model request.
- The receipt is durably written before any prompt under a portable filename derived from
  `SHA-256(reviewId)` (the exact public ID is preserved inside the receipt), with an append-only
  `reviews/events.jsonl` fact log. Hashing avoids Windows `:`/ADS filenames and case-folding
  collisions such as `Audit:Case` vs `audit:case`. The same `reviewId` with the same canonical
  original body is idempotent and never sends a second prompt, including a duplicate during the
  first continuation; conflicting reuse is refused. The idempotency digest binds the validated raw
  body **before** secret scrubbing, so two different secret-bearing bodies cannot alias. Prior stage
  result and checkpoint bytes are not rewritten.
- A pass receipt containing a `fail`, `blocked` or `not-run` check is contradictory and is refused
  before any receipt file or prompt; exit codes are data, so an expected CLI exit `2` may still be a
  passed business check. `outcome=pass` and `outcome=blocked` do not start the model. A `fail` with
  actionable findings starts exactly one repair stage in the same live session, even if host
  verification previously passed, and starts a fresh bounded automation cycle when it is a new
  explicit review (duplicates and automatic hops never reset budgets). Structured
  expected/actual/reproduction/captured output is transported as untrusted diagnostic data.
- Return shape:

  ```json
  {"ok": true, "taskId": "dsh-...", "reviewId": "...", "stage": 2, "alreadyRecorded": false,
   "continued": true, "repairStage": 3, "source": "caller-reported"}
  ```

  `continued` is `true` only for the call that actually got the repair prompt acknowledged; an
  idempotent duplicate returns `alreadyRecorded=true, continued=false`.
- `externalReview.status` is `none | failed | blocked | awaiting-recheck | passed` in task and
  result. After an external fail, its repair stage and a local command pass, the status stays
  `awaiting-recheck` and `productAcceptance` stays `unverified` until an explicit pass receipt
  against the new stage. A caller pass can never turn a failing host command into a pass. Starting
  ANY new stage after an established pass moves the status to `awaiting-recheck`; it is never reset
  to `none` and never silently inherited. `reviewedSource` files are preflighted and hashed through
  bounded descriptor chunks, so an oversized file is refused without a whole-file read.
- A newly recorded pass, blocked or non-actionable failure synchronizes the existing delivery
  index's review gate/counts, latest receipt artifact, unresolved text and the mutable
  `checkpoint.json` without recapturing live source. The recorded source descriptors/artifacts,
  `evidence/stage-N-result.json` and `checkpoints/stage-N.json` remain sealed; a duplicate
  same-body receipt is a true no-op and does not rewrite the index timestamp/hash.

## C. Honest measurements and evidence

- Task/result expose `automationMetrics`:
  `{autoContinuationCount, reviewRepairCount, externalReviewCount, codexDirectEditCount: null,
  manualCodexContinuationCount, automaticHostRepairCount, providerExhaustionContinuationCount,
  reviewTriggeredRepairCount, note}`.
- Manual Codex continuations, automatic host repairs, provider-exhaustion continuations and
  review-triggered repairs remain separate counters and are never added into a savings figure.
  `codexDirectEditCount`, Codex token counts and review/rework cost remain unknown unless separately
  evidenced; the bridge never invents zero or an efficiency gain.
- Each stage records `cause` (`initial`, `manual-continuation`, `auto-repair`, `auto-continuation`,
  `review-repair`), `causeDetail` and wall-clock `elapsedMs`. `sourceProgress` reports whether a
  measured source change occurred and on what basis.
- Checkpoints carry the automation policies/counters and the latest external-review summary.
  Delivery indexes add `autoContinuationCount`, `reviewRepairCount`, `externalReviewCount`,
  `manualCodexContinuationCount`, `codexDirectEditCount: null`, bounded `externalReviews` summaries
  and the receipt as evidence. Historical projections expose the same facts read-only, tolerate
  pre-1.0.8 records, and never include model reasoning, credentials or executable commands.
- `firstVerificationPassed` still means the first host command, not a complete delivery pass.

## Compatibility and limits

- Version identity is `1.0.8` in `package.json`, `package-lock.json`, `BRIDGE_VERSION`, the MCP
  capability payload and the release docs.
- SDK `0.2.1-rc.2` runtime package entries stay byte-identical. Only the bridge's own `dist/src`
  asset hashes change in the local ignored baseline. `maintenance/guard.mjs` only gains additive
  `ASSETS` coverage for `dist/src/history.js`; its guard algorithm and package list are unchanged.
- Old delivery indexes still export: new Markdown metric lines are emitted only when the recorded
  index has the new metric keys.
- No dependencies, provider route, credential handling, workspace boundary or global settings were
  changed. No GitHub publication is performed by this candidate.
- Scripted tests do not prove real-model behavior, native Windows execution, OS isolation, native
  SDK conversation resume or cost savings. The protected host still owns independent source checks
  and the real SDK review-repair pilot.
