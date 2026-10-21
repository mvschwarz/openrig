// OPR.0.7.0.13, review round 2: what a seat's storage may change, and when. Cleanup and repair act only on paths that
// are still inside the seat's own storage (no link anywhere on the way), only after the seat's consumer is confirmed
// gone, and never over an edit, including OpenRig's generated plugin manifest and catalog. A restore's decisions hold
// through every later writer. `--apply` reserves its attempt before it sends, through the outbox's claim, finalize and
// recovery, and an unreadable selection is never reported as reconciled.
// Hermetic: real filesystem, adapters, reconciler, SQLite and orchestrators; tmux and the transport are scripted.
// Native Claude/Codex behaviour is NOT RUN here.
import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding, ResolvedStartupFile, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import {
  cleanSeatSkills, claudeSeatSkillsNote, ensureSeatSkillPlugin, insideSeatStorage, recordSeatSkillWrite, rehydrateSeatSkills, seatSkillLocation,
  seatSkillPaths, seatSkillReplay, writeSeatSkillCatalog, type SeatSkillPaths,
} from "../src/domain/seat-skill-storage.js";
import {
  applySeatSkills, inspectSeatSkills, recoverSeatSkillAttempts, type SeatRef, type SeatSkillSender,
} from "../src/domain/seat-skill-apply.js";
import { reconcileSkillLoadout, resolveSkillLoadout } from "../src/domain/skill-catalog.js";

const roots: string[] = [];
const scratch = (name: string) => { const dir = mkdtempSync(join(tmpdir(), name)); roots.push(dir); return dir; };
let savedHome: string | undefined;
let home: string;
beforeEach(() => { savedHome = process.env["OPENRIG_HOME"]; home = scratch("seat-own-home-"); process.env["OPENRIG_HOME"] = home; });
afterEach(() => {
  if (savedHome === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = savedHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const realFs = {
  readFile: (p: string) => readFileSync(p, "utf8"), writeFile: (p: string, c: string) => writeFileSync(p, c),
  exists: (p: string) => existsSync(p), mkdirp: (p: string) => { mkdirSync(p, { recursive: true }); },
  copyFile: (a: string, b: string) => writeFileSync(b, readFileSync(a)),
  listFiles: (p: string) => {
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name), join(rel, e.name)); else out.push(join(rel, e.name));
      }
    };
    walk(p, "");
    return out;
  },
  statMode: (p: string) => statSync(p).mode, chmod: (p: string, m: number) => chmodSync(p, m),
};

/** A Claude seat with one recorded skill, as its launch left it: source and copy identical, the write recorded. */
function claudeSeat(files: Record<string, string> = { "SKILL.md": "skill\n", "scripts/helper.sh": "#!/bin/sh\necho hi\n" }) {
  const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
  ensureSeatSkillPlugin(paths);
  const source = join(scratch("seat-own-src-"), "queue-handoff");
  const target = join(paths.skillsRoot, "queue-handoff");
  for (const [rel, text] of Object.entries(files)) {
    for (const root of [source, target]) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); }
    recordSeatSkillWrite(paths.skillsRoot, join(target, rel), join(source, rel), text);
  }
  return { paths, source, target };
}

