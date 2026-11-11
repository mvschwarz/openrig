// The outbound connector against a hub that behaves like an external grant's queue: it lists the participant's own items,
// a claim moves an item out of pending, and a close stores the resolution. Each test counts executions as local items
// carrying the hub item: a lost answer, a restart or a revoke must never make a second one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { NetworkBindingStore, networkCredentialFile } from "../src/domain/network/network-bindings.js";
import { HubError, type HubConnect, type HubItem, type HubSession } from "../src/domain/network/hub-client.js";
import { NetworkConnectorService, networkLocalItemId, runNetworkBindingPass, type NetworkConnectorDeps } from "../src/domain/network/network-connector.js";

const PARTICIPANT = "alex@team";

class FakeHub {
  readonly items = new Map<string, HubItem & { notes: string[] }>();
  readonly tokens: string[] = [];
  revoked = false;
  down = false;
  /** The next claim or close of these ids takes effect, then its answer is lost. */
  readonly loseClaimAnswer = new Set<string>();
  readonly loseCloseAnswer = new Set<string>();
  closes = 0;

  add(qitemId: string, body = "Summarize the release notes", destination = PARTICIPANT): void {
    this.items.set(qitemId, { qitemId, sourceSession: "assistant@team", destinationSession: destination, state: "pending", body, summary: body, resolution: null, notes: [] });
  }

  readonly connect: HubConnect = async (_url, token) => {
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
      show: async (id) => { const { notes: _notes, ...item } = get(id); return { ...item }; },
      note: async (id, note) => { get(id).notes.push(note); },
      close: async (id, input) => {
        this.closes++;
        const item = get(id);
        if (item.state === "done" || item.state === "canceled") throw new HubError("refused", `qitem ${id} is already closed`);
        item.state = input.closureReason === "canceled" ? "canceled" : "done";
        item.resolution = input.resolution;
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
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  const bind = () => bindings.create({ session: "dev-impl@lab", hubUrl: "https://hub.example/mcp", hubSeat: PARTICIPANT, token: "tok-1" });
  const pass = (bindingId: string) => runNetworkBindingPass(deps, bindings.get(bindingId)!);
  /** Executions: local items carrying this hub item. */
  const runs = (hubId: string) => repo.list({ limit: 500 }).filter((i) => (i.tags ?? []).includes(`network-hub-item:${hubId}`));

  it("takes a hub item into the bound seat once, then carries pickup and the result back in order", async () => {
    const b = bind();
    hub.add("hub-1");
    const first = await pass(b.id);
    expect(first).toMatchObject({ taken: 1 });
    expect(first.error).toBeUndefined();
    expect(hub.tokens).toEqual(["tok-1"]);
    const [local] = runs("hub-1");
    expect(local).toMatchObject({ qitemId: networkLocalItemId(b.id, "hub-1"), sourceSession: "daemon@kernel", destinationSession: "dev-impl@lab", state: "pending" });
    expect(local!.body).toContain("Summarize the release notes");
    expect(local!.body).toContain("From assistant@team through the network hub https://hub.example/mcp, as alex@team (hub item hub-1).");
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
    await repo.create({ qitemId: networkLocalItemId(b.id, "hub-3"), sourceSession: "daemon@kernel", destinationSession: "dev-impl@lab", body: "already made",
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
    expect(db.prepare("SELECT outcome, result_sent_at IS NOT NULL AS sent FROM network_receipts WHERE hub_qitem_id = 'hub-4'").get()).toEqual({ outcome: "done", sent: 1 });
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
    expect(hub.items.get("hub-7")!.notes.at(-1)).toBe(`This item's local record (${local!.qitemId}) is gone, so its outcome is unknown. It won't be run again.`);
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

  it("with no active binding, a round reaches no hub", async () => {
    const service = new NetworkConnectorService(deps, { intervalMs: 1000 });
    await service.round();
    expect(hub.tokens).toEqual([]);
  });
});
