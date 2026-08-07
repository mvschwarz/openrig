import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlReadLayer } from "../src/domain/mission-control/mission-control-read-layer.js";
import {
  MissionControlFleetCliCapability,
  makeLocalCliCapabilityProbe,
  LOCAL_CLI_VERSION_LABEL,
} from "../src/domain/mission-control/mission-control-fleet-cli-capability.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";

function buildApp(opts: {
  eventBus: EventBus;
  readLayer: MissionControlReadLayer;
  writeContract: MissionControlWriteContract;
  fleetCli: MissionControlFleetCliCapability;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("missionControlReadLayer" as never, opts.readLayer);
    c.set("missionControlWriteContract" as never, opts.writeContract);
    c.set("missionControlFleetCliCapability" as never, opts.fleetCli);
    await next();
  });
  app.route("/api/mission-control", missionControlRoutes());
  return app;
}

describe("mission-control routes (PL-005 Phase A)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema, viewsCustomSchema,
      missionControlActionsSchema, rigArchiveSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    const viewProjector = new ViewProjector(db, bus);
    const streamStore = new StreamStore(db, bus);
    const rigRepo = new RigRepository(db);
    const fleetCli = new MissionControlFleetCliCapability({ db, eventBus: bus, rigRepo });
    const actionLog = new MissionControlActionLog(db);
    const writeContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog });
    const readLayer = new MissionControlReadLayer({
      db, queueRepo, viewProjector, streamStore, fleetCliCapability: fleetCli,
    });
    app = buildApp({ eventBus: bus, readLayer, writeContract, fleetCli });
  });

  afterEach(() => db.close());

  it("GET /views returns the 7 view names", async () => {
    const res = await app.request("/api/mission-control/views");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { views: string[] };
    expect(body.views).toEqual([
      "my-queue", "human-gate", "fleet", "active-work",
      "recent-ships", "recently-active", "recent-observations",
    ]);
  });

  it("GET /views/:view-name returns view rows for valid view", async () => {
    const res = await app.request("/api/mission-control/views/active-work");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewName: string; rows: unknown[] };
    expect(body.viewName).toBe("active-work");
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("GET /views/:view-name returns 404 for unknown view", async () => {
    const res = await app.request("/api/mission-control/views/totally-bogus");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("view_unknown");
  });

  it("POST /action with valid approve verb returns 200 + structured result", async () => {
    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "dst@rig",
      body: "x",
    });
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      // P21: the actor is the transport header (X-OpenRig-Session), not a body claim.
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "human@r" },
      body: JSON.stringify({
        verb: "approve",
        qitemId: created.qitemId,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actionId: string; verb: string };
    expect(body.actionId).toMatch(/^[0-9A-Z]{26}$/);
    expect(body.verb).toBe("approve");
  });

  it("POST /action with unknown verb returns 400 + verb_unknown", async () => {
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verb: "totally-bogus", qitemId: "x", actorSession: "y" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("verb_unknown");
  });

  it("POST /action on terminal qitem returns 409 + qitem_already_terminal", async () => {
    const created = await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x" });
    await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "h@r" },
      body: JSON.stringify({ verb: "approve", qitemId: created.qitemId }),
    });
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "h@r" },
      body: JSON.stringify({ verb: "approve", qitemId: created.qitemId }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("qitem_already_terminal");
  });

  it("POST /action annotate on missing qitem returns 404 + qitem_not_found", async () => {
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "human@r" },
      body: JSON.stringify({
        verb: "annotate",
        qitemId: "qitem-missing",
        annotation: "operator note",
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("qitem_not_found");
  });

  it("P21 I2: derives the actor from the transport header — forged/absent identity refuses LOUD", async () => {
    const created = await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x" });
    const req = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
      app.request("/api/mission-control/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ verb: "approve", qitemId: created.qitemId, ...extra }),
      });
    // absent header → 401 unattributable (a body actorSession claim is NOT a fallback)
    const noHeader = await req({}, { actorSession: "mallory@r" });
    expect(noHeader.status).toBe(401);
    expect(((await noHeader.json()) as { error: string }).error).toBe("unattributable_sender");
    // body claim ≠ header → 409 identity_mismatch naming BOTH (never prefer either)
    const mismatch = await req({ "X-OpenRig-Session": "human@r" }, { actorSession: "mallory@r" });
    expect(mismatch.status).toBe(409);
    const mm = (await mismatch.json()) as { error: string; message: string };
    expect(mm.error).toBe("identity_mismatch");
    expect(mm.message).toContain("human@r");
    expect(mm.message).toContain("mallory@r");
  });

  it("GET /cli-capabilities returns fleet roll-up", async () => {
    const res = await app.request("/api/mission-control/cli-capabilities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; staleCliCount: number };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.staleCliCount).toBe("number");
  });

  // R1 fix per PL-005 Phase A guard review (2026-05-04). End-to-end
  // proof through the production-wired ROUTE PATH (not just an injected
  // unit seam): when the fleet capability is constructed with the
  // production probe (the same factory startup.ts wires in), the
  // /api/mission-control/cli-capabilities route payload exposes
  // recoveryGuidance drift to UI consumers.
  it("R1 PRODUCTION-WIRED ROUTE: /cli-capabilities reports recoveryGuidance drift in JSON payload + per-row cliDriftDetected", async () => {
    // Build a fresh app with the production probe wired (the no-op
    // default from earlier tests is replaced by the canonical factory).
    const productionFleetCli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo: new RigRepository(db),
      probeRig: makeLocalCliCapabilityProbe(),
    });
    const productionApp = new Hono();
    productionApp.use("*", async (c, next) => {
      c.set("eventBus" as never, bus);
      c.set("missionControlReadLayer" as never, c.get("missionControlReadLayer" as never));
      c.set("missionControlWriteContract" as never, c.get("missionControlWriteContract" as never));
      c.set("missionControlFleetCliCapability" as never, productionFleetCli);
      await next();
    });
    productionApp.route("/api/mission-control", missionControlRoutes());

    const res = await productionApp.request("/api/mission-control/cli-capabilities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ rigName: string; cliDriftDetected: boolean; cliVersionLabel: string }>;
      staleCliCount: number;
      degradedFields: string[];
      sourceFallback: string | null;
    };
    expect(body.staleCliCount).toBeGreaterThan(0);
    expect(body.degradedFields).toContain("recoveryGuidance");
    expect(body.degradedFields).not.toContain("agentActivity");
    for (const row of body.rows) {
      expect(row.cliDriftDetected).toBe(true);
      expect(row.cliVersionLabel).toBe(LOCAL_CLI_VERSION_LABEL);
    }
  });

  // SSE route-order discipline (per PL-004 Phase A R1 lesson; literal
  // /views, /sse, /watch, /cli-capabilities mounted BEFORE /views/:view-name).
  it("R1 SSE pattern: GET /api/mission-control/sse returns 200 + content-type text/event-stream", async () => {
    const res = await app.request("/api/mission-control/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE pattern: GET /api/mission-control/watch returns 200 + content-type text/event-stream", async () => {
    const res = await app.request("/api/mission-control/watch");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE pattern: literal /views returns array (not shadowed by /views/:view-name)", async () => {
    const res = await app.request("/api/mission-control/views");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { views: string[] };
    expect(Array.isArray(body.views)).toBe(true);
  });
});
