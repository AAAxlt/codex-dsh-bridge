/**
 * MCP server surface. Thirteen tools, `dsh_` prefixed.
 *
 * Spec section 4 lists six workflow items; item 3 ("dsh_get_task / dsh_wait_task") is
 * implemented as two separate tools. The two history tools are a bounded READ-ONLY view of
 * records persisted by an earlier process and never join the live task-control map.
 *
 * Nothing here starts a model request except submit/continue, and no tool ever returns
 * credential values, environment dumps or model-internal reasoning.
 */
import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio, type StdioServerHandle} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';
import {
  API_KEY_ENV, BRIDGE_SERVER_NAME, BRIDGE_VERSION, DEFAULT_REASONING_EFFORT, LIMITS,
  MODEL_ID, PROVIDER_API, PROVIDER_BASE_URL, PROVIDER_ID, PROXY_MODE, REASONING_EFFORTS,
  SDK_METHODS, describeCredential, inspectDesktopRoute, probeSdkMethods, readRuntimeFacts,
} from './config.js';
import {BridgeError, TaskManager, previousRunDirs, type TaskState} from './tasks.js';
import {getHistory, historicalTaskExists, HistoryError, listHistory} from './history.js';
import {COMPLETE_DELIVERY_DEFAULTS} from './delivery-preset.js';
import {RECOVERY_LIMITS} from './recovery.js';

const STARTED_AT = new Date().toISOString();

function reply(summary: string, payload: unknown, isError = false) {
  return {
    content: [
      {type: 'text' as const, text: summary},
      {type: 'text' as const, text: '```json\n' + JSON.stringify(payload, null, 2) + '\n```'},
    ],
    isError,
  };
}

function failure(error: unknown) {
  const code = error instanceof BridgeError
    ? error.code
    : error instanceof HistoryError ? error.code : 'internal_error';
  const message = error instanceof Error ? error.message : String(error);
  return reply(`REFUSED [${code}]: ${message}`, {ok: false, code, error: message, refused: true}, true);
}

/**
 * A persisted task id must never enter the live control path. Keep the refusal here so the
 * history module remains free of process control and the TaskManager map stays live-only.
 */
function historicalNotLive(taskId: string, operation: string): BridgeError | null {
  let exists: boolean;
  try {
    exists = historicalTaskExists(taskId);
  } catch (error) {
    if (error instanceof HistoryError) {
      return new BridgeError(`persisted history root is unsafe; ${operation} refused: ${error.message}`, error.code);
    }
    return new BridgeError(`persisted history lookup failed; ${operation} refused`, 'history_invalid');
  }
  if (!exists) return null;
  return new BridgeError(
    `task ${taskId} exists only as persisted read-only history, not as a live task. `
    + `${operation} needs a live session/runtime; history never reattaches, probes, signals or stops the recorded PID. `
    + 'Use dsh_get_history to read recorded evidence, or submit a new task.',
    'historical_not_live',
  );
}

const READ_ONLY = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false} as const;
const WRITES_MAYBE = {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true} as const;
const DESTRUCTIVE = {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false} as const;

/** Additive 1.0.7 explicit source scope. Unknown keys and unsafe path shapes are refused. */
const deliverySourceSchema = z.strictObject({
  mode: z.enum(['complete', 'patch']).describe('complete captures every final file in scope; patch exports only added/modified bytes and deletions against the pre-prompt baseline.'),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(64)
    .describe('Workspace-relative file or directory paths. Absolute paths, traversal, wildcards and links are refused.'),
  exclude: z.array(z.string().min(1).max(4096)).max(64).optional()
    .describe('Optional workspace-relative paths excluded from the declared scope.'),
});

/** Additive 1.0.8 bounded provider-exhaustion continuation policy. */
const autoContinueSchema = z.object({
  enabled: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  noProgressLimit: z.number().int().min(1).max(10).optional(),
  totalBudgetMs: z.number().int().min(1_000).max(86_400_000).optional(),
}).optional().describe(
  'Bounded same-live-session continuation ONLY after a real provider max_tokens/length turn end. '
  + 'Omission is disabled; deliveryPreset complete enables maxAttempts=2, noProgressLimit=2, totalBudgetMs=3600000. '
  + 'Explicit fields win. Storage/preview truncation, cancel, permission/credential failures, a dead runtime, shutdown and verifier-integrity failures never trigger it.',
);

/** Additive 1.0.8 structured caller-reported external acceptance receipt. */
const reviewedSourceSchema = z.array(z.object({
  path: z.string().min(1).max(4_096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})).max(200);

const reviewFindingSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(4_000),
  expected: z.string().max(4_000),
  actual: z.string().max(4_000),
  reproduction: z.array(z.string().max(4_000)).max(20).optional(),
});

const reviewCheckSchema = z.object({
  name: z.string().min(1).max(256),
  status: z.enum(['pass', 'fail', 'not-run', 'blocked']),
  exitCode: z.number().int().nullable().optional(),
  stdout: z.string().max(16_000).optional(),
  stderr: z.string().max(16_000).optional(),
  platform: z.string().max(128).optional(),
  command: z.array(z.string().max(512)).max(32).optional()
    .describe('Data only. The bridge never executes this command.'),
});

