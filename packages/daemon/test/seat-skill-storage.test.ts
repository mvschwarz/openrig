// OPR.0.7.0.13 — a team seat's skills live in storage OpenRig owns, keyed by rig and logical seat, and every launch
// path hands the seat its storage through CLAUDE_CODE_PLUGIN_DIRS, derived from the node record. (Restore, the
// handover successor and the managed env -i launch are covered beside their harnesses in claude-core-plugin-load.)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { withPluginDirs } from "../src/domain/claude-core-plugin-env.js";
import {
  ensureSeatSkillPlugin, listSeatSkillRoots, rehydrateSeatSkills, seatSkillDiffers, seatSkillLocation, seatSkillName, seatSkillPaths, seatSkillsToKeep, cleanSeatSkills, recordSeatSkillWrite, hasSeatSkillRecords,
  seatSkillPluginDir, seatSkillPluginDirForNode, writeSeatSkillCatalog,
} from "../src/domain/seat-skill-storage.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { discoverSkillsWithProvenance } from "../src/domain/skill-discovery.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const PLUGIN_ENV = "CLAUDE_CODE_PLUGIN_DIRS";

function fakeTmux(created: Array<Record<string, string> | undefined>): TmuxAdapter {
  return {
    createSession: async (_n: string, _c?: string, env?: Record<string, string>) => { created.push(env); return { ok: true as const }; },
    setSessionEnv: async () => {}, unsetSessionEnv: async () => {},
    killSession: async () => ({ ok: true as const }), listPanes: async () => [], listSessions: async () => [], listWindows: async () => [],
    hasSession: async () => false, sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
}

describe("seat skill storage", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-skills-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("is keyed by rig, logical seat and runtime, under the OpenRig home and outside any project", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" }, home);
    expect(paths.root).toBe(join(home, "state", "seats", "rig-1", "dev.impl", "claude-code"));
    expect(paths.skillsRoot).toBe(join(paths.pluginDir, "skills"));
    expect(paths.manifestPath).toBe(join(paths.root, "skill-loadout.json"));
    // A fork is a new seat in a new rig: its own storage, never the parent's manifest.
    expect(seatSkillPaths({ rigId: "rig-2", logicalId: "dev.impl", runtime: "claude-code" }, home).root).not.toBe(paths.root);
    // An unusual id stays one path segment inside the home.
    expect(seatSkillPaths({ rigId: "../x", logicalId: "a/b", runtime: "claude-code" }, home).root).toBe(join(home, "state", "seats", ".._x", "a_b", "claude-code"));
  });

  it("generates the plugin once, names its skills openrig:<id>, and records them that way", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" }, home);
    ensureSeatSkillPlugin(paths);
    const manifest = readFileSync(paths.pluginManifestPath, "utf8");
    expect(JSON.parse(manifest)).toMatchObject({ name: "openrig" });
    ensureSeatSkillPlugin(paths);
    expect(readFileSync(paths.pluginManifestPath, "utf8")).toBe(manifest);
    expect(seatSkillName("queue-handoff")).toBe("openrig:queue-handoff");
    const location = seatSkillLocation(paths);
    expect(location).toMatchObject({ targetRoot: paths.skillsRoot, manifestPath: paths.manifestPath });
    expect(location.qualifiedName("x")).toBe("openrig:x");
  });

  it("points a Claude seat at its plugin only once OpenRig has kept skills for it", () => {
    const node = { rig_id: "rig-1", logical_id: "dev.impl", runtime: "claude-code" };
    expect(seatSkillPluginDir(node, home)).toBeUndefined();
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" }, home);
    ensureSeatSkillPlugin(paths);
    expect(seatSkillPluginDir(node, home)).toBe(paths.pluginDir);
    expect(seatSkillPluginDir({ ...node, runtime: "codex" }, home)).toBeUndefined();
  });

  it("adds OpenRig's plugins in order after the seat's own list, each once", () => {
    expect(withPluginDirs({}, ["/v/openrig-core", "/s/plugin"])).toEqual({ [PLUGIN_ENV]: "/v/openrig-core:/s/plugin" });
    expect(withPluginDirs({ [PLUGIN_ENV]: "/own" }, [undefined, "/s/plugin"])).toEqual({ [PLUGIN_ENV]: "/own:/s/plugin" });
    expect(withPluginDirs({ [PLUGIN_ENV]: "/own:/s/plugin" }, ["/s/plugin"])).toEqual({ [PLUGIN_ENV]: "/own:/s/plugin" });
    expect(withPluginDirs({}, [undefined, undefined])).toEqual({});
  });
});

