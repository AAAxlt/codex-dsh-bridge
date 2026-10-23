# Bridge 1.0.3 delivery-observability contract

Publication note (1.0.4): the observation contract below remains applicable. Runtime paths,
registry entries, and historical results describe the original development installation, not files
bundled with this public checkout. Capture your own baseline and register it locally before using
the independent delivery checker. Current publication checks are in VALIDATION.md; new delivery
and repair behavior is described in RELEASE-1.0.4.md and ../USAGE.md.

This candidate changes only the Bridge's own observation, verification and handoff surfaces. The
provider/model route, credential handling, workspace boundary, truncation semantics, cancellation
scope (only this task's SDK process) and explicit-parameter precedence are unchanged.

## What every result now states

### Tool calls: true total vs retained evidence

`bridgeObserved.toolCallsTotal` is the number of tool invocation **start** events the bridge saw in
that stage. It is no longer the length of the retained evidence array. The old value silently stopped
at `limits.toolEvidenceMax` (60), so a stage with 91 calls displayed 60.

| field | meaning |
| --- | --- |
| `toolCallsTotal` | true start-event count for this stage |
| `toolCallsRetained` | observations kept in durable evidence (at most 60) |
| `toolCallsShown` | observations in this reply (25 default, 60 with `verbose:true`) |
| `toolCallsDropped` | true starts not represented in retained evidence |
| `toolCallsTaskTotal` | sum of true start counts across every stage |
| `toolResultsTotal` / `toolResultsTaskTotal` | result events observed |
| `toolErrorCount` / `toolErrorCountTaskTotal` | result events flagged `isError:true` |
| `toolCounts` | per-tool true start counts, including calls whose preview was dropped |

This is independent of stage state: counts already observed survive cancel, timeout, failed turns and
runtime exit. `status.currentStage.toolCalls` now also reports the true count, with retained/dropped
counts alongside it.

### Usage accounting: latest, stage, task, record count

`bridgeObserved.usage` is kept for compatibility and means the **last raw usage event only**. New
callers should use `bridgeObserved.usageAccounting`:

| field | meaning |
| --- | --- |
| `usageAccounting.latest` | last raw assistant-message usage event in this stage |
| `usageAccounting.stage` | sum of every usage event in this stage, exactly once |
| `usageAccounting.task` | sum of every stage, with `stagesWithUsage` / `stagesTotal` |
| `usageAccounting.records` | distinct records, events actually observed, and resends deduplicated |
| `usageAccounting.semantics` | the caveats in the payload itself |

A usage event that carries a stable message id is keyed by that id: a later resend/update **replaces**
the earlier counters instead of adding a second record. `records.stageUsageEventsObserved` vs
`records.stageUsageEvents` exposes the difference, and `records.resendsDeduplicated` names it. An
event with no id is counted as a distinct record; the Bridge does not invent an identity.

Counters recognised under common SDK aliases: input, output, cache-read, cache-write and reasoning
tokens, plus a reported total. If any event in a scope omits a counter, that scope's counter is
`null` with the field named in `unknownFields`; it is **never replaced with 0**.

`totalTokens` is set **only** from an SDK-reported total (`totalSource:"reported"`); otherwise it is
`null`. The arithmetic sum of the four component counters is exposed separately as
`componentSumTokens` with a fixed note that alias counters may overlap and it is NOT a total or
billable amount. In particular `input_tokens:100, output_tokens:10, cacheReadTokens:60,
cacheWriteTokens:0` with no reported total yields `totalTokens:null` and `componentSumTokens:170`,
never `totalTokens:170`.

`cost.amount` is populated only when the SDK usage event itself carries a cost. It is labeled
`isProviderInvoice:false`: it is not a bill, a price quote or a vendor invoice. No new token or cost
limit is imposed; the existing `maxTokens` and `budgetMs` parameters keep their defaults and explicit
values are preserved.

### Verification: configured, run, exit code, not-run reason

`bridgeObserved.verification` is the structured verdict for the Bridge's own command:

```json
{
  "configured": true,
  "status": "passed|failed|timed-out|errored|cancelled-during-run|not-run|not-configured|pending",
  "attempts": 1,
  "runs": [{"argv": ["..."], "exitCode": 0, "timedOut": false, "error": null}],
  "lastRun": {"...": "..."},
  "notRunReason": null,
  "cancelledDuringRun": false,
  "trigger": {"stageState": "awaiting_review", "turnEndKind": "completed"},
  "acceptance": "check-passed"
}
```

`verificationCommand` is still returned as the last raw `CommandObservation` (or `null`), so existing
readers keep working. The control flow is deliberately narrower than 1.0.2:

* the command runs **only** when the SDK turn ended and the stage is `awaiting_review`;
* a failed turn, `incomplete`, `blocked`, `cancelled` or `timed_out` stage does **not** run it;
* `attempts` is the actual number of runs (0 or 1 in this build), and `notRunReason` says why;
* a cancel that lands while the command is executing settles the stage as `cancelled`, keeps the real
  exit code, sets `cancelledDuringRun:true` and reports `cancelled-during-run` — a zero exit is not
  acceptance for a cancelled task;
* a non-zero exit, timeout, spawn error or run cancelled mid-flight makes
  `deliverySummary.productAcceptance` `failed`;
* a zero exit is `check-passed`, never product acceptance.

### Delivery summary

`deliverySummary` is the compact handoff Codex should read first. It contains the stage/task
generation outcome, `productAcceptance`, changed paths and counts, structured verification, the
unresolved list, model-claim vs bridge-command separation, acceptance basis lines and evidence paths.
`awaiting_review` / `completed` means the SDK turn ended; it does not mean the product was accepted.

## Checkpoints

On normal end, cancel, timeout, failed turn, runtime exit and bridge shutdown the Bridge atomically
writes:

* `<taskDir>/checkpoint.json` — the latest state;
* `<taskDir>/checkpoints/stage-N.json` — the same checkpoint for that stage.

Each checkpoint records the task/stage/state, workspace, goal/acceptance, changed files, structured
verification, latest/stage/task usage, the model-report path and character count, evidence paths, and
the resume limits. It explicitly says `resume.sdkCrossProcessResume:false`: this is a handoff
artifact, **not** SDK cross-process recovery. It never paraphrases or fabricates a model conclusion;
it points at the verbatim report file and says so in `modelReport.note`.

Writes use a same-directory temp file followed by `rename`, so a reader never sees a half-written
checkpoint. Original `events.jsonl`, `task.json`, stage result and report files are retained.

## Workflow: DSH does the unit, Codex accepts once

The first-stage and continuation prompts now establish the whole unit of work:

1. implement (read before editing);
2. run the project's real acceptance commands;
3. analyze failures and fix;
4. re-run until passing or a concrete evidenced blocker;
5. self-review the diff and edge cases;
6. deliver once with CHANGED / RAN / UNRESOLVED.

The prompt does not cap tool calls or wall-clock effort; the existing bounded stage budget is the
limit. It explicitly discourages escalating every intermediate failure to Codex. A short optional
`DSH_WORKLOG.md` convention is offered; the Bridge's checkpoint/result files must not be edited by the
model.

Codex still owns product acceptance: read `deliverySummary`, `verification`, `unresolved` and the
checkpoint, then run an independent acceptance check. Do not accept on the model's self-report alone.

## Budget and compatibility

* Defaults are unchanged: `medium`, `maxTokens=16384`, `budgetMs=300000`.
* Explicit `low`/`high`, small/large `maxTokens`, and short/long `budgetMs` remain effective.
* `off`/`none` keeps the existing route mapping rule (GOAT maps to `low` with a warning).
* No default hard token/cost cap was added.
* Provider, model, base URL, credential name and header, execution profiles, workspace boundary,
  `maxConcurrentTasks`, wait contract and cancellation scope are unchanged.
* `toolCallsTotal` has a deliberate semantic change: it is now the true total. Readers that wanted
  the retained count must use `toolCallsRetained`.

## Reproducible acceptance

From any working directory:

```bash
node /path/to/optimization-20261022/scripts/verify-delivery.mjs
```

The script:

1. verifies a non-empty `SOURCE-HASHES.sha256` and a valid `delivery.json` with a positive final
   test total;
2. resolves `node <npm-cli.js>` (never `npm.cmd` without a shell) and runs the real `npm run build`;
3. runs the complete package test script three times — once with the **inherited** environment (the
   Bridge parent's GOAT environment in the real run), once with `DSH_BRIDGE_PROVIDER=opencode-go`,
   and once with `DSH_BRIDGE_PROVIDER=commandcode-goat`;
4. compares every suite's real node-test count with `delivery.json.finalTests.total`; no suites or
   zero tests is a failure;
5. selects the trusted entry from `baseline/runtime-baselines.json` by the canonical
   `DSH_BRIDGE_RUNTIME_ROOT` (or the default root), then runs the execution-profile guard with that
   exact baseline. An unregistered root is refused; no fallback to another runtime's baseline;
6. writes the transcript to `evidence/verify-delivery.log` and
   `evidence/verify-delivery-last.json`, and exits non-zero on any manifest/build/test/count/guard
   failure.

The tests themselves pin their own route before importing `config.ts` when they assert a route, so
an ambient `DSH_BRIDGE_PROVIDER` cannot rewrite an expected credential name. GOAT behavior is still
exercised deliberately by `reliability.test.ts` and by the explicit GOAT pass.

It redirects the E2E self-check's scratch root to `evidence/e2e-root` through the documented
`DSH_BRIDGE_E2E_ROOT` seam because the repository default can be outside a locked-down candidate and
non-writable. That is an explicit path override, not a skipped assertion.

On Windows the npm invocation is always `node.exe <npm-cli.js> ...` from `npm_execpath` or a
resolved node installation, with `shell:false`; `npm.cmd` is never passed to `spawnSync`.

### Runtime baselines are explicit, not interchangeable

`baseline/runtime-baselines.json` registers two exact roots:

| id | root | dsh | baseline |
| --- | --- | --- | --- |
| `legacy-default-0.2.0-rc.2` | `/home/agent/dsh-runtime` | 0.2.0-rc.2 | `execution-profiles-baseline.json` |
| `selected-0.2.1-rc.2-20261017` | `/home/agent/dsh-runtimes/0.2.1-rc.2-20261017` | 0.2.1-rc.2 | `execution-profiles-baseline-0.2.1-rc.2-20261017.json` |

The selected runtime is the authoritative one for this task. Selection compares the canonical root
and the actual `@deepseek-ai/dsh` version; an unknown root or a version mismatch throws. Baselines are
never rebuilt during `check`, and drift is never ignored. To add a new runtime, capture its baseline
and register the exact root/version explicitly.

If the runtime package is absent, the guard is reported as skipped (not passed). If an explicit
`DSH_BRIDGE_RUNTIME_ROOT` is set but has no dsh package, the check fails.

## Verified boundaries

* The full suite uses the scripted SDK fixture for lifecycle scenarios. The authorized real-SDK
  smoke was attempted but **blocked before any model request** because this process has no
  `COMMANDCODE_API_KEY`; `scripts/e2e-smoke.mjs` records that explicitly rather than inventing a
  result. The runtime identity was verified as `@deepseek-ai/dsh 0.2.1-rc.2`.
* The Windows `npm.cmd` EINVAL path is fixed by `node + npm-cli.js` and covered by pure selection /
  argv tests, but no real Windows host run was performed in this stage.
* The Bridge still has no live-task restoration across process restarts; checkpoints are handoff
  evidence only.
