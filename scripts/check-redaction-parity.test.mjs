// Two files carry the same credential-pattern list, and nothing checked that they stayed the same:
//
//   packages/cli/src/restore-packet/redaction.ts    SECRET_PATTERNS
//   packages/daemon/src/domain/transcript-redaction.ts  TRANSCRIPT_SECRET_PATTERNS
//
// The daemon copy says it outright — "keep this list byte-equivalent to the CLI list … drift between
// these two arrays is a defect — reviewers should diff them on any change" — and a future slice is
// meant to fold them into one package. Until then the invariant has no guard, so a change to one
// side redacts one surface (restore packets) and silently leaves the other (transcript reads)
// exposed. This pins the property the comment asks a reviewer to hold in their head.
//
// The two files cannot import each other: the daemon is not a dependency of the CLI and the daemon
// file notes that importing it "would invert the package graph". So the check compares the array
// literals as source text — which is exactly the byte-equivalence the comment asks for — rather
// than the compiled values.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");

const LISTS = {
  cli: {
    file: path.join(ROOT, "packages", "cli", "src", "restore-packet", "redaction.ts"),
    constName: "SECRET_PATTERNS",
  },
  daemon: {
    file: path.join(ROOT, "packages", "daemon", "src", "domain", "transcript-redaction.ts"),
    constName: "TRANSCRIPT_SECRET_PATTERNS",
  },
};

/** The `[ … ]` initialiser of one exported const, as source text. */
export function arrayLiteral(source, constName) {
  const declaration = new RegExp(`export const ${constName}\\b`);
  const start = source.search(declaration);
  assert.notEqual(start, -1, `no \`export const ${constName}\` in the file`);
  const open = source.indexOf("[", start);
  assert.notEqual(open, -1, `\`${constName}\` has no array initialiser`);
  const close = source.indexOf("];", open);
  assert.notEqual(close, -1, `\`${constName}\` array is not closed with \`];\``);
  return source.slice(open, close + 1);
}

/** Comments and blank lines removed, each entry's own line trimmed, order kept. */
export function normalize(block) {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"))
    .join("\n");
}

function read(file) {
  return readFileSync(file, "utf8");
}

test("the transcript and restore-packet redaction lists are the same list", () => {
  const cli = normalize(arrayLiteral(read(LISTS.cli.file), LISTS.cli.constName));
  const daemon = normalize(arrayLiteral(read(LISTS.daemon.file), LISTS.daemon.constName));

  assert.ok(
    cli.includes("/") && cli.split("\n").length >= 5,
    `refusing to compare an empty or partial list: got ${JSON.stringify(cli)}`,
  );

  const cliLines = cli.split("\n");
  const daemonLines = daemon.split("\n");
  const differing = cliLines.length !== daemonLines.length
    || cliLines.some((line, index) => line !== daemonLines[index]);
  assert.ok(
    !differing,
    "the two redaction lists have drifted. A pattern added to one side redacts only that surface " +
      "and leaves the other exposed, so change both files in the same commit:\n" +
      `  ${path.relative(ROOT, LISTS.cli.file)} (${LISTS.cli.constName})\n` +
      `  ${path.relative(ROOT, LISTS.daemon.file)} (${LISTS.daemon.constName})\n\n` +
      `cli:\n${cli}\n\ndaemon:\n${daemon}`,
  );
});