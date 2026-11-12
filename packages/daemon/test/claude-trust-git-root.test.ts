// #2820: Claude Code 2.1.319 has two workspace-trust checks. The loose one accepts trust recorded for the cwd or any
// folder up to the git root; the strict one (the "gated grants" backstop) accepts only the canonical git root of the
// cwd. A seat below the git root whose tracked .claude/settings.json carries permissions.allow therefore stops on the
// "Quick safety check" screen, with the focus on "No, continue without these permissions", when OpenRig's pre-launch
// bootstrap seeds only the seat's folder.
//
// fixtures/claude-trust-git-root/trust-checks.json is a real capture: Claude Code 2.1.319 started in a lab git repo
// (a seat folder with a tracked .claude/settings.json, a symlink to the repo and a linked worktree) with a fake HOME and
// CLAUDE_CONFIG_DIR and different trust keys seeded, recording whether that screen appeared. The key the strict check
// read in each layout comes from those runs. These tests rebuild the same layout and check the state the bootstrap
// writes. Maintainer-owned file fixtures only: no native Claude, daemon, tmux, provider or real user configuration.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

type Capture = {
  cases: Record<string, { cwd: string; seeded: string[]; gatedGrantsScreen: boolean }>;
  strictTrustKey: Record<"subdir" | "link-subdir" | "wt-subdir", { key: string; passes: string; stops: string }>;
  gatedGrantsScreen: string[];
};
const capture = JSON.parse(fs.readFileSync(new URL("./fixtures/claude-trust-git-root/trust-checks.json", import.meta.url), "utf8")) as Capture;

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const git = (cwd: string, ...args: string[]) => execFileSync("git",
  ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args],
  { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });

/** The captured lab: repo/cadeiras/rig/seat with a tracked permissions.allow, link -> repo, wt = a linked worktree. */
function lab() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-trust-root-")));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const at = (rel: string) => rel === "." ? root : path.join(root, rel);
  const repo = at("repo");
  const seat = at("repo/cadeiras/rig/seat");
  fs.mkdirSync(path.join(seat, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(seat, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls:*)", "Bash(git status:*)"] } }));
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "seat");
  git(repo, "worktree", "add", "-q", "--detach", at("wt"));
  fs.symlinkSync(repo, at("link"));
  const home = at("home");
  fs.mkdirSync(home);
  return { root, at, repo, seat, home };
}

function adapterFor(home: string) {
  const statePath = path.join(home, ".claude.json");
  const writes: string[] = [];
  const fsOps: ClaudeAdapterFsOps = {
    homedir: home, exists: fs.existsSync, mkdirp: p => { fs.mkdirSync(p, { recursive: true }); },
    readFile: p => fs.readFileSync(p, "utf8"),
    writeFile: (p, text) => { writes.push(p); fs.writeFileSync(p, text); },
    copyFile: fs.copyFileSync, readdir: p => fs.readdirSync(p),
  };
  const adapter = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, fsOps, sleep: async () => {} });
  const state = () => JSON.parse(fs.readFileSync(statePath, "utf8")) as { projects: Record<string, Record<string, unknown>> } & Record<string, unknown>;
  return { adapter, statePath, writes, state };
}

const trusted = (projects: Record<string, Record<string, unknown>>) =>
  Object.keys(projects).filter(key => projects[key]?.hasTrustDialogAccepted === true).sort();

