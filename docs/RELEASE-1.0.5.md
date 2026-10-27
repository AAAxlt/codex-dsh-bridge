# Bridge 1.0.5

Bridge 1.0.5 adds a bounded read-only history surface after a bridge restart, historical delivery
export by explicit task id, and a stricter prompt/capability statement of what the bridge actually
enforces. It does not add native cross-process SDK session resume.

## Read-only history

- `dsh_list_history(limit)` returns at most 100 projected summaries; the default is 20.
- `dsh_get_history(taskId, stage?)` reads one recorded task, and optionally one recorded stage.
- Every response fixes `source="persisted-history"`, `runtimeAttached=false`,
  `runtimeAlive=null`, `canContinue=false` and `canCancel=false`. Disk content cannot override
  those fields.
- Recorded state, timestamps and PID are labelled as recorded evidence. History never probes,
  signals, reattaches, resumes, starts or stops the old process, never executes recorded argv,
  and never recaptures the current workspace.
- Reads are derived from the configured `DATA_ROOT/tasks` plus a strict bridge-id; absolute paths
  stored in records are ignored. Task records, checkpoints, stage results and delivery indexes are
  size-limited, type-checked, identity-checked and read through link/junction-rejecting path
  resolution.
- Prompts, context, environment, reasoning, raw argv and record-controlled evidence paths are not
  returned. Model text is a scrubbed claim, not acceptance.
- A corrupt task directory is reported as one invalid list entry without hiding valid entries.
- The trust anchor is the canonical configured `DATA_ROOT`. Its `tasks` child is inspected with
  `lstat` and native `realpath`; a linked/junction tasks root is refused before list/get/export or
  control lookup instead of silently redefining the root.
- Native `StageRecord.verification` is projected as the `CommandObservation` it actually is
  (`exitCode`, timeout, signal, scrubbed tails), with a bridge-derived status plus explicit
  cancellation/integrity/not-run distinctions. It is not misreported as an unconfigured
  `VerificationSummary`.
- Verification statuses are fixed enums derived from native facts, not arbitrary disk strings.
  Projected fields, arrays, timestamps, session/task identities and the total MCP reply are bounded;
  a response that would exceed the limit returns a compact truncated envelope.
- `dsh_continue_task`, `dsh_cancel_task` and `dsh_wait_task` refuse a historical id with
  `historical_not_live` (or `history_unsafe` for an untrusted root); they do not touch its recorded PID.

History is not SDK cross-process recovery. A new bridge process still cannot continue an old live
session.

## Historical export

`dsh_export_delivery` now accepts a historical task id when no live task exists. It requires the
latest recorded stage to be finalised, `deliveryStage` to equal the latest task stage, the delivery
index task id to match, `index.metrics.stageCount` to match the task record, and the recorded stage
binding to be present. A stale bundle left behind after a failed later capture is refused.

Historical export and `dsh_get_history.delivery.exportable` now share one strict, pure index
predicate. It requires a settled, fully finalised task; `metrics.stageCount` equal to the task stage
count; `metrics.final === true`; a non-array `hostVerification` object; a host-verification stage
array whose entries are objects numbered `1..N` in order, without repeats; a valid verification
summary per stage; and a `latest` summary bound to the last stage's status, attempts and exit code.
A wrong type is a validation failure, not a skipped check. Corrupt, pending or non-final bundles are
never advertised exportable and are refused before any destination is created.

After those checks the existing delivery validator still verifies every artifact path, size and
SHA-256, and the export copies the recorded source bytes only. It never reruns acceptance and never
captures the changed current workspace. Real 1.0.4 and 1.0.5 generated bundles retain their recorded
schema and remain exportable when those predicates hold.

## Prompt and capability truthfulness

The internal first/continuation prompt now states two facts: the workspace path was admitted against
the configured allowed roots, and the generated SDK overlay sets `workspace-write`. It explicitly
does not claim that everything outside the workspace is unwritable or that OS/filesystem isolation
has been proved. `dsh_get_capabilities.workspaceBounds.isolation` says the same thing.

## Repair-budget scope

`autoRepair.totalBudgetMs` is the wall-clock budget of the **current automatic-repair cycle**
(repair stages and their host verification). It is not a hard ceiling over every manual
`dsh_continue_task` stage. A manual continuation resets the automatic-repair counters while keeping
the same live session and all earlier stage records. Explicit fields still override preset defaults:
`maxTokens` is a per-response output budget, `budgetMs` is a per-stage generation deadline, and
`verificationTimeoutMs` is one host-command timeout. None is a total cost cap.

## Validation

The version is identified consistently in package/config/lock and delivery metadata. The scripted
suite is expanded with cross-platform history/export/prompt cases, including tasks-root junction,
native command-observation, untrusted-status, response-bound and strict delivery-index binding
regressions, and remains the authoritative portable check for this source tree. Real-provider repair scenarios are separate
host-run mechanism drills, not part of `npm test`, and are not claimed here as executed unless their
native evidence exists. The real-repair harness separates a submit attempt from observed native
model activity and requires the explicit native profile, a real execution-baseline hash and actual
SDK `serverInfo` evidence.
