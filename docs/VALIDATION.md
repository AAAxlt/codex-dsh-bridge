# Validation record — 1.0.8

The 1.0.8 update is prepared from the 1.0.7 candidate source. It adds bounded same-live-session continuation after real provider output exhaustion, structured caller-reported external acceptance receipts, and separate automation metrics with per-stage cause/elapsed evidence. It preserves the 1.0.7 persistence, source-scope/import, event-paging and progress surfaces, 1.0.6 checkpoint recovery, 1.0.5 history/export and all old tool schemas.

The 1.0.6 update was prepared from the 1.0.5 candidate source. It adds checkpoint recovery into a NEW task/session (`dsh_prepare_recovery`, `dsh_recover_task`), durable plan idempotency, fail-closed complete workspace content fingerprints, source/workspace drift checks, original protected-pin enforcement, pre-prompt checkpoint durability and the SDK resume assessment. It preserves the 1.0.5 read-only history, historical delivery export, repair-budget behavior and existing validation seams.

Ubuntu-DSH is the intended execution target. Native Windows execution is deferred and is not claimed by this validation record.

The default-route unit suite pins its provider before importing configuration. The unknown-runtime baseline test creates an empty temporary registry, so refusal is tested without the developer's private registry. Two tests against the original Linux runtime installations require those installations and their local registry; absent prerequisites are reported as skipped, never passed. These publication adaptations are test-only and do not remove or skip new feature coverage.

## Fresh publication checks

On Linux x64 / Node.js 24.18.1, the 1.0.8 scripted build and suite collected **293** tests. With the local exact-runtime baselines present in this candidate workspace, **293 passed, 0 skipped, 0 failed, 0 cancelled, 0 todo**. The added coverage includes legacy-disabled and complete-preset autoContinue, same-session hops, attempt/no-progress/budget stops, staging-copy non-progress, cancellation between hops, receipt idempotency/concurrency and raw-body binding, portable review-ID receipt filenames, contradictory pass-check refusal, stale/in-flight/cancelled/historical refusal, reviewed-source traversal/link/hash refusal plus bounded oversized-file refusal, declared-log non-progress, secret scrubbing, non-execution of supplied commands, pass-vs-awaiting-recheck, fresh explicit-review budget cycles, delivery/checkpoint metadata sync for pass/blocked/nonactionable receipts without live-source recapture, sealed stage byte preservation, idempotent duplicate no-ops, guard coverage for history.js, prior-stage byte preservation and pre-1.0.8 history tolerance. Those baseline files are ignored and are not published; without them the same suite reports the historical installed-runtime/baseline cases as skipped rather than passed. The runner prohibits writes outside its candidate workspace; the e2e self-check test redirects `DSH_BRIDGE_E2E_ROOT` to a workspace-local `evidence/e2e-root`, so the real driver branch still executes with unchanged assertions and test count. This is **partial validation**, not a complete installed-runtime pass and not a real-model pass. The checkpoint recovery tests cover the scripted two-phase fixture, a running first stage that already has a pre-prompt checkpoint, and partial/unsettled recovery from that checkpoint after explicit acknowledgment. Fingerprint regressions cover same-size mutation of a >2 MiB file, file-count overflow, total-byte refusal, prepare-time refusal before any runtime, and an already-created retry whose workspace has since become unsupported still returning the original task. Evidence regressions cover a large unhashed file followed by queued directories, file-count-cap deletion inference, incomplete/error snapshots, and legitimate removals on complete snapshots. Independent no-model probes confirmed the fingerprint changes and that an incomplete snapshot does not assert surviving files deleted. These tests do not claim a real provider or native SDK conversation resume. The protected host runs the real cold-restart fixture after delivery. Exact publication commands and results are recorded in [PUBLICATION_CHECKS.json](PUBLICATION_CHECKS.json).

The suite uses scripted processes and temporary metadata; it makes no model requests. `npm run test:installed-runtime` remains an explicit read-only check against a separately installed DSH bundle and fails when the installation is absent. Real provider access, model execution, native runtime behavior, protected host repair/recovery drills and local baseline capture are not claimed by these scripted results; the host runs those separately. `docs/SDK-RESUME-ASSESSMENT.md` is an implementation inspection, not a native resume acceptance result.

GitHub Actions runs npm ci and npm test on Ubuntu / Node.js 24 without provider credentials. Inspect the run for the current commit; the workflow file itself is not a passing result. The two original-installation tests may be skipped in a public runner because private runtime baselines are intentionally absent.

## Source identity and local verification

[SOURCE_MANIFEST.json](SOURCE_MANIFEST.json) and ../SOURCE-HASHES.sha256 identify the public source bytes after publication adaptations. They exclude installation-specific baseline files. Git uses LF line endings to keep checkout and committed source hashes consistent.

`scripts/verify-delivery.mjs` additionally requires a local baseline/runtime-baselines.json, an actual DSH installation, and a captured baseline. These remain local and ignored by Git. A registry entry uses this shape, with actual absolute paths and version values:

```json
{
  "schema": "codex-dsh-bridge/runtime-baselines@1",
  "baselines": [{
    "id": "my-reviewed-runtime",
    "runtimeRoot": "/absolute/path/to/dsh-runtime",
    "dshVersion": "0.2.1-rc.2",
    "baselineFile": "baseline/execution-profiles-baseline.json"
  }]
}
```

Capture the baseline with the command in README.md after reviewing your installation. The checker refuses unknown roots or mismatched versions and reports skipped checks as partial. The committed delivery.json declares source identity and the expected scripted test count (293); it is not a claim of real-model acceptance.

## Limits

No runtime binaries, private task homes, provider credentials, raw model logs, deployment launchers, or installation-specific baselines are published. Workspace admission and the SDK workspace-write setting are configuration, not proof of OS/filesystem isolation. Protected verifier hashes require callers to declare all relevant dependencies. Controlled repair examples do not establish real-task cost or review savings. New hosts, runtime versions, model routes, and arbitrary child-process cleanup need separate validation.
