// The real managed-compaction state, parked-owner policy, queue and watchdog engine;
// recording transport only. No tmux server or native Claude Code is exercised.
import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, isBlockerLive } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import type { SessionTransport } from "../src/domain/session-transport.js";
import {
  makeParkedOwnerConsumerPolicy, makeRigAnchor, RESERVE_PREFIX,
  type ParkedSeatDiagnosisView,
} from "../src/domain/policies/parked-owner-consumer.js";

const seat = "worker@demo";
const high = { sessionName: seat, runtime: "claude-code", usedPercentage: 90 };
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "parked-compaction-"));
  const db = new Database(":memory:");
  disposers.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  const rows = new QueueRepository(db, bus, { validateRig: () => true } as never);
  const addSeat = async (sessionName: string) => {
    const row = await rows.create({ sourceSession: "sender@demo", destinationSession: sessionName, body: "Resume my work" });
    rows.claim({ qitemId: row.qitemId, destinationSession: sessionName });
    return { sessionName, parked: true,
      activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null } },
      obligations: { items: [{ qitemId: row.qitemId, state: "in-progress", summary: null }], held: [] },
    } satisfies ParkedSeatDiagnosisView;
  };
  const seats: ParkedSeatDiagnosisView[] = [await addSeat(seat)];
  const qitem = seats[0]!.obligations.items[0]!.qitemId;
  let clock = Date.now();
  const writes: string[] = [];
  const transport = {
    send: async (_session: string, text: string, opts?: { beforeWrite?: () => void }) => {
      opts?.beforeWrite?.(); writes.push(text); return { ok: true };
    },
    waitUntilIdle: async () => ({ ok: true }),
  } as unknown as SessionTransport;
  const e = new ClaudeCompactionEnforcer({ resolveClaudeCompactionPolicy: () => ({
    enabled: true, thresholdPercent: 80, preCompactInstruction: "Write a restore map.",
    compactInstruction: "", messageInline: "", messageFilePath: "", postRestoreAuditInstruction: "",
  }) } as never, transport, { openrigHome: home, resolveOccupantGeneration: () => "gen-1", now: () => clock });
  const jobs = new WatchdogJobsRepository(db);
  const history = new WatchdogHistoryLog(db);
  const job = jobs.register({ policy: "parked-owner-consumer", targetSession: makeRigAnchor("demo"),
    specYaml: "policy: parked-owner-consumer\ntarget:\n  session: parked-owner-consumer@demo\ninterval_seconds: 120\n",
    intervalSeconds: 120, registeredBySession: "daemon@kernel" });
  const deps = {
    diagnoseRig: () => ({ seats }), history,
    rows: {
      listTransitions: (id: string) => rows.listTransitions(id),
      appendNote: (id: string, note: string) => {
        const row = rows.getById(id);
        if (!row || !isBlockerLive(row.state)) return { ok: false };
        rows.update({ qitemId: id, actorSession: "watchdog@system", transitionNote: note });
        return { ok: true };
      },
      recordNudgeResult: (id: string, result: string) => rows.recordNudgeAttempt(id, result),
      listOpenIds: (session: string) => rows.listOpenObligations(session, 500).map(r => r.qitemId),
    },
    occupantGeneration: () => "gen-1",
    hasPendingPostCompactStage: (session: string) => e.hasPendingPostCompactStage(session),
  };
  const deliveries: Array<{ targetSession: string; message: string }> = [];
  const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: bus,
    now: () => new Date(clock), additionalPolicies: [makeParkedOwnerConsumerPolicy(deps)],
    deliver: async (request) => { deliveries.push(request); return { status: "ok" }; },
  });
  const tick = () => { clock += 120_000; return engine.evaluate(jobs.getByIdOrThrow(job.jobId)); };
  const reserveNotes = () => rows.listTransitions(qitem).filter(t => t.transitionNote?.startsWith(RESERVE_PREFIX));
  const compact = async () => {
    expect(await e.triggerManualCompact(high, { operatorInitiated: true, skipMap: true })).toMatchObject({ triggered: true });
    expect(writes.some(text => text.startsWith("/compact"))).toBe(true);
  };
  const drain = () => e.drainPendingPostCompactStage(high);
  return { e, rows, jobs, job, deliveries, tick, reserveNotes, compact, drain, qitem,
    addOtherSeat: async () => { seats.push(await addSeat("z-reviewer@demo")); },
  };
}

