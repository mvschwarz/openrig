import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { MissionControlFleetCliCapability } from "../src/domain/mission-control/mission-control-fleet-cli-capability.js";
import {
  MissionControlReadLayer,
  MISSION_CONTROL_VIEWS,
  type CompactStatusRow,
} from "../src/domain/mission-control/mission-control-read-layer.js";

describe("MissionControlReadLayer (PL-005 Phase A; 7 views)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let viewProjector: ViewProjector;
  let streamStore: StreamStore;
  let readLayer: MissionControlReadLayer;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema, viewsCustomSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    viewProjector = new ViewProjector(db, bus);
    streamStore = new StreamStore(db, bus);
    const rigRepo = new RigRepository(db);
    const fleetCli = new MissionControlFleetCliCapability({ db, eventBus: bus, rigRepo });
    readLayer = new MissionControlReadLayer({
      db,
      queueRepo,
      viewProjector,
      streamStore,
      fleetCliCapability: fleetCli,
      // V0.3.1 slice 05 kernel-rig-as-default — the ReadLayer's
      // defaultOperatorSession is now injected from the resolved
      // workspace.operator_seat_name setting (rather than a hardcoded
      // constant). Existing fixtures use "human-operator@kernel" as the
      // destinationSession; preserve that here so the fixture data
      // and the my-queue routing align. Production startup.ts injects
      // the SettingsStore-resolved value.
      defaultOperatorSession: "human-operator@kernel",
    });
  });

  afterEach(() => db.close());

  it("readView returns a result for all 7 views (no throw, structurally valid)", async () => {
    for (const viewName of MISSION_CONTROL_VIEWS) {
      const result = await readLayer.readView(viewName);
      expect(result.viewName).toBe(viewName);
      expect(Array.isArray(result.rows)).toBe(true);
      expect(typeof result.meta.rowCount).toBe("number");
    }
  });

  it("9-FIELD CONTENT MODEL: every row across every view exposes all 9 fields", async () => {
    // Seed varied content so every view has at least one row.
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human-operator@kernel",
      body: "needs human approval",
      tier: "human-gate",
    });
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "agent@rig",
      body: "agent task",
      priority: "high",
    });
    streamStore.emit({
      streamItemId: "stream-1",
      sourceSession: "discovery@rig",
      body: "observation",
    });

    const fields: Array<keyof CompactStatusRow> = [
      "rigOrMissionName",
      "currentPhase",
      "state",
      "nextAction",
      "pendingHumanDecision",
      "readCost",
      "lastUpdate",
      "confidenceFreshness",
      "evidenceLink",
    ];

    for (const viewName of MISSION_CONTROL_VIEWS) {
      const result = await readLayer.readView(viewName);
      for (const row of result.rows) {
        for (const field of fields) {
          expect(field in row).toBe(true);
        }
      }
    }
  });

  it("my-queue filters to operator's human-gate items only", async () => {
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human-operator@kernel",
      body: "for the operator",
      tier: "human-gate",
    });
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "agent@rig",
      body: "not human-gate",
    });
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human-operator@kernel",
      body: "non-human-gate from operator",
    });
    const result = await readLayer.readView("my-queue");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.rigOrMissionName).toBe("human-operator@kernel");
  });

  it("qitem-backed rows preserve the queue body for phone human-gate decisions", async () => {
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human-operator@kernel",
      body: "Approve the release candidate after checking the phone notification path.",
      tier: "human-gate",
    });

    const result = await readLayer.readView("my-queue");
    const row = result.rows[0] as Record<string, unknown>;
    expect(row.qitemBody).toBe("Approve the release candidate after checking the phone notification path.");
    expect(row.qitemSummary).toContain("Approve the release candidate");
  });

  it("recent-ships caps at 10", async () => {
    for (let i = 0; i < 15; i++) {
      const created = await queueRepo.create({
        sourceSession: "src@rig",
        destinationSession: "agent@rig",
        body: `ship ${i}`,
      });
      queueRepo.update({
        qitemId: created.qitemId,
        actorSession: "agent@rig",
        state: "done",
        closureReason: "no-follow-on",
      });
    }
    const result = await readLayer.readView("recent-ships");
    expect(result.rows).toHaveLength(10);
  });

  it("active-work sorts priority-first (critical > high > routine > background)", async () => {
    await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x", priority: "routine" });
    await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x", priority: "critical" });
    await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x", priority: "high" });
    const result = await readLayer.readView("active-work");
    expect(result.rows[0]?.confidenceFreshness).toBe("critical");
    expect(result.rows[1]?.confidenceFreshness).toBe("high");
    expect(result.rows[2]?.confidenceFreshness).toBe("routine");
  });

  it("recent-observations reads from stream_items (PL-004 Phase A daemon-backed source)", async () => {
    streamStore.emit({
      streamItemId: "stream-1",
      sourceSession: "discovery@rig",
      body: "observation 1",
      hintType: "feature-request",
    });
    streamStore.emit({
      streamItemId: "stream-2",
      sourceSession: "discovery@rig",
      body: "observation 2",
    });
    const result = await readLayer.readView("recent-observations");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.rigOrMissionName).toBe("discovery@rig");
  });

  it("fleet view returns rows + drift indicator metadata", async () => {
    const result = await readLayer.readView("fleet");
    expect(result.viewName).toBe("fleet");
    expect(typeof result.meta.rowCount).toBe("number");
    // staleCliCount is present (may be 0 with default no-op probe).
    expect(typeof result.meta.rigsRunningStaleCli).toBe("number");
  });
});
