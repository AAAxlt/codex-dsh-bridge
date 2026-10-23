/**
 * MCP server surface. Eight tools, `dsh_` prefixed.
 *
 * Spec section 4 lists six workflow items; item 3 ("dsh_get_task / dsh_wait_task") is
 * implemented as two separate tools, which is why there are seven.
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
import {COMPLETE_DELIVERY_DEFAULTS} from './delivery-preset.js';

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
  const code = error instanceof BridgeError ? error.code : 'internal_error';
  const message = error instanceof Error ? error.message : String(error);
  return reply(`REFUSED [${code}]: ${message}`, {ok: false, code, error: message, refused: true}, true);
}

const READ_ONLY = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false} as const;
const WRITES_MAYBE = {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true} as const;
const DESTRUCTIVE = {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false} as const;

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
    deliveryPresets: {complete: {...COMPLETE_DELIVERY_DEFAULTS, requires: ['verificationCommand', 'protectedVerificationFiles']}, legacyUnchanged: true},
    workspaceBounds: {
      allowedRoots: facts.allowedRoots,
      dataRoot: facts.dataRoot,
      enforcement: 'realpath + path.relative containment against the allowed roots; not a string prefix test',
      sandboxMode: 'workspace-write (pinned per task in the generated overlay)',
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
      restartRecovery: false,
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
      mcpTools: 8,
      note: 'This runtime loads the SDK base rows, not desktop plugins; desktop plugins/skills are NOT inherited. Native skill tooling IS available to delegated tasks. PTC (run_code presentation) is only ever selected explicitly per submit, never automatically. mcpTools counts this MCP surface, NOT the runtime tool count.',
    },
    persistentRuns: previousRunDirs(),
    liveTasks: manager.listTasks(),
    modelReachability: 'NOT tested by this call: dsh_get_capabilities starts no model request, so service reachability is not claimed.',
    observability: {
      toolCounts: 'bridgeObserved.toolCallsTotal is the true count of tool invocation START events in that stage, independent of the retained-evidence cap. toolCallsRetained is how many observations were kept (max 60), toolCallsShown is what this reply displays, and toolCallsTaskTotal is the sum over all stages.',
      usage: 'bridgeObserved.usage is the compatibility field: the LAST raw usage event only. bridgeObserved.usageAccounting.stage / .task are explicit sums; a resent event with the same message id replaces its earlier record, and task never double-counts continuation stages; a missing counter is null, not 0; totalTokens is only the SDK-reported total, while componentSumTokens is an explicitly non-total arithmetic sum of aliases. cost, if the SDK reports it, is an SDK usage-event value and never a provider invoice.',
      verification: 'bridgeObserved.verification.status says whether the bridge actually ran its command, how many attempts, the exit code/error and the not-run reason. Only a normally completed turn is eligible; a cancel during execution is cancelled-during-run, not a pass. A passed command is not product acceptance.',
      checkpoint: 'checkpoint.json and checkpoints/stage-N.json are written atomically on normal end, cancel, timeout, error, runtime exit and shutdown. They are machine-generated handoff evidence, not a model conclusion and not SDK cross-process resume.',
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
        verificationTimeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
        protectedVerificationFiles: z.array(z.string().min(1).max(4096)).max(256).optional().describe('Existing acceptance files, including checker dependencies and fixtures. Bridge pins real paths and SHA-256 before the model starts and checks before/after verification.'),
        autoRepair: z.object({
          enabled: z.boolean().optional(), maxAttempts: z.number().int().min(1).max(10).optional(),
          noProgressLimit: z.number().int().min(1).max(10).optional(),
          totalBudgetMs: z.number().int().min(1000).max(86_400_000).optional(),
        }).optional().describe('Opt-in same-session repair on failed host verification. Requires protected acceptance files. Stops on success, unchanged failures, limits, permission errors or cancellation.'),
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
        return failure(error);
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
        return failure(error);
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
        return failure(error);
      }
    },
  );

  server.registerTool('dsh_export_delivery', {
    title: 'Export the recorded final delivery bundle',
    description: 'Copies the final host-generated delivery index, selected source snapshot and evidence to a new directory inside allowed workspace roots. Validates recorded hashes; never reruns acceptance or starts a model request.',
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