it("defers the parked row from submission through boundary/restore/audit without reserving its wake, then waits for a change after recorded success", async () => {
  const f = await fixture();
  await f.compact();
  for (const stage of ["compacting", "compacted", "restoring"]) {
    expect(f.e.observedCompaction(seat)?.stage).toBe(stage);
    const r = await f.tick();
    expect(r.outcome.action).toBe("skip");
    expect(JSON.stringify(r.outcome.notes)).toContain("managed-compaction-pending");
    expect(f.deliveries).toEqual([]);
    expect(f.reserveNotes()).toEqual([]);
    expect(f.jobs.getByIdOrThrow(f.job.jobId).lastFireAt).toBeNull();
    expect(await f.drain()).toEqual({ triggered: true });
  }
  expect(f.e.hasPendingPostCompactStage(seat)).toBe(false);
  expect(f.rows.getById(f.qitem)?.state).toBe("in-progress");
  expect((await f.tick()).outcome.action).toBe("send");
  expect(f.deliveries).toHaveLength(1);
  expect(f.deliveries[0]).toMatchObject({ targetSession: seat });
  expect(f.deliveries[0]!.message).toContain(f.qitem);
  expect(f.reserveNotes()).toHaveLength(1);
  expect((await f.tick()).outcome.action).toBe("skip");
  expect(f.deliveries).toHaveLength(1);
});

for (const end of ["cancel", "invalidate"] as const) {
  it(`a deferred row is eligible after ${end}, without a consumed episode receipt`, async () => {
    const f = await fixture();
    await f.compact(); await f.drain(); // exact boundary-acknowledged / restore-owed state
    expect(f.e.observedCompaction(seat)?.stage).toBe("compacted");
    expect((await f.tick()).outcome.action).toBe("skip");
    expect(f.reserveNotes()).toEqual([]);
    if (end === "cancel") f.e.cancelPreparation(seat); else f.e.invalidateOccupant(seat);
    expect((await f.tick()).outcome.action).toBe("send");
    expect(f.deliveries).toHaveLength(1);
  });
}

for (const preparation of [false, true]) {
  it(`ordinary parked owners still wake before any compact submission (preparation=${preparation})`, async () => {
    const f = await fixture();
    if (preparation) {
      await f.e.maybeAutoCompact(high);
      expect(f.e.observedCompaction(seat)?.stage).toBe("preparing");
    }
    expect(f.e.hasPendingPostCompactStage(seat)).toBe(false);
    expect((await f.tick()).outcome.action).toBe("send");
    expect(f.deliveries).toHaveLength(1);
  });
}

it("passes the compacting owner to wake another parked owner on the same pass", async () => {
  const f = await fixture();
  await f.compact(); await f.drain(); await f.addOtherSeat();
  const r = await f.tick();
  expect(r.outcome.action).toBe("send");
  expect(f.deliveries[0]?.targetSession).toBe("z-reviewer@demo");
  expect(f.reserveNotes()).toEqual([]);
  expect(JSON.stringify(r.outcome.notes)).toContain("managed-compaction-pending");
});

it("startup reads pending stages from the same late-bound compaction enforcer used by routes and monitoring", () => {
  const source = readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
  expect(source).toMatch(/hasPendingPostCompactStage:\s*\(sessionName\)\s*=>\s*deps\.compactionEnforcer\?\.hasPendingPostCompactStage\(sessionName\)\s*\?\?\s*false/);
  expect(source).toContain("deps.compactionEnforcer = compactionEnforcer;");
});
