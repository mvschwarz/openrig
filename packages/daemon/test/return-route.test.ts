import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";
import { setSelfHostId, getSelfHostId } from "../src/domain/hosts/fanout-contract.js";
import { execFileSync } from "node:child_process";
import { issuedReturnAddress, relayTaskId, resolveEscalationReturnRoute } from "../src/domain/return-route.js";
import { QueueRepositoryError } from "../src/domain/queue-repository.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor, PARKED_OWNER_POLICY_NAME } from "../src/domain/policies/parked-owner-consumer.js";
import type { PolicyJob } from "../src/domain/policies/types.js";
import type { WatchdogHistoryEntry } from "../src/domain/watchdog-history-log.js";
import { queueRecoveryOwnsWake } from "../src/domain/queue-wake-ladder.js";
import { makeOperatorDeliveryEngine } from "../src/domain/gateway/operator-delivery-engine.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";
import { OPENRIG_SENDER } from "../src/lib/pane-envelope.js";
import type { LoadResult } from "../src/domain/gateway/human-registry.js";

// The first-user return route, model-free: the producer (queue create --return-route), the carry (handoffs), the resolver
// (only the work's own rows), the consumer (the operator rung's engine) and the ladder's routed blocked-row prompt trigger.
const reviewer = "dev-review@starter";
const lead = "dev-build@starter";
const nobody: LoadResult = { ok: true, entities: [] };
const slackPerson: LoadResult = { ok: true, entities: [{
  entityId: "sam", class: "human", displayName: "Sam", address: "sam@external",
  connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary", handle: "USAM" }],
  prefs: { deliveryClass: "B", availability: "available" },
}] } as LoadResult;

