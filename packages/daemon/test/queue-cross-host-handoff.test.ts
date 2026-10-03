// OPR.0.4.6.MH3 C2 — cross-host queue HANDOFF choreography (message-passing,
// arch Q-c order) + the D-1 deterministic successor id. The load-bearing pins:
//   - no-host / "local" handoff = today's LOCAL transactional close+create,
//     byte-identical (FR-6);
//   - cross-host: successor-create is forwarded FIRST (D-1 derived id, chain
//     continued, provenance tags, nudge forwarded, hostId stripped), the
//     LOCAL source closes SECOND (closure_target = host-qualified successor id,
//     handed_off_to stays 2-part — BR-1/R1);
//   - NEVER-DROP: a failed forward (unreachable/unknown/ssh) leaves the
//     source UNTOUCHED — the potato stays live;
//   - re-drive: a source already closed toward the MATCHING closure_target
//     absorbs idempotently (forward re-fires with the SAME derived id and
//     absorbs on the target PK); a re-drive naming a DIFFERENT destination
//     conflicts BEFORE any forward (never manufactures a target-side orphan
//     for an un-completable re-drive);
//   - /handoff closes the source `handed-off`; /handoff-and-complete closes
//     it `done` — same choreography, one mechanism.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { EventBus } from "../src/domain/event-bus.js";
import {
  QueueRepository,
  deriveCrossHostSuccessorId,
} from "../src/domain/queue-repository.js";
import { queueRoutes, CROSS_HOST_TAG } from "../src/routes/queue.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "MH3B" },
    { id: "ssh-1", transport: "ssh", target: "x.local" },
  ],
};
process.env["MH3B"] = "remote-token";

function jsonResponse(payload: unknown, status = 201): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeHarness(opts?: { fetchImpl?: typeof fetch; registry?: HostRegistry; destinationAdvisory?: QueueRepository["destinationAdvisory"] }) {
  const db = createDb();
  migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, destinationAdvisory: opts?.destinationAdvisory });
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("eventBus", bus);
    set("queueRepo", repo);
    set("hostRegistryLoader", () => ({ ok: true, registry: opts?.registry ?? REGISTRY }));
    if (opts?.fetchImpl) set("remoteFetchImpl", opts.fetchImpl);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  return { db, bus, repo, app };
}

function post(app: Hono, path: string, body: Record<string, unknown>) {
  // P21 I3: handoff/create derive the sender from the transport header; header==body claim ⇒ tolerated.
  const sender = body["fromSession"] ?? body["sourceSession"] ?? body["actorSession"];
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sender ? { "X-OpenRig-Session": String(sender) } : {}) },
    body: JSON.stringify(body),
  });
}

function rowCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) c FROM queue_items").get() as { c: number }).c;
}

async function seedSource(repo: QueueRepository, over?: Partial<{ qitemId: string; tags: string[]; chainOfRecord: string[] }>) {
  return repo.create({
    qitemId: over?.qitemId ?? "qitem-source-1",
    sourceSession: "orch@rig-a",
    destinationSession: "worker@rig-a",
    body: "carry the potato",
    tags: over?.tags,
    chainOfRecord: over?.chainOfRecord,
    nudge: false,
  });
}

const HANDOFF = { fromSession: "worker@rig-a", toSession: "dev@rig-b" };

