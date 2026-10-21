/**
 * Real-model capability check for the EXECUTION SANDBOX.
 *
 *   node scripts/sandbox-capability.mjs [--run-id <id>]
 *
 * It spends exactly one model request. Nothing here is taken on the model's word: the report
 * is built from what the BRIDGE observed itself - tool call counts, per-call isError flags,
 * the workspace file diff, and the exit code of the verification command the bridge runs in
 * its own process after the model stops.
 *
 * The point is to answer one question with evidence: can a delegated task on THIS platform
 * actually execute a shell command, run a ripgrep search, write a file and run a test inside
 * the configured sandbox? An SDK handshake, or a plain Node child process, does NOT answer it.
 */
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const RUN_ID = arg('run-id', `sandbox-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_MAIN = path.join(REPO_ROOT, 'dist', 'src', 'main.js');
const ROOT = process.env['DSH_BRIDGE_E2E_ROOT'] ??
  (process.platform === 'win32' ? 'D:\\AGENTS\\temp' : path.join(os.homedir(), 'projects', '_e2e'));
const WORKSPACE = path.join(ROOT, 'sandbox-capability', RUN_ID);
const EVIDENCE = path.join(ROOT, 'sandbox-capability', `${RUN_ID}-evidence`);

mkdirSync(WORKSPACE, {recursive: true});
mkdirSync(EVIDENCE, {recursive: true});
const TIMELINE = path.join(EVIDENCE, 'timeline.jsonl');

function stamp(kind, detail = {}) {
  const entry = {at: new Date().toISOString(), kind, ...detail};
  appendFileSync(TIMELINE, `${JSON.stringify(entry)}\n`);
  console.log(`[${entry.at}] ${kind} ${JSON.stringify(detail).slice(0, 500)}`);
  return entry;
}

function save(name, value) {
  writeFileSync(path.join(EVIDENCE, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
}

function textOf(result) {
  return (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
}

function jsonOf(result) {
  const blocks = (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '');
  const fenced = blocks.find((b) => b.startsWith('```json'));
  if (!fenced) throw new Error(`no JSON payload: ${blocks.join(' | ').slice(0, 500)}`);
  return JSON.parse(fenced.replace(/^```json\n/, '').replace(/\n```$/, ''));
}

let client;
let stderrText = '';

async function call(name, args) {
  const result = await client.callTool({name, arguments: args});
  if (result.isError === true) throw new Error(`${name} failed: ${textOf(result)}`);
  return result;
}

const GOAL = [
  'Prove the execution sandbox on this machine actually works, by running four things and',
  'reporting the real result of each. Work only inside the current working directory.',
  '',
  '1. SHELL: use your shell tool to create shell-proof.txt containing the single line',
  '   sandbox-shell-ok',
  '2. SEARCH: use your ripgrep/glob search tool to search this working directory for the text',
  '   sandbox-shell-ok and report which file matched',
  '3. WRITE: create probe.test.mjs, a node:test file with at least three assertions (one of',
  '   them asserting that 1 + 1 === 2)',
  '4. TEST: run `node --test probe.test.mjs` with your shell tool and report its exit code',
  '',
  'If any step fails, say exactly which step failed and paste the real error text. Do not',
  'claim a step succeeded unless you observed it succeed.',
].join('\n');

