import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_PLUGIN_DIRS_ENV, claudeManagedSettingsPath, persistedActivityHooksSelected, sideloadOffExtraSkillsRoots, sideloadOffSkillReads, claudeSideloadEnabled, claudeSideloadOffNotes, claudeSideloadPolicyFile, seatPluginEnv,
} from "../src/domain/claude-core-plugin-env.js";
import { prepareSeatLaunchAdditions, seatLaunchAdditionsForLaunch, seatLaunchAdditionsReport } from "../src/domain/seat-launch-additions.js";
import { ensureSeatSkillPlugin, seatSkillPaths, writeSeatSkillCatalog, writeSeatSkillRouter } from "../src/domain/seat-skill-storage.js";

// #3245: a Claude login whose managed settings set disableSideloadFlags refuses CLAUDE_CODE_PLUGIN_DIRS, so no Claude seat
// starts. With launch.claude_sideload off, a Claude seat starts without OpenRig's plugin folders, gets its skills as a list
// to read, and each launch names what it asked for and doesn't get. The setting's default leaves every launch as it was.

const ENV = "OPENRIG_LAUNCH_CLAUDE_SIDELOAD";
let saved: { sideload?: string; home?: string };
let home: string;
beforeEach(() => {
  saved = { sideload: process.env[ENV], home: process.env["OPENRIG_HOME"] };
  home = mkdtempSync(join(tmpdir(), "claude-sideload-off-"));
  process.env["OPENRIG_HOME"] = home;
});
afterEach(() => {
  for (const [key, value] of [[ENV, saved.sideload], ["OPENRIG_HOME", saved.home]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
const off = () => { process.env[ENV] = "false"; };

describe("launch.claude_sideload", () => {
  it("is on by default, off only when it says false, and on when it can't be read", () => {
    delete process.env[ENV];
    expect(claudeSideloadEnabled()).toBe(true);
    off();
    expect(claudeSideloadEnabled()).toBe(false);
    expect(claudeSideloadEnabled(() => { throw new Error("unreadable"); })).toBe(true);
  });
});

describe("a seat's plugin env", () => {
  const dirs = ["/v/openrig-core", "/s/plugin"];
  it("on: the plugin folders follow the seat's own list, as before", () => {
    expect(seatPluginEnv({ [CLAUDE_PLUGIN_DIRS_ENV]: "/own", KEEP: "1" }, dirs, "claude-code"))
      .toEqual({ [CLAUDE_PLUGIN_DIRS_ENV]: "/own:/v/openrig-core:/s/plugin", KEEP: "1" });
  });
  it("off: a Claude seat gets none, and its own list is left out; another runtime's env is unchanged", () => {
    off();
    expect(seatPluginEnv({ [CLAUDE_PLUGIN_DIRS_ENV]: "/own", KEEP: "1" }, dirs, "claude-code")).toEqual({ KEEP: "1" });
    expect(seatPluginEnv({ KEEP: "1" }, dirs, "claude-code")).toEqual({ KEEP: "1" });
    expect(seatPluginEnv({ [CLAUDE_PLUGIN_DIRS_ENV]: "/own" }, [], "codex")).toEqual({ [CLAUDE_PLUGIN_DIRS_ENV]: "/own" });
  });
});

describe("what a launch names when the setting is off", () => {
  const ask = { runtime: "claude-code", coreSelected: true, seatEnv: { [CLAUDE_PLUGIN_DIRS_ENV]: "/own" }, activityHooksSelected: false };
  it("names openrig-core's hooks, a seat left without any activity relay, and the seat's own list", () => {
    off();
    expect(claudeSideloadOffNotes(ask)).toEqual([
      "claude_sideload_off: openrig-core isn't loaded (launch.claude_sideload is off), so its refocus and compaction-restore hooks don't run; its skills are in this seat's skill list instead",
      "claude_sideload_off: this seat's profile doesn't select claude_activity_hooks, and openrig-core's activity relay isn't loaded, so the seat reports no activity",
      "claude_sideload_off: CLAUDE_CODE_PLUGIN_DIRS from this seat's env is left out (launch.claude_sideload is off)",
    ]);
    // The settings relay covers the activity events, so only the hooks are named.
    expect(claudeSideloadOffNotes({ ...ask, seatEnv: {}, activityHooksSelected: true })).toHaveLength(1);
  });
  it("names nothing with the setting on, for another runtime, or for a seat that asked for nothing", () => {
    expect(claudeSideloadOffNotes(ask)).toEqual([]);
    off();
    expect(claudeSideloadOffNotes({ ...ask, runtime: "codex" })).toEqual([]);
    expect(claudeSideloadOffNotes({ runtime: "claude-code", coreSelected: false, seatEnv: {} })).toEqual([]);
  });
});

describe("whether a seat's saved selection has OpenRig's settings relay, for a native resume that projects nothing", () => {
  it("reads it from the saved startup context, and says nothing when there's none", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE node_startup_context(node_id TEXT, projection_entries_json TEXT)");
      const save = (id: string, json: string) => db.prepare("INSERT INTO node_startup_context VALUES (?, ?)").run(id, json);
      save("with", JSON.stringify([{ category: "plugin" }, { category: "runtime_resource", resourceType: "claude_activity_hooks" }]));
      save("without", JSON.stringify([{ category: "runtime_resource", resourceType: "claude_settings_fragment" }]));
      save("broken", "not json");
      expect(persistedActivityHooksSelected(db, "with")).toBe(true);
      expect(persistedActivityHooksSelected(db, "without")).toBe(false);
      expect(persistedActivityHooksSelected(db, "broken")).toBeUndefined();
      expect(persistedActivityHooksSelected(db, "none")).toBeUndefined();
    } finally { db.close(); }
  });
});

describe("what a seat reads by path when the setting is off", () => {
  it("is its skill list and skills, plus openrig-core's when it selected the plugin; nothing with the setting on", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE node_startup_context(node_id TEXT, projection_entries_json TEXT)");
      const plugins = join(home, "plugins"), core = join(plugins, "openrig-core");
      mkdirSync(join(core, ".claude-plugin"), { recursive: true });
      writeFileSync(join(core, ".claude-plugin", "plugin.json"), "{}");
      db.prepare("INSERT INTO node_startup_context VALUES ('node', ?)").run(JSON.stringify([{ category: "plugin", absolutePath: core }]));
      const seat = seatSkillPaths({ rigId: "rig", logicalId: "dev.impl", runtime: "claude-code" });
      const node = { id: "node", runtime: "claude-code" };
      expect(sideloadOffSkillReads(node, db, seat, plugins)).toEqual({ files: [], trees: [] });
      off();
      expect(sideloadOffSkillReads(node, db, seat, plugins)).toEqual({ files: [seat.catalogPath], trees: [seat.skillsRoot, join(core, "skills")] });
      expect(sideloadOffSkillReads({ id: "other", runtime: "claude-code" }, db, seat, plugins)).toEqual({ files: [seat.catalogPath], trees: [seat.skillsRoot] });
      expect(sideloadOffSkillReads({ ...node, runtime: "codex" }, db, seat, plugins)).toEqual({ files: [], trees: [] });
    } finally { db.close(); }
  });
});