describe("F1: cleanup and repair don't act through a link found on the way out of the seat's storage", () => {
  it("rig down leaves a moved skill alone when its old folder is now a link to it", () => {
    const { paths, target } = claudeSeat();
    const moved = join(scratch("seat-own-moved-"), "queue-handoff");
    renameSync(target, moved);
    symlinkSync(moved, target);
    const out = cleanSeatSkills(paths);
    expect(readFileSync(join(moved, "SKILL.md"), "utf8")).toBe("skill\n");
    expect(readFileSync(join(moved, "scripts/helper.sh"), "utf8")).toContain("echo hi");
    expect(out.removed).toEqual([]);
    expect(out.refused.sort()).toEqual([join(target, "SKILL.md"), join(target, "scripts/helper.sh")]);
  });

  it("rig down leaves the files alone when a higher folder (the plugin) was replaced by a link", () => {
    const { paths } = claudeSeat();
    const elsewhere = join(scratch("seat-own-plugin-"), "plugin");
    renameSync(paths.pluginDir, elsewhere);
    symlinkSync(elsewhere, paths.pluginDir);
    const out = cleanSeatSkills(paths);
    expect(existsSync(join(elsewhere, "skills", "queue-handoff", "SKILL.md"))).toBe(true);
    expect(existsSync(join(elsewhere, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(out.removed).toEqual([]);
  });

  it("a restore writes nothing through a linked folder or a dangling link", () => {
    const { paths, target } = claudeSeat();
    const outside = scratch("seat-own-outside-");
    rmSync(target, { recursive: true });
    symlinkSync(outside, target);
    const linked = rehydrateSeatSkills(paths);
    expect(linked.restored).toEqual([]);
    expect(linked.refused.sort()).toEqual([join(target, "SKILL.md"), join(target, "scripts/helper.sh")]);
    expect(existsSync(join(outside, "SKILL.md"))).toBe(false);

    rmSync(target);
    mkdirSync(join(target, "scripts"), { recursive: true });
    const dangling = join(outside, "planted.md");
    symlinkSync(dangling, join(target, "SKILL.md"));
    const leaf = rehydrateSeatSkills(paths);
    expect(leaf.refused).toEqual([join(target, "SKILL.md")]);
    expect(leaf.restored).toEqual([join(target, "scripts/helper.sh")]);
    expect(existsSync(dangling)).toBe(false);
  });

  it("an install into the seat's storage writes nothing through a linked skill folder", async () => {
    const { paths, target } = claudeSeat({ "SKILL.md": "skill\n" });
    const outside = scratch("seat-own-outside-");
    rmSync(target, { recursive: true });
    symlinkSync(outside, target);
    const src = join(scratch("seat-own-startup-"), "queue-handoff", "SKILL.md");
    mkdirSync(dirname(src), { recursive: true });
    writeFileSync(src, "startup skill\n");
    const adapter = new ClaudeCodeAdapter({ tmux: {} as never, fsOps: realFs });
    const result = await adapter.deliverStartup([{ path: "skills/queue-handoff/SKILL.md", absolutePath: src, ownerRoot: dirname(src), deliveryHint: "skill_install", required: false, appliesOn: ["fresh_start"] }],
      { ...binding(join(home, "project")), seatSkillsRoot: paths.skillsRoot });
    expect(existsSync(join(outside, "SKILL.md"))).toBe(false);
    expect(JSON.stringify(result)).toContain("not inside this seat's storage");
  });
});

function binding(cwd: string): NodeBinding {
  return { id: "b", nodeId: "n", tmuxSession: null, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd } as NodeBinding;
}

describe("F2: rig down cleans a seat's storage only once its consumer is confirmed gone", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  function tmux(probe: "absent" | "present" | "unknown" | "throws" | "none"): TmuxAdapter {
    return {
      killSession: vi.fn(async () => ({ ok: true })), listSessions: vi.fn(async () => []), hasSession: vi.fn(async () => false),
      ...(probe === "none" ? {} : { probeSession: vi.fn(async () => {
        if (probe === "throws") throw new Error("tmux unavailable");
        return probe === "unknown" ? { state: "transport_unavailable", cause: "tmux unavailable" } : { state: probe };
      }) }),
    } as unknown as TmuxAdapter;
  }

  function seatWithStoppedSession(status: "exited" | "detached") {
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("own-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: home });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@own-rig");
    sessionRegistry.updateStatus(session.id, status);
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@own-rig" });
    const paths = seatSkillPaths({ rigId: rig.id, logicalId: "dev.impl", runtime: "claude-code" });
    ensureSeatSkillPlugin(paths);
    const file = join(paths.skillsRoot, "queue-handoff", "SKILL.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "skill\n");
    recordSeatSkillWrite(paths.skillsRoot, file, file, "skill\n");
    const teardown = (t: TmuxAdapter) => new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus: new EventBus(db), tmuxAdapter: t,
      snapshotCapture: { captureSnapshot: () => ({ id: "snap" }), db } as unknown as SnapshotCapture });
    return { rigId: rig.id, paths, file, teardown };
  }

  for (const status of ["exited", "detached"] as const) {
    for (const probe of ["present", "unknown", "throws", "none"] as const) {
      it(`keeps a ${status} seat's files when its session probe says ${probe}`, async () => {
        const s = seatWithStoppedSession(status);
        const result = await s.teardown(tmux(probe)).teardown(s.rigId);
        expect(readFileSync(s.file, "utf8")).toBe("skill\n");
        expect(existsSync(s.paths.pluginManifestPath)).toBe(true);
        expect(result.errors.join("\n")).toContain("its consumer isn't confirmed stopped");
      });
    }
    it(`cleans a ${status} seat's files once its session is confirmed absent`, async () => {
      const s = seatWithStoppedSession(status);
      await s.teardown(tmux("absent")).teardown(s.rigId);
      expect(existsSync(s.file)).toBe(false);
      expect(existsSync(s.paths.pluginManifestPath)).toBe(false);
    });
  }
});

describe("F3: a restore's decisions hold through every later writer", () => {
  function restoreDecisions() {
    const { paths, source, target } = claudeSeat({ "SKILL.md": "skill\n" });
    // A startup-file skill, written by the seat's last launch and recorded.
    const startupSrc = join(scratch("seat-own-startup-"), "orient", "SKILL.md");
    mkdirSync(dirname(startupSrc), { recursive: true });
    writeFileSync(startupSrc, "orient\n");
    const startupTarget = join(paths.skillsRoot, "orient", "SKILL.md");
    mkdirSync(dirname(startupTarget), { recursive: true });
    writeFileSync(startupTarget, "orient\n");
    recordSeatSkillWrite(paths.skillsRoot, startupTarget, startupSrc, "orient\n");
    const files: ResolvedStartupFile[] = [{ path: "skills/orient/SKILL.md", absolutePath: startupSrc, ownerRoot: dirname(dirname(startupSrc)), deliveryHint: "skill_install", required: false, appliesOn: ["fresh_start", "restore"] }];
    const entries = [{ category: "skill", effectiveId: "queue-handoff", absolutePath: source }];
    return { paths, source, target, startupSrc, startupTarget, files, entries };
  }

  it("keeps a startup-file skill the person edited, through the startup install that follows", async () => {
    const r = restoreDecisions();
    writeFileSync(r.startupTarget, "someone's edit\n");
    const rehydration = rehydrateSeatSkills(r.paths);
    const replay = seatSkillReplay({ entries: r.entries, files: r.files, paths: r.paths, rehydration });
    const adapter = new ClaudeCodeAdapter({ tmux: {} as never, fsOps: realFs });
    // What the startup orchestrator hands the real install after the skip (the next test shows it applies the skip).
    await adapter.deliverStartup(r.files.filter((f) => !replay.skipFiles.has(f.absolutePath)), { ...binding(join(home, "project")), seatSkillsRoot: r.paths.skillsRoot });
    expect(readFileSync(r.startupTarget, "utf8")).toBe("someone's edit\n");
    expect(replay.skipFiles.has(r.startupSrc)).toBe(true);
    expect(replay.warnings.join("\n")).toContain(r.startupTarget);
  });

  it("doesn't put back today's bytes for a missing file whose recorded source has changed, by projection or install", () => {
    const r = restoreDecisions();
    rmSync(r.target, { recursive: true });
    writeFileSync(join(r.source, "SKILL.md"), "the source changed since\n");
    rmSync(r.startupTarget);
    writeFileSync(r.startupSrc, "changed too\n");
    const rehydration = rehydrateSeatSkills(r.paths);
    expect(rehydration.missing.sort()).toEqual([join(r.target, "SKILL.md"), r.startupTarget].sort());
    const replay = seatSkillReplay({ entries: r.entries, files: r.files, paths: r.paths, rehydration });
    expect([...replay.skipEntryIds]).toEqual(["queue-handoff"]);
    expect([...replay.skipFiles]).toEqual([r.startupSrc]);
  });

  it("the startup orchestrator projects and installs nothing it was told to skip, and still saves the whole selection", async () => {
    const db = createFullTestDb();
    try {
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const rig = rigRepo.createRig("own-replay");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@own-replay");
      const projected: string[] = [];
      const delivered: string[] = [];
      const adapter = {
        runtime: "claude-code", listInstalled: async () => [], checkReady: async () => ({ ready: true }), launchHarness: async () => ({ ok: true }),
        project: async (plan: { entries: Array<{ effectiveId: string }> }) => { projected.push(...plan.entries.map((e) => e.effectiveId)); return { projected: [], skipped: [], failed: [] }; },
        deliverStartup: async (files: ResolvedStartupFile[]) => { delivered.push(...files.map((f) => f.absolutePath)); return { delivered: files.length, failed: [] }; },
      } as unknown as RuntimeAdapter;
      const file = (p: string): ResolvedStartupFile => ({ path: p, absolutePath: `/src/${p}`, ownerRoot: "/src", deliveryHint: "skill_install", required: false, appliesOn: ["restore"] });
      const entry = (id: string) => ({ category: "skill", effectiveId: id, absolutePath: `/src/${id}`, classification: "safe_projection" });
      const result = await new StartupOrchestrator({ db, sessionRegistry, eventBus: new EventBus(db), tmuxAdapter: {} as TmuxAdapter, sleep: async () => {} }).startNode({
        rigId: rig.id, nodeId: node.id, sessionId: session.id, binding: binding("."), adapter,
        plan: { runtime: "claude-code", cwd: ".", entries: [entry("kept"), entry("new")], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] } as never,
        resolvedStartupFiles: [file("kept/SKILL.md"), file("new/SKILL.md")], startupActions: [], isRestore: true, skipHarnessLaunch: true,
        replaySkip: { entryIds: new Set(["kept"]), files: new Set(["/src/kept/SKILL.md"]) },
      });
      expect(result.ok).toBe(true);
      expect(projected).toEqual(["new"]);
      expect(delivered).toEqual(["/src/new/SKILL.md"]);
      const saved = db.prepare("SELECT projection_entries_json AS e, resolved_files_json AS f FROM node_startup_context WHERE node_id = ?").get(node.id) as { e: string; f: string };
      expect((JSON.parse(saved.e) as Array<{ effectiveId: string }>).map((e) => e.effectiveId)).toEqual(["kept", "new"]);
      expect((JSON.parse(saved.f) as ResolvedStartupFile[]).map((f) => f.path)).toEqual(["kept/SKILL.md", "new/SKILL.md"]);
    } finally { db.close(); }
  });
});

