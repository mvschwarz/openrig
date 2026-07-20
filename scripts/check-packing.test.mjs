import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("npm pack of @openrig/cli includes scripts/check-abi.mjs in tarball", () => {
  const output = execSync("npm pack --dry-run --json 2>/dev/null", {
    cwd: "packages/cli",
    encoding: "utf-8",
  });
  const entries = JSON.parse(output);
  const files = entries[0]?.files?.map((f) => f.path) ?? [];

  assert.ok(
    files.some((f) => f.includes("scripts/check-abi.mjs")),
    `scripts/check-abi.mjs missing from npm pack output. Published tarball will fail postinstall.\nFiles found: ${files.filter((f) => f.includes("scripts")).join(", ") || "(none under scripts/)"}`
  );
});

// aa922842 — the conventions doc reaches agents through a THREE-path model:
//   repo source      docs/reference/sdlc-conventions.md            (what repo readers cite)
//   packed INTERNAL  daemon/docs/reference/sdlc-conventions.md     (assembly input only —
//                                                                   NEVER taught as a user path)
//   installed stable $OPENRIG_HOME/reference/sdlc-conventions.md   (default ~/.openrig/…)
// The daemon materializes the stable path at startup by reading `../docs/reference`
// relative to its dist dir (packages/daemon/src/startup.ts), which is exactly why
// scripts/build-package.sh stages the docs at daemon/docs/reference/. That internal input
// is therefore load-bearing and completely unguarded today: if the copy step regressed, the
// stable path would silently stop materializing and every teaching pointer would go stale
// with no failing test. This pins it.
// HERMETIC BY CONSTRUCTION: packages/cli/daemon is gitignored build output, so any assertion
// that reads it (or runs `npm pack` against it) passes on a developer machine with a stale
// assembled package and FAILS in a clean checkout before anything is built. This test therefore
// asserts the three contracts that make the stable path work, using only git-tracked inputs,
// and never runs or mutates the real package build.
test("build-package stages the conventions doc as the daemon's stable-path input, and the package allowlist ships it", () => {
  const buildScript = readFileSync("scripts/build-package.sh", "utf-8");

  // (a) STAGING CONTRACT — build-package must stage the repo's docs/reference into
  //     daemon/docs/reference. The daemon resolves `../docs/reference` from its dist dir at
  //     startup to materialize $OPENRIG_HOME/reference/; if this staging is dropped or
  //     retargeted, the stable agent-facing path silently stops existing.
  assert.match(
    buildScript,
    /mkdir -p "\$CLI_DIR\/daemon\/docs\/reference"/,
    "scripts/build-package.sh no longer creates daemon/docs/reference — the daemon's startup resolver (../docs/reference) would find nothing and $OPENRIG_HOME/reference/ would never materialize."
  );
  assert.match(
    buildScript,
    /cp -r "\$REPO_ROOT\/docs\/reference\/"\* "\$CLI_DIR\/daemon\/docs\/reference\/"/,
    "scripts/build-package.sh no longer copies docs/reference verbatim into the staged package. Byte preservation is what makes the shipped conventions doc trustworthy — a transforming copy (sed/awk/envsubst) would let installed agents read something the repo never said."
  );

  // (b) INCLUSION CONTRACT — npm only publishes what the files allowlist names. Staging into
  //     daemon/ is useless if "daemon" is not published.
  const pkg = JSON.parse(readFileSync("packages/cli/package.json", "utf-8"));
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes("daemon"),
    `packages/cli package.json "files" must include "daemon" or nothing staged there is published. Found: ${JSON.stringify(pkg.files)}`
  );

  // (c) SOURCE CONTRACT — the doc being staged must actually exist in the repo and be
  //     non-trivial. This is the git-tracked input; everything above is plumbing around it.
  const repoDoc = readFileSync("docs/reference/sdlc-conventions.md");
  assert.ok(
    repoDoc.length > 1000,
    `docs/reference/sdlc-conventions.md is ${repoDoc.length}B — implausibly small for the conventions SSOT; staging would ship a truncated doc.`
  );
});

// OPPORTUNISTIC, never required: when an assembled package happens to be present, verify the
// staged copy really is byte-identical. Skipped (not failed) in a clean checkout, so this
// cannot make `npm run test:repo` depend on build state — the contracts above are the
// hermetic guarantee; this is the belt-and-braces check on an actual artifact.
test("staged conventions doc is byte-identical to the repo source (skipped when no assembled package present)", (t) => {
  const staged = "packages/cli/daemon/docs/reference/sdlc-conventions.md";
  if (!existsSync(staged)) {
    t.skip("no assembled package at packages/cli/daemon — run scripts/build-package.sh to exercise this check");
    return;
  }
  const repoDoc = readFileSync("docs/reference/sdlc-conventions.md");
  const stagedDoc = readFileSync(staged);
  assert.ok(
    repoDoc.equals(stagedDoc),
    `${staged} is not byte-identical to docs/reference/sdlc-conventions.md (repo ${repoDoc.length}B vs staged ${stagedDoc.length}B). Re-run scripts/build-package.sh; a drifted staged copy teaches installed agents stale conventions.`
  );
});