(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE_MAIN],
    env: {...process.env, DSH_BRIDGE_ALLOWED_ROOTS: ROOT},
    cwd: WORKSPACE,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });

  client = new Client({name: 'sandbox-capability-check', version: '1.0.0'}, {capabilities: {}});
  await client.connect(transport);
  stamp('connected', {bridge: BRIDGE_MAIN, workspace: WORKSPACE, runId: RUN_ID, platform: process.platform, node: process.version});

  const caps = jsonOf(await call('dsh_get_capabilities', {}));
  save('capabilities.json', caps);
  stamp('capabilities', {
    cliEntry: caps.communityEdition?.cliEntry,
    cliEntryExists: caps.communityEdition?.cliEntryExists,
    cliEntryKind: caps.communityEdition?.cliEntryKind,
    cliEntryIsReal: caps.communityEdition?.cliEntryIsReal,
    cliEntryPackage: caps.communityEdition?.cliEntryPackage,
    dshPackageVersion: caps.communityEdition?.dshPackageVersion,
    provider: caps.modelRoute?.provider,
    model: caps.modelRoute?.model,
    desktopProfileReadable: caps.modelRoute?.desktopProfileCheck?.readable,
    credentialPresent: caps.credential?.present,
    credentialSource: caps.credential?.source,
    credentialLength: caps.credential?.length,
    sandboxMode: caps.workspaceBounds?.sandboxMode,
    allowedRoots: caps.workspaceBounds?.allowedRoots,
    methodProbeFound: (caps.sdkProtocol?.methodProbe?.methods ?? []).filter((m) => m.found).map((m) => m.method),
  });

  // Authenticity gate: the entry must be a positively identified @deepseek-ai/dsh package.
  if (caps.communityEdition?.cliEntryKind !== 'real-dsh') {
    throw new Error(`refusing to run: cliEntryKind=${String(caps.communityEdition?.cliEntryKind)} (${String(caps.communityEdition?.cliEntryReason)})`);
  }
  if (caps.credential?.present !== true) {
    throw new Error(`refusing to run: no credential resolved (${String(caps.credential?.error)})`);
  }

  const submitted = jsonOf(await call('dsh_submit_task', {
    workspace: WORKSPACE,
    goal: GOAL,
    constraints: ['Only create files inside the working directory.', 'Do not claim a command succeeded unless you ran it.'],
    acceptance: 'shell-proof.txt and probe.test.mjs exist, and node --test probe.test.mjs exits 0.',
    verificationCommand: [process.execPath, '--test', 'probe.test.mjs'],
    reasoningEffort: 'low',
    maxTokens: 8192,
    budgetMs: 300_000,
  }));
  save('submit.json', submitted);
  stamp('submitted', {taskId: submitted.taskId, sessionId: submitted.sessionId, messageId: submitted.messageId, runtimePid: submitted.runtimePid});

  let outcome = null;
  for (let round = 0; round < 6; round += 1) {
    outcome = jsonOf(await call('dsh_wait_task', {taskId: submitted.taskId, timeoutMs: 120_000}));
    stamp('wait', {round, outcome: outcome.outcome, state: outcome.status?.state, waitedMs: outcome.waitedMs});
    if (outcome.outcome === 'settled') break;
  }

  const result = jsonOf(await call('dsh_get_result', {taskId: submitted.taskId, verbose: true}));
  save('result.json', result);
  const observed = result.bridgeObserved ?? {};
  const summary = {
    runId: RUN_ID,
    platform: process.platform,
    workspace: WORKSPACE,
    evidenceDir: EVIDENCE,
    taskId: submitted.taskId,
    stageState: result.stageState,
    taskState: result.taskState,
    waitOutcome: outcome?.outcome ?? null,
    modelReportChars: result.modelReport?.chars ?? 0,
    toolCallsTotal: observed.toolCallsTotal ?? 0,
    toolCounts: observed.toolCounts ?? {},
    toolErrorCount: observed.toolErrorCount ?? 0,
    filesAdded: observed.filesChanged?.added ?? [],
    filesModified: observed.filesChanged?.modified ?? [],
    verification: {
      argv: observed.verificationCommand?.argv ?? null,
      exitCode: observed.verificationCommand?.exitCode ?? null,
      timedOut: observed.verificationCommand?.timedOut ?? null,
      stdoutTail: observed.verificationCommand?.stdoutTail ?? null,
      stderrTail: observed.verificationCommand?.stderrTail ?? null,
      error: observed.verificationCommand?.error ?? null,
    },
    turnEndReason: observed.turnEndReason?.kind ?? null,
    unresolved: result.unresolved ?? [],
    onDisk: {
      shellProof: existsSync(path.join(WORKSPACE, 'shell-proof.txt'))
        ? readFileSync(path.join(WORKSPACE, 'shell-proof.txt'), 'utf8').slice(0, 200) : null,
      probeTest: existsSync(path.join(WORKSPACE, 'probe.test.mjs')) ? 'present' : null,
    },
  };
  save('summary.json', summary);
  stamp('result', summary);
  stamp('tool-calls', {calls: (observed.toolCalls ?? []).map((c) => ({tool: c.tool, isError: c.isError, out: String(c.outputPreview ?? '').slice(0, 160)}))});

  // Cancel must stop THIS task's runtime and verify the pid is gone.
  const cancelled = jsonOf(await call('dsh_cancel_task', {taskId: submitted.taskId}));
  save('cancel.json', cancelled);
  await new Promise((resolve) => setTimeout(resolve, 500));
  let pidAlive = null;
  if (submitted.runtimePid) {
    try { process.kill(submitted.runtimePid, 0); pidAlive = true; } catch { pidAlive = false; }
  }
  stamp('cancelled', {runtimeStopped: cancelled.runtimeStopped, method: cancelled.method, pid: cancelled.pid, pidStillAlive: pidAlive});

  save('bridge-stderr.txt', stderrText);
  await client.close();

  console.log('\n=== SANDBOX CAPABILITY SUMMARY ===');
  console.log(JSON.stringify({...summary, cancel: {runtimeStopped: cancelled.runtimeStopped, method: cancelled.method, pidStillAlive: pidAlive}}, null, 2));
  console.log(`EVIDENCE: ${EVIDENCE}`);
  const ok = summary.verification.exitCode === 0 && summary.toolErrorCount === 0 && summary.onDisk.shellProof !== null;
  console.log(ok ? 'SANDBOX_CAPABILITY_OK' : 'SANDBOX_CAPABILITY_FAILED');
  process.exitCode = ok ? 0 : 1;
})().catch(async (error) => {
  stamp('fatal', {message: String(error?.message ?? error)});
  save('fatal.txt', String(error?.stack ?? error));
  save('bridge-stderr.txt', stderrText);
  try { await client?.close(); } catch { /* already gone */ }
  console.log('SANDBOX_CAPABILITY_FAILED');
  process.exitCode = 1;
});
