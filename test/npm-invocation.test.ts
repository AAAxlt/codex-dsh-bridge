/**
 * Windows-safe npm resolution. On Windows `spawnSync('npm.cmd', ...)` without a shell returns
 * EINVAL, so the verifier must always use `node <npm-cli.js> ...`. These tests exercise selection
 * precedence and argv shape with fake filesystems (no spawn, no model request).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, test} from 'node:test';

import {REPO_ROOT} from './helpers.js';

const {resolveNpmInvocation, npmArgv} = await import(
  pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'npm-invocation.mjs')).href
);

describe('npm invocation selection', () => {
  test('prefers npm_execpath npm-cli.js and always executes it with node', () => {
    const npmCli = '/opt/npm/bin/npm-cli.js';
    const invocation = resolveNpmInvocation({
      execPath: '/opt/node/bin/node',
      env: {npm_execpath: npmCli},
      platform: 'linux',
      exists: (file: string) => file === npmCli,
      pathApi: path.posix,
    });
    assert.equal(invocation.command, '/opt/node/bin/node');
    assert.deepEqual(invocation.prefixArgs, [npmCli]);
    assert.equal(invocation.source, 'env.npm_execpath');
    assert.equal(invocation.shell, false);
  });

  test('falls back to node_modules/npm/bin/npm-cli.js beside the node executable', () => {
    const npmCli = '/opt/node/bin/node_modules/npm/bin/npm-cli.js';
    const invocation = resolveNpmInvocation({
      execPath: '/opt/node/bin/node',
      env: {},
      platform: 'linux',
      exists: (file: string) => file === npmCli,
      pathApi: path.posix,
    });
    assert.deepEqual(invocation.prefixArgs, [npmCli]);
    assert.equal(invocation.source, 'execPath/node_modules/npm/bin/npm-cli.js');
  });

  test('falls back to the global lib/node_modules/npm layout', () => {
    const npmCli = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
    const invocation = resolveNpmInvocation({
      execPath: '/usr/local/bin/node',
      env: {},
      platform: 'linux',
      exists: (file: string) => file === npmCli,
      pathApi: path.posix,
    });
    assert.deepEqual(invocation.prefixArgs, [npmCli]);
    assert.equal(invocation.source, 'execPath/../lib/node_modules/npm/bin/npm-cli.js');
  });

  test('Windows uses node.exe + npm-cli.js and never returns npm.cmd', () => {
    const win = path.win32;
    const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
    const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    const invocation = resolveNpmInvocation({
      execPath: nodeExe,
      env: {npm_execpath: npmCli},
      platform: 'win32',
      exists: (file: string) => file === npmCli,
      pathApi: win,
    });
    assert.equal(invocation.command, nodeExe);
    assert.deepEqual(invocation.prefixArgs, [npmCli]);
    assert.equal(invocation.shell, false);
    assert.ok(!/\.cmd$/i.test(invocation.command));
    assert.ok(!invocation.prefixArgs.some((arg: string) => /\.cmd$/i.test(arg)));
  });

  test('fails closed when no npm-cli.js exists instead of spawning npm.cmd', () => {
    assert.throws(
      () => resolveNpmInvocation({
        execPath: '/nowhere/node', env: {}, platform: 'win32',
        exists: () => false, pathApi: path.posix,
      }),
      /cannot resolve a real npm-cli\.js/i,
    );
  });

  test('npmArgv places npm-cli.js before every npm argument', () => {
    const npmCli = '/opt/npm/bin/npm-cli.js';
    const invocation = resolveNpmInvocation({
      execPath: '/opt/node/bin/node', env: {npm_execpath: npmCli}, platform: 'linux',
      exists: (file: string) => file === npmCli, pathApi: path.posix,
    });
    const [command, args] = npmArgv(invocation, ['--ignore-scripts', 'test']);
    assert.equal(command, '/opt/node/bin/node');
    assert.deepEqual(args, [npmCli, '--ignore-scripts', 'test']);
  });
});