describe.skipIf(process.platform === "win32")("Claude pre-launch trust covers the canonical git root (#2820)", () => {
  it("the fixture is the real 2.1.319 capture: a seat below the git root stops on the gated-grants screen with only its own folder trusted", () => {
    const stops = capture.cases[capture.strictTrustKey.subdir.stops];
    const passes = capture.cases[capture.strictTrustKey.subdir.passes];
    expect(stops).toMatchObject({ cwd: "repo/cadeiras/rig/seat", seeded: ["repo/cadeiras/rig/seat"], gatedGrantsScreen: true });
    expect(passes).toMatchObject({ cwd: "repo/cadeiras/rig/seat", gatedGrantsScreen: false });
    expect(passes.seeded).toEqual(expect.arrayContaining(["repo", "repo/cadeiras/rig/seat"]));
    const screen = capture.gatedGrantsScreen.join("\n");
    expect(screen).toContain("Quick safety check");
    expect(screen).toContain("pre-approves 2 tool permissions in .claude/settings.json");
    expect(capture.gatedGrantsScreen.find(line => line.includes("❯"))).toContain("No, continue without these permissions");
    expect(capture.strictTrustKey).toEqual({
      subdir: expect.objectContaining({ key: "repo" }),
      "link-subdir": expect.objectContaining({ key: "repo" }),
      "wt-subdir": expect.objectContaining({ key: "repo" }),
    });
  });

  it("the --fresh pre-launch of a seat below the git root trusts the seat and the git root the strict check reads", async () => {
    const l = lab();
    const a = adapterFor(l.home);
    const binding = { id: "binding", nodeId: "node", cwd: l.seat, tmuxSession: "seat", tmuxPane: "%1" } as NodeBinding;
    expect(await a.adapter.deliverStartup([], binding)).toMatchObject({ delivered: 0, failed: [] });
    const { projects } = a.state();
    expect(projects[l.at(capture.strictTrustKey.subdir.key)]?.hasTrustDialogAccepted).toBe(true);
    expect(projects[l.seat]?.hasTrustDialogAccepted).toBe(true);
    expect(trusted(projects)).toEqual(capture.cases[capture.strictTrustKey.subdir.passes].seeded.map(l.at).sort());
    expect(Object.keys(projects).sort()).toEqual([l.repo, l.seat].sort());
  });

  it("a managed --fresh writes both keys into the selected CLAUDE_CONFIG_DIR state the child reads", async () => {
    const l = lab();
    const configDir = l.at("selected-config");
    const db = new Database(":memory:");
    cleanup.push(() => db.close());
    db.exec(`CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT);
      CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
      CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
    db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(l.seat);
    const managed = new ClaudeManagedLaunch(db, { PATH: "/usr/bin:/bin", HOME: l.home, CLAUDE_CONFIG_DIR: configDir }, {});
    const writes: string[] = [];
    const fsOps: ClaudeAdapterFsOps = {
      homedir: l.home, exists: fs.existsSync, mkdirp: p => { fs.mkdirSync(p, { recursive: true }); },
      readFile: p => fs.readFileSync(p, "utf8"), writeFile: (p, text) => { writes.push(p); fs.writeFileSync(p, text); },
      copyFile: fs.copyFileSync, readdir: p => fs.readdirSync(p),
    };
    const adapter = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, fsOps, claudeManagedLaunch: managed, sleep: async () => {} });
    adapter.ensureManagedBootstrap({ nodeId: "node", cwd: l.seat, tmuxSession: "seat", permissionMode: "acceptEdits" });
    const statePath = path.join(configDir, ".claude.json");
    expect(writes).toEqual([statePath]);
    const { projects } = JSON.parse(fs.readFileSync(statePath, "utf8")) as { projects: Record<string, Record<string, unknown>> };
    expect(trusted(projects)).toEqual([l.repo, l.seat].sort());
  });

  it("a seat outside any git repository gets only its own folder, without error", () => {
    const l = lab();
    const plain = l.at("plain/cadeiras/rig/seat");
    fs.mkdirSync(plain, { recursive: true });
    const a = adapterFor(l.home);
    expect(() => a.adapter.ensureManagedBootstrap({ cwd: plain })).not.toThrow();
    expect(Object.keys(a.state().projects)).toEqual([plain]);
    expect(a.state().projects[plain]).toEqual({ hasTrustDialogAccepted: true });
  });

  it("a seat that is the git root gets one entry, not a duplicate", () => {
    const l = lab();
    const a = adapterFor(l.home);
    a.adapter.ensureManagedBootstrap({ cwd: l.repo });
    expect(Object.keys(a.state().projects)).toEqual([l.repo]);
    expect(a.state().projects[l.repo]).toEqual({ hasTrustDialogAccepted: true });
  });

  it("a seat reached through a symlink trusts the resolved git root the strict check reads", () => {
    const l = lab();
    const linkedSeat = l.at("link/cadeiras/rig/seat");
    const a = adapterFor(l.home);
    a.adapter.ensureManagedBootstrap({ cwd: linkedSeat });
    const { projects } = a.state();
    const strict = l.at(capture.strictTrustKey["link-subdir"].key);
    expect(strict).toBe(l.repo);
    expect(projects[strict]?.hasTrustDialogAccepted).toBe(true);
    expect(projects[linkedSeat]?.hasTrustDialogAccepted).toBe(true);
    expect(projects[l.seat]?.hasTrustDialogAccepted).toBe(true);
    // [qa] the unresolved link root is never read by either check; it is tolerated, nothing wider is.
    for (const key of Object.keys(projects)) expect([linkedSeat, l.seat, l.repo, l.at("link")]).toContain(key);
  });

  it("a seat in a linked git worktree trusts the main worktree root the strict check reads", () => {
    const l = lab();
    const wtSeat = l.at("wt/cadeiras/rig/seat");
    const a = adapterFor(l.home);
    a.adapter.ensureManagedBootstrap({ cwd: wtSeat });
    const { projects } = a.state();
    const strict = l.at(capture.strictTrustKey["wt-subdir"].key);
    expect(strict).toBe(l.repo);
    expect(projects[strict]?.hasTrustDialogAccepted).toBe(true);
    expect(projects[wtSeat]?.hasTrustDialogAccepted).toBe(true);
    // [qa] the linked worktree root is inside the loose check's range; it is tolerated, nothing wider is.
    for (const key of Object.keys(projects)) expect([wtSeat, l.repo, l.at("wt")]).toContain(key);
  });

  it("existing state is preserved: other projects, top-level fields and the git root's own fields", () => {
    const l = lab();
    const a = adapterFor(l.home);
    const before = {
      theme: "chosen", syntheticAccount: { value: "fixture-only-preserve-me" }, hasCompletedOnboarding: true,
      projects: {
        elsewhere: { untouched: true, hasTrustDialogAccepted: false },
        [l.repo]: { allowedTools: ["Bash(make:*)"], mcpServers: { local: {} }, hasTrustDialogAccepted: false },
        [l.seat]: { kept: 1 },
      },
    };
    fs.writeFileSync(a.statePath, JSON.stringify(before, null, 2));
    a.adapter.ensureManagedBootstrap({ cwd: l.seat });
    expect(a.state()).toEqual({
      ...before,
      projects: {
        elsewhere: { untouched: true, hasTrustDialogAccepted: false },
        [l.repo]: { allowedTools: ["Bash(make:*)"], mcpServers: { local: {} }, hasTrustDialogAccepted: true },
        [l.seat]: { kept: 1, hasTrustDialogAccepted: true },
      },
    });
  });

  it("a state that already trusts the seat and its git root is not rewritten", () => {
    const l = lab();
    const a = adapterFor(l.home);
    const text = JSON.stringify({ hasCompletedOnboarding: true, projects: {
      [l.repo]: { hasTrustDialogAccepted: true, kept: 2 }, [l.seat]: { hasTrustDialogAccepted: true, kept: 1 } } });
    fs.writeFileSync(a.statePath, text);
    a.adapter.ensureManagedBootstrap({ cwd: l.seat });
    expect(a.writes).toEqual([]);
    expect(fs.readFileSync(a.statePath, "utf8")).toBe(text);
  });
});
