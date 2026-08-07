import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 51-04 Q2 — the pack-step proof. The old guard only string-matched `npm pack`, so it stayed GREEN
// over THREE stacked breaks (root package / no bin / non-standalone-installable). Tiers:
//   1. fast OFFLINE pre-check — the tarball is @openrig/cli, ships the `rig` bin, and BUNDLES the
//      (unpublished) @openrig/daemon;
//   2. BUNDLE PROOF (host-runnable) — assemble via build-package.sh + pack, and prove the tarball
//      ships <cli>/node_modules/@openrig/daemon with the EXACT exports-map surfaces the cli's four
//      bare-specifier value-imports resolve to. This is what makes the standalone install stop 404ing
//      on @openrig/daemon (verified: the install now progresses past it to the native build);
//   3. FULL install+LOAD GATE (opt-in RUN_TESTBED_PACK_GATE=1) — the desk-ruled effect proof on a
//      CLEAN target: install + run a command that LOADS the daemon. It requires TARGET build tools
//      because better-sqlite3 is NEVER prebuilt and builds fresh on target (desk caveat 1); on a host
//      without them it stops at that native build, so the operator's Debian Docker rerun IS this gate.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLI_DIR = join(REPO_ROOT, "packages", "cli");
// The 3 daemon exports-map subpaths the cli's runtime value-imports resolve through.
const DAEMON_SURFACES = [
  "node_modules/@openrig/daemon/dist/gateway-protocol-surface.js",
  "node_modules/@openrig/daemon/dist/gateway-human-registry-surface.js",
  "node_modules/@openrig/daemon/dist/crash-cart-surface.js",
];

test("pre-check: @openrig/cli, ships the `rig` bin, and BUNDLES the unpublished @openrig/daemon", () => {
  const pkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8"));
  assert.equal(pkg.name, "@openrig/cli", "must pack @openrig/cli, not the root openrig");
  assert.equal(pkg.bin?.rig, "dist/bin-wrapper.js", "@openrig/cli must declare the `rig` bin");
  assert.ok(Array.isArray(pkg.bundledDependencies) && pkg.bundledDependencies.includes("@openrig/daemon"),
    "@openrig/daemon (unpublished) must be in bundledDependencies so npm install uses the bundle, never the 404 registry");
});

test("bundle proof: the assembled tarball ships @openrig/daemon's exports-map surfaces (standalone resolution)", () => {
  // assemble (bundles daemon into <cli>/node_modules/@openrig/daemon) — heavy but no install/native build
  execFileSync("bash", [join(REPO_ROOT, "scripts", "build-package.sh")], { cwd: REPO_ROOT, stdio: "inherit" });
  assert.ok(existsSync(join(CLI_DIR, "node_modules", "@openrig", "daemon", "package.json")),
    "build-package.sh must assemble a resolver-visible <cli>/node_modules/@openrig/daemon");

  const tgz = execFileSync("npm", ["pack", "--silent"], { cwd: CLI_DIR, encoding: "utf8" }).trim().split("\n").filter(Boolean).pop();
  const tgzPath = join(CLI_DIR, tgz);
  try {
    const listing = execFileSync("tar", ["-tzf", tgzPath], { encoding: "utf8" });
    assert.match(listing, /^package\/dist\/bin-wrapper\.js$/m, "the tarball must ship the `rig` bin");
    assert.match(listing, /^package\/node_modules\/@openrig\/daemon\/package\.json$/m, "must BUNDLE @openrig/daemon (its package.json + exports map)");
    for (const surface of DAEMON_SURFACES) {
      assert.match(listing, new RegExp(`^package/${surface.replace(/[.]/g, "\\.")}$`, "m"),
        `the bundled daemon must ship ${surface} (a value-import resolution target)`);
    }
    // better-sqlite3 (native) must NOT be nested under the bundled daemon — it stays hoisted (caveat 1)
    assert.doesNotMatch(listing, /node_modules\/@openrig\/daemon\/node_modules\/better-sqlite3/,
      "better-sqlite3 must NOT be nested under the bundled daemon (it stays a hoisted cli dep, builds fresh on target)");
  } finally {
    rmSync(tgzPath, { force: true });
  }
});