describe("MH-3 C2 — cross-host handoff (route choreography)", () => {
  let h: ReturnType<typeof makeHarness>;
  afterEach(() => h?.db.close());

  it.each(["handoff", "handoff-and-complete"])("cross-host %s closes the source when the receiving advisory throws", async (verb) => {
    const remote = makeHarness({ destinationAdvisory: () => { throw new Error("unexpected stored snapshot shape"); } });
    try {
      h = makeHarness({ fetchImpl: (async (url, init) => remote.app.request(new URL(String(url)).pathname, init)) as typeof fetch });
      await seedSource(h.repo);
      const response = await post(h.app, `/api/queue/qitem-source-1/${verb}`, { ...HANDOFF, hostId: "vps-b", nudge: false });
      expect(response.status).toBe(201);
      const result = await response.json();
      expect(result.created.advisories).toBeUndefined();
      expect(remote.repo.getById(result.created.qitemId)?.destinationSession).toBe(HANDOFF.toSession);
      expect(h.repo.getById("qitem-source-1")?.state).toBe(verb === "handoff" ? "handed-off" : "done");
      expect(rowCount(remote.db)).toBe(1);
      expect(rowCount(h.db)).toBe(1);
    } finally { remote.db.close(); }
  });

  it("no-host handoff: today's LOCAL transactional path — closed+created both local, no forward (FR-6 zero-regression)", async () => {
    let forwarded = false;
    h = makeHarness({ fetchImpl: (async () => { forwarded = true; return jsonResponse({}); }) as unknown as typeof fetch });
    await seedSource(h.repo);
    const res = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, nudge: false });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { closed: { state: string; closureTarget: string }; created: { qitemId: string } };
    expect(out.closed.state).toBe("handed-off");
    // Local close keeps the 2-part closure_target (unchanged local semantics).
    expect(out.closed.closureTarget).toBe("dev@rig-b");
    // Local successor row exists — two rows total, organic id (not xh-derived).
    expect(rowCount(h.db)).toBe(2);
    expect(out.created.qitemId).not.toMatch(/^qitem-xh-/);
    expect(forwarded).toBe(false);
  });

  it('hostId "local": same local path, no forward', async () => {
    let forwarded = false;
    h = makeHarness({ fetchImpl: (async () => { forwarded = true; return jsonResponse({}); }) as unknown as typeof fetch });
    await seedSource(h.repo);
    const res = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "local", nudge: false });
    expect(res.status).toBe(201);
    expect(rowCount(h.db)).toBe(2);
    expect(forwarded).toBe(false);
  });

  it("cross-host handoff: successor forwarded FIRST; source closes SECOND with a host-qualified successor key and 2-part handed_off_to", async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    h = makeHarness({
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        capture.url = String(url);
        capture.body = JSON.parse(String(init?.body));
        return jsonResponse({ qitemId: String(capture.body?.["qitemId"]), destinationSession: "dev@rig-b", state: "pending" }, 201);
      }) as unknown as typeof fetch,
    });
    await seedSource(h.repo, { tags: ["keep"], chainOfRecord: ["qitem-root"] });

    const res = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "vps-b", nudge: true });
    expect(res.status).toBe(201);

    // Forwarded to the origin's CREATE route (the one shared mechanism).
    expect(capture.url).toContain("/api/queue/create");
    // D-1: the derived, namespaced successor id — deterministic and equal to
    // the exported derivation.
    const expectedId = deriveCrossHostSuccessorId("qitem-source-1", "dev@rig-b", "vps-b");
    expect(capture.body?.["qitemId"]).toBe(expectedId);
    expect(String(capture.body?.["qitemId"])).toMatch(/^qitem-xh-[0-9a-f]{16}$/);
    // Chain continued through the forwarded body (R2b — opaque lineage ids).
    expect(capture.body?.["chainOfRecord"]).toEqual(["qitem-root", "qitem-source-1"]);
    // D-4 provenance appended; existing tag preserved.
    expect(capture.body?.["tags"]).toContain(CROSS_HOST_TAG);
    expect(capture.body?.["tags"]).toContain("keep");
    // Whole-body semantics: nudge forwarded; hostId stripped (BR-1).
    expect(capture.body?.["nudge"]).toBe(true);
    expect("hostId" in (capture.body ?? {})).toBe(false);
    // Source/destination on the forwarded body stay 2-part session strings.
    expect(capture.body?.["sourceSession"]).toBe("worker@rig-a");
    expect(capture.body?.["destinationSession"]).toBe("dev@rig-b");

    // Response pairs the LOCAL close with the origin's VERBATIM successor.
    const out = (await res.json()) as {
      closed: { qitemId: string; state: string; closureReason: string; closureTarget: string; handedOffTo: string };
      created: { qitemId: string };
    };
    expect(out.created.qitemId).toBe(expectedId);
    expect(out.closed.qitemId).toBe("qitem-source-1");
    expect(out.closed.state).toBe("handed-off");
    expect(out.closed.closureReason).toBe("handed_off_to");
    // Closure target carries the host-qualified successor identity.
    expect(out.closed.closureTarget).toBe(`${expectedId}@vps-b`);
    // ...while the session-string carrier stays 2-part (BR-1).
    expect(out.closed.handedOffTo).toBe("dev@rig-b");

    // Origin-owns-the-record: NO local successor row — only the closed source.
    expect(rowCount(h.db)).toBe(1);
    // BR-1 negative at the persisted layer: no @host in any session carrier.
    const row = h.db
      .prepare("SELECT source_session s, destination_session d, blocked_on b, handed_off_to ho FROM queue_items WHERE qitem_id = 'qitem-source-1'")
      .get() as { s: string; d: string; b: string | null; ho: string };
    for (const v of [row.s, row.d, row.b, row.ho]) {
      if (v) expect(v.split("@").length).toBeLessThanOrEqual(2);
    }
  });

  it("handoff-and-complete cross-host: same choreography, source closes `done`", async () => {
    h = makeHarness({
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ qitemId: b["qitemId"] }, 201);
      }) as unknown as typeof fetch,
    });
    await seedSource(h.repo);
    const res = await post(h.app, "/api/queue/qitem-source-1/handoff-and-complete", { ...HANDOFF, hostId: "vps-b", nudge: false });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { closed: { state: string; closureTarget: string } };
    expect(out.closed.state).toBe("done");
    expect(out.closed.closureTarget).toBe(`${deriveCrossHostSuccessorId("qitem-source-1", "dev@rig-b", "vps-b")}@vps-b`);
    expect(rowCount(h.db)).toBe(1);
  });

  it("NEVER-DROP: forward fails (unreachable) → 502 structured, source UNTOUCHED (still pending, no close transition)", async () => {
    h = makeHarness({ fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    await seedSource(h.repo);
    const res = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "vps-b" });
    expect(res.status).toBe(502);
    expect((await res.json()) as { failureClass: string }).toMatchObject({ error: "remote_queue_write_failed", failureClass: "unreachable" });
    const source = h.repo.getById("qitem-source-1")!;
    expect(source.state).toBe("pending");
    expect(source.closureTarget).toBeNull();
    expect(rowCount(h.db)).toBe(1);
  });

  it("unknown host / ssh host: structured 502, source untouched", async () => {
    h = makeHarness();
    await seedSource(h.repo);
    const unknown = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "nope" });
    expect(unknown.status).toBe(502);
    expect((await unknown.json()) as { failureClass: string }).toMatchObject({ failureClass: "unknown-host" });
    const ssh = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "ssh-1" });
    expect(ssh.status).toBe(502);
    expect((await ssh.json()) as { failureClass: string }).toMatchObject({ failureClass: "unsupported-transport" });
    expect(h.repo.getById("qitem-source-1")!.state).toBe("pending");
  });

  it("re-drive absorb (FR-5, the interrupted-close case): second run re-forwards the SAME derived id and absorbs the already-closed source — one close, 201 converged", async () => {
    const forwardedIds: unknown[] = [];
    h = makeHarness({
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        forwardedIds.push(b["qitemId"]);
        return jsonResponse({ qitemId: b["qitemId"] }, 201);
      }) as unknown as typeof fetch,
    });
    await seedSource(h.repo);
    const first = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "vps-b" });
    expect(first.status).toBe(201);
    const tsAfterFirst = h.repo.getById("qitem-source-1")!.tsUpdated;

    const redrive = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "vps-b" });
    expect(redrive.status).toBe(201);
    // Same operation identity on both drives — the target-side PK absorbs.
    expect(forwardedIds).toHaveLength(2);
    expect(forwardedIds[0]).toBe(forwardedIds[1]);
    // The local source closed exactly once (absorb = no second write).
    const source = h.repo.getById("qitem-source-1")!;
    expect(source.state).toBe("handed-off");
    expect(source.tsUpdated).toBe(tsAfterFirst);
    const closeTransitions = h.repo.transitionLog
      .listForQitem("qitem-source-1")
      .filter((t) => t.state === "handed-off");
    expect(closeTransitions).toHaveLength(1);
  });

  it("prospective key grandfather: a pre-convention terminal source re-drives against its stored member@rig@host target without rewriting history", async () => {
    h = makeHarness({
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ qitemId: b["qitemId"] }, 201);
      }) as unknown as typeof fetch,
    });
    await seedSource(h.repo);
    h.repo.closeCrossHostHandoffSource({
      qitemId: "qitem-source-1",
      fromSession: "worker@rig-a",
      toSession: "dev@rig-b",
      closureTarget: "dev@rig-b@vps-b",
      terminalState: "handed-off",
    });

    const redrive = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "vps-b" });
    expect(redrive.status).toBe(201);
    expect(h.repo.getById("qitem-source-1")!.closureTarget).toBe("dev@rig-b@vps-b");
  });

  it("re-drive naming a DIFFERENT destination: 409 cross_host_close_conflict BEFORE any forward (no target-side orphan minted)", async () => {
    let forwardCount = 0;
    h = makeHarness({
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        forwardCount += 1;
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ qitemId: b["qitemId"] }, 201);
      }) as unknown as typeof fetch,
    });
    await seedSource(h.repo);
    const first = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "vps-b" });
    expect(first.status).toBe(201);
    expect(forwardCount).toBe(1);

    const conflicted = await post(h.app, "/api/queue/qitem-source-1/handoff", { fromSession: "worker@rig-a", toSession: "SOMEONE@rig-z", hostId: "vps-b" });
    expect(conflicted.status).toBe(409);
    expect((await conflicted.json()) as { error: string }).toMatchObject({ error: "cross_host_close_conflict" });
    // The pre-flight fired BEFORE the forward — no orphan successor minted.
    expect(forwardCount).toBe(1);
    // The recorded closure is untouched.
    expect(h.repo.getById("qitem-source-1")!.closureTarget).toBe(
      `${deriveCrossHostSuccessorId("qitem-source-1", "dev@rig-b", "vps-b")}@vps-b`,
    );
  });

  it("unknown source qitem: 404, nothing forwarded", async () => {
    let forwarded = false;
    h = makeHarness({ fetchImpl: (async () => { forwarded = true; return jsonResponse({}); }) as unknown as typeof fetch });
    const res = await post(h.app, "/api/queue/qitem-ghost/handoff", { ...HANDOFF, hostId: "vps-b" });
    expect(res.status).toBe(404);
    expect(forwarded).toBe(false);
  });
});

