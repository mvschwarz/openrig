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
  LOCAL_CLI_NODE_FIELDS_AT_0_2_0,
  LOCAL_CLI_VERSION_LABEL,
  makeLocalCliCapabilityProbe,
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

  // R1 fix per PL-005 Phase A guard review (2026-05-04). Production
  // probe (makeLocalCliCapabilityProbe + LOCAL_CLI_NODE_FIELDS_AT_0_2_0)
  // honestly reports drift WITHOUT a fake probeRig injection. This is
  // the production-wired path: the same factory startup.ts uses to
  // construct the daemon-level fleet capability service.
  it("R1 PRODUCTION-WIRED probe (makeLocalCliCapabilityProbe): recoveryGuidance NOT in CLI allow-list → reports drift on every rig", async () => {
    const cli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo,
      probeRig: makeLocalCliCapabilityProbe(),
    });
    const fleet = await cli.rollupFleet();
    expect(fleet.staleCliCount).toBe(2);
    expect(fleet.degradedFields).toContain("recoveryGuidance");
    expect(fleet.degradedFields).not.toContain("agentActivity");
    for (const row of fleet.rows) {
      expect(row.cliDriftDetected).toBe(true);
      expect(row.cliVersionLabel).toBe(LOCAL_CLI_VERSION_LABEL);
    }
  });

  it("R1: agentActivity IS in LOCAL_CLI_NODE_FIELDS_AT_0_2_0 (audit row 5 ground truth)", () => {
    expect(LOCAL_CLI_NODE_FIELDS_AT_0_2_0.has("agentActivity")).toBe(true);
    expect(LOCAL_CLI_NODE_FIELDS_AT_0_2_0.has("recoveryGuidance")).toBe(false);
  });

  it("R1 production probe: an extended (hypothetical future) CLI allow-list with recoveryGuidance reports zero drift", async () => {
    const futureFields = new Set([
      ...LOCAL_CLI_NODE_FIELDS_AT_0_2_0,
      "recoveryGuidance",
    ]);
    const cli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo,
      probeRig: makeLocalCliCapabilityProbe({
        versionLabel: "0.3.0",
        knownNodeFields: futureFields,
      }),
    });
    const fleet = await cli.rollupFleet();
    expect(fleet.staleCliCount).toBe(0);
    expect(fleet.degradedFields).toEqual([]);
  });
});
