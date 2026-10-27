/**
 * Test-only filesystem fault preload. Not a production seam: it is loaded only by the persistence
 * regression test via `node --import`, and no bridge source reads these variables.
 */
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';

const original = {renameSync: fs.renameSync, writeFileSync: fs.writeFileSync, openSync: fs.openSync, appendFileSync: fs.appendFileSync};
function fail(file) {
  const name = String(file);
  const target = process.env.BRIDGE_PROBE_FAULT_TARGET;
  const marker = process.env.BRIDGE_PROBE_FAULT_MARKER;
  const active = marker === undefined || fs.existsSync(marker);
  if (active && target && name.includes(target)) {
    const error = new Error('TEST_FS_FAULT simulated disk failure');
    error.code = 'ENOSPC';
    throw error;
  }
}
fs.renameSync = function (from, to, ...rest) { fail(to); return original.renameSync.call(this, from, to, ...rest); };
fs.writeFileSync = function (file, ...rest) { fail(file); return original.writeFileSync.call(this, file, ...rest); };
fs.openSync = function (file, flags, ...rest) {
  if (typeof flags === 'number' || /[wa+]/.test(String(flags))) fail(file);
  return original.openSync.call(this, file, flags, ...rest);
};
fs.appendFileSync = function (file, ...rest) { fail(file); return original.appendFileSync.call(this, file, ...rest); };
syncBuiltinESMExports();
