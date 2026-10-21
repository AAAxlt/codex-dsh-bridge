/**
 * Execution-profile selection and the per-task profile overlay.
 *
 * Two explicit profiles compose a native agent preset into the SDK runtime:
 *
 *   native — the reference `standard` preset shape, model tools presented in
 *            their native schemas, workflow tooling kept.
 *   ptc    — the reference `ptc` preset shape, model tools presented through
 *            `run_code` (`dsh-agent-tool-presentation` mode `ptc`), and the
 *            root workflow tooling disabled because the two presentation
 *            surfaces are mutually exclusive.
 *
 * Omitted (`executionProfile` absent) keeps the original, byte-for-byte overlay:
 * no agent-preset registry, no preset, upstream `sdk-jsonrpc-server`. That is
 * the legacy run path and it needs no baseline.
 *
 * The overlay text is generated HERE from candidate-owned constants and two
 * fixed template files. No MCP parameter can name a plugin, a preset or a YAML
 * file: the only caller-controlled input is the workspace path (already checked
 * against the allowed roots) and the profile enum.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {
  API_KEY_ENV, MODEL_ID, PROVIDER_API, PROVIDER_BASE_URL, PROVIDER_HEADER_NAME, PROVIDER_HEADER_VALUE, PROVIDER_ID,
} from './config.js';

export const EXECUTION_PROFILES = ['native', 'ptc'] as const;
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

/** Raised for any non-omitted value that is not exactly `native` or `ptc`. */
export class ExecutionProfileError extends Error {
  constructor(value: unknown) {
    super(
      `invalid executionProfile: ${JSON.stringify(value)}; ` +
      `expected one of ${EXECUTION_PROFILES.map((p) => JSON.stringify(p)).join(', ')}, or omit the field`,
    );
    this.name = 'ExecutionProfileError';
  }
}

/**
 * Strict, case-sensitive, no-coercion parse.
 *
 *   * `undefined` means the field was omitted and selects the legacy path.
 *   * exactly `'native'` or `'ptc'` selects that profile.
 *   * every other type or value (including `null`, numbers, objects and
 *     differently-cased strings) throws; it is never silently downgraded to the
 *     legacy path, because that would hide a caller bug as a configuration choice.
 */
export function parseExecutionProfile(value: unknown): ExecutionProfile | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (EXECUTION_PROFILES as readonly string[]).includes(value)) {
    return value as ExecutionProfile;
  }
  throw new ExecutionProfileError(value);
}

/** `dist/src/` -> candidate root. The adapter assets ship next to this module's package. */
const CANDIDATE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PLUGIN_DIR = path.join(CANDIDATE_ROOT, 'plugin');
export const ADAPTER_PLUGIN_FILE = path.join(PLUGIN_DIR, 'dsh-preset-sdk-server.mjs');
export const BASELINE_FILE = path.join(CANDIDATE_ROOT, 'baseline', 'execution-profiles-baseline.json');

export function presetPluginTemplateFile(profile: ExecutionProfile): string {
  return path.join(PLUGIN_DIR, `preset-plugins.${profile}.yml`);
}

/**
 * Root rows that are re-declared inside every profile preset. A preset-backed
 * SDK session must disable exactly these at the root, or the agent joins both
 * the root composition and the preset composition (duplicate registration, and
 * two `presentAs` claims for the same scope). This list is deliberately the
 * SMALLEST set that moves into the preset: only rows whose preset id is also a
 * root `dsh-base` row. It does not touch compaction, workflow or any Web/UI row
 * that the preset does not carry.
 */
export const ROOT_AGENT_PLANE_DISABLES: readonly string[] = [
  'agent-instructions',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-jobs',
  'skill-filesystem',
  'tool-skill',
];

/**
 * Additional root rows disabled only for `ptc`: its `run_code` presentation
 * surface and the workflow tooling share the PTC runtime and are mutually
 * exclusive in the reference implementation. `native` keeps the root workflow
 * rows enabled.
 */
