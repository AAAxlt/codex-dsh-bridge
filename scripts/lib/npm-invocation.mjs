/**
 * Resolve npm to a real JavaScript entry that can be spawned by node WITHOUT a shell.
 *
 * On Windows `npm.cmd` cannot be passed directly to `child_process.spawnSync` when `shell:false`
 * (Node returns EINVAL). The safe cross-platform form is:
 *
 *   process.execPath <absolute path to npm-cli.js> <npm args...>
 *
 * No string concatenation, no shell, no quoting of user-controlled command lines.
 */
import path from 'node:path';

function fileExists(exists, candidate) {
  try { return exists(candidate) === true; } catch { return false; }
}

export function resolveNpmInvocation({
  execPath = process.execPath,
  env = process.env,
  platform = process.platform,
  exists = () => false,
  pathApi = path,
} = {}) {
  const candidates = [];
  const npmExecpath = typeof env.npm_execpath === 'string' ? env.npm_execpath.trim() : '';
  if (npmExecpath.length > 0 && /npm-cli\.js$/i.test(npmExecpath)) {
    candidates.push({file: npmExecpath, source: 'env.npm_execpath'});
  }
  const nodeDir = pathApi.dirname(execPath);
  candidates.push({
    file: pathApi.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    source: 'execPath/node_modules/npm/bin/npm-cli.js',
  });
  candidates.push({
    file: pathApi.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    source: 'execPath/../lib/node_modules/npm/bin/npm-cli.js',
  });

  for (const candidate of candidates) {
    const file = pathApi.resolve(candidate.file);
    if (fileExists(exists, file)) {
      return {
        command: execPath,
        prefixArgs: [file],
        npmCliPath: file,
        source: candidate.source,
        platform,
        shell: false,
      };
    }
  }
  throw new Error(
    'cannot resolve a real npm-cli.js for this node installation; refusing to spawn npm.cmd/npm '
    + `without a shell (platform=${platform}, execPath=${execPath}). Checked: `
    + candidates.map((candidate) => `${candidate.source}=${pathApi.resolve(candidate.file)}`).join(', '),
  );
}

/** Complete argv for spawnSync: [npm-cli.js, ...npmArgs]. */
export function npmArgv(invocation, npmArgs) {
  if (!invocation || typeof invocation.command !== 'string' || !Array.isArray(invocation.prefixArgs)) {
    throw new Error('invalid npm invocation');
  }
  return [invocation.command, [...invocation.prefixArgs, ...npmArgs]];
}
