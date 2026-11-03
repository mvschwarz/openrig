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
    repo = new QueueRepository(db, bus, { validateRig: () => true, resolveOccupantGeneration: () => "estimate-generation" });
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
});