describe("F4: a restore puts back a helper with its executable mode", () => {
  it("restores the mode of a helper recorded by the loadout or by a projection", () => {
    const { paths, source, target } = claudeSeat();
    chmodSync(join(source, "scripts/helper.sh"), 0o755);
    chmodSync(join(target, "scripts/helper.sh"), 0o755);
    cleanSeatSkills(paths);
    expect(existsSync(join(target, "scripts/helper.sh"))).toBe(false);
    expect(rehydrateSeatSkills(paths).restored).toContain(join(target, "scripts/helper.sh"));
    expect(statSync(join(target, "scripts/helper.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(target, "SKILL.md")).mode & 0o111).toBe(0);
  });
});

describe("F5: a selected plugin's bundled skills don't come back into the project", () => {
  function plugin(kind: "claude" | "codex") {
    const dir = join(scratch("seat-own-plugin-src-"), "team-plugin");
    for (const [rel, text] of Object.entries({
      [kind === "claude" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json"]: "{\"name\":\"team-plugin\"}\n",
      "hooks/hooks.json": "{}\n", "skills/review/SKILL.md": "---\nname: review\ndescription: d\n---\n", "skills/review/scripts/run.sh": "#!/bin/sh\n",
    })) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
    return dir;
  }
  const plan = (dir: string, runtime: string, cwd: string) => ({ runtime, cwd, entries: [{ effectiveId: "team-plugin", category: "plugin", absolutePath: dir, classification: "safe_projection" }],
    startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] }) as never;

  it("Claude: copies the plugin's hooks and manifest to the project, not its skills, for a seat with storage", async () => {
    const project = scratch("seat-own-project-");
    const adapter = new ClaudeCodeAdapter({ tmux: {} as never, fsOps: realFs });
    const seat = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    expect((await adapter.project(plan(plugin("claude"), "claude-code", project), { ...binding(project), seatSkillsRoot: seat.skillsRoot })).failed).toEqual([]);
    const copy = join(project, ".claude", "plugins", "team-plugin");
    expect(existsSync(join(copy, "hooks", "hooks.json"))).toBe(true);
    expect(existsSync(join(copy, "skills"))).toBe(false);
  });

  it("Codex: the same", async () => {
    const project = scratch("seat-own-project-");
    const adapter = new CodexRuntimeAdapter({ tmux: {} as never, fsOps: realFs as never });
    const seat = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "codex" });
    expect((await adapter.project(plan(plugin("codex"), "codex", project), { ...binding(project), seatSkillsRoot: seat.skillsRoot })).failed).toEqual([]);
    const copy = join(project, ".codex", "plugins", "team-plugin");
    expect(existsSync(join(copy, "hooks", "hooks.json"))).toBe(true);
    expect(existsSync(join(copy, "skills"))).toBe(false);
  });

  it("a seat without storage keeps today's whole copy", async () => {
    const project = scratch("seat-own-project-");
    const adapter = new ClaudeCodeAdapter({ tmux: {} as never, fsOps: realFs });
    await adapter.project(plan(plugin("claude"), "claude-code", project), binding(project));
    expect(existsSync(join(project, ".claude", "plugins", "team-plugin", "skills", "review", "SKILL.md"))).toBe(true);
  });
});

describe("F6: a Codex seat's first catalog lists every skill written before launch; Claude's version note covers every skill writer", () => {
  it("lists a skill that only the startup install wrote, in the text sent after launch", async () => {
    const db = createFullTestDb();
    try {
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const rig = rigRepo.createRig("own-catalog");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@own-catalog");
      const paths = seatSkillPaths({ rigId: rig.id, logicalId: "dev.impl", runtime: "codex" });
      writeSeatSkillCatalog(paths);
      const src = join(scratch("seat-own-startup-"), "orient", "SKILL.md");
      mkdirSync(dirname(src), { recursive: true });
      writeFileSync(src, "---\nname: orient\ndescription: Use when you start a turn.\n---\n\nbody\n");
      const real = new CodexRuntimeAdapter({ tmux: {} as never, fsOps: realFs as never });
      const sentCatalogs: string[] = [];
      const adapter = {
        runtime: "codex", listInstalled: async () => [], checkReady: async () => ({ ready: true }), launchHarness: async () => ({ ok: true }),
        project: async () => ({ projected: [], skipped: [], failed: [] }),
        deliverStartup: async (files: ResolvedStartupFile[], b: NodeBinding) => {
          const text = files.filter((f) => f.deliveryHint === "send_text");
          for (const f of text) sentCatalogs.push(readFileSync(f.absolutePath, "utf8"));
          return real.deliverStartup(files.filter((f) => f.deliveryHint !== "send_text"), b);
        },
      } as unknown as RuntimeAdapter;
      const result = await new StartupOrchestrator({ db, sessionRegistry, eventBus: new EventBus(db), tmuxAdapter: {} as TmuxAdapter, sleep: async () => {} }).startNode({
        rigId: rig.id, nodeId: node.id, sessionId: session.id, binding: binding(scratch("seat-own-project-")), adapter,
        plan: { runtime: "codex", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] } as never,
        resolvedStartupFiles: [
          { path: "skills/orient/SKILL.md", absolutePath: src, ownerRoot: dirname(dirname(src)), deliveryHint: "skill_install", required: false, appliesOn: ["fresh_start"] },
          { path: "openrig-seat-skills.md", absolutePath: paths.catalogPath, ownerRoot: paths.root, deliveryHint: "send_text", required: false, appliesOn: ["fresh_start"] },
        ],
        startupActions: [], isRestore: false, skipHarnessLaunch: true,
      });
      expect(result.ok).toBe(true);
      expect(sentCatalogs).toHaveLength(1);
      expect(sentCatalogs[0]).toContain("- **orient**: Use when you start a turn.");
    } finally { db.close(); }
  });

  it("names Claude's version limit for a seat whose skills come only from its profile or a startup file", () => {
    const none = { loadoutReceipts: 0, planEntries: [], startupFiles: [] };
    expect(claudeSeatSkillsNote(none)).toBeUndefined();
    expect(claudeSeatSkillsNote({ ...none, loadoutReceipts: 1 })).toContain("team_skills_need_claude_2.1.280");
    expect(claudeSeatSkillsNote({ ...none, planEntries: [{ category: "skill" }] })).toContain("team_skills_need_claude_2.1.280");
    expect(claudeSeatSkillsNote({ ...none, startupFiles: [{ path: "skills/orient/SKILL.md", deliveryHint: "skill_install" }] })).toContain("team_skills_need_claude_2.1.280");
    expect(claudeSeatSkillsNote({ ...none, planEntries: [{ category: "guidance" }], startupFiles: [{ path: "ROLE.md", deliveryHint: "guidance_merge" }] })).toBeUndefined();
  });
});

describe("F7: `--apply` reserves its attempt before it sends, and an interrupted or overlapping attempt is never sent again blindly", () => {
  let db: Database.Database;
  // The daemon's own schema, outbox included.
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); });
  afterEach(() => { db.close(); });

  function codexSeat() {
    const root = scratch("seat-own-catalog-");
    const catalog = join(root, "skills");
    const write = (trigger: string) => {
      mkdirSync(join(catalog, "queue-handoff"), { recursive: true });
      writeFileSync(join(catalog, "queue-handoff", "SKILL.md"), `---\nname: queue-handoff\ndescription: ${trigger}\n---\n\nbody\n`);
      writeFileSync(join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
      execFileSync("git", ["-C", root, "add", "."]); execFileSync("git", ["-C", root, "commit", "-qm", "c", "--allow-empty"]);
    };
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@openrig.invalid"]); execFileSync("git", ["-C", root, "config", "user.name", "T"]);
    write("Use when handing work to another seat.");
    const seat: SeatRef = { nodeId: "node-1", rigId: "rig-apply", logicalId: "dev.impl", runtime: "codex", sessionName: "dev-impl@team", cwd: scratch("seat-own-project-") };
    const paths = seatSkillPaths({ rigId: seat.rigId, logicalId: seat.logicalId, runtime: "codex" });
    const resolved = resolveSkillLoadout({ catalogRoot: catalog, topologySkills: ["queue-handoff"] });
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.errors));
    reconcileSkillLoadout({ loadout: resolved.loadout, runtime: "codex", cwd: seat.cwd, apply: true, topologyOwner: seat.sessionName, location: seatSkillLocation(paths, "codex") });
    return { seat, paths, catalog, write };
  }

  it("lets only one of two overlapping calls send, and the other reports the attempt in flight", async () => {
    const f = codexSeat();
    let release!: () => void;
    const sends: string[] = [];
    const sender: SeatSkillSender = { send: async (_s, _t, opts) => { sends.push(opts.deliveryId); await new Promise<void>((r) => { release = r; }); return { ok: true, outcome: "delivered" }; } };
    const first = applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    // The attempt is reserved before the send: the outbox holds it, claimed.
    expect(new OutboxHandler(db).getById(sends[0]!)?.deliveryState).toBe("sending");
    const second = await applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender });
    expect(second.delivery).toMatchObject({ state: "attempt-in-flight" });
    release();
    expect((await first).delivery).toMatchObject({ state: "sent", record: { outcome: "delivered" } });
    expect(sends).toHaveLength(1);
  });

  it("after a daemon stopped mid-send, the attempt is recovered as unconfirmed and isn't sent again", async () => {
    const f = codexSeat();
    const sends: string[] = [];
    void applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender: { send: async (_s, _t, o) => { sends.push(o.deliveryId); return new Promise(() => {}); } } });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    // Behaviour first: while that attempt is unfinished, another call doesn't send it again.
    await applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender: { send: async () => { sends.push("overlap"); return { ok: true, outcome: "delivered" }; } } });
    expect(sends).toHaveLength(1);
    // The process is gone; the next daemon start recovers abandoned claims without sending.
    expect(recoverSeatSkillAttempts(db)).toBe(1);
    const next = await applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender: { send: async () => { sends.push("again"); return { ok: true, outcome: "delivered" }; } } });
    expect(next.delivery).toMatchObject({ state: "earlier-attempt-unconfirmed", record: { deliveryId: sends[0], outcome: "unconfirmed" } });
    expect(sends).toHaveLength(1);
  });

  it("resends only on an explicit request after a finished attempt that wasn't delivered", async () => {
    const f = codexSeat();
    const sends: string[] = [];
    const sender = (outcome: "failed" | "delivered"): SeatSkillSender => ({ send: async (_s, _t, o) => { sends.push(o.deliveryId); return { ok: outcome === "delivered", outcome }; } });
    await applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender: sender("failed") });
    expect((await applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender: sender("delivered") })).delivery.state).toBe("earlier-attempt-unconfirmed");
    const resent = await applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender: sender("delivered"), resend: true });
    expect(resent.delivery).toMatchObject({ state: "sent", record: { outcome: "delivered" } });
    expect(sends).toHaveLength(2);
    expect(sends[1]).not.toBe(sends[0]);
    const after = await applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender: sender("delivered"), resend: true });
    expect(after.delivery).toMatchObject({ state: "already-delivered" });
    expect(sends).toHaveLength(2);
  });

  it("keeps the last confirmed delivery apart from a newer list's unresolved attempt", async () => {
    const f = codexSeat();
    await applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender: { send: async () => ({ ok: true, outcome: "delivered" }) } });
    const delivered = inspectSeatSkills(f.seat, "gen-1", db).confirmed;
    f.write("Use when handing work to another seat, with its row.");
    await applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender: { send: async () => ({ ok: false, outcome: "failed" }) } });
    const seen = inspectSeatSkills(f.seat, "gen-1", db);
    expect(seen.confirmed).toEqual(delivered);
    expect(seen.delivery).toMatchObject({ outcome: "failed" });
    expect(seen.delivery!.digest).not.toBe(delivered!.digest);
  });
});

