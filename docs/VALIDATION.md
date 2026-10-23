# Validation record — 1.0.4

The public 1.0.4 update is prepared from the local 1.0.4 development candidate on 2026-10-23. All production src/ files are copied without implementation changes. Publication preserves the MIT license, repository metadata, opt-in installed-runtime checks, and portable unit metadata samples from the existing public repository.

The default-route unit suite pins its provider before importing configuration. The unknown-runtime baseline test creates an empty temporary registry, so refusal is tested without the developer's private registry. Two tests against the original Linux runtime installations require those installations and their local registry; absent prerequisites are reported as skipped, never passed. Production source is unchanged by these publication adaptations.

## Fresh publication checks

On Windows x64 / Node.js 24.18.1, the 1.0.4 scripted build and suite collected **185** tests: **183 passed, 2 skipped, 0 failed, 0 cancelled, 0 todo**. This is **partial validation**, not a complete installed-runtime pass. Exact publication commands and results are recorded in [PUBLICATION_CHECKS.json](PUBLICATION_CHECKS.json).

The suite uses scripted processes and temporary metadata; it makes no model requests. `npm run test:installed-runtime` remains an explicit read-only check against a separately installed DSH bundle and fails when the installation is absent. Real provider access, model execution, native runtime behavior, and local baseline capture are not repeated by this publication task.

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

Capture the baseline with the command in README.md after reviewing your installation. The checker refuses unknown roots or mismatched versions and reports skipped checks as partial. The committed delivery.json declares source identity and the expected scripted test count; it is not a claim of real-model acceptance.

## Limits

No runtime binaries, private task homes, provider credentials, raw model logs, deployment launchers, or installation-specific baselines are published. Allowed workspace roots are not an OS sandbox. Protected verifier hashes require callers to declare all relevant dependencies. A controlled repair example does not establish real-task cost or review savings. New hosts, runtime versions, model routes, and arbitrary child-process cleanup need separate validation.