describe("every launch through the node launcher hands a Claude seat its storage", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "seat-skills-launch-")); });
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); rmSync(root, { recursive: true, force: true }); });

  function setup() {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const created: Array<Record<string, string> | undefined> = [];
    // The launch paths hold the daemon's plugins folder; the OpenRig home is its parent.
    const pluginsDir = join(root, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
      tmuxAdapter: fakeTmux(created), sessionEnv: { OPENRIG_HOME: root }, pluginsDir });
    const storage = (rigId: string, logicalId: string) => {
      // Seat storage is always under the OpenRig home (the suite gives each worker its own).
      const paths = seatSkillPaths({ rigId, logicalId, runtime: "claude-code" });
      ensureSeatSkillPlugin(paths);
      return paths.pluginDir;
    };
    // A relaunch comes after the seat's previous session is gone: the node has no binding by then.
    const unbind = (nodeId: string) => db.prepare("DELETE FROM bindings WHERE node_id = ?").run(nodeId);
    return { db, rigRepo, created, launcher, storage, unbind };
  }

  it("fresh launch: a Claude seat with kept skills gets its plugin; one without, and a Codex seat, get nothing", async () => {
    const { rigRepo, created, launcher, storage } = setup();
    const rig = rigRepo.createRig("seat-skills");
    for (const id of ["dev.impl", "dev.qa", "dev.codex"]) rigRepo.addNode(rig.id, id, { runtime: id === "dev.codex" ? "codex" : "claude-code" });
    const dir = storage(rig.id, "dev.impl");
    for (const id of ["dev.impl", "dev.qa", "dev.codex"]) expect((await launcher.launchNode(rig.id, id)).ok).toBe(true);
    expect(created[0]![PLUGIN_ENV]).toBe(dir);
    expect(created[1]).not.toHaveProperty(PLUGIN_ENV);
    expect(created[2]).not.toHaveProperty(PLUGIN_ENV);
  });

  it("a later launch of the same seat, under another session name (a resume, a restore), finds the same storage", async () => {
    const { rigRepo, created, launcher, storage, unbind } = setup();
    const rig = rigRepo.createRig("seat-skills");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const dir = storage(rig.id, "dev.impl");
    expect((await launcher.launchNode(rig.id, "dev.impl", { sessionName: "dev-impl@seat-skills" })).ok).toBe(true);
    unbind(node.id);
    expect((await launcher.launchNode(rig.id, "dev.impl", { sessionName: "dev-impl-2@seat-skills" })).ok).toBe(true);
    expect(created.map((env) => env?.[PLUGIN_ENV])).toEqual([dir, dir]);
  });

  it("a fork is a new seat: the same logical seat in another rig gets that rig's storage, not the parent's", async () => {
    const { rigRepo, created, launcher, storage, unbind } = setup();
    const parent = rigRepo.createRig("parent");
    const fork = rigRepo.createRig("fork");
    rigRepo.addNode(parent.id, "dev.impl", { runtime: "claude-code" });
    const forkNode = rigRepo.addNode(fork.id, "dev.impl", { runtime: "claude-code" });
    const parentDir = storage(parent.id, "dev.impl");
    expect((await launcher.launchNode(fork.id, "dev.impl")).ok).toBe(true);
    expect(created[0]).not.toHaveProperty(PLUGIN_ENV);
    const forkDir = storage(fork.id, "dev.impl");
    unbind(forkNode.id);
    expect((await launcher.launchNode(fork.id, "dev.impl", { sessionName: "dev-impl@fork-2" })).ok).toBe(true);
    expect(created[1]![PLUGIN_ENV]).toBe(forkDir);
    expect(forkDir).not.toBe(parentDir);
  });

  it("reads the node record, so an unreadable database just means no seat plugin", () => {
    const { db } = setup();
    expect(seatSkillPluginDirForNode(db, "no-such-node")).toBeUndefined();
    expect(seatSkillPluginDirForNode({ prepare: () => { throw new Error("no table"); } }, "n")).toBeUndefined();
    // Reading never creates storage.
    expect(existsSync(join(root, "state"))).toBe(false);
  });
});

