import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { remainingDaemonImports } from "./rewrite-daemon-imports.mjs";
import { npmCommand } from "./npm-command.mjs";
import { packageBuildShell } from "./run-package-build.mjs";

// 51-04 Q2 — the pack-step proof. The old guard only string-matched `npm pack`, so it stayed GREEN
// over THREE stacked breaks (root package / no bin / non-standalone-installable). Tiers:
//   1. fast OFFLINE pre-check — the tarball is @openrig/cli, ships the `rig` bin, and does NOT depend
//      on the unpublished @openrig/daemon (#66: package managers that ignore bundling tried the
//      registry and got a 404);
//   2. PACKAGE PROOF (host-runnable) — assemble via build-package.sh + pack, and prove the tarball
//      ships the daemon exports-map surfaces under daemon/dist and that no packaged JS still imports
//      @openrig/daemon;
//   3. FULL install+LOAD GATE (opt-in RUN_TESTBED_PACK_GATE=1) — the desk-ruled effect proof on a
//      CLEAN target: install + run a command that LOADS the daemon. It requires TARGET build tools
//      because better-sqlite3 builds on target when its bundled prebuilds lack the platform (desk caveat 1); on a host
//      without them it stops at that native build, so the operator's Debian Docker rerun IS this gate.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLI_DIR = join(REPO_ROOT, "packages", "cli");
function installedCliRoot(prefix) {
  const modules = execFileSync(...npmCommand(["root", "-g", "--prefix", prefix]), { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const rel = relative(prefix, modules);
  assert.ok(isAbsolute(modules) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "npm global root must stay in the owned prefix");
  return join(modules, "@openrig", "cli");
}
// Daemon exports-map surfaces the cli's runtime value-imports resolve to after packaging.
const DAEMON_SURFACES = [
  "daemon/dist/gateway-human-registry-surface.js",
  "daemon/dist/crash-cart-surface.js",
  "daemon/dist/gateway-slack-surface.js",
];

function assertReleaseGuidance(version, note) {
  const [heading, intro] = note.replaceAll("\r\n", "\n").trim().split(/\n\s*\n/, 2);
  assert.equal(heading, `# What changed in OpenRig ${version}`, 'packaged whats-new heading is stale');
  assert.ok(intro.includes(`just upgraded to ${version}.`), 'packaged whats-new introduction is stale');
}

test("whats-new names its package version, and rejects stale heading or introduction", () => {
  const note = '# What changed in OpenRig 0.7.0\n\nThis note is for an agent on an install that was just upgraded to 0.7.0.';
  assertReleaseGuidance('0.7.0', note);
  assertReleaseGuidance('0.7.0', note.replaceAll('\n', '\r\n'));
  assert.throws(() => assertReleaseGuidance('0.7.0', note.replace('OpenRig 0.7.0', 'OpenRig 0.6.12')), /heading is stale/);
  assert.throws(() => assertReleaseGuidance('0.7.0', note.replace('upgraded to 0.7.0', 'upgraded to 0.6.12')), /introduction is stale/);
});

test("pre-check: @openrig/cli, ships the `rig` bin, and does not depend on the unpublished @openrig/daemon", () => {
  const pkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8"));
  assert.equal(pkg.name, "@openrig/cli", "must pack @openrig/cli, not the root openrig");
  assert.equal(pkg.bin?.rig, "dist/bin-wrapper.js", "@openrig/cli must declare the `rig` bin");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(pkg[field]?.["@openrig/daemon"], undefined, `@openrig/daemon must not be in ${field} (it is unpublished)`);
  }
  for (const field of ["bundledDependencies", "bundleDependencies"]) {
    assert.ok(!(pkg[field] ?? []).includes("@openrig/daemon"), `@openrig/daemon must not be in ${field}`);
  }
});

test("package proof: the tarball ships the daemon surfaces and no packaged JS imports @openrig/daemon", async () => {
  // assemble (stages daemon/, rewrites daemon imports) — heavy but no install/native build
  execFileSync(packageBuildShell(process.platform, process.env), [join(REPO_ROOT, "scripts", "build-package.sh")], { cwd: REPO_ROOT, stdio: "inherit" });
  assert.ok(!existsSync(join(CLI_DIR, "node_modules", "@openrig", "daemon")),
    "build-package.sh must not leave a bundled <cli>/node_modules/@openrig/daemon copy");

  const tgz = execFileSync(...npmCommand(["pack", "--silent"]), { cwd: CLI_DIR, encoding: "utf8" }).trim().split("\n").filter(Boolean).pop();
  const tgzPath = join(CLI_DIR, tgz);
  const extract = mkdtempSync(join(tmpdir(), "q2-pack-content-"));
  try {
    const listing = execFileSync("tar", ["-tzf", tgzPath], { encoding: "utf8" });
    assert.match(listing, /^package\/dist\/bin-wrapper\.js$/m, "the tarball must ship the `rig` bin");
    assert.match(listing, /^package\/tui\/dist\/main\.js$/m, "the tarball must ship the `openrig-tui` bin");
    assert.doesNotMatch(listing, /^package\/node_modules\//m, "the tarball must not bundle node_modules");
    for (const surface of DAEMON_SURFACES) {
      assert.match(listing, new RegExp(`^package/${surface.replace(/[.]/g, "\\.")}$`, "m"),
        `the shipped daemon must include ${surface} (a value-import resolution target)`);
    }
    const packed = JSON.parse(execFileSync("tar", ["-xzOf", tgzPath, "package/package.json"], { encoding: "utf8" }));
    const note = execFileSync("tar", ["-xzOf", tgzPath, "package/daemon/context-packs/reference/whats-new.md"], { encoding: "utf8" });
    assertReleaseGuidance(packed.version, note);
    assert.equal(packed.dependencies?.["@openrig/daemon"], undefined, "the packed manifest must not depend on @openrig/daemon");
    assert.equal(packed.bundledDependencies, undefined, "the packed manifest must not bundle dependencies");

    execFileSync("tar", ["-xzf", tgzPath, "-C", extract]);
    const tileHelper = join(extract, "package/daemon/assets/terminal/windows-tile-attach.ps1");
    assert.equal(lstatSync(tileHelper).isFile(), true);
    assert.equal(lstatSync(tileHelper).isSymbolicLink(), false);
    assert.deepEqual(readFileSync(tileHelper), readFileSync(join(REPO_ROOT,"packages/daemon/assets/terminal/windows-tile-attach.ps1")));
    const tileModule = await import(pathToFileURL(join(extract,"package/daemon/dist/domain/terminal/windows-tile-attach.js")).href);
    const tileArgv = tileModule.windowsTileAttachArgv(process.execPath,[],"owned-fixture",true);
    assert.ok(Buffer.from(tileArgv.at(-1),"base64").toString("utf16le").includes(tileHelper.replaceAll("'","''")),
      "the extracted module must resolve the helper inside the extracted package");
    for (const [projected, document] of [
      ["help/help.md", "help.md"],
      ["reference/acp-agents.md", "acp-agents.md"],
      ["reference/getting-started.md", "getting-started.md"],
      ["reference/instance-layout.md", "instance-layout.md"],
      ["reference/rig-spec.md", "rig-spec.md"],
      ["reference/whats-new.md", "whats-new.md"],
    ]) {
      const output = join(extract, "package/daemon/context-packs", projected);
      assert.equal(lstatSync(output).isSymbolicLink(), false);
      assert.deepEqual(readFileSync(output), readFileSync(join(REPO_ROOT, "docs/reference", document)), projected);
    }
    const left = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".js")) left.push(...remainingDaemonImports(readFileSync(path, "utf8")).map((m) => `${path}: ${m}`));
      }
    };
    walk(join(extract, "package", "dist"));
    walk(join(extract, "package", "tui", "dist"));
    assert.deepEqual(left, [], "no packaged cli/tui JS may import @openrig/daemon");
  } finally {
    rmSync(tgzPath, { force: true });
    rmSync(extract, { recursive: true, force: true });
  }
});