describe("first-user return route", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let app: Hono;
  let home: string;
  let people: LoadResult;
  const selfBefore = getSelfHostId();

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    people = nobody;
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => people });
    app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo); c.set("eventBus" as never, new EventBus(db)); await next(); });
    app.route("/api/queue", queueRoutes());
    home = mkdtempSync(join(tmpdir(), "return-route-"));
  });
  afterEach(() => { setSelfHostId(selfBefore); db.close(); rmSync(home, { recursive: true, force: true }); });

  const create = (body: Record<string, unknown>, sender?: string) => app.request("/api/queue/create", {
    method: "POST", headers: { "content-type": "application/json", ...(sender ? { "x-openrig-session": sender } : {}) },
    body: JSON.stringify({ destinationSession: "operator-agent@kernel", body: "Goal: add word counts", summary: "the goal", nudge: false, ...body }),
  });
  const provenance = (id: string) => (db.prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? AND transition_note = 'created'")
    .get(id) as { identity_provenance: string | null }).identity_provenance;

  describe("the producer", () => {
    it("auto with no caller identity issues one conversation address, records it as the route and as the declared actor", async () => {
      const res = await create({ qitemId: "qitem-goal-1", returnRoute: "auto" });
      expect(res.status).toBe(201);
      const row = await res.json() as Record<string, unknown>;
      const issued = issuedReturnAddress("qitem-goal-1");
      expect(issued).toMatch(/^conversation-[0-9a-f]{12}@kernel$/);
      expect(row).toMatchObject({ qitemId: "qitem-goal-1", sourceSession: issued, returnRoute: issued, returnRouteBasis: "issued-actor" });
      // Declared by the request, not established by transport.
      expect(provenance("qitem-goal-1")).toBe("claimed:v1");
    });

    it("an exact retry, and a restarted daemon, return the same address; another goal gets its own", async () => {
      const first = await (await create({ qitemId: "qitem-goal-1", returnRoute: "auto" })).json() as { returnRoute: string };
      const retry = await create({ qitemId: "qitem-goal-1", returnRoute: "auto" });
      expect(retry.status).toBe(201);
      expect((await retry.json() as { returnRoute: string }).returnRoute).toBe(first.returnRoute);
      const restarted = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
      const again = new Hono();
      again.use("*", async (c, next) => { c.set("queueRepo" as never, restarted); await next(); });
      again.route("/api/queue", queueRoutes());
      const afterRestart = await again.request("/api/queue/create", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ qitemId: "qitem-goal-1", destinationSession: "operator-agent@kernel", body: "Goal: add word counts", summary: "the goal", nudge: false, returnRoute: "auto" }) });
      expect((await afterRestart.json() as { returnRoute: string }).returnRoute).toBe(first.returnRoute);
      expect(db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE qitem_id = 'qitem-goal-1'").get()).toEqual({ n: 1 });
      const second = await (await create({ qitemId: "qitem-goal-2", returnRoute: "auto" })).json() as { returnRoute: string };
      expect(second.returnRoute).not.toBe(first.returnRoute);
    });

    it("a known caller keeps its own identity: auto issues the route beside it, and self is the caller's address", async () => {
      const auto = await (await create({ qitemId: "qitem-joined-auto", returnRoute: "auto" }, "front@kernel")).json() as Record<string, unknown>;
      expect(auto).toMatchObject({ sourceSession: "front@kernel", returnRoute: issuedReturnAddress("qitem-joined-auto"), returnRouteBasis: "issued" });
      expect(provenance("qitem-joined-auto")).toBe("transport:v1");
      const self = await (await create({ qitemId: "qitem-joined-self", returnRoute: "self" }, "front@kernel")).json() as Record<string, unknown>;
      expect(self).toMatchObject({ sourceSession: "front@kernel", returnRoute: "front@kernel", returnRouteBasis: "caller" });
      // self with nobody to be is the existing missing-actor answer, not a new refusal.
      const nobodyHere = await create({ returnRoute: "self" });
      expect(nobodyHere.status).toBe(400);
      expect((await nobodyHere.json() as { error: string }).error).toBe("actor_required");
    });

    it("a named address is kept as named; a person's address isn't a route", async () => {
      const named = await (await create({ returnRoute: "claude-app@kernel" }, "front@kernel")).json() as Record<string, unknown>;
      expect(named).toMatchObject({ returnRoute: "claude-app@kernel", returnRouteBasis: "named" });
      for (const person of ["sam@external", "human@kernel"]) {
        const res = await create({ returnRoute: person }, "front@kernel");
        expect(res.status).toBe(400);
        expect((await res.json() as { error: string }).error).toBe("invalid_return_route");
      }
    });

    it("a registered person's address, named or the caller's own, isn't kept: the work is created without it, and the response and the row say why", async () => {
      people = slackPerson; // sam is registered, so sam@kernel is that person's address
      for (const [returnRoute, sender] of [["sam@kernel", "front@kernel"], ["self", "sam@kernel"]] as const) {
        const res = await create({ returnRoute }, sender);
        expect(res.status).toBe(201);
        const row = await res.json() as { qitemId: string; tags: string[]; advisories: Array<{ code: string; message: string }> };
        expect(row).not.toHaveProperty("returnRoute");
        expect(repo.getById(row.qitemId)).not.toHaveProperty("returnRoute");
        expect(row.tags).toContain("return-route-not-carried");
        const said = row.advisories.filter(a => a.code === "return_route_not_carried").map(a => a.message);
        expect(said).toEqual([expect.stringContaining("The return route sam@kernel wasn't kept: it's a registered person's address")]);
        expect(said[0]).not.toContain("host id");
      }
      // An unreadable registry decides nothing: the route is kept as given.
      people = { ok: false, error: "unreadable" } as unknown as LoadResult;
      const kept = await (await create({ returnRoute: "sam@kernel" }, "front@kernel")).json() as Record<string, unknown> & { tags?: string[] };
      expect(kept).toMatchObject({ returnRoute: "sam@kernel", returnRouteBasis: "named" });
      expect(kept.tags ?? []).not.toContain("return-route-not-carried");
    });

    it("a same-id retry that now reads a person returns the row it stored, route kept, with no warning that contradicts it", async () => {
      people = { ok: false, error: "unreadable" } as unknown as LoadResult; // the first create can't classify, so it keeps the route
      const first = await (await create({ qitemId: "qitem-retry-kept", returnRoute: "sam@kernel" }, "front@kernel")).json() as Record<string, unknown>;
      expect(first).toMatchObject({ returnRoute: "sam@kernel" });
      people = slackPerson; // the retry reads sam@kernel as a person
      const retry = await (await create({ qitemId: "qitem-retry-kept", returnRoute: "sam@kernel" }, "front@kernel")).json() as
        { returnRoute?: string; tags?: string[]; advisories?: Array<{ code: string }> };
      expect(retry.returnRoute).toBe("sam@kernel");
      expect((retry.advisories ?? []).map(a => a.code)).not.toContain("return_route_not_carried");
      expect(retry.tags ?? []).not.toContain("return-route-not-carried");
    });

    it("without the flag the create is unchanged and the row carries no route", async () => {
      const row = await (await create({ qitemId: "qitem-plain" }, "front@kernel")).json() as Record<string, unknown>;
      expect(row).not.toHaveProperty("returnRoute");
      expect(row).not.toHaveProperty("returnRouteBasis");
      expect((await create({})).status).toBe(400); // still actor_required with no identity at all
    });

    it("a compact listing shows a routed row's route, and an unrouted row still has none", async () => {
      const routed = await repo.create({ sourceSession: "front@kernel", destinationSession: lead, body: "goal", nudge: false,
        returnRoute: "front@kernel", returnRouteBasis: "named" });
      const plain = await repo.create({ sourceSession: "front@kernel", destinationSession: lead, body: "other", nudge: false });
      const listed = repo.list({ compact: true, limit: 100 });
      expect(listed.find(r => r.qitemId === routed.qitemId)).toMatchObject({ returnRoute: "front@kernel", returnRouteBasis: "named" });
      expect(listed.find(r => r.qitemId === plain.qitemId)).not.toHaveProperty("returnRoute");
    });
  });

  describe("the carry", () => {
    it("handoffs carry the route and its basis to the successor, both handoff forms", async () => {
      const goal = await repo.create({ sourceSession: "front@kernel", destinationSession: "operator-agent@kernel", body: "goal",
        returnRoute: "front@kernel", returnRouteBasis: "caller", nudge: false });
      const { created: atLead } = await repo.handoff({ qitemId: goal.qitemId, fromSession: "operator-agent@kernel", toSession: lead, nudge: false });
      expect(atLead).toMatchObject({ returnRoute: "front@kernel", returnRouteBasis: "caller" });
      const { created: done } = await repo.handoffAndComplete({ qitemId: atLead.qitemId, fromSession: lead, toSession: reviewer, nudge: false });
      expect(done).toMatchObject({ returnRoute: "front@kernel", returnRouteBasis: "caller" });
      // A cancel-and-replace successor keeps the route of the row it replaces.
      const replacement = await repo.create({ sourceSession: lead, destinationSession: reviewer, body: "corrected", handedOffFrom: done.qitemId, nudge: false });
      expect(replacement).toMatchObject({ returnRoute: "front@kernel", returnRouteBasis: "caller" });
      const plain = await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x", nudge: false });
      expect((await repo.handoff({ qitemId: plain.qitemId, fromSession: "b@r", toSession: "c@r", nudge: false })).created).not.toHaveProperty("returnRoute");
    });

    it("a create sent to another host names this host on the route; without a host id, or for a person's address, it goes without the route and says so", async () => {
      const sent: Array<Record<string, unknown>> = [];
      const remote = new Hono();
      remote.use("*", async (c, next) => {
        c.set("queueRepo" as never, repo);
        c.set("hostRegistryLoader" as never, () => ({ ok: true, registry: { hosts: [{ id: "host-b", transport: "http", url: "http://host-b.invalid" }] } }));
        c.set("hostBindingsLoader" as never, () => ({ ok: true, bindings: [] }));
        c.set("remoteFetchImpl" as never, (async (_url: string, init?: RequestInit) => {
          sent.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ qitemId: "remote" }), { status: 201, headers: { "content-type": "application/json" } });
        }) as typeof fetch);
        await next();
      });
      remote.route("/api/queue", queueRoutes());
      const post = () => remote.request("/api/queue/create", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ qitemId: "qitem-goal-x", destinationSession: lead, body: "goal", nudge: false, returnRoute: "auto", hostId: "host-b" }) });
      setSelfHostId(null);
      const unknown = await post();
      expect(unknown.status).toBe(201);
      expect((await unknown.json() as { advisories: Array<{ code: string }> }).advisories.map(a => a.code)).toContain("return_route_not_carried");
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toHaveProperty("returnRoute");
      expect(sent[0]).not.toHaveProperty("returnRouteBasis");
      expect(sent[0]!.tags).toContain("return-route-not-carried"); // the row there says so too
      sent.length = 0;
      setSelfHostId("host-a");
      await post();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ returnRoute: `${issuedReturnAddress("qitem-goal-x")}@host-a`, returnRouteBasis: "issued-actor",
        sourceSession: `${issuedReturnAddress("qitem-goal-x")}@host-a` });
      // A registered person's address isn't sent as a route, even with this host's id known.
      sent.length = 0;
      people = slackPerson;
      const person = await remote.request("/api/queue/create", { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "front@kernel" },
        body: JSON.stringify({ destinationSession: lead, body: "goal", nudge: false, returnRoute: "sam@kernel", hostId: "host-b" }) });
      expect(person.status).toBe(201);
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toHaveProperty("returnRoute");
      expect(sent[0]!.tags).toContain("return-route-not-carried");
      expect((await person.json() as { advisories: Array<{ code: string; message: string }> }).advisories
        .find(a => a.code === "return_route_not_carried")?.message).toContain("sam@kernel wasn't kept: it's a registered person's address");
    });

    it("a forwarded same-id retry whose receiver kept the route isn't told it wasn't carried, for a person or with no host id", async () => {
      const sent: Array<Record<string, unknown>> = [];
      let stored: Record<string, unknown> = {};
      const remote = new Hono();
      remote.use("*", async (c, next) => {
        c.set("queueRepo" as never, repo);
        c.set("hostRegistryLoader" as never, () => ({ ok: true, registry: { hosts: [{ id: "host-b", transport: "http", url: "http://host-b.invalid" }] } }));
        c.set("hostBindingsLoader" as never, () => ({ ok: true, bindings: [] }));
        c.set("remoteFetchImpl" as never, (async (_url: string, init?: RequestInit) => {
          sent.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify(stored), { status: 201, headers: { "content-type": "application/json" } });
        }) as typeof fetch);
        await next();
      });
      remote.route("/api/queue", queueRoutes());
      const post = async () => (await (await remote.request("/api/queue/create", { method: "POST",
        headers: { "content-type": "application/json", "x-openrig-session": "front@kernel" },
        body: JSON.stringify({ qitemId: "qitem-fwd-retry", destinationSession: lead, body: "goal", nudge: false, returnRoute: "sam@kernel", hostId: "host-b" }) }))
        .json() as { advisories?: Array<{ code: string }> }).advisories?.map(a => a.code) ?? [];
      // The receiver returns the row the first forward stored, with the route it carried.
      stored = { qitemId: "qitem-fwd-retry", returnRoute: "sam@kernel@host-a", returnRouteBasis: "named" };
      setSelfHostId("host-a");
      people = slackPerson; // this retry reads a person, so it sends no route ...
      expect(await post()).not.toContain("return_route_not_carried");
      expect(sent.at(-1)).not.toHaveProperty("returnRoute");
      setSelfHostId(null);
      people = nobody; // ... nor does one without this host's id
      expect(await post()).not.toContain("return_route_not_carried");
      expect(sent.at(-1)).not.toHaveProperty("returnRoute");
      // A receiver row without the route still gets the warning.
      stored = { qitemId: "qitem-fwd-retry" };
      expect(await post()).toContain("return_route_not_carried");
    });

    it.each(["handoff", "handoff-and-complete"] as const)("a %s to another host carries the route naming this host; without a host id it goes without the route and says so", async verb => {
      const sent: Array<Record<string, unknown>> = [];
      const remote = new Hono();
      remote.use("*", async (c, next) => {
        c.set("queueRepo" as never, repo);
        c.set("hostRegistryLoader" as never, () => ({ ok: true, registry: { hosts: [{ id: "host-b", transport: "http", url: "http://host-b.invalid" }] } }));
        c.set("hostBindingsLoader" as never, () => ({ ok: true, bindings: [] }));
        c.set("remoteFetchImpl" as never, (async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          sent.push(body);
          return new Response(JSON.stringify({ qitemId: body.qitemId, destinationSession: body.destinationSession, state: "pending" }), { status: 201, headers: { "content-type": "application/json" } });
        }) as typeof fetch);
        await next();
      });
      remote.route("/api/queue", queueRoutes());
      const handOver = async () => {
        const goal = await repo.create({ sourceSession: "front@kernel", destinationSession: lead, body: "goal", returnRoute: "front@kernel", returnRouteBasis: "caller", nudge: false });
        repo.claim({ qitemId: goal.qitemId, destinationSession: lead });
        const res = await remote.request(`/api/queue/${goal.qitemId}/${verb}`, { method: "POST",
          headers: { "content-type": "application/json", "x-openrig-session": lead }, body: JSON.stringify({ toSession: reviewer, hostId: "host-b", nudge: false }) });
        return { goal, res };
      };
      setSelfHostId(null);
      const unknown = await handOver();
      expect(unknown.res.status).toBe(201);
      expect((await unknown.res.json() as { advisories: Array<{ code: string }> }).advisories.map(a => a.code)).toEqual(["return_route_not_carried"]);
      expect(sent[0]).not.toHaveProperty("returnRoute");
      expect(sent[0]!.tags).toContain("return-route-not-carried");
      expect(repo.listTransitions(unknown.goal.qitemId).some(t => t.transitionNote?.startsWith("return-route not-carried: The return route front@kernel wasn't carried"))).toBe(true);
      expect(repo.getById(unknown.goal.qitemId)!.state).not.toMatch(/pending|in-progress/); // the work went on
      sent.length = 0;
      setSelfHostId("host-a");
      const known = await handOver();
      expect(known.res.status).toBe(201);
      expect(await known.res.json()).not.toHaveProperty("advisories");
      expect(sent[0]).toMatchObject({ returnRoute: "front@kernel@host-a", returnRouteBasis: "caller" });
      expect(sent[0]!.tags).not.toContain("return-route-not-carried");
    });

    it("the receiving host keeps a carried route's host and basis; one naming this host is local", async () => {
      setSelfHostId("host-b");
      const foreign = await (await create({ returnRoute: "conversation-abc@kernel@host-a", returnRouteBasis: "issued-actor", sourceSession: "conversation-abc@kernel@host-a" })).json() as Record<string, unknown>;
      expect(foreign).toMatchObject({ returnRoute: "conversation-abc@kernel@host-a", returnRouteBasis: "issued-actor" });
      const home = await (await create({ returnRoute: "front@kernel@host-b", sourceSession: "front@kernel" })).json() as Record<string, unknown>;
      expect(home).toMatchObject({ returnRoute: "front@kernel", returnRouteBasis: "named" });
    });
  });

  describe("the resolver reads only the work's own rows", () => {
    it("the actual parent: a fresh row a routed goal waits on resolves to the goal's route", async () => {
      const review = await repo.create({ sourceSession: lead, destinationSession: reviewer, body: "review this", nudge: false });
      const goal = await repo.create({ sourceSession: "front@kernel", destinationSession: lead, body: "goal", returnRoute: "front@kernel", nudge: false });
      expect(resolveEscalationReturnRoute(db, review)).toEqual({ kind: "none" });
      repo.claim({ qitemId: goal.qitemId, destinationSession: lead });
      await repo.update({ qitemId: goal.qitemId, actorSession: lead, state: "blocked", blockedOn: review.qitemId });
      expect(resolveEscalationReturnRoute(db, review)).toEqual({ kind: "route", route: "front@kernel", anchors: [goal.qitemId] });
    });

    it("two conversations on one team stay distinct; an unrelated open route is never borrowed", async () => {
      const routed = async (route: string) => {
        const review = await repo.create({ sourceSession: lead, destinationSession: reviewer, body: `review for ${route}`, nudge: false });
        const goal = await repo.create({ sourceSession: route, destinationSession: lead, body: "goal", returnRoute: route, nudge: false });
        repo.claim({ qitemId: goal.qitemId, destinationSession: lead });
        await repo.update({ qitemId: goal.qitemId, actorSession: lead, state: "blocked", blockedOn: review.qitemId });
        return review;
      };
      const a = await routed("front@kernel");
      const b = await routed("front-2@kernel");
      expect(resolveEscalationReturnRoute(db, a)).toMatchObject({ kind: "route", route: "front@kernel" });
      expect(resolveEscalationReturnRoute(db, b)).toMatchObject({ kind: "route", route: "front-2@kernel" });
      const both = { qitemId: "alert", tags: [`recovery-for:${a.qitemId}`, `recovery-for:${b.qitemId}`] };
      expect(resolveEscalationReturnRoute(db, both)).toMatchObject({ kind: "conflict", routes: ["front-2@kernel", "front@kernel"] });
      // One routed goal open on the team, and a fresh row that has nothing to do with it.
      const unrelated = await repo.create({ sourceSession: lead, destinationSession: reviewer, body: "unrelated", nudge: false });
      expect(resolveEscalationReturnRoute(db, unrelated)).toEqual({ kind: "none" });
    });
  });

  describe("the consumer", () => {
    function engine(registry: LoadResult, dispatched: unknown[] = []) {
      return makeOperatorDeliveryEngine({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry },
        readiness: async () => ({ ready: true, reason: "fixture ready" }),
        dispatch: (op, ref, payload) => { dispatched.push({ op, ref, payload }); return { ok: true, decisionId: "gw-1" }; } });
    }
    async function promptAlert(route: string | null) {
      const goal = await repo.create({ sourceSession: "front@kernel", destinationSession: lead, body: "goal", nudge: false,
        ...(route ? { returnRoute: route, returnRouteBasis: "caller" } : {}) });
      return repo.create({ sourceSession: OPENRIG_SENDER, destinationSession: "operator-agent@kernel", body: "WAKE ESCALATION", nudge: false,
        tags: ["wake-prompt-refusal", `prompt-destination:${reviewer}`, `prompt-routed-work:${goal.qitemId}`] });
    }

    it("a routed escalation becomes one relay task at the route, with nobody registered, and a second dispatch adds none", async () => {
      const alert = await promptAlert("front@kernel");
      const port = engine(nobody);
      const first = await port.dispatchEscalation(alert, "interactive prompt blocks outstanding work");
      expect(first).toMatchObject({ decision: "return-route:front@kernel", dispatched: true, resolved: false });
      const relayId = relayTaskId(first.notificationKey!);
      const relay = repo.getById(relayId)!;
      expect(relay).toMatchObject({ sourceSession: OPENRIG_SENDER, destinationSession: "front@kernel", state: "pending" });
      expect(relay.body).toContain(`rig capture '${reviewer}'`);
      expect(relay.body).toContain(`--reason 'task ${relayId}: <their words>'`);
      expect(relay.lastNudgeResult).toBeNull(); // nothing to wake: the conversation reads it on its next turn
      await port.dispatchEscalation(alert, "again");
      expect(repo.list({ destinationSession: "front@kernel", limit: 100 }).filter(r => r.tags?.includes("return-route-relay"))).toHaveLength(1);
      expect(repo.list({ destinationSession: "front-2@kernel", limit: 100 })).toEqual([]);
      // Without a route, the same escalation is undeliverable as before.
      expect((await port.dispatchEscalation(await promptAlert(null), "x")).decision).toBe("undeliverable:no-registered-human");
    });

    it("a routed goal's new episode takes the route ahead of a ready Slack connector; an unrouted one keeps the gateway", async () => {
      const dispatched: unknown[] = [];
      const port = engine(slackPerson, dispatched);
      expect((await port.dispatchEscalation(await promptAlert("front@kernel"), "x")).decision).toBe("return-route:front@kernel");
      expect(dispatched).toEqual([]);
      await port.dispatchEscalation(await promptAlert(null), "x");
      expect(dispatched).toHaveLength(1);
    });

    it("an episode the gateway already accepted keeps its custody when a route appears", async () => {
      const alert = await promptAlert("front@kernel");
      const port = engine(slackPerson);
      const key = `${alert.qitemId}:operator-rung`;
      new DispatchBuffer(home).enqueue({ decisionId: `operator:${key}` } as never);
      expect(await port.dispatchEscalation(alert, "x")).toMatchObject({ decision: "accepted-pending", dispatched: true });
      expect(repo.getById(relayTaskId(key))).toBeNull();
    });

    it("another host's route and a conflict are said on the row, and the episode takes the existing route", async () => {
      setSelfHostId("host-b");
      const foreign = await promptAlert("front@kernel@host-a");
      const result = await engine(nobody).dispatchEscalation(foreign, "x");
      expect(result.decision).toBe("undeliverable:no-registered-human");
      expect(repo.listTransitions(foreign.qitemId).some(t => t.transitionNote?.startsWith("return-route on-another-host route=front@kernel@host-a"))).toBe(true);
    });

    it("a note on the relay isn't pickup; an agent's claim at the route is, and it resolves the delivery episode as pickup only", async () => {
      const alert = await promptAlert("front@kernel");
      const port = engine(nobody);
      const { notificationKey } = await port.dispatchEscalation(alert, "x");
      const relayId = relayTaskId(notificationKey!);
      await repo.update({ qitemId: relayId, actorSession: OPENRIG_SENDER, transitionNote: "a note isn't pickup" });
      expect(repo.listTransitions(alert.qitemId).some(t => t.transitionNote?.startsWith("return-route relay-claimed"))).toBe(false);
      repo.claim({ qitemId: relayId, destinationSession: "front@kernel" });
      const note = repo.listTransitions(alert.qitemId).find(t => t.transitionNote?.startsWith("return-route relay-claimed"))!;
      expect(note.transitionNote).toContain(`notification_key=${notificationKey}`);
      expect(note.transitionNote).toContain("not the person's answer or approval");
      expect(await port.dispatchEscalation(alert, "x")).toMatchObject({ decision: "picked-up", resolved: true });
    });

    it.each(["done", "canceled"] as const)("closing the relay without a claim (%s) records no pickup, answer or clearance, and keeps its custody", async how => {
      const alert = await promptAlert("front@kernel");
      const port = engine(nobody);
      const { notificationKey } = await port.dispatchEscalation(alert, "x");
      const relayId = relayTaskId(notificationKey!);
      await repo.update(how === "done"
        ? { qitemId: relayId, actorSession: "front@kernel", state: "done", closureReason: "no-follow-on", resolution: "yes" }
        : { qitemId: relayId, actorSession: OPENRIG_SENDER, state: "done", closureReason: "canceled", closureTarget: "withdrawn" });
      const notes = repo.listTransitions(alert.qitemId).map(t => t.transitionNote ?? "");
      expect(notes.some(n => n.startsWith("return-route relay-claimed"))).toBe(false);
      expect(notes.some(n => n.includes("prompt_override") || n.includes("prompt escalation"))).toBe(false);
      expect(await port.dispatchEscalation(alert, "x")).toMatchObject({ decision: "return-route:front@kernel", resolved: false });
    });

    it("an unrelated row holding the relay's id is left alone, said on the escalation, and the existing route is used", async () => {
      const alert = await promptAlert("front@kernel");
      const key = `${alert.qitemId}:operator-rung`;
      const squatter = await repo.create({ qitemId: relayTaskId(key), sourceSession: "someone@else", destinationSession: "front@kernel", body: "unrelated", nudge: false });
      const port = engine(nobody);
      expect(port.hasAcceptedEscalation!(alert)).toBe(false);
      expect((await port.dispatchEscalation(alert, "x")).decision).toBe("undeliverable:no-registered-human");
      expect(repo.getById(squatter.qitemId)).toMatchObject({ sourceSession: "someone@else", body: "unrelated", state: "pending" });
      expect(repo.listTransitions(alert.qitemId).some(t => t.transitionNote?.startsWith(`return-route relay-id-taken relay=${squatter.qitemId}`))).toBe(true);
      // A claim of that row records no pickup for the episode.
      repo.claim({ qitemId: squatter.qitemId, destinationSession: "front@kernel" });
      expect(repo.listTransitions(alert.qitemId).some(t => t.transitionNote?.startsWith("return-route relay-claimed"))).toBe(false);
    });

    it("a relay create that fails is said on the row and the existing route is used; one written before the failure is kept", async () => {
      const port = engine(nobody);
      const failing = await promptAlert("front@kernel");
      const original = repo.create.bind(repo);
      const spy = vi.spyOn(repo, "create").mockImplementation(async input => {
        if (input.qitemId?.startsWith("qitem-route-relay-")) throw new QueueRepositoryError("qitem_erased", "erased");
        return original(input);
      });
      expect((await port.dispatchEscalation(failing, "x")).decision).toBe("undeliverable:no-registered-human");
      expect(repo.listTransitions(failing.qitemId).some(t => t.transitionNote?.includes("relay-not-made") && t.transitionNote.includes("code=qitem_erased"))).toBe(true);
      spy.mockImplementation(async input => {
        const made = await original(input);
        if (input.qitemId?.startsWith("qitem-route-relay-")) throw new Error("connection lost after the write");
        return made;
      });
      const written = await promptAlert("front@kernel");
      expect((await port.dispatchEscalation(written, "x")).decision).toBe("return-route:front@kernel");
      expect(repo.listTransitions(written.qitemId).some(t => t.transitionNote?.includes("relay-not-made"))).toBe(false);
    });

    it("a relay already made keeps its episode when the route changes before the dispatch marker: conflicting or gone", async () => {
      const dispatched: unknown[] = [];
      const port = engine(slackPerson, dispatched);
      const alert = await promptAlert("front@kernel");
      expect((await port.dispatchEscalation(alert, "x")).decision).toBe("return-route:front@kernel");
      // No dispatch marker was recorded (the crash window). A second routed goal now joins this alert.
      const other = await repo.create({ sourceSession: "front-2@kernel", destinationSession: lead, body: "goal 2", returnRoute: "front-2@kernel", nudge: false });
      db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify([...alert.tags!, `prompt-routed-work:${other.qitemId}`]), alert.qitemId);
      const conflicting = repo.getById(alert.qitemId)!;
      expect(resolveEscalationReturnRoute(db, conflicting).kind).toBe("conflict");
      expect(port.hasAcceptedEscalation!(conflicting)).toBe(true);
      expect((await port.dispatchEscalation(conflicting, "x")).decision).toBe("return-route:front@kernel");
      // The association gone altogether.
      db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify(["wake-prompt-refusal", `prompt-destination:${reviewer}`]), alert.qitemId);
      expect((await port.dispatchEscalation(repo.getById(alert.qitemId)!, "x")).decision).toBe("return-route:front@kernel");
      expect(dispatched).toEqual([]);
      expect(repo.list({ destinationSession: "front@kernel", limit: 100 }).filter(r => r.tags?.includes("return-route-relay"))).toHaveLength(1);
    });

    it("the relay's commands quote every name, and its quoting rule keeps the person's words literal", async () => {
      const goal = await repo.create({ sourceSession: "front@kernel", destinationSession: lead, body: "goal", returnRoute: "front@kernel", nudge: false });
      const alert = await repo.create({ sourceSession: OPENRIG_SENDER, destinationSession: "operator-agent@kernel", body: "WAKE ESCALATION", nudge: false,
        tags: ["wake-prompt-refusal", "prompt-destination:dev review@starter", `prompt-routed-work:${goal.qitemId}`] });
      const { notificationKey } = await engine(nobody).dispatchEscalation(alert, "x");
      const relayId = relayTaskId(notificationKey!);
      const body = repo.getById(relayId)!.body;
      expect(body).toContain("rig capture 'dev review@starter'");
      expect(body).toContain(`rig send 'dev review@starter' "<key>" --dangerously-interact --reason 'task ${relayId}: <their words>'`);
      expect(body).toContain(`OPENRIG_SESSION_NAME='front@kernel' rig queue claim '${relayId}'`);
      expect(body).toContain("--resolution '<their words>'");
      expect(body).toContain("writing each ' in them as '\\''");
      // Following that rule, words with an apostrophe, a dollar sign and a backtick reach the command unchanged.
      const words = "yes, but it's $HOME and `date` only";
      const quoted = `'${words.replaceAll("'", "'\\''")}'`;
      expect(execFileSync("/bin/sh", ["-c", `printf %s ${quoted}`], { encoding: "utf8" })).toBe(words);
    });
  });

  describe("the ladder: a routed goal waiting on a reviewer at a prompt", () => {
    let prompt: "blocked" | "clear" | "unknown";
    beforeEach(() => { prompt = "blocked"; });
    const port = () => makeOperatorDeliveryEngine({ home, queueRepo: repo, registry: { loadHumanRegistry: () => nobody },
      dispatch: () => { throw new Error("no gateway dispatch expected"); } });
    let kind: "choice" | "permission" | "unknown";
    beforeEach(() => { kind = "unknown"; });
    const tick = (now = new Date(Date.now() + 120_000), attemptWake = vi.fn(async () => "verified")) => runWakeLadderTick({ db, queueRepo: repo,
      resolveOrchestrator: s => (s === reviewer ? lead : null), readPromptState: dest => (dest === reviewer ? prompt : "unknown"),
      readPromptKind: dest => (dest === reviewer ? kind : "unknown"),
      retryIntervalSeconds: 60, now, deliveryEngine: port(), attemptWake, log: (line: string) => { throw new Error(`unexpected ladder log: ${line}`); } });
    const alerts = () => repo.list({ state: ["pending", "in-progress", "blocked"], limit: 1000 }).filter(r => r.tags?.includes("wake-prompt-refusal"));
    const relays = () => repo.list({ destinationSession: "front@kernel", limit: 1000 }).filter(r => r.tags?.includes("return-route-relay"));
    async function waitingGoal(route: string | null, on: "seat" | "row" | "held" = "seat") {
      const goal = await repo.create({ sourceSession: "front@kernel", destinationSession: lead, body: "goal", nudge: false,
        ...(route ? { returnRoute: route, returnRouteBasis: "issued-actor" } : {}) });
      repo.claim({ qitemId: goal.qitemId, destinationSession: lead });
      if (on === "held") {
        // The starter's culture asks for review by handing the work over: the reviewer then holds the routed row itself.
        const { created } = await repo.handoff({ qitemId: goal.qitemId, fromSession: lead, toSession: reviewer, nudge: false });
        repo.claim({ qitemId: created.qitemId, destinationSession: reviewer });
        return created;
      }
      const blocker = on === "seat" ? reviewer
        : (await repo.create({ sourceSession: lead, destinationSession: reviewer, body: "review the change", nudge: false })).qitemId;
      await repo.update({ qitemId: goal.qitemId, actorSession: lead, state: "blocked", blockedOn: blocker });
      return goal;
    }

    it.each(["seat", "row", "held"] as const)("waiting on the reviewer (%s): one alert and one relay at the route, not a wake of the reviewer's lead", async on => {
      const goal = await waitingGoal("front@kernel", on);
      const wake = vi.fn(async () => "verified");
      await tick(undefined, wake);
      expect(wake).not.toHaveBeenCalled();
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0]!.tags).toContain(`prompt-routed-work:${goal.qitemId}`);
      expect(relays()).toHaveLength(1);
      expect(relays()[0]!.body).toContain(`${reviewer} is stopped at a prompt`);
      await tick(new Date(Date.now() + 400_000), wake);
      expect(relays()).toHaveLength(1);
    });

    // 0.7.18 rehearsal (#3318): the summary said "0 baton(s) stuck" while the alert was about a routed goal.
    it("an alert about a routed goal alone counts the goal in its summary, and its body has no empty baton list", async () => {
      await waitingGoal("front@kernel", "seat");
      await tick();
      const [alert] = alerts();
      expect(alert!.summary).toContain(`Wake escalation: 1 routed goal(s) waiting on ${reviewer} — `);
      expect(alert!.summary).not.toContain("baton(s)");
      expect(alert!.body).not.toContain("stuck batons");
      expect(alert!.body).toContain("work handed over with a return route, stuck at its prompt (1):");
    });

    // #3393 r1: a routed goal the reviewer holds, whose wake was also refused, is one row and counts once.
    it("a routed goal whose wake was also refused counts once in the summary; the body still names it under both", async () => {
      const routed = await waitingGoal("front@kernel", "held");
      await refuseWake([routed.qitemId], `Refused: '${reviewer}' is at an interactive prompt (target_needs_input). No text was sent.`);
      await tick();
      const [alert] = alerts();
      expect(alert!.summary).toContain(`Wake escalation: 1 routed goal(s) waiting on ${reviewer} — `);
      expect(alert!.summary).not.toContain("baton(s)");
      expect(alert!.body).toContain("stuck batons (1):");
      expect(alert!.body).toContain("work handed over with a return route, stuck at its prompt (1):");
    });

    it("a seat reporting a permission prompt takes the route too", async () => {
      kind = "permission";
      await waitingGoal("front@kernel", "held");
      await tick();
      expect(relays()).toHaveLength(1);
    });

    it("a choice prompt the seat reports, with routed work only, keeps the choice route: its lead is woken and no relay is made", async () => {
      kind = "choice";
      await waitingGoal("front@kernel", "held");
      const wake = vi.fn(async () => "verified");
      await tick(undefined, wake);
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0]!.tags).toContain("prompt-kind:choice");
      expect(wake).toHaveBeenCalledWith(alerts()[0]!.qitemId, lead);
      expect(relays()).toEqual([]);
    });

    it("a choice already known from a refused wake isn't turned into a permission prompt by routed work at that seat", async () => {
      const routed = await waitingGoal("front@kernel", "held");
      await refuseWake([routed.qitemId], `Refused: '${reviewer}' is at an interactive prompt (selection_prompt). No text was sent.`);
      const wake = vi.fn(async () => "verified");
      await tick(undefined, wake);
      expect(alerts()[0]!.tags).toContain("prompt-kind:choice");
      expect(wake).toHaveBeenCalledWith(alerts()[0]!.qitemId, lead);
      expect(relays()).toEqual([]);
    });

    function refuseWake(rowIds: string[], deliveryReason: string) {
      const history: WatchdogHistoryEntry[] = [];
      const policy = makeParkedOwnerConsumerPolicy({
        diagnoseRig: () => ({ seats: [{ sessionName: reviewer, parked: true,
          activity: { value: "idle-at-prompt", needsInput: { count: 1, reason: "prompt" } },
          obligations: { items: rowIds.map(qitemId => ({ qitemId, state: "in-progress", summary: "review" })), held: [] } }] }),
        history: { listForJob: () => history, countForJob: () => history.length },
        rows: {
          listTransitions: id => repo.listTransitions(id),
          appendNote: (id, note) => { void repo.update({ qitemId: id, actorSession: "watchdog@system", transitionNote: note }); return { ok: true }; },
          recordNudgeResult: (id, result) => repo.recordNudgeAttempt(id, result),
          listOpenIds: () => rowIds,
          recoveryOwnsWake: id => queueRecoveryOwnsWake(db, repo.getById(id)),
        },
      });
      const job = { jobId: "refuse-job", policy: PARKED_OWNER_POLICY_NAME, target: { session: makeRigAnchor("starter") }, context: {} } as PolicyJob;
      return policy.evaluate(job).then(async wake => {
        history.push({ historyId: "refuse-history", jobId: job.jobId, evaluatedAt: new Date().toISOString(), outcome: "sent", skipReason: null,
          deliveryTargetSession: reviewer, deliveryStatus: "failed", deliveryMessage: "wake", evaluationNotes: { ...wake.notes, deliveryReason } });
        await policy.evaluate(job);
      });
    }

    it("routed work that joins an alert whose lead was already woken still gets its relay, once", async () => {
      const unrouted = await repo.create({ sourceSession: lead, destinationSession: reviewer, body: "other review", nudge: false });
      repo.claim({ qitemId: unrouted.qitemId, destinationSession: reviewer });
      await refuseWake([unrouted.qitemId], `Refused: '${reviewer}' is at an interactive prompt (target_needs_input). No text was sent.`);
      const wake = vi.fn(async () => "verified");
      await tick(undefined, wake);
      expect(wake).toHaveBeenCalledWith(alerts()[0]!.qitemId, lead);
      expect(repo.listTransitions(alerts()[0]!.qitemId).some(t => t.transitionNote?.startsWith("ladder-exhausted: escalated to orchestrator"))).toBe(true);
      expect(relays()).toEqual([]);
      await waitingGoal("front@kernel");
      await tick(new Date(Date.now() + 400_000), wake);
      expect(alerts()).toHaveLength(1);
      expect(relays()).toHaveLength(1);
      await tick(new Date(Date.now() + 800_000), wake);
      expect(relays()).toHaveLength(1);
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it("a route on another host keeps the seat's usual order: its lead is woken, and no relay is made", async () => {
      setSelfHostId("host-b");
      await waitingGoal("front@kernel@host-a");
      const wake = vi.fn(async () => "verified");
      await tick(undefined, wake);
      expect(alerts()).toHaveLength(1);
      expect(wake).toHaveBeenCalledWith(alerts()[0]!.qitemId, lead);
      expect(repo.list({ limit: 1000 }).filter(r => r.tags?.includes("return-route-relay"))).toEqual([]);
    });

    it("closing the relay without a claim leaves the alert's delivery unresolved and the prompt's alert open until it clears", async () => {
      await waitingGoal("front@kernel");
      await tick();
      const relay = relays()[0]!;
      await repo.update({ qitemId: relay.qitemId, actorSession: "front@kernel", state: "done", closureReason: "no-follow-on", resolution: "yes" });
      await tick(new Date(Date.now() + 400_000));
      const alert = alerts()[0]!;
      expect(repo.listTransitions(alert.qitemId).some(t => t.transitionNote?.startsWith("ladder-exhausted:"))).toBe(false);
      expect(relays()).toHaveLength(1);
      prompt = "clear";
      await tick(new Date(Date.now() + 800_000));
      expect(alerts()).toEqual([]);
    });

    it.each(["seat", "held"] as const)("without a route the same work (%s) raises nothing, as before", async on => {
      await waitingGoal(null, on);
      await tick();
      expect(alerts()).toEqual([]);
    });

    it("pickup, answer and effect stay separate: a claim resolves delivery, a close clears nothing, the clear retires the alert", async () => {
      await waitingGoal("front@kernel");
      await tick();
      const relay = relays()[0]!;
      repo.claim({ qitemId: relay.qitemId, destinationSession: "front@kernel" });
      await tick(new Date(Date.now() + 400_000));
      const alert = alerts()[0]!;
      expect(repo.listTransitions(alert.qitemId).some(t => t.transitionNote?.startsWith("ladder-exhausted:"))).toBe(true);
      await repo.update({ qitemId: relay.qitemId, actorSession: "front@kernel", state: "done", closureReason: "no-follow-on", resolution: "yes, run the tests" });
      await tick(new Date(Date.now() + 800_000));
      expect(alerts().map(a => a.qitemId)).toEqual([alert.qitemId]); // still at the prompt: the answer isn't the effect
      expect(repo.listTransitions(alert.qitemId).some(t => t.transitionNote?.includes("prompt_override"))).toBe(false);
      prompt = "clear";
      await tick(new Date(Date.now() + 1_200_000));
      expect(alerts()).toEqual([]);
      expect(repo.getById(relay.qitemId)).toMatchObject({ state: "done", resolution: "yes, run the tests" });
    });

    it("a prompt that clears before pickup closes its relay as canceled; the next prompt is a new episode and task", async () => {
      await waitingGoal("front@kernel");
      await tick();
      const stale = relays()[0]!;
      prompt = "clear";
      await tick(new Date(Date.now() + 400_000));
      expect(repo.getById(stale.qitemId)).toMatchObject({ state: "done", closureReason: "canceled" });
      expect(repo.listTransitions(stale.qitemId).at(-1)?.transitionNote).toContain("don't send an answer for that prompt");
      prompt = "blocked";
      await tick(new Date(Date.now() + 800_000));
      const open = relays().filter(r => r.state === "pending");
      expect(open).toHaveLength(1);
      expect(open[0]!.qitemId).not.toBe(stale.qitemId);
    });

    it("a clear closes only the episode's own relay: another row that carries the alert's relay tag is left as it is", async () => {
      await waitingGoal("front@kernel");
      await tick();
      const decoy = await repo.create({ sourceSession: lead, destinationSession: "front@kernel", body: "other work", nudge: false,
        tags: [`relay-for:${alerts()[0]!.qitemId}`] });
      prompt = "clear";
      await tick(new Date(Date.now() + 400_000));
      expect(relays()[0]).toMatchObject({ state: "done", closureReason: "canceled" });
      expect(repo.getById(decoy.qitemId)).toMatchObject({ state: "pending" });
      expect(repo.listTransitions(decoy.qitemId).some(t => t.transitionNote?.includes("superseded"))).toBe(false);
    });

    it("routed work that leaves an alert takes its route with it: when one of two conflicting goals leaves, the other's route relays", async () => {
      const leaving = await waitingGoal("front-2@kernel");
      await waitingGoal("front@kernel");
      const wake = vi.fn(async () => "verified");
      await tick(undefined, wake);
      expect(wake).toHaveBeenCalledWith(alerts()[0]!.qitemId, lead); // two routes: nothing chooses, so the lead is woken
      expect(repo.list({ limit: 1000 }).filter(r => r.tags?.includes("return-route-relay"))).toEqual([]);
      await repo.update({ qitemId: leaving.qitemId, actorSession: lead, state: "done", closureReason: "no-follow-on" });
      await tick(new Date(Date.now() + 400_000), wake);
      expect(alerts()).toHaveLength(1);
      expect(relays()).toHaveLength(1); // the conversation that's still waiting gets the prompt
      expect(alerts()[0]!.tags).not.toContain(`prompt-routed-work:${leaving.qitemId}`);
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it("an alert that already went to a relay keeps it, and its record, when routed work joins and then leaves", async () => {
      await waitingGoal("front@kernel");
      await tick();
      const relay = relays()[0]!;
      const passing = await waitingGoal("front-2@kernel");
      await tick(new Date(Date.now() + 400_000));
      await repo.update({ qitemId: passing.qitemId, actorSession: lead, state: "done", closureReason: "no-follow-on" });
      await tick(new Date(Date.now() + 800_000));
      expect(alerts()[0]!.tags).toContain(`prompt-routed-work:${passing.qitemId}`); // a dispatched episode keeps its record
      expect(repo.list({ limit: 1000 }).filter(r => r.tags?.includes("return-route-relay")).map(r => r.qitemId)).toEqual([relay.qitemId]);
    });

    it("an unknown prompt state neither starts an episode nor clears one", async () => {
      prompt = "unknown";
      await waitingGoal("front@kernel");
      await tick();
      expect(alerts()).toEqual([]);
      prompt = "blocked";
      await tick(new Date(Date.now() + 400_000));
      const relay = relays()[0]!;
      prompt = "unknown";
      await tick(new Date(Date.now() + 800_000));
      expect(alerts()).toHaveLength(1);
      expect(repo.getById(relay.qitemId)!.state).toBe("pending");
    });
  });
});
