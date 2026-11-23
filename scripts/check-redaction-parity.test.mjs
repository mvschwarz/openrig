// Transcript text has one credential-redaction rule:
//
//   packages/daemon/src/domain/transcript-redaction.ts   TRANSCRIPT_SECRET_PATTERNS (the list)
//   packages/cli/src/restore-packet/redaction.ts         imports it via @openrig/daemon/transcript-redaction
//
// GET /api/transcripts/:session/full and restore packets used to carry two copies of the list, and this
// file compared them as text. The copies were folded into the daemon module, which the CLI imports
// through the daemon's `./transcript-redaction` export (the package build rewrites that import to the
// shipped daemon copy). This keeps a second copy from coming back: the CLI module holds no pattern
// literal of its own, and the export it imports exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const CLI = path.join(ROOT, "packages", "cli", "src", "restore-packet", "redaction.ts");
const DAEMON = path.join(ROOT, "packages", "daemon", "src", "domain", "transcript-redaction.ts");
const SURFACE = path.join(ROOT, "packages", "daemon", "src", "transcript-redaction-surface.ts");
const DAEMON_PACKAGE = path.join(ROOT, "packages", "daemon", "package.json");

/** Regex literals in source text, comments removed: a `/…/flags` that follows `=`, `[`, `,`, `(` or a line start. */
export function regexLiterals(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return code.match(/(?:^|[=[,(]\s*)\/(?![/*])(?:\\.|[^/\n\\])+\/[a-z]*\s*(?=[,;\]\n)])/gm) ?? [];
}

test("the restore packet's redaction imports the daemon's one list and keeps no copy", () => {
  const cli = readFileSync(CLI, "utf8");
  assert.match(cli, /from "@openrig\/daemon\/transcript-redaction"/, "the CLI must import the shared rule");
  assert.deepEqual(regexLiterals(cli), [],
    "the CLI's redaction module carries its own pattern literal again. A pattern added on one side redacts only that " +
      `surface; add it to ${path.relative(ROOT, DAEMON)} instead.`);
});

test("the daemon exports the list the CLI imports", () => {
  const exportsMap = JSON.parse(readFileSync(DAEMON_PACKAGE, "utf8")).exports ?? {};
  assert.equal(exportsMap["./transcript-redaction"]?.import, "./dist/transcript-redaction-surface.js");
  assert.match(readFileSync(SURFACE, "utf8"), /export \* from "\.\/domain\/transcript-redaction\.js";/);
  const daemon = readFileSync(DAEMON, "utf8");
  assert.match(daemon, /export const TRANSCRIPT_SECRET_PATTERNS\b/);
  assert.ok(regexLiterals(daemon).length >= 5, "refusing to pass an empty or partial daemon list");
});
