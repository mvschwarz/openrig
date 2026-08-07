import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 51-04 Q2 — ARTIFACT-level proof for the testbed build's pack step. The old guard only
// string-matched `npm pack`, so it stayed GREEN while the script packed the WRONG package (the
// private monorepo root `openrig@0.5.0`, no `bin`) -> the image's `rig --version` smoke died with
// exit 127. This test packs the REAL @openrig/cli tarball (what the FIXED build-testbed packs) and
// inspects it: it must be @openrig/cli and SHIP the `rig` bin file. That falsifies the wrong-package
// regression at the artifact level, offline.
//
// NOTE (flagged to orch): the STRONGER required proof — `npm install -g <tgz>` + `rig --version` —
// is currently BLOCKED by a separate packaging defect: @openrig/cli hard-depends on @openrig/daemon
// ("*"), which is 404/unpublished and imported at runtime via a bare specifier
// (await import("@openrig/daemon/...")), while build-package.sh bundles the daemon to <cli>/daemon/
// NOT <cli>/node_modules/@openrig/daemon. So a standalone install fails to resolve @openrig/daemon.
// The full install+run proof rides that packaging fix (self-contained cli); this artifact proof is
// the offline half that already pins the exit-127 wrong-package regression.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLI_DIR = join(REPO_ROOT, "packages", "cli");

test("the packed tarball is @openrig/cli and SHIPS the `rig` bin (the exit-127 wrong-package pin)", () => {
  // Identity: the packable package must be @openrig/cli with a `rig` bin. The monorepo root has
  // neither (that IS the exit-127 bug — Docker installs a package with no `rig`).
  const pkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8"));
  assert.equal(pkg.name, "@openrig/cli", "the packed package must be @openrig/cli, not the root openrig");
  assert.equal(pkg.bin?.rig, "dist/bin-wrapper.js", "@openrig/cli must declare the `rig` bin");

  // Effect: pack the REAL tarball and prove it SHIPS the bin file (root pack ships no bin-wrapper.js).
  const tgz = execFileSync("npm", ["pack", "--silent"], { cwd: CLI_DIR, encoding: "utf8" }).trim().split("\n").filter(Boolean).pop();
  const tgzPath = join(CLI_DIR, tgz);
  try {
    assert.match(tgz, /^openrig-cli-/, "npm pack must produce the @openrig/cli tarball (openrig-cli-*.tgz), never openrig-*.tgz");
    const listing = execFileSync("tar", ["-tzf", tgzPath], { encoding: "utf8" });
    assert.match(listing, /(^|\n)package\/dist\/bin-wrapper\.js(\n|$)/, "the tarball must SHIP the `rig` bin (dist/bin-wrapper.js) — a root pack ships none");
  } finally {
    rmSync(tgzPath, { force: true });
  }
});
