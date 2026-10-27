# SDK resume assessment (pinned 0.2.1-rc.2)

Status: **investigation only; not a Bridge 1.0.6 feature claim.** The checkpoint recovery delivered in
1.0.6 deliberately creates a NEW task/session and does not call `session/resume`. This note records what
the pinned runtime actually implements, what was inspected, and what remains unverified.

## Evidence inspected

| Evidence | Exact source |
|---|---|
| Runtime root | `/home/agent/dsh-runtimes/0.2.1-rc.2-20261017` |
| Protocol implementation | `node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js`, SHA-256 `55412923f9f7c279f7e0b2a1e2853eaf238f390b3d84046cb9c94dc5f22a1e4a`, 16,454 bytes |
| Agent factory resume | `node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`, `resume` / `resumeWith` |
| Persistence backend | `node_modules/@deepseek-ai/dsh-session-persistence-jsonl` (JSONL, current format v3/v4) |
| SDK composition | `node_modules/@deepseek-ai/dsh-sdk-minimal/cordis.patch.yml` and `dsh-base/cordis.patch.yml` |
| Persistence package contract | `node_modules/@deepseek-ai/dsh-session-persistence-jsonl/README.md`, sections "Durability and crash semantics" and "Resumed conversation history" |

No model request and no real-provider probe were run for this assessment. The findings below are
implementation and package-contract evidence, not a live end-to-end resume canary.

## What the selected SDK actually provides

1. **The JSON-RPC method exists and is dispatched.** `HarnessSdkJsonRpcServer.handleRequest` has an
   explicit `case "session/resume"` that requires a non-empty `sessionId` and calls
   `this.resume({sessionId})`. It is not inferred from a method-name string scan.
2. **Resume creates an agent from a persisted session, without sending input.** `resume()` rejects an
   uninitialized/shutting-down server or a session that is already open/opening, then calls
   `openSession(sessionId, true)`. `createSession(sessionId, resume=true)` calls
   `this.ctx.agents.resume({resumeSessionId: sessionId, agentOptions})` instead of
   `ctx.agents.create(...)`. The model route is re-supplied by `initialize` before resume.
3. **The factory performs a cold read of the persisted log.** `AgentLoop.resumeWith` opens
   `sessionPersistence.open(id, "write")`, calls `handle.read(0, undefined, ...)`, appends synthetic
   closers for an interrupted final turn (`interruptedTurnClosers`), seeds a new session from the
   stored events plus closers, and publishes the agent with source `"resume"`. This is a genuine
   implementation path, not a placeholder.
4. **A persistence backend is composed for the SDK profile.** `dsh-sdk-minimal/cordis.patch.yml`
   mounts `@deepseek-ai/dsh-session-persistence-jsonl` with `root: !!js dshHomePath('sessions')` and
   `compression: none`; `dsh-base` mounts the same backend for its profile. The backend stores each
   session in a per-session append-only JSONL log and supports reopening a committed prefix after a
   crash, discarding an incomplete final raw line and repairing an interrupted final turn.
5. **The package documents restored conversation history.** Its "Resumed conversation history"
   section says loading restores stored surface history and request headers, with
   `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` repairs for calls interrupted by a crash. The resume
   operation itself is documented as sending no new input (zero live-request tokens).

## What this does and does not establish

**Supported by the implementation:** the protocol exposes a same-session resume operation; a new SDK
process can, in principle, open a persisted session from the configured `sessions` root, restore its
durable events, repair an interrupted final turn, and accept later prompts under the same session id.

**Not established by this delivery:**

- Bridge 1.0.6 does **not** call `session/resume`, does not start a runtime with the old task's
  `DSH_HOME`/sessions root, and does not reattach or reuse the old SDK process. Its recovery mode is
  explicitly `checkpoint-new-session`.
- No real cold-restart fixture was run that resumes a *conversation* across bridge processes. The
  protected host fixture exercises checkpoint recovery, not native conversation continuity.
- No evidence was collected for provider/model-side equivalence after resume, prompt-cache reuse,
  session-lock behavior across copied homes, or compatibility between an old persisted log and a
  future runtime build.
- The SDK resume path repairs interrupted tool calls with synthetic outcomes. That is a safety
  contract for the model, not proof that external side effects were replayed or were safe to replay.
- A successful `session/resume` with a missing or unreadable session is not tested here; the handler
  propagates the persistence backend's error.

## If native conversation resume is pursued later

It would need a separate integration that (a) starts a new runtime with the source task's exact
`DSH_HOME`/sessions store, (b) re-runs `initialize` with the current guarded route, (c) calls
`session/resume` for the recorded session id, (d) attaches the bridge's stage/event accounting to the
resumed agent, and (e) runs a protected cold-restart canary with a real provider. Until that exists and
passes, capability wording must keep `nativeCrossProcessResume=false` / bridge use of SDK resume false,
and no user-facing claim of full native conversation recovery is justified.
