# Bridge 1.0.7 — persistence health, scoped delivery/import, bounded events

1.0.7 is a bounded compatibility release. It implements three accepted improvements and keeps
1.0.6 behavior, tool schemas that were already public, the pinned SDK/runtime and legacy
observed-changes exports unchanged. Ubuntu-DSH is the execution target; native Windows and native
SDK conversation resume remain deferred.

## A. Strict, visible persistence health

- Critical task-record and current-stage checkpoint writes are made through one atomic writer:
  unique same-directory temp file, `wx` create, file `fsync`, rename, best-effort directory
  `fsync`, temp cleanup on failure. Atomic rename is not a whole-OS/power-loss guarantee.
- Before a new SDK is started and again before the first prompt, the bridge persists a valid
  `task.json` **and** current-stage `checkpoint.json` (plus `checkpoints/stage-N.json`). A failure
  returns an explicit `persistence_failed` error and sends no prompt. If a runtime already exists
  at the second boundary, only that owned runtime is stopped and the cleanup is reported.
- Later task/checkpoint/event-log failures no longer disappear. Live `dsh_get_task` and
  `dsh_get_result` expose:

  ```json
  {
    "persistence": {
      "status": "healthy | degraded",
      "lastSuccessAt": "...",
      "lastSuccessfulCheckpoint": {"at": "...", "reason": "...", "stage": 1, "path": "..."},
      "failures": [{"at": "...", "file": "...json", "code": "ENOSPC", "message": "..."}],
      "note": "..."
    }
  }
  ```

  `degraded` is sticky for the live task. A failed update never replaces previously recorded good
  bytes. When `task.json` itself cannot be written, the live API is the only possible reporting
  surface; this boundary is documented rather than hidden. Recovery claims remain
  checkpoint-based and immutable-lineage-before-prompt.

## B. Explicit `deliverySource` and reproducible import

`dsh_submit_task` and `dsh_recover_task` accept an optional:

```json
{
  "deliverySource": {
    "mode": "complete",
    "paths": ["package.json", "src"],
    "exclude": ["src/generated"]
  }
}
```

Rules:

- `paths` / `exclude` are bounded workspace-relative file or directory paths. Absolute paths,
  traversal, drive/ADS syntax, wildcards, sensitive names and links are refused. Excludes prune
  the declared scope.
- Omission keeps the exact legacy observed-changes behavior and old index schema.
- `complete` captures every regular file in scope at settled delivery, including unchanged and new
  files. A limit, unstable read, non-regular entry or link is an error; a truncated scope is never
  labelled complete.
- `patch` captures and persists a complete baseline **before** the first prompt. The index records
  `source.baseline`; continuations keep that exact baseline. Recovery creates a new task and takes
  the fresh caller's scope/baseline, never the old one.
- Additive index fields: `source.mode`, `source.scope` (`paths`, `exclude`), `source.final`
  (`manifestSha256`, `files`), and for patch `source.baseline`. Files are sorted
  `{path, bytes, sha256}` and `manifestSha256` binds the canonical sorted descriptor JSON.
  `source.files` remains the actual exported artifacts: all final files for complete, only
  added/modified bytes for patch. `changes.removed` is the truthful patch deletion list.
  Existing `selectionSha256` and artifact hash checks still apply.

Import (dry run by default, no directory or file is created):

```bash
node scripts/import-delivery.mjs --bundle <exportDirectory> --destination <directory>
node scripts/import-delivery.mjs --bundle <exportDirectory> --destination <directory> --apply
```

The CLI validates the whole index, every artifact hash, the scope, paths, limits and mode before
touching the destination. Complete import requires a new or empty directory. Patch import requires
the destination's declared scope to match the exact baseline — presence, absence and bytes — while
preserving unrelated out-of-scope files. Conflicts are refused with zero mutations. Patch apply
first writes a sibling backup/`transaction.json`, then applies additions/modifications/deletions;
a failure reports the verified restore as `rollback: complete` or `partial`, never a guess.
No second write MCP tool was added.

## C. Bounded events and recent progress

New read-only tool:

```json
{"taskId": "dsh-...", "cursor": "opaque optional", "limit": 25}
```

`dsh_get_events` returns `events`, `nextCursor`, `hasMore`, `source` (`live` or
`persisted-history`), `runtimeAttached`, `partialLine`, `pendingBytes`, scanned/returned byte
facts and the applied limits. Default limit is 25, hard cap 100. The reader seeks to the cursor and
reads bounded 64 KiB chunks; it never loads the whole log. A trailing partial JSONL line is left
unconsumed, so a later poll can return it. Opaque cursors bind task id, file device/inode identity
and byte position; malformed, cross-task and stale cursors are explicit errors. Historical paths
go through the same anchored, symlink-refusing history guards. No recorded PID is probed,
signalled or restarted; no model call is made. Secrets are scrubbed and model reasoning is stripped
at output as well as storage, and malformed lines become bounded explicit entries.

Live `dsh_get_task` / `dsh_get_result` also expose a bounded `progress` object: `lastActivityAt`,
`currentTool`, newest-first `recentTools` (max 20), stage state, accurate tool totals and the
verification state. The compatibility first-60 `toolCalls` list is unchanged. A 150-call stage
exposes call 149 in `progress.recentTools` and through complete event pagination. There is no
invented percent, ETA, liveness proof or success judgment; polling is read-only.

## Review hardening

After independent review, the 1.0.7 implementation was tightened in place:

- `BRIDGE_VERSION`, `package.json`, `package-lock.json` and the running MCP `dsh_get_capabilities`
  surface all report 1.0.7. A permanent test fails if these identities drift.
- Patch import now has a separate PREPARATION phase: every required original is copied and
  hash-verified before the first destination mutation. A backup or transaction-preparation failure
  leaves all originals untouched and reports `rollback: not-needed`. Apply rollback tracks only
  paths this run actually wrote or removed, never all declared changed paths, so a missing backup
  entry can never be mistaken for a newly created file.
- A single event larger than the page byte budget becomes a bounded
  `bridge/oversized-event` placeholder and the cursor advances past it; oversized later items do
  not hide following events and no empty non-advancing page is possible.
- Source scope capture rejects a known-size overflow before opening/allocating the file, and reads
  through a bounded descriptor loop so growth past the remaining 64 MiB budget is refused rather
  than allocated. Stable-read identity/size checks remain.
- Import inspects each artifact's actual type and size before reading. A tampered oversized file
  whose index record declares a smaller size is refused without a whole-file read or destination
  mutation; bounded reads also detect in-read growth and path identity replacement.
- Patch final capture treats a declared file OR whole declared directory absent at settlement as
  an explicit deletion. Complete capture and patch baseline capture remain strict on missing paths.

## Compatibility and limits

- Version/package-lock: `1.0.7`. Existing runtime package files and versions are byte-identical;
  `maintenance/guard.mjs` only gained new production ASSETS entries.
- Legacy observed-changes delivery indexes, history export, first-60 tool evidence, old tool
  schemas and release history remain valid. New source metadata is additive.
- Native Windows execution, native SDK conversation resume, desktop plugin inheritance and global
  concurrency/leases are deferred.
- Import cannot reconstruct unchanged patch files from a patch bundle: it verifies them against
  the baseline in the destination and refuses a mismatch. A patch bundle is not a standalone full
  copy; use complete mode when a self-contained tree is required.
- Test counts are recorded in `delivery.json` and `docs/PUBLICATION_CHECKS.json` after the final
  run; the source manifest binds the exact delivered bytes.
