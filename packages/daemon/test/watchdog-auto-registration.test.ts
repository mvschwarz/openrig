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
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
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
      const activity = new AgentActivityStore({ db, eventBus: deps.eventBus, now: () => now });
      expect(activity.recordHookEvent({
        runtime: "codex",
        sessionName,
        hookEvent: "Stop",
        occurredAt: fresh,
      }).ok).toBe(true);

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
        additionalPolicies: [makeIdleGateQitemPolicy({ db, agentActivityStore: activity })],
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
