// Candidate-local DSH plugin: an SDK JSON-RPC server that mounts a native agent
// preset before the first prompt.
//
// Why this file exists
// --------------------
// The pinned runtime exports `HarnessSdkJsonRpcServer` (module
// `@deepseek-ai/dsh-sdk-jsonrpc-server`) but its `createSession` calls
// `ctx.agents.create({sessionId, meta:{cwd}, agentOptions})` with no `setup`
// callback and no `agentPreset` meta, so the SDK surface can never mount an
// agent preset. This file subclasses that exported class and overrides ONLY
// `createSession`, adding the two native hooks the runtime already documents:
//
//   * `meta.agentPreset`  – the durable creation header the preset projection
//                           reads (`agentPresetProjectionDefinition.init`);
//   * `setup(agentCtx)`   – runs while the agent is still unpublished, and calls
//                           `ctx.agentPresets.mount(agentCtx, presetId)`.
//
// It reuses the upstream `apply` lifecycle pattern exactly: one
// `JsonRpcLineTransport` over the configured streams, the same request
// dispatcher, the same `shutdown` → flush → `rootFiber.dispose()` → exit(0)
// path, and the same effect-owned transport start/close. It does NOT modify the
// upstream module, `node_modules`, or any shared prototype: the upstream class
// is extended, never patched.
//
// The file is loaded by name from the profile overlay the bridge generates. The
// path is a fixed candidate-owned file; no MCP caller can point it elsewhere.
//
// Module resolution: this file lives outside the DSH installation, so bare
// specifiers are resolved through a `createRequire` anchored at the runtime
// entry (`process.argv[1]`, the `@deepseek-ai/dsh` bin the bridge spawns), not
// through this file's own directory. That keeps the adapter working from any
// candidate checkout without copying anything into `node_modules`.

import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {redactLegacyHostVerification} from '../dist/src/prompts.js';

function runtimeAnchor() {
  if (process.argv[1] && process.argv[1].length > 0) return process.argv[1];
  if (process.env['DSH_BRIDGE_CLI_ENTRY']) return process.env['DSH_BRIDGE_CLI_ENTRY'];
  const root = process.env['DSH_BRIDGE_RUNTIME_ROOT'];
  if (root) return path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return path.join(process.cwd(), 'package.json');
}

const require = createRequire(runtimeAnchor());

async function loadUpstream() {
  const serverPath = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-server');
  const protocolPath = require.resolve('@deepseek-ai/dsh-sdk-protocol');
  const schemaPath = require.resolve('@deepseek-ai/schemastery');
  const [server, protocol, schema] = await Promise.all([
    import(pathToFileURL(serverPath).href),
    import(pathToFileURL(protocolPath).href),
    import(pathToFileURL(schemaPath).href),
  ]);
  return {
    HarnessSdkJsonRpcServer: server.HarnessSdkJsonRpcServer,
    JsonRpcLineTransport: protocol.JsonRpcLineTransport,
    Schema: schema.default ?? schema,
  };
}

const {HarnessSdkJsonRpcServer, JsonRpcLineTransport, Schema} = await loadUpstream();

/**
 * Upstream server plus the one native behaviour it lacks: a preset-mounted
 * session. Everything else is inherited unchanged.
 */
export class CandidatePresetSdkServer extends HarnessSdkJsonRpcServer {
  // New per-task SDKs also minimize prompts from a cached older MCP parent.
  // Non-text blocks (including images) pass through unchanged.
  async prompt(params) {
    let redactedBlocks = 0;
    const contentBlocks = params.contentBlocks.map(block => {
      if (block.type !== 'text' || typeof block.text !== 'string') return block;
      const text = redactLegacyHostVerification(block.text);
      if (text === block.text) return block;
      redactedBlocks++;
      return {...block, text};
    });
    this.transport.notify('execution-profile/host-check-boundary', {
      sessionId: String(params.sessionId), redactedBlocks,
      source: 'SDK text minimization before durablePromptContent',
    });
    return super.prompt({...params, contentBlocks});
  }
  /**
   * Create the session with a durable `agentPreset` header and a scoped
   * `setup` that mounts the requested preset while the agent is unpublished.
   * Emits one `execution-profile/preset` notification carrying the preset id
   * the native registry actually bound (and, when readable, the id the agent's
   * live scope resolves back to), so the bridge records runtime evidence rather
   * than restating its own configuration.
   */
  async createSession(sessionId) {
    const presetId = this.options?.presetId;
    if (typeof presetId !== 'string' || presetId.length === 0) {
      throw new Error('candidate SDK server: config.presetId is required');
    }
    let mountedPreset = null;
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: {cwd: this.cwd, agentPreset: presetId},
      setup: async (agentCtx) => {
        const mounted = await this.ctx.agentPresets.mount(agentCtx, presetId);
        mountedPreset = mounted && typeof mounted.id === 'string' ? mounted.id : null;
      },
      agentOptions: {
        provider: this.provider,
        model: this.model,
        ...(this.reasoningEffort === undefined ? {} : {reasoningEffort: this.reasoningEffort}),
        ...(this.maxTokens === undefined ? {} : {maxTokens: this.maxTokens}),
      },
    });
    const rec = {handle};
    this.sessions.set(sessionId, rec);

    let observedPreset = null;
    try {
      observedPreset = this.ctx.agentPresets.composedPreset(handle.agent.ctx) ?? null;
    } catch {
      observedPreset = null;
    }
    try {
      this.transport.notify('execution-profile/preset', {
        sessionId: String(sessionId),
        configuredPreset: presetId,
        mountedPreset,
        observedPreset,
        match: mountedPreset !== null && mountedPreset === observedPreset,
        source: 'ctx.agentPresets.mount + composedPreset readback',
      });
    } catch {
      // A notification failure must not fail session creation; the bridge still
      // holds the mount result through the server's own RPC error semantics.
    }
    return rec;
  }
}

export const name = 'dsh-candidate-preset-sdk-server';

export const inject = ['agents', 'agentPresets'];

export const Config = Schema.object({
  presetId: Schema.string().required(),
  maxTokensAsSuccess: Schema.boolean().default(false),
  // Test seams; production wiring uses process stdin/stdout and process.exit.
  input: Schema.any(),
  output: Schema.any(),
  exit: Schema.any(),
});

/** Same lifecycle as the upstream plugin, over the preset-aware server. */
export function apply(ctx, config) {
  const resolvedConfig = config;
  const rootFiber = ctx.root.fiber;
  /* v8 ignore next -- production stdio wiring; tests inject the runtime hooks */
  const input = resolvedConfig.input ?? process.stdin;
  /* v8 ignore next -- production stdio wiring */
  const output = resolvedConfig.output ?? process.stdout;
  /* v8 ignore next -- production exit wiring */
  const exit = resolvedConfig.exit ?? ((code) => {
    process.exit(code);
  });
  const transport = new JsonRpcLineTransport(input, output);
  const server = new CandidatePresetSdkServer(ctx, transport, {
    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
    presetId: resolvedConfig.presetId,
  });
  let exitTask;
  const disposeAndExit = () => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())]);
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())]);
      exit(0);
    })();
    return exitTask;
  };
  transport.onRequest(async (method, params) => {
    if (method === 'initialize') await ctx.get('loader')?.await();
    const result = await server.handleRequest(method, params);
    if (method === 'shutdown') {
      setImmediate(() => {
        void disposeAndExit();
      });
    }
    return result;
  });
  ctx.effect(() => {
    transport.start();
    return async () => {
      await server.shutdown();
      transport.close();
    };
  }, 'jsonrpc.serve');
}
