# Bridge 1.0.4

This development release adds complete delivery, optional same-session repair, and inspectable export artifacts. Existing calls retain medium reasoning, 16384 maximum tokens, and a 300000 ms stage budget when no preset or explicit override is supplied.

- `deliveryPreset: "complete"` selects high reasoning, 32768 tokens, a 30-minute stage budget, 10-minute host verification, and up to three additional repair stages within a 60-minute overall budget. Explicit parameters take precedence.
- Optional `autoRepair` sends failed host-verification evidence back to the same live DSH session. It stops on success, cancellation, external blockers, protected-file changes, no progress, or configured limits. Every stage keeps separate evidence.
- Protected verification files are pinned by real path and SHA-256 before execution and checked around verification. Callers must declare the verifier and its dependencies; this is not OS-level isolation.
- Tasks generate delivery indexes, selected source snapshots, redacted evidence, and hashes. `dsh_export_delivery` copies the recorded artifacts to a new directory under an allowed root and validates their hashes. Export does not rerun acceptance.
- Results expose true tool-call totals, deduplicated stage/task usage, checkpoint paths, repair counts, first-pass verification, and delivery duration. Unknown Codex token use and review costs remain unknown.
- The independent delivery checker distinguishes pass (exit 0), partial (exit 2), and fail (exit 1), validates actual test outcomes and manifest bytes, and refuses an unregistered runtime baseline.
- Verification cancellation/shutdown races, verifier descendant timeouts, and stale delivery exports after later failed stages are covered by regression tests.

See [calling conventions](../USAGE.md) and [validation boundaries](VALIDATION.md). Local runtime baselines, credentials, private deployment records, and raw model evidence are excluded from this repository. The scripted publication checks do not repeat real model acceptance or establish cost savings.
