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
  ensureSeatSkillPlugin, recordSeatSkillFollowing, recordSeatSkillWrite, rehydrateSeatSkills, retireSeatCoreSkillCopies,
  retireSeatCoreSkillCopiesForNode, SEAT_SKILL_ROUTER_ID, seatSkillLocation, seatSkillPaths, type SeatSkillPaths,
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

  it("an apply before the next launch leaves them to that launch: it neither removes them under the running seat nor projects them again", async () => {
    const core = plugin(join(home, "plugins", "openrig-core"), ["alpha"]);
    const s = claudeSeat(core);
    oldLoadout(s.paths, pluginCopies(core));
    const applied = await applySeatSkills({ db: s.db, seat: s.seat, occupant: null, catalogRoot: scratch("core-copies-cat-") });
    expect(applied.disk).toMatchObject({ ok: true, removed: [], errors: [] });
    expect(folders(s.paths)).toEqual(["alpha"]);
    expect(manifest(s.paths).skills.map((skill) => skill.id)).toEqual(["alpha"]);

    // The next ordinary launch removes it, and an apply after that doesn't bring it back.
    expect(s.relaunch()).toEqual(["Seat skills: removed OpenRig's copy of openrig-core's alpha, which this seat now loads from the plugin itself"]);
    await applySeatSkills({ db: s.db, seat: s.seat, occupant: null, catalogRoot: scratch("core-copies-cat-") });
    expect(folders(s.paths)).toEqual([]);
  });

  it("a launch removes them from every owner's selection, not only the current one's, so an apply after it can't bring them back", async () => {
    const core = plugin(join(home, "plugins", "openrig-core"), ["alpha"]);
    const other = plugin(scratch("core-copies-other-"), ["delta"]);
    const s = claudeSeat(core);
    oldLoadout(s.paths, [...pluginCopies(core), ...resolvePluginSkills({ pluginId: "other", pluginRoot: other, runtime: "claude-code" }).entries]);
    // An earlier occupant's selection holds alpha, and the current one's only delta.
    const record = JSON.parse(readFileSync(s.paths.manifestPath, "utf8")) as { topologySelections: Record<string, string[]> };
    record.topologySelections = { "dev-seat@core-copies": ["delta"], "earlier@core-copies": ["alpha"] };
    writeFileSync(s.paths.manifestPath, `${JSON.stringify(record, null, 2)}\n`);

    expect(s.relaunch()).toEqual(["Seat skills: removed OpenRig's copy of openrig-core's alpha, which this seat now loads from the plugin itself"]);
    expect(manifest(s.paths).topologySelections).toEqual({ "dev-seat@core-copies": ["delta"] });
    const applied = await applySeatSkills({ db: s.db, seat: s.seat, occupant: null, catalogRoot: scratch("core-copies-cat-") });
    expect(applied.disk).toMatchObject({ ok: true, removed: [], errors: [] });
    expect(folders(s.paths)).toEqual(["delta"]);
  });

  it("keeps a copy another record could put back, so a restore and an apply after the launch leave it recorded", async () => {
    const core = plugin(join(home, "plugins", "openrig-core"), ["alpha", "beta", "delta", "gamma"]);
    const s = claudeSeat(core);
    oldLoadout(s.paths, pluginCopies(core));
    // Beside the loadout's own record: the adapter's record of writing alpha's and delta's files, and beta following its
    // source. Delta's folder is already gone, which that record could put back.
    for (const id of ["alpha", "delta"]) {
      const file = join(s.paths.skillsRoot, id, "SKILL.md");
      recordSeatSkillWrite(s.paths.skillsRoot, file, join(core, "skills", id, "SKILL.md"), readFileSync(file));
    }
    recordSeatSkillFollowing(s.paths.skillsRoot, "beta", join(core, "skills", "beta"));
    rmSync(join(s.paths.skillsRoot, "delta"), { recursive: true });
    const kept = (id: string, why: string) => `Seat skills: kept ${join(s.paths.skillsRoot, id)}, though openrig-core also supplies ${id}: it's also recorded as ${why} in ${s.paths.projectionsPath}`;
    const keptNotes = [kept("alpha", "a projection"), kept("beta", "following its source"), kept("delta", "a projection")];

    expect(s.relaunch()).toEqual(["Seat skills: removed OpenRig's copy of openrig-core's gamma, which this seat now loads from the plugin itself", ...keptNotes]);
    expect(folders(s.paths)).toEqual(["alpha", "beta"]);

    // The loadout still owns delta, so a restore that puts its recorded file back leaves a recorded copy, not an
    // unrecorded folder: the next launch names the same three, and an apply changes nothing.
    expect(rehydrateSeatSkills(s.paths).restored).toEqual([join(s.paths.skillsRoot, "delta", "SKILL.md")]);
    expect(s.relaunch()).toEqual(keptNotes);
    const applied = await applySeatSkills({ db: s.db, seat: s.seat, occupant: null, catalogRoot: scratch("core-copies-cat-") });
    expect(applied.disk).toMatchObject({ ok: true, removed: [], errors: [] });
    expect(folders(s.paths)).toEqual(["alpha", "beta", "delta"]);
    expect(manifest(s.paths).skills.map((skill) => skill.id)).toEqual(["alpha", "beta", "delta"]);
  });

  // A provider switch relaunches a running Claude seat in its own pane: the launch itself ends the running process there.
  it.each([true, false])("on a kept pane, the copies go only once its running process has ended (it ends: %s)", async (ends) => {
    const core = plugin(join(home, "plugins", "openrig-core"), ["alpha"]);
    const s = claudeSeat(core);
    oldLoadout(s.paths, pluginCopies(core));
    const sessions = new SessionRegistry(s.db);
    const running = sessions.registerSession(s.seat.nodeId, s.seat.sessionName);
    sessions.updateStatus(running.id, "running");
    sessions.updateBinding(s.seat.nodeId, { tmuxSession: s.seat.sessionName, tmuxPane: "%7" });
    const alpha = join(s.paths.skillsRoot, "alpha");
    const presentWhenSignalled: boolean[] = [];
    const tmux = { ...fakeTmux([]),
      listPanes: async () => [{ id: "%7", index: 0, cwd: ".", width: 80, height: 24, active: true }],
      setRemainOnExit: async () => ({ ok: true as const }),
      signalPaneProcess: async () => { presentWhenSignalled.push(existsSync(alpha)); return { ok: true as const }; },
      isPaneDead: async () => ends,
      getDefaultShell: async () => "/bin/sh",
      respawnPane: async () => ({ ok: true as const }),
    } as unknown as TmuxAdapter;
    const launcher = new NodeLauncher({ db: s.db, rigRepo: new RigRepository(s.db), sessionRegistry: sessions, eventBus: new EventBus(s.db),
      tmuxAdapter: tmux, pluginsDir: join(home, "plugins"), paneExit: { pollMs: 1, timeoutMs: 5, sleep: async () => {} } });

    // As restore's relaunch for a provider switch asks: the seat's own session and its bound pane.
    const result = await launcher.launchNode(s.seat.rigId, s.seat.logicalId, { pluginPaths: [core], keepPane: "%7", sessionName: s.seat.sessionName });
    expect(result).toMatchObject({ ok: ends });
    // Nothing was removed while the process the pane held was still being asked to end.
    expect(presentWhenSignalled.length).toBeGreaterThan(0);
    expect(presentWhenSignalled.every(Boolean)).toBe(true);
    if (ends) {
      expect(result).toMatchObject({ ok: true,
        warnings: expect.arrayContaining(["Seat skills: removed OpenRig's copy of openrig-core's alpha, which this seat now loads from the plugin itself"]) });
      expect(folders(s.paths)).toEqual([]);
    } else {
      expect(result).toMatchObject({ ok: false, code: "pane_process_not_ended" });
      expect(folders(s.paths)).toEqual(["alpha"]);
      expect(manifest(s.paths).skills.map((skill) => skill.id)).toEqual(["alpha"]);
    }
  });

  it("keeps every copy while the seat's projection record can't be read", () => {
    const core = plugin(join(home, "plugins", "openrig-core"), ["alpha"]);
    const s = claudeSeat(core);
    oldLoadout(s.paths, pluginCopies(core));
    writeFileSync(s.paths.projectionsPath, "{ not json");
    const notes = s.relaunch();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^Seat skills: kept .*alpha, though openrig-core also supplies alpha: .*skill-projections\.json can't be read/);
    expect(folders(s.paths)).toEqual(["alpha"]);
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
