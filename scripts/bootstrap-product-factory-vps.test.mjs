// The VPS bootstrap runs as root on a fresh host and hands the target user NOPASSWD sudo, so the one
// operator-supplied value it carries — `--artifact` — must never be spliced into shell text. An
// apostrophe in the value would close the quoting and the rest would run as root; the fix passes the
// artifact as a positional parameter and the command text quotes "$1".
//
// A structural test pins the property on every host: it reads the shipped script, so a regression is
// caught wherever `npm run test:repo` runs, without needing a POSIX shell to execute the injection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
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

// The bootstrap runs as root on a fresh VPS and pipes two vendor installers into a shell (Tailscale's
// and NodeSource's). A pipe executes whatever the network returned, with no chance to look at the
// bytes first. Both now download to a file and verify against a SHA-256 when one is pinned, and the
// step says out loud when it is not.
test("no vendor installer is piped straight into a shell", () => {
  // Prose mentions the shape it is warning about, so only executable lines are scanned.
  const code = source.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  const piped = /curl[^\n|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/.exec(code);
  assert.equal(piped, null, `an installer is piped into a shell: ${piped?.[0] ?? ""}`);
});

test("both vendor installers go through the verifying downloader", () => {
  assert.match(
    source,
    /download_and_run_installer https:\/\/tailscale\.com\/install\.sh "\$TS_INSTALL_SHA256" sh/,
    "the Tailscale installer must be fetched and verified through download_and_run_installer",
  );
  assert.match(
    source,
    /download_and_run_installer https:\/\/deb\.nodesource\.com\/setup_22\.x "\$NODESOURCE_SETUP_SHA256" bash/,
    "the NodeSource installer must be fetched and verified through download_and_run_installer",
  );
});

test("the downloader refuses a mismatch and does not run the file", () => {
  const body = source.slice(source.indexOf("download_and_run_installer() {"));
  const helper = body.slice(0, body.indexOf("\n}\n"));
  assert.match(helper, /sha256sum "\$file"/, "the helper hashes the downloaded file");
  assert.match(helper, /\[\[ "\$actual" != "\$expected" \]\][\s\S]*return 1/, "a mismatch returns before running");
  // The interpreter runs only after the check block.
  assert.ok(
    helper.indexOf('"$interpreter" "$file"') > helper.indexOf("sha256 ok"),
    "the file is executed after the verification branch, never before",
  );
});


// The checks above read the script. These run the downloader itself, with `curl` and `sha256sum`
// replaced by shims on PATH, so the matching, mismatching and unpinned cases (plus a download that
// fails and an installer that fails) are exercised for real, with no network and no root bootstrap
// on anyone's machine. Each case also asserts the thing a structural check cannot see: the temporary
// installer is gone afterwards, on every failure path as well as on success.

const BASH_OK = spawnSync("bash", ["-c", "true"]).status === 0;
const SKIP_NO_BASH = BASH_OK ? false : "bash is not available";

/** Forward slashes, so a path embedded in shell text survives Git Bash on Windows. */
const posix = (p) => p.split(path.sep).join("/");

function sha256Hex(text) {
  return spawnSync("node", ["-e",
    'const c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(process.argv[1]).digest("hex"))',
    text], { encoding: "utf8" }).stdout;
}

/** The downloader as source text, up to its closing brace at column 0, normalised to LF. */
function downloaderSource() {
  const start = source.indexOf("download_and_run_installer() {");
  assert.notEqual(start, -1, "the script has a download_and_run_installer function");
  const close = /^}\r?$/m.exec(source.slice(start));
  assert.ok(close, "the downloader body closes with a brace at column 0");
  return source.slice(start, start + close.index + 1).replace(/\r\n/g, "\n");
}

const CURL_SHIM = `#!/bin/sh
# curl shim: enough of "-fsSL <url> -o <file>" for the downloader, plus a switchable failure.
[ -n "$SHIM_CURL_FAIL" ] && exit 6
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
cp "\${url#file://}" "$out"
`;

const SHA_SHIM = `#!/bin/sh
# sha256sum shim: prints "<hex>  <file>", which is the shape the downloader's awk reads,
# and exits non-zero when SHIM_SHA_FAIL is set so the guard around the hash can be exercised.
[ -n "$SHIM_SHA_FAIL" ] && exit 5
node -e 'const c=require("node:crypto"),f=require("node:fs");const h=c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex");process.stdout.write(h+"  "+process.argv[1]+String.fromCharCode(10))' "$1"
`;

/**
 * Run the downloader once in a scratch tree.
 * mode: "match" pins the correct hash, "mismatch" pins a wrong one, "unpinned" passes none.
 */
