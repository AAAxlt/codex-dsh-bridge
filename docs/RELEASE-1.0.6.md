# Bridge 1.0.6

Bridge 1.0.6 adds **checkpoint-based task recovery into a NEW task/session** after a bridge restart.
It keeps the 1.0.5 read-only history surface and all earlier delivery, verification, repair, cancel
and evidence behavior. It does **not** add native SDK conversation resume, whole-OS reboot recovery or
replay of external side effects.

## New MCP tools

### `dsh_prepare_recovery({taskId, workspace})`

Read-only. It loads exactly `task.json` and `checkpoint.json` from the canonical
`DATA_ROOT/tasks/<taskId>` through anchored, symlink-refusing readers, verifies their identity,
schema, stage binding and size, checks that the admitted caller workspace canonically equals the
recorded workspace, and returns a bounded, scrubbed plan:

- `planToken` — a deterministic token bound to the exact source record hash, checkpoint hash, task
  identity and current workspace fingerprint;
- source/hash/stage/recorded-state and verifier metadata;
- explicit limits: no restored conversation, no model reasoning, no old stage stitching, old
  evidence read-only, new session;
- warnings for an unsettled source, fresh-verification requirements and protected pins.

It starts no runtime, makes no model request, writes nothing, probes no PID and exposes no prompt,
context, environment, reasoning or recorded argv. A source still in the calling bridge's live map is
refused; use `dsh_continue_task` for a live session. A missing or corrupt checkpoint is an explicit
refusal, never reconstructed.

### `dsh_recover_task({taskId, workspace, planToken, instructions, ...fresh submit parameters})`

Starts a NEW task id, NEW session id and NEW private SDK runtime. The stage prompt uses the checked
original goal/constraints, a bounded checkpoint summary and the caller's current instructions. It
does not restore the old prompt, context, model reasoning or conversation.

Fresh `verificationCommand`, `protectedVerificationFiles`, acceptance, preset, repair, reasoning,
token/budget/timeout and execution-profile parameters follow the existing validation and precedence.
The recorded verification argv is never executed. If the source configured verification, a fresh
argv is required; if it pinned protected files, fresh pins must include the same real paths with the
original SHA-256 values. Additional pins are allowed. Old pins cannot be silently dropped.

The new record persists `recoveredFrom` before the first prompt:

```json
{
  "taskId": "dsh-source",
  "stage": 1,
  "sessionId": "session-dsh-source",
  "recordSha256": "...",
  "checkpointSha256": "...",
  "planToken": "...",
  "mode": "checkpoint-new-session"
}
```

The field is exposed in the new task record, `dsh_get_task`, `dsh_get_result`, `dsh_get_history` and
`dsh_list_history`. Old stages and evidence are never rewritten or appended to the new stage list.

## Idempotency and safety

- One durable claim per plan token is written atomically under `DATA_ROOT/recovery/claims` **before**
  the new task or runtime exists. Repeated calls — including after a bridge restart and after the new
  task changed the workspace — return the same `taskId` with `alreadyRecovered:true`, and start no
  second runtime or model request.
- An in-progress claim is refused. A failed start is handled conservatively: a claim that may have
  created a task or begun a runtime is never blindly retried. A provably pre-start failure may be
  cleared.
- A source recorded `accepted`/`starting`/`running` is refused by default because its stop status is
  unknown. Only explicit `allowUnsettledSource:true` permits a NEW-session recovery; this is recorded
  as a caller acknowledgment, not as bridge proof that the old PID is alive or dead. The bridge never
  probes, signals, reattaches or reuses the recorded PID.
- Source or workspace drift after planning refuses before any task or runtime is started. The
  workspace plan binds the **complete content** of every included regular file, streamed in bounded
  blocks (a file larger than 2 MiB is hashed, not skipped). Exceeding the 4,000-file count or 64 MiB
  total byte budget, or encountering an unreadable, unsupported, replaced or unstable entry, refuses
  preparation/execution before any runtime starts. There is no partial, truncated or null-digest
  fingerprint. `node_modules`, `.git`, `.hg`, `.svn` and `DATA_ROOT/tasks`/`DATA_ROOT/recovery` are
  intentionally excluded; symlinks bind their target string and are not followed.
- Every stage writes a valid current-stage checkpoint **before** the runtime starts and again before
  the prompt is sent. A bridge/OS crash during the first generation therefore leaves durable
  recovery evidence; a pre-prompt checkpoint is accepted only for a still-live source and only with
  explicit `allowUnsettledSource:true`. A missing or corrupt checkpoint is never reconstructed.
- File-change evidence distinguishes file-enumeration exhaustion from hash-coverage truncation.
  Large files or an exhausted hash budget retain metadata with an honest null digest and never stop
  enumeration of queued directories. A file-count cap, readdir/stat failure or hash read error marks
  the snapshot incomplete; an absent entry is reported as removed only when the after snapshot is
  complete (`removalDetection: 'complete'`), never inferred from a truncated or errored one.
- Recovery claims are size-bounded and their ledger/claim paths are checked for links, junctions and
  escape. Errors and plan fields are bounded and scrubbed.

## Execution target

Ubuntu-DSH is the intended execution target for this release. Native Windows execution is deferred,
not claimed as an acceptance gap: Windows source builds are not the release target, and no
Windows-native host acceptance is part of this delivery.

## Compatibility

- All 1.0.5 history envelopes, limits, historical delivery export and `historical_not_live`
  refusals are unchanged.
- Existing fixed history envelope remains read-only; the new recovery tools are separate live
  controls.
- MIT license, provider/model defaults, tool schemas for existing tools and the pinned
  execution-profile guard are preserved. The recovery and evidence production modules are covered by
  the guard asset list; runtime package/version hashes are unchanged.
- Version: `1.0.6`. Scripted suite: **238 tests, 0 skipped, 0 failed** in the candidate environment.

## Explicit non-claims

This release proves **bridge-restart checkpoint recovery into a new session**. It does **not** prove:

- native SDK `session/resume` conversation continuity (see
  [SDK-RESUME-ASSESSMENT.md](SDK-RESUME-ASSESSMENT.md));
- whole-OS reboot recovery;
- replay safety of external side effects or external business systems;
- model/provider cost savings;
- filesystem isolation outside the admitted workspace.
