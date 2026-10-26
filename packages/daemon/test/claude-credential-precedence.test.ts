import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";

// Before a Claude seat moves to its own subscription token, OpenRig finds what Claude Code would rank above that token
// (a cloud provider, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, an apiKeyHelper): in the seat's launch environment and in the
// settings files it loads. It names each one and its remedy, edits nothing, and says what it couldn't read.

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

function fixture(opts: { daemonEnv?: Record<string, string>; memberEnv?: Record<string, string>; worktree?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "claude-precedence-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), main = path.join(root, "main"), cwd = opts.worktree ? path.join(root, "wt") : main;
  for (const dir of [home, main, cwd, path.join(home, ".claude"), path.join(cwd, ".claude"), path.join(main, ".claude"), path.join(main, ".git", "worktrees", "wt")]) {
    mkdirSync(dir, { recursive: true });
  }
  if (opts.worktree) writeFileSync(path.join(cwd, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
  const db = new Database(":memory:"); cleanup.push(() => { db.close(); });
  db.exec(`CREATE TABLE rigs(id TEXT, env_json TEXT);
    CREATE TABLE nodes(id TEXT, rig_id TEXT, runtime TEXT, cwd TEXT, env_json TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
  db.prepare("INSERT INTO rigs VALUES ('rig', NULL)").run();
  db.prepare("INSERT INTO nodes VALUES ('node', 'rig', 'claude-code', ?, ?)").run(cwd, opts.memberEnv ? JSON.stringify(opts.memberEnv) : null);
  db.exec("INSERT INTO bindings VALUES ('b', 'node', 'seat@rig', '%1'); INSERT INTO occupant_tenures VALUES ('node', 'gen', 1)");
  const managed = new ClaudeManagedLaunch(db, { PATH: "/usr/bin:/bin", HOME: home, ...opts.daemonEnv }, {}, async () => undefined);
  return { managed, home, main, cwd };
}

describe("what would outrank a Claude seat's own subscription token", () => {
  it("names each one in the launch environment and the settings files the seat loads, with its remedy", async () => {
    const f = fixture({ daemonEnv: { ANTHROPIC_AUTH_TOKEN: "x" }, memberEnv: { ANTHROPIC_API_KEY: "y" }, worktree: true });
    writeFileSync(path.join(f.home, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "/usr/local/bin/key" }));
    writeFileSync(path.join(f.cwd, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }));
    // In a worktree, Claude Code reads the local settings at the main checkout's root.
    writeFileSync(path.join(f.main, ".claude", "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "z" } }));
    const found = await f.managed.credentialPrecedence("node");
    expect(found.conflicts.map((c) => [c.name, c.source])).toEqual([
      ["ANTHROPIC_AUTH_TOKEN", "the daemon's environment, which every managed Claude launch receives"],
      ["ANTHROPIC_API_KEY", "this seat's env: (member or rig) or a one-off launch name"],
      ["apiKeyHelper", `user settings ${path.join(f.home, ".claude", "settings.json")}`],
      ["CLAUDE_CODE_USE_BEDROCK", `the env block of project settings ${path.join(f.cwd, ".claude", "settings.json")}`],
      ["ANTHROPIC_API_KEY", `the env block of project local settings ${path.join(f.main, ".claude", "settings.local.json")}`],
    ]);
    for (const conflict of found.conflicts) expect(conflict.remedy.length).toBeGreaterThan(0);
    // Values are never reported, only names and where they come from.
    expect(JSON.stringify(found)).not.toMatch(/"(x|y|z)"/);
  });

  it("finds nothing on a seat with none, and says what it couldn't read", async () => {
    const f = fixture();
    writeFileSync(path.join(f.cwd, ".claude", "settings.json"), JSON.stringify({ env: { FOO: "1" }, model: "opus" }));
    const found = await f.managed.credentialPrecedence("node");
    expect(found.conflicts).toEqual([]);
    // A pane shell's own exports can't be read, but the launch unsets those names for Claude when the token applies.
    expect(found.checked).toContain("the launch environment (a pane shell's own exports are unset for Claude's process when the token applies)");
    expect(found.notChecked).toEqual(["managed settings (a managed-settings.json file, MDM or the server)"]);
  });

  it("a move back to the stored login also finds a CLAUDE_CODE_OAUTH_TOKEN the seat would still receive, as what it uses instead", async () => {
    const f = fixture({ daemonEnv: { CLAUDE_CODE_OAUTH_TOKEN: "x" }, memberEnv: { CLAUDE_CODE_OAUTH_TOKEN: "y" } });
    writeFileSync(path.join(f.cwd, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "z" } }));
    const back = await f.managed.credentialPrecedence("node", { storedLogin: true });
    expect(back.conflicts).toEqual([]);
    expect(back.instead?.map((c) => [c.name, c.source])).toEqual([
      ["CLAUDE_CODE_OAUTH_TOKEN", "the daemon's environment, which every managed Claude launch receives"],
      ["CLAUDE_CODE_OAUTH_TOKEN", "this seat's env: (member or rig) or a one-off launch name"],
      ["CLAUDE_CODE_OAUTH_TOKEN", `the env block of project settings ${path.join(f.cwd, ".claude", "settings.json")}`],
    ]);
    // The pane shell's own exports, which a launch without a permission mode keeps, can't be read.
    expect(back.notChecked).toContain("the pane shell's own exports (its startup files), which a launch without an explicit permission mode keeps");
    expect(JSON.stringify(back)).not.toMatch(/"(x|y|z)"/);
    // Moving to a token, the same token isn't something that outranks it.
    expect((await f.managed.credentialPrecedence("node")).instead).toBeUndefined();
  });

  it("a settings file that isn't valid JSON is named as not checked, never as clear", async () => {
    const f = fixture();
    writeFileSync(path.join(f.home, ".claude", "settings.json"), "{ not json");
    const found = await f.managed.credentialPrecedence("node");
    expect(found.notChecked).toContain(`user settings ${path.join(f.home, ".claude", "settings.json")} (not valid JSON)`);
  });
});
