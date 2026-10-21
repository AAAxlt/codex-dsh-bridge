/**
 * Cheap real-environment probe: starts the bridge exactly as Codex would, with NO CLI override,
 * and asks only for dsh_get_capabilities. That tool starts no model request, so this costs nothing
 * while still proving the real credential path and the real community-edition paths resolve.
 *
 *   node scripts/real-capabilities.mjs [outFile]
 */
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const OUT = process.argv[2] ?? null;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, 'dist', 'src', 'main.js')],
  env: {...process.env},
  cwd: REPO_ROOT,
  stderr: 'pipe',
});
let stderrText = '';
transport.stderr?.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });

const client = new Client({name: 'real-capabilities-probe', version: '1.0.0'}, {capabilities: {}});
await client.connect(transport);

const listed = await client.listTools();
const reply = await client.callTool({name: 'dsh_get_capabilities', arguments: {}});
const blocks = (reply.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '');
const fenced = blocks.find((b) => b.startsWith('```json'));
const payload = JSON.parse(fenced.replace(/^```json\n/, '').replace(/\n```$/, ''));

const summary = {
  tools: listed.tools.map((t) => t.name),
  cliEntry: payload.communityEdition.cliEntry,
  cliEntryExists: payload.communityEdition.cliEntryExists,
  cliEntryOverridden: payload.communityEdition.cliEntryOverridden,
  appPackage: payload.communityEdition.appPackage,
  dshPackageVersion: payload.communityEdition.dshPackageVersion,
  provider: payload.modelRoute.provider,
  model: payload.modelRoute.model,
  desktopProfileMatches: payload.modelRoute.desktopProfileCheck.matchesBridgeConstants,
  desktopProfileDrift: payload.modelRoute.desktopProfileCheck.drift,
  credential: payload.credential,
  probedMethodsFound: payload.sdkProtocol.methodProbe.methods.filter((m) => m.found).map((m) => m.method),
  probedMethodsAbsent: payload.sdkProtocol.methodProbe.methods.filter((m) => !m.found).map((m) => m.method),
  scanTruncated: payload.sdkProtocol.methodProbe.scanTruncated,
  allowedRoots: payload.workspaceBounds.allowedRoots,
  proxyMode: payload.proxyPolicy.mode,
  restartRecovery: payload.capabilities.restartRecovery,
  modelReachability: payload.modelReachability,
  valueNeverReturned: payload.credential.valueNeverReturned,
  leakedValue: 'value' in payload.credential,
  stderrHead: stderrText.slice(0, 500),
};

console.log(JSON.stringify(summary, null, 2));
if (OUT) writeFileSync(OUT, JSON.stringify({summary, full: payload}, null, 2), 'utf8');
await client.close();