test("install RED (resident, docker-free): a clean install materializes a COMPLETE better-sqlite3 (binding.gyp present)", () => {
  // Q2 break #5: the BUNDLED @openrig/daemon package.json declared its cli-SUBSET deps
  // (better-sqlite3 + hono/tar/ulid/yaml/@hono/*), so `npm install -g` treated them as bundle-provided
  // UNDER @openrig/daemon and left an EMPTY <cli>/node_modules/better-sqlite3 (no binding.gyp →
  // 'prebuild-install: not found' + 'binding.gyp not found'). The pack-CONTENT assertion above
  // (daemon present + better-sqlite3 absent) FALSE-GREENS this — it passes on the broken pack. The
  // effect is only visible one layer later, at INSTALL. --ignore-scripts skips the native build, so
  // this is TOOLCHAIN-INDEPENDENT + fast (the effect one layer earlier than the container gate).
  execFileSync("bash", [join(REPO_ROOT, "scripts", "build-package.sh")], { cwd: REPO_ROOT, stdio: "inherit" });
  const prefix = mkdtempSync(join(tmpdir(), "q2-install-red-"));
  let tgzPath;
  try {
    const tgz = execFileSync("npm", ["pack", "--silent"], { cwd: CLI_DIR, encoding: "utf8" }).trim().split("\n").filter(Boolean).pop();
    tgzPath = join(CLI_DIR, tgz);
    execFileSync("npm", ["install", "-g", "--prefix", prefix, "--ignore-scripts", tgzPath], { cwd: REPO_ROOT, stdio: "inherit" });
    const bsq3 = join(prefix, "lib", "node_modules", "@openrig", "cli", "node_modules", "better-sqlite3");
    assert.ok(existsSync(bsq3), "a clean install must materialize the cli-level better-sqlite3 dir");
    assert.ok(existsSync(join(bsq3, "binding.gyp")),
      "better-sqlite3 must be COMPLETE (binding.gyp present) — an EMPTY placeholder is the bundled-daemon-deps break #5 the pack-content assertion cannot see");
    assert.ok(existsSync(join(bsq3, "package.json")),
      "better-sqlite3 must be the full registry copy (package.json present), not an npm placeholder dir");
  } finally {
    if (tgzPath) rmSync(tgzPath, { force: true });
    rmSync(prefix, { recursive: true, force: true });
  }
});

const RUN_GATE = process.env.RUN_TESTBED_PACK_GATE === "1";
test("GATE (target-native): install the tarball + a cli command LOADS the daemon subpath", { skip: RUN_GATE ? false : "opt-in RUN_TESTBED_PACK_GATE=1; needs TARGET build tools (better-sqlite3 builds fresh) — the operator's Docker rerun is this gate" }, () => {
  execFileSync("bash", [join(REPO_ROOT, "scripts", "build-package.sh")], { cwd: REPO_ROOT, stdio: "inherit" });
  const prefix = mkdtempSync(join(tmpdir(), "q2-gate-prefix-"));
  const home = mkdtempSync(join(tmpdir(), "q2-gate-home-"));
  let tgzPath;
  try {
    const tgz = execFileSync("npm", ["pack", "--silent"], { cwd: CLI_DIR, encoding: "utf8" }).trim().split("\n").filter(Boolean).pop();
    tgzPath = join(CLI_DIR, tgz);
    execFileSync("npm", ["install", "-g", "--prefix", prefix, tgzPath], { cwd: REPO_ROOT, stdio: "inherit" });
    const rigBin = join(prefix, "bin", "rig");
    const out = execFileSync(rigBin, [
      "gateway", "human", "add", "gateuser",
      "--display-name", "Gate User",
      "--binding", "slack:main:vault://slack/gate:primary:handle=UGATE",
      "--delivery-class", "B",
    ], { encoding: "utf8", env: { ...process.env, OPENRIG_HOME: home } });
    assert.match(out, /"ok":\s*true|gateuser/, "`rig gateway human add` must succeed, proving @openrig/daemon resolved on a clean install");
    assert.ok(existsSync(join(home, "gateway", "humans", "gateuser.yaml")), "the daemon-backed verb must have written the fragment");
  } finally {
    if (tgzPath) rmSync(tgzPath, { force: true });
    rmSync(prefix, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
