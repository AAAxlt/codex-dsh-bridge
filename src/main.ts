#!/usr/bin/env node
/**
 * Entry point. stdout is the MCP wire: every diagnostic goes to stderr.
 *
 *   node dist/main.js            start the stdio MCP server
 *   node dist/main.js --doctor   print a JSON environment report and exit
 *   node dist/main.js --version  print the bridge version and exit
 */
import {BRIDGE_SERVER_NAME, BRIDGE_VERSION, API_KEY_ENV, MODEL_ID, PROVIDER_ID, readRuntimeFacts, checkWorkspace, describeCredential} from './config.js';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {TaskManager, previousRunDirs} from './tasks.js';
import {createServer} from './server.js';

function log(message: string): void {
  process.stderr.write(`[${BRIDGE_SERVER_NAME}] ${message}\n`);
}

function doctor(): number {
  const facts = readRuntimeFacts();
  const report: Record<string, unknown> = {
    ok: true,
    bridge: {name: BRIDGE_SERVER_NAME, version: BRIDGE_VERSION, pid: process.pid, nodeVersion: facts.nodeVersion},
    communityEdition: {
      appRoot: facts.appRoot,
      appPackage: facts.appPackage,
      dshPackageVersion: facts.dshPackageVersion,
      cliEntry: facts.cliEntry,
      cliEntryExists: facts.cliEntryExists,
    },
    route: {provider: PROVIDER_ID, model: MODEL_ID, apiKeyEnv: API_KEY_ENV},
    environment: {
      dataRoot: facts.dataRoot,
      maxConcurrentTasks: facts.maxConcurrentTasks,
      proxyVariablesPresent: facts.proxyVariablesPresent,
    },
    checks: [] as Array<{check: string; pass: boolean; detail: string}>,
    persistentRuns: previousRunDirs(),
  };
  const checks = report.checks as Array<{check: string; pass: boolean; detail: string}>;

  checks.push({
    check: 'community-edition CLI entry exists',
    pass: facts.cliEntryExists,
    detail: facts.cliEntry,
  });
  const roots = facts.allowedRoots;
  const probes = roots.map((root) => ({root, check: checkWorkspace(root)}));
  checks.push({
    check: 'allowed workspace roots resolve and are inside themselves',
    pass: probes.length > 0 && probes.every((p) => p.check.ok),
    detail: probes.map((p) => `${p.root} -> ${p.check.ok ? p.check.realPath : `FAIL: ${p.check.reason}`}`).join('; '),
  });
  const credential = describeCredential();
  checks.push({
    check: `${API_KEY_ENV} resolvable`,
    pass: credential.present,
    detail: credential.present
      ? `present via ${credential.source}, length ${credential.length} (value never printed)`
      : `NOT resolvable from process env or the user environment — model calls will fail (${credential.error ?? 'no key found'})`,
  });

  report.ok = checks.every((c) => c.pass);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--version')) {
    process.stdout.write(`${BRIDGE_VERSION}\n`);
    return;
  }
  if (argv.includes('--doctor')) {
    process.exitCode = doctor();
    return;
  }

  const manager = new TaskManager();
  log(`v${BRIDGE_VERSION} starting, stdio transport, ${previousRunDirs().count} previous run dir(s) on disk`);

  const handle = serveStdio(() => createServer(manager), {
    onerror: (error: unknown) => log(`transport error: ${error instanceof Error ? error.message : String(error)}`),
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`${signal} received; stopping delegated tasks (the user's DSH Desktop is not touched)`);
    try {
      const stopped = await manager.shutdownAll();
      for (const entry of stopped) log(`  ${entry.taskId}: stopped=${entry.stopped} via ${entry.method}`);
    } catch (error) {
      log(`shutdown error: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await handle.close();
    } catch { /* the client may already be gone */ }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection (server kept alive): ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });

  log('ready on stdio');
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
