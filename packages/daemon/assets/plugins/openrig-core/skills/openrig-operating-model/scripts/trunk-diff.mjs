#!/usr/bin/env node
import { open, lstat, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { composeDown, parseOptions } from "./compose-down.mjs";

let lock, temporary, locked = false;
try {
  const [root, state, ...options] = process.argv.slice(2);
  if (!root || !state) throw Error("usage: trunk-diff.mjs ROOT STATE [--name FILE ...] [--exclude GLOB ...]");
  const { names, excludes } = parseOptions(options), target = resolve(state);
  lock = target + ".lock";
  await (await open(lock, "wx", 0o600)).close(); locked = true;
  let previous;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw Error("State must be a regular file, not a link");
    previous = await readFile(target, "utf8");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const content = await composeDown(root, names, excludes);
  let message = "── first render (no previous state); full content is the baseline ──\n";
  temporary = target + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(content, "utf8"); } finally { await file.close(); }
  if (previous !== undefined) {
    if (previous === content) message = "── no changes since your last render ──\n";
    else {
      const diff = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--text", "--", target, temporary], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      if (diff.error || ![0, 1].includes(diff.status)) throw Error("Native git diff failed; previous state retained");
      message = diff.stdout;
    }
  }
  await rename(temporary, target); temporary = undefined;
  process.stdout.write(message);
} catch (error) { console.error(error.message); process.exitCode = 2; }
finally {
  if (temporary) await unlink(temporary).catch(() => {});
  if (locked) await unlink(lock).catch(() => {});
}
