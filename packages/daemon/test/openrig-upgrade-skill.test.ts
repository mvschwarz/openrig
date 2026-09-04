import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_WORLD_MANIFEST } from "../src/domain/system-world.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const skillRoot = path.join(
  repoRoot,
  "packages/daemon/specs/agents/shared/skills/core/openrig-upgrade",
);
const skillPath = path.join(skillRoot, "SKILL.md");
const temporaryRoots: string[] = [];

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-upgrade-skill-"));
  temporaryRoots.push(root);
  return root;
}

function write(root: string, relative: string, bytes: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function runJson(script: string, args: string[], env?: NodeJS.ProcessEnv): any {
  const stdout = execFileSync(process.execPath, [path.join(skillRoot, "scripts", script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return JSON.parse(stdout);
}

function runJsonResult(script: string, args: string[], env?: NodeJS.ProcessEnv): { status: number | null; body: any } {
  return runJsonFileResult(path.join(skillRoot, "scripts", script), args, env);
}

function runJsonFileResult(scriptPath: string, args: string[], env?: NodeJS.ProcessEnv): { status: number | null; body: any } {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const output = result.status === 0 ? result.stdout : result.stderr;
  return { status: result.status, body: JSON.parse(output) };
}

function writeRigInventory(root: string, entries: Array<Record<string, unknown>>): string {
  const fakeRig = path.join(root, "rig");
  fs.writeFileSync(fakeRig, `#!/bin/sh
if [ "$*" = "ps --nodes -A --json --full" ]; then
  cat <<'JSON'
${JSON.stringify({ entries, totalNodes: entries.length, truncated: false })}
JSON
  exit 0
fi
echo "unexpected rig command: $*" >&2
exit 7
`, { mode: 0o755 });
  return fakeRig;
}

function seedLegacyTelemetry(root: string, sessionName = "dev-impl@test-rig", cwdName = "project") {
  const home = path.join(root, "home");
  const cwd = path.join(root, cwdName);
  const contextDir = path.join(home, "context");
  const providerDir = path.join(home, "provider-usage");
  const settingsPath = path.join(cwd, ".claude", "settings.local.json");
  const collectorPath = path.join(cwd, ".openrig", "context-collector.cjs");
  const originalSettings = JSON.stringify({
    keep: true,
    statusLine: {
      type: "command",
      command: `node ${collectorPath} ${contextDir} ${providerDir}`,
    },
  }, null, 2);

  write(home, `context/${sessionName}.json`, JSON.stringify({
    context_window: { context_window_size: 200_000, used_percentage: 25 },
    session_id: "session-1",
    session_name: sessionName,
    sampled_at: "2026-01-01T00:00:00.000Z",
  }));
  write(home, `provider-usage/${sessionName}.json`, JSON.stringify({
    seatSession: sessionName,
    asOf: "2026-01-01T00:00:00.000Z",
  }));
  write(cwd, ".claude/settings.local.json", originalSettings);
  write(cwd, ".openrig/context-collector.cjs", "collector bytes stay unchanged");

  return { home, cwd, contextDir, providerDir, settingsPath, collectorPath, originalSettings, sessionName };
}

function writeTelemetryPair(
  fixture: ReturnType<typeof seedLegacyTelemetry>,
  root: "legacy" | "state",
  timestamp: string,
  usedPercentage: number,
): void {
  const contextRoot = root === "legacy" ? "context" : "state/context-usage";
  const providerRoot = root === "legacy" ? "provider-usage" : "state/provider-usage";
  write(fixture.home, `${contextRoot}/${fixture.sessionName}.json`, JSON.stringify({
    context_window: { context_window_size: 200_000, used_percentage: usedPercentage },
    session_id: "session-1",
    session_name: fixture.sessionName,
    sampled_at: timestamp,
  }));
  write(fixture.home, `${providerRoot}/${fixture.sessionName}.json`, JSON.stringify({
    seatSession: fixture.sessionName,
    asOf: timestamp,
  }));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("openrig-upgrade stays agent-driven", () => {
  it("does not teach or advertise a monolithic upgrade command", () => {
    const skill = fs.readFileSync(skillPath, "utf8");
    expect(skill).not.toMatch(/\brig upgrade\b/);
    expect(skill).toContain("The agent owns the sequence");
    expect(skill).toContain("Stop after every mutation");
  });

  it("teaches the ALL-RIG node read for the post-upgrade seat check, in every shipped copy", () => {
    // R2 F2 at 13531c17. Step 9 taught `rig ps --nodes --json`, which the live
    // CLI scopes to the CURRENT rig. A daemon upgrade protects seats across
    // every rig on the host, so the narrow form reports a verified upgrade
    // while seats outside the caller's rig were never looked at. The inspect
    // helper already used -A; the public step that runs AFTER the mutation did
    // not, and only the helper's argv was pinned — which is why the
    // contradiction stayed green.
    //
    // Both copies are asserted: the byte-for-byte mirror pin above covers the
    // three helper scripts, not SKILL.md, so a divergent public copy would
    // otherwise ship unnoticed.
    for (const copy of [
      skillPath,
      path.join(repoRoot, "skills/_canonical/core/openrig-upgrade/SKILL.md"),
    ]) {
      const skill = fs.readFileSync(copy, "utf8");
      const seatCheck = skill
        .split("\n")
        .filter((line) => line.includes("rig ps --nodes"));
      expect(seatCheck.length, `no node read found in ${copy}`).toBeGreaterThan(0);
      for (const line of seatCheck) {
        expect(line, `narrow current-rig node read in ${copy}: ${line}`).toContain("-A");
      }
    }
  });

  it("ships four bounded helpers and mirrors them byte-for-byte", () => {
    for (const helper of ["inspect-upgrade.mjs", "backup-sqlite.mjs", "refresh-managed-plugin.mjs", "migrate-telemetry-state-0.5.9.mjs"]) {
      const source = path.join(skillRoot, "scripts", helper);
      const mirror = path.join(repoRoot, "skills/_canonical/core/openrig-upgrade/scripts", helper);
      expect(fs.existsSync(source), `missing source helper ${helper}`).toBe(true);
      expect(fs.existsSync(mirror), `missing mirrored helper ${helper}`).toBe(true);
      expect(fs.readFileSync(mirror)).toEqual(fs.readFileSync(source));
    }
  });

  it("keeps the public 0.5.9 notice and shipped skill on the proven layout-migration contract", () => {
    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const skill = fs.readFileSync(skillPath, "utf8");
    const reference = fs.readFileSync(path.join(repoRoot, "docs/reference/instance-layout.md"), "utf8");
    for (const text of [readme, skill]) {
      expect(text).toContain("migrate-telemetry-state-0.5.9.mjs");
      expect(text).toContain("Agent-Operated Migration");
      expect(text).toContain("--apply-state");
      expect(text).toContain("--verify");
      expect(text).toContain("--apply-library");
      expect(text).toContain("--rollback");
      expect(text).toContain("state/context-usage");
      expect(text).toContain("context/system/system-world.yaml");
      expect(text).toMatch(/canonical-first[^.]*legacy-fallback/i);
      expect(text).toMatch(/non-destructive\s+finalizer/i);
      expect(text).toMatch(/custom context-library root[^.]*stable/i);
    }
    for (const text of [readme, skill, reference]) {
      expect(text).toMatch(/paired new-root|newer paired|newer samples.*both new state roots/i);
      expect(text).toMatch(/tail bytes|exact tail bytes|accepted tail\s+bytes|accepted tails/i);
      expect(text).toContain("--help");
      expect(text).toMatch(/no\s+phase\s+flag[^.]*read-only plan/i);
      expect(text).toMatch(/unknown options\s+fail nonzero/i);
      expect(text).toMatch(/never\s+(?:removes|deletes) the legacy (?:telemetry|library|sources)/i);
    }
  });
});

describe("refresh-managed-plugin helper", () => {
  it("applies only unambiguous writes and preserves modifications, deletions, and live-only files", () => {
    const root = temporaryRoot();
    const ancestor = path.join(root, "ancestor");
    const target = path.join(root, "target");
    const live = path.join(root, "live");

    write(ancestor, "hooks/refresh.cjs", "old");
    write(ancestor, "skills/modified/SKILL.md", "old");
    write(ancestor, "skills/deleted/SKILL.md", "old");
    write(target, "hooks/refresh.cjs", "new");
    write(target, "skills/modified/SKILL.md", "target");
    write(target, "skills/deleted/SKILL.md", "target");
    write(target, "skills/new/SKILL.md", "new skill");
    write(live, "hooks/refresh.cjs", "old");
    write(live, "skills/modified/SKILL.md", "local edit");
    write(live, "skills/private/SKILL.md", "private");

    const planned = runJson("refresh-managed-plugin.mjs", [
      "--ancestor", ancestor,
      "--target", target,
      "--live", live,
    ]);
    expect(planned.applied).toBe(false);
    expect(planned.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "hooks/refresh.cjs", decision: "refresh-safe" }),
      expect.objectContaining({ path: "skills/new/SKILL.md", decision: "add-safe" }),
      expect.objectContaining({ path: "skills/modified/SKILL.md", decision: "preserve-local-modification" }),
      expect.objectContaining({ path: "skills/deleted/SKILL.md", decision: "preserve-local-deletion" }),
      expect.objectContaining({ path: "skills/private/SKILL.md", decision: "preserve-live-only" }),
    ]));
    expect(fs.readFileSync(path.join(live, "hooks/refresh.cjs"), "utf8")).toBe("old");

    const applied = runJson("refresh-managed-plugin.mjs", [
      "--ancestor", ancestor,
      "--target", target,
      "--live", live,
      "--apply-safe",
    ]);
    expect(applied.applied).toBe(true);
    expect(fs.readFileSync(path.join(live, "hooks/refresh.cjs"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(live, "skills/new/SKILL.md"), "utf8")).toBe("new skill");
    expect(fs.readFileSync(path.join(live, "skills/modified/SKILL.md"), "utf8")).toBe("local edit");
    expect(fs.existsSync(path.join(live, "skills/deleted/SKILL.md"))).toBe(false);
    expect(fs.readFileSync(path.join(live, "skills/private/SKILL.md"), "utf8")).toBe("private");
  });

  it("preserves a MODE-ONLY local modification instead of chmodding it back", () => {
    // R2 F1 at 13531c17. The inventory carries each file's mode, but equality
    // compared kind and hash only, so a file whose bytes still match the
    // ancestor but whose mode the operator changed was classified refresh-safe
    // — and apply then installed the packaged mode over their change. A chmod
    // is a local modification; the contract says local modifications are never
    // overwritten.
    const root = temporaryRoot();
    const ancestor = path.join(root, "ancestor");
    const target = path.join(root, "target");
    const live = path.join(root, "live");

    // Same bytes in all three trees. The ONLY divergence is the live mode.
    write(ancestor, "hooks/run.cjs", "same bytes");
    write(target, "hooks/run.cjs", "same bytes");
    write(live, "hooks/run.cjs", "same bytes");
    fs.chmodSync(path.join(ancestor, "hooks/run.cjs"), 0o644);
    fs.chmodSync(path.join(target, "hooks/run.cjs"), 0o644);
    fs.chmodSync(path.join(live, "hooks/run.cjs"), 0o600);

    const planned = runJson("refresh-managed-plugin.mjs", [
      "--ancestor", ancestor,
      "--target", target,
      "--live", live,
    ]);
    expect(planned.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "hooks/run.cjs", decision: "preserve-local-modification" }),
    ]));

    const applied = runJson("refresh-managed-plugin.mjs", [
      "--ancestor", ancestor,
      "--target", target,
      "--live", live,
      "--apply-safe",
    ]);
    expect(applied.written).not.toContain("hooks/run.cjs");
    expect(fs.statSync(path.join(live, "hooks/run.cjs")).mode & 0o777).toBe(0o600);
  });

  it("still refreshes when the live file matches the ancestor in bytes AND mode", () => {
    // The other side of the same axis: including mode in equality must not
    // freeze a file the operator never touched. A packaged mode advance still
    // lands when live is byte- and mode-identical to the ancestor.
    const root = temporaryRoot();
    const ancestor = path.join(root, "ancestor");
    const target = path.join(root, "target");
    const live = path.join(root, "live");

    write(ancestor, "hooks/run.cjs", "old");
    write(target, "hooks/run.cjs", "new");
    write(live, "hooks/run.cjs", "old");
    fs.chmodSync(path.join(ancestor, "hooks/run.cjs"), 0o644);
    fs.chmodSync(path.join(live, "hooks/run.cjs"), 0o644);
    fs.chmodSync(path.join(target, "hooks/run.cjs"), 0o755);

    const applied = runJson("refresh-managed-plugin.mjs", [
      "--ancestor", ancestor,
      "--target", target,
      "--live", live,
      "--apply-safe",
    ]);
    expect(applied.written).toContain("hooks/run.cjs");
    expect(fs.readFileSync(path.join(live, "hooks/run.cjs"), "utf8")).toBe("new");
    expect(fs.statSync(path.join(live, "hooks/run.cjs")).mode & 0o777).toBe(0o755);
  });

  it("preserves target descendants beneath unsupported live parents", () => {
    const root = temporaryRoot();
    const ancestor = path.join(root, "ancestor");
    const target = path.join(root, "target");
    const live = path.join(root, "live");
    const external = path.join(root, "external");

    fs.mkdirSync(ancestor, { recursive: true });
    write(target, "skills/linked/SKILL.md", "new skill");
    fs.mkdirSync(path.join(live, "skills"), { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.symlinkSync(external, path.join(live, "skills/linked"), "dir");

    const planned = runJson("refresh-managed-plugin.mjs", [
      "--ancestor", ancestor,
      "--target", target,
      "--live", live,
    ]);
    expect(planned.actions).toEqual(expect.arrayContaining([
      { path: "skills/linked", decision: "preserve-unsupported-type" },
      { path: "skills/linked/SKILL.md", decision: "preserve-unsupported-type" },
    ]));

    const applied = runJson("refresh-managed-plugin.mjs", [
      "--ancestor", ancestor,
      "--target", target,
      "--live", live,
      "--apply-safe",
    ]);
    expect(applied.written).not.toContain("skills/linked/SKILL.md");
    expect(fs.existsSync(path.join(external, "SKILL.md"))).toBe(false);
    expect(fs.lstatSync(path.join(live, "skills/linked")).isSymbolicLink()).toBe(true);
  });

  it("preserves target descendants beneath live file parents", () => {
    const root = temporaryRoot();
    const ancestor = path.join(root, "ancestor");
    const target = path.join(root, "target");
    const live = path.join(root, "live");

    fs.mkdirSync(ancestor, { recursive: true });
    write(target, "skills/blocked/SKILL.md", "new skill");
    write(live, "skills/blocked", "operator file");

    const planned = runJson("refresh-managed-plugin.mjs", [
      "--ancestor", ancestor,
      "--target", target,
      "--live", live,
    ]);
    expect(planned.actions).toEqual(expect.arrayContaining([
      { path: "skills/blocked", decision: "preserve-live-only" },
      { path: "skills/blocked/SKILL.md", decision: "preserve-unsupported-type" },
    ]));

    const applied = runJson("refresh-managed-plugin.mjs", [
      "--ancestor", ancestor,
      "--target", target,
      "--live", live,
      "--apply-safe",
    ]);
    expect(applied.written).not.toContain("skills/blocked/SKILL.md");
    expect(fs.readFileSync(path.join(live, "skills/blocked"), "utf8")).toBe("operator file");
    expect(fs.existsSync(path.join(live, "skills/blocked/SKILL.md"))).toBe(false);
  });
});

