import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { applySeatSkills } from "../src/domain/seat-skill-apply.js";
import { reconcileSkillLoadout, resolvePluginSkills, type CatalogSkill } from "../src/domain/skill-catalog.js";
import {
  ensureSeatSkillPlugin, rehydrateSeatSkills, retireSeatCoreSkillCopies, retireSeatCoreSkillCopiesForNode, SEAT_SKILL_ROUTER_ID,
  seatSkillLocation, seatSkillPaths, type SeatSkillPaths,
} from "../src/domain/seat-skill-storage.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// #2426: #2433 stopped copying the vendored openrig-core's skills into a Claude seat that loads the plugin itself, but
// seats launched before it still carry those copies, and a fresh launch, a restore or a saved-loadout apply kept them, so
// the seat loaded each skill twice. Now the seat's next launch retires OpenRig's own unchanged copies (and their records),
// and keeps and names anything it can't show is one.

let home: string;
let saved: string | undefined;
const scratches: string[] = [];
const dbs: ReturnType<typeof createFullTestDb>[] = [];
const scratch = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); scratches.push(dir); return dir; };
beforeEach(() => { saved = process.env["OPENRIG_HOME"]; home = scratch("core-copies-home-"); process.env["OPENRIG_HOME"] = home; });
afterEach(() => {
  if (saved === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = saved;
  for (const db of dbs.splice(0)) db.close();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const skillMd = (id: string, body = "Use it when the task calls for it.") => `---\nname: ${id}\ndescription: The ${id} skill.\n---\n\n${body}\n`;

/** A plugin folder with these skills; at <home>/plugins/openrig-core it is the vendored core. */
function plugin(dir: string, ids: string[]): string {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "openrig-core", version: "0.7.9" }));
  for (const id of ids) {
    mkdirSync(join(dir, "skills", id), { recursive: true });
    writeFileSync(join(dir, "skills", id, "SKILL.md"), skillMd(id));
  }
  return dir;
}

const fakeTmux = (created: string[]): TmuxAdapter => ({
  createSession: async (name: string) => { created.push(name); return { ok: true as const }; },
  setSessionEnv: async () => {}, unsetSessionEnv: async () => {},
  killSession: async () => ({ ok: true as const }), listPanes: async () => [], listSessions: async () => [], listWindows: async () => [],
  hasSession: async () => false, sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
}) as unknown as TmuxAdapter;

/** A Claude seat whose saved plugin selection includes the vendored core, with its storage and generated plugin. */
function claudeSeat(core: string) {
  const db = createFullTestDb(); dbs.push(db);
  const rigRepo = new RigRepository(db);
  const rig = rigRepo.createRig("core-copies");
  const node = rigRepo.addNode(rig.id, "dev.seat", { runtime: "claude-code" });
  db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, '[]', '[]', 'claude-code')")
    .run(node.id, JSON.stringify([{ category: "plugin", absolutePath: core }]));
  const paths = seatSkillPaths({ rigId: rig.id, logicalId: node.logicalId, runtime: "claude-code" });
  ensureSeatSkillPlugin(paths);
  const created: string[] = [];
  const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
    tmuxAdapter: fakeTmux(created), pluginsDir: join(home, "plugins") });
  const launch = async (pluginPaths: string[]) => {
    const result = await launcher.launchNode(rig.id, node.logicalId, { pluginPaths });
    expect(result.ok).toBe(true);
    return result.ok ? result.warnings ?? [] : [];
  };
  const seat = { nodeId: node.id, rigId: rig.id, logicalId: node.logicalId, runtime: "claude-code", sessionName: "dev-seat@core-copies", cwd: "." };
  // What the launcher runs for this seat before its session starts, for the launches after the first.
  const relaunch = () => retireSeatCoreSkillCopiesForNode(db, node.id, core);
  return { db, paths, launch, relaunch, seat };
}

