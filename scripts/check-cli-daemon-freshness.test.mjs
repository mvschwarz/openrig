// Baseline-dogfood guard from QA qitem-20260518054224.
//
// Catches "merged in source but invisible through the real CLI" — the
// failure class where slice work lands in `packages/daemon/dist` and
// `packages/daemon/specs` but the vendored copy at
// `packages/cli/daemon/{dist,specs}` is stale (only rebuilt by
// `scripts/build-package.sh`). Before the fix on baseline-fix-packaging,
// `rig daemon start` from a monorepo checkout launched the stale
// vendored daemon, so /api/rig-policy/* (slice 09) and the
// review-feedback fix in the starter spec (slice 01) were
// unreachable through the user-facing CLI path even though the
// source-of-truth carried them.
//
// This guard runs ONLY when both paths exist (a monorepo dev checkout
// that has assembled the vendored bundle). In that state, the vendored
// copies MUST carry the same load-bearing surface as source — or the
// assembly is stale and `scripts/build-package.sh` must be re-run.
//
// Two narrow discriminators, both cited to baseline-dogfood findings:
//
//   1. Slice 09 rig-policy regression — vendored daemon dist MUST
//      include the rig-policy route module + its registration in
//      server.js. (qitem-20260518054224)
//
//   2. The current built-in team specs and kernel variants must ship byte-for-byte.
//      Old provider-specific starter entries must not survive in the package.
//
// The runtime resolveDaemonPath fix means `rig daemon start` from the
// monorepo prefers source even when vendored is stale, so the user
// path is no longer broken by staleness — but the assembled bundle
// still matters for `npm publish`. This guard remains the assembly
// quality gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SRC_DAEMON_DIST = path.join(REPO_ROOT, "packages/daemon/dist");
const VEND_DAEMON_DIST = path.join(REPO_ROOT, "packages/cli/daemon/dist");
const SRC_SPECS = path.join(REPO_ROOT, "packages/daemon/specs");
const VEND_SPECS = path.join(REPO_ROOT, "packages/cli/daemon/specs");

function vendoredAssembled() {
  return fs.existsSync(path.join(VEND_DAEMON_DIST, "index.js"));
}

test("baseline-fix-packaging guard: vendored daemon dist carries slice-09 rig-mode routes when assembled (qitem-20260518054224)", () => {
  if (!vendoredAssembled()) {
    // No vendored assembly present (fresh clone, or clean) — guard not
    // applicable. The runtime resolver fix means the CLI uses source
    // anyway.
    return;
  }
  assert.ok(
    fs.existsSync(path.join(VEND_DAEMON_DIST, "routes/rig-mode.js")),
    "Vendored daemon at packages/cli/daemon/dist/routes/rig-mode.js is missing. Slice 09 (OPR.0.3.2.9) shipped this route module (renamed from rig-policy in 0.5.3); if vendored bundle exists it MUST carry it. Re-run scripts/build-package.sh to refresh."
  );
  const serverJs = fs.readFileSync(path.join(VEND_DAEMON_DIST, "server.js"), "utf-8");
  assert.ok(
    serverJs.includes("rigModeRoutes") && serverJs.includes("/api/rig-mode"),
    "Vendored daemon server.js does not register /api/rig-mode routes. This is the exact baseline-dogfood failure that masked slice 09. Re-run scripts/build-package.sh."
  );
});

test("vendored built-in teams match source and omit retired shelf entries when assembled", () => {
  if (!vendoredAssembled()) return;
  for (const rel of [
    "launch/starter/rig.yaml", "launch/factory/rig.yaml", "focused/code-review/rig.yaml",
    "focused/research/rig.yaml", "focused/pm/rig.yaml", "launch/kernel/rig.yaml",
    "launch/kernel/rig-claude-only.yaml", "launch/kernel/rig-codex-only.yaml",
    "launch/factory-rsi/world-bundle.yaml", "launch/secrets-manager/rig.yaml",
  ]) {
    const source = path.join(SRC_SPECS, "rigs", rel);
    const vendored = path.join(VEND_SPECS, "rigs", rel);
    assert.ok(fs.existsSync(vendored), `Assembled package is missing ${rel}; rebuild with scripts/build-package.sh.`);
    assert.equal(fs.readFileSync(vendored, "utf8"), fs.readFileSync(source, "utf8"), `Stale packaged spec: ${rel}`);
  }
  for (const rel of [
    "launch/first-project", "launch/first-project-claude", "launch/first-project-mixed",
    "launch/conveyor", "launch/demo", "launch/implementation-pair", "preview/product-team",
    "focused/adversarial-review", "focused/research-team", "focused/pm-team",
    "launch/factory-rsi",
  ]) assert.equal(fs.existsSync(path.join(VEND_SPECS, "rigs", rel, "rig.yaml")), false, `Retired shelf entry still packaged: ${rel}`);
});

test("baseline-fix-packaging guard: vendored daemon dist+specs match source when both exist (general staleness)", () => {
  if (!vendoredAssembled()) return;

  // Pin a small set of files we know shipped recently in 0.3.2 and
  // compare byte-for-byte. Cheap, deterministic, no timestamp games.
  const pinned = [
    "server.js",
    "routes/rig-policy.js",
    "domain/rig-policy/rig-policy-types.js",
  ];
  for (const rel of pinned) {
    const srcPath = path.join(SRC_DAEMON_DIST, rel);
    const vendPath = path.join(VEND_DAEMON_DIST, rel);
    if (!fs.existsSync(srcPath)) continue;
    if (!fs.existsSync(vendPath)) {
      assert.fail(`Vendored ${rel} missing while source exists. Vendored bundle is stale; run scripts/build-package.sh.`);
    }
    const srcBytes = fs.readFileSync(srcPath);
    const vendBytes = fs.readFileSync(vendPath);
    assert.deepStrictEqual(
      Array.from(vendBytes),
      Array.from(srcBytes),
      `Vendored daemon ${rel} bytes differ from source. Vendored bundle is stale; run scripts/build-package.sh.`,
    );
  }

});
