import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { runStuckSweep } from "../src/domain/queue-stuck-sweep.js";
import { queueRoutes } from "../src/routes/queue.js";

describe("accepted queue re-estimates (#2453)", () => {
  let db: Database.Database, repo: QueueRepository, app: Hono;
  const later = "2026-11-03T13:00:00.000Z";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T12:00:00.000Z"));
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db), outbox = new OutboxHandler(db);
    repo = new QueueRepository(db, bus, {
      validateRig: () => true, resolveOccupantGeneration: () => "estimate-generation",
      loadHumanRegistry: () => ({ ok: true, entities: [] }),
    });
    repo.attachOutbox(outbox);
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("queueRepo" as never, repo); c.set("eventBus" as never, bus); c.set("outboxHandler" as never, outbox);
      await next();
    });
    app.route("/api/queue", queueRoutes());
  });
  afterEach(() => { db.close(); vi.useRealTimers(); });

  async function overdue() {
    const row = await repo.create({ sourceSession: "coordinator@fixture", destinationSession: "worker@fixture", body: "work", tier: "fast", nudge: false });
    repo.claim({ qitemId: row.qitemId, destinationSession: row.destinationSession });
    db.prepare("UPDATE queue_items SET closure_required_at = ? WHERE qitem_id = ?").run("2026-11-03T11:59:00.000Z", row.qitemId);
    return repo.getById(row.qitemId)!;
  }
  const claim = (id: string) => db.prepare("SELECT state, claimed_at, claimed_by_generation_uuid FROM queue_items WHERE qitem_id = ?").get(id);
  const post = (id: string, body: Record<string, unknown>) => app.request(`/api/queue/${id}/update`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "coordinator@fixture" }, body: JSON.stringify(body),
  });
  const accept = (id: string) => post(id, { closureRequiredAt: later, actorSession: "body-claim@fixture", transitionNote: "Accepted an extra hour for the remaining work" });
  const sweep = () => runStuckSweep({
    db, queueRepo: repo, now: new Date(), unclaimedAgeMinutes: 60,
    resolveOrchestrator: () => null, sessionConfirmedMissing: () => false,
    resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null, isRegisteredHost: () => false, log: () => {},
  });

  it("accepts a deadline through the real update route with old/new/actor provenance and the original claim", async () => {
    const row = await overdue(), before = claim(row.qitemId);
    const response = await accept(row.qitemId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ closureRequiredAt: later });
    expect(claim(row.qitemId)).toEqual(before);
    const receipt = repo.transitionLog.listForQitem(row.qitemId).at(-1)!;
    expect(receipt).toMatchObject({ state: "in-progress", actorSession: "coordinator@fixture", identityProvenance: "transport:v1" });
    expect(receipt.transitionNote).toContain(row.closureRequiredAt);
    expect(receipt.transitionNote).toContain(later);
    expect(receipt.transitionNote).toContain("Accepted an extra hour");
  });

  it("stops reporting overdue until the accepted deadline actually expires", async () => {
    const row = await overdue();
    expect(repo.findOverdue().map(r => r.qitemId)).toContain(row.qitemId);
    expect((await accept(row.qitemId)).status).toBe(200);
    expect(repo.findOverdue().map(r => r.qitemId)).not.toContain(row.qitemId);
    expect((await sweep()).findings.filter(f => f.qitemId === row.qitemId && f.kind === "overdue-claim")).toEqual([]);
    vi.setSystemTime(new Date(Date.parse(later) + 1));
    expect(repo.findOverdue().map(r => r.qitemId)).toContain(row.qitemId);
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ qitemId: row.qitemId, kind: "overdue-claim", action: "created" }));
  });

  it("closes an already-open overdue finding on the next sweep without closing or reclaiming the work", async () => {
    const row = await overdue(), before = claim(row.qitemId);
    const initial = await sweep();
    const finding = initial.findings.find(f => f.qitemId === row.qitemId && f.kind === "overdue-claim")!;
    expect(finding.action).toBe("created");
    const owner = repo.getById(finding.findingQitemId)!;
    expect((await accept(row.qitemId)).status).toBe(200);
    expect((await sweep()).findings).toContainEqual({ ...finding, action: "closed" });
    expect(repo.getById(finding.findingQitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on", sourceSession: owner.sourceSession, destinationSession: owner.destinationSession });
    expect(claim(row.qitemId)).toEqual(before);
    vi.setSystemTime(new Date(Date.parse(later) + 1));
    const expired = (await sweep()).findings.find(f => f.qitemId === row.qitemId && f.kind === "overdue-claim")!;
    expect(expired.action).toBe("created");
    expect(expired.findingQitemId).not.toBe(finding.findingQitemId);
    expect(claim(row.qitemId)).toEqual(before);
  });

  it("leaves an unrelated overdue sibling reportable", async () => {
    const row = await overdue(), sibling = await overdue();
    expect((await accept(row.qitemId)).status).toBe(200);
    const findings = (await sweep()).findings.filter(f => f.kind === "overdue-claim");
    expect(findings.some(f => f.qitemId === sibling.qitemId)).toBe(true);
    expect(findings.some(f => f.qitemId === row.qitemId)).toBe(false);
    expect(repo.getById(sibling.qitemId)?.closureRequiredAt).toBe(sibling.closureRequiredAt);
  });

  it("does not interpret a prose ETA or an ordinary note as an accepted deadline", async () => {
    const row = await overdue(), before = claim(row.qitemId);
    expect((await post(row.qitemId, { transitionNote: `Accepted ETA ${later}, still working` })).status).toBe(200);
    expect(repo.getById(row.qitemId)?.closureRequiredAt).toBe(row.closureRequiredAt);
    expect(repo.findOverdue().map(r => r.qitemId)).toContain(row.qitemId);
    expect(claim(row.qitemId)).toEqual(before);
  });

  it("can add an estimate to a claim without a tier, without requiring a note or resetting its generation", async () => {
    const row = await repo.create({ sourceSession: "coordinator@fixture", destinationSession: "worker@fixture", body: "untimed", nudge: false });
    repo.claim({ qitemId: row.qitemId, destinationSession: row.destinationSession });
    const before = claim(row.qitemId);
    expect(repo.getById(row.qitemId)?.closureRequiredAt).toBeNull();
    expect((await post(row.qitemId, { state: "in-progress", closureRequiredAt: "2026-11-03T14:00:00+01:00" })).status).toBe(200);
    expect(repo.getById(row.qitemId)?.closureRequiredAt).toBe(later);
    expect(claim(row.qitemId)).toEqual(before);
    expect(repo.transitionLog.listForQitem(row.qitemId).at(-1)?.transitionNote).toContain(`(none) -> ${later}; accepted by coordinator@fixture`);
  });

  it.each(["not-a-time", null, 123])("rejects an unpersistable deadline %s without changing the row or ledger", async closureRequiredAt => {
    const row = await overdue(), count = repo.transitionLog.listForQitem(row.qitemId).length;
    expect((await post(row.qitemId, { closureRequiredAt, transitionNote: "request" })).status).toBe(400);
    expect(repo.getById(row.qitemId)).toEqual(row);
    expect(repo.transitionLog.listForQitem(row.qitemId)).toHaveLength(count);
  });

  it("does not combine re-estimation with closing work or silently set a pending row's deadline", async () => {
    const row = await overdue();
    expect((await post(row.qitemId, { closureRequiredAt: later, state: "done", closureReason: "no-follow-on" })).status).toBe(409);
    expect(repo.getById(row.qitemId)).toEqual(row);
    const pending = await repo.create({ sourceSession: "coordinator@fixture", destinationSession: "worker@fixture", body: "pending", nudge: false });
    expect((await accept(pending.qitemId)).status).toBe(409);
    expect(repo.getById(pending.qitemId)).toEqual(pending);
  });

  it("rolls back the deadline when its acceptance receipt cannot be appended", async () => {
    const row = await overdue(), count = repo.transitionLog.listForQitem(row.qitemId).length;
    const append = vi.spyOn(repo.transitionLog, "append").mockImplementationOnce(() => { throw new Error("fixture receipt unavailable"); });
    try {
      expect(() => repo.update({ qitemId: row.qitemId, actorSession: "coordinator@fixture", closureRequiredAt: later })).toThrow("fixture receipt unavailable");
    } finally { append.mockRestore(); }
    expect(repo.getById(row.qitemId)).toEqual(row);
    expect(repo.transitionLog.listForQitem(row.qitemId)).toHaveLength(count);
  });
});