describe("a restore keeps a Claude seat's selected skills, and repairs only what it can prove", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-skills-rehydrate-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  function seatWith(files: Record<string, string>) {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" }, home);
    ensureSeatSkillPlugin(paths);
    const source = join(home, "catalog", "queue-handoff");
    const target = join(paths.skillsRoot, "queue-handoff");
    for (const [rel, text] of Object.entries(files)) {
      for (const root of [source, target]) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); }
    }
    writeFileSync(paths.manifestPath, JSON.stringify({ skills: [{ id: "queue-handoff", target, sourceDir: source,
      files: Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, sha(text)])) }] }));
    return { paths, source, target };
  }

  it("puts back a missing file from its recorded source, keeps an edited one, and names one it can't prove", () => {
    const { paths, source, target } = seatWith({ "SKILL.md": "skill", "scripts/helper.sh": "helper", "notes.md": "notes" });
    rmSync(join(target, "scripts/helper.sh"));
    writeFileSync(join(target, "SKILL.md"), "someone's edit");
    rmSync(join(target, "notes.md"));
    writeFileSync(join(source, "notes.md"), "the source changed since");
    const out = rehydrateSeatSkills(paths);
    expect(out).toEqual({ restored: [join(target, "scripts/helper.sh")], kept: [join(target, "SKILL.md")], missing: [join(target, "notes.md")], refused: [] });
    expect(readFileSync(join(target, "scripts/helper.sh"), "utf8")).toBe("helper");
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("someone's edit");
    expect(existsSync(join(target, "notes.md"))).toBe(false);
  });

  it("touches nothing outside the seat's own skills, whatever its manifest says", () => {
    const { paths } = seatWith({ "SKILL.md": "skill" });
    const outside = join(home, "elsewhere");
    writeFileSync(paths.manifestPath, JSON.stringify({ skills: [{ id: "x", target: outside, sourceDir: home, files: { "a": sha("a") } }] }));
    expect(rehydrateSeatSkills(paths)).toEqual({ restored: [], kept: [], missing: [], refused: [] });
    expect(existsSync(outside)).toBe(false);
  });

  it("on a fresh relaunch, leaves a skill already in storage alone (naming an edited one) and projects only a missing one", () => {
    const { paths, source, target } = seatWith({ "SKILL.md": "skill" });
    const entry = (id: string) => ({ category: "skill", effectiveId: id, absolutePath: source });
    expect(seatSkillsToKeep([entry("queue-handoff"), entry("not-there-yet"), { ...entry("x"), category: "guidance" }], paths))
      .toEqual({ keep: new Set(["queue-handoff"]), warnings: [] });
    writeFileSync(join(target, "SKILL.md"), "someone's edit");
    const edited = seatSkillsToKeep([entry("queue-handoff")], paths);
    expect([...edited.keep]).toEqual(["queue-handoff"]);
    expect(edited.warnings).toEqual([`Restore: kept ${target}: it differs from its source ${source} (an edit is never overwritten)`]);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("someone's edit");
  });

  it("tells an unchanged copy of a skill folder from an edited or incomplete one", () => {
    const { source, target } = seatWith({ "SKILL.md": "skill", "scripts/helper.sh": "helper" });
    expect(seatSkillDiffers(source, target)).toBe(false);
    writeFileSync(join(target, "scripts/helper.sh"), "edited");
    expect(seatSkillDiffers(source, target)).toBe(true);
    copyFileSync(join(source, "scripts/helper.sh"), join(target, "scripts/helper.sh"));
    rmSync(join(target, "SKILL.md"));
    expect(seatSkillDiffers(source, target)).toBe(true);
  });
});