describe("MH-3 C2 — deriveCrossHostSuccessorId (D-1)", () => {
  it("deterministic + namespaced: same (source,dest,host) → same id; any argument change → different id", () => {
    const a = deriveCrossHostSuccessorId("qitem-s", "dev@rig-b", "vps-b");
    expect(a).toBe(deriveCrossHostSuccessorId("qitem-s", "dev@rig-b", "vps-b"));
    expect(a).toMatch(/^qitem-xh-[0-9a-f]{16}$/);
    expect(a).not.toBe(deriveCrossHostSuccessorId("qitem-s2", "dev@rig-b", "vps-b"));
    expect(a).not.toBe(deriveCrossHostSuccessorId("qitem-s", "dev2@rig-b", "vps-b"));
    expect(a).not.toBe(deriveCrossHostSuccessorId("qitem-s", "dev@rig-b", "vps-c"));
  });
});

describe("MH-3 C2 — closeCrossHostHandoffSource (repo, re-drive semantics)", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.db.close());

  it("non-terminal source: closes with handed_off_to=2-part, closure_target=host-qualified successor, closure_reason=handed_off_to", async () => {
    await seedSource(h.repo);
    const closureTarget = `${deriveCrossHostSuccessorId("qitem-source-1", "dev@rig-b", "vps-b")}@vps-b`;
    const out = h.repo.closeCrossHostHandoffSource({
      qitemId: "qitem-source-1",
      fromSession: "worker@rig-a",
      toSession: "dev@rig-b",
      closureTarget,
      terminalState: "handed-off",
    });
    expect(out.absorbed).toBe(false);
    expect(out.item.state).toBe("handed-off");
    expect(out.item.closureReason).toBe("handed_off_to");
    expect(out.item.closureTarget).toBe(closureTarget);
    expect(out.item.handedOffTo).toBe("dev@rig-b");
  });

  it("already-terminal + MATCHING closure_target: idempotent absorb — stored row returned, no mutation", async () => {
    await seedSource(h.repo);
    const closureTarget = `${deriveCrossHostSuccessorId("qitem-source-1", "dev@rig-b", "vps-b")}@vps-b`;
    h.repo.closeCrossHostHandoffSource({
      qitemId: "qitem-source-1", fromSession: "worker@rig-a", toSession: "dev@rig-b",
      closureTarget, terminalState: "done",
    });
    const ts = h.repo.getById("qitem-source-1")!.tsUpdated;
    const out = h.repo.closeCrossHostHandoffSource({
      qitemId: "qitem-source-1", fromSession: "worker@rig-a", toSession: "dev@rig-b",
      closureTarget, terminalState: "done",
    });
    expect(out.absorbed).toBe(true);
    expect(out.item.tsUpdated).toBe(ts);
  });

  it("already-terminal + MISMATCHED closure_target: structured cross_host_close_conflict, never overwritten", async () => {
    await seedSource(h.repo);
    const closureTarget = `${deriveCrossHostSuccessorId("qitem-source-1", "dev@rig-b", "vps-b")}@vps-b`;
    h.repo.closeCrossHostHandoffSource({
      qitemId: "qitem-source-1", fromSession: "worker@rig-a", toSession: "dev@rig-b",
      closureTarget, terminalState: "handed-off",
    });
    expect(() =>
      h.repo.closeCrossHostHandoffSource({
        qitemId: "qitem-source-1", fromSession: "worker@rig-a", toSession: "other@rig-c",
        closureTarget: `${deriveCrossHostSuccessorId("qitem-source-1", "other@rig-c", "vps-b")}@vps-b`, terminalState: "handed-off",
      }),
    ).toThrowError(expect.objectContaining({ code: "cross_host_close_conflict" }));
    expect(h.repo.getById("qitem-source-1")!.closureTarget).toBe(closureTarget);
  });
});


