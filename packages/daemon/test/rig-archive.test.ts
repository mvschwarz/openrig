// OPR.0.3.3.19 - rig archive affordance.
//
// THE load-bearing test is AC-8: archive is non-destructive (retains the rigs
// row + topology + snapshots, restore stays reachable) and is explicitly
// contrasted against `down --delete`, which removes the rigs row and makes
// RestoreOrchestrator return `rig_not_found`. Archive MUST NOT take the delete path.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import { Hono } from "hono";
import { psRoutes } from "../src/routes/ps.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => null),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

function mockResume(): ClaudeResumeAdapter & CodexResumeAdapter {
  return {
    canResume: vi.fn(() => false),
    resume: vi.fn(async () => ({ ok: true as const })),
  } as unknown as ClaudeResumeAdapter & CodexResumeAdapter;
}

describe("rig archive affordance (OPR.0.3.3.19)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let checkpointStore: CheckpointStore;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  });

  afterEach(() => { db.close(); });

  function createOrchestrator() {
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    return new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: mockResume(),
      codexResume: mockResume(),
    });
  }

  /** Build a rig with two nodes + one edge so retention is observable. */
  function seedRigWithTopology(name: string): string {
    const rig = rigRepo.createRig(name);
    const a = rigRepo.addNode(rig.id, "orchestrator", { role: "orchestrator", runtime: "claude-code" });
    const b = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "codex" });
    rigRepo.addEdge(rig.id, a.id, b.id, "delegates_to");
    return rig.id;
  }

  function rowCount(table: string, rigCol: string, rigId: string): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${rigCol} = ?`).get(rigId) as { c: number }).c;
  }

  it("AC-8 (load-bearing): archive RETAINS row + topology + snapshots and keeps restore reachable; down --delete REMOVES the row and breaks restore (rig_not_found)", async () => {
    const orch = createOrchestrator();
    const archiveRig = seedRigWithTopology("archive-me");
    const deleteRig = seedRigWithTopology("delete-me");
    const snapA = snapshotCapture.captureSnapshot(archiveRig, "manual");
    const snapB = snapshotCapture.captureSnapshot(deleteRig, "manual");

    // --- ARCHIVE PATH: non-destructive ---
    expect(rigRepo.archiveRig(archiveRig)).toBe(true);
    // rigs row + topology rows + snapshot all retained on disk.
    expect(rigRepo.getRig(archiveRig)).not.toBeNull();
    expect(rowCount("rigs", "id", archiveRig)).toBe(1);
    expect(rowCount("nodes", "rig_id", archiveRig)).toBe(2);
    expect(rowCount("edges", "rig_id", archiveRig)).toBe(1);
    expect(rowCount("snapshots", "rig_id", archiveRig)).toBeGreaterThan(0);
    // restore is REACHABLE - it does NOT return rig_not_found, because the row exists.
    const restoreArchived = await orch.restore(snapA.id);
    expect(restoreArchived.ok === false && restoreArchived.code === "rig_not_found").toBe(false);
    // unarchive returns it to the default view; still non-destructive.
    expect(rigRepo.unarchiveRig(archiveRig)).toBe(true);
    expect(rigRepo.getRig(archiveRig)).not.toBeNull();

    // --- DELETE PATH (the contrast): destructive ---
    rigRepo.deleteRig(deleteRig);
    expect(rigRepo.getRig(deleteRig)).toBeNull();
    expect(rowCount("rigs", "id", deleteRig)).toBe(0);
    // restore now breaks with rig_not_found - the row is gone.
    const restoreDeleted = await orch.restore(snapB.id);
    expect(restoreDeleted.ok).toBe(false);
    if (restoreDeleted.ok === false) {
      expect(restoreDeleted.code).toBe("rig_not_found");
    }
  });

  describe("repository archive methods + filters", () => {
    it("archiveRig/unarchiveRig flip the flag and are idempotent", () => {
      const rigId = rigRepo.createRig("r1").id;
      expect(rigRepo.archiveRig(rigId)).toBe(true);
      expect(rigRepo.archiveRig(rigId)).toBe(false); // already archived
      expect(rigRepo.unarchiveRig(rigId)).toBe(true);
      expect(rigRepo.unarchiveRig(rigId)).toBe(false); // already active
    });

    it("listRigs / getRigSummaries default-exclude archived; includeArchived / archivedOnly opt in", () => {
      const active = rigRepo.createRig("active").id;
      const archived = rigRepo.createRig("archived").id;
      rigRepo.archiveRig(archived);

      // default excludes archived
      expect(rigRepo.listRigs().map((r) => r.id)).toEqual([active]);
      expect(rigRepo.getRigSummaries().map((s) => s.id)).toEqual([active]);
      // includeArchived returns both
      expect(rigRepo.listRigs({ includeArchived: true }).map((r) => r.id).sort()).toEqual([active, archived].sort());
      // archivedOnly returns only archived
      expect(rigRepo.listRigs({ archivedOnly: true }).map((r) => r.id)).toEqual([archived]);
      const onlyArchived = rigRepo.getRigSummaries({ archivedOnly: true });
      expect(onlyArchived.map((s) => s.id)).toEqual([archived]);
      expect(onlyArchived[0]!.archivedAt).not.toBeNull();
    });
  });

  describe("ps-projection archive filter", () => {
    it("getEntries default-excludes archived; includeArchived / archivedOnly opt in; carries isArchived", () => {
      const active = rigRepo.createRig("active").id;
      const archived = rigRepo.createRig("archived").id;
      rigRepo.archiveRig(archived);
      const ps = new PsProjectionService({ db });

      expect(ps.getEntries().map((e) => e.rigId)).toEqual([active]);
      expect(ps.getEntries({ includeArchived: true }).map((e) => e.rigId).sort()).toEqual([active, archived].sort());
      const only = ps.getEntries({ archivedOnly: true });
      expect(only.map((e) => e.rigId)).toEqual([archived]);
      expect(only[0]!.isArchived).toBe(true);
      expect(only[0]!.archivedAt).not.toBeNull();
    });

    it("counts archived rigs from the archived_at index, and /api/ps sends that count beside its unchanged list (#3636)", async () => {
      const active = rigRepo.createRig("active").id;
      for (const name of ["old-1", "old-2"]) rigRepo.archiveRig(rigRepo.createRig(name).id);
      const ps = new PsProjectionService({ db });
      expect(ps.countArchivedRigs()).toBe(2);
      // The daemon's own engine plans it on the index, not a scan of rigs.
      const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM rigs WHERE archived_at IS NOT NULL").all() as Array<{ detail: string }>)
        .map((row) => row.detail).join(" ");
      expect(plan).toContain("idx_rigs_archived");

      const app = new Hono();
      app.use("*", async (c, next) => { c.set("psProjectionService" as never, ps as never); await next(); });
      app.route("/api/ps", psRoutes);
      const res = await app.request("/api/ps");
      expect(res.headers.get("x-openrig-archived-count")).toBe("2");
      expect((await res.json() as Array<{ rigId: string }>).map((entry) => entry.rigId)).toEqual([active]);
    });
  });

  describe("AC-4 host-scoped (no cross-host leak)", () => {
    it("archive is local to the host that owns the rigs row; a 2nd host node is unaffected and needs no rework", () => {
      // Two independent daemon DBs == two host nodes. V0.4 multi-host nests each
      // rig set under its own host node; today there is one localhost, but the
      // archive flag lives on the LOCAL rigs row, so it is keyed by host by
      // construction and can never cross the host boundary. We do NOT build any
      // multi-host table/registry here (out of scope) - two repositories suffice
      // to simulate two hosts and prove no cross-host leak.
      const dbHostA = db; // host A (from beforeEach)
      const repoA = rigRepo;
      const dbHostB = createFullTestDb(); // host B
      const repoB = new RigRepository(dbHostB);
      try {
        const a1 = repoA.createRig("shared-name").id;
        repoA.createRig("a-active");
        const b1 = repoB.createRig("shared-name").id;
        repoB.createRig("b-active");

        // Archive a rig under host A only.
        expect(repoA.archiveRig(a1)).toBe(true);

        // Host A: default hides it; archivedOnly shows only it.
        expect(repoA.getRigSummaries().some((s) => s.id === a1)).toBe(false);
        expect(repoA.getRigSummaries({ archivedOnly: true }).map((s) => s.id)).toEqual([a1]);

        // Host B is UNAFFECTED: the same-named rig stays active + visible, and
        // host B has NO archived rigs at all - the flag never crossed hosts.
        expect(repoB.getRigSummaries().some((s) => s.id === b1)).toBe(true);
        expect(repoB.getRigSummaries({ archivedOnly: true })).toEqual([]);

        // Same guarantee at the ps-projection seam (the CLI/UI default read).
        const psA = new PsProjectionService({ db: dbHostA });
        const psB = new PsProjectionService({ db: dbHostB });
        expect(psA.getEntries().some((e) => e.rigId === a1)).toBe(false);
        expect(psA.getEntries({ archivedOnly: true }).map((e) => e.rigId)).toEqual([a1]);
        expect(psB.getEntries({ archivedOnly: true })).toEqual([]);
      } finally {
        dbHostB.close();
      }
    });
  });
});
