/** Bounded, no-network drift gate. No model request and no credential reads. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const PACKAGES = Object.freeze([
  'dsh','dsh-app-boot','dsh-base','dsh-sdk-app','dsh-sdk-jsonrpc-server',
  'dsh-sdk-protocol','dsh-tools','dsh-ptc-runtime','dsh-ptc-runtime-node',
  'dsh-agent-preset','dsh-agent-preset-registry','dsh-agent-tool-presentation',
  'dsh-agent-loop','dsh-sandbox','dsh-sandbox-local','dsh-sandbox-policy',
  'dsh-scope','dsh-fs-local','cordis-plugin-loader','schemastery',
]);
export const ASSETS = Object.freeze([
  'plugin/dsh-preset-sdk-server.mjs','plugin/preset-plugins.native.yml',
  'plugin/preset-plugins.ptc.yml','dist/src/execution-profiles.js',
  'dist/src/tasks.js','dist/src/server.js','dist/src/runtime.js',
  'dist/src/delivery.js','dist/src/delivery-preset.js',
  'dist/src/config.js','dist/src/prompts.js','maintenance/guard.mjs',
]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BASELINE = path.join(ROOT, 'baseline', 'execution-profiles-baseline.json');
export const BASELINE_REGISTRY = path.join(ROOT, 'baseline', 'runtime-baselines.json');
const canonical = value => JSON.stringify(value, null, 2) + '\n';
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function realRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error('absolute root required');
  const root = fs.realpathSync.native(value);
  if (!fs.statSync(root).isDirectory()) throw Error('root is not a directory');
  return root;
}
function regularFile(root, rel) {
  const p = path.join(root, rel);
  if (!inside(root, fs.realpathSync.native(p)) || !fs.lstatSync(p).isFile()) throw Error('nonregular or escaping runtime asset: ' + rel);
  return p;
}
function libraryFiles(packageRoot, rel = 'lib') {
  const p = path.join(packageRoot, rel);
  if (!fs.existsSync(p)) return [];
  if (!inside(packageRoot, fs.realpathSync.native(p)) || fs.lstatSync(p).isSymbolicLink()) throw Error('linked library directory');
  const result = [];
  for (const e of fs.readdirSync(p, {withFileTypes:true}).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const child = rel + '/' + e.name;
    if (e.isSymbolicLink()) throw Error('linked library asset: ' + child);
    if (e.isDirectory()) result.push(...libraryFiles(packageRoot, child));
    else if (e.isFile() && /\.(?:js|mjs|cjs|json|node)$/.test(e.name)) result.push(child);
  }
  return result;
}
/** Covers a fixed set of critical packages and assets, not the whole transitive environment. */
export function captureBaseline(runtimeRoot, assetsRoot = ROOT) {
  const runtime = realRoot(runtimeRoot), assets = realRoot(assetsRoot);
  const files = {}, versions = {};
  for (const name of PACKAGES) {
    const packageDir = fs.realpathSync.native(path.join(runtime, 'node_modules', '@deepseek-ai', name));
    if (!inside(runtime, packageDir)) throw Error('package escapes pinned runtime root: ' + name);
    const info = JSON.parse(fs.readFileSync(regularFile(packageDir, 'package.json'), 'utf8'));
    if (info.name !== '@deepseek-ai/' + name || typeof info.version !== 'string') throw Error('unexpected package identity: ' + name);
    versions[name] = info.version;
    const selected = ['package.json', ...libraryFiles(packageDir)];
    if (fs.existsSync(path.join(packageDir, 'cordis.patch.yml'))) selected.push('cordis.patch.yml');
    for (const rel of selected.sort()) files['runtime/' + name + '/' + rel] = sha(regularFile(packageDir, rel));
  }
  for (const rel of ASSETS) files['assets/' + rel] = sha(regularFile(assets, rel));
  return {schema:'dsh-execution-profiles/baseline@1', platform:process.platform,
    arch:process.arch, nodeVersion:process.versions.node, versions,
    files:Object.fromEntries(Object.entries(files).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0))};
}
export function writeBaseline(file, runtimeRoot, assetsRoot = ROOT) {
  if (!path.isAbsolute(file)) throw Error('absolute baseline path required');
  const data = captureBaseline(runtimeRoot, assetsRoot);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, canonical(data), {flag:'wx', mode:0o600});
  return {baseline:file, files:Object.keys(data.files).length, created:true};
}
/** Baseline paths are never used to decide what to read: the fixed package/asset list is authoritative. */
export function checkBaseline(runtimeRoot, assetsRoot = ROOT, file = DEFAULT_BASELINE) {
  const drift = [];
  let expected, raw;
  try {
    if (!fs.lstatSync(file).isFile()) throw Error('baseline is not a regular file');
    raw = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw Error('baseline too large');
    expected = JSON.parse(raw);
    if (canonical(expected) !== raw) throw Error('baseline must use canonical JSON (no duplicate keys or hidden changes)');
    const keys = Object.keys(expected).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['arch','files','nodeVersion','platform','schema','versions'])) throw Error('unexpected baseline structure');
    if (expected.schema !== 'dsh-execution-profiles/baseline@1' || expected.files === null || typeof expected.files !== 'object' || Array.isArray(expected.files) || Object.values(expected.files).some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h))) throw Error('invalid baseline schema');
  } catch (error) {return {ok:false, drift:[{kind:'baseline-invalid',detail:error.message}], files:0};}
  let actual;
  try {actual = captureBaseline(runtimeRoot, assetsRoot);} catch (error) {return {ok:false, drift:[{kind:'runtime-unreadable',detail:error.message}], files:0};}
  for (const key of ['platform','arch','nodeVersion']) if (expected[key] !== actual[key]) drift.push({kind:key, expected:expected[key], actual:actual[key]});
  if (JSON.stringify(expected.versions) !== JSON.stringify(actual.versions)) drift.push({kind:'package-versions'});
  for (const rel of [...new Set([...Object.keys(expected.files), ...Object.keys(actual.files)])].sort()) {
    if (expected.files[rel] !== actual.files[rel]) drift.push({kind:!(rel in actual.files)?'missing':!(rel in expected.files)?'added':'changed', file:rel});
  }
  return {ok:drift.length === 0, drift, files:Object.keys(actual.files).length, baselineSha256:sha(file)};
}
/**
 * Selects the trusted baseline registered for THIS canonical runtime root. There is deliberately
 * no fallback to another runtime's baseline: 0.2.0-rc.2 and 0.2.1-rc.2 do not share file hashes.
 * An unregistered root, a version mismatch, or a missing/escaping baseline file is refused.
 */