function runCase({ mode = "match", curlFails = false, installerExit = 0, shaFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opr-bootstrap-case-"));
  const shims = path.join(root, "shims");
  const tmp = path.join(root, "tmp");
  const marker = path.join(root, "ran");
  fs.mkdirSync(shims);
  fs.mkdirSync(tmp);
  for (const [name, body] of [["curl", CURL_SHIM], ["sha256sum", SHA_SHIM]]) {
    const shim = path.join(shims, name);
    fs.writeFileSync(shim, body);
    fs.chmodSync(shim, 0o755);
  }
  const payload = path.join(root, "installer.sh");
  const payloadText = installerExit === 0
    ? `#!/bin/sh\necho ran >> "${posix(marker)}"\n`
    : `#!/bin/sh\nexit ${installerExit}\n`;
  fs.writeFileSync(payload, payloadText);
  const hash = mode === "mismatch" ? "0".repeat(64) : mode === "unpinned" ? "" : sha256Hex(payloadText);
  const driver = path.join(root, "drive.sh");
  fs.writeFileSync(driver, [
    "set -euo pipefail",
    downloaderSource(),
    'download_and_run_installer "file://$PAYLOAD" "$HASH" sh',
    "",
  ].join("\n"));

  const result = spawnSync("bash", [driver], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME ?? root,
      PATH: `${posix(shims)}${path.delimiter}${process.env.PATH}`,
      TMPDIR: posix(tmp),
      PAYLOAD: posix(payload),
      HASH: hash,
      ...(curlFails ? { SHIM_CURL_FAIL: "1" } : {}),
      ...(shaFails ? { SHIM_SHA_FAIL: "1" } : {}),
    },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    ran: fs.existsSync(marker),
    leftovers: fs.readdirSync(tmp),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("the downloader runs a pinned installer whose hash matches", { skip: SKIP_NO_BASH }, () => {
  const result = runCase({ mode: "match" });
  try {
    assert.equal(result.status, 0, `the downloader should succeed: ${result.output}`);
    assert.equal(result.ran, true, "the installer ran");
    assert.match(result.output, /sha256 ok: /, "the match is reported");
    assert.deepEqual(result.leftovers, [], "no temporary installer is left behind");
  } finally {
    result.cleanup();
  }
});

test("the downloader refuses a mismatched hash without running it", { skip: SKIP_NO_BASH }, () => {
  const result = runCase({ mode: "mismatch" });
  try {
    assert.notEqual(result.status, 0, "a mismatch is a failure");
    assert.equal(result.ran, false, "the installer did not run");
    assert.match(result.output, /refusing to run/, "the refusal says why");
    assert.deepEqual(result.leftovers, [], "no temporary installer is left behind");
  } finally {
    result.cleanup();
  }
});

test("the downloader runs an unpinned installer and says it is unverified", { skip: SKIP_NO_BASH }, () => {
  const result = runCase({ mode: "unpinned" });
  try {
    assert.equal(result.status, 0, `an unpinned run should proceed: ${result.output}`);
    assert.equal(result.ran, true, "the installer ran");
    assert.match(result.output, /WARNING: running .* unverified/, "the run is labelled unverified");
    assert.deepEqual(result.leftovers, [], "no temporary installer is left behind");
  } finally {
    result.cleanup();
  }
});

test("a failed download leaves no temporary installer behind", { skip: SKIP_NO_BASH }, () => {
  const result = runCase({ mode: "match", curlFails: true });
  try {
    assert.notEqual(result.status, 0, "a failed download is a failure");
    assert.equal(result.ran, false, "nothing ran");
    assert.deepEqual(result.leftovers, [], "the partial download was removed");
  } finally {
    result.cleanup();
  }
});

test("an installer that fails is reported as a failure and leaves nothing behind", { skip: SKIP_NO_BASH }, () => {
  const result = runCase({ mode: "match", installerExit: 3 });
  try {
    assert.notEqual(result.status, 0, "the installer's non-zero status is the caller's status");
    assert.deepEqual(result.leftovers, [], "no temporary installer is left behind");
  } finally {
    result.cleanup();
  }
});


test("a failing hash computation removes the downloaded installer", { skip: SKIP_NO_BASH }, () => {
  const result = runCase({ mode: "match", shaFails: true });
  try {
    assert.notEqual(result.status, 0, "a hash that cannot be computed is a failure");
    assert.equal(result.ran, false, "the installer did not run");
    assert.match(result.output, /could not compute the SHA-256/, "the failure names the cause");
    assert.deepEqual(result.leftovers, [], "the downloaded installer was removed");
  } finally {
    result.cleanup();
  }
});
