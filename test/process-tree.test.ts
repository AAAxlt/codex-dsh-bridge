/**
 * R1 regression: the runtime's own pid exiting must never be reported as "the task is stopped".
 *
 * Both scenarios below run a fixture that spawns a long-lived grandchild which INHERITS the
 * process group - the shape a tool subprocess has:
 *
 *   graceful     the fixture answers `shutdown` and exits, leaving the grandchild behind
 *   unresponsive the fixture refuses `shutdown` and ignores SIGTERM, so the forced path must run
 *
 * The assertion is on the GRANDCHILD, not on the runtime's own pid, and on the work already
 * written to the workspace. No model request is spent: the fixture is a scripted test double.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';

/**
 * Same convention as test/helpers.ts: Windows uses D:\AGENTS\temp, because the user's %TEMP%
 * is not reliably writable here (it is the very directory the Windows dsh-acl-locks failure lives
 * in), while POSIX uses the OS temp dir.
 */
const SCRATCH_PARENT = process.platform === 'win32' ? 'D:\\AGENTS\\temp' : os.tmpdir();
mkdirSync(SCRATCH_PARENT, {recursive: true});
const ROOT = mkdtempSync(path.join(SCRATCH_PARENT, 'codex-dsh-bridge-tree-'));
const FIXTURE_DIR = path.join(ROOT, 'tree-fixture');
mkdirSync(FIXTURE_DIR, {recursive: true});
const FIXTURE = path.join(FIXTURE_DIR, 'fixture-runtime.mjs');

// A scripted test double, not a DSH runtime: the entry classifier must see it as one, and the
// bridge must therefore not demand a credential for these tests.
const FIXTURE_SOURCE = `
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';

const mode = process.env.TREE_FIXTURE_MODE || 'graceful';
// 'vanishes' models a runtime that is already gone before stop() runs and left NOTHING behind, so
// not a single process of its own can be attributed at stop time. The bridge must not turn that
// empty capture into a "fully stopped" claim.
const vanish = mode === 'vanishes';
const kid = vanish ? null : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
if (kid) {
  kid.unref();
  writeFileSync(process.cwd() + '/grandchild.pid', String(kid.pid));
}
writeFileSync(process.cwd() + '/parent.pid', String(process.pid));

if (mode === 'unresponsive') {
  process.on('SIGTERM', () => {});
}

createInterface({input: process.stdin}).on('line', (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.id === undefined || frame.id === null) return;
  if (frame.method === 'shutdown' && mode === 'unresponsive') {
    process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: frame.id, error: {code: -32000, message: 'shutdown refused by fixture'}}) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: frame.id, result: {serverInfo: {name: 'tree-fixture', version: '1'}}}) + '\\n');
  if (vanish) { setTimeout(() => process.exit(0), 20); return; }
  if (frame.method === 'shutdown') setTimeout(() => process.exit(0), 10);
});
`;

writeFileSync(FIXTURE, FIXTURE_SOURCE, 'utf8');

// config reads its environment once, at first import: set every seam BEFORE importing src/.
process.env['DSH_BRIDGE_CLI_ENTRY'] = FIXTURE;
process.env['DSH_BRIDGE_PROXY_MODE'] = 'direct';
process.env['DSH_BRIDGE_STOP_GRACE_MS'] = '600';
process.env['DSH_BRIDGE_STOP_RPC_TIMEOUT_MS'] = '600';

const config = await import('../src/config.js');
const {DshRuntime} = await import('../src/runtime.js');

const POSIX = process.platform !== 'win32';
const spawnedGrandchildren: number[] = [];

/** A zombie is not a running process: only a live /proc entry counts. */
function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    const state = close < 0 ? '' : raw.slice(close + 2).split(' ')[0];
    return state !== '' && state !== 'Z';
  } catch {
    return false;
  }
}

async function runScenario(mode: string): Promise<{
  workspace: string; runtimePid: number; grandchildPid: number;
  evidence: Awaited<ReturnType<InstanceType<typeof DshRuntime>['stop']>>;
}> {
  const workspace = mkdtempSync(path.join(ROOT, `${mode}-`));
  writeFileSync(path.join(workspace, 'keep-me.txt'), 'written before the stop\n', 'utf8');
  process.env['TREE_FIXTURE_MODE'] = mode;

  const runtime = new DshRuntime({
    workspace,
    homeDir: path.join(workspace, 'home'),
    overlayPath: path.join(workspace, 'overlay.yml'),
    profileName: 'tree-fixture',
    reasoningEffort: 'low',
    maxTokens: 64,
  });
  await runtime.start(5_000);
  const runtimePid = runtime.pid ?? -1;
  const grandchildPid = Number(readFileSync(path.join(workspace, 'grandchild.pid'), 'utf8'));
  spawnGrandchild(grandchildPid);
  const evidence = await runtime.stop();
  return {workspace, runtimePid, grandchildPid, evidence};
}

