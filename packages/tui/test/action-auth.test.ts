// Answering an ask from the TUI is operator-gated: the daemon checks its operator bearer (OPENRIG_AUTH_BEARER_TOKEN), which
// can differ from the terminal token every other TUI call carries. The client sends the action headers only on that
// write. Synthetic credentials; the joined cells run the daemon's real Mission Control and pairing routes in-process.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_UNAUTHORIZED, DaemonClient } from "../src/daemon-client.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { makeTopologyDestinationCheck } from "../../daemon/src/domain/queue-destination-check.js";
import { MissionControlWriteContract } from "../../daemon/src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../../daemon/src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../../daemon/src/routes/mission-control.js";
import { hostsRoutes } from "../../daemon/src/routes/hosts.js";

const ACTION = "synthetic-operator-bearer", TERMINAL = "synthetic-terminal-token";
const PERSON = "pair-person@external";

/** Records the Authorization header each call carried, by method and route. */
function recording() {
  const seen: Array<{ method: string; route: string; auth: string | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ method: init?.method ?? "GET", route: new URL(String(url)).pathname, auth: headers.get("authorization") ?? undefined });
    return new Response(JSON.stringify({ verb: "answer", qitemId: "q-1", closedQitem: null }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe("the TUI's answer carries the operator bearer; every other call keeps its terminal credential", () => {
  it("with distinct operator and terminal credentials, the answer carries the operator bearer and a read the terminal token", async () => {
    const r = recording();
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: r.fetchImpl,
      headers: () => ({ Authorization: `Bearer ${TERMINAL}` }), actionHeaders: () => ({ Authorization: `Bearer ${ACTION}` }) });
    await client.missionControlAction({ verb: "answer", qitemId: "q-1", actorSession: PERSON, decision: "yes" });
    await client.queueItem("q-1");
    expect(r.seen).toEqual([
      { method: "POST", route: "/api/mission-control/action", auth: `Bearer ${ACTION}` },
      { method: "GET", route: "/api/queue/q-1", auth: `Bearer ${TERMINAL}` },
    ]);
  });

  it("with an operator bearer configured and no terminal-token file, the answer carries the bearer and reads carry none", async () => {
    const r = recording();
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: r.fetchImpl, headers: () => ({}),
      actionHeaders: () => ({ Authorization: `Bearer ${ACTION}` }) });
    await client.missionControlAction({ verb: "answer", qitemId: "q-1", actorSession: PERSON, decision: "yes" });
    await client.queueItem("q-1");
    expect(r.seen.map((s) => s.auth)).toEqual([`Bearer ${ACTION}`, undefined]);
  });

  it("with no action headers, the answer keeps the existing fallback: the same credential as every other call", async () => {
    const r = recording();
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: r.fetchImpl, headers: () => ({ Authorization: `Bearer ${TERMINAL}` }) });
    await client.missionControlAction({ verb: "answer", qitemId: "q-1", actorSession: PERSON, decision: "yes" });
    expect(r.seen.map((s) => s.auth)).toEqual([`Bearer ${TERMINAL}`]);
  });

  it("a page client keeps the action headers", async () => {
    const r = recording();
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: r.fetchImpl,
      headers: () => ({ Authorization: `Bearer ${TERMINAL}` }), actionHeaders: () => ({ Authorization: `Bearer ${ACTION}` }) });
    const page = client.forPage({ fetch: (impl: typeof fetch) => impl } as never, new AbortController().signal);
    await page.missionControlAction({ verb: "answer", qitemId: "q-1", actorSession: PERSON, decision: "yes" });
    expect(r.seen.map((s) => s.auth)).toEqual([`Bearer ${ACTION}`]);
  });
});