export const PTC_EXTRA_ROOT_DISABLES: readonly string[] = ['workflow-ptc', 'tool-workflow'];

function yamlSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The pinned provider route block, shared by the legacy and profile overlays. */
function routeBlock(): string[] {
  const pending: string[] = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      ' + PROVIDER_ID + ':',
    '        displayName: ' + (PROVIDER_ID === 'commandcode-goat' ? 'CommandCode GOAT' : 'OpenCode Go'),
    '        apiKeyEnv: ' + API_KEY_ENV,
    '        api: ' + PROVIDER_API,
    '        baseURL: ' + PROVIDER_BASE_URL,
  ];
  if (PROVIDER_HEADER_NAME) {
    pending.push('        headers:', '          ' + PROVIDER_HEADER_NAME + ': ' + PROVIDER_HEADER_VALUE);
  }
  pending.push(
    '        models:',
    '          - id: ' + MODEL_ID,
    '            name: ' + MODEL_ID,
  );
  if (PROVIDER_ID === 'commandcode-goat') pending.push('            contextWindow: 1000000');
  pending.push(
    '            reasoningEfforts:',
    "              'off': none",
    '              low: low',
    '              medium: medium',
    '              high: high',
  );
  return pending;
}

function indented(lines: readonly string[], spaces: number): string[] {
  const prefix = ' '.repeat(spaces);
  return lines.map((line) => (line.length === 0 ? '' : prefix + line));
}

/**
 * The per-task overlay YAML.
 *
 * @param workspace canonical task workspace (already inside the allowed roots).
 * @param profile explicit profile, or undefined for the legacy path.
 */
export function renderOverlay(workspace: string, profile?: ExecutionProfile): string {
  const quoted = workspace.replace(/\\/g, '/').replace(/'/g, "''");
  if (profile === undefined) {
    return [
      '- id: sandbox-policy',
      '  config:',
      '    mode: workspace-write',
      `    workspaceRoot: '${quoted}'`,
      '- id: sdk-jsonrpc-server',
      '  config:',
      '    maxTokensAsSuccess: false',
      ...routeBlock(),
      '',
    ].join('\n');
  }

  const template = readFileSync(presetPluginTemplateFile(profile), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/, '')
    .split('\n');
  const pluginUrl = pathToFileURL(ADAPTER_PLUGIN_FILE).href;

  const lines: string[] = [
    '- id: sandbox-policy',
    '  config:',
    '    mode: workspace-write',
    `    workspaceRoot: '${quoted}'`,
    '# Explicit execution profile: the upstream SDK server cannot mount a preset,',
    '# so it is disabled and replaced by the candidate-owned preset-aware server.',
    '- id: sdk-jsonrpc-server',
    '  disabled: true',
    ...routeBlock(),
    '# The agent plane moves behind the preset; these root rows are re-declared inside it.',
  ];
  const disabledRows = profile === 'ptc'
    ? [...ROOT_AGENT_PLANE_DISABLES, ...PTC_EXTRA_ROOT_DISABLES]
    : ROOT_AGENT_PLANE_DISABLES;
  for (const id of disabledRows) {
    lines.push(`- id: ${id}`, '  disabled: true');
  }
  lines.push(
    '- insert:',
    '    - id: agent-preset-registry',
    "      name: '@deepseek-ai/dsh-agent-preset-registry'",
    '      config:',
    `        default: ${profile}`,
    `    - id: preset-${profile}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${profile}`,
    '        order: 1',
    '        plugins:',
    ...indented(template, 10),
    '    - id: dsh-candidate-preset-sdk-server',
    `      name: ${yamlSingleQuote(pluginUrl)}`,
    '      inject: [sdkAppStartup, loader]',
    '      config:',
    `        presetId: ${profile}`,
    '        maxTokensAsSuccess: false',
    '',
  );
  return lines.join('\n');
}
