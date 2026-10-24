// Slice 16's narrow check (founder decision-20261014-0454-1214-successor-first: extra generation checks narrowed to the
// switch itself). During and after a runtime switch two processes may act as one seat. Only the generations a switch
// record names are held back, on the seat it names; every other request goes on exactly as before (P8, P9).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { queueRoutes } from "../src/routes/queue.js";
import { transportRoutes } from "../src/routes/transport.js";
import { activityRoutes } from "../src/routes/activity.js";
import { runtimeSwitchCustodyRefusal } from "../src/routes/runtime-switch-custody.js";

const SEAT = "dev-impl@seat-rig";
const OTHER = "orch-lead@seat-rig";

describe("a runtime switch's own processes don't act as the seat; nothing else changes", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let queueRepo: QueueRepository;
  let app: Hono;
  let nodeId: string;
  let predecessor: string;
  let send: ReturnType<typeof vi.fn>;
  const successor = "0b9d8c7e-successor-generation";

  const record = (committed: boolean) => db.prepare(`INSERT INTO seat_runtime_switches (id, node_id, canonical_session, staging_session, predecessor_pane,
      successor_pane, predecessor_generation, successor_generation, from_runtime, to_runtime, phase, reason, plan_json, deadline_at, committed_at)
      VALUES ('sw1', ?, ?, 'openrig-switch-sw1', '%0', '%5', ?, ?, 'codex', 'claude-code', ?, 'limit', '{}', '2026-10-24T03:00:00Z', ?)`)
    .run(nodeId, SEAT, predecessor, successor, committed ? "finished" : "preparing", committed ? "2026-10-24T02:01:00.000Z" : null);
  const asSeat = (generation?: string) => ({ "Content-Type": "application/json", "X-OpenRig-Session": SEAT,
    ...(generation ? { "X-OpenRig-Occupant-Generation": generation } : {}) });
  const claim = (id: string, generation?: string) => app.request(`/api/queue/${id}/claim`, { method: "POST", headers: asSeat(generation), body: "{}" });
  const create = (generation?: string) => app.request("/api/queue/create", { method: "POST", headers: asSeat(generation),
    body: JSON.stringify({ destinationSession: OTHER, body: "from the seat", nudge: false }) });

  beforeEach(() => {
    db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    const inbox = new InboxHandler(db, eventBus, queueRepo);
    const outbox = new OutboxHandler(db);
    queueRepo.attachOutbox(outbox);
    const rig = rigRepo.createRig("seat-rig");
    nodeId = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" }).id;
    const session = sessionRegistry.registerSession(nodeId, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(nodeId, { tmuxSession: SEAT, tmuxPane: "%0" });
    predecessor = sessionRegistry.currentOccupantTenure(nodeId)!.generationUuid;
    send = vi.fn(async () => ({ ok: true, sessionName: SEAT }));
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("db" as never, db as never);
      c.set("eventBus" as never, eventBus as never);
      c.set("queueRepo" as never, queueRepo as never);
      c.set("inboxHandler" as never, inbox as never);
      c.set("outboxHandler" as never, outbox as never);
      c.set("sessionTransport" as never, { resolveSessions: vi.fn(async () => ({ ok: true, sessions: [{ sessionName: SEAT }] })), send } as never);
      c.set("agentActivityStore" as never, new AgentActivityStore({ db, eventBus }) as never);
      c.set("activityHookToken" as never, "fixture" as never);
      c.set("sessionRegistry" as never, sessionRegistry as never);
      await next();
    });
    app.route("/api/queue", queueRoutes());
    app.route("/api/transport", transportRoutes());
    app.route("/api/activity", activityRoutes);
  });
  afterEach(() => db.close());

  describe("after the switch commits", () => {
    beforeEach(() => record(true));

    it("the retired predecessor can't claim the seat's work, and is told the seat moved", async () => {
      const row = await queueRepo.create({ sourceSession: OTHER, destinationSession: SEAT, body: "review", nudge: false });
      const response = await claim(row.qitemId, predecessor);
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({ code: "occupant_retired_by_switch", switchId: "sw1" });
      expect(body.message).toMatch(/This process was dev-impl@seat-rig's codex occupant\. The seat moved to claude-code/);
      expect(queueRepo.getById(row.qitemId)?.state).toBe("pending");
    });

    it("the retired predecessor can't send as the seat; nothing is typed anywhere", async () => {
      const response = await app.request("/api/transport/send", { method: "POST", headers: asSeat(predecessor), body: JSON.stringify({ session: OTHER, text: "hi" }) });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "occupant_retired_by_switch" });
      expect(send).not.toHaveBeenCalled();
    });

    it("the successor, and a request with no generation, claim as before", async () => {
      const first = await queueRepo.create({ sourceSession: OTHER, destinationSession: SEAT, body: "a", nudge: false });
      const second = await queueRepo.create({ sourceSession: OTHER, destinationSession: SEAT, body: "b", nudge: false });
      expect((await claim(first.qitemId, successor)).status).toBe(200);
      expect((await claim(second.qitemId)).status).toBe(200);
    });

    it("the retired predecessor's activity doesn't count for the seat", async () => {
      const response = await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", "x-openrig-activity-token": "fixture" },
        body: JSON.stringify({ eventFamily: "activity", hookEvent: "PreToolUse", sessionName: SEAT, nodeId, runtime: "codex", generation: predecessor }) });
      expect(await response.json()).toMatchObject({ ok: true, ignored: "retired_predecessor", switchId: "sw1" });
    });
  });

  describe("before the switch commits", () => {
    beforeEach(() => record(false));

    it("the staged successor can't act as the seat yet, and is told how to confirm and to wait", async () => {
      const response = await create(successor);
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({ code: "switch_not_committed", switchId: "sw1" });
      expect(body.message).toMatch(/rig seat set-runtime dev-impl@seat-rig --confirm sw1 --note/);
      expect(queueRepo.list()).toHaveLength(0);
    });

    it("the predecessor still holds the seat and works as before", async () => {
      expect((await create(predecessor)).status).toBe(201);
    });

    it("the staged successor's native identity is kept on the switch, not written to the seat", async () => {
      const response = await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", "x-openrig-activity-token": "fixture" },
        body: JSON.stringify({ eventFamily: "session_identity", hookEvent: "SessionStart", sessionName: SEAT, nodeId, runtime: "claude-code", generation: successor,
          sessionId: "11111111-2222-4333-8444-555555555555" }) });
      expect(await response.json()).toMatchObject({ ok: true, ignored: "staged_successor", tokenPersisted: false });
      expect(db.prepare("SELECT successor_resume_token t FROM seat_runtime_switches WHERE id = 'sw1'").get()).toEqual({ t: "11111111-2222-4333-8444-555555555555" });
      expect((db.prepare("SELECT resume_token t FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(nodeId) as { t: string | null }).t).toBeNull();
    });
  });

  describe("nothing else changes (P9)", () => {
    it("a seat with no switch: an earlier generation of a re-adopted seat still works", async () => {
      // A claim or self-attach mints a new tenure for a process that keeps its old environment.
      sessionRegistry.registerClaimedSession(nodeId, SEAT, "adopt");
      expect(sessionRegistry.currentOccupantTenure(nodeId)!.generationUuid).not.toBe(predecessor);
      expect((await create(predecessor)).status).toBe(201);
    });

    it("a switch's generation on another seat, an unknown generation, and no generation are all left alone", () => {
      record(true);
      expect(runtimeSwitchCustodyRefusal(db, OTHER, predecessor)).toBeNull();
      expect(runtimeSwitchCustodyRefusal(db, SEAT, "some-other-generation")).toBeNull();
      expect(runtimeSwitchCustodyRefusal(db, SEAT, null)).toBeNull();
      expect(runtimeSwitchCustodyRefusal(db, null, predecessor)).toBeNull();
    });

    it("a store without switch records refuses nothing", () => {
      db.exec("DROP TABLE seat_runtime_switches");
      expect(runtimeSwitchCustodyRefusal(db, SEAT, predecessor)).toBeNull();
    });
  });

  // A send to a seat that is switching is held at once and says why, on the send's own answer (no extra request, and
  // no wait behind the switch's lease).
  describe("a send to a seat that is switching runtime", () => {
    const sendTo = () => app.request("/api/transport/send", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": OTHER }, body: JSON.stringify({ session: SEAT, text: "please review" }) });

    it("is held, not typed, and the sender is told the seat is switching and until when", async () => {
      record(false);
      const response = await sendTo();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ outcome: "retained", sent: false, reason: "runtime_switch_in_progress", runtimeSwitch: { id: "sw1", to: "claude-code" } });
      expect(body.warning).toBe("dev-impl@seat-rig is switching runtime (codex -> claude-code, switch sw1) until about 2026-10-24T03:00:00Z. Send it again after the switch; it then reaches whoever holds the seat.");
      expect(send).not.toHaveBeenCalled();
    });

    it("once the switch has committed, a send goes to the seat as usual", async () => {
      record(true);
      expect((await sendTo()).status).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("a send that waited while the seat moved says so, and that nothing was typed", async () => {
      send.mockImplementationOnce(async () => {
        // The switch commits while this send waits behind its lease.
        db.prepare(`INSERT INTO seat_runtime_switches (id, node_id, canonical_session, staging_session, predecessor_pane, successor_pane,
          predecessor_generation, successor_generation, from_runtime, to_runtime, phase, reason, plan_json, deadline_at, committed_at)
          VALUES ('sw2', ?, ?, 'openrig-switch-sw2', '%0', '%5', ?, 'g2', 'codex', 'claude-code', 'finished', 'limit', '{}', ?, ?)`)
          .run(nodeId, SEAT, predecessor, new Date().toISOString(), new Date().toISOString());
        return { ok: false, sessionName: SEAT, sent: false, reason: "guard_target_changed", error: "Input target changed while waiting; no input written." };
      });
      const response = await sendTo();
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("Input target changed while waiting; no input written. dev-impl@seat-rig moved to claude-code (runtime switch sw2) while this send waited, so nothing was typed. Send it again to reach its new occupant.");
    });

    it("a seat with no switch, or a switch long finished, sends exactly as before", async () => {
      expect((await sendTo()).status).toBe(200);
      send.mockImplementationOnce(async () => ({ ok: false, sessionName: SEAT, sent: false, reason: "guard_target_changed", error: "Input target changed while waiting; no input written." }));
      record(true); // committed 2026-10-24T02:01Z, before this send began
      expect((await (await sendTo()).json()).error).toBe("Input target changed while waiting; no input written.");
    });
  });
});
