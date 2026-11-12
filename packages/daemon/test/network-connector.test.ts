// The outbound connector against a hub that behaves like an external grant's queue: it lists the participant's own items,
// a claim moves an item out of pending, and a close stores the resolution. Each test counts the local queue items that
// carry a hub item: a lost answer, a restart, a rebinding or a revoke must never make a second one. No agent consumes
// these items here, so the cells prove one local item per hub item, not one agent run.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { NetworkBindingStore, networkCredentialFile } from "../src/domain/network/network-bindings.js";
import { Hono } from "hono";
import { connectMcpHub, HubError, type HubConnect, type HubItem, type HubSession } from "../src/domain/network/hub-client.js";
import { networkRoutes } from "../src/routes/network.js";
import { NetworkConnectorService, networkClosedElsewhere, networkLocalItemId, runNetworkBindingPass, type NetworkConnectorDeps } from "../src/domain/network/network-connector.js";

const PARTICIPANT = "alex@team";

class FakeHub {
  readonly items = new Map<string, HubItem & { notes: string[] }>();
  readonly tokens: string[] = [];
  revoked = false;
  down = false;
  /** The next claim or close of these ids takes effect, then its answer is lost. */
  readonly loseClaimAnswer = new Set<string>();
  readonly loseCloseAnswer = new Set<string>();
  /** The next note on these ids fails; later ones land. */
  readonly failNote = new Set<string>();
  /** Shows of these ids wait until the pass closes its connection. */
  readonly stallShow = new Set<string>();
  /** Runs while a show is waiting on the hub, before it answers. */
  duringShow: ((id: string) => void) | null = null;
  /** Someone else closes these items just as ours arrives: the hub keeps theirs and answers ours as done. */
  readonly raceClose = new Map<string, Partial<HubItem>>();
  closes = 0;

  add(qitemId: string, body = "Summarize the release notes", destination = PARTICIPANT): void {
    this.items.set(qitemId, { qitemId, sourceSession: "assistant@team", destinationSession: destination, state: "pending", body, summary: body, resolution: null, closureReason: null, notes: [] });
  }

  readonly connect: HubConnect = async (_url, token, signal) => {
    this.tokens.push(token);
    if (this.revoked) throw new HubError("revoked", "The hub refused this participant's credential.");
    if (this.down) throw new HubError("unavailable", "The hub couldn't be reached: connect ECONNREFUSED");
    const get = (id: string) => {
      const item = this.items.get(id);
      if (!item) throw new HubError("refused", `qitem_not_found ${id}`);
      return item;
    };
    const session: HubSession = {
      listOwned: async (state, limit) => [...this.items.values()].filter((i) => i.destinationSession === PARTICIPANT && i.state === state).slice(0, limit)
        .map(({ notes: _notes, ...item }) => ({ ...item, body: null })),
      claim: async (id) => {
        const item = get(id);
        if (item.state !== "pending") throw new HubError("refused", `qitem ${id} is ${item.state}`);
        item.state = "in-progress";
        if (this.loseClaimAnswer.delete(id)) throw new HubError("unavailable", "The hub couldn't be reached: socket hang up");
      },
      show: async (id) => {
        this.duringShow?.(id);
        if (this.stallShow.has(id)) {
          await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new HubError("unavailable", "The hub couldn't be reached: closed")), { once: true }));
        }
        const { notes: _notes, ...item } = get(id);
        return { ...item };
      },
      note: async (id, note) => {
        if (this.failNote.delete(id)) throw new HubError("unavailable", "The hub couldn't be reached: socket hang up");
        get(id).notes.push(note);
      },
      close: async (id, input) => {
        this.closes++;
        const item = get(id);
        if (["done", "canceled", "denied", "failed"].includes(item.state)) throw new HubError("refused", `qitem ${id} is already closed`);
        const theirs = this.raceClose.get(id);
        if (theirs) { Object.assign(item, theirs); return; }
        Object.assign(item, { state: input.state, closureReason: input.closureReason, resolution: input.resolution });
        if (this.loseCloseAnswer.delete(id)) throw new HubError("unavailable", "The hub couldn't be reached: socket hang up");
      },
      end: async () => {},
    };
    return session;
  };
}

