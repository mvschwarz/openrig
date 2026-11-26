#!/usr/bin/env node
import { open, utimes } from "node:fs/promises";
import { join } from "node:path";

const [seat] = process.argv.slice(2);
if (!seat) { console.error("usage: node trace-stamp.mjs <seat-dir>"); process.exit(2); }
const stamp = join(seat, ".last-trace"), now = new Date();
await (await open(stamp, "a")).close();
await utimes(stamp, now, now);
console.log(`stamped: ${stamp} (${now.toISOString()})`);
