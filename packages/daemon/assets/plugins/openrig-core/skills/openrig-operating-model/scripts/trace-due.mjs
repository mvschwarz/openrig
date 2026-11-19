#!/usr/bin/env node
import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const [seat, ...work] = process.argv.slice(2);
const hours = name => {
  const text = process.env[name] || (name === "TRACE_MIN_HOURS" ? "6" : "72");
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(`${name} must be an integer number of hours`);
  return Number(text);
};
if (!seat) { console.error("usage: node trace-due.mjs <seat-dir> [work-dir ...]"); process.exit(2); }
const minimum = hours("TRACE_MIN_HOURS"), force = hours("TRACE_FORCE_HOURS");
const stamp = join(seat, ".last-trace"), now = Date.now();

// find's default traversal does not follow symlinks. Like the previous due
// check, unreadable/exited paths supply no positive activity evidence.
async function recent(directory, since, excludeStamp) {
  let info;
  try { info = await lstat(directory); } catch { return false; }
  if (info.isSymbolicLink()) return false;
  if (info.isFile()) return (!excludeStamp || basename(directory) !== ".last-trace") && info.mtimeMs > since;
  if (!info.isDirectory()) return false;
  let entries;
  try { entries = await readdir(directory); } catch { return false; }
  for (const name of entries) if (await recent(join(directory, name), since, excludeStamp)) return true;
  return false;
}

let previous;
try { const info = await stat(stamp); if (info.isFile()) previous = info.mtimeMs; }
catch { /* An inaccessible/missing stamp supplies no prior trace evidence. */ }
if (previous === undefined) {
  for (const directory of [seat, ...work]) if (await recent(directory, now - 7 * 86400000, false)) {
    console.log("DUE: no trace on record and recent activity exists"); process.exit(0);
  }
} else {
  const age = Math.trunc((Math.floor(now / 1000) - Math.floor(previous / 1000)) / 3600);
  if (age >= minimum) {
    if (age >= force) { console.log(`DUE: ${age}h since last trace (force threshold ${force}h)`); process.exit(0); }
    for (const directory of [seat, ...work]) if (await recent(directory, previous, true)) {
      console.log(`DUE: ${age}h since last trace and new activity under ${directory}`); process.exit(0);
    }
  }
}
process.exitCode = 1;
