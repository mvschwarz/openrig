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
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { connectMcpHub, HubError, hubFailure, parseHubToolResult, type HubConnect, type HubItem, type HubSession } from "../src/domain/network/hub-client.js";
import { networkRoutes } from "../src/routes/network.js";
import { NetworkConnectorService, networkClosedElsewhere, networkLocalItemId, runNetworkBindingPass, type NetworkConnectorDeps } from "../src/domain/network/network-connector.js";
import { listNetworkPeers, networkHubRequestId, networkRequestBlocker, originateNetworkRequest } from "../src/domain/network/network-requests.js";
import { OPENRIG_SENDER } from "../src/lib/pane-envelope.js";
import { deriveWorkCandidates } from "../src/domain/current-work.js";

const PARTICIPANT = "alex@team";
/** Another seat in the participant's hub rig, which the participant may send to. */
const PEER = PARTICIPANT.replace(/^alex/, "sam");

class FakeHub {
  readonly items = new Map<string, HubItem & { notes: string[] }>();
  readonly tokens: string[] = [];
  revoked = false;
  down = false;
  settingUp = false;
  requesterQuestions = false;
  readonly beforeBlocks = new Map<string, string>();
  /** The next claim or close of these ids takes effect, then its answer is lost. */
  readonly loseClaimAnswer = new Set<string>();
  readonly loseCloseAnswer = new Set<string>();
  /** The next note on these ids fails; later ones land. */
  readonly failNote = new Set<string>();
  /** Shows of these ids wait until the pass closes its connection. */
  readonly stallShow = new Set<string>();
  /** Runs while a show is waiting on the hub, before it answers; the show waits for what it returns. */
  duringShow: ((id: string) => void | Promise<void>) | null = null;
  /** Runs right after a create stores a new item, before it answers. */
  afterCreate: ((id: string) => void) | null = null;
  /** Runs while a connection is being set up, before it's ready. */
  duringConnect: (() => void) | null = null;
  /** Someone else closes these items just as ours arrives: the hub keeps theirs and answers ours as done. */
  readonly raceClose = new Map<string, Partial<HubItem>>();
  closes = 0;
  /** The seats a create may address. */
  readonly seats = new Set<string>([PEER]);
  /** The next create of these ids lands, then its answer is lost. */
  readonly loseCreateAnswer = new Set<string>();
  creates = 0;
  readonly teamCalls: Array<string | undefined> = [];
  /** The hub's tool list can't be read. */
  failToolList = false;

  add(qitemId: string, body = "Summarize the release notes", destination = PARTICIPANT): void {
    this.items.set(qitemId, { qitemId, sourceSession: "assistant@team", destinationSession: destination, state: "pending", body, summary: body, resolution: null, closureReason: null, notes: [] });
  }