describe("F8: OpenRig's generated plugin manifest and catalog are changed or removed only while they are as OpenRig wrote them", () => {
  it("keeps and names an edited plugin manifest, at launch and at rig down", () => {
    const { paths } = claudeSeat({ "SKILL.md": "skill\n" });
    writeFileSync(paths.pluginManifestPath, "{\"name\":\"openrig\",\"edited\":true}\n");
    const warnings: unknown = ensureSeatSkillPlugin(paths);
    // The behaviour first: the edit is still there (the warning is checked after).
    expect(readFileSync(paths.pluginManifestPath, "utf8")).toContain("edited");
    expect(String(warnings)).toContain(paths.pluginManifestPath);
    const down = cleanSeatSkills(paths, { dropRecords: true });
    expect(down.kept).toContain(paths.pluginManifestPath);
    expect(readFileSync(paths.pluginManifestPath, "utf8")).toContain("edited");
  });

  it("keeps and names an edited catalog, at launch and at rig down, and keeps an unrecorded one", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "codex" });
    writeSeatSkillCatalog(paths);
    writeFileSync(paths.catalogPath, "someone's own list\n");
    const relaunch = writeSeatSkillCatalog(paths);
    // The behaviour first: the person's catalog is still there (the kept flag is checked after).
    expect(readFileSync(paths.catalogPath, "utf8")).toBe("someone's own list\n");
    expect(relaunch.kept).toBe(true);
    expect(cleanSeatSkills(paths).kept).toContain(paths.catalogPath);
    expect(readFileSync(paths.catalogPath, "utf8")).toBe("someone's own list\n");

    const unrecorded = seatSkillPaths({ rigId: "rig-2", logicalId: "dev.impl", runtime: "codex" });
    mkdirSync(unrecorded.root, { recursive: true });
    writeFileSync(unrecorded.catalogPath, "not OpenRig's\n");
    expect(writeSeatSkillCatalog(unrecorded).kept).toBe(true);
    expect(cleanSeatSkills(unrecorded).kept).toContain(unrecorded.catalogPath);
    expect(readFileSync(unrecorded.catalogPath, "utf8")).toBe("not OpenRig's\n");
  });

  it("removes them, as before, while they are as OpenRig wrote them, with no skill loadout record", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "codex" });
    writeSeatSkillCatalog(paths);
    rmSync(paths.manifestPath, { force: true });
    expect(cleanSeatSkills(paths).kept).toEqual([]);
    expect(existsSync(paths.catalogPath)).toBe(false);
  });
});

