# Codex–DSH Bridge

A local MCP bridge that lets Codex delegate bounded development tasks to a separate DSH agent harness, inspect the evidence, and explicitly decide whether to continue.

**Development status:** work in progress. The current source baseline is **1.0.2**. This is an independent community project, with no claim of affiliation with OpenAI or DeepSeek. Public adoption and cross-model coverage have not been established.

[中文说明](README.zh-CN.md) · [Calling conventions](USAGE.md) · [Validation and limitations](docs/VALIDATION.md)

## Why this exists

Connecting an MCP client to another agent is only the first step. A useful delegation loop also needs bounded execution, inspectable results, explicit review, continuation, and cancellation.

This bridge keeps Codex in charge of that loop. DSH executes one stage in a private SDK process and task home; the bridge records SDK events, workspace changes, and optional host verification separately from the model's own report. Reaching an output limit is reported as `incomplete`, rather than being presented as successful completion.

The project is also a place to develop reproducible harness and model compatibility checks. Its current provider routes are deliberately narrow; it does not claim universal provider support or measured cost savings.

## The workflow

1. Inspect configuration with `dsh_get_capabilities`.
2. Submit a workspace, goal, constraints, and acceptance criteria with `dsh_submit_task`.
3. Observe progress with `dsh_get_task` or `dsh_wait_task`.
4. Read `dsh_get_result`, checking `modelReport` and `bridgeObserved` separately.
5. Supply an actual review to `dsh_continue_task`, or end the runtime with `dsh_cancel_task`.

A returned report is evidence for review, not automatic acceptance. Continuation requires the original runtime to remain alive. There is no recovery of live sessions across bridge restarts.

## Build and run

Use **Node.js 24** for the currently tested development environment. The package declares Node.js 20 or later, but the full suite has not been validated on every declared Node version.

```sh
npm ci
npm run build
npm test
```

The ordinary suite uses scripted execution and synthetic package metadata, requires no installed DSH runtime, and makes no model requests. The initial automated CI targets Ubuntu. Some Windows tests retain the original `D:\AGENTS` scratch-directory convention; Windows CI portability remains unfinished.

Actual delegation additionally needs a separately installed **community DSH runtime**. The development baseline used `@deepseek-ai/dsh` **0.2.1-rc.2**. DSH and its SDK packages are not bundled or installed by this repository. Compatibility with later versions must be checked rather than assumed.

After configuring that installation, `npm run test:installed-runtime` runs two additional read-only checks against the actual bundle. Those checks fail when the installation is missing; they never fall back to synthetic metadata. They do not test model reachability.

Configure the MCP server to execute `node /absolute/path/to/codex-dsh-bridge/dist/src/main.js` over stdio. Set these environment variables in the launcher or MCP server configuration:

| Variable | Purpose |
| --- | --- |
| `DSH_BRIDGE_RUNTIME_ROOT` | Absolute directory containing the DSH runtime's `node_modules` |
| `DSH_BRIDGE_ALLOWED_ROOTS` | Existing workspace roots; separate with `;` on Windows or `:` on POSIX |
| `DSH_BRIDGE_DATA_ROOT` | Private writable location for task state and evidence |
| `DSH_BRIDGE_PROVIDER` | `opencode-go` (default) or `commandcode-goat` |
| `OPENCODE_GO_API_KEY` | Credential for the `opencode-go` route |
| `COMMANDCODE_API_KEY` | Credential for the `commandcode-goat` route |
| `DSH_BRIDGE_PROXY_MODE` | `inherit` (default) or explicit `direct` for the child process |
| `DSH_BRIDGE_DESKTOP_PROFILE_PATCH` | Optional local desktop profile path; use an absent path when no desktop profile is available |

Supply only the credential for the route you intend to use. Read it from your private environment; do not commit it to a repository or a shared launcher. A ChatGPT subscription is not itself a credential for these DSH provider routes.

Example POSIX launcher, after defining the selected provider credential privately:

```sh
export DSH_BRIDGE_RUNTIME_ROOT="$HOME/dsh-runtime"
export DSH_BRIDGE_ALLOWED_ROOTS="$HOME/projects"
export DSH_BRIDGE_DATA_ROOT="$HOME/.codex-dsh-bridge"
export DSH_BRIDGE_PROVIDER="opencode-go"
mkdir -p "$HOME/projects" "$DSH_BRIDGE_DATA_ROOT"
node /absolute/path/to/codex-dsh-bridge/dist/src/main.js
```

The Windows defaults in `src/config.ts` still reflect the original development machine. Override the paths explicitly on other machines. A WSL runtime expects Linux paths and workspaces visible inside that environment; a Windows path cannot be passed to it unchanged.

### Optional execution profiles

Omit `executionProfile` for the legacy overlay. Explicit `native` and `ptc` profiles mount scoped agent presets and require a local critical-runtime baseline. That baseline is installation specific and is intentionally excluded from Git.

After reviewing the installed runtime and building the bridge, capture it locally:

```sh
node maintenance/guard.mjs baseline \
  --runtime-root "$DSH_BRIDGE_RUNTIME_ROOT" \
  --assets-root "$PWD" \
  --baseline "$PWD/baseline/execution-profiles-baseline.json"
```

The guard refuses to overwrite an existing baseline and blocks explicit profiles on drift. A baseline records selected files; it is not a full audit of the runtime or its dependency tree. Desktop plugins are not inherited by these profiles.

### Task parameters

Omitted work parameters select `reasoningEffort=medium`, `maxTokens=16384`, and a **300000 ms per-stage budget**. Explicit shorter diagnostic budgets and `high` effort are preserved. On the GOAT route, `off`/`none` is mapped to `low` with a warning; there is no silent provider switch.

`verificationCommand` is an optional argv array executed by the bridge in the workspace. Its exit code is recorded independently of the model report. Long MCP waits also require a client request timeout above the floor reported by capabilities.

## Boundaries and known gaps

- The allowed-root check validates task admission. It is **not an operating-system sandbox** and does not isolate arbitrary child commands. Use a separate OS account, container, VM, or other appropriate host boundary for untrusted work.
- The default concurrency limit is one task. Model calls require your own authorized provider access and can incur charges.
- A read-only capability probe does not establish model reachability or end-to-end acceptance.
- Cancellation records process cleanup evidence, with platform-dependent coverage. It does not guarantee capture of arbitrary escaped descendants.
- The model harness is version sensitive. Browser, desktop, account, and arbitrary model/provider compatibility remain outside the current acceptance claims.
- Live model scripts are separate from `npm test`; review them and configure the runtime before running them. `scripts/e2e-real.mjs` intentionally waits for a review file between stages.

See [validation notes](docs/VALIDATION.md) before relying on the bridge for a new environment.

## Contributing

Small, reproducible bug reports are useful: include the bridge commit, Node/OS version, DSH runtime version, selected route and execution profile, expected behavior, and a redacted minimal reproduction. Never attach credentials, private prompts, task homes, or unredacted model logs.

Build and run `npm test` before proposing a change. State whether evidence comes from scripted tests or a real runtime. Cross-model claims need the exact route/model/runtime and a reproducible task; configuration alone is insufficient.

## License and dependencies

Bridge source is released under the [MIT License](LICENSE). External dependencies and the separately installed DSH runtime retain their own licenses and terms. See [third-party notices](THIRD_PARTY_NOTICES.md).
