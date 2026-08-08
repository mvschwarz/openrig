import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { occupantGenerationStampsSchema } from "../src/db/migrations/063_occupant_generation_stamps.js";
import { watchdogTargetGenerationSchema } from "../src/db/migrations/066_watchdog_target_generation.js";
import {
  PHASE_C_POLICIES,
  WatchdogJobsError,
  WatchdogJobsRepository,
} from "../src/domain/watchdog-jobs-repository.js";
import { createFullTestDb } from "./helpers/test-app.js";

describe("WatchdogJobsRepository (PL-004 Phase C)", () => {
  let db: Database.Database;
  let repo: WatchdogJobsRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]);
    repo = new WatchdogJobsRepository(db);
  });

  afterEach(() => db.close());

  function validInput(overrides: Record<string, unknown> = {}) {
    return {
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget: a@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: a@rig\n  message: hello\n",
      targetSession: "a@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
      ...overrides,
    };
  }

  it("register stores all three v1 policies + actionable defaults to false", () => {
    for (const p of PHASE_C_POLICIES) {
      const job = repo.register(validInput({ policy: p }));
      expect(job.policy).toBe(p);
      expect(job.state).toBe("active");
      expect(job.actionable).toBe(false);
      expect(job.lastActionableAt).toBeNull();
      expect(job.jobId).toMatch(/^[0-9A-Z]{26}$/);
    }
  });

  // PL-004 Phase D: registration-rejection for workflow-keepalive REPLACED
  // with positive registration-accept. workflow-keepalive is now an
  // accepted policy enum value (orch-ratified Phase D extension).
  it("register accepts workflow-keepalive (Phase D enum extension)", () => {
    const job = repo.register(validInput({ policy: "workflow-keepalive" }));
    expect(job.policy).toBe("workflow-keepalive");
    expect(job.state).toBe("active");
  });

  it("register rejects unknown policy with policy_unknown", () => {
    try {
      repo.register(validInput({ policy: "totally-bogus" }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WatchdogJobsError);
      expect((err as WatchdogJobsError).code).toBe("policy_unknown");
    }
  });

  it("register rejects non-positive interval_seconds with interval_invalid", () => {
    for (const bad of [0, -1, 1.5]) {
      try {
        repo.register(validInput({ intervalSeconds: bad }));
        throw new Error(`should have thrown for ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WatchdogJobsError);
        expect((err as WatchdogJobsError).code).toBe("interval_invalid");
      }
    }
  });

  it("register rejects target_session without @ as target_session_invalid", () => {
    try {
      repo.register(validInput({ targetSession: "no-at-here" }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WatchdogJobsError);
      expect((err as WatchdogJobsError).code).toBe("target_session_invalid");
    }
  });

  it("listActive returns only state=active jobs in registration order", () => {
    const a = repo.register(validInput({ targetSession: "a@rig" }));
    const b = repo.register(validInput({ targetSession: "b@rig" }));
    const c = repo.register(validInput({ targetSession: "c@rig" }));
    repo.stop(b.jobId);
    const active = repo.listActive();
    expect(active.map((j) => j.jobId)).toEqual([a.jobId, c.jobId]);
  });

  it("recordEvaluation(fired=true) updates last_evaluation_at + last_fire_at", () => {
    const job = repo.register(validInput());
    repo.recordEvaluation(job.jobId, "2026-05-03T07:00:00.000Z", true);
    const after = repo.getByIdOrThrow(job.jobId);
    expect(after.lastEvaluationAt).toBe("2026-05-03T07:00:00.000Z");
    expect(after.lastFireAt).toBe("2026-05-03T07:00:00.000Z");
  });

  it("recordEvaluation(fired=false) updates only last_evaluation_at", () => {
    const job = repo.register(validInput());
    repo.recordEvaluation(job.jobId, "2026-05-03T07:00:00.000Z", false);
    const after = repo.getByIdOrThrow(job.jobId);
    expect(after.lastEvaluationAt).toBe("2026-05-03T07:00:00.000Z");
    expect(after.lastFireAt).toBeNull();
  });

  it("markTerminal sets state=terminal + terminal_reason", () => {
    const job = repo.register(validInput());
    repo.markTerminal(job.jobId, "policy_returned_terminal");
    const after = repo.getByIdOrThrow(job.jobId);
    expect(after.state).toBe("terminal");
    expect(after.terminalReason).toBe("policy_returned_terminal");
  });

  it("stop sets state=stopped + records reason", () => {
    const job = repo.register(validInput());
    const stopped = repo.stop(job.jobId, "operator stop reason");
    expect(stopped.state).toBe("stopped");
    expect(stopped.terminalReason).toBe("operator stop reason");
  });

  it("stop on already-terminal job throws job_terminal", () => {
    const job = repo.register(validInput());
    repo.markTerminal(job.jobId, "done");
    try {
      repo.stop(job.jobId);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WatchdogJobsError);
      expect((err as WatchdogJobsError).code).toBe("job_terminal");
    }
  });

  it("setActionable(true) sets actionable=1 + last_actionable_at to evaluatedAt by default", () => {
    const job = repo.register(validInput());
    repo.setActionable(job.jobId, true, "2026-05-03T07:00:00.000Z");
    const after = repo.getByIdOrThrow(job.jobId);
    expect(after.actionable).toBe(true);
    expect(after.lastActionableAt).toBe("2026-05-03T07:00:00.000Z");
  });

  it("setActionable(true) preserves last_actionable_at when preserve arg passed (continued window)", () => {
    const job = repo.register(validInput());
    repo.setActionable(job.jobId, true, "2026-05-03T07:00:00.000Z");
    repo.setActionable(job.jobId, true, "2026-05-03T07:01:00.000Z", "2026-05-03T07:00:00.000Z");
    const after = repo.getByIdOrThrow(job.jobId);
    expect(after.lastActionableAt).toBe("2026-05-03T07:00:00.000Z");
  });

  it("setActionable(false) clears actionable + last_actionable_at", () => {
    const job = repo.register(validInput());
    repo.setActionable(job.jobId, true, "2026-05-03T07:00:00.000Z");
    repo.setActionable(job.jobId, false, "2026-05-03T07:01:00.000Z");
    const after = repo.getByIdOrThrow(job.jobId);
    expect(after.actionable).toBe(false);
    expect(after.lastActionableAt).toBeNull();
  });

  it("getByIdOrThrow throws job_not_found for unknown id", () => {
    try {
      repo.getByIdOrThrow("does-not-exist");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WatchdogJobsError);
      expect((err as WatchdogJobsError).code).toBe("job_not_found");
    }
  });
});

// ── GHOST-STAGE (e/Class-B): occupant-generation stamp + gen-scoped swap drop ──
describe("WatchdogJobsRepository — generation stamps (Class-B)", () => {
  let db: Database.Database;
  let repo: WatchdogJobsRepository;
  let genBySession: Map<string, string | null>;

  beforeEach(() => {
    db = createDb();
    // 063 ALTERs BOTH queue_items + watchdog_jobs (one migration), so both tables must exist first.
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, watchdogJobsSchema, watchdogHistorySchema, occupantGenerationStampsSchema]);
    genBySession = new Map();
    repo = new WatchdogJobsRepository(db, undefined, (s) => genBySession.get(s) ?? null);
  });
  afterEach(() => db.close());

  const input = (overrides: Record<string, unknown> = {}) => ({
    policy: "periodic-reminder",
    specYaml: "policy: periodic-reminder\ntarget: a@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: a@rig\n  message: hi\n",
    targetSession: "a@rig",
    intervalSeconds: 60,
    registeredBySession: "seat@rig",
    ...overrides,
  });

  it("stamps the ARMING occupant's generation at register", () => {
    genBySession.set("seat@rig", "gen-1");
    expect(repo.register(input()).registeredByGeneration).toBe("gen-1");
  });

  it("an unresolved arming generation stays NULL (UNKNOWN — never a false stamp)", () => {
    expect(repo.register(input({ registeredBySession: "unknown@rig" })).registeredByGeneration).toBeNull();
  });

  it("drops ONLY armed jobs of the retiring generation — the successor's own job (same name, live gen) survives", () => {
    genBySession.set("seat@rig", "gen-retired");
    const retired = repo.register(input());
    genBySession.set("seat@rig", "gen-live"); // successor resumes into the SAME seat name, new gen
    const live = repo.register(input());

    const stopped = repo.dropArmedByRegisteringGeneration("gen-retired");
    expect(stopped).toBe(1);
    expect(repo.getById(retired.jobId)!.state).toBe("stopped");
    expect(repo.getById(retired.jobId)!.terminalReason).toContain("retired");
    expect(repo.getById(live.jobId)!.state).toBe("active"); // NOT name-scoped — successor untouched
  });

  it("an empty generation is a no-op (never a catch-all drop)", () => {
    genBySession.set("seat@rig", "gen-1");
    repo.register(input());
    expect(repo.dropArmedByRegisteringGeneration("")).toBe(0);
  });

  it("NULL-generation jobs are never matched (UNKNOWN != retired)", () => {
    const job = repo.register(input({ registeredBySession: "unknown@rig" }));
    expect(repo.dropArmedByRegisteringGeneration("gen-anything")).toBe(0);
    expect(repo.getById(job.jobId)!.state).toBe("active");
  });

  it("pre-063 db (no gen column) degrades: register succeeds, gen NULL, drop no-ops (blast-radius containment)", () => {
    const bareDb = createDb();
    migrate(bareDb, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]); // NO 063
    const bareRepo = new WatchdogJobsRepository(bareDb, undefined, () => "gen-x");
    const job = bareRepo.register(input());
    expect(job.registeredByGeneration).toBeNull();
    expect(bareRepo.dropArmedByRegisteringGeneration("gen-x")).toBe(0);
    bareDb.close();
  });
});

// ── GHOST-STAGE (i-c): opt-in TARGET-generation stamp (fire-time gen-gate input) ──
describe("WatchdogJobsRepository — target-generation stamp (i-c, opt-in)", () => {
  let db: Database.Database;
  let repo: WatchdogJobsRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, watchdogJobsSchema, watchdogHistorySchema, occupantGenerationStampsSchema, watchdogTargetGenerationSchema]);
    repo = new WatchdogJobsRepository(db);
  });
  afterEach(() => db.close());

  const input = (overrides: Record<string, unknown> = {}) => ({
    policy: "periodic-reminder",
    specYaml: "policy: periodic-reminder\ntarget: a@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: a@rig\n  message: hi\n",
    targetSession: "a@rig",
    intervalSeconds: 60,
    registeredBySession: "seat@rig",
    ...overrides,
  });

  // THE CRUX PIN (ratified): a job with no target generation is ROLE-bound — NULL, fires unchanged.
  it("defaults to NULL (role-bound) when no target generation is supplied", () => {
    expect(repo.register(input()).targetGeneration).toBeNull();
  });

  it("stamps + round-trips an opt-in target generation (generation-bound wake)", () => {
    const job = repo.register(input({ targetGenerationUuid: "gen-target-7" }));
    expect(job.targetGeneration).toBe("gen-target-7");
    expect(repo.getById(job.jobId)!.targetGeneration).toBe("gen-target-7");
  });

  it("role-bound stays role-bound alongside a generation-bound sibling (independent columns)", () => {
    const roleBound = repo.register(input());
    const genBound = repo.register(input({ targetGenerationUuid: "gen-9" }));
    expect(repo.getById(roleBound.jobId)!.targetGeneration).toBeNull();
    expect(repo.getById(genBound.jobId)!.targetGeneration).toBe("gen-9");
  });

  it("pre-066 db (no target-gen column) degrades: register succeeds, targetGeneration NULL", () => {
    const bareDb = createDb();
    migrate(bareDb, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]); // NO 066
    const bareRepo = new WatchdogJobsRepository(bareDb);
    const job = bareRepo.register(input({ targetGenerationUuid: "gen-x" }));
    expect(job.targetGeneration).toBeNull(); // column absent → opt-in silently degrades to role-bound
    bareDb.close();
  });
});

// OPR.0.5.1 51-06 W2c — auto-registration is an exact-tuple ensure, not a blind
// register. These are deliberately repository-altitude: a newer terminal row
// must not hide an older runnable duplicate, and stopped is a durable operator
// opt-out rather than a row to resurrect.
describe("WatchdogJobsRepository — W2c exact-tuple auto-registration", () => {
  let db: Database.Database;
  let repo: WatchdogJobsRepository;

  beforeEach(() => {
    db = createFullTestDb();
    repo = new WatchdogJobsRepository(db);
  });
  afterEach(() => db.close());

  const input = (targetSession: string) => ({
    policy: "idle-gate-qitem",
    specYaml:
      `policy: idle-gate-qitem\n` +
      `generated_by: openrig-daemon\n` +
      `target:\n  session: ${targetSession}\n` +
      `interval_seconds: 60\n` +
      `scan_interval_seconds: 60\n` +
      `active_wake_interval_seconds: 900\n`,
    targetSession,
    intervalSeconds: 60,
    scanIntervalSeconds: 60,
    activeWakeIntervalSeconds: 900,
    registeredBySession: "daemon@kernel",
    targetGenerationUuid: null,
  });

  function ensureFn() {
    const ensure = (repo as unknown as {
      ensureAutoRegistration?: (value: ReturnType<typeof input>) => ReturnType<WatchdogJobsRepository["register"]>;
    }).ensureAutoRegistration;
    expect(ensure, "repository must expose the state-aware W2c exact-tuple ensure").toBeTypeOf("function");
    return ensure!.bind(repo);
  }

  it("reuses the sole active row and preserves role-bound daemon identity across handover", () => {
    const first = repo.register(input("active@rig"));
    const ensured = ensureFn()(input("active@rig"));
    expect(ensured.jobId).toBe(first.jobId);
    expect(ensured).toMatchObject({
      state: "active",
      registeredBySession: "daemon@kernel",
      registeredByGeneration: null,
      targetGeneration: null,
    });
    expect(repo.dropArmedByRegisteringGeneration("retiring-generation")).toBe(0);
    expect(repo.getById(first.jobId)?.state).toBe("active");
  });

  it("preserves the sole stopped row as an operator opt-out", () => {
    const stopped = repo.register(input("stopped@rig"));
    repo.stop(stopped.jobId, "operator_stopped");
    const ensured = ensureFn()(input("stopped@rig"));
    expect(ensured.jobId).toBe(stopped.jobId);
    expect(ensured.state).toBe("stopped");
    expect(repo.listAll().filter((job) => job.targetSession === "stopped@rig")).toHaveLength(1);
  });

  it("terminal-only history creates one replacement and subsequent ensure reuses it", () => {
    const terminal = repo.register(input("terminal@rig"));
    repo.markTerminal(terminal.jobId, "completed");
    const ensure = ensureFn();
    const replacement = ensure(input("terminal@rig"));
    expect(replacement.jobId).not.toBe(terminal.jobId);
    expect(replacement.state).toBe("active");
    expect(ensure(input("terminal@rig")).jobId).toBe(replacement.jobId);
    expect(repo.listAll().filter((job) => job.targetSession === "terminal@rig")).toHaveLength(2);
  });

  it("inspects full history: older active plus newer terminal reuses the active row", () => {
    const active = repo.register(input("history@rig"));
    const terminal = repo.register(input("history@rig"));
    repo.markTerminal(terminal.jobId, "newer terminal history");
    const ensured = ensureFn()(input("history@rig"));
    expect(ensured.jobId).toBe(active.jobId);
    expect(repo.listAll().filter((job) => job.targetSession === "history@rig")).toHaveLength(2);
  });

  it("fails loudly on every ambiguous nonterminal cardinality with all job ids and states", () => {
    const scenarios = [
      { target: "two-active@rig", states: ["active", "active"] as const },
      { target: "two-stopped@rig", states: ["stopped", "stopped"] as const },
      { target: "active-stopped@rig", states: ["active", "stopped"] as const },
    ];
    const ensure = ensureFn();

    for (const scenario of scenarios) {
      const rows = scenario.states.map((state) => {
        const row = repo.register(input(scenario.target));
        if (state === "stopped") repo.stop(row.jobId, "operator_stopped");
        return repo.getByIdOrThrow(row.jobId);
      });
      try {
        ensure(input(scenario.target));
        throw new Error("expected ambiguous auto-registration to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(WatchdogJobsError);
        expect((error as WatchdogJobsError).code).toBe("auto_registration_ambiguous");
        expect((error as WatchdogJobsError).details).toMatchObject({
          targetSession: scenario.target,
          rows: expect.arrayContaining(rows.map((row) => ({ jobId: row.jobId, state: row.state }))),
        });
      }
      expect(repo.listAll().filter((job) => job.targetSession === scenario.target)).toHaveLength(2);
    }
  });
});