describe("network connector", () => {
  let db: Database.Database;
  let home: string;
  let repo: QueueRepository;
  let bindings: NetworkBindingStore;
  let hub: FakeHub;
  let deps: NetworkConnectorDeps;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const rigs = new RigRepository(db);
    const node = rigs.addNode(rigs.createRig("lab").id, "impl", { runtime: "claude-code" });
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', ?, 'dev-impl@lab', 'running')").run(node.id);
    home = mkdtempSync(join(tmpdir(), "openrig-connector-"));
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    bindings = new NetworkBindingStore(db, home);
    hub = new FakeHub();
    deps = { db, queueRepo: repo, bindings, home, connect: hub.connect };
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(home, { recursive: true, force: true }); });

  const bind = () => bindings.create({ session: "dev-impl@lab", hubUrl: "https://hub.example/mcp", hubSeat: PARTICIPANT, token: "tok-1" });
  const pass = (bindingId: string) => runNetworkBindingPass(deps, bindings.get(bindingId)!);
  /** The local items carrying this hub item. */
  const runs = (hubId: string) => repo.list({ limit: 500 }).filter((i) => (i.tags ?? []).includes(`network-hub-item:${hubId}`));

  it("takes a hub item into the bound seat once, says where it came from first, then carries pickup and the result back in order", async () => {
    const b = bind();
    hub.add("hub-1");
    const first = await pass(b.id);
    expect(first).toMatchObject({ taken: 1 });
    expect(first.error).toBeUndefined();
    expect(hub.tokens).toEqual(["tok-1"]);
    const [local] = runs("hub-1");
    expect(local).toMatchObject({ qitemId: networkLocalItemId(b, "hub-1"), sourceSession: "daemon@kernel", destinationSession: "dev-impl@lab", state: "pending",
      summary: "From assistant@team via network hub: Summarize the release notes" });
    // Where it came from is read before the requester's own words.
    expect(local!.body!.split("\n")[0]).toBe("From assistant@team through the network hub https://hub.example/mcp, as alex@team (hub item hub-1).");
    expect(local!.body).toContain("Summarize the release notes");
    // The hub claim is custody, not pickup: the item says it's queued and not picked up.
    expect(hub.items.get("hub-1")).toMatchObject({ state: "in-progress" });
    expect(hub.items.get("hub-1")!.notes).toEqual([`Queued for the connected local seat as ${local!.qitemId}. Not picked up yet.`]);
    expect(bindings.get(b.id)!.lastContactAt).not.toBeNull();

    await pass(b.id);
    expect(runs("hub-1")).toHaveLength(1);
    expect(hub.items.get("hub-1")!.notes).toHaveLength(1);

    repo.claim({ qitemId: local!.qitemId, destinationSession: "dev-impl@lab" });
    expect(await pass(b.id)).toMatchObject({ pickupsSent: 1, resultsSent: 0 });
    expect(hub.items.get("hub-1")!.notes.at(-1)).toMatch(/^Picked up by the local seat at /);

    await repo.update({ qitemId: local!.qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "no-follow-on", resolution: "Three changes; none breaking." });
    expect(await pass(b.id)).toMatchObject({ resultsSent: 1 });
    expect(hub.items.get("hub-1")).toMatchObject({ state: "done", resolution: "Three changes; none breaking." });
    await pass(b.id);
    expect(hub.closes).toBe(1);
    expect(runs("hub-1")).toHaveLength(1);
  });

  it("a claim whose answer was lost: the next pass finds the item it holds and makes its one local item", async () => {
    const b = bind();
    hub.add("hub-2");
    hub.loseClaimAnswer.add("hub-2");
    expect(await pass(b.id)).toMatchObject({ taken: 0, error: "unavailable" });
    expect(runs("hub-2")).toHaveLength(0);
    expect(bindings.get(b.id)!.state).toBe("active");
    expect(await pass(b.id)).toMatchObject({ taken: 1 });
    expect(runs("hub-2")).toHaveLength(1);
    await pass(b.id);
    expect(runs("hub-2")).toHaveLength(1);
  });

  it("a restart between the local create and its receipt finds the same local item, not a second one", async () => {
    const b = bind();
    hub.add("hub-3");
    hub.items.get("hub-3")!.state = "in-progress"; // claimed before the restart
    await repo.create({ qitemId: networkLocalItemId(b, "hub-3"), sourceSession: "daemon@kernel", destinationSession: "dev-impl@lab", body: "already made",
      tags: [`network-binding:${b.id}`, "network-hub-item:hub-3"] });
    await pass(b.id);
    expect(runs("hub-3")).toHaveLength(1);
    expect(runs("hub-3")[0]!.body).toBe("already made");
    expect(db.prepare("SELECT count(*) AS n FROM network_receipts WHERE hub_qitem_id = 'hub-3'").get()).toEqual({ n: 1 });
  });

  it("a close whose answer was lost is seen closed on the next pass and recorded as sent, without closing twice", async () => {
    const b = bind();
    hub.add("hub-4");
    await pass(b.id);
    const [local] = runs("hub-4");
    await repo.update({ qitemId: local!.qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "no-follow-on", resolution: "done it" });
    hub.loseCloseAnswer.add("hub-4");
    expect(await pass(b.id)).toMatchObject({ error: "unavailable" });
    expect(hub.items.get("hub-4")).toMatchObject({ state: "done", resolution: "done it" });
    const settled = await pass(b.id);
    expect(settled).toMatchObject({ resultsSent: 1 });
    expect(settled.error).toBeUndefined();
    expect(hub.items.get("hub-4")!.resolution).toBe("done it");
    expect(db.prepare("SELECT outcome, settled_at IS NOT NULL AS sent FROM network_receipts WHERE hub_qitem_id = 'hub-4'").get()).toEqual({ outcome: "done", sent: 1 });
  });

  it("a revoked credential ends the binding: no new work comes in, and the work already taken stays", async () => {
    const b = bind();
    hub.add("hub-5");
    await pass(b.id);
    hub.revoked = true;
    expect(await pass(b.id)).toMatchObject({ error: "revoked" });
    expect(bindings.get(b.id)).toMatchObject({ state: "revoked" });
    expect(existsSync(networkCredentialFile(home, b.id))).toBe(false);
    hub.revoked = false;
    hub.add("hub-6");
    const service = new NetworkConnectorService(deps, { intervalMs: 1000 });
    await service.round();
    expect(runs("hub-6")).toHaveLength(0);
    expect(runs("hub-5")).toHaveLength(1);
    expect(hub.items.get("hub-6")!.state).toBe("pending");
  });

  it("an unreachable hub is recorded, the binding stays active, and its next pass waits out a growing backoff", async () => {
    const b = bind();
    hub.down = true;
    let now = new Date("2026-11-11T19:00:00.000Z");
    const service = new NetworkConnectorService({ ...deps, now: () => now }, { intervalMs: 30_000, random: () => 0.5 });
    await service.round();
    expect(bindings.get(b.id)).toMatchObject({ state: "active", lastError: "The hub couldn't be reached: connect ECONNREFUSED" });
    expect(service.snapshot().bindings[0]).toMatchObject({ id: b.id, backoffMs: 60_000, lastPass: expect.objectContaining({ error: "unavailable" }) });
    const attempts = hub.tokens.length;
    now = new Date(now.getTime() + 30_000);
    await service.round();
    expect(hub.tokens.length).toBe(attempts);
    now = new Date(now.getTime() + 30_001);
    await service.round();
    expect(hub.tokens.length).toBe(attempts + 1);
    expect(service.snapshot().bindings[0]!.backoffMs).toBe(120_000);
    hub.down = false;
    now = new Date(now.getTime() + 120_001);
    await service.round();
    expect(service.snapshot().bindings[0]!.backoffMs).toBe(30_000);
    expect(bindings.get(b.id)!.lastError).toBeNull();
  });

  it("a local item whose record is gone reads unknown on the hub and is never run again", async () => {
    const b = bind();
    hub.add("hub-7");
    await pass(b.id);
    const [local] = runs("hub-7");
    db.prepare("DELETE FROM queue_items WHERE qitem_id = ?").run(local!.qitemId);
    expect(await pass(b.id)).toMatchObject({ unknown: 1 });
    expect(hub.items.get("hub-7")!.notes.at(-1)).toBe(`This item's local record (${local!.qitemId}) is gone, so whether it ran is unknown. It won't be run again.`);
    expect(hub.items.get("hub-7")!.state).toBe("in-progress");
    await pass(b.id);
    expect(runs("hub-7")).toHaveLength(0);
    expect(db.prepare("SELECT outcome FROM network_receipts WHERE hub_qitem_id = 'hub-7'").get()).toEqual({ outcome: "unknown" });
  });

  it("a seat with no session leaves its hub items pending and says why; once it has one, work goes to its current address", async () => {
    const b = bind();
    hub.add("hub-8");
    db.prepare("DELETE FROM sessions WHERE node_id = ?").run(b.nodeId);
    expect(await pass(b.id)).toMatchObject({ taken: 0, error: "no_session" });
    expect(hub.items.get("hub-8")).toMatchObject({ state: "pending", notes: [] });
    expect(runs("hub-8")).toHaveLength(0);
    expect(bindings.get(b.id)).toMatchObject({ state: "active", lastError: "dev-impl@lab has no session here, so its hub items stay pending until it has one." });
    // The seat comes back under another address; the binding follows its node.
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s2', ?, 'impl-v2@lab', 'running')").run(b.nodeId);
    const taken = await pass(b.id);
    expect(taken).toMatchObject({ taken: 1 });
    expect(taken.error).toBeUndefined();
    expect(runs("hub-8")).toEqual([expect.objectContaining({ destinationSession: "impl-v2@lab" })]);
    expect(bindings.get(b.id)!.lastError).toBeNull();
  });

  it("a revoke whose credential can't be removed still ends the binding, records why, and the next start sweeps it", async () => {
    const { chmodSync } = await import("node:fs");
    const b = bind();
    hub.revoked = true;
    const secrets = join(home, "network-secrets");
    chmodSync(secrets, 0o500);
    try {
      expect(await pass(b.id)).toMatchObject({ error: "revoked" });
      expect(bindings.get(b.id)!.state).toBe("revoked");
      expect(bindings.get(b.id)!.lastError).toContain(`Run \`rig network disconnect ${b.id}\` again to retry.`);
      expect(existsSync(networkCredentialFile(home, b.id))).toBe(true);
    } finally {
      chmodSync(secrets, 0o700);
    }
    const lines: string[] = [];
    const service = new NetworkConnectorService({ ...deps, log: (line) => lines.push(line) }, { intervalMs: 1000 });
    service.start();
    await service.stop();
    expect(existsSync(networkCredentialFile(home, b.id))).toBe(false);
    expect(lines).toEqual([`network connector: removed the credentials of ended bindings ${b.id}`]);
  });

  it("a plain-http binding with its recorded choice is used pass after pass, and one without a choice sends no token", async () => {
    const b = bindings.create({ session: "dev-impl@lab", hubUrl: "http://192.0.2.7:7433/mcp", hubSeat: PARTICIPANT, token: "tok-1", allowHttp: true });
    hub.add("hub-9");
    expect((await pass(b.id)).error).toBeUndefined();
    expect((await pass(b.id)).error).toBeUndefined();
    expect(hub.tokens).toEqual(["tok-1", "tok-1"]);
    expect(runs("hub-9")).toHaveLength(1);

    db.prepare("UPDATE network_bindings SET allow_http = 0 WHERE id = ?").run(b.id);
    expect(await pass(b.id)).toMatchObject({ error: "http_not_allowed" });
    expect(hub.tokens).toHaveLength(2);
    expect(bindings.get(b.id)!.lastError).toContain("--allow-http");
  });

  it("a hub that redirects to another origin gets no token there, and the error names where it pointed", async () => {
    const { createServer } = await import("node:http");
    const listen = (handler: Parameters<typeof createServer>[1]) => new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const server = createServer(handler).listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((done) => server.close(() => done())) });
      });
    });
    const elsewhere: Array<string | undefined> = [];
    const other = await listen((req, res) => { elsewhere.push(req.headers.authorization); res.writeHead(500).end(); });
    const asked: Array<string | undefined> = [];
    const hubServer = await listen((req, res) => { asked.push(req.headers.authorization); res.writeHead(307, { Location: other.url }).end(); });
    try {
      const b = bindings.create({ session: "dev-impl@lab", hubUrl: hubServer.url, hubSeat: PARTICIPANT, token: "tok-redirect", allowHttp: true });
      const result = await runNetworkBindingPass({ db, queueRepo: repo, bindings, home }, bindings.get(b.id)!);
      expect(result.error).toBe("unavailable");
      expect(asked[0]).toBe("Bearer tok-redirect");
      expect(elsewhere).toEqual([]);
      expect(bindings.get(b.id)!.lastError).toContain("redirected the connection somewhere else");
      expect(bindings.get(b.id)!.lastError).toContain(other.url);
      expect(bindings.get(b.id)!.state).toBe("active");
    } finally {
      await hubServer.close();
      await other.close();
    }
  });

  it("a local handoff's result comes back from its successor; failed and denied closes come back as themselves; no successor reads unknown", async () => {
    const b = bind();
    for (const id of ["hub-h1", "hub-h2", "hub-h3", "hub-h4"]) hub.add(id);
    await pass(b.id);
    const local = (id: string) => runs(id)[0]!;
    repo.claim({ qitemId: local("hub-h1").qitemId, destinationSession: "dev-impl@lab" });
    const { created } = await repo.handoff({ qitemId: local("hub-h1").qitemId, fromSession: "dev-impl@lab", toSession: "review@lab", nudge: false });
    repo.claim({ qitemId: created.qitemId, destinationSession: "review@lab" });
    await repo.update({ qitemId: created.qitemId, actorSession: "review@lab", state: "done", closureReason: "no-follow-on", resolution: "Reviewed: fine." });
    await repo.update({ qitemId: local("hub-h2").qitemId, actorSession: "dev-impl@lab", state: "failed", transitionNote: "The build broke." });
    // The queue's own refusal form: done with closure reason denied.
    await repo.update({ qitemId: local("hub-h3").qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "denied", resolution: "Not mine to do." });
    // Handed on with no successor here, as a handoff to another host leaves it.
    db.prepare("UPDATE queue_items SET state = 'handed-off' WHERE qitem_id = ?").run(local("hub-h4").qitemId);

    expect(await pass(b.id)).toMatchObject({ resultsSent: 3, unknown: 1 });
    expect(hub.items.get("hub-h1")).toMatchObject({ state: "done", closureReason: "no-follow-on", resolution: "Reviewed: fine." });
    expect(hub.items.get("hub-h2")).toMatchObject({ state: "failed", closureReason: null, resolution: "The build broke." });
    expect(hub.items.get("hub-h3")).toMatchObject({ state: "done", closureReason: "denied", resolution: "Not mine to do." });
    expect(hub.items.get("hub-h4")).toMatchObject({ state: "in-progress" });
    expect(hub.items.get("hub-h4")!.notes.at(-1)).toBe(`This item was handed on from ${local("hub-h4").qitemId} without one successor here, so its outcome is unknown. It won't be run again.`);
  });

  it("a disconnect while a hub answer is pending starts no local work, and work already queued stays", async () => {
    const b = bind();
    hub.add("hub-d1");
    await pass(b.id);
    hub.add("hub-d2");
    hub.duringShow = (id) => { if (id === "hub-d2") bindings.disconnect(b.id); };
    await pass(b.id);
    expect(runs("hub-d2")).toHaveLength(0);
    expect(runs("hub-d1")).toHaveLength(1);
    expect(hub.items.get("hub-d2")).toMatchObject({ state: "in-progress", notes: [] });
  });

  it("disconnecting and connecting the same seat, hub and participant again keeps one local item per hub item, unknown included", async () => {
    const first = bind();
    for (const id of ["r-queued", "r-picked", "r-done", "r-gone"]) hub.add(id);
    await pass(first.id);
    const local = (id: string) => runs(id)[0]!;
    repo.claim({ qitemId: local("r-picked").qitemId, destinationSession: "dev-impl@lab" });
    repo.claim({ qitemId: local("r-done").qitemId, destinationSession: "dev-impl@lab" });
    await repo.update({ qitemId: local("r-done").qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "no-follow-on", resolution: "Finished before the reconnect." });
    const gone = local("r-gone").qitemId;
    db.prepare("DELETE FROM queue_items WHERE qitem_id = ?").run(gone);
    bindings.disconnect(first.id);

    const second = bind();
    expect(second.id).not.toBe(first.id);
    expect(await pass(second.id)).toMatchObject({ taken: 0, pickupsSent: 2, resultsSent: 1, unknown: 1 });
    for (const id of ["r-queued", "r-picked", "r-done"]) expect(runs(id)).toHaveLength(1);
    expect(runs("r-gone")).toHaveLength(0);
    expect(hub.items.get("r-picked")!.notes.at(-1)).toMatch(/^Picked up by the local seat at /);
    expect(hub.items.get("r-done")).toMatchObject({ state: "done", resolution: "Finished before the reconnect." });
    expect(hub.items.get("r-gone")!.notes.at(-1)).toBe(`This item's local record (${gone}) is gone, so whether it ran is unknown. It won't be run again.`);
    expect(db.prepare("SELECT DISTINCT binding_id FROM network_receipts").all()).toEqual([{ binding_id: second.id }]);
    await pass(second.id);
    expect(runs("r-gone")).toHaveLength(0);
    expect(hub.items.get("r-gone")!.notes.filter((n) => n.includes("is unknown"))).toHaveLength(1);
  });

  it("a stage note that fails is sent on the next pass, and an unknown outcome is marked sent only once its note lands", async () => {
    const b = bind();
    hub.add("hub-n1");
    hub.failNote.add("hub-n1");
    expect(await pass(b.id)).toMatchObject({ taken: 1, error: "unavailable" });
    expect(hub.items.get("hub-n1")!.notes).toEqual([]);
    await pass(b.id);
    expect(hub.items.get("hub-n1")!.notes).toEqual([`Queued for the connected local seat as ${runs("hub-n1")[0]!.qitemId}. Not picked up yet.`]);

    // An id used before and erased: the queue refuses it, so whether it ran is unknown.
    hub.add("hub-n2");
    vi.spyOn(repo, "create").mockRejectedValueOnce(new QueueRepositoryError("qitem_erased", "erased"));
    hub.failNote.add("hub-n2");
    expect(await pass(b.id)).toMatchObject({ error: "unavailable" });
    const receipt = () => db.prepare("SELECT outcome, settled_at FROM network_receipts WHERE hub_qitem_id = 'hub-n2'").get() as { outcome: string; settled_at: string | null };
    expect(receipt()).toMatchObject({ outcome: "unknown", settled_at: null });
    await pass(b.id);
    expect(hub.items.get("hub-n2")!.notes).toEqual([expect.stringMatching(/is gone, so whether it ran is unknown\. It won't be run again\.$/)]);
    expect(receipt().settled_at).not.toBeNull();
    expect(runs("hub-n2")).toHaveLength(0);
  });

  it("a hub item someone else closed first isn't taken as our result: the receipt says so and the local result stays", async () => {
    const b = bind();
    hub.add("hub-c1");
    await pass(b.id);
    const [local] = runs("hub-c1");
    Object.assign(hub.items.get("hub-c1")!, { state: "done", closureReason: "canceled", resolution: "Not needed any more." });
    await repo.update({ qitemId: local!.qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "no-follow-on", resolution: "Here it is." });
    const closes = hub.closes;
    expect(await pass(b.id)).toMatchObject({ resultsSent: 0 });
    // Checked before the close, so nothing is written over theirs.
    expect(hub.closes).toBe(closes);
    expect(hub.items.get("hub-c1")).toMatchObject({ state: "done", closureReason: "canceled", resolution: "Not needed any more." });
    expect(db.prepare("SELECT outcome, settled_at IS NOT NULL AS settled, last_error FROM network_receipts WHERE hub_qitem_id = 'hub-c1'").get()).toEqual({
      outcome: "closed_on_hub", settled: 1,
      last_error: `The hub item was closed elsewhere (done, canceled) before this result reached it. The result stays on ${local!.qitemId}.`,
    });
    expect(repo.getById(local!.qitemId)!.resolution).toBe("Here it is.");
  });

  it("closed-elsewhere conflicts are listed by when they settled, and ones that settled in the same millisecond by local item", () => {
    const add = db.prepare(`INSERT INTO network_receipts (local_qitem_id, binding_id, hub_qitem_id, created_at, settled_at, outcome)
      VALUES (?, 'netb-order', ?, '2026-11-11T19:00:00.000Z', ?, 'closed_on_hub')`);
    // The latest has the first id, and the two that tie were recorded, and name hub items, out of local-item order.
    add.run("qitem-net-a", "hub-1", "2026-11-11T19:00:00.001Z");
    add.run("qitem-net-c", "hub-2", "2026-11-11T19:00:00.000Z");
    add.run("qitem-net-b", "hub-3", "2026-11-11T19:00:00.000Z");
    expect(networkClosedElsewhere(db, "netb-order").map((c) => c.localItem)).toEqual(["qitem-net-b", "qitem-net-c", "qitem-net-a"]);
  });

  it("a hub item already failed elsewhere gets no write and isn't our result, and a close that loses a race is read back as closed elsewhere", async () => {
    const b = bind();
    hub.add("hub-f1");
    hub.add("hub-f2");
    await pass(b.id);
    const [f1] = runs("hub-f1");
    const [f2] = runs("hub-f2");
    Object.assign(hub.items.get("hub-f1")!, { state: "failed", closureReason: null, resolution: "Their failure." });
    hub.raceClose.set("hub-f2", { state: "done", closureReason: "no-follow-on", resolution: "Someone else's answer." });
    for (const item of [f1!, f2!]) {
      await repo.update({ qitemId: item.qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "no-follow-on", resolution: "Ours." });
    }
    const closes = hub.closes;
    expect(await pass(b.id)).toMatchObject({ resultsSent: 0 });
    expect(hub.closes).toBe(closes + 1);
    expect(hub.items.get("hub-f1")).toMatchObject({ state: "failed", resolution: "Their failure." });
    expect(hub.items.get("hub-f2")).toMatchObject({ state: "done", resolution: "Someone else's answer." });
    const outcomes = db.prepare("SELECT hub_qitem_id, outcome FROM network_receipts WHERE hub_qitem_id IN ('hub-f1', 'hub-f2') ORDER BY hub_qitem_id").all();
    expect(outcomes).toEqual([{ hub_qitem_id: "hub-f1", outcome: "closed_on_hub" }, { hub_qitem_id: "hub-f2", outcome: "closed_on_hub" }]);

    // The person sees both conflicts on the binding.
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("rigRepo" as never, new RigRepository(db) as never); await next(); });
    app.route("/api/network", networkRoutes({ home }));
    // A later pass's ordinary contact doesn't clear it, and it's read from the receipts, so a restart keeps it.
    expect((await pass(b.id)).error).toBeUndefined();
    const listed = await (await app.request("/api/network/bindings")).json() as { bindings: Array<{ id: string; closedElsewhere: unknown[] }> };
    // Listed in the order they settled, which can fall in one millisecond or two, so compared by local item.
    const byLocal = (x: { localItem: string }, y: { localItem: string }) => x.localItem.localeCompare(y.localItem);
    expect([...listed.bindings.find((x) => x.id === b.id)!.closedElsewhere as Array<{ localItem: string }>].sort(byLocal)).toEqual([
      { hubItem: "hub-f1", localItem: f1!.qitemId, note: `The hub item was closed elsewhere (failed) before this result reached it. The result stays on ${f1!.qitemId}.` },
      { hubItem: "hub-f2", localItem: f2!.qitemId, note: `The hub item was closed elsewhere (done, no-follow-on) before this result reached it. The result stays on ${f2!.qitemId}.` },
    ].sort(byLocal));
  });

  it("a close without a resolution sends only the closer's own closing note, never another note on the item", async () => {
    const b = bind();
    hub.add("hub-w1");
    hub.add("hub-w2");
    await pass(b.id);
    const [w1] = runs("hub-w1");
    const [w2] = runs("hub-w2");
    db.prepare("INSERT INTO queue_transitions (qitem_id, ts, state, transition_note, actor_session) VALUES (?, ?, 'pending', ?, 'daemon@kernel')")
      .run(w1!.qitemId, new Date().toISOString(), "Stuck sweep: dev-impl@lab idle 17 min, recovery qitem-recovery-x.");
    await repo.update({ qitemId: w1!.qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "no-follow-on" });
    await repo.update({ qitemId: w2!.qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "no-follow-on", transitionNote: "Done; the notes are in the item." });
    // Notes after a close repeat its state: the closer's own later note isn't the result, and a later OpenRig note
    // doesn't hide the closer's note on the close.
    await repo.update({ qitemId: w1!.qitemId, actorSession: "dev-impl@lab", transitionNote: "Also: I left a scratch file in /tmp." });
    db.prepare("INSERT INTO queue_transitions (qitem_id, ts, state, transition_note, actor_session) VALUES (?, ?, 'done', ?, 'daemon@kernel')")
      .run(w2!.qitemId, new Date().toISOString(), "Delivery receipt: wake confirmed for dev-impl@lab.");
    await pass(b.id);
    expect(hub.items.get("hub-w1")!.resolution).toBe("Closed without a stated result.");
    expect(hub.items.get("hub-w2")!.resolution).toBe("Done; the notes are in the item.");
  });

  it("a failure here is recorded as local, not as the hub's", async () => {
    const b = bind();
    hub.add("hub-l1");
    vi.spyOn(repo, "create").mockRejectedValueOnce(new Error("disk I/O error"));
    expect(await pass(b.id)).toMatchObject({ error: "local" });
    expect(bindings.get(b.id)!.lastError).toBe("A local error stopped this pass: disk I/O error");
  });

  it("reporting looks at a bounded batch per pass and rotates it, so a later item isn't hidden behind older open ones", async () => {
    const b = bind();
    for (const id of ["hub-q1", "hub-q2", "hub-q3"]) hub.add(id);
    let tick = Date.parse("2026-11-11T19:00:00.000Z");
    const limited = { ...deps, reportLimit: 1, now: () => new Date(tick += 1000) };
    await runNetworkBindingPass(limited, bindings.get(b.id)!);
    // q1 and q2 stay unclaimed and open; q3 is picked up.
    repo.claim({ qitemId: runs("hub-q3")[0]!.qitemId, destinationSession: "dev-impl@lab" });
    for (let i = 0; i < 3; i++) await runNetworkBindingPass(limited, bindings.get(b.id)!);
    expect(hub.items.get("hub-q3")!.notes.at(-1)).toMatch(/^Picked up by the local seat at /);
  });

  it("a pass whose hub stalls is closed at its deadline before any late local work, and the next binding still gets its turn", async () => {
    const node = new RigRepository(db).addNode(new RigRepository(db).listRigs()[0]!.id, "review", { runtime: "claude-code" });
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s9', ?, 'dev-review@lab', 'running')").run(node.id);
    const slow = bind();
    hub.add("hub-s1");
    hub.stallShow.add("hub-s1");
    const other = new FakeHub();
    other.add("hub-o1");
    const fast = bindings.create({ session: "dev-review@lab", hubUrl: "https://other-hub.example/mcp", hubSeat: PARTICIPANT, token: "tok-2" });
    const connect: HubConnect = (url, token, signal) => (url === "https://other-hub.example/mcp" ? other : hub).connect(url, token, signal);
    const service = new NetworkConnectorService({ ...deps, connect, passTimeoutMs: 200 }, { intervalMs: 1000 });
    await service.round();
    expect(bindings.get(slow.id)!.lastError).toBe("This pass took longer than 200 ms, so its connection to the hub was closed. The next pass tries again.");
    expect(runs("hub-s1")).toHaveLength(0);
    // The other binding's pass ran in the same round and took its item.
    expect(runs("hub-o1")).toEqual([expect.objectContaining({ destinationSession: "dev-review@lab" })]);
    expect(bindings.get(fast.id)!.lastError).toBeNull();
  });

  it("an initialize the hub answers but a stalled initialized notification is closed at the deadline, and stop doesn't wait for a pass", async () => {
    const { createServer } = await import("node:http");
    const waiting: Array<() => void> = [];
    const held: Array<import("node:http").ServerResponse> = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const message = raw ? JSON.parse(raw) as { id?: number; method?: string; params?: { protocolVersion?: string } } : {};
        if (message.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
            result: { protocolVersion: message.params?.protocolVersion, capabilities: {}, serverInfo: { name: "stalling hub", version: "1" } } }));
        } else {
          held.push(res); // notifications/initialized: never answered
          waiting.shift()?.();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    try {
      const b = bindings.create({ session: "dev-impl@lab", hubUrl: url, hubSeat: PARTICIPANT, token: "tok-stall", allowHttp: true });
      const real = { ...deps, connect: connectMcpHub };
      expect(await runNetworkBindingPass({ ...real, passTimeoutMs: 300 }, bindings.get(b.id)!)).toMatchObject({ error: "unavailable" });
      expect(bindings.get(b.id)!.lastError).toBe("This pass took longer than 300 ms, so its connection to the hub was closed. The next pass tries again.");

      const service = new NetworkConnectorService({ ...real, passTimeoutMs: 60_000 }, { intervalMs: 1000 });
      const stalled = new Promise<void>((resolve) => waiting.push(resolve));
      service.start();
      await stalled;
      const asked = Date.now();
      await service.stop();
      expect(Date.now() - asked).toBeLessThan(5_000);
      expect(bindings.get(b.id)!.lastError).toBe("The connector stopped during this pass and closed its connection to the hub.");
    } finally {
      for (const res of held) res.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("with no active binding, a round reaches no hub", async () => {
    const service = new NetworkConnectorService(deps, { intervalMs: 1000 });
    await service.round();
    expect(hub.tokens).toEqual([]);
  });
});