function spawnGrandchild(pid: number): void {
  if (Number.isFinite(pid) && pid > 0) spawnedGrandchildren.push(pid);
}

after(() => {
  for (const pid of spawnedGrandchildren) {
    if (processAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  rmSync(ROOT, {recursive: true, force: true, maxRetries: 3});
});

describe('R1: stopping a task stops the whole task, not just its main process', () => {
  test('the entry this test drives really is classified as a scripted test double', () => {
    assert.equal(config.CLI_ENTRY_IS_REAL, false, `unexpected entry identity: ${config.CLI_ENTRY_IDENTITY.reason}`);
    assert.equal(config.CLI_ENTRY_IDENTITY.kind, 'test-double');
  });

  for (const mode of ['graceful', 'unresponsive']) {
    test(`nothing a task spawned survives stop() (${mode})`, async () => {
      const {workspace, runtimePid, grandchildPid, evidence} = await runScenario(mode);

      // The parent going away is necessary but never sufficient.
      assert.equal(evidence.parentStopped, true, `runtime pid ${runtimePid} is still alive`);
      assert.equal(evidence.treeVerified, POSIX,
        `treeVerified should be ${POSIX} on ${process.platform}: ${evidence.note}`);

      if (POSIX) {
        assert.deepEqual(evidence.survivorPids, [], `survivors reported: ${evidence.note}`);
        assert.equal(evidence.fullyStopped, true, `not fully stopped: ${evidence.note}`);
        assert.equal(processAlive(grandchildPid), false,
          `the grandchild (pid ${grandchildPid}) outlived the task: ${evidence.note}`);
      } else {
        // This platform cannot enumerate a task tree; the claim must stay unverified, not become a pass.
        assert.equal(evidence.fullyStopped, false, 'an unverifiable platform must not claim a fully stopped task');
        assert.equal(evidence.survivorPids, null);
      }

      assert.ok(evidence.method.startsWith(mode === 'graceful' ? 'shutdown-rpc' : 'none')
        || evidence.method.length > 0, `unexpected method: ${evidence.method}`);
      assert.ok(existsSync(path.join(workspace, 'keep-me.txt')), 'already-written work must survive the stop');
    });
  }

  test('a task with nothing attributable at stop time is never claimed fully stopped', async () => {
    const workspace = mkdtempSync(path.join(ROOT, 'vanishes-'));
    writeFileSync(path.join(workspace, 'keep-me.txt'), 'written before the stop\n', 'utf8');
    process.env['TREE_FIXTURE_MODE'] = 'vanishes';

    const runtime = new DshRuntime({
      workspace,
      homeDir: path.join(workspace, 'home'),
      overlayPath: path.join(workspace, 'overlay.yml'),
      profileName: 'tree-fixture',
      reasoningEffort: 'low',
      maxTokens: 64,
    });
    await runtime.start(5_000);
    // Wait until the runtime's own process is observed gone: stop() then runs the already-exited
    // path with an EMPTY capture, which is exactly the gap this test exists to pin down.
    const deadline = Date.now() + 5_000;
    while (runtime.alive && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.alive, false, 'the fixture must be gone before stop() is called');

    const evidence = await runtime.stop();
    assert.equal(evidence.parentStopped, true, `the runtime pid must be gone: ${evidence.note}`);
    assert.equal(evidence.stopped, true, `only the runtime pid could be checked here: ${evidence.note}`);
    // The hard rule from R1: an empty capture may never be upgraded into a pass. Nothing was
    // attributed to this task, so nothing about the task tree was verified - not even "empty".
    assert.equal(evidence.treeVerified, false, `nothing was attributable, so the tree is NOT verified: ${evidence.note}`);
    assert.equal(evidence.survivorPids, null, 'an empty capture is unknown, not "no survivors"');
    assert.equal(evidence.fullyStopped, false, 'HARD RULE: no attributable process means no fully-stopped claim');
    if (POSIX) {
      assert.match(evidence.note, /could be captured/i, `the note must say why: ${evidence.note}`);
      assert.match(evidence.method, /nothing-attributable/, `the method must record the empty capture: ${evidence.method}`);
    }
    assert.ok(existsSync(path.join(workspace, 'keep-me.txt')), 'already-written work must survive the stop');
  });
});