describe("F9: an unreadable stored selection is reported as such, and nothing is sent from it", () => {
  let db: Database.Database;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); });
  afterEach(() => { db.close(); });

  const seat = (): { seat: SeatRef; paths: SeatSkillPaths } => {
    const s: SeatRef = { nodeId: "node-9", rigId: "rig-f9", logicalId: "dev.impl", runtime: "codex", sessionName: "dev-impl@f9", cwd: scratch("seat-own-project-") };
    return { seat: s, paths: seatSkillPaths({ rigId: s.rigId, logicalId: s.logicalId, runtime: "codex" }) };
  };

  it("a corrupt selection: not reconciled, says why, and sends nothing", async () => {
    const { seat: s, paths } = seat();
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.manifestPath, "{ truncated");
    const sends: string[] = [];
    const out = await applySeatSkills({ db, seat: s, occupant: "gen-1", catalogRoot: scratch("seat-own-cat-"), sender: { send: async () => { sends.push("x"); return { ok: true, outcome: "delivered" }; } } });
    expect(out.disk).toMatchObject({ ok: false, selection: "unreadable" });
    expect(out.disk.errors.join("\n")).toContain(paths.manifestPath);
    expect(out.delivery.state).toBe("not-sent");
    expect(sends).toEqual([]);
  });

  it("no stored selection at all: its own outcome, not a reconciliation", async () => {
    const { seat: s } = seat();
    const out = await applySeatSkills({ db, seat: s, occupant: "gen-1", catalogRoot: scratch("seat-own-cat-"), sender: { send: async () => ({ ok: true, outcome: "delivered" }) } });
    expect(out.disk).toMatchObject({ ok: true, selection: "none" });
  });
});

