import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { i3IdentityProvenanceSchema } from "../src/db/migrations/067_i3_identity_provenance.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { CLOSURE_REASONS } from "../src/domain/hot-potato-enforcer.js";
import { queueRoutes } from "../src/routes/queue.js";
import { setSelfHostId, getSelfHostId } from "../src/domain/hosts/fanout-contract.js";
import { expectLimitParsing } from "./helpers/limit-query-cases.js";

function buildApp(opts: {
  eventBus: EventBus;
  queueRepo: QueueRepository;
  inboxHandler: InboxHandler;
  outboxHandler: OutboxHandler;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("queueRepo" as never, opts.queueRepo);
    c.set("inboxHandler" as never, opts.inboxHandler);
    c.set("outboxHandler" as never, opts.outboxHandler);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  return app;
}

describe("queue routes", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let inbox: InboxHandler;
  let outbox: OutboxHandler;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      streamItemsSchema, // 067's stream_items ALTER needs its base table present
      queueItemsSchema,
      queueTransitionsSchema,
      watchdogJobsSchema,
      inboxEntriesSchema,
      outboxEntriesSchema,
      queueTargetRepoSchema, // OPR.0.3.2.20: required for attention=1&targetRepo=X composition tests
      i3IdentityProvenanceSchema, // P21 §4 era-stamp column on the queue-spine stores (last: needs all 4 tables)
    ]);
    createWakeContractTable(db);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    inbox = new InboxHandler(db, bus, queueRepo);
    outbox = new OutboxHandler(db);
    queueRepo.attachOutbox(outbox); // W1 MF2: handoff routes need a wake-intent store
    app = buildApp({ eventBus: bus, queueRepo, inboxHandler: inbox, outboxHandler: outbox });
  });

  afterEach(() => db.close());

  it.each(["create", "handoff", "handoff-and-complete"])("keeps committed %s successful when the destination advisory throws", async (verb) => {
    queueRepo = new QueueRepository(db, bus, {
      destinationAdvisory: () => { throw Object.assign(new Error("membership unavailable"), { code: "SQLITE_BUSY" }); },
    });
    queueRepo.attachOutbox(outbox);
    app = buildApp({ eventBus: bus, queueRepo, inboxHandler: inbox, outboxHandler: outbox });
    const source = verb === "create" ? null : await queueRepo.create({
      sourceSession: "a@r", destinationSession: "a@r", body: "source", nudge: false,
    });
    const response = await app.request(source ? `/api/queue/${source.qitemId}/${verb}` : "/api/queue/create", {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify(source ? { toSession: "typo@r", nudge: false } : { destinationSession: "typo@r", body: "committed", nudge: false }),
    });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.advisories).toBeUndefined();
    const created = result.created ?? result;
    expect(queueRepo.getById(created.qitemId)?.destinationSession).toBe("typo@r");
    expect(queueRepo.list()).toHaveLength(source ? 2 : 1);
    if (source) expect(queueRepo.getById(source.qitemId)?.state).toBe(verb === "handoff" ? "handed-off" : "done");
  });

  function createWakeContractTable(database: Database.Database): void {
    database.exec(`
      CREATE TABLE queue_transition_wakes (
        transition_id INTEGER PRIMARY KEY,
        qitem_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        wake_kind TEXT NOT NULL,
        wake_ref TEXT NOT NULL,
        delivery_status TEXT
      );
      CREATE INDEX idx_queue_transition_wakes_qitem ON queue_transition_wakes(qitem_id, transition_id);
      CREATE INDEX idx_queue_transition_wakes_ref ON queue_transition_wakes(wake_ref, phase);
    `);
  }

  it.each(["missing", "unrelated", "wrong-owner", "remote-qualified"] as const)(
    "records generic handoff with unverified custody advice (%s) without creating work", async (mode) => {
      const source = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "continue", nudge: false });
      queueRepo.claim({ qitemId: source.qitemId, destinationSession: "b@r" });
      const successor = mode === "missing" ? null : await queueRepo.create({
        sourceSession: "b@r", destinationSession: mode === "wrong-owner" ? "other@r" : "next@r",
        body: "follow-on", nudge: false,
        chainOfRecord: mode === "unrelated" ? [] : [source.qitemId],
      });
      const transitions = queueRepo.listTransitions(source.qitemId);
      const events = bus.replayAll(0);
      const closureTarget = mode === "remote-qualified" ? `${successor!.qitemId}@remote` : "next@r";
      const res = await app.request(`/api/queue/${source.qitemId}/update`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({ state: "done", closureReason: "handed_off_to", closureTarget,
          transitionNote: "handoff" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ state: "done", closureTarget,
        handoffAdvisory: { status: "unverified", target: closureTarget } });
      expect(queueRepo.getById(source.qitemId)).toMatchObject({ state: "done",
        handoffAdvisory: { status: "unverified" } });
      expect(queueRepo.list({ limit: 100 })).toHaveLength(successor ? 2 : 1);
      expect(queueRepo.listTransitions(source.qitemId)).toHaveLength(transitions.length + 1);
      expect(bus.replayAll(0).length).toBeGreaterThan(events.length);
    },
  );

  it.each(["seat", "qitem"] as const)("accepts an existing successor with source lineage targeted by %s", async (targetKind) => {
    const source = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "continue", nudge: false });
    const successor = await queueRepo.create({ sourceSession: "b@r", destinationSession: "next@r", body: "follow-on",
      chainOfRecord: [source.qitemId], nudge: false });
    const res = await app.request(`/api/queue/${source.qitemId}/update`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({ state: "done", closureReason: "handed_off_to",
        closureTarget: targetKind === "seat" ? "next@r" : successor.qitemId }),
    });
    expect(res.status).toBe(200);
    expect(queueRepo.getById(source.qitemId)).toMatchObject({ state: "done", closureTarget: targetKind === "seat" ? "next@r" : successor.qitemId });
    expect(queueRepo.getById(successor.qitemId)).toMatchObject({ state: "pending", chainOfRecord: [source.qitemId] });
  });

  it("does not infer lost custody when a linked successor has handed on to a third owner", async () => {
    const source = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "continue", nudge: false });
    const successor = await queueRepo.create({ sourceSession: "b@r", destinationSession: "next@r", body: "follow-on",
      chainOfRecord: [source.qitemId], nudge: false });
    queueRepo.update({ qitemId: source.qitemId, actorSession: "b@r", state: "done",
      closureReason: "handed_off_to", closureTarget: successor.qitemId });
    const nextHop = await queueRepo.handoff({ qitemId: successor.qitemId, fromSession: "next@r", toSession: "third@r", nudge: false });
    expect(nextHop.created.state).toBe("pending");
    expect(queueRepo.getById(source.qitemId)?.handoffAdvisory).toBeUndefined();
    expect(queueRepo.list({ limit: 100 })).toHaveLength(3);
  });

  it.each([{ states: ["failed"] }, { states: ["denied"] }, { states: ["canceled"] }, { states: ["done"] }, { states: ["done", "failed"] }] as const)(
    "does not infer custody from linked local successor states $states", async ({ states }) => {
      const source = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "continue", nudge: false });
      for (const state of states) {
        const successor = await queueRepo.create({ sourceSession: "b@r", destinationSession: "next@r", body: "follow-on",
          chainOfRecord: [source.qitemId], nudge: false });
        queueRepo.update({ qitemId: successor.qitemId, actorSession: "next@r", state,
          ...(state === "done" ? { closureReason: "no-follow-on" } : {}) });
      }
      const count = queueRepo.list({ limit: 100 }).length;
      const res = await app.request(`/api/queue/${source.qitemId}/update`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({ state: "done", closureReason: "handed_off_to", closureTarget: "next@r" }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).handoffAdvisory).toBeUndefined();
      expect(queueRepo.getById(source.qitemId)?.handoffAdvisory).toBeUndefined();
      expect(queueRepo.list({ limit: 100 })).toHaveLength(count);
    },
  );

  it("keeps a saved generic close successful when the optional custody lookup is unavailable", async () => {
    const source = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "continue", nudge: false });
    const nativePrepare = db.prepare.bind(db);
    const prepare = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.includes("FROM queue_items s") && sql.includes("json_each")) {
        throw Object.assign(new Error("optional custody lookup unavailable"), { code: "SQLITE_BUSY" });
      }
      return nativePrepare(sql);
    });
    try {
      const res = await app.request(`/api/queue/${source.qitemId}/update`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({ state: "done", closureReason: "handed_off_to", closureTarget: "next@r" }),
      });
      expect(res.status).toBe(200);
      const row = await res.json();
      expect(row.state).toBe("done");
      expect(row.handoffAdvisory).toBeUndefined();
      expect(nativePrepare("SELECT state, closure_reason, closure_target FROM queue_items WHERE qitem_id = ?").get(source.qitemId))
        .toEqual({ state: "done", closure_reason: "handed_off_to", closure_target: "next@r" });
      expect(nativePrepare("SELECT COUNT(*) AS n FROM queue_items").get()).toEqual({ n: 1 });
    } finally { prepare.mockRestore(); }
    expect(queueRepo.getById(source.qitemId)?.handoffAdvisory?.status).toBe("unverified");
  });

  it("skips successor-history lookups for transactionally handed-off rows on show, list and note updates", async () => {
    const source = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "continue", nudge: false });
    const handoff = await queueRepo.handoff({ qitemId: source.qitemId, fromSession: "b@r", toSession: "next@r", nudge: false });
    const prepare = vi.spyOn(db, "prepare"); // Forward actual SQL; only observe the lookup boundary.
    try {
      expect(queueRepo.getById(source.qitemId)?.state).toBe("handed-off");
      queueRepo.list({ limit: 100 });
      const res = await app.request(`/api/queue/${source.qitemId}/update`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({ transitionNote: "receipt appended" }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).handoffAdvisory).toBeUndefined();
      expect(prepare.mock.calls.filter(([sql]) => sql.includes("FROM queue_items s") && sql.includes("json_each"))).toEqual([]);
      expect(queueRepo.getById(handoff.created.qitemId)?.state).toBe("pending");
      expect(queueRepo.list({ limit: 100 })).toHaveLength(2);
    } finally { prepare.mockRestore(); }
  });

  it("keeps dependent row resolution unchanged when recording an unverified close", async () => {
    const source = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "continue", nudge: false });
    const dependent = await queueRepo.create({ sourceSession: "a@r", destinationSession: "held@r", body: "wait", nudge: false });
    queueRepo.update({ qitemId: dependent.qitemId, actorSession: "held@r", state: "blocked", blockedOn: source.qitemId });
    const res = await app.request(`/api/queue/${source.qitemId}/update`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({ state: "done", closureReason: "handed_off_to", closureTarget: "next@r" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handoffAdvisory: { status: "unverified" } });
    expect(queueRepo.getById(dependent.qitemId)?.state).toBe("pending");
    expect(queueRepo.list({ limit: 100 })).toHaveLength(2);
  });

  it("keeps legacy custody note appends and explicit reopen/repair available", async () => {
    const source = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "legacy", nudge: false });
    queueRepo.update({ qitemId: source.qitemId, actorSession: "b@r",
      state: "done", closureReason: "handed_off_to", closureTarget: "qitem-old@remote" });
    const post = (body: Record<string, unknown>) => app.request(`/api/queue/${source.qitemId}/update`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" }, body: JSON.stringify(body),
    });
    expect((await post({ transitionNote: "custody verification remains an append-only fact" })).status).toBe(200);
    expect(queueRepo.getById(source.qitemId)).toMatchObject({ state: "done", closureTarget: "qitem-old@remote" });
    expect((await post({ state: "in-progress", reopen: true, transitionNote: "deliberately repair missing custody" })).status).toBe(200);
    const successor = await queueRepo.create({ sourceSession: "b@r", destinationSession: "next@r", body: "repaired follow-on",
      chainOfRecord: [source.qitemId], nudge: false });
    expect((await post({ state: "done", closureReason: "handed_off_to", closureTarget: successor.qitemId })).status).toBe(200);
    expect(queueRepo.getById(source.qitemId)).toMatchObject({ state: "done", closureTarget: successor.qitemId });
  });

  it("S03: update route passes wakeAfterSeconds through and atomically records the timer", async () => {
    const row = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x", nudge: false });
    const res = await app.request(`/api/queue/${row.qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({
        state: "blocked",
        blockedOn: "external:cooldown",
        transitionNote: "continuation: retry after cooldown",
        wakeAfterSeconds: 45,
      }),
    });
    expect(res.status).toBe(200);
    const wake = db.prepare("SELECT wake_kind, wake_ref FROM queue_transition_wakes WHERE qitem_id = ?")
      .get(row.qitemId) as { wake_kind: string; wake_ref: string } | undefined;
    expect(wake?.wake_kind).toBe("timer");
    const transitions = await app.request(`/api/queue/${row.qitemId}/transitions`);
    expect(transitions.status).toBe(200);
    expect((await transitions.json() as Array<{ wake?: { kind: string; ref: string } }>).at(-1)?.wake)
      .toMatchObject({ kind: "timer", ref: wake?.wake_ref });
    const job = wake
      ? db.prepare("SELECT target_session, interval_seconds, state FROM watchdog_jobs WHERE job_id = ?").get(wake.wake_ref)
      : undefined;
    expect(job).toMatchObject({ target_session: "b@r", interval_seconds: 45, state: "active" });
  });

  // 0.5.1-54 DR-1 — the create-path failed-nudge surface (the NAMED, human/agent-visible read path).
  it("DR-1: GET /undelivered surfaces the failed-nudge pending strand, V1-only", async () => {
    const failed = await queueRepo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "x" });
    queueRepo.recordNudgeAttempt(failed.qitemId, "failed:Session 'b@rig' not found");
    const delivered = await queueRepo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "y" });
    queueRepo.recordNudgeAttempt(delivered.qitemId, "verified");
    const res = await app.request("/api/queue/undelivered");
    expect(res.status).toBe(200);
    const items = (await res.json()) as Array<{ qitemId: string; deliveryFailureClass: string | null }>;
    const ids = items.map((i) => i.qitemId);
    expect(ids, "the failed-nudge strand is surfaced").toContain(failed.qitemId);
    expect(ids, "V1-only: a delivered row is not surfaced").not.toContain(delivered.qitemId);
    // classifier fold: the not-found strand is labeled permanent-topology (unresolvable on this daemon).
    const strand = items.find((i) => i.qitemId === failed.qitemId)!;
    expect(strand.deliveryFailureClass, "the not-found strand is labeled permanent-topology").toBe("permanent-topology");
  });

  // ── P18 sender-provenance: /inbox/drop derives the sender from the authenticated transport
  // header (X-OpenRig-Session), never a request-body claim; refuses-unattributable LOUD when absent. ──
  describe("P18 sender-provenance", () => {
    it("records the TRANSPORT-DERIVED sender (header), IGNORING a forged body senderSession/authenticatedSender", async () => {
      const res = await app.request("/api/queue/inbox/drop", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
        body: JSON.stringify({
          destinationSession: "bob@rig", body: "hi",
          senderSession: "mallory@rig", authenticatedSender: "mallory@rig", // forged body claims — must be ignored
        }),
      });
      expect(res.status).toBe(201);
      const entry = await res.json() as { senderSession: string };
      expect(entry.senderSession).toBe("alice@rig"); // the header wins; the forged body claim never lands
    });

    it("header absent (no body sender read) → 400 actor_required (P18 sweep: parameter completeness, not the retired 401 refusal)", async () => {
      const res = await app.request("/api/queue/inbox/drop", {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // NO X-OpenRig-Session
        body: JSON.stringify({ destinationSession: "bob@rig", body: "hi", senderSession: "mallory@rig" }),
      });
      // inbox/drop never reads a body sender (forgeable), so with no header there is no actor to LABEL →
      // 400 actor_required (the queue.ts:215 class), NOT the retired 401 refusal-of-an-uncertifiable-sender.
      expect(res.status).toBe(400);
      const err = await res.json() as { error: string; message: string };
      expect(err.error).toBe("actor_required");
      expect(err.message).toMatch(/X-OpenRig-Session/);
    });
  });

  it("inbox drop — era-stamps inbox_entries transport:v1 (P21 §4 derived-era boundary)", async () => {
    const res = await app.request("/api/queue/inbox/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "sender@rig" },
      body: JSON.stringify({ destinationSession: "dest@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { inboxId } = (await res.json()) as { inboxId: string };
    // The dropped entry's sender is transport-derived → the channel-of-record row is stamped transport:v1.
    const row = db
      .prepare("SELECT identity_provenance FROM inbox_entries WHERE inbox_id = ?")
      .get(inboxId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  // P21 I3 — inbox absorb/deny (receiverSession) + outbox record (senderSession) were the LIVE
  // allow-all body-supplied identity sites (specimen-5 family). I3 derives them from the header.
  async function dropEntry(dest: string, sender: string): Promise<string> {
    const res = await app.request("/api/queue/inbox/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": sender },
      body: JSON.stringify({ destinationSession: dest, body: "hi" }),
    });
    return ((await res.json()) as { inboxId: string }).inboxId;
  }

  it("outbox record — still accepts a normal (non-reserved) outboxId", async () => {
    const res = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "sender@rig" },
      body: JSON.stringify({ destinationSession: "dest@rig", body: "ordinary audit" }),
    });
    expect(res.status).toBe(201);
  });

  it("inbox absorb — header absent + body receiverSession → delivers under the claimed actor, transition claimed:v1 (deliver-and-label)", async () => {
    const inboxId = await dropEntry("dest@rig", "sender@rig");
    const res = await app.request(`/api/queue/inbox/${inboxId}/absorb`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiverSession: "dest@rig" }),
    });
    expect(res.status).toBe(200);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  it("inbox absorb — header present + differing body receiverSession → wire supersedes (delivers under dest@rig, transport:v1); 409 retired", async () => {
    const inboxId = await dropEntry("dest@rig", "sender@rig");
    const res = await app.request(`/api/queue/inbox/${inboxId}/absorb`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dest@rig" },
      body: JSON.stringify({ receiverSession: "mallory@rig" }), // superseded by the wire identity
    });
    expect(res.status).toBe(200);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("inbox absorb — derives receiver from the header + era-stamps the absorbed qitem transport:v1", async () => {
    const inboxId = await dropEntry("dest@rig", "sender@rig");
    const res = await app.request(`/api/queue/inbox/${inboxId}/absorb`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dest@rig" },
      body: JSON.stringify({ receiverSession: "dest@rig" }),
    });
    expect(res.status).toBe(200);
    const { qitemId } = (await res.json()) as { qitemId: string };
    // The absorb is a transport-derived receiver action → the created qitem's transition is transport:v1.
    const row = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("inbox deny — header absent + body receiverSession → delivers under the claimed actor (200); 401 retired", async () => {
    const inboxId = await dropEntry("dest@rig", "sender@rig");
    const res = await app.request(`/api/queue/inbox/${inboxId}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiverSession: "dest@rig", reason: "nope" }),
    });
    expect(res.status).toBe(200);
  });

  it("inbox deny — header present + differing body receiverSession → wire supersedes, delivers (200); 409 retired", async () => {
    const inboxId = await dropEntry("dest@rig", "sender@rig");
    const res = await app.request(`/api/queue/inbox/${inboxId}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dest@rig" },
      body: JSON.stringify({ receiverSession: "mallory@rig", reason: "nope" }), // superseded by the wire identity
    });
    expect(res.status).toBe(200);
  });

  it("inbox deny — derives receiver from the header (200)", async () => {
    const inboxId = await dropEntry("dest@rig", "sender@rig");
    const res = await app.request(`/api/queue/inbox/${inboxId}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dest@rig" },
      body: JSON.stringify({ receiverSession: "dest@rig", reason: "not mine" }),
    });
    expect(res.status).toBe(200);
  });

  it("outbox record — header absent + body senderSession → delivers under the claimed actor, outbox_entries claimed:v1", async () => {
    const res = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderSession: "me@rig", destinationSession: "you@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { outboxId } = (await res.json()) as { outboxId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM outbox_entries WHERE outbox_id = ?")
      .get(outboxId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  it("outbox record — header present + differing body senderSession → wire supersedes (transport:v1); 409 retired", async () => {
    const res = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "me@rig" },
      body: JSON.stringify({ senderSession: "evil@rig", destinationSession: "you@rig", body: "hi" }), // superseded
    });
    expect(res.status).toBe(201);
    const { outboxId } = (await res.json()) as { outboxId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM outbox_entries WHERE outbox_id = ?")
      .get(outboxId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("outbox record — derives sender from the header + era-stamps outbox_entries transport:v1", async () => {
    const res = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "me@rig" },
      body: JSON.stringify({ senderSession: "me@rig", destinationSession: "you@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { outboxId } = (await res.json()) as { outboxId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM outbox_entries WHERE outbox_id = ?")
      .get(outboxId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("POST /api/queue/create creates a qitem", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "do thing",
        priority: "urgent",
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { qitemId: string; state: string; priority: string };
    expect(data.state).toBe("pending");
    expect(data.priority).toBe("urgent");
  });

  // P21 I3 — create's sender is the transport header (X-OpenRig-Session), NEVER a body claim.
  // Adopt-drop window: a body sourceSession is tolerated ONLY when it EQUALS the transport identity.
  it("create — header absent + body sourceSession → delivers under the claimed actor, transition claimed:v1", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "bob@rig", destinationSession: "dst@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const t = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(t?.identity_provenance).toBe("claimed:v1");
  });

  it("create — header present + differing body sourceSession → wire supersedes (source alice@rig, transport:v1); 409 retired", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({ sourceSession: "bob@rig", destinationSession: "dst@rig", body: "hi" }), // superseded
    });
    expect(res.status).toBe(201);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const row = db
      .prepare("SELECT source_session FROM queue_items WHERE qitem_id = ?")
      .get(qitemId) as { source_session: string } | undefined;
    expect(row?.source_session).toBe("alice@rig");
    const t = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(t?.identity_provenance).toBe("transport:v1");
  });

  it("create — derives source_session from the transport header, never the body (equal claim tolerated)", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({ sourceSession: "alice@rig", destinationSession: "dst@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const row = db
      .prepare("SELECT source_session FROM queue_items WHERE qitem_id = ?")
      .get(qitemId) as { source_session: string } | undefined;
    expect(row?.source_session).toBe("alice@rig");
  });

  it("create — era-stamps the created transition transport:v1 (P21 §4 derived-era boundary)", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({ sourceSession: "alice@rig", destinationSession: "dst@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { qitemId } = (await res.json()) as { qitemId: string };
    // The 'created' transition's actor is transport-derived → stamped transport:v1 (absence = claimed-era).
    const row = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  // P21 I3 — update's actor is the transport header (X-OpenRig-Session), NEVER a body claim.
  async function createForUpdate(session: string): Promise<string> {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": session },
      body: JSON.stringify({ sourceSession: session, destinationSession: "worker@r", body: "x" }),
    });
    return ((await create.json()) as { qitemId: string }).qitemId;
  }

  it("update — header absent + body actorSession → delivers under the claimed actor, transition claimed:v1", async () => {
    const qitemId = await createForUpdate("a@r");
    const res = await app.request(`/api/queue/${qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorSession: "worker@r", state: "in-progress" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("worker@r");
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  it("update — header present + differing body actorSession → wire supersedes (actor worker@r, transport:v1); 409 retired", async () => {
    const qitemId = await createForUpdate("a@r");
    const res = await app.request(`/api/queue/${qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@r" },
      body: JSON.stringify({ actorSession: "mallory@r", state: "in-progress" }), // superseded by the wire identity
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("worker@r");
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("update — derives the transition actor from the transport header, never the body", async () => {
    const qitemId = await createForUpdate("a@r");
    const res = await app.request(`/api/queue/${qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@r" },
      body: JSON.stringify({ actorSession: "worker@r", state: "in-progress" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("worker@r");
    // P21 §4 era-stamp: a transport-derived actor is stamped transport:v1 (absence = claimed-era).
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  // P21 I3 — handoff / handoff-and-complete derive fromSession from the transport header, never body.
  async function createForHandoff(dest: string): Promise<string> {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@r" },
      body: JSON.stringify({ sourceSession: "orch@r", destinationSession: dest, body: "x" }),
    });
    return ((await create.json()) as { qitemId: string }).qitemId;
  }

  for (const verb of ["handoff", "handoff-and-complete"] as const) {
    it(`${verb} — header absent + body fromSession → delivers under the claimed actor, close transition claimed:v1`, async () => {
      const qitemId = await createForHandoff("b@r");
      const res = await app.request(`/api/queue/${qitemId}/${verb}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSession: "b@r", toSession: "c@r" }),
      });
      expect(res.status).toBe(201);
      const closed = db
        .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(qitemId) as { identity_provenance: string | null } | undefined;
      expect(closed?.identity_provenance).toBe("claimed:v1");
    });

    it(`${verb} — header present + differing body fromSession → wire supersedes (delivers, transport:v1); 409 retired`, async () => {
      const qitemId = await createForHandoff("b@r");
      const res = await app.request(`/api/queue/${qitemId}/${verb}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({ fromSession: "mallory@r", toSession: "c@r" }), // superseded by the wire identity
      });
      expect(res.status).toBe(201);
      const closed = db
        .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(qitemId) as { identity_provenance: string | null } | undefined;
      expect(closed?.identity_provenance).toBe("transport:v1");
    });

    it(`${verb} — derives fromSession from the header + era-stamps the close transition transport:v1`, async () => {
      const qitemId = await createForHandoff("b@r");
      const res = await app.request(`/api/queue/${qitemId}/${verb}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({ fromSession: "b@r", toSession: "c@r" }),
      });
      expect(res.status).toBe(201);
      // The source-close transition (handed-off/done) actor is transport-derived → transport:v1.
      const closed = db
        .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(qitemId) as { identity_provenance: string | null } | undefined;
      expect(closed?.identity_provenance).toBe("transport:v1");
    });
  }

  // #131 — under load the CLI's locality probe can time out and stamp THIS daemon's own self-host id
  // onto the sender (member@rig@<selfHostId>). The daemon must canonicalize that back to the bare local
  // seat before every actor compare/record; a FOREIGN host qualifier stays verbatim.
  describe("self-host-suffixed transport identity (#131)", () => {
    const SELF = "host-self-131";
    let priorSelfId: string | null;
    beforeEach(() => { priorSelfId = getSelfHostId(); setSelfHostId(SELF); });
    afterEach(() => setSelfHostId(priorSelfId));
    const post = (url: string, session: string, body: unknown) => app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": session },
      body: JSON.stringify(body),
    });
    const lastActor = (qitemId: string) => (db
      .prepare("SELECT actor_session FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string }).actor_session;

    it("claim — a self-host-suffixed claimant resolves to the local seat (was claim_destination_mismatch)", async () => {
      const qitemId = await createForHandoff("b@r");
      const res = await post(`/api/queue/${qitemId}/claim`, `b@r@${SELF}`, {});
      expect(res.status).toBe(200);
      expect(((await res.json()) as { state: string }).state).toBe("in-progress");
      expect(lastActor(qitemId)).toBe("b@r");
    });

    it("claim — a FOREIGN-host-suffixed claimant is preserved and still refused", async () => {
      const qitemId = await createForHandoff("b@r");
      const res = await post(`/api/queue/${qitemId}/claim`, "b@r@host-elsewhere", {});
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await res.json())).toContain("claim_destination_mismatch");
    });

    it("unclaim, update and handoff record the canonical local actor", async () => {
      const qitemId = await createAndClaim("b@r");
      expect((await post(`/api/queue/${qitemId}/unclaim`, `b@r@${SELF}`, {})).status).toBe(200);
      expect(lastActor(qitemId)).toBe("b@r");
      expect((await post(`/api/queue/${qitemId}/claim`, `b@r@${SELF}`, {})).status).toBe(200);
      expect((await post(`/api/queue/${qitemId}/update`, `b@r@${SELF}`, { transitionNote: "progress" })).status).toBe(200);
      expect(lastActor(qitemId)).toBe("b@r");
      const handoff = await post(`/api/queue/${qitemId}/handoff`, `b@r@${SELF}`, { toSession: "c@r", body: "next" });
      expect(handoff.status).toBeLessThan(300);
      const source = db.prepare("SELECT source_session FROM queue_items WHERE destination_session = 'c@r'").get() as { source_session: string };
      expect(source.source_session).toBe("b@r");
    });

    it("create — a self-host-suffixed sender is stored as the bare local source", async () => {
      const res = await post("/api/queue/create", `orch@r@${SELF}`, { destinationSession: "b@r", body: "x" });
      expect(res.status).toBeLessThan(300);
      const qitemId = ((await res.json()) as { qitemId: string }).qitemId;
      const row = db.prepare("SELECT source_session FROM queue_items WHERE qitem_id = ?").get(qitemId) as { source_session: string };
      expect(row.source_session).toBe("orch@r");
    });
  });

  // P21 I3 — claim/unclaim derive the claimant (destinationSession) from the transport header.
  // The repo still enforces you can only (un)claim an item assigned to your identity.
  async function createAndClaim(dest: string): Promise<string> {
    const qitemId = await createForHandoff(dest);
    await app.request(`/api/queue/${qitemId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": dest },
      body: JSON.stringify({ destinationSession: dest }),
    });
    return qitemId;
  }

  it("claim — header absent + body destinationSession → delivers under the claimed actor, transition claimed:v1", async () => {
    const qitemId = await createForHandoff("b@r");
    const res = await app.request(`/api/queue/${qitemId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "b@r" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("b@r");
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  it("claim — header present + differing body destinationSession → wire supersedes (claimant b@r, transport:v1); 409 retired", async () => {
    const qitemId = await createForHandoff("b@r");
    const res = await app.request(`/api/queue/${qitemId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({ destinationSession: "mallory@r" }), // superseded by the wire identity
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("b@r");
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("claim — derives the claimant from the header + era-stamps the transition transport:v1", async () => {
    const qitemId = await createForHandoff("b@r");
    const res = await app.request(`/api/queue/${qitemId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({ destinationSession: "b@r" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("b@r");
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("unclaim — header absent + body destinationSession → delivers under the claimed actor, transition claimed:v1", async () => {
    const qitemId = await createAndClaim("b@r");
    const res = await app.request(`/api/queue/${qitemId}/unclaim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "b@r" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("b@r");
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  it("unclaim — header present + differing body destinationSession → wire supersedes (b@r, transport:v1); 409 retired", async () => {
    const qitemId = await createAndClaim("b@r");
    const res = await app.request(`/api/queue/${qitemId}/unclaim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({ destinationSession: "mallory@r" }), // superseded by the wire identity
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("b@r");
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("unclaim — derives the claimant from the header + era-stamps the transition transport:v1", async () => {
    const qitemId = await createAndClaim("b@r");
    const res = await app.request(`/api/queue/${qitemId}/unclaim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({ destinationSession: "b@r" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("b@r");
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("POST /api/queue/:id/update with state=done WITHOUT closure_reason returns 400 with validReasons", async () => {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "x" }),
    });
    const item = (await create.json()) as { qitemId: string };

    const update = await app.request(`/api/queue/${item.qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({ actorSession: "b@r", state: "done" }),
    });
    expect(update.status).toBe(400);
    const data = (await update.json()) as { error: string; validReasons: string[] };
    expect(data.error).toBe("missing_closure_reason");
    expect(data.validReasons).toEqual(CLOSURE_REASONS);
  });

  it("POST /api/queue/:id/update accepts each valid closure reason", async () => {
    for (const reason of CLOSURE_REASONS) {
      const create = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: `for-${reason}` }),
      });
      const item = (await create.json()) as { qitemId: string };

      const requiresTarget = reason === "handed_off_to" || reason === "blocked_on" || reason === "escalation";
      const closureTarget = reason === "handed_off_to" ? "c@r" : "downstream-target";
      if (reason === "handed_off_to") await queueRepo.create({
        sourceSession: "b@r", destinationSession: closureTarget,
        body: "continue the work", chainOfRecord: [item.qitemId], nudge: false,
      });
      const update = await app.request(`/api/queue/${item.qitemId}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({
          actorSession: "b@r",
          state: "done",
          closureReason: reason,
          ...(requiresTarget ? { closureTarget } : {}),
        }),
      });
      expect(update.status).toBe(200);
      const data = (await update.json()) as { state: string; closureReason: string };
      expect(data.state).toBe("done");
      expect(data.closureReason).toBe(reason);
    }
  });

  it("POST /api/queue/:id/handoff returns closed + created in one transaction", async () => {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "x" }),
    });
    const item = (await create.json()) as { qitemId: string };

    const handoff = await app.request(`/api/queue/${item.qitemId}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" }, // P21 I3: handoff actor from the transport header
      body: JSON.stringify({ fromSession: "b@r", toSession: "c@r", transitionNote: "specialty" }),
    });
    expect(handoff.status).toBe(201);
    const data = (await handoff.json()) as {
      closed: { state: string; closureReason: string; handedOffTo: string };
      created: { state: string; destinationSession: string; handedOffFrom: string };
    };
    expect(data.closed.state).toBe("handed-off");
    expect(data.closed.closureReason).toBe("handed_off_to");
    expect(data.closed.handedOffTo).toBe("c@r");
    expect(data.created.state).toBe("pending");
    expect(data.created.destinationSession).toBe("c@r");
    expect(data.created.handedOffFrom).toBe(item.qitemId);
  });

  it("GET /api/queue/:id returns the qitem; transitions endpoint returns the log", async () => {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "x" }),
    });
    const item = (await create.json()) as { qitemId: string };

    const get = await app.request(`/api/queue/${item.qitemId}`);
    expect(get.status).toBe(200);

    const transitions = await app.request(`/api/queue/${item.qitemId}/transitions`);
    expect(transitions.status).toBe(200);
    const tlist = (await transitions.json()) as Array<{ state: string }>;
    expect(tlist).toHaveLength(1);
    expect(tlist[0]!.state).toBe("pending");
  });

  it("inbox drop / absorb / deny round-trip", async () => {
    const drop = await app.request("/api/queue/inbox/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" }, // P18: transport-derived sender
      body: JSON.stringify({
        destinationSession: "b@r",
        body: "async",
      }),
    });
    expect(drop.status).toBe(201);
    const entry = (await drop.json()) as { inboxId: string };

    const absorb = await app.request(`/api/queue/inbox/${entry.inboxId}/absorb`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" }, // P21 I3: receiver from the transport header
      body: JSON.stringify({ receiverSession: "b@r" }),
    });
    expect(absorb.status).toBe(200);
    const absorbed = (await absorb.json()) as { qitemId: string };
    expect(absorbed.qitemId).toMatch(/^qitem-/);

    // Second drop + deny path
    const drop2 = await app.request("/api/queue/inbox/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" }, // P18: transport-derived sender
      body: JSON.stringify({ destinationSession: "b@r", body: "skip" }),
    });
    const entry2 = (await drop2.json()) as { inboxId: string };
    const deny = await app.request(`/api/queue/inbox/${entry2.inboxId}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" }, // P21 I3: receiver from the transport header
      body: JSON.stringify({ receiverSession: "b@r", reason: "off-topic" }),
    });
    expect(deny.status).toBe(200);
  });

  it("outbox record + list round-trip", async () => {
    const record = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" }, // P21 I3: outbox sender from the transport header
      body: JSON.stringify({ senderSession: "a@r", destinationSession: "b@r", body: "fyi" }),
    });
    expect(record.status).toBe(201);

    const list = await app.request("/api/queue/outbox/list?senderSession=a@r");
    expect(list.status).toBe(200);
    const data = (await list.json()) as Array<{ body: string }>;
    expect(data).toHaveLength(1);
    expect(data[0]!.body).toBe("fyi");
  });

  it("queue, inbox and outbox list refuse only a non-numeric or unbindable limit (#586)", async () => {
    for (const body of ["one", "two", "three"]) {
      const res = await app.request("/api/queue/create", {
        method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({ destinationSession: "b@r", body, nudge: false }),
      });
      expect(res.status).toBe(201);
    }
    await expectLimitParsing(app, "/api/queue/list?destinationSession=b@r");
    await expectLimitParsing(app, "/api/queue/inbox/list?destinationSession=b@r");
    await expectLimitParsing(app, "/api/queue/outbox/list?senderSession=a@r");
  });

  it("GET /api/queue/list filters by destination + state", async () => {
    await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "1" }),
    });
    await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "c@r", body: "2" }),
    });
    const res = await app.request("/api/queue/list?destinationSession=b@r");
    const data = (await res.json()) as unknown[];
    expect(data).toHaveLength(1);
  });

  // OPR.0.3.2.20 — `?attention=1` filter for the For You priority
  // windowing slice. Returns OPEN attention-class qitems (the durable
  // source of truth) so the UI Action-required + Approval lenses don't
  // depend on the lossy ephemeral event FIFO. HG-4 verified against
  // the mission-control read layer's canonical attention semantics:
  //   - approval class: tier === "human-gate"
  //   - action-required class: destinationSession is human-*@kernel|host
  //   - open state: pending | in-progress | blocked
  describe("OPR.0.3.2.20 GET /api/queue/list?attention=1 — open attention-class items", () => {
    it("tier-only agent rows do not create a human approval obligation", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "b@r",
          body: "approve please",
          tier: "human-gate",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      expect(res.status).toBe(200);
      const data = (await res.json()) as Array<{ tier: string | null; body: string }>;
      expect(data).toHaveLength(0);
    });

    it("HG-4 positive (action-required class): destination=human-foo@kernel open qitem is returned", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-bob@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "needs human",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as Array<{ destinationSession: string }>;
      expect(data).toHaveLength(1);
      expect(data[0]!.destinationSession).toBe("human-bob@kernel");
    });

    it("HG-4 positive: destination=human@host (bare human prefix) open qitem is returned", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human@host",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "needs human attention",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as unknown[];
      expect(data).toHaveLength(1);
    });

    it("HG-4 negative: routine pending qitem (non-attention tier + non-human destination) is NOT returned", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "b@r",
          body: "routine work",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as unknown[];
      expect(data).toHaveLength(0);
    });

    it("HG-4 negative: closed attention qitem (state=done) is NOT returned", async () => {
      const create = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-x@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "done already",
        }),
      });
      const item = (await create.json()) as { qitemId: string };
      await app.request(`/api/queue/${item.qitemId}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "human-x@kernel" },
        body: JSON.stringify({
          actorSession: "human-x@kernel",
          state: "done",
          closureReason: "no-follow-on",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as unknown[];
      expect(data).toHaveLength(0);
    });

    it("HG-5/HG-7 sane bound: ?attention=1&limit=N caps the result", async () => {
      // Seed 5 attention-class qitems
      for (let i = 0; i < 5; i++) {
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
          body: JSON.stringify({
            sourceSession: "a@r",
            destinationSession: `human-${i}@kernel`,
            body: `attn ${i}`,
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1&limit=3");
      const data = (await res.json()) as unknown[];
      expect(data.length).toBeLessThanOrEqual(3);
    });

    it("HG-2 (the headline): attention-class items survive >100 unrelated routine qitems being created (queue is durable source)", async () => {
      // Seed ONE attention-class item first
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-founder@external",
          body: "approve me",
          tier: "human-gate",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
        }),
      });
      // Then create >100 routine qitems (no attention markers); these
      // would saturate any FIFO window in the UI but the queue is the
      // durable source — the attention filter must still surface the
      // human-gate item.
      for (let i = 0; i < 110; i++) {
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": `routine-${i}@r` },
          body: JSON.stringify({
            sourceSession: `routine-${i}@r`,
            destinationSession: `other-${i}@r`,
            body: `noise ${i}`,
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as Array<{ tier: string | null }>;
      // Attention item still present despite 110 routine qitems written
      // after it.
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data.some((q) => q.tier === "human-gate")).toBe(true);
    });

    // Guard re-verify-2 (qitem-20260518192210) BLOCKER-1: the prior
    // forward-fix dropped destinationSession/sourceSession/targetRepo
    // composition. The fix routes those params through listAttention
    // into the SQL WHERE so scoped attention queries return only the
    // matching attention items.

    it("BLOCKER re-verify-2: attention=1 + destinationSession=X returns only X-scoped attention items", async () => {
      // Seed 2 attention items at different destinations.
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor@r1" },
        body: JSON.stringify({
          sourceSession: "advisor@r1",
          destinationSession: "human-alice@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "for alice",
        }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor@r2" },
        body: JSON.stringify({
          sourceSession: "advisor@r2",
          destinationSession: "human-bob@kernel",
          body: "for bob",
          tier: "human-gate",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
        }),
      });
      // Also create a non-attention routine qitem destined to alice;
      // it must not appear.
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor@r1" },
        body: JSON.stringify({
          sourceSession: "advisor@r1",
          destinationSession: "human-alice@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          state: "pending",
          body: "another for alice",
        }),
      });

      const res = await app.request("/api/queue/list?attention=1&destinationSession=human-alice@kernel");
      const data = (await res.json()) as Array<{ destinationSession: string; body: string }>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      for (const item of data) {
        expect(item.destinationSession).toBe("human-alice@kernel");
      }
      // None of them should be for bob.
      expect(data.some((q) => q.destinationSession === "human-bob@kernel")).toBe(false);
    });

    it("BLOCKER re-verify-2: attention=1 + sourceSession=X returns only X-sourced attention items", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor-a@r" },
        body: JSON.stringify({
          sourceSession: "advisor-a@r",
          destinationSession: "human-x@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "from advisor-a",
        }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor-b@r" },
        body: JSON.stringify({
          sourceSession: "advisor-b@r",
          destinationSession: "human-y@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "from advisor-b",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1&sourceSession=advisor-a@r");
      const data = (await res.json()) as Array<{ sourceSession: string }>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      for (const item of data) {
        expect(item.sourceSession).toBe("advisor-a@r");
      }
    });

    it("BLOCKER re-verify-2: attention=1 unscoped still returns the global attention set (composition is OPT-IN, not required)", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-x@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "global x",
        }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({
          sourceSession: "b@r",
          destinationSession: "human-y@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "global y",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as unknown[];
      expect(data.length).toBeGreaterThanOrEqual(2);
    });

    // Guard re-verify BLOCKER 1 (qitem-20260518190827): the prior
    // fetch-then-filter approach (ATTENTION_FETCH_BOUND=1000 then
    // JS filter) would have hidden an attention item behind 1001+
    // newer routine open qitems. The fix pushes the attention
    // predicate INTO SQL so the LIMIT applies AFTER attention
    // filtering. This test scales the routine churn well past the
    // old ATTENTION_FETCH_BOUND to prove window-independence by
    // construction.
    // Guard re-verify-3 (qitem-20260518193005) BLOCKER 1: SQL LIKE
    // was a superset of the regex. Malformed rows like
    // `destination_session='human-@kernel'` (empty name segment)
    // match LIKE `human-%@kernel` but FAIL the strict regex. >LIMIT
    // such rows could fill the SQL window pre-JS-filter and hide
    // valid attention items behind them.
    //
    // Fix: SQLite function `is_human_seat_session` evaluates the
    // exact regex in SQL — malformed rows are rejected BEFORE LIMIT.
    it("BLOCKER re-verify-3: malformed superset rows ('human-@kernel') do NOT evict valid attention items", async () => {
      // Seed 1 valid attention item.
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor@r" },
        body: JSON.stringify({
          sourceSession: "advisor@r",
          destinationSession: "human-alice@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "valid attention",
        }),
      });
      // Seed 1100 malformed rows that match LIKE 'human-%@kernel' or
      // similar but FAIL the strict regex (empty name segment;
      // forbidden chars). Mix forms to ensure no single LIKE branch
      // is the leak.
      for (let i = 0; i < 1100; i++) {
        const variant = i % 4;
        const dest = variant === 0
          ? "human-@kernel"          // empty segment between hyphen and @
          : variant === 1
            ? "human- @kernel"       // space (forbidden char) — would match LIKE 'human-%@kernel'
            : variant === 2
              ? "human-x:@kernel"    // colon (forbidden char)
              : "human-x/@kernel";   // slash (forbidden char)
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": `garbage-${i}@r` },
          body: JSON.stringify({
            sourceSession: `garbage-${i}@r`,
            destinationSession: dest,
            body: `malformed ${i}`,
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1&limit=100");
      const data = (await res.json()) as Array<{ destinationSession: string; body: string }>;
      // Valid item must surface — it is the ONLY row matching the
      // strict regex. Malformed rows must NOT appear.
      const valid = data.find((q) => q.destinationSession === "human-alice@kernel");
      expect(valid).toBeDefined();
      expect(valid!.body).toBe("valid attention");
      // No malformed rows in the result set.
      for (const q of data) {
        expect(q.destinationSession).not.toBe("human-@kernel");
        expect(q.destinationSession).not.toContain(" ");
        expect(q.destinationSession).not.toContain(":");
        expect(q.destinationSession).not.toContain("/");
      }
    });

    // Guard re-verify-3 (qitem-20260518193005) BLOCKER 2: targetRepo
    // composition was implemented in the previous forward-fix but
    // never pinned by a test. This discriminator proves
    // attention=1&targetRepo=X scopes the result + composes with the
    // attention predicate at the SQL stage (LIMIT applies AFTER).
    it("BLOCKER re-verify-3: attention=1 + targetRepo=X scopes attention to repo X", async () => {
      // Seed attention items in different repos.
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-bob@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "for repo-a",
          targetRepo: "repo-a",
        }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-carol@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "for repo-b",
          targetRepo: "repo-b",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1&targetRepo=repo-a");
      const data = (await res.json()) as Array<{ targetRepo: string | null; body: string }>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      for (const item of data) {
        expect(item.targetRepo).toBe("repo-a");
      }
    });

    it("BLOCKER re-verify-3: targetRepo composition preserves the >1100-routine-open durability guarantee", async () => {
      // Seed 1 attention item with targetRepo=repo-X.
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-z@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "repo-X attention",
          targetRepo: "repo-X",
        }),
      });
      // 1100 newer routine open qitems in OTHER repos that would
      // otherwise dominate the window if the targetRepo predicate
      // were applied post-LIMIT.
      for (let i = 0; i < 1100; i++) {
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": `routine-${i}@r` },
          body: JSON.stringify({
            sourceSession: `routine-${i}@r`,
            destinationSession: `other-${i}@r`,
            body: `noise ${i}`,
            targetRepo: "repo-other",
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1&targetRepo=repo-X");
      const data = (await res.json()) as Array<{ targetRepo: string | null; body: string }>;
      expect(data.length).toBe(1);
      expect(data[0]!.targetRepo).toBe("repo-X");
      expect(data[0]!.body).toBe("repo-X attention");
    });

    it("BLOCKER-1: attention item surfaces even when >1100 newer routine OPEN qitems exist (SQL predicate pushdown)", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "old@r" },
        body: JSON.stringify({
          sourceSession: "old@r",
          destinationSession: "human-founder@external",
          body: "approve me — oldest",
          tier: "human-gate",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
        }),
      });
      // 1100 routine OPEN qitems land AFTER the attention item. They
      // each get a newer ts_created than the attention item; a
      // fetch-then-filter with LIMIT 1000 would never return the
      // attention item.
      for (let i = 0; i < 1100; i++) {
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": `routine-${i}@r` },
          body: JSON.stringify({
            sourceSession: `routine-${i}@r`,
            destinationSession: `other-${i}@r`,
            body: `noise ${i}`,
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as Array<{ tier: string | null; body: string }>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      const found = data.find((q) => q.tier === "human-gate");
      expect(found).toBeDefined();
      expect(found!.body).toContain("oldest");
    });
  });

  // ---- PL-004 Phase A revision (R1) route tests ----

  describe("R1 cross-rig validation rejection", () => {
    let strictDb: Database.Database;
    let strictBus: EventBus;
    let strictRepo: QueueRepository;
    let strictApp: Hono;

    beforeEach(() => {
      strictDb = createDb();
      migrate(strictDb, [
        coreSchema,
        eventsSchema,
        streamItemsSchema, // 067's stream_items ALTER needs its base table present
        queueItemsSchema,
        queueTransitionsSchema,
        inboxEntriesSchema,
        outboxEntriesSchema,
        i3IdentityProvenanceSchema, // P21 §4 era-stamp column (last: needs all 4 tables)
      ]);
      strictBus = new EventBus(strictDb);
      strictRepo = new QueueRepository(strictDb, strictBus, {
        // Topology-backed validator stub: only `@known-rig` is recognized.
        validateRig: (s) => /^[^@]+@known-rig$/.test(s),
      });
      const strictInbox = new InboxHandler(strictDb, strictBus, strictRepo);
      const strictOutbox = new OutboxHandler(strictDb);
      strictRepo.attachOutbox(strictOutbox); // W1 MF2
      strictApp = buildApp({
        eventBus: strictBus,
        queueRepo: strictRepo,
        inboxHandler: strictInbox,
        outboxHandler: strictOutbox,
      });
    });

    afterEach(() => strictDb.close());

    it("POST /api/queue/create rejects unknown rig with 400 + structured error", async () => {
      const res = await strictApp.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@known-rig" },
        body: JSON.stringify({
          sourceSession: "alice@known-rig",
          destinationSession: "bob@phantom-rig",
          body: "x",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("unknown_destination_rig");
      expect(body.message).toMatch(/phantom-rig/);
    });

    it("POST /api/queue/create accepts known rig with 201", async () => {
      const res = await strictApp.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@known-rig" },
        body: JSON.stringify({
          sourceSession: "alice@known-rig",
          destinationSession: "bob@known-rig",
          body: "ok",
        }),
      });
      expect(res.status).toBe(201);
    });

    it("POST /api/queue/:id/handoff rejects unknown destination rig", async () => {
      const created = await strictApp.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@known-rig" },
        body: JSON.stringify({
          sourceSession: "alice@known-rig",
          destinationSession: "bob@known-rig",
          body: "x",
        }),
      });
      const item = (await created.json()) as { qitemId: string };
      const res = await strictApp.request(`/api/queue/${item.qitemId}/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "bob@known-rig" }, // P21 I3: handoff actor from the transport header
        body: JSON.stringify({
          fromSession: "bob@known-rig",
          toSession: "carol@phantom-rig",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unknown_destination_rig");
    });

    it("POST /api/queue/:id/handoff-and-complete rejects unknown destination rig", async () => {
      const created = await strictApp.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@known-rig" },
        body: JSON.stringify({
          sourceSession: "alice@known-rig",
          destinationSession: "bob@known-rig",
          body: "x",
        }),
      });
      const item = (await created.json()) as { qitemId: string };
      const res = await strictApp.request(`/api/queue/${item.qitemId}/handoff-and-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "bob@known-rig" }, // P21 I3: handoff actor from the transport header
        body: JSON.stringify({
          fromSession: "bob@known-rig",
          toSession: "carol@phantom-rig",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unknown_destination_rig");
    });
  });

  describe("R1 handoff-and-complete route", () => {
    it("POST /api/queue/:id/handoff-and-complete closes source as done + creates new", async () => {
      const created = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "bob@r", body: "x" }),
      });
      const item = (await created.json()) as { qitemId: string };
      const res = await app.request(`/api/queue/${item.qitemId}/handoff-and-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "bob@r" }, // P21 I3: handoff actor from the transport header
        body: JSON.stringify({
          fromSession: "bob@r",
          toSession: "carol@r",
          body: "carol's piece",
        }),
      });
      expect(res.status).toBe(201);
      const result = (await res.json()) as {
        closed: { state: string; closureReason: string; handedOffTo: string };
        created: { state: string; handedOffFrom: string; destinationSession: string; body: string };
      };
      expect(result.closed.state).toBe("done");
      expect(result.closed.closureReason).toBe("handed_off_to");
      expect(result.closed.handedOffTo).toBe("carol@r");
      expect(result.created.state).toBe("pending");
      expect(result.created.handedOffFrom).toBe(item.qitemId);
      expect(result.created.body).toBe("carol's piece");
    });

    it("POST /api/queue/:id/handoff-and-complete returns 400 on missing toSession (fromSession is header-derived; missing-sender is the 401 path)", async () => {
      const res = await app.request("/api/queue/some-id/handoff-and-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "bob@r" },
        body: JSON.stringify({ fromSession: "bob@r" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/toSession/);
    });
  });

  describe("R1 whoami route", () => {
    it("GET /api/queue/whoami returns counts + recent for the session", async () => {
      // Seed: 2 pending + 1 in-progress for bob; 1 unrelated for carol.
      const a = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "bob@r", body: "1" }),
      });
      const itemA = (await a.json()) as { qitemId: string };
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "bob@r", body: "2" }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "carol@r", body: "3" }),
      });
      await app.request(`/api/queue/${itemA.qitemId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "bob@r" }, // P21 I3: claimant from the transport header
        body: JSON.stringify({ destinationSession: "bob@r" }),
      });

      const res = await app.request("/api/queue/whoami?session=bob@r");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        session: string;
        asDestination: { pending: number; inProgress: number; recent: unknown[] };
        asSource: { total: number };
      };
      expect(body.session).toBe("bob@r");
      expect(body.asDestination.pending).toBe(1);
      expect(body.asDestination.inProgress).toBe(1);
      expect(body.asDestination.recent).toHaveLength(2);
      expect(body.asSource.total).toBe(0);
    });

    // OPR.0.7.0.12 — work candidates ride only an explicit request, and the read writes nothing.
    it("GET /api/queue/whoami adds workCandidates only with candidates=1, read-only", async () => {
      const created = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "bob@r", body: "x", tags: ["mission:m"] }),
      });
      expect(created.status).toBe(201);
      const counts = () => ({
        items: (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n,
        transitions: (db.prepare("SELECT COUNT(*) AS n FROM queue_transitions").get() as { n: number }).n,
      });
      const before = counts();
      const plain = (await (await app.request("/api/queue/whoami?session=bob@r")).json()) as Record<string, unknown>;
      expect(plain).not.toHaveProperty("workCandidates");
      const asked = await app.request("/api/queue/whoami?session=bob@r&candidates=1");
      expect(asked.status).toBe(200);
      const body = (await asked.json()) as { workCandidates: { next: Array<{ missions: string[] }>; candidates: unknown[]; held: unknown[] } };
      expect(body.workCandidates.next).toEqual([expect.objectContaining({ missions: ["m"] })]);
      expect(body.workCandidates.candidates).toEqual([]);
      expect(counts()).toEqual(before);
    });

    it("GET /api/queue/whoami returns 400 without session query param", async () => {
      const res = await app.request("/api/queue/whoami");
      expect(res.status).toBe(400);
    });

    it("GET /api/queue/whoami returns 400 for a recentLimit that is not a number", async () => {
      const res = await app.request("/api/queue/whoami?session=bob@r&recentLimit=abc");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "recentLimit must be a number" });
      // Everything parseInt reads keeps working as before, clamped by whoami.
      for (const value of ["5", "1.5", "2x", "-1"]) {
        const ok = await app.request(`/api/queue/whoami?session=bob@r&recentLimit=${value}`);
        expect(ok.status, value).toBe(200);
      }
    });
  });

  describe("R1 SSE route — live GET reaches the SSE handler (not shadowed by /:qitemId)", () => {
    // Live GET tests per QA finding: HEAD comparison was inadequate because
    // dynamic route shadowing (/:qitemId catching `sse` and `watch` as ids)
    // returns 404 with `qitem_not_found` instead of the SSE handler.
    // Real GET that asserts content-type: text/event-stream proves the
    // SSE handler is reached. We cancel the response body to release the
    // long-lived stream.

    it("GET /api/queue/sse returns 200 + content-type: text/event-stream (handler reached)", async () => {
      const res = await app.request("/api/queue/sse");
      try {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      } finally {
        await res.body?.cancel();
      }
    });

    it("GET /api/queue/watch returns 200 + content-type: text/event-stream (handler reached)", async () => {
      const res = await app.request("/api/queue/watch");
      try {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      } finally {
        await res.body?.cancel();
      }
    });

    it("GET /api/queue/sse does NOT return qitem_not_found (route-order regression guard)", async () => {
      const res = await app.request("/api/queue/sse");
      try {
        // If /:qitemId catches `sse` as an id, it returns 404 JSON with
        // {"error":"qitem_not_found"}. This must never happen.
        expect(res.status).not.toBe(404);
        const ct = res.headers.get("content-type") ?? "";
        expect(ct).not.toContain("application/json");
      } finally {
        await res.body?.cancel();
      }
    });
  });
});
