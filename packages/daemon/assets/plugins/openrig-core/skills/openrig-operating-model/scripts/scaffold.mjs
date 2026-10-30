#!/usr/bin/env node
import { constants } from "node:fs";
import { copyFile, mkdir, open, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, root, ...args] = process.argv.slice(2);
const files = mode === "topology" ? ["LEARNED.md"] : mode === "work" ? ["SPEC.md", "NOTES.md"] : null;
if (!files || !root || args.length % 2 || args.some((arg, index) => index % 2 === 0 ? arg !== "--node" : !arg)) {
  console.error("usage: node scaffold.mjs <topology|work> <root> [--node <relpath> ...]");
  process.exit(2);
}
const templates = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

async function place(directory, file) {
  await mkdir(directory, { recursive: true });
  const target = join(directory, file);
  try {
    // Exclusion preserves an entry another owner creates during this operation.
    await copyFile(join(templates, file), target, constants.COPYFILE_EXCL);
    console.log(`  CREATED: ${target} (template — UNSEEDED; the real owner seeds it)`);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log(`  exists : ${target}`);
  }
}

console.log(`scaffold ${mode} @ ${root}`);
await mkdir(root, { recursive: true });
const marker = join(root, ".compose-root");
await (await open(marker, "a")).close();
const now = new Date();
await utimes(marker, now, now);
for (const directory of [root, ...args.filter((_, index) => index % 2 === 1).map(node => join(root, node))]) {
  for (const file of files) await place(directory, file);
}
console.log("done. Rules: existing files untouched; UNSEEDED templates await their owners; seat LEARNED.md is SELF-seeded (the audit) — never bulk-filled.");
