// Baseline-dogfood guard from QA qitem-20260518054224.
//
// Catches "merged in source but invisible through the real CLI" — the
// failure class where slice work lands in `packages/daemon/dist` and
// `packages/daemon/specs` but the vendored copy at
// `packages/cli/daemon/{dist,specs}` is stale (only rebuilt by
// `scripts/build-package.sh`). Before the fix on baseline-fix-packaging,
// `rig daemon start` from a monorepo checkout launched the stale
// vendored daemon, so /api/rig-policy/* (slice 09) and the
// review-feedback fix in the conveyor spec (slice 01) were
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
//   2. Slice 01 conveyor cycle regression — vendored conveyor spec
//      MUST carry the review.reviewer → build.builder edge as
//      `can_observe` (the slice-01 fix at f3449baf), NOT
//      `delegates_to` (which would make `rig up conveyor` reject with
//      cycle_error). (qitem-20260518054046)
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

test("baseline-fix-packaging guard: vendored daemon dist carries slice-09 rig-policy routes when assembled (qitem-20260518054224)", () => {
  if (!vendoredAssembled()) {
    // No vendored assembly present (fresh clone, or clean) — guard not
    // applicable. The runtime resolver fix means the CLI uses source
    // anyway.
    return;
  }
  assert.ok(
    fs.existsSync(path.join(VEND_DAEMON_DIST, "routes/rig-policy.js")),
    "Vendored daemon at packages/cli/daemon/dist/routes/rig-policy.js is missing. Slice 09 (OPR.0.3.2.9) shipped this route module; if vendored bundle exists it MUST carry it. Re-run scripts/build-package.sh to refresh."
  );
  const serverJs = fs.readFileSync(path.join(VEND_DAEMON_DIST, "server.js"), "utf-8");
  assert.ok(
    serverJs.includes("rigPolicyRoutes") && serverJs.includes("/api/rig-policy"),
    "Vendored daemon server.js does not register /api/rig-policy routes. This is the exact baseline-dogfood failure that masked slice 09. Re-run scripts/build-package.sh."
  );
});

test("baseline-fix-packaging guard: vendored conveyor spec carries slice-01 can_observe edge when assembled (qitem-20260518054046)", () => {
  // Skip ONLY when no vendored bundle has been assembled at all
  // (fresh clone / clean state). Per guard verdict
  // qitem-20260518055713: an assembled bundle (dist present) that is
  // missing the conveyor spec is a stale/incomplete artifact and MUST
  // fail this gate, not skip silently.
  if (!vendoredAssembled()) {
    return;
  }
  const vendoredSpecPath = path.join(VEND_SPECS, "rigs/launch/conveyor/rig.yaml");
  assert.ok(
    fs.existsSync(vendoredSpecPath),
    `Vendored daemon dist is assembled but packages/cli/daemon/specs/rigs/launch/conveyor/rig.yaml is missing. scripts/build-package.sh assembles BOTH dist + specs; an assembled bundle without specs is an incomplete artifact that would break \`rig up conveyor\`. Re-run scripts/build-package.sh.`,
  );
  const vendoredSpec = fs.readFileSync(vendoredSpecPath, "utf-8");

  // Slice 01's review feedback fix: review.reviewer → build.builder is
  // can_observe (NOT delegates_to). A vendored spec that still says
  // `delegates_to` here is pre-slice-01 stale and `rig up conveyor`
  // will reject with cycle_error.
  //
  // Discriminator: locate the edge by from/to anchors and confirm its
  // `kind:` line is `can_observe`. Match the exact YAML block shape
  // used in the spec.
  const cycleReviewerToBuilder = /from:\s*review\.reviewer\s*\n\s*to:\s*build\.builder/m.test(vendoredSpec);
  if (!cycleReviewerToBuilder) {
    // Spec may have been restructured; verify against source and let
    // the second guard test catch sync drift below.
    return;
  }

  // Find the kind line that IMMEDIATELY precedes the `from:
  // review.reviewer / to: build.builder` block. .match() without the
  // global flag returns the FIRST match, so walking backward requires
  // matchAll + take-last.
  const idx = vendoredSpec.search(/from:\s*review\.reviewer\s*\n\s*to:\s*build\.builder/);
  const before = vendoredSpec.slice(0, idx);
  const kindMatches = [...before.matchAll(/kind:\s*(\w+)/g)];
  const lastKind = kindMatches[kindMatches.length - 1];
  assert.ok(lastKind, "Could not locate kind for review.reviewer→build.builder edge in vendored conveyor spec.");
  assert.strictEqual(
    lastKind[1],
    "can_observe",
    `Vendored conveyor spec has review.reviewer→build.builder as '${lastKind[1]}', expected 'can_observe' (slice 01 fix at f3449baf). 'delegates_to' here triggers cycle_error on \`rig up conveyor --yes\`. Re-run scripts/build-package.sh.`,
  );
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

  // Same check for the conveyor spec (the slice-01-aware artifact).
  // Per guard verdict qitem-20260518055713: when the bundle is
  // assembled and source has the spec, vendored MUST have it too —
  // missing = fail, not skip.
  const conveyorRel = "rigs/launch/conveyor/rig.yaml";
  const srcConveyor = path.join(SRC_SPECS, conveyorRel);
  const vendConveyor = path.join(VEND_SPECS, conveyorRel);
  if (fs.existsSync(srcConveyor)) {
    assert.ok(
      fs.existsSync(vendConveyor),
      `Source conveyor spec exists but vendored copy at packages/cli/daemon/specs/${conveyorRel} is missing. Assembled bundle is incomplete; run scripts/build-package.sh to assemble both dist + specs.`,
    );
    assert.strictEqual(
      fs.readFileSync(vendConveyor, "utf-8"),
      fs.readFileSync(srcConveyor, "utf-8"),
      `Vendored conveyor spec differs from source. Re-run scripts/build-package.sh to refresh both dist and specs.`,
    );
  }
});
