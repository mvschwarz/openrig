// #2829 slice 1 — SeatColdStarter eligibility, coalescing, and backoff against a
// real migrated SQLite database. The launch door and tmux probe are fakes; every
// gate the maintainer's terms added is exercised: dormancy vs intentional operator
// stop vs daemon reclaim vs deleted seat vs failed start, simultaneous-arrival
// coalescing (including across a daemon restart), and the running-rig-only rule.
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import {
  SeatColdStarter,
  COLD_START_MIN_INTERVAL_MS,
  classifyColdStartLaunch,
  classifyColdStartStop,
  type SeatColdStartDeps,
} from "../src/domain/seat-cold-start.js";
import type { RigSpec } from "../src/domain/types.js";

function specWith(coldStart: { member?: boolean; pod?: boolean }): { rigSpec: RigSpec } {
  return {
    rigSpec: {
      version: "0.2",
      name: "fleet",
      pods: [{
        id: "dev",
        label: "Dev",
        ...(coldStart.pod === undefined ? {} : { coldStart: coldStart.pod }),
        members: [{
          id: "impl",
          agentRef: "local:agents/impl",
          profile: "default",
          runtime: "pi",
          cwd: ".",
          ...(coldStart.member === undefined ? {} : { coldStart: coldStart.member }),
        }],
        edges: [],
      }],
      edges: [],
    } as RigSpec,
  };
}

const STOPPED_AT = "2026-11-11T22:00:00.000Z";

function insertStopEvent(db: Database.Database, opts: { sessionName: string; operator: string | null; reason: string }): void {
  db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('r1','n1','session.stopped', ?)")
    .run(JSON.stringify({
      type: "session.stopped", rigId: "r1", nodeId: "n1",
      sessionName: opts.sessionName, reason: opts.reason, operator: opts.operator,
    }));
}

interface FixtureOptions {
  /** The seat's latest session was marked intentionally stopped after `rig seat stop`. */
  intentionallyStopped?: boolean;
  /** Latest stop attribution written by `rig seat stop`. */
  stopEvent?: { sessionName: string; operator: string | null; reason: string };
  /** Latest session row status (default `exited`). */
  status?: string;
}

interface Fixture {
  db: Database.Database;
  deps: SeatColdStartDeps;
  starter: SeatColdStarter;
  launches: Array<{ rigId: string; logicalId: string }>;
  logs: string[];
  setRecipe: (recipe: { rigSpec: RigSpec } | null) => void;
  setLiveSessions: (names: string[]) => void;
  ledger: () => { last_outcome: string; consecutive_failures: number } | undefined;
}

