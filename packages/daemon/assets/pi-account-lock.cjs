// Pi uses proper-lockfile with realpath:false. Redirect only the managed auth
// link's lock operations, so seat aliases and the account owner use one lock.
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
// The runner injects this exact option. Consume only our preload before Pi can
// launch tools, preserving any other Node options supplied by its wrapper.
const preload = `--require=${JSON.stringify(__filename)}`;
if (process.env.NODE_OPTIONS) {
  const remaining = process.env.NODE_OPTIONS.replace(preload, '').trim();
  if (remaining) process.env.NODE_OPTIONS = remaining;
  else delete process.env.NODE_OPTIONS;
}
let localLock, sharedLock;
try {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) return;
  const auth = path.join(agentDir, 'auth.json');
  const account = fs.readFileSync(path.join(agentDir, '.openrig-account'), 'utf8');
  const source = path.resolve(path.dirname(auth), fs.readlinkSync(auth));
  if (source !== path.resolve(account, 'auth.json')) return;
  localLock = path.resolve(auth + '.lock');
  // Match direct Pi's realpath:false pathname, even when the source is a link.
  sharedLock = source + '.lock';
} catch {
  // Preparation validates selected credentials. Unrelated processes are untouched.
  return;
}
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