describe("F1, round 3: no cleanup, repair or projection through a linked anchor, ancestor or helper", () => {
  const moveAndLink = (dir: string): string => {
    const moved = join(scratch("seat-own-moved-"), "moved");
    renameSync(dir, moved);
    symlinkSync(moved, dir);
    return moved;
  };
  const recorded = (paths: SeatSkillPaths) => [join(paths.skillsRoot, "queue-handoff", "SKILL.md"), join(paths.skillsRoot, "queue-handoff", "scripts", "helper.sh")];

  it("a linked shared anchor (state/seats): cleanup removes nothing, keeps an empty folder, and a restore writes nothing there", () => {
    const { paths } = claudeSeat();
    mkdirSync(join(paths.skillsRoot, "empty-unrecorded"), { recursive: true });
    const anchor = join(home, "state", "seats");
    const moved = moveAndLink(anchor);
    const inMoved = (p: string) => join(moved, p.slice(anchor.length + 1));
    const out = cleanSeatSkills(paths);
    expect(out.removed).toEqual([]);
    for (const file of recorded(paths)) expect(existsSync(inMoved(file))).toBe(true);
    expect(existsSync(inMoved(join(paths.skillsRoot, "empty-unrecorded")))).toBe(true);
    expect(existsSync(inMoved(paths.pluginManifestPath))).toBe(true);

    rmSync(inMoved(recorded(paths)[0]!));
    const restored = rehydrateSeatSkills(paths);
    expect(restored.restored).toEqual([]);
    expect(existsSync(inMoved(recorded(paths)[0]!))).toBe(false);
  });

  for (const which of ["rig", "seat", "runtime"] as const) {
    it(`a linked ${which} folder: cleanup removes nothing in the moved tree and keeps its empty folders`, () => {
      const { paths } = claudeSeat();
      mkdirSync(join(paths.skillsRoot, "empty-unrecorded"), { recursive: true });
      const dir = which === "runtime" ? paths.root : which === "seat" ? dirname(paths.root) : dirname(dirname(paths.root));
      const moved = moveAndLink(dir);
      const inMoved = (p: string) => join(moved, p.slice(dir.length + 1));
      const out = cleanSeatSkills(paths);
      expect(out.removed).toEqual([]);
      for (const file of recorded(paths)) expect(existsSync(inMoved(file))).toBe(true);
      expect(existsSync(inMoved(join(paths.skillsRoot, "empty-unrecorded")))).toBe(true);
      expect(existsSync(inMoved(paths.pluginManifestPath))).toBe(true);
    });
  }

  it("ordinary storage (control): removes the recorded files and the folders it emptied, and keeps an unrecorded empty folder", () => {
    const { paths, target } = claudeSeat();
    mkdirSync(join(paths.skillsRoot, "empty-unrecorded"), { recursive: true });
    const out = cleanSeatSkills(paths);
    expect(out.removed.sort()).toEqual(recorded(paths).sort());
    expect(existsSync(target)).toBe(false);
    expect(existsSync(paths.pluginManifestPath)).toBe(false);
    expect(existsSync(join(paths.skillsRoot, "empty-unrecorded"))).toBe(true);
  });

  for (const runtime of ["claude-code", "codex"] as const) {
    for (const link of ["helper folder", "helper file"] as const) {
      it(`${runtime} projection: a linked ${link} is not written or re-moded, the external bytes and mode stay, and the skill is reported incomplete`, async () => {
        const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime });
        const source = join(scratch("seat-own-proj-src-"), "review");
        mkdirSync(join(source, "scripts"), { recursive: true });
        writeFileSync(join(source, "SKILL.md"), "---\nname: review\ndescription: d\n---\n");
        writeFileSync(join(source, "scripts", "run.sh"), "#!/bin/sh\necho team\n");
        chmodSync(join(source, "scripts", "run.sh"), 0o755);
        const external = scratch("seat-own-external-");
        writeFileSync(join(external, "run.sh"), "the person's own\n");
        chmodSync(join(external, "run.sh"), 0o644);
        const target = join(paths.skillsRoot, "review");
        mkdirSync(target, { recursive: true });
        if (link === "helper folder") symlinkSync(external, join(target, "scripts"));
        else { mkdirSync(join(target, "scripts")); symlinkSync(join(external, "run.sh"), join(target, "scripts", "run.sh")); }
        const project = scratch("seat-own-project-");
        const adapter = runtime === "codex" ? new CodexRuntimeAdapter({ tmux: {} as never, fsOps: realFs as never }) : new ClaudeCodeAdapter({ tmux: {} as never, fsOps: realFs });
        const result = await adapter.project({ runtime, cwd: project, entries: [{ effectiveId: "review", category: "skill", absolutePath: source, classification: "safe_projection" }],
          startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] } as never, { ...binding(project), seatSkillsRoot: paths.skillsRoot });
        expect(readFileSync(join(external, "run.sh"), "utf8")).toBe("the person's own\n");
        expect(statSync(join(external, "run.sh")).mode & 0o777).toBe(0o644);
        expect(JSON.stringify(result.warnings ?? [])).toContain("not inside this seat's storage");
        // Partial projection is reported as such: the skill is skipped, not projected, and the warning says it's incomplete.
        expect(result.projected).not.toContain("review");
        expect(result.skipped).toContain("review");
        expect(JSON.stringify(result.warnings ?? [])).toContain("review: incomplete in this seat's storage: 1 file(s) not projected");
        expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("name: review");
      });
    }
  }
});