test("install RED (resident, docker-free): a clean install materializes a COMPLETE better-sqlite3 (binding.gyp present)", () => {
  // Q2 break #5 (historical: the daemon is no longer bundled): the BUNDLED @openrig/daemon package.json declared its cli-SUBSET deps
  // (better-sqlite3 + hono/tar/ulid/yaml/@hono/*), so `npm install -g` treated them as bundle-provided
  // UNDER @openrig/daemon and left an EMPTY <cli>/node_modules/better-sqlite3 (no binding.gyp →
  // 'prebuild-install: not found' + 'binding.gyp not found'). The pack-CONTENT assertion above
  // (daemon present + better-sqlite3 absent) FALSE-GREENS this — it passes on the broken pack. The
  // effect is only visible one layer later, at INSTALL. --ignore-scripts skips the native build, so
  // this is TOOLCHAIN-INDEPENDENT + fast (the effect one layer earlier than the container gate).
  execFileSync(packageBuildShell(process.platform, process.env), [join(REPO_ROOT, "scripts", "build-package.sh")], { cwd: REPO_ROOT, stdio: "inherit" });
  const prefix = mkdtempSync(join(tmpdir(), "q2-install-red-"));
  let tgzPath;
  try {
    const tgz = execFileSync(...npmCommand(["pack", "--silent"]), { cwd: CLI_DIR, encoding: "utf8" }).trim().split("\n").filter(Boolean).pop();
    tgzPath = join(CLI_DIR, tgz);
    execFileSync(...npmCommand(["install", "-g", "--prefix", prefix, "--ignore-scripts", tgzPath]), { cwd: REPO_ROOT, stdio: "inherit" });
    const bsq3 = join(installedCliRoot(prefix), "node_modules", "better-sqlite3");
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
  execFileSync(packageBuildShell(process.platform, process.env), [join(REPO_ROOT, "scripts", "build-package.sh")], { cwd: REPO_ROOT, stdio: "inherit" });
  const prefix = mkdtempSync(join(tmpdir(), "q2-gate-prefix-"));
  const home = mkdtempSync(join(tmpdir(), "q2-gate-home-"));
  let tgzPath;
  try {
    const tgz = execFileSync(...npmCommand(["pack", "--silent"]), { cwd: CLI_DIR, encoding: "utf8" }).trim().split("\n").filter(Boolean).pop();
    tgzPath = join(CLI_DIR, tgz);
    execFileSync(...npmCommand(["install", "-g", "--prefix", prefix, tgzPath]), { cwd: REPO_ROOT, stdio: "inherit" });
    const installed = installedCliRoot(prefix);
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    const entry = join(installed, manifest.bin.rig);
    assert.ok(existsSync(entry), "installed bin entry must exist");
    assert.ok(existsSync(process.platform === "win32" ? join(prefix, "rig.cmd") : join(prefix, "bin", "rig")), "npm must materialize the installed rig shim");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENRIG|RIGGED)_/i.test(key)));
    Object.assign(env, { OPENRIG_HOME: home, HOME: home, USERPROFILE: home });
    // Explicitly exercise the installed in-memory SQLite check even when the
    // operator's npm configuration happens to suppress lifecycle scripts.
    execFileSync(process.execPath, [join(installed, "scripts/check-abi.mjs")], { cwd: home, env, stdio: "pipe" });
    const args = [
      "gateway", "human", "add", "gateuser",
      "--display-name", "Gate User",
      "--binding", "slack:main:vault://slack/gate:primary:handle=UGATE",
      "--delivery-class", "B",
    ];
    let out;
    if (process.platform === "win32") {
      const argumentsFile = join(home, "rig-arguments.json");
      writeFileSync(argumentsFile, JSON.stringify(args));
      const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      out = execFileSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; $rigArgs=@(Get-Content -LiteralPath $env:OPENRIG_TEST_RIG_ARGUMENTS -Raw | ConvertFrom-Json); & $env:OPENRIG_TEST_RIG_COMMAND @rigArgs; exit $LASTEXITCODE"], {
        encoding: "utf8", cwd: home, windowsHide: true,
        env: { ...env, OPENRIG_TEST_RIG_ARGUMENTS: argumentsFile, OPENRIG_TEST_RIG_COMMAND: join(prefix, "rig.cmd") },
      });
    } else out = execFileSync(join(prefix, "bin", "rig"), args, { encoding: "utf8", cwd: home, env });
    assert.match(out, /"ok":\s*true|gateuser/, "`rig gateway human add` must succeed, proving @openrig/daemon resolved on a clean install");
    assert.ok(existsSync(join(home, "gateway", "humans", "gateuser.yaml")), "the daemon-backed verb must have written the fragment");
  } finally {
    if (tgzPath) rmSync(tgzPath, { force: true });
    rmSync(prefix, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