function fixture(opts?: FixtureOptions): Fixture {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  const status = opts?.status ?? "exited";
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r1','fleet');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('n1','r1','dev.impl','pi');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('n2','r1','dev.rev','pi');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('b1','n1','dev-impl@fleet','%1');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('b2','n2','dev-rev@fleet','%2');
    INSERT INTO sessions(id,node_id,session_name,status,created_at,intentionally_stopped)
      VALUES ('s1','n1','dev-impl@fleet','${status}','${STOPPED_AT}',${opts?.intentionallyStopped ? 1 : 0});
    INSERT INTO sessions(id,node_id,session_name,status,created_at,intentionally_stopped)
      VALUES ('s2','n2','dev-rev@fleet','running','${STOPPED_AT}',0);`);
  if (opts?.stopEvent) insertStopEvent(db, opts.stopEvent);
  let recipe: { rigSpec: RigSpec } | null = specWith({ member: true });
  let liveSessions = new Set(["dev-rev@fleet"]);
  const launches: Array<{ rigId: string; logicalId: string }> = [];
  const logs: string[] = [];
  const deps: SeatColdStartDeps = {
    db,
    launchSingleNode: async (rigId, logicalId) => {
      launches.push({ rigId, logicalId });
      return { ok: true, launched: [{ logicalId, status: "resumed" }] };
    },
    hasSession: async name => liveSessions.has(name),
    getNodeLaunchRecipe: () => recipe,
    log: line => logs.push(line),
    now: () => new Date(),
  };
  return {
    db, deps, starter: new SeatColdStarter(deps), launches, logs,
    setRecipe: next => { recipe = next; },
    setLiveSessions: names => { liveSessions = new Set(names); },
    ledger: () => db.prepare("SELECT last_outcome, consecutive_failures FROM seat_cold_starts WHERE node_id = 'n1'")
      .get() as { last_outcome: string; consecutive_failures: number } | undefined,
  };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

describe("SeatColdStarter (#2829 slice 1)", () => {
  it("cold-starts an eligible dormant seat of a running rig through the single-seat door", async () => {
    const f = fixture();
    f.starter.notify("dev.impl@fleet");
    await vi.waitFor(() => expect(f.launches).toHaveLength(1));
    expect(f.launches[0]).toEqual({ rigId: "r1", logicalId: "dev.impl" });
    expect(f.ledger()).toEqual({ last_outcome: "resumed", consecutive_failures: 0 });
    f.db.close();
  });

  it("resolves the dashed canonical address too", async () => {
    const f = fixture();
    f.starter.notify("dev-impl@fleet");
    await vi.waitFor(() => expect(f.launches).toHaveLength(1));
    f.db.close();
  });

  it("coalesces simultaneous arrivals into one launch", async () => {
    const f = fixture();
    f.starter.notify("dev.impl@fleet");
    f.starter.notify("dev-impl@fleet");
    f.starter.notify("dev.impl@fleet");
    await vi.waitFor(() => expect(f.launches).toHaveLength(1));
    await flush();
    expect(f.launches).toHaveLength(1);
    f.db.close();
  });

  it("claims the durable attempt window before the launch, so an in-flight seat cannot be launched twice", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.deps.launchSingleNode = async (rigId, logicalId) => {
      f.launches.push({ rigId, logicalId });
      await gate;
      return { ok: true, launched: [{ logicalId, status: "resumed" }] };
    };
    f.starter.notify("dev.impl@fleet");
    // The window is open while the launch is still running.
    await vi.waitFor(() => expect(f.ledger()?.last_outcome).toBe("launching"));
    f.starter.notify("dev.impl@fleet");
    release();
    await vi.waitFor(() => expect(f.ledger()?.last_outcome).toBe("resumed"));
    expect(f.launches).toHaveLength(1);
    f.db.close();
  });

  it("coalesces across a daemon restart: the durable ledger alone blocks a second launch in the window", async () => {
    const f = fixture();
    f.starter.notify("dev.impl@fleet");
    await vi.waitFor(() => expect(f.launches).toHaveLength(1));
    // A fresh instance has no in-memory join; only the ledger stands between it and a relaunch.
    const restarted = new SeatColdStarter(f.deps);
    restarted.notify("dev.impl@fleet");
    await flush();
    expect(f.launches).toHaveLength(1);
    expect(f.logs.some(line => line.includes("an attempt was made recently"))).toBe(true);
    f.db.close();
  });

  it("coalesces across ticks: a second notification inside the interval does not relaunch", async () => {
    const f = fixture();
    f.starter.notify("dev.impl@fleet");
    await vi.waitFor(() => expect(f.launches).toHaveLength(1));
    await flush();
    f.starter.notify("dev.impl@fleet");
    await flush();
    expect(f.launches).toHaveLength(1);
    f.db.close();
  });

  it("does not cold-start without the opt-in", async () => {
    const f = fixture();
    f.setRecipe(specWith({}));
    f.starter.notify("dev.impl@fleet");
    await flush();
    expect(f.launches).toHaveLength(0);
    f.db.close();
  });

  it("honours the pod-level flag when the member has none", async () => {
    const f = fixture();
    f.setRecipe(specWith({ pod: true }));
    f.starter.notify("dev.impl@fleet");
    await vi.waitFor(() => expect(f.launches).toHaveLength(1));
    f.db.close();
  });

  it("a member's explicit false wins over a pod-level true", async () => {
    const f = fixture();
    f.setRecipe(specWith({ member: false, pod: true }));
    f.starter.notify("dev.impl@fleet");
    await flush();
    expect(f.launches).toHaveLength(0);
    f.db.close();
  });

  it("never cold-starts a deleted seat (removed from the current spec)", async () => {
    const f = fixture();
    f.setRecipe(null);
    f.starter.notify("dev.impl@fleet");
    await flush();
    expect(f.launches).toHaveLength(0);
    f.db.close();
  });

  // === Maintainer term 1: keyed on WHO stopped the seat ===

  it("never cold-starts a human operator stop, and names the operator", async () => {
    const f = fixture({
      intentionallyStopped: true,
      stopEvent: { sessionName: "dev-impl@fleet", operator: "operator:ezotoff", reason: "paused for the weekend" },
    });
    f.starter.notify("dev.impl@fleet");
    await flush();
    expect(f.launches).toHaveLength(0);
    expect(f.logs.some(line => line.includes("operator:ezotoff"))).toBe(true);
    f.db.close();
  });

  it("cold-starts a seat the idle reaper reclaimed, even though its stop intent is recorded", async () => {
    const f = fixture({
      intentionallyStopped: true,
      stopEvent: { sessionName: "dev-impl@fleet", operator: "daemon:seat-reaper", reason: "idle_reap" },
    });
    f.starter.notify("dev.impl@fleet");
    await vi.waitFor(() => expect(f.launches).toHaveLength(1));
    f.db.close();
  });

  it("never revives the reaper's operator for any other reason", async () => {
    const f = fixture({
      intentionallyStopped: true,
      stopEvent: { sessionName: "dev-impl@fleet", operator: "daemon:seat-reaper", reason: "operator_override" },
    });
    f.starter.notify("dev.impl@fleet");
    await flush();
    expect(f.launches).toHaveLength(0);
    f.db.close();
  });

  it("never cold-starts an intentional stop with no attributable event (rig down, removal)", async () => {
    const f = fixture({ intentionallyStopped: true });
    f.starter.notify("dev.impl@fleet");
    await flush();
    expect(f.launches).toHaveLength(0);
    expect(f.logs.some(line => line.includes("stopped intentionally"))).toBe(true);
    f.db.close();
  });

  it("ignores a stale stop event from another session of the same seat", async () => {
    const f = fixture({
      intentionallyStopped: true,
      stopEvent: { sessionName: "dev-impl@fleet--old", operator: "daemon:seat-reaper", reason: "idle_reap" },
    });
    f.starter.notify("dev.impl@fleet");
    await flush();
    expect(f.launches).toHaveLength(0);
    f.db.close();
  });

  it("retries a failed start (a rolled-back launch's superseded row is not an intentional stop)", async () => {
    const f = fixture({ status: "superseded", intentionallyStopped: true });
    f.starter.notify("dev.impl@fleet");
    await vi.waitFor(() => expect(f.launches).toHaveLength(1));
    f.db.close();
  });

  it("never cold-starts when the seat's tmux session is live", async () => {
    const f = fixture();
    f.setLiveSessions(["dev-impl@fleet", "dev-rev@fleet"]);
    f.starter.notify("dev.impl@fleet");
    await flush();
    expect(f.launches).toHaveLength(0);
    f.db.close();
  });

  it("keeps rig-down deferred: no other live seat means no launch", async () => {
    const f = fixture();
    f.setLiveSessions([]);
    f.starter.notify("dev.impl@fleet");
    await flush();
    expect(f.launches).toHaveLength(0);
    expect(f.logs.some(line => line.includes("rig down"))).toBe(true);
    f.db.close();
  });

  it("stops after repeated failed attempts (failed starts do not loop)", async () => {
    const f = fixture();
    f.deps.launchSingleNode = async () => ({ ok: false, code: "no_usable_snapshot", message: "no snapshot" });
    const starter = new SeatColdStarter(f.deps);
    for (let round = 0; round < 4; round++) {
      // Age out the interval gate between rounds; failures accumulate.
      f.db.prepare("UPDATE seat_cold_starts SET last_attempt_at = ? WHERE node_id = 'n1'")
        .run(new Date(Date.now() - COLD_START_MIN_INTERVAL_MS * 2).toISOString());
      starter.notify("dev.impl@fleet");
      await flush();
    }
    const row = f.ledger();
    expect(row?.consecutive_failures).toBe(3);
    expect(row?.last_outcome).toBe("failed:no snapshot");
    expect(f.logs.some(line => line.includes("too many consecutive failed attempts"))).toBe(true);
    f.db.close();
  });

  it("a successful launch resets the failure count", async () => {
    const f = fixture();
    f.db.prepare("INSERT INTO seat_cold_starts (node_id,last_attempt_at,last_outcome,consecutive_failures) VALUES ('n1',?,'failed:test',2)")
      .run(new Date(Date.now() - COLD_START_MIN_INTERVAL_MS * 2).toISOString());
    f.starter.notify("dev.impl@fleet");
    await vi.waitFor(() => expect(f.launches).toHaveLength(1));
    expect(f.ledger()).toEqual({ last_outcome: "resumed", consecutive_failures: 0 });
    f.db.close();
  });

  it("ignores non-seat destinations", async () => {
    const f = fixture();
    f.starter.notify("someone@external");
    f.starter.notify("no-such-seat@fleet");
    await flush();
    expect(f.launches).toHaveLength(0);
    f.db.close();
  });
});

describe("classifyColdStartStop (#2829 slice 1)", () => {
  it("reports a seat that never ran as dormant", () => {
    const f = fixture();
    f.db.prepare("DELETE FROM sessions WHERE node_id = 'n1'").run();
    expect(classifyColdStartStop(f.db, "n1")).toEqual({ kind: "dormant" });
    f.db.close();
  });

  it("reports an observed exit (no stop intent) as dormant", () => {
    const f = fixture();
    expect(classifyColdStartStop(f.db, "n1")).toEqual({ kind: "dormant" });
    f.db.close();
  });
});

describe("cold-start continuity outcomes (#2829 slice 1)", () => {

  it("does not treat an awaiting-decision result as a launch", async () => {
    expect(classifyColdStartLaunch("dev.impl", {
      ok: true,
      launched: [{ logicalId: "dev.impl", status: "awaiting-decision", error: "no resume token" }],
    })).toEqual({ kind: "awaiting_decision", error: "no resume token" });
  });

  it("reads resumed, fresh-primed and already-running distinctly", async () => {
    expect(classifyColdStartLaunch("dev.impl", { ok: true, launched: [{ logicalId: "dev.impl", status: "resumed" }] }))
      .toEqual({ kind: "resumed" });
    expect(classifyColdStartLaunch("dev.impl", { ok: true, launched: [{ logicalId: "dev.impl", status: "fresh-primed" }] }))
      .toEqual({ kind: "fresh_primed" });
    expect(classifyColdStartLaunch("dev.impl", { ok: true, alreadyRunning: [{ logicalId: "dev.impl" }] }))
      .toEqual({ kind: "already_running" });
  });

  it("fails closed when the door reports no outcome for the seat", async () => {
    expect(classifyColdStartLaunch("dev.impl", { ok: true }).kind).toBe("failed");
    expect(classifyColdStartLaunch("dev.impl", { ok: false, code: "no_usable_snapshot", message: "no snapshot" }))
      .toEqual({ kind: "failed", error: "no snapshot" });
  });
});