function capabilitiesPayload(manager: TaskManager): unknown {
  const facts = readRuntimeFacts();
  const route = inspectDesktopRoute();
  const credential = describeCredential();
  const probe = probeSdkMethods();
  return {
    ok: true,
    bridge: {
      name: BRIDGE_SERVER_NAME,
      version: BRIDGE_VERSION,
      pid: process.pid,
      startedAt: STARTED_AT,
      nodeVersion: facts.nodeVersion,
      nodeExecutable: facts.nodeExecutable,
      transport: 'stdio, one JSON-RPC message per line (MCP stdio binding)',
    },
    communityEdition: {
      appRoot: facts.appRoot,
      appPackageJson: facts.appPackageJson,
      appPackage: facts.appPackage,
      dshPackageVersion: facts.dshPackageVersion,
      cliEntry: facts.cliEntry,
      cliEntryExists: facts.cliEntryExists,
      cliEntryOverridden: facts.cliEntryOverridden,
      cliEntryKind: facts.cliEntryKind,
      cliEntryIsReal: facts.cliEntryIsReal,
      cliEntryPackage: facts.cliEntryPackage,
      cliEntryReason: facts.cliEntryReason,
      note: 'Re-read from disk on every call. A missing cliEntry is reported, not assumed. cliEntryKind is a positive identification of the entry (@deepseek-ai/dsh vs a scripted test double), not a same-path guess.',
    },
    sdkProtocol: {
      transport: 'line-delimited JSON-RPC over the SDK child process stdio',
      methodsThisBridgeUses: [...SDK_METHODS],
      methodProbe: {
        explanation: 'Read-only scan of the pinned runtime bundle for the string literals it registers. A capability that is not found is reported as absent rather than invented.',
        scannedFiles: probe.scannedFiles,
        scannedBytes: probe.scannedBytes,
        scanTruncated: probe.truncated,
        scanError: probe.error,
        methods: probe.methods.map((m) => ({method: m.method, found: m.found, seenIn: m.files})),
      },
      nativePerTurnCancel: false,
      nativeCrossProcessResume: false,
      sdkResumeProtocolMethodPresent: true,
      bridgeUsesSdkResume: false,
      nativeConversationRecoveryValidated: false,
      cancelSemantics:
        'This SDK build exposes no per-turn cancel. dsh_cancel_task therefore stops the task\'s OWN SDK process and verifies the pid is gone. Existing files may already be partly modified.',
    },
    modelRoute: {
      selectedByUser: true,
      provider: PROVIDER_ID,
      model: MODEL_ID,
      api: PROVIDER_API,
      baseURL: PROVIDER_BASE_URL,
      apiKeyEnv: API_KEY_ENV,
      reasoningEfforts: {...REASONING_EFFORTS},
      reasoningCompatibility: {legacyNoneAlias: 'off', offAdjustedToLow: PROVIDER_ID === 'commandcode-goat', providerFallback: false},
      desktopProfileCheck: {
        path: route.path,
        readable: route.available,
        error: route.error,
        observed: route.route,
        matchesBridgeConstants: route.matchesBridgeConstants,
        drift: route.drift,
        note: 'Only non-secret fields (api, baseURL, apiKeyEnv, header name, model ids) are read. No credential file is opened. readable=false means there is no user profile to re-verify against on this platform, NOT that the route was verified.',
      },
    },
    credential: {...credential, valueNeverReturned: true},
    limits: {...LIMITS, maxConcurrentTasks: facts.maxConcurrentTasks},
    executionDefaults: {reasoningEffort: DEFAULT_REASONING_EFFORT, maxTokens: LIMITS.maxTokensDefault, budgetMs: LIMITS.stageBudgetMsDefault, explicitParametersOverrideDefaults: true},
    repairBudgetScope: {
      automaticRepair: 'autoRepair.totalBudgetMs bounds the current automatic-repair cycle of the live task: the initial generation stage, the initial host verification, and every following automatic repair stage with its host verification.',
      notAnAllManualStagesCeiling: 'A 60-minute (or any) autoRepair.totalBudgetMs is NOT a hard ceiling over all manual dsh_continue_task stages. It does not spend on or refuse a manual continuation.',
      manualContinuation: 'A manual continuation resets the automatic-repair AND output-exhaustion continuation cycle counters (attempts, unchangedFailures, lastProgressFingerprint/lastFailure, startedAt, stopReason) while preserving the previous stages, the same live session and every cumulative count (totalAutoRepairs/totalAutoContinuations).',
      parameters: {
        maxTokens: 'SDK per-response output budget, including reasoning; not a task or provider-cost ceiling.',
        budgetMs: 'Per-stage generation deadline. Expiry stops the task runtime; it is not a total task budget.',
        verificationTimeoutMs: 'Timeout for one host verification command, not the model stage and not total delivery time.',
      },
      nativeCrossProcessResume: false,
      autoContinuation: 'autoContinue bounds same-live-session continuation ONLY after an actual provider max_tokens/length turn end. Omission is disabled; deliveryPreset complete enables maxAttempts=2/noProgressLimit=2/totalBudgetMs=3600000. Attempts, monotonic elapsed budget and meaningful declared-scope source progress are counted; the same bytes, self-report, tool counts, staging copies and log growth are not progress. Storage/preview truncation, cancel, credential/permission blockers, a dead runtime, shutdown and verifier-integrity failure never trigger it.',
      externalReview: 'dsh_submit_review records a structured caller-reported receipt bound to the exact settled stage. Supplied commands/outputs are never executed. A fail with actionable findings starts one same-session repair; pass/blocked do not start the model. After a review repair and a local command pass, externalReview.status stays awaiting-recheck and productAcceptance stays unverified until an explicit pass receipt against the NEW stage. A caller pass can never turn a failing host command into a pass.',
      note: 'Legacy parameter precedence is unchanged: explicit fields override preset defaults. This bridge does not invent native cross-process SDK resume.',
    },
    deliveryPresets: {complete: {...COMPLETE_DELIVERY_DEFAULTS, requires: ['verificationCommand', 'protectedVerificationFiles']}, legacyUnchanged: true},
    workspaceBounds: {
      allowedRoots: facts.allowedRoots,
      dataRoot: facts.dataRoot,
      enforcement: 'realpath + path.relative containment against the allowed roots; not a string prefix test',
      sandboxMode: 'workspace-write (pinned per task in the generated overlay)',
      isolation: 'Workspace admission plus SDK workspace-write configuration only. OS/filesystem isolation outside the workspace is NOT proved and is not claimed by the bridge or its prompts.',
    },
    history: {
      tools: ['dsh_list_history', 'dsh_get_history'],
      source: 'persisted-history',
      runtimeAttached: false,
      runtimeAlive: null,
      canContinue: false,
      canCancel: false,
      defaultLimit: 20,
      maximumLimit: 100,
      note: 'Read-only records projected from DATA_ROOT/tasks with fixed size/array/response limits. The recorded PID is evidence only; history never probes, signals, reattaches or restarts it. List one corrupt entry without hiding valid entries.',
      export: 'dsh_export_delivery also accepts a historical taskId when no live task exists, after task/stage/deliveryStage/index alignment and artifact hash checks. It copies recorded source bytes and never reruns acceptance or recaptures the workspace.',
      controlRefusals: 'dsh_continue_task, dsh_cancel_task and dsh_wait_task refuse a historical id with code historical_not_live and never interact with its recorded process.',
    },
    proxyPolicy: {
      mode: PROXY_MODE,
      inheritedVariablesPresent: facts.proxyVariablesPresent,
      note: "'inherit' keeps the parent environment as-is; 'direct' strips proxy variables for this bridge's own child processes only. Nothing is changed globally.",
    },
    capabilities: {
      loadsDesktopPlugins: false,
      desktopPluginsInherited: false,
      baseToolsOnly: true,
      restartRecovery: true,
      restartRecoveryMode: 'checkpoint-new-session',
      concurrencyLimit: facts.maxConcurrentTasks,
      executionProfiles: {
        available: ['native', 'ptc'],
        omitted: 'legacy overlay with no agent-preset registry and no preset; the default',
        native: 'minimal agent preset composing the base agent-plane rows; the native skill tooling (skill-filesystem / tool-skill) is available',
        ptc: 'explicit opt-in only (executionProfile="ptc"); model tools are presented through run_code',
        desktopPlugins: 'NOT inherited by either profile; presets carry no Web/Desktop personality, UI or planning rows',
      },
      // This is the count of THIS MCP server's own tools, not the number of tools the model sees
      // at runtime. The runtime tool count depends on the selected preset and is not reported here.
      mcpTools: 14,
    checkpointRecovery: {
      available: true,
      tools: ['dsh_prepare_recovery', 'dsh_recover_task'],
      mode: 'checkpoint-new-session',
      newTask: true,
      newSession: true,
      oldTaskEvidence: 'read-only; never appended to the new task and never rewritten',
      sourcePidPolicy: 'the recorded PID is never probed, signalled, reattached or reused',
      recordedArgvPolicy: 'the recorded verification argv is never executed; a fresh argv and fresh protected pins are required when the source configured verification',
      idempotency: 'a durable atomic claim under DATA_ROOT/recovery/claims returns the same new taskId on retries, including after a bridge restart and after the new task changed the workspace',
      unsettledSource: 'a source recorded accepted/starting/running is refused unless the caller explicitly acknowledges allowUnsettledSource=true; that acknowledgment is not proof of old-process liveness or death',
      nativeSdkConversationResume: false,
      note: 'This is checkpoint-based work recovery into a new session, not native SDK conversation continuity. See docs/SDK-RESUME-ASSESSMENT.md.',
    },
      note: 'This runtime loads the SDK base rows, not desktop plugins; desktop plugins/skills are NOT inherited. Native skill tooling IS available to delegated tasks. PTC (run_code presentation) is only ever selected explicitly per submit, never automatically. mcpTools counts this MCP surface (including two read-only history tools, two checkpoint-recovery tools and the bounded dsh_get_events reader), NOT the runtime tool count. restartRecovery=true means checkpoint-new-session recovery only; native SDK conversation resume is not used or claimed.',
    },
    persistentRuns: previousRunDirs(),
    liveTasks: manager.listTasks(),
    modelReachability: 'NOT tested by this call: dsh_get_capabilities starts no model request, so service reachability is not claimed.',
    observability: {
      toolCounts: 'bridgeObserved.toolCallsTotal is the true count of tool invocation START events in that stage, independent of the retained-evidence cap. toolCallsRetained is how many observations were kept (max 60), toolCallsShown is what this reply displays, and toolCallsTaskTotal is the sum over all stages.',
      usage: 'bridgeObserved.usage is the compatibility field: the LAST raw usage event only. bridgeObserved.usageAccounting.stage / .task are explicit sums; a resent event with the same message id replaces its earlier record, and task never double-counts continuation stages; a missing counter is null, not 0; totalTokens is only the SDK-reported total, while componentSumTokens is an explicitly non-total arithmetic sum of aliases. cost, if the SDK reports it, is an SDK usage-event value and never a provider invoice.',
      verification: 'bridgeObserved.verification.status says whether the bridge actually ran its command, how many attempts, the exit code/error and the not-run reason. Only a normally completed turn is eligible; a cancel during execution is cancelled-during-run, not a pass. A passed command is not product acceptance.',
      checkpoint: 'checkpoint.json and checkpoints/stage-N.json are written atomically on normal end, cancel, timeout, error, runtime exit and shutdown. They are machine-generated handoff evidence, not a model conclusion and not SDK cross-process resume.',
      persistence: 'Live task/result expose persistence.status healthy|degraded, last successful checkpoint and bounded scrubbed failure facts. Critical pre-runtime/pre-prompt task+checkpoint failures are explicit and send no prompt; later failures never replace prior good bytes. If task.json itself cannot be written, only the live API can report it.',
      events: 'dsh_get_events reads bounded chunks from a cursor (default 25, hard cap 100), never the whole log. Cursors bind task/file identity; invalid/cross-task/stale cursors are refused; a partial final JSONL line is left for a later poll. Historical readers use anchored no-link paths and never probe a PID or make a model call.',
      progress: 'Live progress includes lastActivityAt, currentTool, newest-first recentTools (max 20), stage and verification state. It contains no invented percent, ETA, liveness proof or success judgment; the compatibility first-60 toolCalls list is unchanged.',
      deliverySource: 'Optional submit/recover deliverySource {mode: complete|patch, paths, exclude}. Complete captures all final in-scope files; patch binds a pre-prompt baseline and exports changed bytes plus a truthful removed list. Omission keeps the legacy observed-changes schema. Import with scripts/import-delivery.mjs (dry run default, --apply optional).',
      externalReview: 'externalReview.status is none|failed|blocked|awaiting-recheck|passed. Receipts live under the task reviews/ directory and are copied as delivery evidence; they are caller-reported, never bridge-run checks, and never include model reasoning or credentials. automationMetrics keeps manual continuations, host repairs, exhaustion continuations and review repairs as separate counters; codexDirectEditCount and token/cost savings stay unknown.',
    },
    reportingContract: {
      modelReport: 'the model\'s own text, verbatim',
      bridgeObserved: 'the SDK event stream, the workspace file diff and any command the bridge ran itself',
      separated: 'the two are returned in different fields and are never merged',
      output: 'incomplete means output exhaustion or bridge storage cutoff, resumable only while its runtime lives; previewTruncated alone does not mean incomplete',
    },
  };
}