describe("F1, round 4: the skill-loadout reconciler changes nothing in a seat's storage that is linked outside the anchor", () => {
  let db: Database.Database;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); });
  afterEach(() => { db.close(); });

  function tree(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string, rel: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        const full = join(d, e.name);
        const mode = (statSync(full).mode & 0o777).toString(8);
        if (e.isDirectory()) { out.push(`${r}/ ${mode}`); walk(full, r); } else out.push(`${r} ${mode} ${readFileSync(full, "utf8").length}:${readFileSync(full, "utf8")}`);
      }
    };
    walk(dir, "");
    return out.sort();
  }

  function seatWithSelection() {
    const root = scratch("seat-own-r4-catalog-");
    const catalog = join(root, "skills");
    const write = (trigger: string) => {
      mkdirSync(join(catalog, "queue-handoff", "scripts"), { recursive: true });
      writeFileSync(join(catalog, "queue-handoff", "SKILL.md"), `---\nname: queue-handoff\ndescription: ${trigger}\n---\n\nbody\n`);
      writeFileSync(join(catalog, "queue-handoff", "scripts", "run.sh"), "#!/bin/sh\n");
      chmodSync(join(catalog, "queue-handoff", "scripts", "run.sh"), 0o755);
      writeFileSync(join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
      execFileSync("git", ["-C", root, "add", "."]); execFileSync("git", ["-C", root, "commit", "-qm", "c", "--allow-empty"]);
    };
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@openrig.invalid"]); execFileSync("git", ["-C", root, "config", "user.name", "T"]);
    write("Use when handing work to another seat.");
    const seat: SeatRef = { nodeId: "node-r4", rigId: "rig-r4", logicalId: "dev.impl", runtime: "codex", sessionName: "dev-impl@r4", cwd: scratch("seat-own-project-") };
    const paths = seatSkillPaths({ rigId: seat.rigId, logicalId: seat.logicalId, runtime: "codex" });
    const resolved = resolveSkillLoadout({ catalogRoot: catalog, topologySkills: ["queue-handoff"] });
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.errors));
    expect(reconcileSkillLoadout({ loadout: resolved.loadout, runtime: "codex", cwd: seat.cwd, apply: true, topologyOwner: seat.sessionName, location: seatSkillLocation(paths, "codex") }).ok).toBe(true);
    return { seat, paths, catalog, write };
  }

  it("seat apply: a linked runtime folder and an advanced catalog skill leave the moved tree's bytes, modes and manifest as they were", async () => {
    const f = seatWithSelection();
    const moved = join(scratch("seat-own-r4-moved-"), "codex");
    renameSync(f.paths.root, moved);
    symlinkSync(moved, f.paths.root);
    const before = tree(moved);
    f.write("Use when handing work to another seat, with its row.");
    const sends: string[] = [];
    // Whatever the call returns or throws, the moved tree is checked first.
    const out = await applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender: { send: async () => { sends.push("x"); return { ok: true, outcome: "delivered" }; } } })
      .catch((error: unknown) => error);
    expect(tree(moved)).toEqual(before);
    expect(out).toMatchObject({ disk: { ok: false } });
    expect((out as { disk: { errors: string[] } }).disk.errors.join("\n")).toContain("seat_storage_refused");
    expect(sends).toEqual([]);
  });

  it("seat apply (control): the same refresh in ordinary storage updates the skill", async () => {
    const f = seatWithSelection();
    f.write("Use when handing work to another seat, with its row.");
    const out = await applySeatSkills({ db, seat: f.seat, occupant: "gen-1", catalogRoot: f.catalog, sender: { send: async () => ({ ok: true, outcome: "delivered" }) } });
    expect(out.disk.ok).toBe(true);
    expect(readFileSync(join(f.paths.skillsRoot, "queue-handoff", "SKILL.md"), "utf8")).toContain("with its row.");
    expect(statSync(join(f.paths.skillsRoot, "queue-handoff", "scripts", "run.sh")).mode & 0o777).toBe(0o755);
  });
});

describe("F1, round 5: containment's parent test is exact", () => {
  it("treats a first component like `..name` as inside the seat's storage, and `..` itself as outside", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    mkdirSync(paths.root, { recursive: true });
    expect(insideSeatStorage(paths.root, join(paths.root, "..name", "file.md"))).toBe(true);
    expect(insideSeatStorage(paths.root, join(paths.root, "..", "file.md"))).toBe(false);
  });
});