describe("a seat's launch additions when the setting is off", () => {
  function seat() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE nodes(id TEXT, rig_id TEXT, logical_id TEXT, runtime TEXT)");
    db.prepare("INSERT INTO nodes VALUES ('node', 'rig', 'dev.impl', 'claude-code')").run();
    const paths = seatSkillPaths({ rigId: "rig", logicalId: "dev.impl", runtime: "claude-code" });
    ensureSeatSkillPlugin(paths);
    const src = join(home, "src");
    mkdirSync(join(src, "tools", ".claude-plugin"), { recursive: true });
    writeFileSync(join(src, "tools", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tools" }));
    writeFileSync(join(src, "helper.md"), "---\nname: helper\ndescription: Helps.\n---\n\nHelp.\n");
    writeFileSync(join(src, "prompt.md"), "Be brief.\n");
    const prepared = prepareSeatLaunchAdditions(paths, { agentFile: join(src, "helper.md"), appendSystemPromptFile: join(src, "prompt.md"),
      pluginDirs: [join(src, "tools")], pluginChannels: ["plugin:chat@approved"] });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    return db;
  }

  it("passes the prompt file and plugin channels, and names the agent and plugin folder it leaves off", () => {
    const db = seat();
    try {
      const on = seatLaunchAdditionsForLaunch(db, "node");
      expect(on.additions).toMatchObject({ agent: "openrig:helper", pluginChannels: ["plugin:chat@approved"] });
      expect(on.additions!.pluginDirs).toHaveLength(1);
      expect(on.refused).toEqual([]);
      off();
      const launch = seatLaunchAdditionsForLaunch(db, "node");
      expect(launch.additions).toEqual({ pluginDirs: [], appendSystemPromptFile: on.additions!.appendSystemPromptFile, pluginChannels: ["plugin:chat@approved"] });
      expect(launch.refused).toEqual([
        "the agent openrig:helper: launch.claude_sideload is off, and it loads through a plugin folder (CLAUDE_CODE_PLUGIN_DIRS)",
        `the plugin folder ${on.additions!.pluginDirs[0]}: launch.claude_sideload is off, and it loads through a plugin folder (CLAUDE_CODE_PLUGIN_DIRS)`,
      ]);
      // The seat's view says the same as its launch.
      expect(seatLaunchAdditionsReport(seatSkillPaths({ rigId: "rig", logicalId: "dev.impl", runtime: "claude-code" })))
        .toMatchObject({ pluginDirs: [], pluginChannels: ["plugin:chat@approved"], refused: launch.refused });
      expect(seatLaunchAdditionsReport(seatSkillPaths({ rigId: "rig", logicalId: "dev.impl", runtime: "claude-code" }))).not.toHaveProperty("agent");
      // An export carries what the seat asked for, whatever this machine's setting.
      expect(seatLaunchAdditionsForLaunch(db, "node", true).additions).toEqual(on.additions);
    } finally { db.close(); }
  });
});

describe("a Claude seat's skill list when the setting is off", () => {
  const skill = (paths: ReturnType<typeof seatSkillPaths>, id: string) => {
    mkdirSync(join(paths.skillsRoot, id), { recursive: true });
    writeFileSync(join(paths.skillsRoot, id, "SKILL.md"), `---\nname: ${id}\ndescription: Use for ${id}.\n---\n\nDo ${id}.\n`);
  };

  it("lists each skill's trigger and file, and says they are files to read, not installed skills", () => {
    const paths = seatSkillPaths({ rigId: "rig", logicalId: "dev.impl", runtime: "claude-code" });
    skill(paths, "review");
    const catalog = writeSeatSkillCatalog(paths, { claudeWithoutPlugin: true });
    expect(catalog).toMatchObject({ path: paths.catalogPath, count: 1 });
    const text = readFileSync(paths.catalogPath, "utf8");
    expect(text).toContain("These are files to read, not Claude Code skills: none is installed in Claude Code, none has a slash command, and none starts on its own.");
    expect(text).toContain(`- **review**: Use for review.\n  Read before you use it: \`${join(paths.skillsRoot, "review", "SKILL.md")}\``);
    // A Codex seat's list is unchanged.
    expect(writeSeatSkillCatalog(seatSkillPaths({ rigId: "rig", logicalId: "dev.cx", runtime: "codex" }))).toMatchObject({ count: 0 });
  });

  it("lists openrig-core's skills where the vendored plugin keeps them, after the seat's own, which win on the same id", () => {
    const paths = seatSkillPaths({ rigId: "rig", logicalId: "dev.impl", runtime: "claude-code" });
    skill(paths, "review");
    const coreSkills = join(home, "plugins", "openrig-core", "skills");
    for (const id of ["refocusing", "review"]) {
      mkdirSync(join(coreSkills, id), { recursive: true });
      writeFileSync(join(coreSkills, id, "SKILL.md"), `---\nname: ${id}\ndescription: Core ${id}.\n---\n\nUse it.\n`);
    }
    expect(writeSeatSkillCatalog(paths, { claudeWithoutPlugin: true, extraSkillsRoots: [coreSkills] })).toMatchObject({ count: 2 });
    const text = readFileSync(paths.catalogPath, "utf8");
    expect(text).toContain(`- **refocusing**: Core refocusing.\n  Read before you use it: \`${join(coreSkills, "refocusing", "SKILL.md")}\``);
    expect(text).toContain(`- **review**: Use for review.`);
    expect(text).not.toContain("Core review.");
  });

  it("is no file at all with no skills, removing one OpenRig wrote earlier, and keeps a person's edit", () => {
    const paths = seatSkillPaths({ rigId: "rig", logicalId: "dev.impl", runtime: "claude-code" });
    skill(paths, "review");
    writeSeatSkillCatalog(paths, { claudeWithoutPlugin: true });
    rmSync(join(paths.skillsRoot, "review"), { recursive: true });
    expect(writeSeatSkillCatalog(paths, { claudeWithoutPlugin: true })).toMatchObject({ count: 0 });
    expect(existsSync(paths.catalogPath)).toBe(false);
    writeFileSync(paths.catalogPath, "My own list.\n");
    expect(writeSeatSkillCatalog(paths, { claudeWithoutPlugin: true })).toMatchObject({ kept: true, reason: "edited" });
    expect(readFileSync(paths.catalogPath, "utf8")).toBe("My own list.\n");
  });

  it("has a router that lists the same skills and says it's a file to read; the usual router is unchanged", () => {
    const paths = seatSkillPaths({ rigId: "rig", logicalId: "dev.impl", runtime: "claude-code" });
    skill(paths, "review");
    const coreSkills = join(home, "plugins", "openrig-core", "skills");
    mkdirSync(join(coreSkills, "refocusing"), { recursive: true });
    writeFileSync(join(coreSkills, "refocusing", "SKILL.md"), "---\nname: refocusing\ndescription: Core refocusing.\n---\n\nUse it.\n");
    const router = writeSeatSkillRouter(paths);
    const usual = readFileSync(router.path, "utf8");
    expect(usual).not.toContain("refocusing");
    expect(usual).not.toContain("files to read, not Claude Code skills");
    expect(writeSeatSkillRouter(paths, { claudeWithoutPlugin: true, extraSkillsRoots: [coreSkills] })).toMatchObject({ written: true });
    const text = readFileSync(router.path, "utf8");
    expect(text).toContain("This file and the skills it lists are files to read, not Claude Code skills");
    expect(text).toContain(`- **refocusing**: Core refocusing.\n  Read before you use it: \`${join(coreSkills, "refocusing", "SKILL.md")}\``);
    expect(text).toContain("- **review**: Use for review.");
    // Back on, the router is the usual one again.
    writeSeatSkillRouter(paths);
    expect(readFileSync(router.path, "utf8")).toBe(usual);
  });

  it("lists openrig-core's skills only for a Claude seat that selected it, with the setting off", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE node_startup_context(node_id TEXT, projection_entries_json TEXT)");
      const plugins = join(home, "plugins"), core = join(plugins, "openrig-core");
      mkdirSync(join(core, ".claude-plugin"), { recursive: true });
      writeFileSync(join(core, ".claude-plugin", "plugin.json"), "{}");
      db.prepare("INSERT INTO node_startup_context VALUES ('node', ?)").run(JSON.stringify([{ category: "plugin", absolutePath: core }]));
      const node = { id: "node", runtime: "claude-code" };
      expect(sideloadOffExtraSkillsRoots(node, db, undefined, plugins)).toEqual([]);
      off();
      expect(sideloadOffExtraSkillsRoots(node, db, undefined, plugins)).toEqual([join(core, "skills")]);
      expect(sideloadOffExtraSkillsRoots({ id: "other", runtime: "claude-code" }, db, undefined, plugins)).toEqual([]);
      expect(sideloadOffExtraSkillsRoots({ ...node, runtime: "codex" }, db, undefined, plugins)).toEqual([]);
    } finally { db.close(); }
  });
});

describe("the managed settings file, the only evidence of the policy OpenRig reads", () => {
  const read = (files: Record<string, string>) => (path: string) => {
    if (!(path in files)) throw new Error("ENOENT");
    return files[path]!;
  };
  it("is named only when it sets disableSideloadFlags to true", () => {
    const linux = claudeManagedSettingsPath("linux")!;
    expect(linux).toBe("/etc/claude-code/managed-settings.json");
    expect(claudeSideloadPolicyFile(read({ [linux]: '{"disableSideloadFlags": true}' }), "linux")).toBe(linux);
    for (const content of ['{"disableSideloadFlags": false}', '{"disableSideloadFlags": "true"}', "{}", "not json", "null"]) {
      expect(claudeSideloadPolicyFile(read({ [linux]: content }), "linux"), content).toBeUndefined();
    }
    expect(claudeSideloadPolicyFile(read({}), "linux")).toBeUndefined();
    const mac = claudeManagedSettingsPath("darwin")!;
    expect(claudeSideloadPolicyFile(read({ [mac]: '{"disableSideloadFlags": true}' }), "darwin")).toBe(mac);
    expect(claudeSideloadPolicyFile(read({}), "win32")).toBeUndefined();
  });
});
