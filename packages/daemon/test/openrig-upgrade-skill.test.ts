import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const skillRoot = path.join(
  repoRoot,
  "packages/daemon/specs/agents/shared/skills/core/openrig-upgrade",
);
const skillPath = path.join(skillRoot, "SKILL.md");
const temporaryRoots: string[] = [];

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

  it("ships three bounded helpers and mirrors them byte-for-byte", () => {
    for (const helper of ["inspect-upgrade.mjs", "backup-sqlite.mjs", "refresh-managed-plugin.mjs"]) {
      const source = path.join(skillRoot, "scripts", helper);
      const mirror = path.join(repoRoot, "skills/_canonical/core/openrig-upgrade/scripts", helper);
      expect(fs.existsSync(source), `missing source helper ${helper}`).toBe(true);
      expect(fs.existsSync(mirror), `missing mirrored helper ${helper}`).toBe(true);
      expect(fs.readFileSync(mirror)).toEqual(fs.readFileSync(source));
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
