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
import { identityProvenanceSchema } from "../src/db/migrations/065_identity_provenance.js";
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
      identityProvenanceSchema,
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

  // P21 REVISED (was "forged/absent identity refuses LOUD"). Contract change, deliberate: mission-control
  // /action is a FOUNDER-VISIBLE review-actions surface (d00c468d) — the browser UI fires approve/deny/etc
  // HEADERLESS (bearer only + body actorSession). Refuse-loud would break the founder's one-tap review, so
  // an absent header now DEFERS (records the body actor as the declared claimed-era variant `claimed:v1`),
  // never 401. The CLI forgery guard (header present, differing body claim → 409) is UNCHANGED.
  it("P21 review-actions deferral: UI headerless records claimed:v1 (never refused, never null); CLI header ⇒ transport:v1; body≠header ⇒ 409", async () => {
    const mk = async (body: string) => (await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body })).qitemId;
    const [qUi, qCli, qMm] = [await mk("u"), await mk("c"), await mk("m")];
    const req = (qitemId: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
      app.request("/api/mission-control/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ verb: "annotate", qitemId, annotation: "n", ...extra }),
      });
    const provenanceOf = (qitemId: string) =>
      (db.prepare("SELECT identity_provenance FROM mission_control_actions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1").get(qitemId) as { identity_provenance: string | null } | undefined)?.identity_provenance ?? null;

    // UI path: headerless + body actorSession → NOT refused; recorded claimed-era (declared variant).
    const ui = await req(qUi, {}, { actorSession: "founder@r" });
    expect(ui.status).toBe(200);
    expect(provenanceOf(qUi)).toBe("claimed:v1");

    // CLI path: transport header present → derived, era-stamped transport:v1.
    const cli = await req(qCli, { "X-OpenRig-Session": "human@r" });
    expect(cli.status).toBe(200);
    expect(provenanceOf(qCli)).toBe("transport:v1");

    // Forgery guard unchanged: header present + differing body claim → 409 naming BOTH (no write).
    const mismatch = await req(qMm, { "X-OpenRig-Session": "human@r" }, { actorSession: "mallory@r" });
    expect(mismatch.status).toBe(409);
    const mm = (await mismatch.json()) as { error: string; message: string };
    expect(mm.error).toBe("identity_mismatch");
    expect(mm.message).toContain("human@r");
    expect(mm.message).toContain("mallory@r");
    expect(provenanceOf(qMm)).toBeNull(); // refused before any write
  });

  // P21 NEGATIVE CONTROL (rail 4) — the anti-laundering pin. Without this a future refactor could silently
  // re-upgrade a relayed claimed-era actor to transport:v1 and the audit trail would lie again.
  it("P21: a RELAYED claimed-era action records claimed:v1 (never transport:v1 — no laundering); transport marker ⇒ relay:v1; MISSING marker ⇒ claimed:v1 (degrade-down)", async () => {
    const mk = async (body: string) => (await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body })).qitemId;
    const [qClaimed, qTransport, qMissing] = [await mk("a"), await mk("b"), await mk("c")];
    const req = (qitemId: string, headers: Record<string, string>) =>
      app.request("/api/mission-control/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "origin@r", ...headers },
        body: JSON.stringify({ verb: "annotate", qitemId, annotation: "n" }),
      });
    const provenanceOf = (qitemId: string) =>
      (db.prepare("SELECT identity_provenance FROM mission_control_actions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1").get(qitemId) as { identity_provenance: string | null } | undefined)?.identity_provenance ?? null;

    // Relayed CLAIMED-era origin actor (marker says claimed:v1): the origin records claimed:v1, NEVER
    // transport:v1 — an unverified actor cannot be laundered into a verified one by crossing a hop.
    await req(qClaimed, { "X-OpenRig-Relay": "host-a", "X-OpenRig-Provenance": "claimed:v1" });
    expect(provenanceOf(qClaimed)).toBe("claimed:v1");

    // Relayed TRANSPORT-verified actor: relay:v1 (verified one hop away — honest about distance), never
    // transport:v1 (which would falsely claim THIS hop verified it).
    await req(qTransport, { "X-OpenRig-Relay": "host-a", "X-OpenRig-Provenance": "transport:v1" });
    expect(provenanceOf(qTransport)).toBe("relay:v1");

    // Rail 1 default-weaker: a relayed request with NO marker (old forwarder) degrades DOWN to claimed:v1,
    // never transport:v1 — a missing marker is indistinguishable from claimed-era and both are unverified.
    await req(qMissing, { "X-OpenRig-Relay": "host-a" });
    expect(provenanceOf(qMissing)).toBe("claimed:v1");
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