export function selectBaselineForRuntime(runtimeRoot, assetsRoot = ROOT) {
  const runtime = realRoot(runtimeRoot);
  const assets = realRoot(assetsRoot);
  const registryFile = path.join(assets, 'baseline', 'runtime-baselines.json');
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  } catch (error) {
    throw Error(`runtime baseline registry unreadable at ${registryFile}: ${error.message}`);
  }
  if (registry?.schema !== 'codex-dsh-bridge/runtime-baselines@1' || !Array.isArray(registry.baselines)) {
    throw Error(`runtime baseline registry has an unexpected schema: ${registryFile}`);
  }
  const registered = [];
  for (const entry of registry.baselines) {
    if (!entry || typeof entry !== 'object') throw Error('runtime baseline registry contains a non-object entry');
    if (typeof entry.id !== 'string' || entry.id.length === 0) throw Error('runtime baseline entry has no id');
    if (typeof entry.runtimeRoot !== 'string' || !path.isAbsolute(entry.runtimeRoot)) throw Error(`runtime baseline '${entry.id}' needs an absolute runtimeRoot`);
    if (typeof entry.dshVersion !== 'string' || entry.dshVersion.length === 0) throw Error(`runtime baseline '${entry.id}' needs a dshVersion`);
    if (typeof entry.baselineFile !== 'string' || entry.baselineFile.length === 0) throw Error(`runtime baseline '${entry.id}' needs a baselineFile`);
    let entryRoot;
    try { entryRoot = fs.realpathSync.native(entry.runtimeRoot); } catch { continue; }
    registered.push({entry, entryRoot});
    if (entryRoot !== runtime) continue;
    const pkgFile = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch (error) {
      throw Error(`runtime identity unreadable at ${pkgFile}: ${error.message}`);
    }
    if (pkg.name !== '@deepseek-ai/dsh') throw Error(`runtime identity is not @deepseek-ai/dsh at ${runtime}`);
    if (pkg.version !== entry.dshVersion) {
      throw Error(`runtime identity mismatch for '${entry.id}': registry expects dsh ${entry.dshVersion}, actual ${pkg.version} at ${runtime}`);
    }
    const baselineFile = path.resolve(assets, entry.baselineFile);
    let realBaseline;
    try { realBaseline = fs.realpathSync.native(baselineFile); } catch (error) {
      throw Error(`registered baseline for '${entry.id}' is missing: ${baselineFile} (${error.message})`);
    }
    if (!inside(assets, realBaseline) || !fs.lstatSync(realBaseline).isFile()) {
      throw Error(`registered baseline for '${entry.id}' is not a regular file inside the assets root: ${realBaseline}`);
    }
    return {
      id: entry.id, runtimeRoot: runtime, dshVersion: pkg.version,
      baselineFile: realBaseline, baselineSha256: sha(realBaseline),
      registryFile, note: typeof entry.note === 'string' ? entry.note : null,
    };
  }
  const known = registered.map(({entry, entryRoot}) => `${entry.id}=${entryRoot} (dsh ${entry.dshVersion})`);
  throw Error(
    `no trusted baseline registered for runtime root ${runtime}; refusing to reuse another runtime's baseline. `
    + `Registered roots: [${known.join(', ') || 'none'}]. Add an explicit registry entry and its captured baseline first.`,
  );
}

export function enforceBaseline(runtimeRoot, assetsRoot = ROOT, file = DEFAULT_BASELINE) {
  const result = checkBaseline(runtimeRoot, assetsRoot, file);
  if (!result.ok) throw Error('execution profile blocked by baseline drift: ' + JSON.stringify(result.drift));
  return result;
}
function cli() {
  const [command,...args] = process.argv.slice(2), options = {};
  if (!['baseline','check'].includes(command)) throw Error('usage: guard.mjs baseline|check --runtime-root ABS --assets-root ABS --baseline ABS');
  for (let i=0;i<args.length;i+=2) {
    const key=args[i];if(!['--runtime-root','--assets-root','--baseline'].includes(key) || typeof args[i+1] !== 'string' || Object.hasOwn(options,key)) throw Error('invalid, duplicate or missing CLI argument');
    options[key]=args[i+1];
  }
  if (!options['--runtime-root']) throw Error('--runtime-root required');
  const root=options['--assets-root']??ROOT;
  let file=options['--baseline'];
  let selection=null;
  if(command==='check' && !file){
    selection=selectBaselineForRuntime(options['--runtime-root'],root);
    file=selection.baselineFile;
  }
  if(!file) file=path.join(root,'baseline','execution-profiles-baseline.json');
  const result=command==='baseline'?writeBaseline(file,options['--runtime-root'],root):checkBaseline(options['--runtime-root'],root,file);
  console.log(JSON.stringify(selection?{...result,selection}:result));if(result.ok===false)process.exitCode=1;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{cli();}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
