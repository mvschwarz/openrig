import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { deriveCrossHostSuccessorId, matchesRecordedHandoffTarget, QueueRepository } from "../src/domain/queue-repository.js";
import { runStuckSweep } from "../src/domain/queue-stuck-sweep.js";
import { queueRoutes } from "../src/routes/queue.js";

describe("recorded legacy cross-host custody", () => {
  const databases: ReturnType<typeof createDb>[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  function harness(remote?: Hono) {
    const db = createDb();
    databases.push(db);
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    const repo = new QueueRepository(db, bus, { validateRig: () => true });
    repo.attachOutbox(new OutboxHandler(db));
    const app = new Hono();
    app.use("*", async (c, next) => {
      const set = c.set.bind(c) as (key: string, value: unknown) => void;
      set("queueRepo", repo);
      set("eventBus", bus);
      set("hostRegistryLoader", () => ({ ok: true, registry: {
        hosts: [{ id: "remote", transport: "http", url: "http://remote.invalid" }],
      } }));
      if (remote) set("remoteFetchImpl", (url: string, init: RequestInit) => remote.request(new URL(url).pathname, init));
      await next();
    });
    app.route("/api/queue", queueRoutes());
    const sweep = () => runStuckSweep({ db, queueRepo: repo, resolveOrchestrator: () => null,
      isRegisteredHost: () => true, unclaimedAgeMinutes: 60, log: () => {} });
    return { repo, app, sweep };
  }

  async function post(app: Hono, id: string, verb: string, body: Record<string, unknown>) {
    const response = await app.request(`/api/queue/${id}/${verb}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@r" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(verb === "handoff" ? 201 : 200);
    return response.json();
  }

  async function seed(repo: QueueRepository, recorded = true) {
    const source = await repo.create({ sourceSession: "sender@r", destinationSession: "worker@r", body: "work", nudge: false });
    if (recorded) repo.closeCrossHostHandoffSource({ qitemId: source.qitemId, fromSession: "worker@r",
      toSession: "prior@r", closureTarget: "prior@r@remote", terminalState: "handed-off" });
    return source.qitemId;
  }

  it.each(["advisory", "sweep"])("keeps a successful repeated legacy handoff quiet (%s)", async check => {
    const remote = harness();
    const local = harness(remote.app);
    const id = await seed(local.repo);
    for (let attempt = 0; attempt < 2; attempt++) {
      const receipt = await post(local.app, id, "handoff", { toSession: "prior@r", hostId: "remote", nudge: false });
      expect(receipt.closed).toMatchObject({ state: "handed-off", handedOffTo: "prior@r", closureTarget: "prior@r@remote" });
      expect(receipt.created.qitemId).toBe(deriveCrossHostSuccessorId(id, "prior@r", "remote"));
      expect(remote.repo.getById(receipt.created.qitemId)).toMatchObject({ destinationSession: "prior@r", chainOfRecord: [id] });
      if (check === "advisory") expect(receipt.closed.handoffAdvisory).toBeUndefined();
    }
    expect(remote.repo.list()).toHaveLength(1);
    const first = await local.sweep();
    const second = await local.sweep();
    expect(first.findings.filter(f => f.qitemId === id)).toHaveLength(0);
    expect(second.findings.filter(f => f.qitemId === id)).toHaveLength(0);
    expect(local.repo.list()).toHaveLength(1);
  });

  it.each(["next@r", "next@r@remote", "prior-extra@r@remote"])("reports a changed target after reopening: %s", async target => {
    const local = harness();
    const id = await seed(local.repo);
    await post(local.app, id, "update", { state: "in-progress", reopen: true, transitionNote: "another round" });
    const closed = await post(local.app, id, "update", { state: "handed-off", closureReason: "handed_off_to", closureTarget: target });
    expect(closed.handedOffTo).toBe("prior@r");
    expect(closed.handoffAdvisory).toBeDefined();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await local.sweep()).findings.filter(f => f.qitemId === id)).toHaveLength(1);
    }
    expect(local.repo.list()).toHaveLength(2);
  });

  it("still reports a generic legacy-shaped target without an internal handoff record", async () => {
    const local = harness();
    const id = await seed(local.repo, false);
    const closed = await post(local.app, id, "update", {
      state: "handed-off", closureReason: "handed_off_to", closureTarget: "prior@r@remote",
    });
    expect(closed.handedOffTo).toBeNull();
    expect(closed.handoffAdvisory).toBeDefined();
    expect((await local.sweep()).findings.filter(f => f.qitemId === id)).toHaveLength(1);
  });

  it("also recognizes recorded flat-session legacy targets", () => {
    expect(matchesRecordedHandoffTarget("qitem-source", "r01-prior", "r01-prior@remote")).toBe(true);
  });

  it.each(["prior@r@", "prior@r@remote@extra", "prior-extra@r@remote", "prior@r@remote,missing", "prior@r@remote missing"])("does not match an incomplete or different legacy target: %s", target => {
    expect(matchesRecordedHandoffTarget("qitem-source", "prior@r", target)).toBe(false);
  });
});
