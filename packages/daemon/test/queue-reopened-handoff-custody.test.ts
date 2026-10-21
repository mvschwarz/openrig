import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { deriveCrossHostSuccessorId, QueueRepository } from "../src/domain/queue-repository.js";
import { runStuckSweep } from "../src/domain/queue-stuck-sweep.js";
import { queueRoutes } from "../src/routes/queue.js";

describe("custody diagnostics after reopening an atomic handoff", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    repo.attachOutbox(new OutboxHandler(db));
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("queueRepo" as never, repo);
      c.set("eventBus" as never, bus);
      await next();
    });
    app.route("/api/queue", queueRoutes());
  });
  afterEach(() => db.close());

  async function post(id: string, verb: string, body: Record<string, unknown>) {
    const response = await app.request(`/api/queue/${id}/${verb}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@r" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(verb === "handoff" ? 201 : 200);
    return response.json();
  }

  it("keeps the internal deterministic remote handoff quiet without local successor lookups", async () => {
    const source = await repo.create({ sourceSession: "sender@r", destinationSession: "worker@r", body: "work", nudge: false });
    const target = `${deriveCrossHostSuccessorId(source.qitemId, "next@r", "remote")}@remote`;
    repo.closeCrossHostHandoffSource({ qitemId: source.qitemId, fromSession: "worker@r", toSession: "next@r",
      closureTarget: target, terminalState: "handed-off" });
    const prepare = vi.spyOn(db, "prepare");
    try {
      expect(repo.getById(source.qitemId)?.handoffAdvisory).toBeUndefined();
      const sweep = await runStuckSweep({ db, queueRepo: repo, resolveOrchestrator: () => null,
        isRegisteredHost: () => false, log: () => {} });
      expect(sweep.outcome).toBe("clean");
      expect(prepare.mock.calls.some(([sql]) => sql.includes("FROM queue_items s"))).toBe(false);
    } finally { prepare.mockRestore(); }
  });

  it.each((["done", "handed-off"] as const).flatMap(state =>
    (["same", "missing", "linked", "verified-remote"] as const).map(custody => ({ state, custody }))))(
    "checks the current target after a generic $state close ($custody)", async ({ state, custody }) => {
      const source = await repo.create({ sourceSession: "sender@r", destinationSession: "worker@r", body: "work", nudge: false });
      await post(source.qitemId, "handoff", { toSession: "prior@r", nudge: false });
      await post(source.qitemId, "update", { state: "in-progress", reopen: true, transitionNote: "another round" });
      const target = custody === "same" ? "prior@r" : custody === "verified-remote" ? "qitem-successor@remote" : "next@r";
      if (custody === "linked") await repo.create({ sourceSession: "worker@r", destinationSession: target,
        body: "follow-on", chainOfRecord: [source.qitemId], nudge: false });
      const before = repo.list().length;
      const closed = await post(source.qitemId, "update", { state, closureReason: "handed_off_to", closureTarget: target });
      expect(closed).toMatchObject({ state, closureTarget: target, handedOffTo: "prior@r" });
      expect(Boolean(closed.handoffAdvisory)).toBe(custody === "missing" || custody === "verified-remote");
      expect(repo.list()).toHaveLength(before);
      if (custody === "verified-remote") await post(source.qitemId, "update", {
        transitionNote: `custody-verified: ${target} synthetic remote verification disposition`,
      });
      const sweep = () => runStuckSweep({ db, queueRepo: repo, resolveOrchestrator: () => null,
        isRegisteredHost: () => false, unclaimedAgeMinutes: 60, log: () => {} });
      const first = await sweep();
      expect(first.outcome).toBe(custody === "missing" ? "findings" : "clean");
      expect(first.findings.filter(f => f.qitemId === source.qitemId)).toHaveLength(custody === "missing" ? 1 : 0);
      await sweep();
      expect(repo.list()).toHaveLength(before + (custody === "missing" ? 1 : 0));
      expect(repo.list({ destinationSession: "next@r" })).toHaveLength(custody === "linked" ? 1 : 0);
    },
  );
});