it("reconciles a verified foreign successor after interrupted transport without duplicate work", async () => {
  const foreign = makeHarness();
  let interrupt = true;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const response = await foreign.app.fetch(new Request(`http://localhost${req.url}`, {
        method: req.method, headers,
        ...(req.method === "GET" ? {} : { body: Buffer.concat(chunks).toString("utf8") }),
      }));
      // Commit the actual foreign queue create, then lose only its response.
      if (interrupt) { interrupt = false; req.socket.destroy(); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  let local: ReturnType<typeof makeHarness> | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    local = makeHarness({ registry: { hosts: [{ id: "remote", transport: "http", url }] } });
    const source = await seedSource(local.repo);
    const body = { fromSession: "worker@rig-a", toSession: "dev@rig-b", hostId: "remote", nudge: false };
    const path = `/api/queue/${source.qitemId}/handoff-and-complete`;
    expect((await post(local.app, path, body)).status).toBe(502);
    expect(local.repo.getById(source.qitemId)?.state).toBe("pending");
    expect(rowCount(foreign.db)).toBe(1);
    const successor = foreign.repo.list({ limit: 100 })[0]!;
    const confirmation = await fetch(`${url}/api/queue/${successor.qitemId}`);
    expect(confirmation.status).toBe(200);
    expect(await confirmation.json()).toMatchObject({ state: "pending", chainOfRecord: [source.qitemId] });

    const repaired = await post(local.app, `/api/queue/${source.qitemId}/update`, {
      actorSession: "worker@rig-a", state: "done", closureReason: "handed_off_to",
      closureTarget: `${successor.qitemId}@remote`, transitionNote: "foreign successor confirmed by ID",
    });
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({ state: "done",
      handoffAdvisory: { status: "unverified", reason: "no-live-local-successor" } });
    // A verified create response establishes that attempt's outcome, not an
    // ongoing local read of remote custody. Existing re-drive remains idempotent.
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await post(local.app, path, body);
      expect(retry.status).toBe(201);
      expect(await retry.json()).toMatchObject({ created: { qitemId: successor.qitemId },
        closed: { handoffAdvisory: { status: "unverified" } } });
    }
    expect(rowCount(local.db)).toBe(1);
    expect(rowCount(foreign.db)).toBe(1);
    expect(local.repo.getById(source.qitemId)?.closureTarget).toBe(`${successor.qitemId}@remote`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    local?.db.close(); foreign.db.close();
  }
});