describe("backup-sqlite helper", () => {
  it("creates a verified backup without changing the source database", () => {
    const sqlite = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
    if (sqlite.status !== 0) return;

    const root = temporaryRoot();
    const source = path.join(root, "openrig.sqlite");
    const destination = path.join(root, "openrig.backup.sqlite");
    execFileSync("sqlite3", [source, "CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('kept');"]);
    const before = fs.readFileSync(source);

    const receipt = runJson("backup-sqlite.mjs", [
      "--source", source,
      "--destination", destination,
    ]);
    expect(receipt.integrity).toBe("ok");
    expect(receipt.destination).toBe(destination);
    expect(fs.readFileSync(source)).toEqual(before);
    expect(execFileSync("sqlite3", [destination, "SELECT value FROM proof;"], { encoding: "utf8" }).trim()).toBe("kept");
  });

  it("refuses to overwrite an existing destination", () => {
    const sqlite = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
    if (sqlite.status !== 0) return;

    const root = temporaryRoot();
    const source = path.join(root, "openrig.sqlite");
    const destination = path.join(root, "existing.sqlite");
    execFileSync("sqlite3", [source, "CREATE TABLE proof(value TEXT);"]);
    fs.writeFileSync(destination, "keep this");

    const result = spawnSync(process.execPath, [
      path.join(skillRoot, "scripts", "backup-sqlite.mjs"),
      "--source", source,
      "--destination", destination,
    ], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual(expect.objectContaining({
      ok: false,
      error: expect.stringMatching(/destination already exists/i),
      next: expect.stringMatching(/never overwrites/i),
    }));
    expect(fs.readFileSync(destination, "utf8")).toBe("keep this");
  });
});

describe("inspect-upgrade helper", () => {
  it("keeps all-rig node evidence and teaches the next probe when a surface is unavailable", () => {
    const root = temporaryRoot();
    const fakeRig = path.join(root, "rig");
    fs.writeFileSync(fakeRig, `#!/bin/sh
case "$*" in
  "--version") echo "0.5.7 (abc12345)" ;;
  "daemon status") echo 'Daemon running (pid 42)' ;;
  "ps --nodes -A --json") echo '[{"rigName":"demo","logicalId":"lead"},{"rigName":"other","logicalId":"worker"}]' ;;
  "plugin list --json") echo 'plugin lookup unavailable' >&2; exit 9 ;;
  *) exit 7 ;;
esac
`, { mode: 0o755 });

    const report = runJson("inspect-upgrade.mjs", [], { OPENRIG_RIG_BIN: fakeRig });
    expect(report.rigVersion.ok).toBe(true);
    expect(report.daemonStatus.ok).toBe(true);
    expect(report.nodes.ok).toBe(true);
    expect(report.nodes.command).toEqual([fakeRig, "ps", "--nodes", "-A", "--json"]);
    expect(report.nodes.value).toEqual([
      { rigName: "demo", logicalId: "lead" },
      { rigName: "other", logicalId: "worker" },
    ]);
    expect(report.plugins.ok).toBe(false);
    expect(report.plugins.next).toMatch(/run .*plugin list --json/i);
    expect(report.ready).toBe(false);
  });
});

describe("0.5.9 telemetry-state migration helper", () => {
  const helper = "migrate-telemetry-state-0.5.9.mjs";

  it("prints help without inventorying and refuses unknown options before planning", () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    const rigCalled = path.join(root, "rig-called");
    const fakeRig = path.join(root, "rig");
    fs.writeFileSync(fakeRig, `#!/bin/sh
: > ${JSON.stringify(rigCalled)}
exit 7
`, { mode: 0o755 });
    const scriptPath = path.join(skillRoot, "scripts", helper);
    const env = { ...process.env, OPENRIG_HOME: "", OPENRIG_RIG_BIN: fakeRig };

    const help = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8", env });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage: migrate-telemetry-state-0.5.9.mjs");
    expect(help.stdout).toContain("No phase flag runs the read-only plan");
    expect(help.stdout).toContain("--apply-state");
    expect(help.stdout).toContain("--verify");
    expect(help.stdout).toContain("--apply-library");
    expect(help.stdout).toContain("--rollback");
    expect(fs.existsSync(rigCalled)).toBe(false);
    expect(fs.existsSync(home)).toBe(false);

    const unknown = spawnSync(process.execPath, [scriptPath, "--home", home, "--mystery"], {
      encoding: "utf8",
      env,
    });
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(JSON.parse(unknown.stderr)).toMatchObject({
      phase: "input",
      ok: false,
      issues: [{ code: "unknown_option", option: "--mystery" }],
    });
    expect(fs.existsSync(rigCalled)).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
  });

  it("routes the no-flag plan and every mutually exclusive phase distinctly", () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    const fakeRig = writeRigInventory(root, []);
    const env = { OPENRIG_RIG_BIN: fakeRig };

    expect(runJson(helper, ["--home", home], env).phase).toBe("plan");
    for (const [args, phase] of [
      [["--apply-state"], "apply-state"],
      [["--verify"], "verify"],
      [["--apply-library"], "apply-library"],
      [["--rollback", path.join(root, "missing-preimage")], "rollback"],
    ] as const) {
      const result = runJsonResult(helper, ["--home", home, ...args], env);
      expect(result.status, phase).toBe(1);
      expect(result.body.phase).toBe(phase);
    }

    const conflict = runJsonResult(helper, ["--home", home, "--apply-state", "--verify"], env);
    expect(conflict.status).toBe(1);
    expect(conflict.body).toMatchObject({
      phase: "input",
      ok: false,
      issues: [{ code: "phase_conflict" }],
    });
  });

  function prepareLibraryMigration(
    root: string,
    seedLibrary: (fixture: ReturnType<typeof seedLegacyTelemetry>) => void,
  ) {
    const fixture = seedLegacyTelemetry(root);
    fs.mkdirSync(path.join(fixture.home, "context", "system"));
    seedLibrary(fixture);
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before-layout");
    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    write(fixture.home, "context/system/system-world.yaml", DEFAULT_SYSTEM_WORLD_MANIFEST);
    const collector = path.join(repoRoot, "packages", "daemon", "assets", "claude-statusline-context.cjs");
    const collected = spawnSync(process.execPath, [
      collector,
      path.join(fixture.home, "state", "context-usage"),
      path.join(fixture.home, "state", "provider-usage"),
    ], {
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "session-1",
        session_name: fixture.sessionName,
        context_window: { context_window_size: 200_000, used_percentage: 26 },
      }),
    });
    expect(collected.status, collected.stderr).toBe(0);
    const verification = runJson(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    expect(verification).toMatchObject({ phase: "verify", verified: true, complete: true, issues: [] });
    const verificationPath = path.join(root, "verification.json");
    fs.writeFileSync(verificationPath, JSON.stringify(verification));
    return { fixture, env, preimage, verificationPath };
  }

  it("prepares the compatibility bridge without moving live state and finalizes by copy without deleting the recovery source", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    write(fixture.home, "context-packs/operator-pack/manifest.yaml", "name: operator-pack\nversion: \"1\"\ntaxonomy: world\nfiles: []\n");
    const legacyContext = path.join(fixture.home, "context", `${fixture.sessionName}.json`);
    const legacyProvider = path.join(fixture.home, "provider-usage", `${fixture.sessionName}.json`);
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "agent-managed-prepare");

    const prepared = runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    expect(prepared).toMatchObject({ phase: "apply-state", applied: true, complete: false });
    expect(fs.existsSync(legacyContext)).toBe(true);
    expect(fs.existsSync(legacyProvider)).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "state", "context-usage", `${fixture.sessionName}.json`))).toBe(false);
    expect(fs.existsSync(path.join(fixture.home, "state", "provider-usage", `${fixture.sessionName}.json`))).toBe(false);
    expect(fs.readFileSync(fixture.settingsPath, "utf8")).toBe(fixture.originalSettings);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.home, "config.json"), "utf8"))).toMatchObject({
      context: { root: path.join(fixture.home, "context-packs") },
    });

    write(fixture.home, "context/system/system-world.yaml", DEFAULT_SYSTEM_WORLD_MANIFEST);
    const manifest = JSON.parse(fs.readFileSync(path.join(preimage, "manifest.json"), "utf8"));
    const adoptedAt = new Date(Date.parse(manifest.appliedAt) + 2_000).toISOString();
    writeTelemetryPair(fixture, "state", adoptedAt, 31);
    const verification = runJson(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    const verificationPath = path.join(root, "verification.json");
    fs.writeFileSync(verificationPath, JSON.stringify(verification));

    const finalized = runJson(helper, [
      "--home", fixture.home,
      "--apply-library",
      "--preimage", preimage,
      "--verification", verificationPath,
    ], env);
    expect(finalized).toMatchObject({ phase: "apply-library", applied: true, complete: true, issues: [] });
    expect(fs.existsSync(path.join(fixture.home, "context-packs", "operator-pack", "manifest.yaml"))).toBe(true);
    expect(fs.existsSync(legacyContext)).toBe(true);
    expect(fs.existsSync(legacyProvider)).toBe(true);
    expect(fs.readFileSync(path.join(fixture.home, "context", "operator-pack", "manifest.yaml"), "utf8"))
      .toContain("operator-pack");
    expect(JSON.parse(fs.readFileSync(path.join(fixture.home, "config.json"), "utf8"))).toMatchObject({
      context: { root: path.join(fixture.home, "context") },
    });
  });

  it("plans read-only, prepares without replaying state, verifies real canonical samples, and rolls back only owned effects", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "telemetry-state-before-0.5.9");

    const planned = runJson(helper, ["--home", fixture.home], env);
    expect(planned).toEqual(expect.objectContaining({
      schema: "openrig-telemetry-state-migration/v1",
      phase: "plan",
      applied: false,
      complete: true,
    }));
    expect(planned.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: "preserve-legacy-fallback", kind: "context", path: expect.stringContaining("/context/") }),
      expect.objectContaining({ decision: "preserve-legacy-fallback", kind: "provider", path: expect.stringContaining("/provider-usage/") }),
      expect.objectContaining({ decision: "pin-library-during-activation", to: path.join(fixture.home, "context-packs") }),
    ]));
    expect(fs.existsSync(path.join(fixture.home, "state"))).toBe(false);

    const applied = runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    expect(applied).toEqual(expect.objectContaining({ phase: "apply-state", applied: true, complete: false }));
    expect(applied.next).toMatch(/canonical-only writes/i);
    expect(fs.existsSync(path.join(fixture.home, "state", "context-usage", `${fixture.sessionName}.json`))).toBe(false);
    expect(fs.existsSync(path.join(fixture.home, "state", "provider-usage", `${fixture.sessionName}.json`))).toBe(false);
    expect(fs.readFileSync(fixture.settingsPath, "utf8")).toBe(fixture.originalSettings);
    const manifest = JSON.parse(fs.readFileSync(path.join(preimage, "manifest.json"), "utf8"));
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        originalPath: path.join(fixture.home, "context", `${fixture.sessionName}.json`),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        storedAs: expect.stringMatching(/^files\/\d{4}-[a-f0-9]{64}$/),
      }),
    ]));
    expect(manifest.libraryPlan).toMatchObject({
      sourceRoot: path.join(fixture.home, "context-packs"),
      targetRoot: path.join(fixture.home, "context"),
    });

    const beforeFreshSample = runJsonResult(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    expect(beforeFreshSample.status).toBe(1);
    expect(beforeFreshSample.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_fresh_sample" }),
    ]));

    const collector = path.join(repoRoot, "packages", "daemon", "assets", "claude-statusline-context.cjs");
    const collected = spawnSync(process.execPath, [
      collector,
      path.join(fixture.home, "state", "context-usage"),
      path.join(fixture.home, "state", "provider-usage"),
    ], {
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "session-1",
        session_name: fixture.sessionName,
        context_window: { context_window_size: 200_000, used_percentage: 26 },
      }),
    });
    expect(collected.status, collected.stderr).toBe(0);

    const verified = runJson(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    expect(verified).toEqual(expect.objectContaining({ phase: "verify", complete: true, verified: true }));
    expect(verified.freshSamples).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionName: fixture.sessionName }),
    ]));

    const rolledBack = runJson(helper, ["--home", fixture.home, "--rollback", preimage], env);
    expect(rolledBack).toEqual(expect.objectContaining({ phase: "rollback", complete: true, rolledBack: true }));
    expect(fs.readFileSync(fixture.settingsPath, "utf8")).toBe(fixture.originalSettings);
    expect(fs.existsSync(path.join(fixture.home, "state", "context-usage", `${fixture.sessionName}.json`))).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "config.json"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.home, "context", "system", "system-world.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.home, "context", `${fixture.sessionName}.json`))).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "provider-usage", `${fixture.sessionName}.json`))).toBe(true);
  });

  it("copies the legacy context library only after a verification receipt and leaves recovery sources intact", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    fs.mkdirSync(path.join(fixture.home, "context", "system"));
    write(fixture.home, "context-packs/operator-pack/manifest.yaml", "name: operator-pack\nversion: \"1\"\ntaxonomy: world\nfiles: []\n");
    const libraryFile = path.join(fixture.home, "context-packs", "operator-pack", "manifest.yaml");
    const libraryFileDigest = sha256(fs.readFileSync(libraryFile));
    const libraryDirectory = path.dirname(libraryFile);
    const libraryDirectoryRow = `operator-pack\0directory\0${fs.statSync(libraryDirectory).mode & 0o777}`;
    const libraryFileRow = `operator-pack/manifest.yaml\0${fs.statSync(libraryFile).mode & 0o777}\0${libraryFileDigest}`;
    const legacyLibraryDigest = sha256(`${libraryDirectoryRow}\n${libraryFileRow}`);
    write(fixture.home, "config.json", `${JSON.stringify({ keep: true, context: { packsRoot: path.join(fixture.home, "context-packs") } }, null, 2)}\n`);
    const originalConfig = fs.readFileSync(path.join(fixture.home, "config.json"));
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before-layout");

    const plan = runJson(helper, ["--home", fixture.home], env);
    expect(plan.complete).toBe(true);
    expect(plan.actions).toContainEqual({
      decision: "install-system-world",
      path: path.join(fixture.home, "context", "system", "system-world.yaml"),
    });

    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    write(fixture.home, "context/system/system-world.yaml", DEFAULT_SYSTEM_WORLD_MANIFEST);
    const collector = path.join(repoRoot, "packages", "daemon", "assets", "claude-statusline-context.cjs");
    const collected = spawnSync(process.execPath, [
      collector,
      path.join(fixture.home, "state", "context-usage"),
      path.join(fixture.home, "state", "provider-usage"),
    ], {
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "session-1",
        session_name: fixture.sessionName,
        context_window: { context_window_size: 200_000, used_percentage: 26 },
      }),
    });
    expect(collected.status, collected.stderr).toBe(0);
    const verification = runJson(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    const verificationPath = path.join(root, "verification.json");
    fs.writeFileSync(verificationPath, JSON.stringify(verification));

    const migrated = runJson(helper, [
      "--home", fixture.home,
      "--apply-library",
      "--preimage", preimage,
      "--verification", verificationPath,
    ], env);
    expect(migrated).toMatchObject({ phase: "apply-library", applied: true, complete: true, issues: [] });
    const completedManifest = JSON.parse(fs.readFileSync(path.join(preimage, "manifest.json"), "utf8"));
    expect(completedManifest.library.sourceTreeDigest).toBe(legacyLibraryDigest);
    expect(completedManifest.status).toBe("finalizer-applied");
    expect(completedManifest.library.targetTreeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(completedManifest.library.sourceTreeInventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "operator-pack/manifest.yaml", type: "file", sha256: libraryFileDigest }),
    ]));
    expect(completedManifest.library.copiedRoots).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "operator-pack" }),
    ]));
    expect(fs.existsSync(path.join(fixture.home, "context-packs"))).toBe(true);
    expect(fs.readFileSync(path.join(fixture.home, "context", "operator-pack", "manifest.yaml"), "utf8")).toContain("operator-pack");
    expect(fs.readFileSync(path.join(fixture.home, "context", "system", "system-world.yaml"), "utf8")).toBe(DEFAULT_SYSTEM_WORLD_MANIFEST);
    expect(fs.existsSync(path.join(fixture.home, "context", `${fixture.sessionName}.json`))).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "provider-usage"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.home, "config.json"), "utf8"))).toEqual({
      keep: true,
      context: { root: path.join(fixture.home, "context") },
    });

    const rolledBack = runJson(helper, ["--home", fixture.home, "--rollback", preimage], env);
    expect(rolledBack).toMatchObject({ phase: "rollback", complete: true, rolledBack: true, issues: [] });
    expect(fs.readFileSync(path.join(fixture.home, "config.json"))).toEqual(originalConfig);
    expect(fs.existsSync(path.join(fixture.home, "context-packs", "operator-pack", "manifest.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "context", "operator-pack"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.home, "context", `${fixture.sessionName}.json`))).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "provider-usage", `${fixture.sessionName}.json`))).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "state", "context-usage", `${fixture.sessionName}.json`))).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "context", "system"))).toBe(false);
    expect(fs.readFileSync(fixture.settingsPath, "utf8")).toBe(fixture.originalSettings);
  });

  it("refuses a directory-only library change after inventory before copying it", () => {
    const root = temporaryRoot();
    const prepared = prepareLibraryMigration(root, (fixture) => {
      write(fixture.home, "context-packs/operator-pack/a.txt", "alpha\n");
    });
    const lateDirectory = path.join(prepared.fixture.home, "context-packs", "operator-pack", "late-empty-directory");
    const helperPath = path.join(skillRoot, "scripts", helper);
    const interposedHelperPath = path.join(root, "migrate-directory-drift.mjs");
    const seam = `  try {\n    assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);\n    fs.mkdirSync(library.targetRoot, { recursive: true });`;
    const source = fs.readFileSync(helperPath, "utf8");
    expect(source.split(seam)).toHaveLength(2);
    fs.writeFileSync(interposedHelperPath, source.replace(seam, `  try {\n    fs.mkdirSync(${JSON.stringify(lateDirectory)});\n    assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);\n    fs.mkdirSync(library.targetRoot, { recursive: true });`));

    const result = runJsonFileResult(interposedHelperPath, [
      "--home", prepared.fixture.home,
      "--apply-library",
      "--preimage", prepared.preimage,
      "--verification", prepared.verificationPath,
    ], prepared.env);
    expect(result.status).toBe(1);
    expect(result.body).toMatchObject({ phase: "apply-library", applied: false, complete: false });
    expect(result.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "library_source_drift" }),
    ]));
    expect(fs.existsSync(lateDirectory)).toBe(true);
    expect(fs.existsSync(path.join(prepared.fixture.home, "context", "operator-pack"))).toBe(false);
  });

  it("records an interrupted root copy so rollback preserves and names its partial residue", () => {
    const root = temporaryRoot();
    const prepared = prepareLibraryMigration(root, (fixture) => {
      write(fixture.home, "context-packs/operator-pack/a.txt", "alpha\n");
      write(fixture.home, "context-packs/operator-pack/b.txt", "beta\n");
    });
    const helperPath = path.join(skillRoot, "scripts", helper);
    const interposedHelperPath = path.join(root, "migrate-interrupted-copy.mjs");
    const seam = `function copyEntryOpaque(source, destination) {\n  const stat = fs.lstatSync(source);`;
    const source = fs.readFileSync(helperPath, "utf8");
    expect(source.split(seam)).toHaveLength(2);
    fs.writeFileSync(interposedHelperPath, source.replace(seam, `function copyEntryOpaque(source, destination) {\n  if (source.endsWith(${JSON.stringify(`${path.sep}b.txt`)})) throw new Error("injected mid-root copy interruption");\n  const stat = fs.lstatSync(source);`));

    const interrupted = runJsonFileResult(interposedHelperPath, [
      "--home", prepared.fixture.home,
      "--apply-library",
      "--preimage", prepared.preimage,
      "--verification", prepared.verificationPath,
    ], prepared.env);
    const partialRoot = path.join(prepared.fixture.home, "context", "operator-pack");
    expect(interrupted.status).toBe(1);
    expect(interrupted.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "library_apply_incomplete" }),
    ]));
    expect(fs.readdirSync(partialRoot)).toEqual(["a.txt"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(prepared.preimage, "manifest.json"), "utf8"));
    expect(manifest.status).toBe("finalizer-copying");
    expect(manifest.library.copiedRoots).toEqual([
      expect.objectContaining({ name: "operator-pack" }),
    ]);

    const rolledBack = runJsonFileResult(helperPath, [
      "--home", prepared.fixture.home,
      "--rollback", prepared.preimage,
    ], prepared.env);
    expect(rolledBack.status).toBe(1);
    expect(rolledBack.body).toMatchObject({ phase: "rollback", rolledBack: false, complete: false });
    expect(rolledBack.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "destination_drift", path: partialRoot }),
    ]));
    expect(fs.readdirSync(partialRoot)).toEqual(["a.txt"]);
  });

  it("copies and rolls back an opaque project-context symlink without reading or claiming its target", () => {
    const root = temporaryRoot();
    let projectPack = "";
    let legacyLink = "";
    const prepared = prepareLibraryMigration(root, (fixture) => {
      projectPack = path.join(fixture.home, "workspace", ".openrig", "context-packs", "context-engineering");
      write(projectPack, "manifest.yaml", "name: context-engineering\nversion: \"1\"\ntaxonomy: world\nfiles: []\n");
      legacyLink = path.join(fixture.home, "context-packs", "context-engineering");
      fs.mkdirSync(path.dirname(legacyLink), { recursive: true });
      fs.symlinkSync(projectPack, legacyLink, "dir");
    });
    const { fixture, env, preimage, verificationPath } = prepared;
    const originalLink = fs.lstatSync(legacyLink);
    const originalTargetBytes = fs.readFileSync(path.join(projectPack, "manifest.yaml"));

    const migrated = runJson(helper, [
      "--home", fixture.home,
      "--apply-library",
      "--preimage", preimage,
      "--verification", verificationPath,
    ], env);
    expect(migrated).toMatchObject({ phase: "apply-library", applied: true, complete: true, issues: [] });
    const migratedLink = path.join(fixture.home, "context", "context-engineering");
    expect(fs.lstatSync(migratedLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(migratedLink)).toBe(projectPack);
    expect(fs.lstatSync(migratedLink).ino).not.toBe(originalLink.ino);
    expect(fs.lstatSync(legacyLink).ino).toBe(originalLink.ino);
    const completed = JSON.parse(fs.readFileSync(path.join(preimage, "manifest.json"), "utf8"));
    expect(completed.library).toEqual(expect.objectContaining({
      sourceTreeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetTreeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceTreeInventory: expect.arrayContaining([
        expect.objectContaining({
          path: "context-engineering",
          type: "symlink",
          mode: originalLink.mode & 0o777,
          linkTargetBase64: Buffer.from(projectPack).toString("base64"),
          identity: { dev: String(originalLink.dev), ino: String(originalLink.ino) },
        }),
      ]),
    }));

    write(projectPack, "manifest.yaml", "project target changed after migration\n");
    const rolledBack = runJson(helper, ["--home", fixture.home, "--rollback", preimage], env);
    expect(rolledBack).toMatchObject({ phase: "rollback", complete: true, rolledBack: true, issues: [] });
    expect(fs.lstatSync(legacyLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(legacyLink)).toBe(projectPack);
    expect(fs.lstatSync(legacyLink).ino).toBe(originalLink.ino);
    expect(fs.existsSync(migratedLink)).toBe(false);
    expect(originalTargetBytes).not.toEqual(fs.readFileSync(path.join(projectPack, "manifest.yaml")));
  });

  it.each(["relative", "broken-relative", "absolute-outside"])(
    "preserves a %s child symlink as opaque library identity",
    (shape) => {
      const root = temporaryRoot();
      let linkPath = "";
      let linkTarget = "";
      const prepared = prepareLibraryMigration(root, (fixture) => {
        linkPath = path.join(fixture.home, "context-packs", "linked-pack");
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        if (shape === "relative") {
          const target = path.join(fixture.home, "workspace", ".openrig", "context-packs", "linked-pack");
          write(target, "manifest.yaml", "name: linked-pack\nversion: \"1\"\nfiles: []\n");
          linkTarget = "../workspace/.openrig/context-packs/linked-pack";
        } else if (shape === "broken-relative") {
          linkTarget = "../workspace/.openrig/context-packs/missing-pack";
        } else {
          const target = path.join(root, "outside-library", "linked-pack");
          write(target, "manifest.yaml", "outside target stays outside\n");
          linkTarget = target;
        }
        fs.symlinkSync(linkTarget, linkPath, "dir");
      });
      const original = fs.lstatSync(linkPath);

      const migrated = runJson(helper, [
        "--home", prepared.fixture.home,
        "--apply-library",
        "--preimage", prepared.preimage,
        "--verification", prepared.verificationPath,
      ], prepared.env);
      expect(migrated, shape).toMatchObject({ phase: "apply-library", applied: true, complete: true, issues: [] });
      const movedLink = path.join(prepared.fixture.home, "context", "linked-pack");
      expect(fs.lstatSync(movedLink).isSymbolicLink(), shape).toBe(true);
      expect(fs.readlinkSync(movedLink), shape).toBe(linkTarget);
      expect(fs.lstatSync(movedLink).ino, shape).not.toBe(original.ino);
      expect(fs.lstatSync(linkPath).ino, shape).toBe(original.ino);

      const rolledBack = runJson(helper, ["--home", prepared.fixture.home, "--rollback", prepared.preimage], prepared.env);
      expect(rolledBack, shape).toMatchObject({ phase: "rollback", complete: true, rolledBack: true, issues: [] });
      expect(fs.lstatSync(linkPath).isSymbolicLink(), shape).toBe(true);
      expect(fs.readlinkSync(linkPath), shape).toBe(linkTarget);
      expect(fs.lstatSync(linkPath).ino, shape).toBe(original.ino);
      expect(fs.existsSync(movedLink), shape).toBe(false);
    },
  );

  it.each(["payload", "type", "inode"])(
    "refuses pre-mutation library symlink %s drift and preserves the observed entry",
    (change) => {
      const root = temporaryRoot();
      let linkPath = "";
      const linkTarget = "../workspace/.openrig/context-packs/linked-pack";
      const prepared = prepareLibraryMigration(root, (fixture) => {
        const target = path.join(fixture.home, "workspace", ".openrig", "context-packs", "linked-pack");
        write(target, "manifest.yaml", "name: linked-pack\nversion: \"1\"\nfiles: []\n");
        linkPath = path.join(fixture.home, "context-packs", "linked-pack");
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        fs.symlinkSync(linkTarget, linkPath, "dir");
      });
      const original = fs.lstatSync(linkPath);
      const legacyContextPath = path.join(prepared.fixture.home, "context", `${prepared.fixture.sessionName}.json`);
      const legacyProviderPath = path.join(prepared.fixture.home, "provider-usage", `${prepared.fixture.sessionName}.json`);
      const contextBefore = fs.readFileSync(legacyContextPath);
      const providerBefore = fs.readFileSync(legacyProviderPath);
      const helperPath = path.join(skillRoot, "scripts", helper);
      const interposedHelperPath = path.join(root, `migrate-${change}.mjs`);
      const seam = `  try {\n    assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);\n    fs.mkdirSync(library.targetRoot, { recursive: true });`;
      const source = fs.readFileSync(helperPath, "utf8");
      expect(source.split(seam), change).toHaveLength(2);
      const replacement = change === "type"
        ? `fs.rmSync(${JSON.stringify(linkPath)}); fs.writeFileSync(${JSON.stringify(linkPath)}, "changed type");`
        : `fs.rmSync(${JSON.stringify(linkPath)}); fs.symlinkSync(${JSON.stringify(change === "payload" ? "changed-target" : linkTarget)}, ${JSON.stringify(linkPath)}, "dir");`;
      fs.writeFileSync(interposedHelperPath, source.replace(seam, `  try {\n    ${replacement}\n    assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);\n    fs.mkdirSync(library.targetRoot, { recursive: true });`));

      const result = runJsonFileResult(interposedHelperPath, [
        "--home", prepared.fixture.home,
        "--apply-library",
        "--preimage", prepared.preimage,
        "--verification", prepared.verificationPath,
      ], prepared.env);
      expect(result.status, change).toBe(1);
      expect(result.body, change).toMatchObject({ phase: "apply-library", applied: false, complete: false });
      expect(result.body.issues, change).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "library_source_drift" }),
      ]));
      expect(fs.readFileSync(legacyContextPath), change).toEqual(contextBefore);
      expect(fs.readFileSync(legacyProviderPath), change).toEqual(providerBefore);
      expect(fs.existsSync(path.join(prepared.fixture.home, "context", "linked-pack")), change).toBe(false);
      const manifest = JSON.parse(fs.readFileSync(path.join(prepared.preimage, "manifest.json"), "utf8"));
      expect(manifest.status, change).toBe("finalizer-prepared");
      expect(manifest.library.appliedAt, change).toBeUndefined();
      if (change === "type") {
        expect(fs.lstatSync(linkPath).isFile()).toBe(true);
        expect(fs.readFileSync(linkPath, "utf8")).toBe("changed type");
      } else {
        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(linkPath)).toBe(change === "payload" ? "changed-target" : linkTarget);
        if (change === "inode") expect(fs.lstatSync(linkPath).ino).not.toBe(original.ino);
      }
    },
  );

  it.each(["payload", "type", "inode"])(
    "refuses rollback when the migrated library symlink %s drifts",
    (change) => {
      const root = temporaryRoot();
      const linkTarget = "../workspace/.openrig/context-packs/linked-pack";
      const prepared = prepareLibraryMigration(root, (fixture) => {
        const target = path.join(fixture.home, "workspace", ".openrig", "context-packs", "linked-pack");
        write(target, "manifest.yaml", "name: linked-pack\nversion: \"1\"\nfiles: []\n");
        const linkPath = path.join(fixture.home, "context-packs", "linked-pack");
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        fs.symlinkSync(linkTarget, linkPath, "dir");
      });
      const migrated = runJson(helper, [
        "--home", prepared.fixture.home,
        "--apply-library",
        "--preimage", prepared.preimage,
        "--verification", prepared.verificationPath,
      ], prepared.env);
      expect(migrated).toMatchObject({ phase: "apply-library", applied: true, complete: true, issues: [] });

      const movedLink = path.join(prepared.fixture.home, "context", "linked-pack");
      const original = fs.lstatSync(movedLink);
      fs.rmSync(movedLink);
      if (change === "type") fs.writeFileSync(movedLink, "changed type");
      else fs.symlinkSync(change === "payload" ? "changed-target" : linkTarget, movedLink, "dir");
      const settingsBefore = fs.readFileSync(prepared.fixture.settingsPath);

      const result = runJsonFileResult(path.join(skillRoot, "scripts", helper), [
        "--home", prepared.fixture.home,
        "--rollback", prepared.preimage,
      ], prepared.env);
      expect(result.status, change).toBe(1);
      expect(result.body, change).toMatchObject({ phase: "rollback", rolledBack: false, complete: false });
      expect(result.body.issues, change).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "destination_drift" }),
      ]));
      expect(fs.existsSync(path.join(prepared.fixture.home, "context-packs")), change).toBe(true);
      expect(fs.readFileSync(prepared.fixture.settingsPath), change).toEqual(settingsBefore);
      expect(JSON.parse(fs.readFileSync(path.join(prepared.preimage, "manifest.json"), "utf8")).status, change)
        .toBe("finalizer-applied");
      if (change === "type") {
        expect(fs.lstatSync(movedLink).isFile()).toBe(true);
        expect(fs.readFileSync(movedLink, "utf8")).toBe("changed type");
      } else {
        expect(fs.lstatSync(movedLink).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(movedLink)).toBe(change === "payload" ? "changed-target" : linkTarget);
        if (change === "inode") expect(fs.lstatSync(movedLink).ino).not.toBe(original.ino);
      }
    },
  );

  it.each([
    { label: "matching-content", content: DEFAULT_SYSTEM_WORLD_MANIFEST },
    { label: "different-content", content: "operator-owned: true\n" },
  ])("refuses rollback when the managed System World path becomes a $label symlink", ({ content }) => {
    const root = temporaryRoot();
    const prepared = prepareLibraryMigration(root, (fixture) => {
      write(fixture.home, "context-packs/operator-pack/manifest.yaml", "name: operator-pack\nversion: \"1\"\nfiles: []\n");
    });
    const migrated = runJson(helper, [
      "--home", prepared.fixture.home,
      "--apply-library",
      "--preimage", prepared.preimage,
      "--verification", prepared.verificationPath,
    ], prepared.env);
    expect(migrated).toMatchObject({ phase: "apply-library", applied: true, complete: true, issues: [] });
    const manifest = JSON.parse(fs.readFileSync(path.join(prepared.preimage, "manifest.json"), "utf8"));
    expect(manifest.systemWorld).toMatchObject({
      existed: false,
      mode: 0o644,
      sha256: sha256(DEFAULT_SYSTEM_WORLD_MANIFEST),
    });

    const managedPath = path.join(prepared.fixture.home, "context", "system", "system-world.yaml");
    const externalTarget = path.join(root, "external-system-world.yaml");
    fs.rmSync(managedPath);
    write(root, "external-system-world.yaml", content);
    fs.symlinkSync(externalTarget, managedPath, "file");
    const observed = fs.lstatSync(managedPath);
    const settingsBefore = fs.readFileSync(prepared.fixture.settingsPath);

    const result = runJsonResult(helper, ["--home", prepared.fixture.home, "--rollback", prepared.preimage], prepared.env);
    expect(result.status).toBe(1);
    expect(result.body).toMatchObject({ phase: "rollback", rolledBack: false, complete: false });
    expect(result.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "destination_drift", path: managedPath }),
    ]));
    expect(fs.lstatSync(managedPath).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(managedPath).ino).toBe(observed.ino);
    expect(fs.readlinkSync(managedPath)).toBe(externalTarget);
    expect(fs.readFileSync(externalTarget, "utf8")).toBe(content);
    expect(fs.existsSync(path.join(prepared.fixture.home, "context-packs"))).toBe(true);
    expect(fs.readFileSync(prepared.fixture.settingsPath)).toEqual(settingsBefore);
  });

  it("refuses a symlinked library root before changing live state", () => {
    const root = temporaryRoot();
    let externalLibrary = "";
    let sourceRoot = "";
    const prepared = prepareLibraryMigration(root, (fixture) => {
      externalLibrary = path.join(root, "external-library");
      write(externalLibrary, "pack/manifest.yaml", "name: pack\nversion: \"1\"\nfiles: []\n");
      sourceRoot = path.join(fixture.home, "context-packs");
      fs.symlinkSync(externalLibrary, sourceRoot, "dir");
    });
    const legacyContextPath = path.join(prepared.fixture.home, "context", `${prepared.fixture.sessionName}.json`);
    const legacyProviderPath = path.join(prepared.fixture.home, "provider-usage", `${prepared.fixture.sessionName}.json`);
    const contextBefore = fs.readFileSync(legacyContextPath);
    const providerBefore = fs.readFileSync(legacyProviderPath);

    const result = runJsonResult(helper, [
      "--home", prepared.fixture.home,
      "--apply-library",
      "--preimage", prepared.preimage,
      "--verification", prepared.verificationPath,
    ], prepared.env);
    expect(result.status).toBe(1);
    expect(result.body).toMatchObject({ phase: "apply-library", applied: false, complete: false });
    expect(result.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "library_source_invalid", path: sourceRoot }),
    ]));
    expect(fs.lstatSync(sourceRoot).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(externalLibrary, "pack", "manifest.yaml"), "utf8")).toContain("name: pack");
    expect(fs.readFileSync(legacyContextPath)).toEqual(contextBefore);
    expect(fs.readFileSync(legacyProviderPath)).toEqual(providerBefore);
    const manifest = JSON.parse(fs.readFileSync(path.join(prepared.preimage, "manifest.json"), "utf8"));
    expect(manifest.status).toBe("applied");
  });

  it.each([
    { name: "differing", systemWorld: "operator-owned: true\n", extraFile: null },
    { name: "additional", systemWorld: DEFAULT_SYSTEM_WORLD_MANIFEST, extraFile: "operator-note.yaml" },
  ])("refuses $name System World content created between apply-state and verify", ({ systemWorld, extraFile }) => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    fs.mkdirSync(path.join(fixture.home, "context", "system"));
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before-layout");

    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    const manifest = JSON.parse(fs.readFileSync(path.join(preimage, "manifest.json"), "utf8"));
    const freshAt = new Date(Date.parse(manifest.appliedAt) + 2_000).toISOString();
    write(fixture.home, "context/system/system-world.yaml", systemWorld);
    if (extraFile) write(fixture.home, `context/system/${extraFile}`, "operator-owned: true\n");
    writeTelemetryPair(fixture, "state", freshAt, 26);

    const result = runJsonResult(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    expect(result.status).toBe(1);
    expect(result.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "system_world_conflict",
        path: expect.stringContaining(path.join(fixture.home, "context", "system")),
      }),
    ]));
    expect(fs.readFileSync(path.join(fixture.home, "context", "system", "system-world.yaml"), "utf8"))
      .toBe(systemWorld);
    if (extraFile) {
      expect(fs.readFileSync(path.join(fixture.home, "context", "system", extraFile), "utf8"))
        .toBe("operator-owned: true\n");
    }
  });

  it("accepts a bounded legacy tail followed by newer paired state samples and leaves the tail in place", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    write(fixture.home, "context-packs/operator-pack/manifest.yaml", "name: operator-pack\nversion: \"1\"\ntaxonomy: world\nfiles: []\n");
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before-layout");

    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    const appliedManifest = JSON.parse(fs.readFileSync(path.join(preimage, "manifest.json"), "utf8"));
    const tailAt = new Date(Date.parse(appliedManifest.appliedAt) + 1_000).toISOString();
    const adoptedAt = new Date(Date.parse(appliedManifest.appliedAt) + 2_000).toISOString();
    writeTelemetryPair(fixture, "legacy", tailAt, 30);
    writeTelemetryPair(fixture, "state", adoptedAt, 31);
    const tailContext = fs.readFileSync(path.join(fixture.home, "context", `${fixture.sessionName}.json`));
    const tailProvider = fs.readFileSync(path.join(fixture.home, "provider-usage", `${fixture.sessionName}.json`));

    const verification = runJson(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    expect(verification).toMatchObject({ phase: "verify", verified: true, complete: true, issues: [] });
    expect(verification.legacyTails).toEqual([
      expect.objectContaining({ kind: "context", sessionName: fixture.sessionName, observedAt: tailAt }),
      expect.objectContaining({ kind: "provider", sessionName: fixture.sessionName, observedAt: tailAt }),
    ]);
    const verificationPath = path.join(root, "verification.json");
    fs.writeFileSync(verificationPath, JSON.stringify(verification));

    const migrated = runJson(helper, [
      "--home", fixture.home,
      "--apply-library",
      "--preimage", preimage,
      "--verification", verificationPath,
    ], env);
    expect(migrated).toMatchObject({ phase: "apply-library", applied: true, complete: true, issues: [] });
    expect(fs.readFileSync(path.join(fixture.home, "context", `${fixture.sessionName}.json`))).toEqual(tailContext);
    expect(fs.readFileSync(path.join(fixture.home, "provider-usage", `${fixture.sessionName}.json`))).toEqual(tailProvider);
    expect(fs.existsSync(path.join(fixture.home, "context-packs", "operator-pack", "manifest.yaml"))).toBe(true);

    const rolledBack = runJson(helper, ["--home", fixture.home, "--rollback", preimage], env);
    expect(rolledBack).toMatchObject({ phase: "rollback", complete: true, rolledBack: true, issues: [] });
    expect(fs.readFileSync(path.join(fixture.home, "context", `${fixture.sessionName}.json`))).toEqual(tailContext);
    expect(fs.readFileSync(path.join(fixture.home, "provider-usage", `${fixture.sessionName}.json`))).toEqual(tailProvider);
    expect(fs.existsSync(path.join(fixture.home, "context-packs", "operator-pack", "manifest.yaml"))).toBe(true);
  });

  it("refuses verification when a preimage-bound legacy source disappears", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before");

    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    const manifest = JSON.parse(fs.readFileSync(path.join(preimage, "manifest.json"), "utf8"));
    const adoptedAt = new Date(Date.parse(manifest.appliedAt) + 1_000).toISOString();
    const legacyContextPath = path.join(fixture.home, "context", `${fixture.sessionName}.json`);
    fs.rmSync(legacyContextPath);
    writeTelemetryPair(fixture, "state", adoptedAt, 30);

    const result = runJsonResult(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    expect(result.status).toBe(1);
    expect(result.body).toMatchObject({ phase: "verify", verified: false, complete: false });
    expect(result.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "legacy_source_drift", path: legacyContextPath }),
    ]));
  });

  it("refuses a legacy writer whose newest write follows its paired state samples", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before");

    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    const manifest = JSON.parse(fs.readFileSync(path.join(preimage, "manifest.json"), "utf8"));
    const adoptedAt = new Date(Date.parse(manifest.appliedAt) + 1_000).toISOString();
    const resumedAt = new Date(Date.parse(manifest.appliedAt) + 2_000).toISOString();
    writeTelemetryPair(fixture, "state", adoptedAt, 30);
    writeTelemetryPair(fixture, "legacy", resumedAt, 31);

    const result = runJsonResult(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    expect(result.status).toBe(1);
    expect(result.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "legacy_writer_active", sessionName: fixture.sessionName }),
    ]));
  });

  it("refuses legacy-byte drift between verify and apply-library", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    write(fixture.home, "context-packs/operator-pack/manifest.yaml", "name: operator-pack\nversion: \"1\"\ntaxonomy: world\nfiles: []\n");
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before");

    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    const manifest = JSON.parse(fs.readFileSync(path.join(preimage, "manifest.json"), "utf8"));
    const tailAt = new Date(Date.parse(manifest.appliedAt) + 1_000).toISOString();
    const adoptedAt = new Date(Date.parse(manifest.appliedAt) + 2_000).toISOString();
    writeTelemetryPair(fixture, "legacy", tailAt, 30);
    writeTelemetryPair(fixture, "state", adoptedAt, 31);
    const verification = runJson(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    const verificationPath = path.join(root, "verification.json");
    fs.writeFileSync(verificationPath, JSON.stringify(verification));

    const resumedAt = new Date(Date.parse(manifest.appliedAt) + 3_000).toISOString();
    writeTelemetryPair(fixture, "legacy", resumedAt, 32);
    const result = runJsonResult(helper, [
      "--home", fixture.home,
      "--apply-library",
      "--preimage", preimage,
      "--verification", verificationPath,
    ], env);
    expect(result.status).toBe(1);
    expect(result.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "legacy_source_drift" }),
    ]));
    expect(fs.existsSync(path.join(fixture.home, "context-packs", "operator-pack", "manifest.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "context", `${fixture.sessionName}.json`))).toBe(true);
  });

  it("refuses a resumed legacy writer immediately before the final config switch", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    write(fixture.home, "context-packs/operator-pack/manifest.yaml", "name: operator-pack\nversion: \"1\"\ntaxonomy: world\nfiles: []\n");
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before");

    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    const manifest = JSON.parse(fs.readFileSync(path.join(preimage, "manifest.json"), "utf8"));
    const tailAt = new Date(Date.parse(manifest.appliedAt) + 1_000).toISOString();
    const adoptedAt = new Date(Date.parse(manifest.appliedAt) + 2_000).toISOString();
    writeTelemetryPair(fixture, "legacy", tailAt, 30);
    writeTelemetryPair(fixture, "state", adoptedAt, 31);
    const contextPath = path.join(fixture.home, "context", `${fixture.sessionName}.json`);
    const verification = runJson(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    const verificationPath = path.join(root, "verification.json");
    fs.writeFileSync(verificationPath, JSON.stringify(verification));

    const seam = "    assertLegacySourcesStillVerified(\n";
    const helperPath = path.join(skillRoot, "scripts", helper);
    const interposedHelperPath = path.join(root, helper);
    const source = fs.readFileSync(helperPath, "utf8");
    expect(source.split(seam)).toHaveLength(2);
    fs.writeFileSync(interposedHelperPath, source.replace(seam, `    {
      const target = ${JSON.stringify(contextPath)};
      fs.writeFileSync(target, "resumed legacy writer", { mode: 0o600 });
    }
${seam}`));

    const result = runJsonFileResult(interposedHelperPath, [
      "--home", fixture.home,
      "--apply-library",
      "--preimage", preimage,
      "--verification", verificationPath,
    ], env);
    expect(result.status).toBe(1);
    expect(result.body).toMatchObject({ phase: "apply-library", applied: false, complete: false });
    expect(result.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "legacy_source_drift", path: contextPath }),
    ]));
    expect(fs.readFileSync(contextPath, "utf8")).toBe("resumed legacy writer");
    expect(JSON.parse(fs.readFileSync(path.join(fixture.home, "config.json"), "utf8")).context.root)
      .toBe(path.join(fixture.home, "context-packs"));
  });

  it("refuses library mutation without the exact successful verification receipt", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    write(fixture.home, "context-packs/pack/manifest.yaml", "name: pack\nversion: \"1\"\ntaxonomy: world\nfiles: []\n");
    const fakeRig = writeRigInventory(root, []);
    const preimage = path.join(fixture.home, "backups", "before-layout");
    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], { OPENRIG_RIG_BIN: fakeRig });
    const receipt = path.join(root, "verification.json");
    fs.writeFileSync(receipt, JSON.stringify({ schema: "openrig-telemetry-state-migration/v1", phase: "verify", home: fixture.home, complete: false }));

    const result = runJsonResult(helper, [
      "--home", fixture.home,
      "--apply-library",
      "--preimage", preimage,
      "--verification", receipt,
    ], { OPENRIG_RIG_BIN: fakeRig });
    expect(result.status).toBe(1);
    expect(result.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "verification_receipt_invalid" })]));
    expect(fs.existsSync(path.join(fixture.home, "context-packs", "pack", "manifest.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "context", `${fixture.sessionName}.json`))).toBe(true);
  });

  it("refuses a reserved legacy-library System World conflict before finalizer mutation", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    write(fixture.home, "context-packs/operator-pack/manifest.yaml", "name: operator-pack\nversion: \"1\"\ntaxonomy: world\nfiles: []\n");
    write(fixture.home, "context-packs/system", "operator-owned conflict\n");
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before-layout");

    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    const collector = path.join(repoRoot, "packages", "daemon", "assets", "claude-statusline-context.cjs");
    const collected = spawnSync(process.execPath, [
      collector,
      path.join(fixture.home, "state", "context-usage"),
      path.join(fixture.home, "state", "provider-usage"),
    ], {
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "session-1",
        session_name: fixture.sessionName,
        context_window: { context_window_size: 200_000, used_percentage: 26 },
      }),
    });
    expect(collected.status, collected.stderr).toBe(0);
    const verification = runJson(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    const verificationPath = path.join(root, "verification.json");
    fs.writeFileSync(verificationPath, JSON.stringify(verification));

    const interrupted = runJsonResult(helper, [
      "--home", fixture.home,
      "--apply-library",
      "--preimage", preimage,
      "--verification", verificationPath,
    ], env);
    expect(interrupted.status).toBe(1);
    expect(interrupted.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "system_world_conflict" })]));
    expect(fs.existsSync(path.join(fixture.home, "context-packs", "operator-pack", "manifest.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "context", "operator-pack", "manifest.yaml"))).toBe(false);

    const rolledBack = runJson(helper, ["--home", fixture.home, "--rollback", preimage], env);
    expect(rolledBack).toMatchObject({ phase: "rollback", complete: true, rolledBack: true, issues: [] });
    expect(fs.readFileSync(path.join(fixture.home, "context-packs", "system"), "utf8")).toBe("operator-owned conflict\n");
    expect(fs.existsSync(path.join(fixture.home, "context", `${fixture.sessionName}.json`))).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, "provider-usage", `${fixture.sessionName}.json`))).toBe(true);
    expect(fs.readFileSync(fixture.settingsPath, "utf8")).toBe(fixture.originalSettings);
  });

  it("reports malformed, foreign, and reserved System World inputs without reviving controller assumptions", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    write(fixture.home, "context/broken.json", "not json");
    write(fixture.home, "context/foreign.txt", "leave me alone");
    write(fixture.home, "context/system/user-owned.yaml", "preserve: true\n");
    write(fixture.home, "state/context-usage/existing.json", "{}");
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: "unknown-cwd@test-rig",
      cwd: null,
    }]);

    const planned = runJson(helper, ["--home", fixture.home], { OPENRIG_RIG_BIN: fakeRig });
    expect(planned.complete).toBe(false);
    expect(planned.issues.map((issue: { code: string }) => issue.code)).toEqual(expect.arrayContaining([
      "malformed_sidecar",
      "foreign_file",
      "system_world_conflict",
    ]));
    expect(planned.issues.map((issue: { code: string }) => issue.code)).not.toEqual(expect.arrayContaining([
      "unknown_live_cwd",
      "target_nonempty",
    ]));
    expect(planned.issues).toContainEqual(expect.objectContaining({
      code: "foreign_file",
      path: path.join(fixture.home, "context", "foreign.txt"),
    }));
    expect(fs.readFileSync(fixture.settingsPath, "utf8")).toBe(fixture.originalSettings);
  });

  it("refuses an unwriteable target ancestor without mutation", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    write(fixture.home, "state", "not a directory");
    const fakeRig = writeRigInventory(root, []);

    const planned = runJson(helper, ["--home", fixture.home], { OPENRIG_RIG_BIN: fakeRig });
    expect(planned.complete).toBe(false);
    expect(planned.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unwriteable_target", blockingPath: path.join(fixture.home, "state") }),
    ]));
    expect(fs.readFileSync(fixture.settingsPath, "utf8")).toBe(fixture.originalSettings);
  });

  it("does not rewrite live collector settings when several Claude seats share a cwd", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    const fakeRig = writeRigInventory(root, [
      {
        runtime: "claude-code",
        sessionStatus: "running",
        canonicalSessionName: fixture.sessionName,
        cwd: fixture.cwd,
      },
      {
        runtime: "claude-code",
        sessionStatus: "running",
        canonicalSessionName: "dev-review@test-rig",
        cwd: fixture.cwd,
      },
    ]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before");

    const planned = runJson(helper, ["--home", fixture.home], env);
    expect(planned.actions.filter((action: { decision: string }) => action.decision === "rewrite-collector")).toHaveLength(0);
    const applied = runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    expect(applied).toEqual(expect.objectContaining({ applied: true, issues: [] }));
    expect(fs.readFileSync(fixture.settingsPath, "utf8")).toBe(fixture.originalSettings);
  });

  it("does not depend on live collector cwd writability during preparation", () => {
    const root = temporaryRoot();
    const first = seedLegacyTelemetry(root, "dev-first@test-rig", "project-first");
    const second = seedLegacyTelemetry(root, "dev-second@test-rig", "project-second");
    const fakeRig = writeRigInventory(root, [first, second].map((fixture) => ({
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    })));
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(first.home, "backups", "before-interrupted-apply");
    const secondSettingsDir = path.dirname(second.settingsPath);

    fs.chmodSync(secondSettingsDir, 0o500);
    try {
      const applied = runJsonResult(helper, ["--home", first.home, "--apply-state", "--preimage", preimage], env);
      expect(applied.status).toBe(0);
      expect(applied.body).toEqual(expect.objectContaining({ applied: true, issues: [] }));
      expect(fs.readFileSync(first.settingsPath, "utf8")).toBe(first.originalSettings);
      expect(fs.readFileSync(second.settingsPath, "utf8")).toBe(second.originalSettings);

      const rolledBack = runJsonResult(helper, ["--home", first.home, "--rollback", preimage], env);
      expect(rolledBack.status).toBe(0);
      expect(rolledBack.body).toEqual(expect.objectContaining({ phase: "rollback", complete: true, rolledBack: true }));
      expect(fs.readFileSync(first.settingsPath, "utf8")).toBe(first.originalSettings);
      expect(fs.readFileSync(second.settingsPath, "utf8")).toBe(second.originalSettings);
    } finally {
      fs.chmodSync(secondSettingsDir, 0o755);
    }
  });

  it("refuses verify while a legacy collector is still writing", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before");
    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    fs.writeFileSync(path.join(fixture.home, "context", `${fixture.sessionName}.json`), JSON.stringify({
      context_window: { used_percentage: 30 },
      session_name: fixture.sessionName,
      sampled_at: "2099-01-01T00:00:00.000Z",
    }));

    const result = runJsonResult(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    expect(result.status).toBe(1);
    expect(result.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "legacy_writer_active", sessionName: fixture.sessionName }),
      expect.objectContaining({ code: "missing_fresh_sample" }),
    ]));
  });

  it("detects a legacy sidecar first created after apply", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before");
    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    write(fixture.home, "context/new-writer@test-rig.json", JSON.stringify({
      session_name: "new-writer@test-rig",
      sampled_at: "2099-01-01T00:00:00.000Z",
    }));

    const result = runJsonResult(helper, ["--home", fixture.home, "--verify", "--preimage", preimage], env);
    expect(result.status).toBe(1);
    expect(result.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "legacy_writer_active", sessionName: "new-writer@test-rig" }),
    ]));
  });

  it("refuses rollback when a byte-addressed preimage no longer matches its manifest", () => {
    const root = temporaryRoot();
    const fixture = seedLegacyTelemetry(root);
    const fakeRig = writeRigInventory(root, [{
      runtime: "claude-code",
      sessionStatus: "running",
      canonicalSessionName: fixture.sessionName,
      cwd: fixture.cwd,
    }]);
    const env = { OPENRIG_RIG_BIN: fakeRig };
    const preimage = path.join(fixture.home, "backups", "before");
    runJson(helper, ["--home", fixture.home, "--apply-state", "--preimage", preimage], env);
    const manifest = JSON.parse(fs.readFileSync(path.join(preimage, "manifest.json"), "utf8"));
    fs.writeFileSync(path.join(preimage, manifest.files[0].storedAs), "tampered");
    const appliedSettings = fs.readFileSync(fixture.settingsPath, "utf8");

    const result = runJsonResult(helper, ["--home", fixture.home, "--rollback", preimage], env);
    expect(result.status).toBe(1);
    expect(result.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "preimage_mismatch" }),
    ]));
    expect(fs.readFileSync(fixture.settingsPath, "utf8")).toBe(appliedSettings);
  });
});
