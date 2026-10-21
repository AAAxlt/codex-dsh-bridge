/**
 * Shared test helpers. Test-only; never imported by src/.
 */
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** dist/test -> dist -> repo root */
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const FAKE_RUNTIME = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-runtime.mjs');
export const BRIDGE_MAIN = path.join(REPO_ROOT, 'dist', 'src', 'main.js');

/**
 * Platform-native test root. The same suite has to run on Windows and on Linux, so no drive
 * letter is hard-coded: on POSIX this lives under the OS temp directory.
 */
export const TEST_ROOT = process.platform === 'win32'
  ? 'D:\\AGENTS\\temp\\codex-dsh-bridge-tests'
  : path.join(os.tmpdir(), 'codex-dsh-bridge-tests');
export const SECOND_ROOT = process.platform === 'win32'
  ? 'D:\\AGENTS\\workspaces'
  : path.join(os.tmpdir(), 'codex-dsh-bridge-second-root');
export const TEST_DATA_ROOT = path.join(TEST_ROOT, 'data');

export function makeWorkspace(label: string): string {
  mkdirSync(TEST_ROOT, {recursive: true});
  return mkdtempSync(path.join(TEST_ROOT, `${label}-`));
}

export function cleanupDir(dir: string): void {
  rmSync(dir, {recursive: true, force: true, maxRetries: 3});
}

/**
 * Environment for a bridge that is driven by the scripted runtime instead of the real
 * DSH SDK, so unit and protocol tests never spend a model request.
 */
export function scriptedBridgeEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    DSH_BRIDGE_CLI_ENTRY: FAKE_RUNTIME,
    DSH_BRIDGE_DATA_ROOT: TEST_DATA_ROOT,
    DSH_BRIDGE_ALLOWED_ROOTS: [TEST_ROOT, SECOND_ROOT].join(path.delimiter),
    DSH_BRIDGE_MAX_TASKS: '1',
    DSH_BRIDGE_PROXY_MODE: 'direct',
    // Capability tests must not depend on (or inspect) the user's changing desktop profile.
    DSH_BRIDGE_DESKTOP_PROFILE_PATCH: path.join(TEST_ROOT, 'no-desktop-profile.yml'),
    // Shorten only the bridge's own handshake timeouts so the "runtime never answers" case is
    // testable in seconds instead of two minutes. Not a tool parameter, so this cannot be abused.
    DSH_BRIDGE_SUBMIT_TIMEOUT_MS: '5000',
    DSH_BRIDGE_PROMPT_ACK_TIMEOUT_MS: '5000',
    ...overrides,
  };
}

/** Applies env for in-process tests. Must run before importing src/config.js. */
export function applyScriptedEnv(overrides: Record<string, string> = {}): void {
  for (const [key, value] of Object.entries(scriptedBridgeEnv(overrides))) process.env[key] = value;
}

export interface ConnectedClient {
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}

export async function connectBridge(env: Record<string, string>, cwd: string = REPO_ROOT): Promise<ConnectedClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE_MAIN],
    env,
    cwd,
    stderr: 'pipe',
  });
  let stderrText = '';
  const stream = (transport as unknown as {stderr?: NodeJS.ReadableStream | null}).stderr;
  stream?.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8');
  });
  const client = new Client({name: 'bridge-test-client', version: '1.0.0'}, {capabilities: {}});
  await client.connect(transport);
  return {
    client,
    stderr: () => stderrText,
    close: async () => {
      try {
        await client.close();
      } catch { /* the transport may already be gone */ }
    },
  };
}

export function textOf(result: {content?: Array<{type: string; text?: string}>}): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

/** The second text block of every reply is a fenced JSON payload. */
export function jsonOf<T = Record<string, unknown>>(result: {content?: Array<{type: string; text?: string}>}): T {
  const blocks = (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '');
  const payload = blocks.find((block) => block.startsWith('```json'));
  if (!payload) throw new Error(`no JSON payload in reply: ${blocks.join(' | ').slice(0, 400)}`);
  return JSON.parse(payload.replace(/^```json\n/, '').replace(/\n```$/, '')) as T;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 30_000, stepMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await sleep(stepMs);
  }
}