// A handoff whose host envelope names the RECEIVING daemon's own resolved id is a local handoff:
// the same atomic close+create record as a no-host handoff, with no forward, extra write or nudge.
describe("cross-host handoff addressed to the receiving daemon's own host id", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => setSelfHostId("host-self"));
  afterEach(() => {
    setSelfHostId(null);
    h?.db.close();
  });

  async function runLocal(verb: string, hostId?: string) {
    let forwarded = false;
    const local = makeHarness({ fetchImpl: (async () => { forwarded = true; return jsonResponse({}); }) as unknown as typeof fetch });
    try {
      await seedSource(local.repo, { tags: ["origin-tag"] });
      const res = await post(local.app, `/api/queue/qitem-source-1/${verb}`, { ...HANDOFF, ...(hostId ? { hostId } : {}), nudge: false });
      const out = (await res.json()) as { created?: { qitemId: string }; failureClass?: string };
      const source = local.repo.getById("qitem-source-1")!;
      const successor = out.created ? local.repo.getById(out.created.qitemId) : null;
      const count = (sql: string) => (local.db.prepare(sql).get() as { c: number }).c;
      return {
        status: res.status, failureClass: out.failureClass, forwarded, rows: rowCount(local.db),
        transitions: count("SELECT COUNT(*) c FROM queue_transitions"),
        nudges: count("SELECT COUNT(*) c FROM queue_items WHERE last_nudge_attempt IS NOT NULL OR last_nudge_result IS NOT NULL"),
        source: { state: source.state, closureReason: source.closureReason, closureTarget: source.closureTarget, handedOffTo: source.handedOffTo },
        successor: successor && {
          organicId: !successor.qitemId.startsWith("qitem-xh-"), sourceSession: successor.sourceSession,
          destinationSession: successor.destinationSession, tags: successor.tags, chainOfRecord: successor.chainOfRecord,
        },
      };
    } finally { local.db.close(); }
  }

  it.each(["handoff", "handoff-and-complete"])("%s with the exact self id keeps the no-host local record", async (verb) => {
    const baseline = await runLocal(verb);
    const self = await runLocal(verb, "host-self");
    expect(self).toEqual(baseline);
    expect(self.status).toBe(201);
    expect(self.forwarded).toBe(false);
    expect(self.source.closureTarget).toBe("dev@rig-b");
    expect(self.successor?.tags ?? []).not.toContain(CROSS_HOST_TAG);
  });

  it.each([
    ["handoff", "Host-Self", "host-self"],
    ["handoff-and-complete", "Host-Self", "host-self"],
    ["handoff", "host-self", null],
    ["handoff-and-complete", "host-self", null],
  ] as const)("%s to %s with self id %s: unknown-host as today, source untouched", async (verb, hostId, self) => {
    setSelfHostId(self);
    h = makeHarness();
    await seedSource(h.repo);
    const res = await post(h.app, `/api/queue/qitem-source-1/${verb}`, { ...HANDOFF, hostId, nudge: false });
    expect(res.status).toBe(502);
    expect((await res.json()) as { failureClass: string }).toMatchObject({ failureClass: "unknown-host" });
    expect(h.repo.getById("qitem-source-1")!.state).toBe("pending");
    expect(rowCount(h.db)).toBe(1);
  });
});
