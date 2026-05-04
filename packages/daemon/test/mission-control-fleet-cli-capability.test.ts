import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import {
  MissionControlFleetCliCapability,
  MISSION_CONTROL_DESIRED_FIELDS,
} from "../src/domain/mission-control/mission-control-fleet-cli-capability.js";

describe("MissionControlFleetCliCapability (PL-005 Phase A; 4 sub-clauses of graceful degradation)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig-alpha')`).run();
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-2', 'rig-beta')`).run();
    bus = new EventBus(db);
    rigRepo = new RigRepository(db);
  });

  afterEach(() => db.close());

  it("rollupFleet returns one row per registered rig", async () => {
    const cli = new MissionControlFleetCliCapability({ db, eventBus: bus, rigRepo });
    const fleet = await cli.rollupFleet();
    expect(fleet.rows).toHaveLength(2);
  });

  it("SUB-CLAUSE 1+4: probe-reported missing fields surface as drift + bump staleCliCount", async () => {
    const cli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo,
      probeRig: async (name) => ({
        cliVersionLabel: name === "rig-alpha" ? "v0.1.12" : "head",
        unsupportedFields: name === "rig-alpha" ? ["recoveryGuidance"] : [],
      }),
    });
    const fleet = await cli.rollupFleet();
    const alpha = fleet.rows.find((r) => r.rigName === "rig-alpha");
    const beta = fleet.rows.find((r) => r.rigName === "rig-beta");
    expect(alpha?.cliDriftDetected).toBe(true);
    expect(beta?.cliDriftDetected).toBe(false);
    expect(fleet.staleCliCount).toBe(1);
    expect(fleet.degradedFields).toContain("recoveryGuidance");
  });

  it("SUB-CLAUSE 3: once-per-session-per-rig logging — drift event emitted only once per (rig, field)", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const cli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo,
      probeRig: async () => ({
        cliVersionLabel: "v0.1.12",
        unsupportedFields: ["recoveryGuidance"],
      }),
    });
    // 5 rollup calls = 10 (rig, field) observations, but only 2 drift events (one per rig).
    for (let i = 0; i < 5; i++) {
      await cli.rollupFleet();
    }
    const driftEvents = events.filter((e) => e.type === "mission_control.cli_drift_detected");
    expect(driftEvents).toHaveLength(2); // 2 rigs × 1 missing field × ONCE
  });

  it("SUB-CLAUSE 3: resetDriftLogForTest re-arms once-per-session log", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const cli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo,
      probeRig: async () => ({
        cliVersionLabel: "v0.1.12",
        unsupportedFields: ["recoveryGuidance"],
      }),
    });
    await cli.rollupFleet();
    expect(events.filter((e) => e.type === "mission_control.cli_drift_detected")).toHaveLength(2);
    cli.resetDriftLogForTest();
    await cli.rollupFleet();
    expect(events.filter((e) => e.type === "mission_control.cli_drift_detected")).toHaveLength(4);
  });

  it("SUB-CLAUSE 2: per-rig honesty — different rigs report different capabilities", async () => {
    const cli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo,
      probeRig: async (name) => {
        if (name === "rig-alpha") return { cliVersionLabel: "v0.1.12", unsupportedFields: [...MISSION_CONTROL_DESIRED_FIELDS] };
        return { cliVersionLabel: "head", unsupportedFields: [] };
      },
    });
    const fleet = await cli.rollupFleet();
    const alpha = fleet.rows.find((r) => r.rigName === "rig-alpha");
    const beta = fleet.rows.find((r) => r.rigName === "rig-beta");
    expect(alpha?.cliVersionLabel).toBe("v0.1.12");
    expect(beta?.cliVersionLabel).toBe("head");
  });

  it("rig with active in-progress queue item summarizes activityState=active", async () => {
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-1', '2026-05-04T01:00:00Z', '2026-05-04T01:00:00Z', 'a@rig-alpha', 'b@rig-alpha', 'in-progress', 'routine', 'x')`,
    ).run();
    const cli = new MissionControlFleetCliCapability({ db, eventBus: bus, rigRepo });
    const fleet = await cli.rollupFleet();
    const alpha = fleet.rows.find((r) => r.rigName === "rig-alpha");
    expect(alpha?.activityState).toBe("active");
  });

  it("rig with blocked queue item summarizes activityState=blocked + attentionReason", async () => {
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body, blocked_on)
       VALUES ('q-1', '2026-05-04T01:00:00Z', '2026-05-04T01:00:00Z', 'a@rig-alpha', 'b@rig-alpha', 'blocked', 'routine', 'x', 'gate-x')`,
    ).run();
    const cli = new MissionControlFleetCliCapability({ db, eventBus: bus, rigRepo });
    const fleet = await cli.rollupFleet();
    const alpha = fleet.rows.find((r) => r.rigName === "rig-alpha");
    expect(alpha?.activityState).toBe("blocked");
    expect(alpha?.attentionReason).toContain("gate-x");
  });
});
