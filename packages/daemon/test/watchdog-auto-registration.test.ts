import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine, type DeliveryFn } from "../src/domain/watchdog-policy-engine.js";
import { makeIdleGateQitemPolicy } from "../src/domain/policies/idle-gate-qitem.js";
import { makeRigAnchor, PARKED_OWNER_POLICY_NAME } from "../src/domain/policies/parked-owner-consumer.js";
import { createFullTestDb, mockTmuxAdapter } from "./helpers/test-app.js";

const AUTO_POLICY = "idle-gate-qitem";
const AUTO_REGISTRAR = "daemon@kernel";

function autoRows(db: Database.Database, targetSession: string) {
  return new WatchdogJobsRepository(db).listAll().filter((job) =>
    job.policy === AUTO_POLICY &&
    job.targetSession === targetSession &&
    job.targetGeneration === null
  );
}

function seedCanonicalNode(db: Database.Database, rigName = "auto-rig") {
  const rigRepo = new RigRepository(db);
  const rig = rigRepo.createRig(rigName);
  const node = rigRepo.addNode(rig.id, "dev-qa", {
    role: "qa",
    runtime: "codex",
  });
  return { rigRepo, rig, node, sessionName: `dev-qa@${rigName}` };
}

describe("W2c watchdog auto-registration — production composition", () => {
  const originalNoKernel = process.env.OPENRIG_NO_KERNEL;
  const originalAutoRegister = process.env.OPENRIG_POLICIES_IDLE_GATE_QITEM_AUTO_REGISTER;
  const tempRoots: string[] = [];

  beforeAll(() => {
    process.env.OPENRIG_NO_KERNEL = "1";
    // B6 — auto-registration is no longer default-on; this suite exercises the
    // registration machinery, so it runs under the explicit fleet opt-in. The
    // ruled default ("off") has its own describe below.
    process.env.OPENRIG_POLICIES_IDLE_GATE_QITEM_AUTO_REGISTER = "all";
  });

  afterAll(() => {
    if (originalNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
    else process.env.OPENRIG_NO_KERNEL = originalNoKernel;
    if (originalAutoRegister === undefined) delete process.env.OPENRIG_POLICIES_IDLE_GATE_QITEM_AUTO_REGISTER;
    else process.env.OPENRIG_POLICIES_IDLE_GATE_QITEM_AUTO_REGISTER = originalAutoRegister;
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("production-wired NodeLauncher registers one configured role-bound job for a canonical seat", async () => {
    const { db, deps, eventLoopMonitor } = await createDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
    });
    try {
      const { rig, node, sessionName } = seedCanonicalNode(db);
      const result = await deps.nodeLauncher.launchNode(rig.id, node.logicalId, { sessionName });
      expect(result.ok).toBe(true);
      const session = deps.sessionRegistry.getSessionsForRig(rig.id).find((row) => row.sessionName === sessionName);
      expect(session?.status).toBe("running");

      const rows = autoRows(db, sessionName);
      expect.soft(rows, "current base leaves the successfully launched canonical seat unwatched").toHaveLength(1);
      if (rows[0]) {
        expect.soft(rows[0]).toMatchObject({
          policy: AUTO_POLICY,
          targetSession: sessionName,
          intervalSeconds: 60,
          scanIntervalSeconds: 60,
          activeWakeIntervalSeconds: 900,
          state: "active",
          registeredBySession: AUTO_REGISTRAR,
          registeredByGeneration: null,
          targetGeneration: null,
        });
        expect.soft(rows[0].specYaml).toBe(
          `policy: idle-gate-qitem\n` +
          `generated_by: openrig-daemon\n` +
          `target:\n  session: ${sessionName}\n` +
          `interval_seconds: 60\n` +
          `scan_interval_seconds: 60\n` +
          `active_wake_interval_seconds: 900\n`,
        );
      }
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("a post-start repository failure preserves the launched seat and reports exact missing coverage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, deps, eventLoopMonitor } = await createDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
    });
    try {
      const { rig, node, sessionName } = seedCanonicalNode(db, "failure-rig");
      const register = vi.spyOn(deps.watchdogJobsRepo!, "register").mockImplementation(() => {
        throw new Error("injected watchdog repository failure");
      });

      const result = await deps.nodeLauncher.launchNode(rig.id, node.logicalId, { sessionName });
      expect(result.ok).toBe(true);
      expect(deps.sessionRegistry.getSessionsForRig(rig.id).find((row) => row.sessionName === sessionName)?.status)
        .toBe("running");
      expect.soft(register, "the post-start mint must attempt the auto-registration write").toHaveBeenCalled();
      const attributable = warn.mock.calls.map((args) => args.map(String).join(" ")).filter((line) =>
        line.includes(node.id) && line.includes(sessionName)
      );
      expect.soft(attributable.some((line) => line.includes("injected watchdog repository failure"))).toBe(true);
      expect.soft(attributable.some((line) => /missing/i.test(line))).toBe(true);
      expect.soft(autoRows(db, sessionName)).toHaveLength(0);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("legacy and noncanonical claimed seats are named exclusions with no ensure or coverage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, deps, eventLoopMonitor } = await createDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
    });
    try {
      const { rigRepo, rig, node } = seedCanonicalNode(db, "exclusion-rig");
      const claimed = rigRepo.addNode(rig.id, "legacy-claimed", { role: "worker", runtime: "terminal" });
      const register = vi.spyOn(deps.watchdogJobsRepo!, "register");
      const auto = (deps as unknown as {
        watchdogAutoRegistration?: { ensure: (...args: unknown[]) => unknown; assertCoverage: (...args: unknown[]) => unknown };
      }).watchdogAutoRegistration;
      const ensure = auto ? vi.spyOn(auto, "ensure") : null;
      const coverage = auto ? vi.spyOn(auto, "assertCoverage") : null;

      deps.sessionRegistry.registerSession(node.id, "r01-dev-qa");
      deps.sessionRegistry.registerClaimedSession(claimed.id, "external-seat-without-canonical-rig");
      deps.sessionRegistry.registerClaimedSession(node.id, "bad:seat@exclusion-rig");

      expect(register).not.toHaveBeenCalled();
      if (ensure) expect(ensure).not.toHaveBeenCalled();
      if (coverage) expect(coverage).not.toHaveBeenCalled();
      expect(autoRows(db, "r01-dev-qa")).toHaveLength(0);
      expect(autoRows(db, "external-seat-without-canonical-rig")).toHaveLength(0);
      expect(autoRows(db, "bad:seat@exclusion-rig")).toHaveLength(0);
      const lines = warn.mock.calls.map((args) => args.map(String).join(" "));
      expect(lines.some((line) =>
        line.includes("r01-dev-qa") ||
        line.includes("external-seat-without-canonical-rig") ||
        line.includes("bad:seat@exclusion-rig")
      ))
        .toBe(false);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("coverage refuses a formerly valid row after its persisted state mutates outside the closed set", async () => {
    const { db, deps, eventLoopMonitor } = await createDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
    });
    try {
      const { node, sessionName } = seedCanonicalNode(db, "state-rig");
      deps.sessionRegistry.registerSession(node.id, sessionName);
      const [row] = autoRows(db, sessionName);
      expect(row).toBeDefined();
      db.prepare("UPDATE watchdog_jobs SET state = 'paused' WHERE job_id = ?").run(row!.jobId);
      const auto = (deps as unknown as {
        watchdogAutoRegistration: { assertCoverage(nodeId: string, seat: string): unknown };
      }).watchdogAutoRegistration;
      expect(() => auto.assertCoverage(node.id, sessionName)).toThrow(/auto_registration_state_invalid/);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("coverage warnings retain node, seat, and every conflicting job id/state", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, deps, eventLoopMonitor } = await createDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
    });
    try {
      const { node, sessionName } = seedCanonicalNode(db, "conflict-rig");
      deps.sessionRegistry.registerSession(node.id, sessionName);
      const first = autoRows(db, sessionName)[0]!;
      const second = deps.watchdogJobsRepo!.register({
        policy: AUTO_POLICY,
        specYaml: first.specYaml,
        targetSession: sessionName,
        intervalSeconds: 60,
        scanIntervalSeconds: 60,
        activeWakeIntervalSeconds: 900,
        registeredBySession: AUTO_REGISTRAR,
        targetGenerationUuid: null,
      });

      deps.sessionRegistry.registerClaimedSession(node.id, sessionName, "handover");
      const lines = warn.mock.calls.map((args) => args.map(String).join(" "));
      const coverage = lines.find((line) => line.includes("watchdog coverage FAILED"));
      expect(coverage).toContain(node.id);
      expect(coverage).toContain(sessionName);
      expect(coverage).toContain(first.jobId);
      expect(coverage).toContain(second.jobId);
      expect(coverage).toContain('"state":"active"');
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("canonical rig mismatch is a loud target_mismatch while the core session persists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, deps, eventLoopMonitor } = await createDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
    });
    try {
      const { rig, node } = seedCanonicalNode(db, "actual-rig");
      const mismatchedSeat = "dev-qa@different-rig";
      const session = deps.sessionRegistry.registerSession(node.id, mismatchedSeat);
      expect(deps.sessionRegistry.getSessionsForRig(rig.id).some((row) => row.id === session.id)).toBe(true);
      const lines = warn.mock.calls.map((args) => args.map(String).join(" "));
      expect(lines.some((line) =>
        line.includes("target_mismatch") && line.includes(node.id) && line.includes(mismatchedSeat)
      )).toBe(true);
      expect(autoRows(db, mismatchedSeat)).toHaveLength(0);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("missing rig topology is a loud target_mismatch while the core session persists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, deps, eventLoopMonitor } = await createDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
    });
    try {
      const { node, sessionName } = seedCanonicalNode(db, "missing-rig");
      db.pragma("foreign_keys = OFF");
      db.prepare("UPDATE nodes SET rig_id = 'does-not-exist' WHERE id = ?").run(node.id);
      db.pragma("foreign_keys = ON");
      expect(db.prepare("SELECT id FROM nodes WHERE id = ?").get(node.id)).toBeDefined();

      const session = deps.sessionRegistry.registerSession(node.id, sessionName);
      expect(db.prepare("SELECT id FROM sessions WHERE id = ?").get(session.id)).toBeDefined();
      const lines = warn.mock.calls.map((args) => args.map(String).join(" "));
      expect(lines.some((line) =>
        line.includes("target_mismatch") && line.includes(node.id) && line.includes(sessionName)
      )).toBe(true);
      expect(autoRows(db, sessionName)).toHaveLength(0);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("startup coverage reports a dangling missing-node session without deleting the core row", async () => {
    const root = mkdtempSync(join(tmpdir(), "w2c-missing-node-"));
    tempRoots.push(root);
    const dbPath = join(root, "openrig.sqlite");
    const seed = createDb(dbPath);
    migrate(seed, ALL_MIGRATIONS);
    seed.pragma("foreign_keys = OFF");
    seed.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status) VALUES ('dangling-session', 'missing-node', 'dev-qa@missing-node-rig', 'unknown')",
    ).run();
    seed.pragma("foreign_keys = ON");
    seed.close();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, eventLoopMonitor } = await createDaemon({
      dbPath,
      tmuxExec: async () => "",
      cmuxExec: async () => "",
    });
    try {
      expect(db.prepare("SELECT id FROM sessions WHERE id = 'dangling-session'").get()).toBeDefined();
      const lines = warn.mock.calls.map((args) => args.map(String).join(" "));
      expect(lines.some((line) =>
        line.includes("target_mismatch") && line.includes("missing-node") && line.includes("dev-qa@missing-node-rig")
      )).toBe(true);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("startup sweep reports a pre-existing latest unknown canonical seat with missing coverage", async () => {
    const root = mkdtempSync(join(tmpdir(), "w2c-startup-sweep-"));
    tempRoots.push(root);
    const dbPath = join(root, "openrig.sqlite");
    const seed = createDb(dbPath);
    migrate(seed, ALL_MIGRATIONS);
    const { node, sessionName } = seedCanonicalNode(seed, "sweep-rig");
    const seededSession = new SessionRegistry(seed).registerSession(node.id, sessionName);
    expect(seededSession.status).toBe("unknown");
    seed.close();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, eventLoopMonitor } = await createDaemon({
      dbPath,
      tmuxExec: async () => "",
      cmuxExec: async () => "",
    });
    try {
      const attributable = warn.mock.calls.map((args) => args.map(String).join(" ")).filter((line) =>
        line.includes(node.id) && line.includes(sessionName)
      );
      expect(attributable.some((line) => /missing/i.test(line))).toBe(true);
      expect(autoRows(db, sessionName)).toHaveLength(0);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("generation turnover reuses one role-bound job and the real idle-gate engine delivers once", async () => {
    const now = new Date("2026-08-08T18:00:00.000Z");
    const fresh = "2026-08-08T17:59:00.000Z";
    const { db, deps, eventLoopMonitor } = await createDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
    });
    try {
      const { rig, node, sessionName } = seedCanonicalNode(db, "delivery-rig");
      deps.sessionRegistry.registerSession(node.id, sessionName, "initial");
      const firstGeneration = deps.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid;
      const firstRows = autoRows(db, sessionName);
      expect.soft(firstRows, "first mint must auto-register the role-bound job").toHaveLength(1);
      if (!firstRows[0]) return;

      deps.sessionRegistry.registerClaimedSession(node.id, sessionName, "handover");
      deps.sessionRegistry.registerClaimedSession(node.id, sessionName, "adopt");
      const latestGeneration = deps.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid;
      expect(latestGeneration).not.toBe(firstGeneration);
      const rows = autoRows(db, sessionName);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        jobId: firstRows[0].jobId,
        state: "active",
        registeredBySession: AUTO_REGISTRAR,
        registeredByGeneration: null,
        targetGeneration: null,
      });

      db.prepare(
        `INSERT INTO queue_items
          (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body)
         VALUES
          ('q-w2c-delivery', '2026-08-08T17:00:00Z', '2026-08-08T17:00:00Z',
           'orch@delivery-rig', ?, 'pending', 'urgent', 'deep', '["gate:guard"]', 'review the gate')`,
      ).run(sessionName);
      const seatActivity = {
        getSeatStateBySession: () => ({
          seatNodeId: node.id,
          activity: "idle-at-prompt" as const,
          needsInput: { count: 0, reason: null },
          decidedBy: "lifecycle-hooks" as const,
          seq: 1,
          changedAt: fresh,
          rungs: [],
          lastSwap: null,
        }),
      };

      const history = new WatchdogHistoryLog(db);
      const deliveries: Array<{ targetSession: string; message: string }> = [];
      const deliver: DeliveryFn = async (request) => {
        deliveries.push(request);
        return { status: "ok" };
      };
      const engine = new WatchdogPolicyEngine({
        jobsRepo: deps.watchdogJobsRepo!,
        historyLog: history,
        eventBus: deps.eventBus,
        deliver,
        now: () => now,
        additionalPolicies: [makeIdleGateQitemPolicy({ db, seatActivity })],
        resolveTargetGeneration: (seat) => deps.sessionRegistry.currentOccupantGenerationForSession(seat),
      });

      const first = await engine.evaluate(deps.watchdogJobsRepo!.getByIdOrThrow(rows[0]!.jobId));
      expect(first.outcome.action).toBe("send");
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.targetSession).toBe(sessionName);
      expect(deliveries[0]?.message).toContain("q-w2c-delivery");
      expect(history.listForJob(rows[0]!.jobId).map((entry) => entry.outcome)).toEqual(["sent"]);

      // AMENDED by OPR.0.5.8.1 S2. The subject — "delivers once" — is unchanged
      // and still asserted by the delivery count below. Only the skip REASON
      // moved: the gated-condition gate now decides before the engine's
      // active-wake window is consulted. The two are not interchangeable, so
      // the new reason is asserted exactly rather than relaxed to "some skip".
      const second = await engine.evaluate(deps.watchdogJobsRepo!.getByIdOrThrow(rows[0]!.jobId));
      expect(second.outcome).toEqual({
        action: "skip",
        reason: "gate_condition_unchanged",
        // Notes match the convention of this policy's sibling quiet skips
        // (seat_active carries them too): available to a caller inspecting the
        // outcome, while the quiet classification keeps them out of history.
        notes: { seat: sessionName, pendingGateCount: 1 },
      });
      expect(deliveries).toHaveLength(1);
      expect(autoRows(db, sessionName)).toHaveLength(1);

      const generationBound = deps.watchdogJobsRepo!.register({
        policy: AUTO_POLICY,
        specYaml: rows[0]!.specYaml,
        targetSession: sessionName,
        intervalSeconds: 60,
        scanIntervalSeconds: 60,
        activeWakeIntervalSeconds: 900,
        registeredBySession: "ops@kernel",
        targetGenerationUuid: "stale-generation",
      });
      const mismatch = await engine.evaluate(generationBound);
      expect(mismatch.outcome).toEqual({ action: "skip", reason: "target_generation_mismatch" });
      expect(deliveries).toHaveLength(1);
      expect(history.listForJob(generationBound.jobId)[0]).toMatchObject({
        outcome: "skipped",
        skipReason: "target_generation_mismatch",
        evaluationNotes: {
          armedForGeneration: "stale-generation",
          liveGeneration: latestGeneration,
          targetSession: sessionName,
        },
      });
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);
});

describe("W2c watchdog auto-registration — mint altitude", () => {
  it("NodeLauncher invokes ensure then coverage while registerSession is still unknown", async () => {
    const db = createFullTestDb();
    try {
      const { rigRepo, rig, node, sessionName } = seedCanonicalNode(db, "launch-rig");
      const seen: Array<{ stage: string; status: string | undefined }> = [];
      const observer = {
        ensure(nodeId: string, seat: string) {
          const row = db.prepare("SELECT status FROM sessions WHERE node_id = ? AND session_name = ? ORDER BY created_at DESC LIMIT 1")
            .get(nodeId, seat) as { status: string } | undefined;
          seen.push({ stage: "ensure", status: row?.status });
        },
        assertCoverage(nodeId: string, seat: string) {
          const row = db.prepare("SELECT status FROM sessions WHERE node_id = ? AND session_name = ? ORDER BY created_at DESC LIMIT 1")
            .get(nodeId, seat) as { status: string } | undefined;
          seen.push({ stage: "coverage", status: row?.status });
        },
      };
      const sessionRegistry = new (SessionRegistry as unknown as new (
        db: Database.Database,
        observer: typeof observer,
      ) => SessionRegistry)(db, observer);
      const launcher = new NodeLauncher({
        db,
        rigRepo,
        sessionRegistry,
        eventBus: new EventBus(db),
        tmuxAdapter: mockTmuxAdapter(),
      });

      const result = await launcher.launchNode(rig.id, node.logicalId, { sessionName });
      expect(result.ok).toBe(true);
      expect(seen).toEqual([
        { stage: "ensure", status: "unknown" },
        { stage: "coverage", status: "unknown" },
      ]);
    } finally {
      db.close();
    }
  });
});

// B6 founder ruling — the RULED DEFAULT: auto-registration is NOT default-on. These tests build the
// registration unit directly with a fake settings store so the gate is exercised without env plumbing.
describe("B6 — idle-gate auto-registration default-off / opt-in gate", () => {
  const settings = (autoRegister: string, optIn = "") => ({
    resolveOne: (key: string) => {
      if (key === "policies.idle_gate_qitem.auto_register") return { value: autoRegister };
      if (key === "policies.idle_gate_qitem.opt_in_sessions") return { value: optIn };
      if (key === "policies.idle_gate_qitem.scan_interval_seconds") return { value: 60 };
      if (key === "policies.idle_gate_qitem.active_wake_interval_seconds") return { value: 900 };
      throw new Error(`unexpected settings key ${key}`);
    },
  });

  async function build(autoRegister: string, optIn = "") {
    const { WatchdogAutoRegistration } = await import("../src/domain/watchdog-auto-registration.js");
    const db = createFullTestDb();
    const { rig, node, sessionName } = seedCanonicalNode(db, "gate-rig");
    new SessionRegistry(db).registerSession(node.id, sessionName);
    const jobsRepo = new WatchdogJobsRepository(db);
    const unit = new WatchdogAutoRegistration({
      db,
      jobsRepo,
      settingsStore: settings(autoRegister, optIn) as never,
      warn: () => {},
    });
    return { db, rig, node, sessionName, jobsRepo, unit };
  }

  it("default off: a fresh canonical seat gets NO job, and coverage reads that as the ruled state (null, no throw)", async () => {
    const { db, node, sessionName, unit } = await build("off");
    try {
      expect(unit.ensure(node.id, sessionName)).toBeNull();
      expect(autoRows(db, sessionName)).toHaveLength(0);
      expect(unit.assertCoverage(node.id, sessionName)).toBeNull();
    } finally { db.close(); }
  });

  it("a seat named in opt_in_sessions gets exactly its job while the mode is off", async () => {
    const { db, node, sessionName, unit } = await build("off", ` other@rig , ${"dev-qa@gate-rig"} `);
    try {
      const job = unit.ensure(node.id, sessionName);
      expect(job).not.toBeNull();
      expect(autoRows(db, sessionName)).toHaveLength(1);
      expect(unit.assertCoverage(node.id, sessionName)).not.toBeNull();
    } finally { db.close(); }
  });

  it('store-to-enforcer: a validator-accepted whitespace-padded " all " opts the fleet in (the gate compares the same normalization the validator accepted)', async () => {
    const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
    const home = mkdtempSync(join(tmpdir(), "b6-trim-"));
    const prevEnv = process.env.OPENRIG_POLICIES_IDLE_GATE_QITEM_AUTO_REGISTER;
    process.env.OPENRIG_POLICIES_IDLE_GATE_QITEM_AUTO_REGISTER = " all ";
    try {
      const realStore = new SettingsStore(join(home, "config.yaml"));
      // The REAL store hands the padded value through as valid env config…
      expect(String(realStore.resolveOne("policies.idle_gate_qitem.auto_register").value)).toBe(" all ");
      // …and the enforcement gate must read it as the mode the validator accepted.
      const { WatchdogAutoRegistration } = await import("../src/domain/watchdog-auto-registration.js");
      const db = createFullTestDb();
      const { node, sessionName } = seedCanonicalNode(db, "trim-rig");
      new SessionRegistry(db).registerSession(node.id, sessionName);
      const unit = new WatchdogAutoRegistration({
        db,
        jobsRepo: new WatchdogJobsRepository(db),
        settingsStore: realStore as never,
        warn: () => {},
      });
      expect(unit.ensure(node.id, sessionName)).not.toBeNull();
      expect(autoRows(db, sessionName)).toHaveLength(1);
      db.close();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENRIG_POLICIES_IDLE_GATE_QITEM_AUTO_REGISTER;
      else process.env.OPENRIG_POLICIES_IDLE_GATE_QITEM_AUTO_REGISTER = prevEnv;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('auto_register "all" restores fleet-wide registration', async () => {
    const { db, node, sessionName, unit } = await build("all");
    try {
      expect(unit.ensure(node.id, sessionName)).not.toBeNull();
      expect(autoRows(db, sessionName)).toHaveLength(1);
    } finally { db.close(); }
  });

  it("an EXISTING job survives the default flip and keeps being maintained (ensure still returns it, coverage still audits)", async () => {
    const { db, node, sessionName, jobsRepo, unit } = await build("all");
    try {
      expect(unit.ensure(node.id, sessionName)).not.toBeNull();
      // The fleet later flips to the ruled default; the surviving job must not be dropped or ignored.
      const flipped = new (unit.constructor as new (deps: unknown) => typeof unit)({
        db, jobsRepo, settingsStore: settings("off") as never, warn: () => {},
      });
      expect(flipped.ensure(node.id, sessionName)).not.toBeNull();
      expect(autoRows(db, sessionName)).toHaveLength(1);
      expect(flipped.assertCoverage(node.id, sessionName)).not.toBeNull();
    } finally { db.close(); }
  });
});

// #3634: a parked-owner-consumer job is armed for a rig name while it has an unarchived row or a running seat.
// Archive and delete retire it in the same act once the name has neither; unarchive and re-creation under the same
// name put the same job back (id and history kept); an operator-stopped job stays stopped; jobs earlier daemons left
// active are not cleaned up here.
describe("#3634 parked-owner-consumer jobs follow archive, unarchive, delete and re-creation", () => {
  const originalNoKernel = process.env.OPENRIG_NO_KERNEL;
  const roots: string[] = [];
  beforeAll(() => { process.env.OPENRIG_NO_KERNEL = "1"; });
  afterAll(() => {
    if (originalNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
    else process.env.OPENRIG_NO_KERNEL = originalNoKernel;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const boot = (dbPath = ":memory:") => createDaemon({ dbPath, tmuxExec: async () => "", cmuxExec: async () => "" });
  const fileDb = (prefix: string) => {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return join(root, "openrig.sqlite");
  };
  const parked = (db: Database.Database, rigName: string) =>
    new WatchdogJobsRepository(db).listExactTuple(PARKED_OWNER_POLICY_NAME, makeRigAnchor(rigName), null);
  const states = (db: Database.Database, rigName: string) => parked(db, rigName).map((job) => job.state);
  const ids = (db: Database.Database, rigName: string) => parked(db, rigName).map((job) => job.jobId);
  const parkedJob = (rigName: string) => ({
    policy: PARKED_OWNER_POLICY_NAME,
    targetSession: makeRigAnchor(rigName),
    registeredBySession: "daemon@kernel",
    intervalSeconds: 120,
    specYaml: `policy: ${PARKED_OWNER_POLICY_NAME}\ntarget:\n  session: ${makeRigAnchor(rigName)}\ncontext:\n  rig: ${rigName}\n`,
  });

  it("a daemon start arms names with an unarchived row, never re-arms a retired name, and puts a re-created name's job back", async () => {
    const dbPath = fileDb("parked-start-");
    const seed = createDb(dbPath);
    migrate(seed, ALL_MIGRATIONS);
    const rigs = new RigRepository(seed);
    const jobs = new WatchdogJobsRepository(seed);
    rigs.createRig("live");
    rigs.archiveRig(rigs.createRig("never-armed").id);
    rigs.archiveRig(rigs.createRig("retired").id);
    rigs.archiveRig(rigs.createRig("reborn").id);
    rigs.createRig("reborn");
    rigs.archiveRig(rigs.createRig("leftover").id);
    const seated = rigs.createRig("seated");
    const seatedNode = rigs.addNode(seated.id, "dev-qa", { role: "qa", runtime: "codex" });
    const seatedSession = new SessionRegistry(seed).registerSession(seatedNode.id, "dev-qa@seated");
    new SessionRegistry(seed).updateStatus(seatedSession.id, "running");
    rigs.archiveRig(seated.id);
    for (const name of ["retired", "reborn", "seated"]) {
      const job = jobs.register(parkedJob(name));
      jobs.markTerminal(job.jobId, "rig archived");
    }
    jobs.register(parkedJob("leftover"));
    const rebornId = ids(seed, "reborn");
    const seatedId = ids(seed, "seated");
    seed.close();

    const { db, eventLoopMonitor } = await boot(dbPath);
    try {
      expect(states(db, "live")).toEqual(["active"]);
      expect(states(db, "never-armed")).toEqual([]);
      expect(states(db, "retired")).toEqual(["terminal"]);
      expect(states(db, "reborn")).toEqual(["active"]);
      expect(ids(db, "reborn")).toEqual(rebornId);
      // An archived rig with a running seat is still watched: its retired job comes back at start.
      expect(states(db, "seated")).toEqual(["active"]);
      expect(ids(db, "seated")).toEqual(seatedId);
      // No one-time cleanup: a job an earlier daemon left active stays as it was.
      expect(states(db, "leftover")).toEqual(["active"]);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("archive through the route retires the job in the same act, and unarchive puts the same job back", async () => {
    const { app, db, deps, eventLoopMonitor } = await boot();
    try {
      const rig = deps.rigRepo.createRig("solo");
      const armed = ids(db, "solo");
      expect((await app.request(`/api/rigs/${rig.id}/archive`, { method: "POST" })).status).toBe(200);
      expect(states(db, "solo")).toEqual(["terminal"]);
      expect(parked(db, "solo")[0]!.terminalReason).toBe("rig archived");
      expect((await app.request(`/api/rigs/${rig.id}/unarchive`, { method: "POST" })).status).toBe(200);
      expect(states(db, "solo")).toEqual(["active"]);
      expect(ids(db, "solo")).toEqual(armed);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("delete, direct and through the route, retires the job once the last unarchived row of the name is gone", async () => {
    const { app, db, deps, eventLoopMonitor } = await boot();
    try {
      const older = deps.rigRepo.createRig("twice");
      const newer = deps.rigRepo.createRig("twice");
      deps.rigRepo.deleteRig(older.id);
      expect(states(db, "twice")).toEqual(["active"]);
      deps.rigRepo.deleteRig(newer.id);
      expect(states(db, "twice")).toEqual(["terminal"]);
      expect(parked(db, "twice")[0]!.terminalReason).toBe("rig deleted");
      const deletedId = ids(db, "twice");
      deps.rigRepo.createRig("twice");
      expect(states(db, "twice")).toEqual(["active"]);
      expect(ids(db, "twice")).toEqual(deletedId);
      const routed = deps.rigRepo.createRig("routed");
      expect((await app.request(`/api/rigs/${routed.id}`, { method: "DELETE" })).status).toBe(204);
      expect(states(db, "routed")).toEqual(["terminal"]);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("a same-name replacement (archive the old generation, create the new, one transaction) keeps the same job", async () => {
    const { db, deps, eventLoopMonitor } = await boot();
    try {
      const old = deps.rigRepo.createRig("replaced");
      const armed = ids(db, "replaced");
      db.transaction(() => {
        deps.rigRepo.archiveRig(old.id);
        deps.rigRepo.createRig("replaced");
      })();
      expect(states(db, "replaced")).toEqual(["active"]);
      expect(ids(db, "replaced")).toEqual(armed);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("a rolled-back replacement leaves the job as it was: the transaction aborted, and the failed import undone", async () => {
    const { db, deps, eventLoopMonitor } = await boot();
    try {
      const old = deps.rigRepo.createRig("rolled");
      const armed = ids(db, "rolled");
      expect(() => db.transaction(() => {
        deps.rigRepo.archiveRig(old.id);
        throw new Error("generation changed");
      })()).toThrow("generation changed");
      expect(states(db, "rolled")).toEqual(["active"]);
      expect(ids(db, "rolled")).toEqual(armed);
      // The instantiator's undo after a failed replacement: delete the new generation, unarchive the old one.
      let created = "";
      db.transaction(() => {
        deps.rigRepo.archiveRig(old.id);
        created = deps.rigRepo.createRig("rolled").id;
      })();
      deps.rigRepo.deleteRig(created);
      deps.rigRepo.unarchiveRig(old.id);
      expect(states(db, "rolled")).toEqual(["active"]);
      expect(ids(db, "rolled")).toEqual(armed);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("an operator-stopped job stays stopped through archive, unarchive and a daemon start", async () => {
    const dbPath = fileDb("parked-stopped-");
    const seed = createDb(dbPath);
    migrate(seed, ALL_MIGRATIONS);
    const rigs = new RigRepository(seed);
    const jobs = new WatchdogJobsRepository(seed);
    rigs.createRig("held-live");
    rigs.archiveRig(rigs.createRig("held-gone").id);
    for (const name of ["held-live", "held-gone"]) jobs.stop(jobs.register(parkedJob(name)).jobId);
    seed.close();

    const { db, deps, eventLoopMonitor } = await boot(dbPath);
    try {
      expect(states(db, "held-live")).toEqual(["stopped"]);
      expect(states(db, "held-gone")).toEqual(["stopped"]);
      const live = deps.rigRepo.findUnarchivedRigsByName("held-live")[0]!;
      deps.rigRepo.archiveRig(live.id);
      expect(states(db, "held-live")).toEqual(["stopped"]);
      deps.rigRepo.unarchiveRig(live.id);
      expect(states(db, "held-live")).toEqual(["stopped"]);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("unarchiving one generation while another keeps the name armed leaves the same single job", async () => {
    const { db, deps, eventLoopMonitor } = await boot();
    try {
      const older = deps.rigRepo.createRig("pair");
      deps.rigRepo.createRig("pair");
      deps.rigRepo.archiveRig(older.id);
      const before = parked(db, "pair");
      deps.rigRepo.unarchiveRig(older.id);
      expect(parked(db, "pair")).toEqual(before);
      expect(states(db, "pair")).toEqual(["active"]);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("archive --force of a rig with a running seat keeps its job armed, also across a daemon start", async () => {
    const dbPath = fileDb("parked-forced-");
    const first = await boot(dbPath);
    try {
      const rig = first.deps.rigRepo.createRig("forced");
      const node = first.deps.rigRepo.addNode(rig.id, "dev-qa", { role: "qa", runtime: "codex" });
      const session = first.deps.sessionRegistry.registerSession(node.id, "dev-qa@forced");
      first.deps.sessionRegistry.updateStatus(session.id, "running");
      const res = await first.app.request(`/api/rigs/${rig.id}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      expect(res.status).toBe(200);
      expect(first.deps.rigRepo.findUnarchivedRigsByName("forced")).toEqual([]);
      expect(states(first.db, "forced")).toEqual(["active"]);
    } finally {
      first.eventLoopMonitor.stop();
      first.db.close();
    }
    const second = await boot(dbPath);
    try {
      expect(states(second.db, "forced")).toEqual(["active"]);
    } finally {
      second.eventLoopMonitor.stop();
      second.db.close();
    }
  }, 30_000);

  it("a watchdog row in an unknown state warns and never blocks the unarchive", async () => {
    const { app, db, deps, eventLoopMonitor } = await boot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rig = deps.rigRepo.createRig("damaged");
      deps.rigRepo.archiveRig(rig.id);
      db.prepare("UPDATE watchdog_jobs SET state = 'bogus' WHERE policy = ? AND target_session = ?")
        .run(PARKED_OWNER_POLICY_NAME, makeRigAnchor("damaged"));
      expect((await app.request(`/api/rigs/${rig.id}/unarchive`, { method: "POST" })).status).toBe(200);
      expect(deps.rigRepo.findUnarchivedRigsByName("damaged").map((row) => row.id)).toEqual([rig.id]);
      expect(warn.mock.calls.some(([message]) => String(message).includes("auto_registration_state_invalid"))).toBe(true);
    } finally {
      warn.mockRestore();
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("a seat of an archived rig that runs again (restore or launch, no unarchive) brings the same job back", async () => {
    const { db, deps, eventLoopMonitor } = await boot();
    try {
      const rig = deps.rigRepo.createRig("returning");
      const node = deps.rigRepo.addNode(rig.id, "dev-qa", { role: "qa", runtime: "codex" });
      const armed = ids(db, "returning");
      deps.rigRepo.archiveRig(rig.id);
      expect(states(db, "returning")).toEqual(["terminal"]);
      const session = deps.sessionRegistry.registerSession(node.id, "dev-qa@returning");
      deps.sessionRegistry.updateStatus(session.id, "running");
      expect(states(db, "returning")).toEqual(["active"]);
      expect(ids(db, "returning")).toEqual(armed);
      expect(deps.rigRepo.findUnarchivedRigsByName("returning")).toEqual([]);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("a seat of an archived name with no job gets exactly one active job when it runs, with no restart or unarchive", async () => {
    const dbPath = fileDb("parked-seat-unarmed-");
    const seed = createDb(dbPath);
    migrate(seed, ALL_MIGRATIONS);
    const rigs = new RigRepository(seed);
    const jobs = new WatchdogJobsRepository(seed);
    const unarmed = rigs.createRig("never-armed");
    const unarmedNode = rigs.addNode(unarmed.id, "dev-qa", { role: "qa", runtime: "codex" });
    rigs.archiveRig(unarmed.id);
    const held = rigs.createRig("held");
    const heldNode = rigs.addNode(held.id, "dev-qa", { role: "qa", runtime: "codex" });
    rigs.archiveRig(held.id);
    jobs.stop(jobs.register(parkedJob("held")).jobId);
    const heldId = ids(seed, "held");
    seed.close();

    const { db, deps, eventLoopMonitor } = await boot(dbPath);
    try {
      // The start skips both: archived, with no running seat.
      expect(states(db, "never-armed")).toEqual([]);
      expect(states(db, "held")).toEqual(["stopped"]);
      for (const [nodeId, name] of [[unarmedNode.id, "dev-qa@never-armed"], [heldNode.id, "dev-qa@held"]] as const) {
        deps.sessionRegistry.updateStatus(deps.sessionRegistry.registerSession(nodeId, name).id, "running");
      }
      expect(states(db, "never-armed")).toEqual(["active"]);
      expect(deps.rigRepo.findUnarchivedRigsByName("never-armed")).toEqual([]);
      // Control: the same transition leaves an operator-stopped job stopped.
      expect(states(db, "held")).toEqual(["stopped"]);
      expect(ids(db, "held")).toEqual(heldId);
    } finally {
      eventLoopMonitor.stop();
      db.close();
    }
  }, 30_000);

  it("a failed put-back warns and never stops a daemon start, an unarchive or a running seat", async () => {
    const dbPath = fileDb("parked-revive-fails-");
    const seed = createDb(dbPath);
    migrate(seed, ALL_MIGRATIONS);
    const rigs = new RigRepository(seed);
    rigs.createRig("steady");
    const back = rigs.createRig("back");
    rigs.archiveRig(back.id);
    const seat = rigs.createRig("seat");
    const seatNode = rigs.addNode(seat.id, "dev-qa", { role: "qa", runtime: "codex" });
    rigs.archiveRig(seat.id);
    seed.close();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const revive = vi.spyOn(WatchdogJobsRepository.prototype, "reviveRetired").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    try {
      const { app, db, deps, eventLoopMonitor } = await boot(dbPath);
      try {
        expect(states(db, "steady")).toEqual(["active"]);
        expect((await app.request(`/api/rigs/${back.id}/unarchive`, { method: "POST" })).status).toBe(200);
        expect(deps.rigRepo.findUnarchivedRigsByName("back").map((row) => row.id)).toEqual([back.id]);
        expect(states(db, "back")).toContain("active");
        const session = deps.sessionRegistry.registerSession(seatNode.id, "dev-qa@seat");
        expect(() => deps.sessionRegistry.updateStatus(session.id, "running")).not.toThrow();
        expect(states(db, "seat")).toContain("active");
        expect(revive).toHaveBeenCalled();
        expect(warn.mock.calls.some(([message]) => String(message).includes("could not put back"))).toBe(true);
      } finally {
        eventLoopMonitor.stop();
        db.close();
      }
    } finally {
      revive.mockRestore();
      warn.mockRestore();
    }
  }, 30_000);
});