export function createServer(manager: TaskManager): McpServer {
  const server = new McpServer(
    {name: BRIDGE_SERVER_NAME, version: BRIDGE_VERSION},
    {capabilities: {tools: {}}},
  );

  server.registerTool(
    'dsh_get_capabilities',
    {
      title: 'Inspect the DSH bridge environment (read-only)',
      description:
        'Read-only. Reports the community-edition DSH paths and versions, the pinned model route and any drift from the live desktop profile, credential presence (never its value), the SDK methods actually present in the pinned runtime, workspace bounds and the honest limit list. Starts no model request.',
      inputSchema: z.object({}),
      annotations: {...READ_ONLY, title: 'Inspect the DSH bridge environment (read-only)'},
    },
    async () => {
      const payload = capabilitiesPayload(manager);
      const facts = readRuntimeFacts();
      const summary = [
        `community edition: ${facts.appPackage.name ?? '?'} ${facts.appPackage.version ?? '?'} (dsh ${facts.dshPackageVersion ?? '?'})`,
        `cli entry present: ${facts.cliEntryExists}`,
        `route: ${PROVIDER_ID}/${MODEL_ID} on ${PROVIDER_BASE_URL}`,
        `credential ${API_KEY_ENV}: ${describeCredential().present ? 'present in this process' : 'NOT present'}`,
        `allowed workspace roots: ${facts.allowedRoots.join(', ')}`,
        'no model request was made, so reachability is not claimed',
      ].join('\n');
      return reply(summary, payload);
    },
  );

  server.registerTool(
    'dsh_submit_task',
    {
      title: 'Delegate one stage of work to DSH (starts a model request)',
      description:
        'Validates the workspace against the allowed roots, creates an isolated task directory and DSH_HOME, starts a private SDK runtime process, sends the stage prompt and returns immediately with taskId/sessionId/state. It does NOT wait for the work to finish: use dsh_wait_task and dsh_get_result. May create or modify files inside the workspace.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Absolute path to the task workspace. Must be inside the bridge\'s allowed roots.'),
        goal: z.string().min(1).max(20_000).describe('What this stage must produce.'),
        context: z.string().max(40_000).optional().describe('Background the model needs.'),
        constraints: z.array(z.string().max(2_000)).max(64).optional().describe('Rules the model must respect.'),
        acceptance: z.string().max(10_000).optional().describe('How Codex will judge this stage.'),
        verificationCommand: z.array(z.string().max(512)).min(1).max(32).optional()
          .describe('Optional argv array the BRIDGE runs itself after the stage ends, in the workspace. No shell is involved. Its real exit code is recorded separately from the model report.'),
        reasoningEffort: z.enum(['off', 'none', 'low', 'medium', 'high']).optional()
          .describe('Default medium for work. Use explicit low for short diagnostic probes and high for difficult tasks. none is a legacy alias of off; on GOAT off/none maps to low with an explicit warning, without changing provider.'),
        executionProfile: z.enum(['native', 'ptc']).optional()
          .describe('Optional execution profile. Omit for the legacy no-preset overlay. "native" mounts the minimal agent preset with native tool schemas; "ptc" presents model tools through run_code and is an explicit opt-in only. Any other value is refused before the task directory is created.'),
        maxTokens: z.number().int().min(256).max(32_768).optional()
          .describe('Per-response output budget, including model reasoning. Default 16384, maximum 32768. Explicit short budgets are preserved, not raised to a floor; values below 2048 get a warning. Output exhaustion is incomplete, not acceptance.'),
        budgetMs: z.number().int().min(1_000).max(86_400_000).optional()
          .describe('Per-stage wall-clock budget. Default 300000ms when omitted; explicit shorter/longer values are preserved. For high effort complex tasks consider 600000ms or more. Expiry stops this task SDK process and marks timed_out.'),
        deliveryPreset: z.enum(['complete']).optional().describe('Complete delivery: high/32768/30min, 10min verification, up to 3 automatic repair stages. Explicit fields override defaults. Requires an independent command and protected acceptance files.'),
        deliverySource: deliverySourceSchema.optional().describe('Explicit 1.0.7 source scope for reproducible complete/patch delivery. Omit for the legacy observed-changes export.'),
        verificationTimeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
        protectedVerificationFiles: z.array(z.string().min(1).max(4096)).max(256).optional().describe('Existing acceptance files, including checker dependencies and fixtures. Bridge pins real paths and SHA-256 before the model starts and checks before/after verification.'),
        autoRepair: z.object({
          enabled: z.boolean().optional(), maxAttempts: z.number().int().min(1).max(10).optional(),
          noProgressLimit: z.number().int().min(1).max(10).optional(),
          totalBudgetMs: z.number().int().min(1000).max(86_400_000).optional(),
        }).optional().describe('Opt-in same-session repair on failed host verification. Requires protected acceptance files. Stops on success, unchanged failures, limits, permission errors or cancellation.'),
        autoContinue: autoContinueSchema,
      }),
      annotations: {...WRITES_MAYBE, title: 'Delegate one stage of work to DSH (starts a model request)'},
    },
    async (args) => {
      try {
        const record = await manager.submit({
          workspace: args.workspace,
          goal: args.goal,
          context: args.context,
          constraints: args.constraints,
          acceptance: args.acceptance,
          verificationCommand: args.verificationCommand,
          reasoningEffort: args.reasoningEffort,
          executionProfile: args.executionProfile,
          maxTokens: args.maxTokens,
          budgetMs: args.budgetMs,
          deliveryPreset: args.deliveryPreset, verificationTimeoutMs: args.verificationTimeoutMs,
          protectedVerificationFiles: args.protectedVerificationFiles, autoRepair: args.autoRepair,
          autoContinue: args.autoContinue,
          deliverySource: args.deliverySource === undefined ? undefined : {
            mode: args.deliverySource.mode, paths: args.deliverySource.paths,
            exclude: args.deliverySource.exclude ?? [],
          },
        });
        const stage = record.stages[0]!;
        return reply(
          [
            `accepted: taskId=${record.taskId} sessionId=${record.sessionId}`,
            `state=${record.state} stage=${stage.index} messageId=${stage.messageId}`,
            record.executionProfile === null
              ? 'executionProfile: omitted (legacy no-preset overlay)'
              : `executionProfile: ${record.executionProfile} (preset overlay, sha256=${record.overlaySha256})`,
            'accepted only means the stage prompt was acknowledged. It is not completion.',
            ...record.configurationWarnings.map((warning) => `WARNING: ${warning}`),
            `next: dsh_wait_task({taskId:"${record.taskId}"}) then dsh_get_result`,
          ].join('\n'),
          {
            ok: true, taskId: record.taskId, sessionId: record.sessionId, state: record.state,
            deliveryPreset: record.deliveryPreset, verificationTimeoutMs: record.verificationTimeoutMs, autoRepair: record.autoRepair,
            stage: stage.index, messageId: stage.messageId,
            workspace: record.workspace, taskDir: record.taskDir, dshHome: record.homeDir,
            runtimePid: record.runtimePid, serverInfo: record.serverInfo,
            verificationCommand: record.verificationCommand,
            executionProfile: record.executionProfile,
            overlaySha256: record.overlaySha256,
            reasoningPolicy: record.reasoningPolicy,
            effectiveParameters: {reasoningEffort: record.reasoningEffort, maxTokens: record.maxTokens, budgetMs: record.budgetMs},
            configurationWarnings: record.configurationWarnings,
            note: 'The bridge returns as soon as the prompt is acknowledged; the model is still working.',
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'dsh_prepare_recovery',
    {
      title: 'Plan a checkpoint recovery into a new session (read-only)',
      description:
        'Read-only. Loads a persisted task record and checkpoint under DATA_ROOT/tasks with anchored, symlink-refusing reads, checks that the caller workspace matches the recorded workspace, and returns a bounded scrubbed plan with a planToken bound to the exact source record/checkpoint and current workspace state. Starts no runtime and makes no model request; never probes or reuses the recorded PID and never exposes prompts, context, environment, reasoning or the recorded argv. A source still in this bridge process\'s live map is refused; use dsh_continue_task. A missing or corrupt checkpoint is an explicit refusal. A source recorded accepted/starting/running produces a warning and requires allowUnsettledSource=true at recovery.',
      inputSchema: z.object({
        taskId: z.string().min(1).max(64),
        workspace: z.string().min(1).max(4096).describe('The admitted current workspace; it must canonically match the workspace recorded for the task.'),
      }),
      annotations: {...READ_ONLY, title: 'Plan a checkpoint recovery into a new session (read-only)'},
    },
    async ({taskId, workspace}) => {
      try {
        const plan = manager.prepareRecovery({taskId, workspace});
        return reply(
          [
            `recovery plan: source=${plan.source.taskId} stage=${plan.source.stage} recordedState=${plan.source.recordedState}`,
            `planToken=${plan.planToken}`,
            `requires: instructions=true freshVerification=${plan.requires.freshVerificationCommand} freshProtectedFiles=${plan.requires.freshProtectedVerificationFiles} allowUnsettledSource=${plan.requires.allowUnsettledSource}`,
            ...plan.warnings.map((warning) => `WARNING: ${warning}`),
            'read-only plan: no runtime and no model request was started; the old task is evidence only',
            plan.note,
          ].join('\n'),
          plan,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'dsh_recover_task',
    {
      title: 'Recover a persisted checkpoint into a NEW task/session (starts a model request)',
      description:
        'Starts a NEW task, private SDK runtime and session from a plan produced by dsh_prepare_recovery, using the checked original goal/constraints, a bounded checkpoint summary and the current instructions. The old task tree is never written and its stages are never appended. The recorded PID and recorded verification argv are never reused or executed: fresh caller-supplied verification settings are required when the source configured verification, and original protected pins must still match. A durable atomic claim returns the same new taskId with alreadyRecovered=true on retries, including after a bridge restart. A source recorded accepted/starting/running requires explicit allowUnsettledSource=true; that is a caller acknowledgment, not bridge proof of old-process liveness.',
      inputSchema: z.object({
        taskId: z.string().min(1).max(64),
        workspace: z.string().min(1).max(4096),
        planToken: z.string().length(64).regex(/^[a-f0-9]{64}$/).describe('planToken returned by dsh_prepare_recovery for this exact source and workspace.'),
        instructions: z.string().min(1).max(RECOVERY_LIMITS.instructionsChars).describe('What this recovered NEW stage must do now. The old conversation is not restored.'),
        allowUnsettledSource: z.boolean().optional().describe('Explicit acknowledgment that the source was recorded accepted/starting/running and the old stop status is unknown. It is not proof that the old process is dead; recovery still starts a NEW session.'),
        acceptance: z.string().max(10_000).optional(),
        verificationCommand: z.array(z.string().max(512)).min(1).max(32).optional()
          .describe('Fresh argv the bridge runs itself after the recovered stage. Required when the source configured verification; the recorded argv is never executed.'),
        reasoningEffort: z.enum(['off', 'none', 'low', 'medium', 'high']).optional(),
        executionProfile: z.enum(['native', 'ptc']).optional()
          .describe('Fresh execution profile. Omitted inherits the source profile when it had one, preserving the same execution semantics.'),
        maxTokens: z.number().int().min(256).max(32_768).optional(),
        budgetMs: z.number().int().min(1_000).max(86_400_000).optional(),
        deliveryPreset: z.enum(['complete']).optional(),
        deliverySource: deliverySourceSchema.optional()
          .describe('Fresh explicit source scope for the recovered task. The source task\'s historic paths and patch baseline are never replayed.'),
        verificationTimeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
        protectedVerificationFiles: z.array(z.string().min(1).max(4096)).max(256).optional()
          .describe('Fresh pins for current verifier files. When the source pinned files, the same real paths and original hashes must be supplied; additional pins are allowed.'),
        autoRepair: z.object({
          enabled: z.boolean().optional(), maxAttempts: z.number().int().min(1).max(10).optional(),
          noProgressLimit: z.number().int().min(1).max(10).optional(),
          totalBudgetMs: z.number().int().min(1000).max(86_400_000).optional(),
        }).optional(),
        autoContinue: autoContinueSchema,
      }),
      annotations: {...WRITES_MAYBE, title: 'Recover a persisted checkpoint into a NEW task/session (starts a model request)'},
    },
    async (args) => {
      try {
        const result = await manager.recoverTask({
          ...args,
          deliverySource: args.deliverySource === undefined ? undefined : {
            mode: args.deliverySource.mode, paths: args.deliverySource.paths,
            exclude: args.deliverySource.exclude ?? [],
          },
        });
        return reply(
          [
            `${result.alreadyRecovered ? 'already recovered' : 'recovered'}: taskId=${result.taskId} sessionId=${result.sessionId}`,
            `recoveredFrom=${result.recoveredFrom.taskId} stage=${result.recoveredFrom.stage} sourceSessionId=${result.recoveredFrom.sessionId} mode=${result.recoveredFrom.mode}`,
            result.alreadyRecovered
              ? 'idempotent retry: no second runtime or model request was started'
              : `state=${result.state ?? 'unknown'} runtimePid=${String(result.runtimePid ?? null)}`,
            'this is a NEW session; old stages and old evidence remain in the old task and are read-only',
            result.note,
          ].join('\n'),
          result,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'dsh_get_task',
    {
      title: 'Read the current state of a task (read-only, never blocks)',
      description:
        'Returns the eight-state task state, the current stage summary, runtime liveness, cancel/timeout facts and whether the task can accept another stage. Never blocks.',
      inputSchema: z.object({taskId: z.string().min(1)}),
      annotations: {...READ_ONLY, title: 'Read the current state of a task (read-only, never blocks)'},
    },
    async ({taskId}) => {
      try {
        const status = manager.status(taskId) as {state: TaskState; stageCount: number; canContinue: boolean};
        return reply(
          `taskId=${taskId} state=${status.state} stages=${status.stageCount} canContinue=${status.canContinue}`,
          status,
        );
      } catch (error) {
        return failure(historicalNotLive(taskId, 'dsh_get_task') ?? error);
      }
    },
  );

  server.registerTool(
    'dsh_wait_task',
    {
      title: 'Wait a bounded time for the current stage to settle (read-only)',
      description:
        `Blocks up to timeoutMs (default ${LIMITS.waitTimeoutMs}, hard cap ${LIMITS.waitTimeoutMaxMs} = limits.waitTimeoutMaxMs in dsh_get_capabilities) waiting for the current stage to end. On timeout it returns the latest status and says you may simply call it again. It never waits indefinitely and never treats a timeout as failure. IMPORTANT for clients: set your own per-request timeout above limits.clientRequestTimeoutFloorMs (${LIMITS.clientRequestTimeoutFloorMs}ms); an MCP client's SDK default is 60s, so a long wait will otherwise be aborted client-side and look like a transport failure.`,
      inputSchema: z.object({
        taskId: z.string().min(1),
        timeoutMs: z.number().int().min(1_000).max(LIMITS.waitTimeoutMaxMs).optional(),
      }),
      annotations: {...READ_ONLY, title: 'Wait a bounded time for the current stage to settle (read-only)'},
    },
    async ({taskId, timeoutMs}) => {
      try {
        const outcome = await manager.wait(taskId, timeoutMs ?? LIMITS.waitTimeoutMs);
        const status = outcome.status as {state: TaskState};
        return reply(
          [
            `outcome=${outcome.outcome} state=${status.state} waitedMs=${outcome.waitedMs}`,
            outcome.outcome === 'timeout'
              ? 'the stage is still in flight; call dsh_wait_task again or dsh_get_task for the latest state'
              : 'the stage settled; read dsh_get_result',
          ].join('\n'),
          outcome,
        );
      } catch (error) {
        return failure(historicalNotLive(taskId, 'dsh_wait_task') ?? error);
      }
    },
  );

  server.registerTool(
    'dsh_get_result',
    {
      title: 'Read one stage result: model report and bridge-observed evidence (read-only)',
      description:
        'Returns the latest or a named stage. Model report and bridge evidence are separate. modelReport.previewTruncated means only the display preview was shortened; upstreamTruncated means the model hit its output limit and the stage is incomplete. Full recorded text stays on disk. bridgeObserved.toolCallsTotal is the TRUE tool-call total (not the retained 60); usageAccounting separates latest, stage sum and task sum (missing counters are null, never 0); verification.status states whether the bridge command ran, its attempts/exit code and any not-run reason; deliverySummary gives a compact deterministic acceptance basis and evidence paths. Model-internal reasoning is excluded.',
      inputSchema: z.object({
        taskId: z.string().min(1),
        stage: z.number().int().min(1).optional().describe('Stage number. Defaults to the latest stage.'),
        verbose: z.boolean().optional().describe('Include up to 60 tool observations instead of 25.'),
      }),
      annotations: {...READ_ONLY, title: 'Read one stage result: model report and bridge-observed evidence (read-only)'},
    },
    async ({taskId, stage, verbose}) => {
      try {
        const payload = manager.result(taskId, stage, verbose ?? false) as {
          stage: number; stageState: TaskState; taskState: TaskState;
          modelReport: {chars: number; truncated: boolean; previewTruncated: boolean; upstreamTruncated: boolean; storageTruncated: boolean; fullReportPath: string | null};
          bridgeObserved: {
            output: {status: string; limitReached: boolean};
            toolCallsTotal: number; toolCallsRetained: number; toolCallsShown: number; toolCallsDropped: number; toolCallsTaskTotal: number;
            toolErrorCount: number;
            verification: {status: string; attempts: number; lastRun: {exitCode: number | null} | null; notRunReason: string | null};
            usageAccounting: {stage: {records: number}; task: {records: number; stagesWithUsage: number; stagesTotal: number}};
          };
          deliverySummary: {productAcceptance: string; evidence: {checkpoint: string}};
          configurationWarnings: string[];
          unresolved: string[];
        };
        const v = payload.bridgeObserved.verification;
        const usage = payload.bridgeObserved.usageAccounting;
        return reply(
          [
            `taskId=${taskId} stage=${payload.stage} stageState=${payload.stageState} taskState=${payload.taskState}`,
            `generation=${payload.bridgeObserved.output.status}; upstreamTruncated=${payload.modelReport.upstreamTruncated}; previewTruncated=${payload.modelReport.previewTruncated}; storageTruncated=${payload.modelReport.storageTruncated}`,
            `model report: ${payload.modelReport.chars} recorded chars (truncated=${payload.modelReport.truncated})${payload.modelReport.fullReportPath ? ` recorded text: ${payload.modelReport.fullReportPath}` : ''}`,
            ...payload.configurationWarnings.map((warning) => `WARNING: ${warning}`),
            `bridge observed: ${payload.bridgeObserved.toolCallsTotal} tool call(s) total, ${payload.bridgeObserved.toolCallsRetained} retained, ${payload.bridgeObserved.toolCallsShown} shown, ${payload.bridgeObserved.toolErrorCount} flagged isError; task total ${payload.bridgeObserved.toolCallsTaskTotal}`,
            v.status === 'cancelled-during-run'
              ? `bridge verification ran but the task was cancelled during it (exitCode=${String(v.lastRun?.exitCode ?? null)}); not acceptance`
              : v.status === 'passed' || v.status === 'failed' || v.status === 'timed-out' || v.status === 'errored'
                ? `bridge verification: ${v.status} (attempts=${v.attempts}, exitCode=${String(v.lastRun?.exitCode ?? null)})`
                : v.status === 'not-configured'
                  ? 'no verification command was supplied to the bridge'
                  : `bridge verification did NOT run (${v.status}): ${v.notRunReason ?? 'reason not recorded'}`,
            `usage: stage ${usage.stage.records} event(s), task ${usage.task.records} event(s) across ${usage.task.stagesWithUsage}/${usage.task.stagesTotal} stage(s); see usageAccounting for exact fields`,
            `delivery: productAcceptance=${payload.deliverySummary.productAcceptance}; checkpoint=${payload.deliverySummary.evidence.checkpoint}`,
            `${payload.unresolved.length} unresolved item(s)`,
          ].join('\n'),
          payload,
        );
      } catch (error) {
        return failure(historicalNotLive(taskId, 'dsh_get_result') ?? error);
      }
    },
  );

  server.registerTool(
    'dsh_get_events',
    {
      title: 'Read bounded incremental task events (read-only)',
      description:
        'Reads at most limit (default 25, hard cap 100) events from the task event log, starting at an opaque cursor. Logs are scanned in bounded chunks, never loaded whole; a trailing partial JSONL line is not consumed. Cursors are bound to task id and file identity, and invalid/cross-task/stale cursors are refused. Live and persisted-history reads are read-only: no PID is probed or controlled, no runtime is started and no model request is made. Secrets are scrubbed and model reasoning is stripped at output as well as storage.',
      inputSchema: z.object({
        taskId: z.string().min(1).max(64),
        cursor: z.string().min(1).max(1024).optional().describe('Opaque nextCursor from a previous dsh_get_events page.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum events in this page. Default 25, maximum 100.'),
      }),
      annotations: {...READ_ONLY, title: 'Read bounded incremental task events (read-only)'},
    },
    async ({taskId, cursor, limit}) => {
      try {
        const page = manager.getEvents(taskId, cursor, limit);
        return reply(
          [
            `events: ${page.returned} returned (hasMore=${page.hasMore}, partialLine=${page.partialLine}, scannedBytes=${page.scannedBytes})`,
            `source=${page.source}; runtimeAttached=${page.runtimeAttached}; limit=${page.limits.limit}`,
            page.hasMore ? 'call dsh_get_events again with nextCursor for the next bounded page' : 'no further complete events are available at this cursor',
            page.note,
          ].join('\n'),
          page,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'dsh_list_history',
    {
      title: 'List persisted task history after a bridge restart (read-only, bounded)',
      description:
        'Read-only view of tasks recorded under the configured DATA_ROOT/tasks by earlier bridge processes. Returns at most limit (default 20, hard maximum 100) projected summaries. Every response fixes source=persisted-history, runtimeAttached=false, runtimeAlive=null, canContinue=false and canCancel=false. The recorded state, timestamps and PID are evidence only; this tool never probes, resumes, continues, cancels or restarts a recorded runtime, and never recaptures a workspace. One corrupt entry is reported without hiding valid entries.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Maximum summaries to return. Default 20, maximum 100.'),
      }),
      annotations: {...READ_ONLY, title: 'List persisted task history after a bridge restart (read-only, bounded)'},
    },
    async ({limit}) => {
      try {
        const payload = listHistory({limit}) as {
          tasks: Array<{taskId: string; valid: boolean; recordedState?: string | null}>;
          total: number; returned: number; truncated: boolean;
        };
        return reply(
          [
            `${payload.returned}/${payload.total} persisted task record(s) returned (truncated=${payload.truncated})`,
            'source=persisted-history; runtimeAttached=false; runtimeAlive=null; canContinue=false; canCancel=false',
            ...payload.tasks.slice(0, 10).map((item) => `${item.taskId}: ${item.valid ? `recordedState=${item.recordedState ?? 'unknown'}` : 'corrupt record'}`),
            'these are recorded facts, not a live task list; use dsh_get_history for bounded detail',
          ].join('\n'),
          payload,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'dsh_get_history',
    {
      title: 'Read one persisted task record and stage result (read-only, bounded)',
      description:
        'Reads one task recorded by an earlier bridge process, optionally one stage. Returns a fixed read-only envelope (source=persisted-history, runtimeAttached=false, runtimeAlive=null, canContinue=false, canCancel=false) plus projected, scrubbed task/stage/checkpoint/delivery evidence. Prompts, context, environment, reasoning, raw argv and record-controlled absolute paths are not returned. A missing or corrupt stage result is reported explicitly and never replaced with an earlier stage. The recorded PID is never probed or used for process control.',
      inputSchema: z.object({
        taskId: z.string().min(1),
        stage: z.number().int().min(1).optional().describe('Recorded stage number. Defaults to the latest recorded stage.'),
      }),
      annotations: {...READ_ONLY, title: 'Read one persisted task record and stage result (read-only, bounded)'},
    },
    async ({taskId, stage}) => {
      try {
        const payload = getHistory(taskId, stage) as {
          taskId: string; recordedState: string; stageCount: number;
          stage: {index: number; recordedState: string; recordedResult?: {status?: string}};
          delivery: {exportable: boolean; reason: string | null};
          checkpoint: {status: string};
        };
        const resultStatus = payload.stage.recordedResult?.status ?? 'omitted (bounded response)';
        return reply(
          [
            `historical taskId=${payload.taskId} recordedState=${payload.recordedState} stages=${payload.stageCount}`,
            `stage=${payload.stage.index} recordedState=${payload.stage.recordedState} result=${resultStatus} checkpoint=${payload.checkpoint.status}`,
            `delivery exportable=${payload.delivery.exportable}${payload.delivery.reason ? ` (${payload.delivery.reason})` : ''}`,
            'source=persisted-history; runtimeAttached=false; runtimeAlive=null; canContinue=false; canCancel=false',
            'recorded evidence only: no runtime was attached, no PID was probed and no acceptance command was run',
          ].join('\n'),
          payload,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'dsh_continue_task',
    {
      title: 'Send Codex review comments as the next stage of the same session',
      description:
        'Continues the SAME live session so the model still has its earlier work in context. Refuses unknown taskIds, a stage already in flight, cancelled tasks, tasks whose runtime died, and any stage after shutdown. Each stage gets its own number and its own result; earlier stage evidence is never overwritten.',
      inputSchema: z.object({
        taskId: z.string().min(1),
        review: z.string().min(1).max(40_000).describe('Codex\'s review of the previous stage, including what failed and what to change.'),
        acceptance: z.string().max(10_000).optional().describe('Acceptance for the new stage.'),
        goal: z.string().min(1).max(20_000).optional().describe('Restate the stage goal if it differs from the original.'),
      }),
      annotations: {...WRITES_MAYBE, title: 'Send Codex review comments as the next stage of the same session'},
    },
    async ({taskId, review, acceptance, goal}) => {
      try {
        const record = await manager.continue(taskId, review, acceptance, goal);
        const stage = record.stages[record.stages.length - 1]!;
        return reply(
          [
            `continued: taskId=${record.taskId} stage=${stage.index} state=${record.state} messageId=${stage.messageId}`,
            'the previous stage result is still on disk and unchanged',
            `next: dsh_wait_task({taskId:"${record.taskId}"}) then dsh_get_result`,
          ].join('\n'),
          {
            ok: true, taskId: record.taskId, stage: stage.index, state: record.state,
            messageId: stage.messageId, stageCount: record.stages.length,
            previousStages: record.stages.slice(0, -1).map((s) => ({index: s.index, state: s.state, resultPath: s.resultPath})),
          },
        );
      } catch (error) {
        return failure(historicalNotLive(taskId, 'dsh_continue_task') ?? error);
      }
    },
  );

  server.registerTool(
    'dsh_submit_review',
    {
      title: 'Record a structured external acceptance receipt (may start one repair stage)',
      description:
        'Records a caller-reported external acceptance receipt bound to the exact latest settled stage. source=caller-reported: supplied commands and check outputs are DATA ONLY and are never executed. reviewedSource paths must be workspace-relative regular no-link files whose current SHA-256 matches. The receipt is persisted before any prompt. outcome=pass/blocked never starts the model; outcome=fail with actionable findings starts ONE repair stage in the same live session, even if host verification previously passed. Same reviewId with the same body is idempotent and never sends a second prompt; conflicting reuse is refused. Stale/in-flight/cancelled/historical/dead-runtime controls are refused without modifying files.',
      inputSchema: z.object({
        taskId: z.string().min(1).max(64),
        stage: z.number().int().min(1).max(100).describe('The exact latest settled stage this receipt reviews.'),
        reviewId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        outcome: z.enum(['pass', 'fail', 'blocked']),
        summary: z.string().min(1).max(20_000),
        findings: z.array(reviewFindingSchema).max(50).optional(),
        checks: z.array(reviewCheckSchema).max(50).optional(),
        reviewedSource: reviewedSourceSchema.optional(),
      }),
      annotations: {...WRITES_MAYBE, title: 'Record a structured external acceptance receipt (may start one repair stage)'},
    },
    async (args) => {
      try {
        const result = await manager.submitReview({
          taskId: args.taskId,
          stage: args.stage,
          reviewId: args.reviewId,
          outcome: args.outcome,
          summary: args.summary,
          findings: (args.findings ?? []).map((finding) => ({
            id: finding.id, title: finding.title, expected: finding.expected, actual: finding.actual,
            reproduction: finding.reproduction ?? [],
          })),
          checks: (args.checks ?? []).map((check) => ({
            name: check.name, status: check.status, exitCode: check.exitCode ?? null,
            stdout: check.stdout ?? '', stderr: check.stderr ?? '',
            platform: check.platform ?? null, command: check.command ?? null,
          })),
          reviewedSource: args.reviewedSource ?? [],
        });
        return reply(
          [
            `review recorded: taskId=${result.taskId} reviewId=${result.reviewId} stage=${result.stage} alreadyRecorded=${result.alreadyRecorded}`,
            `continued=${result.continued} repairStage=${String(result.repairStage)} externalReview=${result.externalReview.status}`,
            'source=caller-reported: the bridge did not execute any supplied command or check output',
            result.note,
          ].join('\n'),
          result,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'dsh_cancel_task',
    {
      title: 'Stop this task\'s own SDK process and preserve its evidence (destructive)',
      description:
        'Stops the SDK process this bridge started for THIS task only, then verifies the pid is gone. It never touches the user\'s running DSH Desktop. Because the SDK has no per-turn cancel, the turn is interrupted rather than gracefully cancelled, and files may already have been partly modified; the returned diff is what the bridge actually observed.',
      inputSchema: z.object({taskId: z.string().min(1), reason: z.string().max(2_000).optional()}),
      annotations: {...DESTRUCTIVE, title: 'Stop this task\'s own SDK process and preserve its evidence (destructive)'},
    },
    async ({taskId, reason}) => {
      try {
        const payload = await manager.cancel(taskId) as {
          runtimeStopped: boolean; pid: number | null; partialFileChanges: {added: string[]; modified: string[]; removed: string[]} | null;
        };
        return reply(
          [
            `cancelled: taskId=${taskId} runtimeStopped=${payload.runtimeStopped} pid=${payload.pid}`,
            reason ? `reason: ${reason}` : 'no reason supplied',
            payload.partialFileChanges
              ? `partial changes already on disk: +${payload.partialFileChanges.added.length} ~${payload.partialFileChanges.modified.length} -${payload.partialFileChanges.removed.length}`
              : 'no file changes were observed',
            'evidence was preserved under this task\'s directory',
          ].join('\n'),
          payload,
        );
      } catch (error) {
        return failure(historicalNotLive(taskId, 'dsh_cancel_task') ?? error);
      }
    },
  );

  server.registerTool('dsh_export_delivery', {
    title: 'Export the recorded final delivery bundle',
    description: 'Copies a recorded delivery index, selected source snapshot and evidence to a new directory inside allowed workspace roots. It exports a settled live task or a validated persisted-history task when no live task exists. Historical export requires task/deliveryStage/index taskId and stageCount alignment and still validates every recorded artifact hash and path; it copies recorded source bytes only, never reruns acceptance, never recaptures the current workspace and starts no model request or runtime.',
    inputSchema: z.object({taskId: z.string().min(1), destination: z.string().min(1).max(4096)}),
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false},
  }, async ({taskId, destination}) => {
    try { const payload = manager.exportDelivery(taskId, destination); return reply(`delivery exported: ${payload.indexJson}`, {ok: true, ...payload}); }
    catch (error) { return failure(error); }
  });

  return server;
}

export function startStdio(manager: TaskManager): StdioServerHandle {
  return serveStdio(() => createServer(manager));
}