describe("a Claude seat with storage gets every skill there, and the audit sees it", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-skills-adapter-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const realFs = {
    readFile: (p: string) => readFileSync(p, "utf8"), writeFile: (p: string, c: string) => writeFileSync(p, c),
    exists: (p: string) => existsSync(p), mkdirp: (p: string) => { mkdirSync(p, { recursive: true }); },
    copyFile: (a: string, b: string) => copyFileSync(a, b), listFiles: (p: string) => readdirSync(p),
  };

  it("projects a profile skill and installs a startup skill file into the seat's storage, not the project", async () => {
    const project = join(home, "project");
    const seat = join(home, "plugin", "skills");
    const source = join(home, "src", "review-pr");
    mkdirSync(project, { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: review-pr\ndescription: d\n---\nbody\n");
    const adapter = new ClaudeCodeAdapter({ tmux: {} as never, fsOps: realFs });
    const binding = { id: "b", nodeId: "n", tmuxSession: null, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: project, seatSkillsRoot: seat };
    const result = await adapter.project({ runtime: "claude-code", cwd: project, entries: [{ effectiveId: "review-pr", category: "skill", absolutePath: source, classification: "safe_projection" } as never],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] } as never, binding);
    expect(result.failed).toEqual([]);
    expect(existsSync(join(seat, "review-pr", "SKILL.md"))).toBe(true);
    await adapter.deliverStartup([{ path: "skills/orient/SKILL.md", absolutePath: join(home, "src", "orient", "SKILL.md"), ownerRoot: home, deliveryHint: "skill_install", required: false, appliesOn: ["fresh_start"] }].map((f) => {
      mkdirSync(dirname(f.absolutePath), { recursive: true }); writeFileSync(f.absolutePath, "orient"); return f;
    }), binding);
    expect(readFileSync(join(seat, "orient", "SKILL.md"), "utf8")).toBe("orient");
    expect(existsSync(join(project, ".claude"))).toBe(false);
    expect((await adapter.listInstalled(binding)).map((r) => r.effectiveId).sort()).toEqual(["orient", "review-pr"]);
    // Each file written there is recorded with its hash and source, beside the loadout record.
    const recorded = JSON.parse(readFileSync(join(home, "skill-projections.json"), "utf8")) as { files: Record<string, { source: string }> };
    expect(Object.keys(recorded.files).sort()).toEqual([join(seat, "orient", "SKILL.md"), join(seat, "review-pr", "SKILL.md")]);
    expect(recorded.files[join(seat, "review-pr", "SKILL.md")]!.source).toBe(join(source, "SKILL.md"));
  });

  it("lists every seat's skill folder for the audit, which reports them per seat", async () => {
    for (const [rig, seat] of [["rig-1", "dev.impl"], ["rig-2", "dev.qa"]] as const) {
      const paths = seatSkillPaths({ rigId: rig, logicalId: seat, runtime: "claude-code" }, home);
      mkdirSync(join(paths.skillsRoot, "shared"), { recursive: true });
      writeFileSync(join(paths.skillsRoot, "shared", "SKILL.md"), "---\nname: shared\ndescription: A shared skill.\n---\n\nBody content.\n");
    }
    const roots = listSeatSkillRoots(home);
    expect(roots).toHaveLength(2);
    const audited = await discoverSkillsWithProvenance({ runtime: "claude-code", homedir: join(home, "user"), cwd: join(home, "cwd"), seatSkillRoots: roots });
    expect(audited.skills.filter((s) => s.sourceKind === "seat_material").map((s) => s.id)).toEqual(["shared", "shared"]);
  });
});

describe("rig down removes only what OpenRig wrote into a seat's storage, and keeps what a restore needs", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-skills-clean-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function seat() {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" }, home);
    ensureSeatSkillPlugin(paths);
    const src = join(home, "src");
    const write = (rel: string, text: string, record = true) => {
      for (const root of [src, paths.skillsRoot]) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); }
      if (record) recordSeatSkillWrite(paths.skillsRoot, join(paths.skillsRoot, rel), join(src, rel), text);
    };
    return { paths, src, write };
  }

  it("removes unchanged recorded files and the plugin, keeps edited and unrecorded ones and reports them, and keeps the records", () => {
    const { paths, write } = seat();
    write("queue-handoff/SKILL.md", "skill");
    write("queue-handoff/scripts/helper.sh", "helper");
    write("review-pr/SKILL.md", "review");
    writeFileSync(join(paths.skillsRoot, "review-pr/SKILL.md"), "someone's edit");
    write("mine/SKILL.md", "the person's own", false);
    const out = cleanSeatSkills(paths);
    expect(out.removed.sort()).toEqual([join(paths.skillsRoot, "queue-handoff/SKILL.md"), join(paths.skillsRoot, "queue-handoff/scripts/helper.sh")]);
    expect(out.kept).toEqual([join(paths.skillsRoot, "mine/SKILL.md"), join(paths.skillsRoot, "review-pr/SKILL.md")]);
    expect(existsSync(join(paths.skillsRoot, "queue-handoff"))).toBe(false);
    expect(existsSync(paths.pluginManifestPath)).toBe(false);
    expect(hasSeatSkillRecords(paths)).toBe(true);
  });

  it("puts the removed files back from the records, then drops everything once the rig itself is deleted", () => {
    const { paths, write } = seat();
    write("queue-handoff/SKILL.md", "skill");
    cleanSeatSkills(paths);
    expect(rehydrateSeatSkills(paths).restored).toEqual([join(paths.skillsRoot, "queue-handoff/SKILL.md")]);
    ensureSeatSkillPlugin(paths);
    expect(cleanSeatSkills(paths, { dropRecords: true })).toEqual({ removed: [join(paths.skillsRoot, "queue-handoff/SKILL.md")], kept: [], refused: [] });
    // The seat's folder and its rig's go; the folder every seat shares stays.
    expect(existsSync(join(home, "state", "seats", "rig-1"))).toBe(false);
  });

  it("keeps the records when something was kept, even when the rig is deleted", () => {
    const { paths, write } = seat();
    write("queue-handoff/SKILL.md", "skill");
    writeFileSync(join(paths.skillsRoot, "queue-handoff/SKILL.md"), "edited");
    expect(cleanSeatSkills(paths, { dropRecords: true }).kept).toEqual([join(paths.skillsRoot, "queue-handoff/SKILL.md")]);
    expect(hasSeatSkillRecords(paths)).toBe(true);
  });
});

