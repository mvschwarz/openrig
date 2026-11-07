// Pi uses proper-lockfile with realpath:false. Redirect only the managed auth
// link's lock operations, so seat aliases and the account owner use one lock.
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const auth = path.join(process.env.PI_CODING_AGENT_DIR, 'auth.json');
if (!fs.lstatSync(auth).isSymbolicLink()) throw new Error('Managed Pi account auth link is missing');
const localLock = path.resolve(auth + '.lock');
const sharedLock = fs.realpathSync(auth) + '.lock';
/** Map only the managed auth lock to the shared target; leave all other filesystem paths unchanged. */
function lockPath(value) {
  return typeof value === 'string' && path.resolve(value) === localLock ? sharedLock : value;
}
for (const name of ['mkdir', 'rmdir', 'stat', 'utimes']) {
  for (const method of [name, name + 'Sync']) {
    const original = fs[method];
    fs[method] = function (file, ...args) { return original.call(this, lockPath(file), ...args); };
  }
}
syncBuiltinESMExports();
