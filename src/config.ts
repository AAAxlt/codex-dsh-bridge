/**
 * Static configuration, runtime facts, route inspection and workspace boundary guard.
 *
 * Design rule: every executable path and every workspace boundary comes from HERE,
 * never from MCP tool parameters. Tool parameters only ever name a workspace directory,
 * and that directory is validated against ALLOWED_ROOTS via realpath.
 */
import {existsSync, readFileSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const BRIDGE_SERVER_NAME = 'codex-dsh-bridge';
export const BRIDGE_VERSION = '1.0.4';

/** Route pinned by the prompt and re-verified against the live desktop profile patch. */
const ROUTE_ID = process.env['DSH_BRIDGE_PROVIDER'] ?? 'opencode-go';
if (ROUTE_ID !== 'opencode-go' && ROUTE_ID !== 'commandcode-goat') {
  throw new Error('Unsupported DSH_BRIDGE_PROVIDER: ' + ROUTE_ID);
}
const COMMANDCODE_ROUTE = ROUTE_ID === 'commandcode-goat';
export const PROVIDER_ID = ROUTE_ID;
export const MODEL_ID = COMMANDCODE_ROUTE ? 'deepseek/deepseek-v4.1-flash' : 'deepseek-flash';
export const PROVIDER_API = 'openai-completions';
export const PROVIDER_BASE_URL = COMMANDCODE_ROUTE ? 'https://api.commandcode.ai/provider/v1' : 'https://opencode.ai/zen/go/v1';
export const API_KEY_ENV = COMMANDCODE_ROUTE ? 'COMMANDCODE_API_KEY' : 'OPENCODE_GO_API_KEY';
export const PROVIDER_HEADER_NAME = COMMANDCODE_ROUTE ? '' : 'x-opencode-session';
export const PROVIDER_HEADER_VALUE = COMMANDCODE_ROUTE ? '' : 'zcode-opencode-go';

export const REASONING_EFFORTS = {off: COMMANDCODE_ROUTE ? 'low' : 'none', low: 'low', medium: 'medium', high: 'high'} as const;
export type ReasoningEffort = keyof typeof REASONING_EFFORTS | 'none';
export const DEFAULT_REASONING_EFFORT = 'medium' as const;
export interface ReasoningPolicy {
  requested: ReasoningEffort;
  effective: keyof typeof REASONING_EFFORTS;
  sdkValue: string;
  adjusted: boolean;
  reason: string | null;
}
/** Pinned route correction before any SDK process or model request. */
export function resolveReasoningEffort(requested: ReasoningEffort = DEFAULT_REASONING_EFFORT): ReasoningPolicy {
  if (!['none', 'off', 'low', 'medium', 'high'].includes(requested)) throw new Error('Unsupported reasoning effort: ' + String(requested));
  const normalized = requested === 'none' ? 'off' : requested;
  const adjusted = COMMANDCODE_ROUTE && normalized === 'off';
  const effective = adjusted ? 'low' : normalized;
  return {requested, effective, sdkValue: REASONING_EFFORTS[effective], adjusted,
    reason: adjusted ? 'commandcode-goat DeepSeek Flash does not support none; using low on the same provider/model' : null};
}

/** SDK JSON-RPC handlers this bridge is allowed to assume. Verified locally, not guessed. */
export const SDK_METHODS = ['initialize', 'session/prompt', 'shutdown'] as const;

/**
 * Bridge-owned timeout knobs are environment-only on purpose: they are never accepted as a
 * tool parameter, so a caller cannot shrink or stretch the bridge's own safety limits.
 */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

const WAIT_TIMEOUT_MS = envInt('DSH_BRIDGE_WAIT_MS', 30_000, 1_000, 600_000);
const WAIT_TIMEOUT_MAX_MS = envInt('DSH_BRIDGE_WAIT_MAX_MS', 120_000, 1_000, 600_000);

export const LIMITS = {
  submitTimeoutMs: envInt('DSH_BRIDGE_SUBMIT_TIMEOUT_MS', 120_000, 1_000, 600_000),
  promptAckTimeoutMs: envInt('DSH_BRIDGE_PROMPT_ACK_TIMEOUT_MS', 60_000, 1_000, 600_000),
  waitTimeoutMs: WAIT_TIMEOUT_MS,
  waitTimeoutMaxMs: WAIT_TIMEOUT_MAX_MS,
  // Alignment between the two sides of one call. This bridge may block a wait for up to
  // waitTimeoutMaxMs, but an MCP client aborts a request after its OWN per-request timeout, whose
  // SDK default is 60s. A client that leaves that default in place dies with "Request timed out"
  // on any wait longer than a minute (this is exactly how linux-05 lost its verdict), so the floor
  // it must use is published here and in dsh_get_capabilities instead of being left to chance.
  clientRequestTimeoutFloorMs: WAIT_TIMEOUT_MAX_MS + 5_000,
  shutdownGraceMs: 15_000,
  // Bridge-owned stop ladder. Environment-only, never a tool parameter, so a caller cannot
  // shorten the grace given to a runtime that is still shutting down.
  stopShutdownTimeoutMs: envInt('DSH_BRIDGE_STOP_RPC_TIMEOUT_MS', 10_000, 100, 120_000),
  stopGraceMs: envInt('DSH_BRIDGE_STOP_GRACE_MS', 5_000, 100, 120_000),
  maxTokensDefault: 16_384,
  stageBudgetMsDefault: 300_000,
  maxTokensMax: 32_768,
  modelReportMaxChars: 8_000,
  toolEvidenceMax: 60,
  toolPreviewMaxChars: 400,
  fileChangeMax: 200,
} as const;

function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Which runtime this bridge delegates to. On Windows that is the community DSH Desktop app;
 * on Linux there is no desktop app, so it is the standalone SDK runtime root. Both are
 * overridable, and DSH_BRIDGE_RUNTIME_ROOT is the platform-neutral name for it.
 */
export const IS_WINDOWS = process.platform === 'win32';

export const COMMUNITY_APP_ROOT =
  envValue('DSH_BRIDGE_RUNTIME_ROOT') ??
  envValue('DSH_BRIDGE_APP_ROOT') ??
  (IS_WINDOWS
    ? 'D:\\ds-harness-desktop\\DSH Desktop\\resources\\app'
    : path.join(os.homedir(), 'dsh-runtime'));
export const COMMUNITY_APP_PACKAGE = path.join(COMMUNITY_APP_ROOT, 'package.json');
export const DSH_PACKAGE_JSON = path.join(
  COMMUNITY_APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json',
);
export const CLI_ENTRY_DEFAULT = path.join(
  COMMUNITY_APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
);
/** Test seam: lets failure tests drive the bridge with a scripted runtime instead of a real model. */
export const CLI_ENTRY = envValue('DSH_BRIDGE_CLI_ENTRY') ?? CLI_ENTRY_DEFAULT;
export const CLI_ENTRY_OVERRIDDEN = CLI_ENTRY !== CLI_ENTRY_DEFAULT;

export type CliEntryKind = 'real-dsh' | 'test-double' | 'unknown';

export interface CliEntryIdentity {
  kind: CliEntryKind;
  path: string;
  exists: boolean;
  packageName: string | null;
  packageVersion: string | null;
  reason: string;
}

/**
 * Positive identification of WHAT the configured CLI entry is.
 *
 * The bridge must be able to tell a real DSH runtime entry from a scripted test double without
 * relying on string equality with the platform default: on Linux the real entry is a different
 * path than on Windows, so a same-path check would misreport a genuine runtime as an override
 * (and a same-path check would happily accept any binary dropped on the Windows default path).
 * The test-double rule is deliberately narrow - a fixtures directory, or a fake/fixture/mock
 * file name - so anything unrecognised is reported as 'unknown' rather than trusted as real.
 */
export function identifyCliEntry(entry: string = CLI_ENTRY): CliEntryIdentity {
  const base: CliEntryIdentity = {
    kind: 'unknown', path: entry, exists: existsSync(entry),
    packageName: null, packageVersion: null, reason: '',
  };
  const normalised = entry.split(path.sep).join('/');
  if (/(^|\/)(fixtures?|__fixtures__)\//i.test(normalised) ||
      /(^|[.-])(fake|fixture|mock|stub|scripted)[.-]/i.test(path.basename(entry))) {
    return {...base, kind: 'test-double', reason: 'entry names a scripted test double, not a DSH runtime'};
  }
  let dir = path.dirname(path.resolve(entry));
  for (let depth = 0; depth < 5; depth += 1) {
    const manifest = readJson(path.join(dir, 'package.json'));
    const name = typeof manifest?.['name'] === 'string' ? (manifest['name'] as string) : null;
    if (name) {
      const version = typeof manifest?.['version'] === 'string' ? (manifest['version'] as string) : null;
      if (name === '@deepseek-ai/dsh') {
        return {...base, kind: 'real-dsh', packageName: name, packageVersion: version,
          reason: 'entry resolves inside the @deepseek-ai/dsh package'};
      }
      return {...base, kind: 'unknown', packageName: name, packageVersion: version,
        reason: `entry resolves inside package '${name}', which is not @deepseek-ai/dsh`};
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {...base, reason: 'no package.json found above the entry; cannot prove it is a DSH runtime'};
}

export const CLI_ENTRY_IDENTITY: CliEntryIdentity = identifyCliEntry();

/** True only when the entry is positively identified as a real DSH runtime. */
export const CLI_ENTRY_IS_REAL = CLI_ENTRY_IDENTITY.kind === 'real-dsh';

export const DATA_ROOT =
  envValue('DSH_BRIDGE_DATA_ROOT') ??
  (IS_WINDOWS ? 'D:\\AGENTS\\temp\\codex-dsh-bridge' : path.join(os.homedir(), '.codex-dsh-bridge'));

/**
 * Workspace boundary. The separator is platform-native: ';' on Windows, ':' on POSIX (a POSIX
 * value is additionally split on ';' so a Windows-style list still parses instead of silently
 * collapsing into one unusable root).
 */
const ALLOWED_ROOTS_DEFAULT = IS_WINDOWS
  ? 'D:\\AGENTS\\workspaces;D:\\AGENTS\\temp'
  : path.join(os.homedir(), 'projects');

export const ALLOWED_ROOTS: readonly string[] = (
  envValue('DSH_BRIDGE_ALLOWED_ROOTS') ?? ALLOWED_ROOTS_DEFAULT
).split(IS_WINDOWS ? /;/ : /[;:]/).map((s) => s.trim()).filter((s) => s.length > 0);

export const MAX_CONCURRENT_TASKS = Number(envValue('DSH_BRIDGE_MAX_TASKS') ?? '1');

/**
 * Proxy policy is EXPLICIT. 'inherit' (default) keeps whatever the parent process had;
 * 'direct' strips proxy variables for the DSH child only. Never a silent global strip.
 */
export const PROXY_MODE: 'inherit' | 'direct' =
  envValue('DSH_BRIDGE_PROXY_MODE') === 'direct' ? 'direct' : 'inherit';

/**
 * Windows-only source of truth for the pinned route: the live DSH Desktop profile patch.
 * There is no desktop profile on Linux, so the default is empty there and the route check
 * reports itself unavailable instead of pretending the route was re-verified.
 */
export const DESKTOP_PROFILE_PATCH =
  envValue('DSH_BRIDGE_DESKTOP_PROFILE_PATCH') ??
  (IS_WINDOWS ? 'D:\\AGENTS\\migration-20261011\\data\\.dsh\\profiles\\desktop\\cordis.patch.yml' : '');

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];

/* ------------------------------------------------------------------ versions */

export interface PackageIdentity {
  name: string | null;
  version: string | null;
}

export interface RuntimeFacts {
  nodeExecutable: string;
  nodeVersion: string;
  appRoot: string;
  appPackageJson: string;
  appPackage: PackageIdentity;
  dshPackageVersion: string | null;
  cliEntry: string;
  cliEntryDefault: string;
  cliEntryExists: boolean;
  cliEntryOverridden: boolean;
  cliEntryKind: CliEntryKind;
  cliEntryIsReal: boolean;
  cliEntryReason: string;
  cliEntryPackage: {name: string | null; version: string | null};
  dataRoot: string;
  allowedRoots: string[];
  maxConcurrentTasks: number;
  proxyMode: 'inherit' | 'direct';
  proxyVariablesPresent: string[];
  sdkMethods: string[];
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Read-only. Starts no process and contacts no network. */
export function readRuntimeFacts(): RuntimeFacts {
  const app = readJson(COMMUNITY_APP_PACKAGE);
  const dsh = readJson(DSH_PACKAGE_JSON);
  return {
    nodeExecutable: process.execPath,
    nodeVersion: process.version,
    appRoot: COMMUNITY_APP_ROOT,
    appPackageJson: COMMUNITY_APP_PACKAGE,
    appPackage: {name: str(app?.['name']), version: str(app?.['version'])},
    dshPackageVersion: str(dsh?.['version']),
    cliEntry: CLI_ENTRY,
    cliEntryDefault: CLI_ENTRY_DEFAULT,
    cliEntryExists: existsSync(CLI_ENTRY),
    cliEntryOverridden: CLI_ENTRY_OVERRIDDEN,
    cliEntryKind: CLI_ENTRY_IDENTITY.kind,
    cliEntryIsReal: CLI_ENTRY_IS_REAL,
    cliEntryReason: CLI_ENTRY_IDENTITY.reason,
    cliEntryPackage: {name: CLI_ENTRY_IDENTITY.packageName, version: CLI_ENTRY_IDENTITY.packageVersion},
    dataRoot: DATA_ROOT,
    allowedRoots: [...ALLOWED_ROOTS],
    maxConcurrentTasks: MAX_CONCURRENT_TASKS,
    proxyMode: PROXY_MODE,
    proxyVariablesPresent: PROXY_VARS.filter((v) => envValue(v) !== undefined),
    sdkMethods: [...SDK_METHODS],
  };
}

/* ------------------------------------------------------------------ desktop route */

export interface RouteFacts {
  api: string | null;
  baseURL: string | null;
  apiKeyEnv: string | null;
  sessionHeader: string | null;
  models: string[];
}

export interface RouteInspection {
  available: boolean;
  path: string;
  route: RouteFacts | null;
  matchesBridgeConstants: boolean;
  drift: string[];
  error: string | null;
}

/**
 * Reads ONLY the non-secret route fields out of the live desktop profile patch.
 * Never touches `.credentials.yaml`; an env-var NAME is reported, never a value.
 */
export function inspectDesktopRoute(patchPath: string = DESKTOP_PROFILE_PATCH): RouteInspection {
  const base: RouteInspection = {
    available: false, path: patchPath, route: null, matchesBridgeConstants: false, drift: [], error: null,
  };
  if (patchPath.length === 0) {
    return {...base, error: 'no desktop profile patch on this platform: the route is pinned only by the generated per-task overlay, so it was NOT re-verified against a user profile'};
  }
  let text: string;
  try {
    text = readFileSync(patchPath, 'utf8');
  } catch (error) {
    return {...base, error: `profile patch not readable: ${(error as Error).message}`};
  }
  const lines = text.split(/\r?\n/);
  const anchor = lines.findIndex((l) => new RegExp(`^\\s*${PROVIDER_ID}\\s*:\\s*$`).test(l));
  if (anchor === -1) {
    return {...base, error: `provider '${PROVIDER_ID}' not found in profile patch`};
  }
  const anchorIndent = lines[anchor]!.length - lines[anchor]!.trimStart().length;
  const route: RouteFacts = {api: null, baseURL: null, apiKeyEnv: null, sessionHeader: null, models: []};
  let inModels = false;
  let modelsIndent = Number.POSITIVE_INFINITY;
  for (let i = anchor + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= anchorIndent) break;
    const trimmed = line.trim();
    const keyed = /^([A-Za-z][\w.-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (keyed && !inModels) {
      const [, key, value] = keyed;
      const clean = (value ?? '').replace(/#.*$/, '').trim();
      if (key === 'api') route.api = clean;
      else if (key === 'baseURL') route.baseURL = clean;
      else if (key === 'apiKeyEnv') route.apiKeyEnv = clean;
      else if (key === 'headers') route.sessionHeader = route.sessionHeader ?? '';
      else if (key === 'models') { inModels = true; modelsIndent = indent; }
      continue;
    }
    if (inModels) {
      if (indent < modelsIndent) { inModels = false; i--; continue; }
      const idMatch = /^\s*-\s*id\s*:\s*(\S+)/.exec(line);
      if (idMatch) route.models.push(idMatch[1]!);
      const headerMatch = new RegExp(`^\\s*${PROVIDER_HEADER_NAME}\\s*:\\s*(\\S+)`).exec(line);
      if (headerMatch) route.sessionHeader = `${PROVIDER_HEADER_NAME}: ${headerMatch[1]}`;
    }
    const headerMatch = new RegExp(`^\\s*${PROVIDER_HEADER_NAME}\\s*:\\s*(\\S+)`).exec(line);
    if (headerMatch) route.sessionHeader = `${PROVIDER_HEADER_NAME}: ${headerMatch[1]}`;
  }
  const drift: string[] = [];
  if (route.api !== PROVIDER_API) drift.push(`api: profile='${route.api}' bridge='${PROVIDER_API}'`);
  if (route.baseURL !== PROVIDER_BASE_URL) drift.push(`baseURL: profile='${route.baseURL}' bridge='${PROVIDER_BASE_URL}'`);
  if (route.apiKeyEnv !== API_KEY_ENV) drift.push(`apiKeyEnv: profile='${route.apiKeyEnv}' bridge='${API_KEY_ENV}'`);
  if (!route.models.includes(MODEL_ID)) drift.push(`model '${MODEL_ID}' not listed; profile has [${route.models.join(', ')}]`);
  return {...base, available: true, route, matchesBridgeConstants: drift.length === 0, drift};
}

/* ------------------------------------------------------------------ credential */

export type CredentialSource = 'process-env' | 'user-env' | 'absent';

export interface CredentialDescription {
  envVarName: string;
  present: boolean;
  source: CredentialSource;
  length: number;
  error: string | null;
}

let credentialCache: {value: string; source: CredentialSource} | null | undefined;

let userEnvProbeError: string | null = null;

/**
 * Last-resort fallback for hosts that launch the bridge without the user environment.
 * Deliberately does NOT fall back to writing the secret to a temporary file: a file-backed
 * read would put a live credential on disk, which this bridge refuses to do.
 */
function readUserScopeEnvVar(name: string): string | null {
  if (!IS_WINDOWS) {
    userEnvProbeError =
      'there is no registry fallback on this platform; export ' + name +
      ' in the environment that launches this server (wsl.exe forwards an exported variable into WSL)';
    return null;
  }
  try {
    const out = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8', windowsHide: true, timeout: 5_000,
    });
    if (out.error) {
      userEnvProbeError = `registry fallback unavailable: ${(out.error as NodeJS.ErrnoException).code ?? 'error'} ${out.error.message}`;
      return null;
    }
    if (out.status !== 0 || typeof out.stdout !== 'string') {
      userEnvProbeError = `registry fallback found no value (reg.exe exit ${out.status})`;
      return null;
    }
    const match = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(out.stdout);
    if (!match) {
      userEnvProbeError = 'registry fallback could not parse reg.exe output';
      return null;
    }
    userEnvProbeError = null;
    return match[1]!;
  } catch (error) {
    userEnvProbeError = `registry fallback threw: ${error instanceof Error ? error.message : String(error)}`;
    return null;
  }
}

function loadCredential(): {value: string; source: CredentialSource} | null {
  if (credentialCache !== undefined) return credentialCache;
  const fromProcess = envValue(API_KEY_ENV);
  if (fromProcess) { credentialCache = {value: fromProcess, source: 'process-env'}; return credentialCache; }
  const fromUser = readUserScopeEnvVar(API_KEY_ENV);
  credentialCache = fromUser ? {value: fromUser, source: 'user-env'} : null;
  return credentialCache;
}

/** Internal only. The value is injected into the DSH child environment and never logged. */
export function credentialValue(): string | null {
  return loadCredential()?.value ?? null;
}

/** Safe to return over MCP: existence, provenance and length. Never the value. */
export function describeCredential(): CredentialDescription {
  const found = loadCredential();
  return {
    envVarName: API_KEY_ENV,
    present: found !== null,
    source: found?.source ?? 'absent',
    length: found?.value.length ?? 0,
    error: found
      ? null
      : `${API_KEY_ENV} is not in this process's environment and the HKCU\\Environment fallback did not yield it (${userEnvProbeError ?? 'no value'}). The MCP client must launch this server with the user environment, or set ${API_KEY_ENV} for the server process.`,
  };
}

/* ------------------------------------------------------------------ workspace guard */

export type PathCheck = {ok: true; realPath: string} | {ok: false; reason: string};

function canonical(p: string): string {
  return realpathSync.native(p);
}

/** Boundary test on canonical paths. Not a string-prefix test. */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function checkWorkspace(candidate: unknown): PathCheck {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return {ok: false, reason: 'workspace must be a non-empty absolute path string'};
  }
  const raw = candidate.trim();
  if (!path.isAbsolute(raw)) {
    return {ok: false, reason: `workspace must be absolute, got '${raw}'`};
  }
  if (path.parse(raw).root === raw) {
    return {ok: false, reason: 'a filesystem root cannot be used as a workspace'};
  }
  let real: string;
  try {
    real = canonical(raw);
  } catch {
    return {ok: false, reason: `workspace does not exist or is not accessible: ${raw}`};
  }
  let stat;
  try {
    stat = statSync(real);
  } catch {
    return {ok: false, reason: `workspace is not accessible after realpath: ${real}`};
  }
  if (!stat.isDirectory()) return {ok: false, reason: `workspace is not a directory: ${real}`};
  const roots: string[] = [];
  for (const root of ALLOWED_ROOTS) {
    try { roots.push(canonical(root)); } catch { /* non-existent configured root: skip */ }
  }
  if (roots.length === 0) {
    return {ok: false, reason: `none of the configured allowed roots exist: ${ALLOWED_ROOTS.join(', ')}`};
  }
  for (const root of roots) {
    if (isInside(root, real)) return {ok: true, realPath: real};
  }
  return {
    ok: false,
    reason: `workspace is outside the allowed roots. allowed=[${roots.join(', ')}] requested=${real}`,
  };
}

/* ------------------------------------------------------------------ SDK method probe */

export interface MethodProbe {
  method: string;
  found: boolean;
  files: string[];
}

export interface ProbeResult {
  available: boolean;
  scannedFiles: number;
  scannedBytes: number;
  truncated: boolean;
  scannedRoots: string[];
  methods: MethodProbe[];
  error: string | null;
}

/**
 * Candidate JSON-RPC methods, including the ones this bridge deliberately does NOT claim.
 * `session/cancel` and `session/resume` are probed precisely so a missing capability is
 * reported as missing instead of being invented.
 */
export const PROBED_METHODS: readonly string[] = [
  'initialize', 'session/prompt', 'shutdown',
  'session/cancel', 'session/resume', 'session/list', 'session/load',
];

const PROBE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json']);
const PROBE_LIMITS = {maxFiles: 500, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 48 * 1024 * 1024} as const;

/**
 * The JSON-RPC surface is registered by the pinned runtime's own `dsh-sdk-*` packages, not by the
 * tiny launcher in `@deepseek-ai/dsh/lib`. Scanning the launcher directory finds nothing and would
 * make the probe lie by omission, so the scan roots are the sibling `dsh-sdk-*` packages.
 */
function probeRoots(): string[] {
  const scopeDir = path.resolve(path.dirname(CLI_ENTRY), '..', '..');
  let names: string[];
  try {
    names = readdirSync(scopeDir, {withFileTypes: true}).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const sdkPackages = names.filter((name) => name.startsWith('dsh-sdk-')).sort();
  // Fall back to the launcher directory only if the expected packages are absent.
  if (sdkPackages.length === 0) return [path.dirname(CLI_ENTRY)];
  return sdkPackages.map((name) => path.join(scopeDir, name));
}

/** Read-only scan of the pinned community runtime for the string literals it actually registers. */
export function probeSdkMethods(): ProbeResult {
  const roots = probeRoots();
  const methods: MethodProbe[] = PROBED_METHODS.map((method) => ({method, found: false, files: []}));
  const result: ProbeResult = {
    available: false, scannedFiles: 0, scannedBytes: 0, truncated: false, methods,
    scannedRoots: roots.map((root) => path.relative(COMMUNITY_APP_ROOT, root).split(path.sep).join('/')),
    error: roots.length === 0 ? `no scan root found next to ${CLI_ENTRY}` : null,
  };
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    if (result.scannedFiles >= PROBE_LIMITS.maxFiles || result.scannedBytes >= PROBE_LIMITS.maxTotalBytes) {
      result.truncated = true;
      break;
    }
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      result.error = result.error ?? `cannot read ${dir}: ${(error as Error).message}`;
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile() || !PROBE_EXTENSIONS.has(path.extname(entry.name))) continue;
      let text: string;
      try {
        const stat = statSync(full);
        if (stat.size > PROBE_LIMITS.maxFileBytes) { result.truncated = true; continue; }
        text = readFileSync(full, 'utf8');
      } catch { continue; }
      result.scannedFiles++;
      result.scannedBytes += text.length;
      for (const probe of methods) {
        if (probe.found || probe.files.length >= 3) continue;
        if (text.includes(`"${probe.method}"`) || text.includes(`'${probe.method}'`)) {
          probe.found = true;
          probe.files.push(path.relative(COMMUNITY_APP_ROOT, full).split(path.sep).join('/'));
        }
      }
    }
  }
  result.available = result.scannedFiles > 0;
  return result;
}

/* ------------------------------------------------------------------ child environment */

/**
 * Builds the DSH child environment. The credential value is placed in the child's env only;
 * it is never written to disk, never passed as an argv element and never logged.
 */
export function buildChildEnv(homeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env, DSH_HOME: homeDir};
  if (PROXY_MODE === 'direct') {
    for (const name of PROXY_VARS) delete env[name];
  }
  const credential = credentialValue();
  if (credential) env[API_KEY_ENV] = credential;
  return env;
}
