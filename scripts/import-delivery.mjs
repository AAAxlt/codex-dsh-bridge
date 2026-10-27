#!/usr/bin/env node
/**
 * Explicit scoped delivery importer (dry run by default; `--apply` mutates).
 *
 * Usage:
 *   node scripts/import-delivery.mjs --bundle <exportDirectory> --destination <directory>
 *   node scripts/import-delivery.mjs --bundle <exportDirectory> --destination <directory> --apply
 *
 * The implementation lives in the built module so the CLI, export validation and the TypeScript
 * tests share one integrity predicate. No model request, runtime, task home or SD state is used.
 */
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = path.join(ROOT, 'dist', 'src', 'delivery-import.js');

if (!existsSync(MODULE)) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: 'build_required',
    error: `built importer is missing at ${MODULE}; run "npm run build" first`,
  }, null, 2)}\n`);
  process.exitCode = 2;
} else {
  const {runImportCli} = await import(pathToFileURL(MODULE).href);
  process.exitCode = runImportCli(process.argv.slice(2));
}