describe("against the daemon's real routes, a pairing answer without the operator bearer stays unauthorized and decides nothing", () => {
  const closes: Array<() => void> = [];
  afterEach(() => { for (const close of closes.splice(0)) close(); });

  async function daemon() {
    const home = mkdtempSync(join(tmpdir(), "tui-action-auth-"));
    const db = new Database(join(home, "queue.sqlite")); migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    const registry = { ok: true as const, entities: [{ entityId: "pair-person", class: "human" as const, displayName: "Pairing person",
      address: PERSON, connectorBindings: [], prefs: { deliveryClass: "A" as const } }] };
    const validateRig = makeTopologyDestinationCheck({ findRigsByName: () => [], loadHumanRegistry: () => registry, sharedChannels: () => [] });
    const repo = new QueueRepository(db, bus, { validateRig, loadHumanRegistry: () => registry,
      transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); c.set("eventBus" as never, bus as never);
      c.set("missionControlWriteContract" as never, contract as never); await next(); });
    app.route("/api/mission-control", missionControlRoutes({ bearerToken: ACTION }));
    app.route("/api/hosts", hostsRoutes({ bearerToken: ACTION, humanRegistry: () => registry }));
    closes.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => app.fetch(new Request(String(url), init))) as typeof fetch;
    const issued = await (await fetchImpl("http://daemon/api/hosts/pair-request", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requester: "requester@far-host" }) })).json() as { pairId: string; approvalQitemId: string };
    const poll = async () => (await (await fetchImpl(`http://daemon/api/hosts/pair-request/${issued.pairId}`)).json()) as { status: string };
    const tui = (action: Record<string, string> | undefined) => new DaemonClient({ baseUrl: "http://daemon", fetchImpl,
      headers: () => ({ Authorization: `Bearer ${TERMINAL}` }), ...(action ? { actionHeaders: () => action } : {}) });
    // The TUI's act: the primary user at the terminal, with no seat header.
    const approve = (client: DaemonClient) => client.missionControlAction({ verb: "answer", qitemId: issued.approvalQitemId,
      actorSession: PERSON, questionId: "pair", optionId: "approve", authority: "primary-user" });
    return { repo, issued, poll, tui, approve };
  }

  it.each([
    ["the terminal token only (the old wiring)", undefined],
    ["a wrong operator bearer", { Authorization: "Bearer synthetic-wrong-bearer" }],
    ["no credential at all", {}],
  ] as const)("%s: 401 with what to set and no token in it, and the request stays pending", async (_label, action) => {
    const d = await daemon();
    const refused = await d.approve(d.tui(action)).then(() => null, (err: Error) => err.message);
    expect(refused).toBe(ACTION_UNAUTHORIZED);
    expect(refused).not.toContain(ACTION);
    expect(refused).not.toContain(TERMINAL);
    expect(d.repo.getById(d.issued.approvalQitemId)).toMatchObject({ state: "pending" });
    expect(d.repo.getById(d.issued.approvalQitemId)?.humanAnswers?.pair).toBeUndefined();
    expect(await d.poll()).toMatchObject({ status: "pending" });
  });

  it("with the operator bearer, the person's Approve is recorded and kept for a receiving agent; it doesn't decide the agent-free request", async () => {
    const d = await daemon();
    await d.approve(d.tui({ Authorization: `Bearer ${ACTION}` }));
    expect(d.repo.getById(d.issued.approvalQitemId)).toMatchObject({ state: "done", humanAnswers: { pair: "approve" } });
    expect(await d.poll()).toMatchObject({ status: "pending" });
  });

  it("the settings page's direct decision takes the operator bearer: without it nothing is decided, with it the request is approved", async () => {
    const d = await daemon();
    const refused = await d.tui({ Authorization: `Bearer ${TERMINAL}` }).pairDecision(d.issued.approvalQitemId, "approve");
    expect(refused.status).toBe(401);
    expect(await d.poll()).toMatchObject({ status: "pending" });
    const decided = await d.tui({ Authorization: `Bearer ${ACTION}` }).pairDecision(d.issued.approvalQitemId, "approve");
    expect(decided).toMatchObject({ status: 200, body: { ok: true, decision: "approve" } });
    expect(await d.poll()).toMatchObject({ status: "approved" });
  });
});
