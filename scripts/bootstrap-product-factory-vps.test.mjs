// The VPS bootstrap runs as root on a fresh host and hands the target user NOPASSWD sudo, so the one
// operator-supplied value it carries — `--artifact` — must never be spliced into shell text. An
// apostrophe in the value would close the quoting and the rest would run as root; the fix passes the
// artifact as a positional parameter and the command text quotes "$1".
//
// A structural test pins the property on every host: it reads the shipped script, so a regression is
// caught wherever `npm run test:repo` runs, without needing a POSIX shell to execute the injection.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const script = path.join(import.meta.dirname, "bootstrap-product-factory-vps.sh");
const source = fs.readFileSync(script, "utf8");

test("the bootstrap never splices --artifact into a shell command", () => {
  // The exact shape that was injectable: the value inside single quotes inside a double-quoted
  // `bash -lc` argument.
  assert.equal(
    /bash -lc "[^"\n]*\$\{?ARTIFACT\}?/.test(source),
    false,
    "the artifact must not appear inside a double-quoted bash -lc argument",
  );
  assert.equal(/'\$ARTIFACT'/.test(source), false, "the artifact must not be single-quoted inside command text");
});

test("the bootstrap passes the artifact as a positional parameter and quotes it in the command", () => {
  const line = source.split("\n").find((l) => l.includes("npm install -g"));
  assert.ok(line, "the install step is present");
  assert.match(line, /bash -lc 'npm install -g "\$1" \|\| sudo npm install -g "\$1"' _ "\$ARTIFACT"/);
});