  readonly connect: HubConnect = async (_url, token, signal) => {
    this.tokens.push(token);
    this.duringConnect?.();
    if (this.revoked) throw new HubError("revoked", "The hub refused this participant's credential.");
    if (this.down) throw new HubError("unavailable", "The hub couldn't be reached: connect ECONNREFUSED");
    // The hub's own 503 answer while its grant authority can't serve the participant yet, as the SDK reports it.
    if (this.settingUp) throw hubFailure(new StreamableHTTPError(503, `Error POSTing to endpoint: ${JSON.stringify({ error: "grant_authority_unavailable", message: "The grant authority can't answer now, so this request isn't served. Try again later." })}`));
    const get = (id: string) => {
      const item = this.items.get(id);
      if (!item) throw new HubError("refused", `qitem ${id} not found`, "qitem_not_found");
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
        await this.duringShow?.(id);
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
      block: async (id, blockedOn) => {
        const item = get(id);
        if (item.state !== "blocked") this.beforeBlocks.set(id, item.state);
        Object.assign(item, { state: "blocked", blockedOn });
      },
      close: async (id, input) => {
        this.closes++;
        const item = get(id);
        if (["done", "canceled", "denied", "failed"].includes(item.state)) throw new HubError("refused", `qitem ${id} is already closed`);
        const theirs = this.raceClose.get(id);
        if (theirs) { Object.assign(item, theirs); return; }
        Object.assign(item, { state: input.state, closureReason: input.closureReason, resolution: input.resolution });
        for (const waiting of this.items.values()) if (waiting.state === "blocked" && waiting.blockedOn === id) {
          Object.assign(waiting, { state: this.beforeBlocks.get(waiting.qitemId) ?? "in-progress", blockedOn: null });
        }
        if (this.loseCloseAnswer.delete(id)) throw new HubError("unavailable", "The hub couldn't be reached: socket hang up");
      },
      team: async (rigId) => {
        this.teamCalls.push(rigId);
        return { rig: rigId, seats: [...this.seats].map((seat) => ({ session: seat })) };
      },
      // As the hub's create does: the same id with the same parties returns the stored item (with a warning when the body
      // differs), other parties are refused, and an unknown seat is refused.
      create: async (input) => {
        const destination = input.requesterOf ? get(input.requesterOf).sourceSession : input.destination!;
        this.creates++;
        const existing = this.items.get(input.qitemId);
        if (existing) {
          if (existing.destinationSession !== destination || existing.sourceSession !== PARTICIPANT) throw new HubError("refused", `qitemId ${input.qitemId} is already taken.`, "qitem_id_reuse");
          const { notes: _notes, ...stored } = existing;
          return existing.body === input.body ? { ...stored } : { ...stored, createWarning: "qitem_body_not_saved" };
        }
        if (!this.seats.has(destination)) throw new HubError("refused", `No seat here is named '${destination}', so nothing was written.`, input.requesterOf ? "requester_unreachable" : "destination_not_found");
        this.items.set(input.qitemId, { qitemId: input.qitemId, sourceSession: PARTICIPANT, state: "pending",
          body: input.body, summary: input.summary ?? null, resolution: null, closureReason: null, notes: [], requesterOf: input.requesterOf ?? null,
          destinationSession: destination });
        this.afterCreate?.(input.qitemId);
        if (this.loseCreateAnswer.delete(input.qitemId)) throw new HubError("unavailable", "The hub couldn't be reached: socket hang up");
        const { notes: _createdNotes, ...created } = this.items.get(input.qitemId)!;
        return { ...created };
      },
      offers: async (_tool, property) => {
        if (this.failToolList) throw new HubError("unavailable", "The hub couldn't be reached: tools/list failed");
        return property === undefined || (property === "requesterOf" && this.requesterQuestions);
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

  it("keeps a relayed hub request as unscoped work rather than an OpenRig notice", async () => {
    const b = bind();
    hub.add("hub-refocus");
    expect(await pass(b.id)).toMatchObject({ taken: 1 });
    const [local] = runs("hub-refocus");
    expect(local).toMatchObject({ sourceSession: "daemon@kernel", state: "pending" });
    const work = deriveWorkCandidates([local!], join(home, "missions"), { getRow: () => null, continuationOf: () => null });
    expect(work.next).toHaveLength(1);
    expect(work.next[0]).not.toHaveProperty("openrigNotice");
  });

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
    // After the requester's words: what goes back to them, that sharing instructions apply, and how to answer, in that order.
    const after = local!.body!.split("\n---\n")[1]!.split("\n");
    expect(after).toEqual([
      "The requester gets back only this item's progress (queued, picked up, an explicit wait on a requester question, or an outcome that isn't known) and your answer: the resolution you close it with, or without one, your own note on the close. The connector does not copy other notes, unrelated items or files to the hub.",
      "Put in your answer only what this seat's sharing instructions allow.",
      `Answer by closing this item with your result: rig queue update ${local!.qitemId} --state done --closure-reason no-follow-on --resolution "<your answer>".`,
      `If you need the requester's decision, ask with rig network request --requester-of ${local!.qitemId} --id <question-id> --body-file <question-file>. On a supporting hub this keeps this same work blocked on the question receipt. An unsupported hub writes no question or wait; keep the work open and report that limit. Never put the question only in a private note or substitute your own answer for the person's decision.`,
      "OpenRig returns the resolution to the hub item.",
    ]);
    // The hub claim is custody, not pickup: the item says it's queued and not picked up.
    expect(hub.items.get("hub-1")).toMatchObject({ state: "in-progress" });
    expect(hub.items.get("hub-1")!.notes).toEqual(["Queued for the connected local seat. Not picked up yet."]);
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

  const SETTING_UP = "The network is still finishing setup for this agent. Try again in a moment.";
  const after = (b: { id: string }, ms: number) => new Date(Date.parse(bindings.get(b.id)!.createdAt) + ms);

  it("only the hub's 503 grant_authority_unavailable answer counts as the network still setting up", () => {
    const body = JSON.stringify({ error: "grant_authority_unavailable", message: "Try again later." });
    expect(hubFailure(new StreamableHTTPError(503, `Error POSTing to endpoint: ${body}`))).toMatchObject({ kind: "unavailable", code: "grant_authority_unavailable" });
    expect(hubFailure(new StreamableHTTPError(500, `Error POSTing to endpoint: ${body}`)).code).toBeUndefined();
    expect(hubFailure(new StreamableHTTPError(503, "Error POSTing to endpoint: Service Unavailable")).code).toBeUndefined();
    expect(hubFailure(new Error("connect ECONNREFUSED")).code).toBeUndefined();
  });

  it("a new connection the network is still setting up says so, is asked again in 5 s, and then makes contact", async () => {
    const b = bind();
    hub.settingUp = true;
    let now = after(b, 1_000);
    const service = new NetworkConnectorService({ ...deps, now: () => now }, { intervalMs: 30_000, random: () => 0.5 });
    await service.round();
    expect(bindings.get(b.id)).toMatchObject({ state: "active", lastContactAt: null, lastError: SETTING_UP });
    expect(service.snapshot().bindings[0]).toMatchObject({ nextPassAt: new Date(now.getTime() + 5_000).toISOString(), backoffMs: 30_000,
      lastPass: expect.objectContaining({ error: "unavailable", settingUp: true }) });
    const attempts = hub.tokens.length;
    now = new Date(now.getTime() + 4_999);
    await service.round();
    expect(hub.tokens.length).toBe(attempts);
    now = new Date(now.getTime() + 1);
    await service.round();
    expect(hub.tokens.length).toBe(attempts + 1);
    hub.settingUp = false;
    hub.add("hub-setup");
    now = new Date(now.getTime() + 5_000);
    await service.round();
    expect(bindings.get(b.id)!.lastError).toBeNull();
    expect(bindings.get(b.id)!.lastContactAt).not.toBeNull();
    expect(runs("hub-setup")).toHaveLength(1);
    expect(service.snapshot().bindings[0]).toMatchObject({ backoffMs: 30_000, nextPassAt: new Date(now.getTime() + 30_000).toISOString() });
  });

  it("a minute after connect, the same answer backs off as before, and still says setup is finishing", async () => {
    const b = bind();
    hub.settingUp = true;
    const now = after(b, 60_000);
    const service = new NetworkConnectorService({ ...deps, now: () => now }, { intervalMs: 30_000, random: () => 0.5 });
    await service.round();
    expect(bindings.get(b.id)!.lastError).toBe(SETTING_UP);
    expect(service.snapshot().bindings[0]).toMatchObject({ backoffMs: 60_000, nextPassAt: new Date(now.getTime() + 60_000).toISOString() });
  });

  it("a binding that has had contact keeps the hub's own words and its backoff for the same answer", async () => {
    const b = bind();
    await pass(b.id);
    hub.settingUp = true;
    const now = after(b, 1_000);
    const service = new NetworkConnectorService({ ...deps, now: () => now }, { intervalMs: 30_000, random: () => 0.5 });
    await service.round();
    expect(bindings.get(b.id)!.lastError).toMatch(/^The hub couldn't be reached: .*grant_authority_unavailable/);
    expect(service.snapshot().bindings[0]).toMatchObject({ backoffMs: 60_000 });
    expect(service.snapshot().bindings[0]!.lastPass!.settingUp).toBeUndefined();
  });

  it("a local item whose record is gone reads unknown on the hub and is never run again", async () => {
    const b = bind();
    hub.add("hub-7");
    await pass(b.id);
    const [local] = runs("hub-7");
    db.prepare("DELETE FROM queue_items WHERE qitem_id = ?").run(local!.qitemId);
    expect(await pass(b.id)).toMatchObject({ unknown: 1 });
    expect(hub.items.get("hub-7")!.notes.at(-1)).toBe("This item's local record is gone, so whether it ran is unknown. It won't be run again.");
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
    const secrets = join(home, "network-secrets", b.id);
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
    expect(hub.items.get("hub-h4")!.notes.at(-1)).toBe("This item was handed on here without one successor, so its outcome is unknown. It won't be run again.");
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
    expect(hub.items.get("r-gone")!.notes.at(-1)).toBe("This item's local record is gone, so whether it ran is unknown. It won't be run again.");
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
    expect(hub.items.get("hub-n1")!.notes).toEqual(["Queued for the connected local seat. Not picked up yet."]);

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

  it("a handoff-and-complete close sends the closer's own note, never the note OpenRig writes when it gives none", async () => {
    const b = bind();
    hub.add("hub-c1");
    hub.add("hub-c2");
    await pass(b.id);
    const [c1] = runs("hub-c1");
    const [c2] = runs("hub-c2");
    // With no note of the closer's, the queue writes "handoff-and-complete to review@lab", which names a local seat.
    await repo.handoffAndComplete({ qitemId: c1!.qitemId, fromSession: "dev-impl@lab", toSession: "review@lab", nudge: false });
    await repo.handoffAndComplete({ qitemId: c2!.qitemId, fromSession: "dev-impl@lab", toSession: "review@lab", nudge: false,
      transitionNote: "Done here; the review is a separate step." });
    await pass(b.id);
    expect(hub.items.get("hub-c1")!.resolution).toBe("Closed without a stated result.");
    expect(hub.items.get("hub-c2")!.resolution).toBe("Done here; the review is a separate step.");
  });

  it("a cross-host handoff-and-complete close sends the closer's own note, never the cross-host note the queue writes", async () => {
    const b = bind();
    for (const id of ["hub-x1", "hub-x2", "hub-x3"]) hub.add(id);
    await pass(b.id);
    const local = (id: string) => runs(id)[0]!;
    // Forwarded to another host and completed here: with no note of the closer's, the queue writes
    // "cross-host handoff to review@lab", and adds what it overrode when a claim was made while the handoff was forwarded.
    repo.closeCrossHostHandoffSource({ qitemId: local("hub-x1").qitemId, fromSession: "dev-impl@lab", toSession: "review@lab",
      closureTarget: "qitem-remote-1@vps-b", terminalState: "done" });
    repo.closeCrossHostHandoffSource({ qitemId: local("hub-x2").qitemId, fromSession: "dev-impl@lab", toSession: "review@lab",
      closureTarget: "qitem-remote-2@vps-b", terminalState: "done", transitionNote: "Done here; the review runs on the other host." });
    repo.claim({ qitemId: local("hub-x3").qitemId, destinationSession: "dev-impl@lab" });
    repo.closeCrossHostHandoffSource({ qitemId: local("hub-x3").qitemId, fromSession: "dev-impl@lab", toSession: "review@lab",
      closureTarget: "qitem-remote-3@vps-b", terminalState: "done", claimedAtBeforeForward: null });
    expect(repo.closingTransition(local("hub-x3").qitemId, "done")?.transitionNote).toMatch(/^cross-host handoff to review@lab \(this overrode /);
    await pass(b.id);
    expect.soft(hub.items.get("hub-x1")!.resolution, "hub-x1").toBe("Closed without a stated result.");
    expect.soft(hub.items.get("hub-x2")!.resolution, "hub-x2").toBe("Done here; the review runs on the other host.");
    expect.soft(hub.items.get("hub-x3")!.resolution, "hub-x3").toBe("Closed without a stated result.");
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

  describe("requester questions", () => {
    const incoming = async () => {
      const binding = bind();
      hub.add("hub-work", "Ask me before choosing the audience.");
      hub.items.get("hub-work")!.sourceSession = PEER;
      await runNetworkBindingPass(deps, bindings.get(binding.id)!);
      const work = runs("hub-work")[0]!;
      repo.claim({ qitemId: work.qitemId, destinationSession: "dev-impl@lab" });
      return { binding: bindings.get(binding.id)!, work: repo.getById(work.qitemId)! };
    };

    it.each([true, false])("R1 uncertain retry preserves the current dependency (owner selected another=%s)", async (changed) => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      const input = { requesterOf: work.qitemId, requestId: "qitem-old-question", body: "Which audience?" };
      const hubId = networkHubRequestId(binding, input.requestId);
      hub.loseCreateAnswer.add(hubId);
      expect((await originateNetworkRequest(deps, binding, input)).state).toBe("unknown");
      if (changed) {
        await repo.create({ qitemId: "qitem-new-question", sourceSession: "dev-impl@lab", destinationSession: "dev-impl@lab", body: "A later decision", nudge: false });
        repo.update({ qitemId: work.qitemId, actorSession: "dev-impl@lab", state: "blocked", blockedOn: "qitem-new-question" });
      }
      expect((await originateNetworkRequest(deps, binding, input)).state).toBe("sent");
      expect.soft(repo.getById(work.qitemId)).toMatchObject({ state: "blocked", blockedOn: changed ? "qitem-new-question" : input.requestId });
      expect(hub.creates).toBe(1);
      Object.assign(hub.items.get(hubId)!, { state: "done", closureReason: "no-follow-on", resolution: "Old question's answer" });
      await runNetworkBindingPass(deps, binding);
      expect(repo.getById(input.requestId)!.state).toBe("done");
      expect(repo.getById(work.qitemId)).toMatchObject(changed ? { state: "blocked", blockedOn: "qitem-new-question" } : { state: "pending", blockedOn: null });
      if (changed) expect(repo.getById("qitem-new-question")!.state).toBe("pending");
    });

    it("R1 overlapping first attempts establish the wait only on the actual receipt insert", async () => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      const input = { requesterOf: work.qitemId, requestId: "qitem-overlap", body: "Which audience?" };
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const create = repo.create.bind(repo); let first = true;
      const spy = vi.spyOn(repo, "create").mockImplementation(async (change) => {
        const row = await create(change);
        if (change.qitemId === input.requestId && first) { first = false; entered(); await gate; }
        return row;
      });
      const delayed = originateNetworkRequest(deps, binding, input);
      await waiting;
      try {
        const hubId = networkHubRequestId(binding, input.requestId);
        hub.loseCreateAnswer.add(hubId);
        expect((await originateNetworkRequest(deps, binding, input)).state).toBe("unknown");
        await repo.create({ qitemId: "qitem-overlap-new", sourceSession: "dev-impl@lab", destinationSession: "dev-impl@lab", body: "Later dependency", nudge: false });
        repo.update({ qitemId: work.qitemId, actorSession: "dev-impl@lab", state: "blocked", blockedOn: "qitem-overlap-new" });
      } finally { release(); }
      expect((await delayed).state).toBe("sent"); spy.mockRestore();
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "blocked", blockedOn: "qitem-overlap-new" });
      expect([...hub.items.values()].filter(x => x.requesterOf === "hub-work")).toHaveLength(1);
    });

    it("R1 an interrupted initial wait rolls back its receipt and a same-id retry completes it", async () => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      const input = { requesterOf: work.qitemId, requestId: "qitem-incomplete", body: "Which audience?" };
      const update = repo.update.bind(repo);
      const spy = vi.spyOn(repo, "update").mockImplementation((change) => {
        if (change.qitemId === work.qitemId && change.blockedOn === input.requestId) {
          spy.mockRestore(); throw new Error("fixture: initial wait interrupted");
        }
        return update(change);
      });
      await expect(originateNetworkRequest(deps, binding, input)).rejects.toThrow("initial wait interrupted");
      expect(db.prepare("SELECT count(*) AS n FROM network_requests WHERE local_qitem_id = ?").get(input.requestId)).toEqual({ n: 0 });
      expect(repo.getById(input.requestId)!.state).toBe("blocked");
      expect(repo.getById(work.qitemId)!.state).toBe("in-progress");
      expect((await originateNetworkRequest(deps, binding, input)).state).toBe("sent");
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "blocked", blockedOn: input.requestId });
      expect(hub.creates).toBe(1);
    });

    it.each(["missing", "unreadable"] as const)("R1 a %s requester advertisement cannot prevent an existing answer from returning", async (mode) => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      const sent = await originateNetworkRequest(deps, binding, { requesterOf: work.qitemId, requestId: "qitem-confirmed-question", body: "Which audience?" });
      await runNetworkBindingPass(deps, binding);
      Object.assign(hub.items.get(sent.hubQitemId)!, { state: "done", closureReason: "no-follow-on", resolution: "Person Alex: use the public audience." });
      if (mode === "missing") hub.requesterQuestions = false;
      else hub.failToolList = true;
      await runNetworkBindingPass(deps, binding);
      expect(repo.getById("qitem-confirmed-question")).toMatchObject({ state: "done", resolution: "Person Alex: use the public audience." });
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "pending", blockedOn: null });
      expect(hub.creates).toBe(1);
    });

    it("R1 canceling a deferred unsupported question releases the work without a create", async () => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      let connects = 0;
      hub.duringConnect = () => { if (++connects === 2) hub.requesterQuestions = false; };
      expect((await originateNetworkRequest(deps, binding, { requesterOf: work.qitemId, requestId: "qitem-deferred", body: "Which audience?" })).state).toBe("unknown");
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "blocked", blockedOn: "qitem-deferred" });
      repo.update({ qitemId: "qitem-deferred", actorSession: "dev-impl@lab", state: "done", closureReason: "canceled", resolution: "Canceled the question" });
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "pending", blockedOn: null });
      expect(hub.creates).toBe(0);
    });

    it("an old hub writes no question, receipt or wait and never tries name-based create", async () => {
      const { binding, work } = await incoming();
      const count = db.prepare("SELECT count(*) AS n FROM queue_items").get();
      await expect(originateNetworkRequest(deps, binding, {
        requesterOf: work.qitemId, requestId: "qitem-question-old", body: "Who is the audience?",
      })).rejects.toMatchObject({ code: "requester_question_unsupported" });
      expect(db.prepare("SELECT count(*) AS n FROM queue_items").get()).toEqual(count);
      expect(db.prepare("SELECT count(*) AS n FROM network_requests").get()).toEqual({ n: 0 });
      expect(hub.creates).toBe(0);
      expect(repo.getById(work.qitemId)!.state).toBe("in-progress");
    });

    it.each([false, true])("the HTTP request route forwards requesterOf and the named outcome (supported=%s)", async (supported) => {
      hub.requesterQuestions = supported;
      const { binding, work } = await incoming();
      const app = new Hono();
      app.use("*", async (c, next) => { c.set("rigRepo" as never, new RigRepository(db) as never); c.set("queueRepo" as never, repo as never); await next(); });
      app.route("/api/network", networkRoutes({ home, hubConnect: hub.connect }));
      const request = { requesterOf: work.qitemId, requestId: "route-question", body: "Which audience?", returnRoute: "auto" };
      const res = await app.request(`/api/network/bindings/${binding.id}/requests`, { method: "POST",
        headers: { "content-type": "application/json", "X-OpenRig-Session": "reviewer@lab" }, body: JSON.stringify(request) });
      expect(res.status).toBe(supported ? 201 : 409);
      const response = await res.json();
      expect(response).toMatchObject(supported ? { localQitemId: "route-question", state: "sent" } : { error: "requester_question_unsupported" });
      expect(hub.creates).toBe(supported ? 1 : 0);
      if (!supported) expect(repo.getById("route-question")).toBeNull();
      else {
        const local = repo.getById("route-question")!;
        expect(local).toMatchObject({ sourceSession: "reviewer@lab", returnRouteBasis: "issued" });
        expect(repo.listTransitions("route-question")[0]).toMatchObject({ identityProvenance: "transport:v1" });
        expect(local.returnRoute).toMatch(/^conversation-[a-f0-9]{12}@kernel$/);
        expect(local.tags).toContain("network-requester-question");
        expect(hub.items.get(response.hubQitemId)).toMatchObject({ requesterOf: "hub-work" });
        const retry = await app.request(`/api/network/bindings/${binding.id}/requests`, { method: "POST",
          headers: { "content-type": "application/json", "X-OpenRig-Session": "later-caller@lab" }, body: JSON.stringify(request) });
        expect(retry.status).toBe(201);
        expect(await retry.json()).toMatchObject({ sourceSession: "reviewer@lab", returnRoute: local.returnRoute, returnRouteBasis: "issued" });
        expect(hub.creates).toBe(1);
      }
    });

    it("pins the route by work id, mirrors its wait, and resumes the same work on the explicit answer", async () => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      const sent = await originateNetworkRequest(deps, binding, {
        requesterOf: work.qitemId, requestId: "qitem-question", body: "Who is the audience? Ask the person; do not infer it.",
      });
      expect(sent.state).toBe("sent");
      expect(hub.items.get(sent.hubQitemId)).toMatchObject({ requesterOf: "hub-work", destinationSession: PEER });
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "blocked", blockedOn: "qitem-question", claimedAt: work.claimedAt });
      await runNetworkBindingPass(deps, binding);
      expect(hub.items.get("hub-work")).toMatchObject({ state: "blocked", blockedOn: sent.hubQitemId });
      // An explicit answer fixture for the question's destination. This is not a real person/UI journey.
      expect(hub.items.get(sent.hubQitemId)!.destinationSession).toBe(PEER);
      const connection = await hub.connect("https://hub.example/mcp", "tok");
      await connection.close(sent.hubQitemId, { state: "done", closureReason: "no-follow-on", resolution: "The reader is a first-time event organiser." });
      await runNetworkBindingPass(deps, binding);
      expect(repo.getById("qitem-question")).toMatchObject({ state: "done", resolution: "The reader is a first-time event organiser." });
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "pending", claimedAt: work.claimedAt });
      expect(hub.items.get("hub-work")!.state).toBe("in-progress");
      expect(runs("hub-work")).toHaveLength(1);
      expect(hub.creates).toBe(1);
    });

    it("recovers a lost create reply with the same question id, never a second question or pickup", async () => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      const id = networkHubRequestId(binding, "lost-question");
      hub.loseCreateAnswer.add(id);
      expect((await originateNetworkRequest(deps, binding, { requesterOf: work.qitemId, requestId: "lost-question", body: "Which audience?" })).state).toBe("unknown");
      await runNetworkBindingPass(deps, binding);
      await runNetworkBindingPass(deps, binding);
      expect(hub.creates).toBe(1);
      expect(runs("hub-work")).toHaveLength(1);
      expect(hub.items.get("hub-work")).toMatchObject({ state: "blocked", blockedOn: id });
      expect(hub.items.get("hub-work")!.notes.filter(n => n.startsWith("Picked up"))).toHaveLength(1);
    });

    it("keeps the same question and blocked work across connector restart and binding replacement", async () => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      const result = await originateNetworkRequest(deps, binding, { requesterOf: work.qitemId, requestId: "rebound-question", body: "Which audience?" });
      await runNetworkBindingPass(deps, binding);
      expect(hub.items.get("hub-work")!.state).toBe("blocked");
      bindings.disconnect(binding.id);
      const replacement = bindings.create({ session: binding.localSession, hubUrl: binding.hubUrl, hubSeat: binding.hubSeat, token: "replacement" });
      await runNetworkBindingPass({ ...deps }, bindings.get(replacement.id)!);
      expect(db.prepare("SELECT binding_id FROM network_receipts WHERE local_qitem_id = ?").get(work.qitemId)).toEqual({ binding_id: replacement.id });
      Object.assign(hub.items.get(result.hubQitemId)!, { state: "done", closureReason: "no-follow-on", resolution: "Person Alex: use the public audience." });
      await runNetworkBindingPass({ ...deps }, bindings.get(replacement.id)!);
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "pending", claimedAt: work.claimedAt });
      expect(repo.getById("rebound-question")).toMatchObject({ state: "done", resolution: "Person Alex: use the public audience." });
      expect(runs("hub-work")).toHaveLength(1);
      expect(hub.creates).toBe(1);
    });

    it("rechecks the original work after capability discovery before creating remotely", async () => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      let connects = 0;
      hub.duringConnect = () => {
        if (++connects === 2) repo.update({ qitemId: work.qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "canceled", resolution: "No longer needed" });
      };
      const result = await originateNetworkRequest(deps, binding, { requesterOf: work.qitemId, requestId: "stopped-question", body: "Which audience?" });
      expect(result.state).toBe("refused");
      expect(hub.creates).toBe(0);
      expect(repo.getById("stopped-question")!.state).toBe("failed");
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "done", closureReason: "canceled" });
    });

    it("does not confirm a lost-reply readback that lacks the persisted original-work relation", async () => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      const hubId = networkHubRequestId(binding, "unconfirmed-question");
      hub.loseCreateAnswer.add(hubId);
      await originateNetworkRequest(deps, binding, { requesterOf: work.qitemId, requestId: "unconfirmed-question", body: "Which audience?" });
      hub.items.get(hubId)!.requesterOf = null;
      await runNetworkBindingPass(deps, binding);
      expect(db.prepare("SELECT hub_created_at FROM network_requests WHERE local_qitem_id = 'unconfirmed-question'").get()).toEqual({ hub_created_at: null });
      expect(repo.getById("unconfirmed-question")!.state).toBe("blocked");
      expect(hub.creates).toBe(1);
      expect(hub.items.get("hub-work")!.state).toBe("in-progress");
    });

    it("keeps unrelated local waits and private notes off the hub", async () => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      await repo.create({ qitemId: "private-local", sourceSession: "dev-impl@lab", destinationSession: "dev-impl@lab", body: "private" });
      repo.update({ qitemId: work.qitemId, actorSession: "dev-impl@lab", state: "blocked", blockedOn: "private-local", transitionNote: "PRIVATE-NOTE" });
      await runNetworkBindingPass(deps, binding);
      expect(hub.items.get("hub-work")).toMatchObject({ state: "in-progress" });
      expect(hub.items.get("hub-work")!.notes.join(" ")).not.toContain("PRIVATE");
    });

    it("refuses unreachable original requesters without a name fallback and releases the local wait", async () => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      hub.seats.delete(PEER);
      const result = await originateNetworkRequest(deps, binding, { requesterOf: work.qitemId, requestId: "unreachable-question", body: "Which audience?" });
      expect(result.state).toBe("refused");
      expect(result.message).toContain("requester_unreachable");
      expect(repo.getById("unreachable-question")!.state).toBe("failed");
      expect(repo.getById(work.qitemId)!.state).toBe("pending");
      expect(hub.items.has(result.hubQitemId)).toBe(false);
      expect(hub.creates).toBe(1);
    });

    it.each([true, false])("retains explicit remote waits without copying notes or hidden identities (visible=%s)", async (visible) => {
      const binding = bind();
      const sent = await originateNetworkRequest(deps, bindings.get(binding.id)!, { peer: PEER, requestId: "outgoing-work", body: "Do the work" });
      const local = await repo.create({ qitemId: "local-dependent", sourceSession: "dev-impl@lab", destinationSession: "dev-impl@lab", body: "Wait for it" });
      repo.update({ qitemId: local.qitemId, actorSession: "dev-impl@lab", state: "blocked", blockedOn: "outgoing-work" });
      hub.add("remote-question", "PRIVATE QUESTION TEXT");
      Object.assign(hub.items.get("remote-question")!, { requesterOf: sent.hubQitemId, sourceSession: PEER });
      Object.assign(hub.items.get(sent.hubQitemId)!, { state: "blocked", blockedOn: visible ? "remote-question" : null });
      await runNetworkBindingPass(deps, bindings.get(binding.id)!);
      const expected = visible ? { kind: "requester-question", hubQitemId: "remote-question", localQitemId: runs("remote-question")[0]!.qitemId, blockerState: "in-progress" }
        : { kind: "another-request", hubQitemId: null, localQitemId: null, blockerState: null };
      expect(repo.getById("outgoing-work")!.networkWait).toMatchObject(expected);
      expect(repo.getById(local.qitemId)!.waiting!.blocker!.networkWait).toMatchObject(expected);
      const stored = db.prepare("SELECT remote_wait FROM network_requests WHERE local_qitem_id = 'outgoing-work'").get() as { remote_wait: string };
      expect(stored.remote_wait).not.toContain("PRIVATE");
      hub.items.get(sent.hubQitemId)!.state = "in-progress";
      await runNetworkBindingPass(deps, bindings.get(binding.id)!);
      expect(repo.getById("outgoing-work")).not.toHaveProperty("networkWait");
    });

    it.each(["failed", "canceled", "denied"] as const)("a %s question releases the local wait without becoming approval", async (state) => {
      hub.requesterQuestions = true;
      const { binding, work } = await incoming();
      const sent = await originateNetworkRequest(deps, binding, { requesterOf: work.qitemId, requestId: "qitem-not-approved", body: "May I proceed?" });
      Object.assign(hub.items.get(sent.hubQitemId)!, { state, closureReason: state === "failed" ? null : state, resolution: "No approval was given." });
      await runNetworkBindingPass(deps, binding);
      expect(repo.getById("qitem-not-approved")).toMatchObject({ state: state === "failed" ? "failed" : "done", resolution: "No approval was given." });
      expect(repo.getById(work.qitemId)!.state).toBe("pending");
      expect(hub.items.get("hub-work")!.state).toBe("in-progress");
    });
  });

  describe("requests the seat sends through its hub", () => {
    const send = (bindingId: string, requestId: string, body = "Review the release notes", peer = PEER) =>
      originateNetworkRequest(deps, bindings.get(bindingId)!, { peer, requestId, body, summary: "Release notes review" });
    const answer = (hubId: string, fields: Partial<HubItem>) => Object.assign(hub.items.get(hubId)!, fields);
    const outcome = (requestId: string) => db.prepare("SELECT outcome FROM network_requests WHERE local_qitem_id = ?").get(requestId);

    it("a create whose answer was lost is found by its id on the next pass: one hub item, and its answer closes the local item", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-1");
      hub.loseCreateAnswer.add(hubId);
      expect(await send(b.id, "req-1")).toMatchObject({ localQitemId: "req-1", hubQitemId: hubId, peer: PEER, state: "unknown" });
      // Recorded first, from the seat to OpenRig, parked on the hub item.
      const local = repo.getById("req-1")!;
      expect(local).toMatchObject({ sourceSession: b.localSession, destinationSession: OPENRIG_SENDER, state: "blocked", blockedOn: networkRequestBlocker(hubId) });
      expect(local.tags).toEqual(expect.arrayContaining([`network-hub-item:${hubId}`, `network-peer:${PEER}`, "network-direction:outbound"]));
      expect(hub.creates).toBe(1);
      await pass(b.id);
      expect(hub.creates).toBe(1);
      expect(repo.getById("req-1")!.state).toBe("blocked");
      answer(hubId, { state: "done", closureReason: "no-follow-on", resolution: "Two typos; otherwise fine." });
      await pass(b.id);
      expect(repo.getById("req-1")).toMatchObject({ state: "done", closureReason: "no-follow-on", resolution: "Two typos; otherwise fine." });
      expect(repo.listTransitions("req-1").at(-1)!.transitionNote).toBe(`Answered by ${PEER} via network hub https://hub.example/mcp (hub item ${hubId}).`);
      expect(outcome("req-1")).toEqual({ outcome: "done" });
      await pass(b.id);
      expect(hub.creates).toBe(1);
      expect([...hub.items.values()].filter((item) => item.destinationSession === PEER)).toHaveLength(1);
    });

    it("a create that never reached the hub is created on the next pass under the same id", async () => {
      const b = bind();
      hub.down = true;
      expect((await send(b.id, "req-7")).state).toBe("unknown");
      expect(hub.creates).toBe(0);
      hub.down = false;
      await pass(b.id);
      expect(hub.creates).toBe(1);
      expect(hub.items.get(networkHubRequestId(b, "req-7"))).toMatchObject({ destinationSession: PEER, body: "Review the release notes" });
      await pass(b.id);
      expect(hub.creates).toBe(1);
    });

    it("the same request id with another request is refused and sends nothing; the same request returns where it stands", async () => {
      const b = bind();
      const sent = await send(b.id, "req-2");
      expect(sent.state).toBe("sent");
      // The local item is OpenRig's, so its close wakes no seat: both sent outcomes say how to be woken.
      expect(sent.message).toContain("Nothing wakes you when it closes: to be woken, park a row of your own on it");
      await expect(send(b.id, "req-2", "Something else entirely")).rejects.toMatchObject({ code: "request_id_reused", status: 409 });
      expect(await send(b.id, "req-2")).toMatchObject({ state: "sent", message: expect.stringContaining("rig network request --help shows how") });
      expect(hub.creates).toBe(1);
      expect(repo.getById("req-2")!.body).toContain("Review the release notes");
      // An id that already names another local item is refused too.
      hub.add("hub-in");
      await pass(b.id);
      const [inbound] = runs("hub-in");
      await expect(send(b.id, inbound!.qitemId)).rejects.toMatchObject({ code: "request_id_reused" });
      expect(hub.creates).toBe(1);
    });

    // The wait the help teaches: a row of the seat's own, parked on the request item. Parked first, the answer wakes it.
    // Parked after the answer, nothing will, which is why the help says to check the request once after the park.
    it("a row parked on a request wakes when the answer lands; parked after the answer it never would, and the retry says so", async () => {
      const b = bind();
      const park = (row: string, on: string) =>
        repo.update({ qitemId: row, actorSession: b.localSession, state: "blocked", blockedOn: on, transitionNote: "waiting for the answer" });
      const waitRow = async (id: string) => { await repo.create({ qitemId: id, sourceSession: b.localSession, destinationSession: b.localSession, body: "Report the answer", nudge: false }); };

      expect((await send(b.id, "req-8")).state).toBe("sent");
      await waitRow("req-8-wait");
      park("req-8-wait", "req-8");
      answer(networkHubRequestId(b, "req-8"), { state: "done", closureReason: "no-follow-on", resolution: "Looks fine." });
      await pass(b.id);
      expect(repo.getById("req-8")!.state).toBe("done");
      expect(repo.getById("req-8-wait")).toMatchObject({ state: "pending", blockedOn: null });

      expect((await send(b.id, "req-9")).state).toBe("sent");
      answer(networkHubRequestId(b, "req-9"), { state: "done", closureReason: "no-follow-on", resolution: "Looks fine." });
      await pass(b.id);
      // The same-id retry of an answered request no longer invites a park.
      const again = await send(b.id, "req-9");
      expect(again).toMatchObject({ state: "sent", message: expect.stringContaining("It has closed, so nothing more will wake you for it: read its outcome with rig queue show req-9.") });
      expect(again.message).not.toContain("park a row");
      // Parked too late: block takes an id that isn't qitem-shaped unchecked, and the completion has already passed.
      await waitRow("req-9-wait");
      park("req-9-wait", "req-9");
      await pass(b.id);
      expect(repo.getById("req-9-wait")).toMatchObject({ state: "blocked", blockedOn: "req-9" });
      // A qitem-shaped request id makes block refuse a closed item outright.
      const shaped = "qitem-20000101000000-00000009";
      expect((await send(b.id, shaped)).state).toBe("sent");
      answer(networkHubRequestId(b, shaped), { state: "done", closureReason: "no-follow-on", resolution: "Looks fine." });
      await pass(b.id);
      await waitRow(`${shaped}-wait`);
      expect(() => park(`${shaped}-wait`, shaped)).toThrow(expect.objectContaining({ code: "blocker_not_live" }));
    });

    it("a peer the hub doesn't know closes the request failed with the hub's words, and nothing more is read", async () => {
      const b = bind();
      const sent = await send(b.id, "req-3", "Review the release notes", PEER.replace(/^sam/, "kim"));
      expect(sent.state).toBe("refused");
      expect(repo.getById("req-3")).toMatchObject({ state: "failed" });
      expect(repo.getById("req-3")!.resolution).toContain("destination_not_found");
      expect(outcome("req-3")).toEqual({ outcome: "refused" });
      await pass(b.id);
      expect(hub.creates).toBe(1);
    });

    it("a revoked binding leaves its open request open and says once that its answer can't be read here; a new binding brings the answer back", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-4");
      expect((await send(b.id, "req-4")).state).toBe("sent");
      hub.revoked = true;
      expect((await pass(b.id)).error).toBe("revoked");
      const ended = () => repo.listTransitions("req-4").filter((t) => t.transitionNote?.startsWith("The network binding this request was sent through has ended"));
      expect(ended()).toHaveLength(1);
      expect(repo.getById("req-4")!.state).toBe("blocked");
      expect(outcome("req-4")).toEqual({ outcome: null });
      hub.revoked = false;
      const again = bindings.create({ session: b.localSession, hubUrl: b.hubUrl, hubSeat: b.hubSeat, token: "tok-2" });
      answer(hubId, { state: "done", closureReason: "no-follow-on", resolution: "Looks good." });
      await pass(again.id);
      expect(repo.getById("req-4")).toMatchObject({ state: "done", resolution: "Looks good." });
      expect(ended()).toHaveLength(1);
    });

    it("a hub item handed on to one this participant can't read isn't an answer: the request stays open, said once; a readable successor's answer closes it", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-5");
      await send(b.id, "req-5");
      answer(hubId, { state: "handed-off", successor: null });
      await pass(b.id);
      await pass(b.id);
      expect(repo.getById("req-5")!.state).toBe("blocked");
      expect(repo.listTransitions("req-5").filter((t) => t.transitionNote?.startsWith("The hub item was handed on to an item this connection can't read"))).toHaveLength(1);
      const next = PEER.replace(/^sam/, "lee");
      hub.add("hub-next", "Review the release notes", next);
      answer("hub-next", { state: "done", closureReason: "no-follow-on", resolution: "Done by the next seat." });
      answer(hubId, { successor: "hub-next" });
      await pass(b.id);
      expect(repo.getById("req-5")).toMatchObject({ state: "done", resolution: "Done by the next seat." });
      expect(repo.listTransitions("req-5").at(-1)!.transitionNote).toBe(`Answered by ${next} via network hub https://hub.example/mcp (hub item hub-next).`);
    });

    it("peers reads the team for the participant's rig, and the routes send a request as the seat's participant", async () => {
      const b = bind();
      expect(await listNetworkPeers(deps, b)).toMatchObject({ bindingId: b.id, hubSeat: PARTICIPANT, team: { seats: [{ session: PEER }] } });
      expect(hub.teamCalls).toEqual([PARTICIPANT.slice(PARTICIPANT.indexOf("@") + 1)]);
      const app = new Hono();
      app.use("*", async (c, next) => { c.set("rigRepo" as never, new RigRepository(db) as never); c.set("queueRepo" as never, repo as never); await next(); });
      app.route("/api/network", networkRoutes({ home, hubConnect: hub.connect }));
      const peers = await app.request(`/api/network/bindings/${b.id}/peers`);
      expect(peers.status).toBe(200);
      const res = await app.request(`/api/network/bindings/${encodeURIComponent(b.localSession)}/requests`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ peer: PEER, requestId: "req-6", body: "Review the release notes" }) });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ localQitemId: "req-6", hubQitemId: networkHubRequestId(b, "req-6"), peer: PEER, state: "sent" });
      expect(hub.tokens.at(-1)).toBe("tok-1");
    });

    it("a hub handoff-and-complete (done, handed_off_to) is a handoff, not an answer: its successor's answer closes the request", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-8");
      await send(b.id, "req-8");
      answer(hubId, { state: "done", closureReason: "handed_off_to", resolution: "Passed to the next seat.", successor: null });
      await pass(b.id);
      expect(repo.getById("req-8")!.state).toBe("blocked");
      expect(repo.listTransitions("req-8").filter((t) => t.transitionNote?.startsWith("The hub item was handed on to an item this connection can't read"))).toHaveLength(1);
      const next = PEER.replace(/^sam/, "lee");
      hub.add("hub-next-2", "Review the release notes", next);
      answer("hub-next-2", { state: "done", closureReason: "no-follow-on", resolution: "Reviewed by the next seat." });
      answer(hubId, { successor: "hub-next-2" });
      await pass(b.id);
      expect(repo.getById("req-8")).toMatchObject({ state: "done", resolution: "Reviewed by the next seat." });
    });

    it("a hub close as escalation closes the request no-follow-on with the reason named, and the pass goes on", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-9");
      await send(b.id, "req-9");
      answer(hubId, { state: "done", closureReason: "escalation", resolution: "Raised with the lead." });
      expect((await pass(b.id)).error).toBeUndefined();
      expect(repo.getById("req-9")).toMatchObject({ state: "done", closureReason: "no-follow-on", resolution: "Raised with the lead." });
      expect(repo.listTransitions("req-9").at(-1)!.transitionNote).toBe(`Answered by ${PEER} via network hub https://hub.example/mcp (hub item ${hubId}); closed there as escalation.`);
      expect(outcome("req-9")).toEqual({ outcome: "done" });
    });

    it("a request canceled here while the hub's answer is being read keeps that cancel, and the pass goes on", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-10");
      await send(b.id, "req-10");
      answer(hubId, { state: "done", closureReason: "no-follow-on", resolution: "Too late." });
      hub.duringShow = (id) => { if (id === hubId) repo.update({ qitemId: "req-10", actorSession: b.localSession, state: "done", closureReason: "canceled" }); };
      expect((await pass(b.id)).error).toBeUndefined();
      expect(repo.getById("req-10")).toMatchObject({ state: "done", closureReason: "canceled" });
      expect(outcome("req-10")).toEqual({ outcome: "local_closed" });
    });

    it("the receipt holds no request text, and a request whose local text was erased is never sent", async () => {
      const b = bind();
      await send(b.id, "req-11", "Confidential request text");
      expect(JSON.stringify(db.prepare("SELECT * FROM network_requests WHERE local_qitem_id = 'req-11'").get())).not.toContain("Confidential request text");
      hub.down = true;
      expect((await send(b.id, "req-12", "Another confidential text")).state).toBe("unknown");
      hub.down = false;
      // As queue erasure's scrub leaves an item: its content gone, its record kept.
      db.prepare("UPDATE queue_items SET body = '', summary = NULL WHERE qitem_id = 'req-12'").run();
      const creates = hub.creates;
      await pass(b.id);
      expect(hub.creates).toBe(creates);
      expect(outcome("req-12")).toEqual({ outcome: "unknown" });
    });

    it("a hub URL's query is hidden in the request's queue text, which keeps the answer's provenance", async () => {
      const first = bind();
      bindings.disconnect(first.id);
      const b = bindings.create({ session: first.localSession, hubUrl: "https://hub.example/mcp?key=pasted-key", hubSeat: PARTICIPANT, token: "tok-q" });
      const hubId = networkHubRequestId(b, "req-13");
      await send(b.id, "req-13");
      answer(hubId, { state: "done", closureReason: "no-follow-on", resolution: "Done." });
      await pass(b.id);
      const texts = [repo.getById("req-13")!.body, ...repo.listTransitions("req-13").map((t) => t.transitionNote)].join("\n");
      expect(texts).not.toContain("pasted-key");
      expect(texts).toContain("https://hub.example/mcp (query hidden)");
    });

    it("a request recorded before fragments were hidden still reads back: its unconfirmed create is sent, not settled as erased", async () => {
      const first = bind();
      bindings.disconnect(first.id);
      const b = bindings.create({ session: first.localSession, hubUrl: "https://hub.example/mcp?key=pasted-key#frag=pasted", hubSeat: PARTICIPANT, token: "tok-f" });
      hub.down = true;
      expect((await send(b.id, "req-14")).state).toBe("unknown");
      expect((await send(b.id, "req-15", "A second request")).state).toBe("unknown");
      expect(repo.getById("req-14")!.body).toContain("https://hub.example/mcp (query and fragment hidden)");
      // As an item recorded before the upgrade reads: the query hidden, the fragment shown.
      const recordedBefore = (id: string) => db.prepare("UPDATE queue_items SET body = replace(body, ?, ?) WHERE qitem_id = ?")
        .run("https://hub.example/mcp (query and fragment hidden)", "https://hub.example/mcp#frag=pasted (query hidden)", id);
      recordedBefore("req-14");
      recordedBefore("req-15");
      // One whose request text changed since is still refused by the body hash.
      db.prepare("UPDATE queue_items SET body = replace(body, 'A second request', 'A changed request') WHERE qitem_id = 'req-15'").run();
      hub.down = false;
      await pass(b.id);
      expect(hub.items.get(networkHubRequestId(b, "req-14"))).toMatchObject({ destinationSession: PEER, body: "Review the release notes" });
      expect(outcome("req-14")).toEqual({ outcome: null });
      expect(repo.getById("req-14")!.state).toBe("blocked");
      expect(hub.items.has(networkHubRequestId(b, "req-15"))).toBe(false);
      expect(outcome("req-15")).toEqual({ outcome: "unknown" });
    });

    it("a command retry of an unconfirmed create shows the hub item first: one the hub rerouted after the lost reply is found, not refused", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-20");
      hub.loseCreateAnswer.add(hubId);
      expect((await send(b.id, "req-20")).state).toBe("unknown");
      expect(hub.creates).toBe(1);
      // The hub hands the item to another seat before the command is retried.
      answer(hubId, { destinationSession: `relief-${PEER}` });
      const shows: string[] = [];
      hub.duringShow = (id) => { shows.push(id); };
      expect(await send(b.id, "req-20")).toMatchObject({ state: "sent", hubQitemId: hubId });
      expect(shows).toEqual([hubId]);
      expect(hub.creates).toBe(1);
      expect(repo.getById("req-20")!.state).toBe("blocked");
      hub.duringShow = null;
      answer(hubId, { state: "done", closureReason: "no-follow-on", resolution: "Done by the relief." });
      await pass(b.id);
      expect(repo.getById("req-20")).toMatchObject({ state: "done", resolution: "Done by the relief." });
      expect(hub.creates).toBe(1);
    });

    it.each(["cancel", "erasure", "disconnect"] as const)("the person's %s while the pass reads a missing hub item starts no create", async (what) => {
      const b = bind();
      hub.down = true;
      expect((await send(b.id, "req-21")).state).toBe("unknown");
      hub.down = false;
      hub.duringShow = () => {
        if (what === "cancel") repo.update({ qitemId: "req-21", actorSession: b.localSession, state: "done", closureReason: "canceled" });
        if (what === "erasure") db.prepare("UPDATE queue_items SET body = '', summary = NULL WHERE qitem_id = 'req-21'").run();
        if (what === "disconnect") bindings.disconnect(b.id);
      };
      await pass(b.id);
      expect(hub.creates).toBe(0);
      expect(outcome("req-21")).toEqual({ outcome: what === "cancel" ? "local_closed" : what === "erasure" ? "unknown" : null });
    });

    it.each(["cancel", "disconnect"] as const)("the person's %s while the command reaches the hub starts no create", async (what) => {
      const b = bind();
      hub.duringConnect = () => {
        if (what === "cancel") repo.update({ qitemId: "req-22", actorSession: b.localSession, state: "done", closureReason: "canceled" });
        else bindings.disconnect(b.id);
      };
      expect((await send(b.id, "req-22")).state).toBe("unknown");
      hub.duringConnect = null;
      expect(hub.creates).toBe(0);
      expect(outcome("req-22")).toEqual({ outcome: what === "cancel" ? "local_closed" : null });
    });

    it("a retry after a local cancel sends nothing; a refusal from show that isn't not-found neither creates nor closes", async () => {
      const b = bind();
      hub.down = true;
      expect((await send(b.id, "req-14")).state).toBe("unknown");
      hub.down = false;
      repo.update({ qitemId: "req-14", actorSession: b.localSession, state: "done", closureReason: "canceled" });
      expect((await send(b.id, "req-14")).state).toBe("unknown");
      expect(hub.creates).toBe(0);
      expect(outcome("req-14")).toEqual({ outcome: "local_closed" });

      hub.down = true;
      expect((await send(b.id, "req-15")).state).toBe("unknown");
      hub.down = false;
      const hubId = networkHubRequestId(b, "req-15");
      hub.duringShow = (id) => { if (id === hubId) throw new HubError("refused", "Item is outside what this connection may reach.", "out_of_scope"); };
      await pass(b.id);
      expect(hub.creates).toBe(0);
      expect(repo.getById("req-15")!.state).toBe("blocked");
      expect(outcome("req-15")).toEqual({ outcome: null });
    });

    it("a show answering unavailable with a not-found code creates nothing, and the request stays unknown", async () => {
      const b = bind();
      hub.down = true;
      expect((await send(b.id, "req-17")).state).toBe("unknown");
      hub.down = false;
      const hubId = networkHubRequestId(b, "req-17");
      hub.duringShow = (id) => { if (id === hubId) throw new HubError("unavailable", "The hub couldn't tell.", "qitem_not_found"); };
      expect((await send(b.id, "req-17")).state).toBe("unknown");
      await pass(b.id);
      expect(hub.creates).toBe(0);
      expect(repo.getById("req-17")!.state).toBe("blocked");
      expect(outcome("req-17")).toEqual({ outcome: null });
    });

    it("a hub holding a different request under the derived id refuses it rather than confirming it", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-16");
      hub.items.set(hubId, { qitemId: hubId, sourceSession: PARTICIPANT, destinationSession: PEER, state: "pending", body: "someone else's text",
        summary: null, resolution: null, closureReason: null, notes: [] });
      expect((await send(b.id, "req-16")).state).toBe("refused");
      expect(repo.getById("req-16")!.state).toBe("failed");
      expect(repo.getById("req-16")!.resolution).toContain("qitem_body_not_saved");
    });

    it("a command retry and a pass that both find the hub item missing: the create that loses to a rerouted one reads it back, and its answer closes the request", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-30");
      hub.down = true;
      expect((await send(b.id, "req-30")).state).toBe("unknown");
      hub.down = false;
      // Both shows answer not-found only once both have asked; the first create to land is rerouted there at once.
      let asked = 0, release!: () => void;
      const both = new Promise<void>((resolve) => { release = resolve; });
      hub.duringShow = async (id) => { if (id !== hubId) return; if (++asked === 2) release(); await both; };
      hub.afterCreate = (id) => { if (id === hubId) answer(hubId, { destinationSession: `relief-${PEER}` }); };
      const [retry, passed] = await Promise.all([send(b.id, "req-30"), pass(b.id)]);
      hub.duringShow = null; hub.afterCreate = null;
      expect(retry.state).toBe("sent");
      expect(passed.error).toBeUndefined();
      expect(hub.creates).toBe(2);
      expect([...hub.items.keys()].filter((id) => id === hubId)).toHaveLength(1);
      expect(repo.getById("req-30")!.state).toBe("blocked");
      expect(outcome("req-30")).toEqual({ outcome: null });
      answer(hubId, { state: "done", closureReason: "no-follow-on", resolution: "Done by the relief." });
      await pass(b.id);
      expect(repo.getById("req-30")).toMatchObject({ state: "done", resolution: "Done by the relief." });
      expect(repo.listTransitions("req-30").filter((t) => t.transitionNote?.startsWith("Answered by"))).toHaveLength(1);
    });

    it("a taken id whose item can't be read back leaves the request unknown and open, not failed", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-31");
      hub.add(hubId, "another seat's item", PEER);
      hub.duringShow = (id) => { if (id === hubId) throw new HubError("refused", "Item is outside what this connection may reach.", "out_of_scope"); };
      expect((await send(b.id, "req-31")).state).toBe("unknown");
      expect(repo.getById("req-31")!.state).toBe("blocked");
      expect(outcome("req-31")).toEqual({ outcome: null });
    });

    it("a lost create reply, then a command retry the hub refuses with 401: the request stays open and unknown, and a new binding reads its answer once", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-32");
      hub.loseCreateAnswer.add(hubId);
      expect((await send(b.id, "req-32")).state).toBe("unknown");
      hub.revoked = true;
      const unknownNote = (t: { transitionNote?: string | null }) => t.transitionNote?.startsWith("The hub refused this binding's credential");
      for (let retry = 0; retry < 2; retry++) {
        expect(await send(b.id, "req-32")).toMatchObject({ state: "unknown", hubQitemId: hubId });
        expect(repo.getById("req-32")!.state).toBe("blocked");
        expect(outcome("req-32")).toEqual({ outcome: null });
      }
      expect(repo.listTransitions("req-32").filter(unknownNote)).toHaveLength(1);
      expect((await pass(b.id)).error).toBe("revoked");
      hub.revoked = false;
      const again = bindings.create({ session: b.localSession, hubUrl: b.hubUrl, hubSeat: b.hubSeat, token: "tok-2" });
      answer(hubId, { state: "done", closureReason: "no-follow-on", resolution: "Ran while you were away." });
      await pass(again.id);
      expect(repo.getById("req-32")).toMatchObject({ state: "done", resolution: "Ran while you were away." });
      expect(hub.creates).toBe(1);
      expect(repo.listTransitions("req-32").filter((t) => t.transitionNote?.startsWith("Answered by"))).toHaveLength(1);
    });

    it("a first try whose create meets a taken id and whose readback is refused with 401 stays open and unknown; a new binding reads the accepted work once", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-42");
      // As if a pass had created this request after the command recorded it, and the hub had moved it on since.
      hub.items.set(hubId, { qitemId: hubId, sourceSession: PARTICIPANT, destinationSession: `relief-${PEER}`, state: "pending", body: "Review the release notes",
        summary: null, resolution: null, closureReason: null, notes: [] });
      hub.duringShow = (id) => { if (id === hubId) throw new HubError("revoked", "The hub refused this participant's credential."); };
      expect(await send(b.id, "req-42")).toMatchObject({ state: "unknown", hubQitemId: hubId });
      expect(repo.getById("req-42")!.state).toBe("blocked");
      expect(outcome("req-42")).toEqual({ outcome: null });
      expect(repo.listTransitions("req-42").filter((t) => t.transitionNote?.startsWith("The hub refused this binding's credential"))).toHaveLength(1);
      hub.duringShow = null;
      hub.revoked = true;
      expect((await pass(b.id)).error).toBe("revoked");
      hub.revoked = false;
      const again = bindings.create({ session: b.localSession, hubUrl: b.hubUrl, hubSeat: b.hubSeat, token: "tok-2" });
      answer(hubId, { state: "done", closureReason: "no-follow-on", resolution: "Accepted and done." });
      await pass(again.id);
      expect(repo.getById("req-42")).toMatchObject({ state: "done", resolution: "Accepted and done." });
      expect(repo.listTransitions("req-42").filter((t) => t.transitionNote?.startsWith("Answered by"))).toHaveLength(1);
    });

    it("a tool list the hub can't serve still reads the answers: the request closes, and the pass reports the failure", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-41");
      expect((await send(b.id, "req-41")).state).toBe("sent");
      answer(hubId, { state: "done", closureReason: "no-follow-on", resolution: "Reviewed." });
      hub.add("hub-in-41");
      hub.failToolList = true;
      const passed = await pass(b.id);
      expect(repo.getById("req-41")).toMatchObject({ state: "done", resolution: "Reviewed." });
      expect(passed.error).toBe("unavailable");
      expect(bindings.get(b.id)!.lastError).toBe("The hub's tool list couldn't be read, so no work was taken in this pass: The hub couldn't be reached: tools/list failed");
      expect(runs("hub-in-41")).toHaveLength(0);
    });

    it("a new request the hub refuses with 401 is refused: nothing was ever accepted", async () => {
      const b = bind();
      hub.revoked = true;
      expect((await send(b.id, "req-33")).state).toBe("refused");
      expect(repo.getById("req-33")!.state).toBe("failed");
      expect(outcome("req-33")).toEqual({ outcome: "refused" });
    });

    it("a hub that stops answering while requests are read makes the pass unavailable and back off; the request stays open, and a later pass reads its answer", async () => {
      const b = bind();
      const hubId = networkHubRequestId(b, "req-34");
      await send(b.id, "req-34");
      const hangUp = (which: string) => { hub.duringShow = (id) => { if (id === which) throw new HubError("unavailable", "The hub couldn't be reached: socket hang up"); }; };
      let now = new Date("2026-11-21T23:00:00.000Z");
      const service = new NetworkConnectorService({ ...deps, now: () => now }, { intervalMs: 30_000, random: () => 0.5 });
      hangUp(hubId);
      await service.round();
      expect(service.snapshot().bindings[0]).toMatchObject({ backoffMs: 60_000, lastPass: expect.objectContaining({ error: "unavailable" }) });
      expect(bindings.get(b.id)!.lastError).toBe("The hub couldn't be reached: socket hang up");
      expect(repo.getById("req-34")!.state).toBe("blocked");
      // The same on the followed successor of an item handed on there.
      hub.add("hub-next-34", "Review the release notes", PEER);
      answer(hubId, { state: "handed-off", successor: "hub-next-34" });
      hangUp("hub-next-34");
      now = new Date(now.getTime() + 60_001);
      await service.round();
      expect(service.snapshot().bindings[0]).toMatchObject({ backoffMs: 120_000, lastPass: expect.objectContaining({ error: "unavailable" }) });
      expect(repo.getById("req-34")!.state).toBe("blocked");
      hub.duringShow = null;
      answer("hub-next-34", { state: "done", closureReason: "no-follow-on", resolution: "Reviewed." });
      now = new Date(now.getTime() + 120_001);
      await service.round();
      expect(repo.getById("req-34")).toMatchObject({ state: "done", resolution: "Reviewed." });
      expect(service.snapshot().bindings[0]!.backoffMs).toBe(30_000);
      expect(bindings.get(b.id)!.lastError).toBeNull();
    });

    /** A hub whose grant offers only `offered`, over MCP's Streamable HTTP. As OpenRig's hub does for an external grant
     *  (packages/cli/src/mcp-server.ts, externalTools and offered), a tool the grant doesn't name isn't listed, and a call
     *  to it gets the answer McpServer gives an unknown tool (the SDK's server/mcp.js: "Tool <name> not found", as a tool
     *  error). */
    async function grantHub(offered: string[], requesterQuestions = false) {
      const { createServer } = await import("node:http");
      const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
      const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
      const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
      const items = new Map<string, HubItem>();
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
      const refused = (text: string, code?: string) => ({ isError: true, content: [{ type: "text" as const, text }], ...(code ? { structuredContent: { code } } : {}) });
      const tools: Record<string, (args: Record<string, unknown>) => unknown> = {
        rig_team: () => json({ rig: "team", seats: [{ session: PEER }] }),
        rig_queue_create: (args) => {
          const id = String(args.qitemId);
          if (!items.has(id)) items.set(id, { qitemId: id, sourceSession: PARTICIPANT, destinationSession: args.requesterOf ? items.get(String(args.requesterOf))!.sourceSession! : String(args.destination), state: "pending",
            requesterOf: typeof args.requesterOf === "string" ? args.requesterOf : null,
            body: String(args.body), summary: null, resolution: null, closureReason: null });
          return json(items.get(id));
        },
        rig_queue_show: (args) => { const item = items.get(String(args.qitemId)); return item ? json({ item }) : refused(`qitem ${String(args.qitemId)} not found`, "qitem_not_found"); },
        rig_queue_list: (args) => json([...items.values()].filter((item) => item.destinationSession === PARTICIPANT && item.state === args.state)),
        rig_queue_claim: (args) => {
          const item = items.get(String(args.qitemId));
          if (item?.state !== "pending") return refused("That item can't be claimed.");
          item.state = "in-progress";
          return json(item);
        },
        rig_queue_update: (args) => {
          const item = items.get(String(args.qitemId));
          if (!item) return refused("No such item.", "qitem_not_found");
          if (typeof args.state === "string") Object.assign(item, { state: args.state, resolution: args.resolution ?? null, closureReason: args.closureReason ?? null });
          return json(item);
        },
      };
      const server = createServer((req, res) => {
        const mcp = new Server({ name: "grant hub", version: "1" }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: offered.map((name) => ({ name, inputSchema: { type: "object" as const, additionalProperties: false,
          ...(name === "rig_queue_create" && requesterQuestions ? { properties: { requesterOf: { type: "string" } } } : {}) } })) }));
        mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
          calls.push({ name: request.params.name, args: request.params.arguments ?? {} });
          return (offered.includes(request.params.name) ? tools[request.params.name]!(request.params.arguments ?? {})
            : refused(`MCP error -32602: Tool ${request.params.name} not found`)) as never;
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { void transport.close(); void mcp.close(); });
        void mcp.connect(transport).then(() => transport.handleRequest(req, res));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      return { items, calls, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
        close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
    }

    it.each([false, true])("requester routing checks the real MCP input schema (advertised=%s) before any local write", async (advertised) => {
      const real = await grantHub(["rig_queue_create", "rig_queue_show"], advertised);
      try {
        const first = bind();
        bindings.disconnect(first.id);
        const b = bindings.create({ session: first.localSession, hubUrl: real.url, hubSeat: PARTICIPANT, token: "tok-grant", allowHttp: true });
        const work = await repo.create({ qitemId: "wire-work", sourceSession: OPENRIG_SENDER, destinationSession: first.localSession, body: "Work" });
        repo.claim({ qitemId: work.qitemId, destinationSession: first.localSession });
        db.prepare("INSERT INTO network_receipts (binding_id, hub_qitem_id, local_qitem_id, created_at) VALUES (?, ?, ?, ?)")
          .run(b.id, "wire-hub-work", work.qitemId, new Date().toISOString());
        real.items.set("wire-hub-work", { qitemId: "wire-hub-work", sourceSession: PEER, destinationSession: PARTICIPANT, state: "in-progress", body: "Work", summary: null, resolution: null, closureReason: null });
        const send = originateNetworkRequest({ ...deps, connect: connectMcpHub }, bindings.get(b.id)!, { requesterOf: work.qitemId, requestId: "wire-question", body: "Which audience?" });
        if (advertised) {
          const result = await send;
          expect(result.state).toBe("sent");
          const create = real.calls.filter(c => c.name === "rig_queue_create");
          expect(create).toHaveLength(1);
          expect(create[0]!.args).toMatchObject({ requesterOf: "wire-hub-work", body: "Which audience?" });
          expect(create[0]!.args).not.toHaveProperty("destination");
          expect(real.items.get(result.hubQitemId)).toMatchObject({ requesterOf: "wire-hub-work", destinationSession: PEER });
        } else {
          await expect(send).rejects.toMatchObject({ code: "requester_question_unsupported" });
          expect(real.calls).toEqual([]);
          expect(repo.getById("wire-question")).toBeNull();
          expect(repo.getById(work.qitemId)!.state).toBe("in-progress");
          expect(db.prepare("SELECT count(*) AS n FROM network_requests").get()).toEqual({ n: 0 });
        }
      } finally { await real.close(); }
    });

    it.each([
      ["sending only (team, create and show)", ["rig_team", "rig_queue_create", "rig_queue_show"]],
      ["both ways", ["rig_team", "rig_queue_create", "rig_queue_show", "rig_queue_list", "rig_queue_claim", "rig_queue_update"]],
    ])("a grant for %s sends a request and reads its answer back into it, through a real MCP hub", async (_grant, offered) => {
      const real = await grantHub(offered);
      try {
        const first = bind();
        bindings.disconnect(first.id);
        const b = bindings.create({ session: first.localSession, hubUrl: real.url, hubSeat: PARTICIPANT, token: "tok-grant", allowHttp: true });
        const viaHub = { ...deps, connect: connectMcpHub };
        const hubId = networkHubRequestId(b, "req-40");
        expect(await originateNetworkRequest(viaHub, bindings.get(b.id)!, { peer: PEER, requestId: "req-40", body: "Review the release notes" })).toMatchObject({ state: "sent" });
        // Work for the participant, which only a grant with the queue's list, claim and update can take.
        real.items.set("hub-in-40", { qitemId: "hub-in-40", sourceSession: PEER, destinationSession: PARTICIPANT, state: "pending", body: "Summarize the notes",
          summary: "Summarize the notes", resolution: null, closureReason: null });
        Object.assign(real.items.get(hubId)!, { state: "done", closureReason: "no-follow-on", resolution: "Looks good." });
        const passed = await runNetworkBindingPass(viaHub, bindings.get(b.id)!);
        expect(passed.error).toBeUndefined();
        expect(bindings.get(b.id)!.lastError).toBeNull();
        expect(repo.getById("req-40")).toMatchObject({ state: "done", resolution: "Looks good." });
        expect(runs("hub-in-40")).toHaveLength(offered.includes("rig_queue_list") ? 1 : 0);
        expect(real.items.get("hub-in-40")!.state).toBe(offered.includes("rig_queue_list") ? "in-progress" : "pending");
      } finally {
        await real.close();
      }
    });
  });

  it("reads a hub tool result: unknown outcome, a fair-use hold and the hub's transient codes are unavailable; other codes are refusals", () => {
    const failure = (structuredContent: Record<string, unknown>) => {
      try { parseHubToolResult({ isError: true, content: [{ type: "text", text: "failed" }], structuredContent }); } catch (error) { return error as HubError; }
      throw new Error("expected a HubError");
    };
    expect(failure({ code: "request_failed", outcome: "unknown" })).toMatchObject({ kind: "unavailable", code: "request_failed" });
    expect(failure({ code: "fair_use_retry_later", retryable: true })).toMatchObject({ kind: "unavailable" });
    for (const code of ["daemon_unreachable", "daemon_timeout", "request_failed"]) expect(failure({ code })).toMatchObject({ kind: "unavailable", code });
    expect(failure({ code: "destination_not_found" })).toMatchObject({ kind: "refused", code: "destination_not_found" });
    expect(parseHubToolResult({ content: [{ type: "text", text: "{\"qitemId\":\"x\"}" }] })).toEqual({ qitemId: "x" });
  });
});