/** What a seat launched before #2433 holds: OpenRig's copies of a plugin's skills, written by the real reconciler. */
function oldLoadout(paths: SeatSkillPaths, entries: CatalogSkill[], projectSelection: string[] = []): void {
  const result = reconcileSkillLoadout({
    loadout: { catalogRoot: scratch("core-copies-cat-"), catalogRevision: null, catalogDigest: null,
      projectSelectionDeclared: projectSelection.length > 0, projectSelection, entries },
    runtime: "claude-code", cwd: paths.root, apply: true, topologyOwner: "dev-seat@core-copies", location: seatSkillLocation(paths),
  });
  expect(result.errors).toEqual([]);
}
const pluginCopies = (root: string) => resolvePluginSkills({ pluginId: "openrig-core", pluginRoot: root, runtime: "claude-code" }).entries;
/** The skill folders in the seat's storage, apart from the router an apply writes. */
const folders = (paths: SeatSkillPaths) => readdirSync(paths.skillsRoot).filter((name) => name !== SEAT_SKILL_ROUTER_ID).sort();
const manifest = (paths: SeatSkillPaths) => JSON.parse(readFileSync(paths.manifestPath, "utf8")) as {
  skills: Array<{ id: string }>; topologySelections: Record<string, string[]>;
};

describe("a Claude seat that loads openrig-core itself, launched with OpenRig's earlier copies of its skills", () => {
  it("loses those copies before it starts, and a restore, an apply or another launch doesn't bring them back", async () => {
    const core = plugin(join(home, "plugins", "openrig-core"), ["alpha", "beta"]);
    const other = plugin(scratch("core-copies-other-"), ["delta"]);
    const s = claudeSeat(core);
    oldLoadout(s.paths, [...pluginCopies(core), ...resolvePluginSkills({ pluginId: "other", pluginRoot: other, runtime: "claude-code" }).entries]);
    expect(folders(s.paths)).toEqual(["alpha", "beta", "delta"]);

    const warnings = await s.launch([core]);
    expect(folders(s.paths)).toEqual(["delta"]);
    expect(warnings).toContain("Seat skills: removed 2 OpenRig copies of openrig-core's alpha, beta, which this seat now loads from the plugin itself");
    expect(manifest(s.paths).skills.map((skill) => skill.id)).toEqual(["delta"]);
    expect(Object.values(manifest(s.paths).topologySelections).flat()).toEqual(["delta"]);

    // Their records went with them: a restore has nothing to put back, and an apply nothing to project again.
    expect(rehydrateSeatSkills(s.paths).restored).toEqual([]);
    const applied = await applySeatSkills({ db: s.db, seat: s.seat, occupant: null, catalogRoot: scratch("core-copies-cat-") });
    expect(applied.disk.errors).toEqual([]);
    expect(folders(s.paths)).toEqual(["delta"]);

    const before = readFileSync(s.paths.manifestPath, "utf8");
    expect(s.relaunch()).toEqual([]);
    expect(readFileSync(s.paths.manifestPath, "utf8")).toBe(before);
  });

  it("an apply before the next launch removes them too, rather than projecting them again", async () => {
    const core = plugin(join(home, "plugins", "openrig-core"), ["alpha"]);
    const s = claudeSeat(core);
    oldLoadout(s.paths, pluginCopies(core));
    const applied = await applySeatSkills({ db: s.db, seat: s.seat, occupant: null, catalogRoot: scratch("core-copies-cat-") });
    expect(applied.disk).toMatchObject({ ok: true, removed: ["alpha"] });
    expect(existsSync(join(s.paths.skillsRoot, "alpha"))).toBe(false);
    expect(manifest(s.paths).skills).toEqual([]);
  });

  it("keeps and names every copy it can't show is OpenRig's own unchanged one, and changes no record", async () => {
    const core = plugin(join(home, "plugins", "openrig-core"), ["edited", "project", "moved", "linked", "unrecorded"]);
    const olderCore = plugin(scratch("core-copies-older-"), ["moved"]);
    const s = claudeSeat(core);
    oldLoadout(s.paths, [
      ...pluginCopies(core).filter((skill) => skill.id !== "moved" && skill.id !== "unrecorded"),
      ...pluginCopies(olderCore),
    ], ["project"]);
    writeFileSync(join(s.paths.skillsRoot, "edited", "SKILL.md"), skillMd("edited", "My own notes."));
    const linkedCopy = scratch("core-copies-link-");
    cpSync(join(s.paths.skillsRoot, "linked"), linkedCopy, { recursive: true });
    rmSync(join(s.paths.skillsRoot, "linked"), { recursive: true });
    symlinkSync(linkedCopy, join(s.paths.skillsRoot, "linked"));
    mkdirSync(join(s.paths.skillsRoot, "unrecorded"));
    writeFileSync(join(s.paths.skillsRoot, "unrecorded", "SKILL.md"), skillMd("unrecorded"));
    const before = readFileSync(s.paths.manifestPath, "utf8");

    const notes = (await s.launch([core])).filter((line) => line.startsWith("Seat skills:"));
    expect(folders(s.paths)).toEqual(["edited", "linked", "moved", "project", "unrecorded"]);
    expect(readFileSync(s.paths.manifestPath, "utf8")).toBe(before);
    const kept = (id: string, reason: string) => `Seat skills: kept ${join(s.paths.skillsRoot, id)}, though openrig-core also supplies ${id}: ${reason}`;
    expect(notes).toEqual(expect.arrayContaining([
      kept("edited", "it was changed after OpenRig wrote it"),
      kept("moved", `recorded from ${olderCore}, not from ${core}`),
      kept("project", "the project selects it"),
      kept("unrecorded", "OpenRig has no record of writing it"),
    ]));
    expect(notes.find((line) => line.includes(`${join(s.paths.skillsRoot, "linked")},`))).toMatch(/can't be read as the folder OpenRig wrote/);
    expect(notes.some((line) => line.includes("removed"))).toBe(false);
  });

  it("changes nothing for a seat that doesn't load openrig-core itself, or for a skill the plugin no longer supplies", async () => {
    const core = plugin(join(home, "plugins", "openrig-core"), ["alpha", "beta"]);
    const s = claudeSeat(core);
    oldLoadout(s.paths, pluginCopies(core));
    const before = readFileSync(s.paths.manifestPath, "utf8");
    expect((await s.launch([])).filter((line) => line.startsWith("Seat skills:"))).toEqual([]);
    expect(folders(s.paths)).toEqual(["alpha", "beta"]);

    rmSync(join(core, "skills", "beta"), { recursive: true });
    expect(s.relaunch()).toEqual(["Seat skills: removed OpenRig's copy of openrig-core's alpha, which this seat now loads from the plugin itself"]);
    expect(folders(s.paths)).toEqual(["beta"]);
    expect(manifest(s.paths).skills.map((skill) => skill.id)).toEqual(["beta"]);
    expect(before).toContain("\"beta\"");
  });

  it.skipIf(process.getuid?.() === 0)("puts every copy back and changes no record when the retirement can't finish", () => {
    const core = plugin(join(home, "plugins", "openrig-core"), ["alpha", "beta"]);
    const s = claudeSeat(core);
    oldLoadout(s.paths, pluginCopies(core));
    const before = readFileSync(s.paths.manifestPath, "utf8");
    // The seat's root can't take the new manifest; its skills folder can still be moved.
    chmodSync(s.paths.root, 0o555);
    let notes: string[];
    try { notes = retireSeatCoreSkillCopies(s.paths, core); } finally { chmodSync(s.paths.root, 0o755); }
    expect(notes).toEqual([expect.stringMatching(/^Seat skills: openrig-core's copies were left as they are: copies were not removed: /)]);
    expect(folders(s.paths)).toEqual(["alpha", "beta"]);
    expect(readFileSync(s.paths.manifestPath, "utf8")).toBe(before);
    expect(readdirSync(s.paths.pluginDir).filter((name) => name.startsWith(".openrig-skill-stage-"))).toEqual([]);
  });
});