describe("a Codex seat's catalog (C2): its skills' triggers and exact paths, delivered through its own startup text", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-skills-catalog-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const skillMd = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

  it("lists each skill's original trigger and the exact SKILL.md to read, never a skill's body", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "codex" }, home);
    expect(paths.skillsRoot).toBe(join(paths.root, "skills"));
    for (const [id, trigger] of [["queue-handoff", "Use when handing work to another seat."], ["review-pr", "Use when reviewing a pull request before merging."]] as const) {
      mkdirSync(join(paths.skillsRoot, id, "scripts"), { recursive: true });
      writeFileSync(join(paths.skillsRoot, id, "SKILL.md"), skillMd(id, trigger, `SECRET BODY OF ${id}`));
      writeFileSync(join(paths.skillsRoot, id, "scripts", "helper.sh"), "#!/bin/sh\n");
    }
    const catalog = writeSeatSkillCatalog(paths);
    const text = readFileSync(catalog.path, "utf8");
    expect(catalog).toMatchObject({ path: paths.catalogPath, count: 2 });
    expect(text).toContain("This list replaces any earlier OpenRig skill list in this conversation.");
    expect(text).toContain("- **queue-handoff**: Use when handing work to another seat.");
    expect(text).toContain(`Read before you use it: \`${join(paths.skillsRoot, "queue-handoff", "SKILL.md")}\``);
    expect(text).toContain("- **review-pr**: Use when reviewing a pull request before merging.");
    expect(text).not.toContain("SECRET BODY");
    // The helper trees stay whole in the seat's storage.
    expect(existsSync(join(paths.skillsRoot, "review-pr", "scripts", "helper.sh"))).toBe(true);
  });

  it("changes its digest only when the seat's skills change, and says so when there are none", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "codex" }, home);
    const empty = writeSeatSkillCatalog(paths);
    expect(readFileSync(empty.path, "utf8")).toContain("No OpenRig skills are kept for this seat.");
    mkdirSync(join(paths.skillsRoot, "queue-handoff"), { recursive: true });
    writeFileSync(join(paths.skillsRoot, "queue-handoff", "SKILL.md"), skillMd("queue-handoff", "Use when handing work on.", "body"));
    const one = writeSeatSkillCatalog(paths);
    expect(one.digest).not.toBe(empty.digest);
    expect(writeSeatSkillCatalog(paths).digest).toBe(one.digest);
  });

  it("gives a fork its own catalog, pointing only into its own storage", () => {
    const parent = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "codex" }, home);
    const fork = seatSkillPaths({ rigId: "rig-2", logicalId: "dev.impl", runtime: "codex" }, home);
    for (const paths of [parent, fork]) {
      mkdirSync(join(paths.skillsRoot, "queue-handoff"), { recursive: true });
      writeFileSync(join(paths.skillsRoot, "queue-handoff", "SKILL.md"), skillMd("queue-handoff", "Use when handing work on.", "body"));
    }
    const text = readFileSync(writeSeatSkillCatalog(fork).path, "utf8");
    expect(text).toContain(fork.skillsRoot);
    expect(text).not.toContain(parent.root);
  });

  it("is removed with the seat's other output at rig down, and written again on restore", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "codex" }, home);
    mkdirSync(join(paths.skillsRoot, "queue-handoff"), { recursive: true });
    mkdirSync(join(home, "src"), { recursive: true });
    const src = join(home, "src", "SKILL.md");
    const text = skillMd("queue-handoff", "Use when handing work on.", "body");
    writeFileSync(src, text);
    writeFileSync(join(paths.skillsRoot, "queue-handoff", "SKILL.md"), text);
    recordSeatSkillWrite(paths.skillsRoot, join(paths.skillsRoot, "queue-handoff", "SKILL.md"), src, text);
    writeSeatSkillCatalog(paths);
    expect(cleanSeatSkills(paths).removed).toEqual([join(paths.skillsRoot, "queue-handoff", "SKILL.md")]);
    expect(existsSync(paths.catalogPath)).toBe(false);
    expect(rehydrateSeatSkills(paths).restored).toHaveLength(1);
    expect(writeSeatSkillCatalog(paths).count).toBe(1);
  });
});
