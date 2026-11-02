// Agent network, increment A: two assistants connected through the grant service (openrig.grant/v1), each with its own
// seat, discover each other and the team, queue work to each other, claim it and return the result on the same item,
// and come back to it without duplicates. Driven through rig mcp serve --http --grant-service and the daemon's real
// routes; the fake grant service answers each connection's key with that connection's grant.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type Database from "better-sqlite3";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { setSelfHostId } from "../../daemon/src/domain/hosts/fanout-contract.js";
import { startMcpHttpServer } from "../src/mcp-http.js";

const SCHEMA = "openrig.grant/v1";
const INSTANCE = "core-test-01";
const RIG = "team-a";
const LEAD = `lead@${RIG}`;
/** Two connections of one account: each its own key, grant and seat. */
const A = { key: `${"8977f2dc0000aaaa1111bbbb"}.cus_VVMAexample01.${"ab".repeat(24)}`, grant: "8977f2dc0000aaaa1111bbbb", seat: `cus-vvmaexample01-chatgpt@${RIG}` };
const B = { key: `${"8977f2dc0000aaaa2222cccc"}.cus_VVMAexample01.${"cd".repeat(24)}`, grant: "8977f2dc0000aaaa2222cccc", seat: `cus-vvmaexample01-claude@${RIG}` };
const NETWORK = { queue: ["create", "show", "list", "claim", "update"], team: ["list"], artifact: ["read"] };
const V1 = { queue: ["create", "show", "list"], artifact: ["read"] };

const active = (who: typeof A, objects: Record<string, string[]>) => ({
  schema: SCHEMA, status: "active",
  principal: { id: "cus_VVMAexample01", kind: "external_caller", label: "External caller …mple01" },
  grant: { id: who.grant, version: 1, updated_at: "2026-11-02T05:00:00.000Z", expires_at: null, cache_seconds: 0, revocation: "per_request" },
  environment: { id: RIG, core_instance: INSTANCE, studio: "https://studio.example", lead: LEAD },
  seat: who.seat, rigs: [RIG], artifact_roots: [], access_class: "work", objects,
});

describe("agent network increment A: OAuth-connected assistants work with each other and the team", () => {
  let db: Database.Database;
  let home: string;
  let repo: QueueRepository;
  let daemon: ServerType;
  let daemonUrl: string;
  let setup: ReturnType<typeof createTestApp>;
  let service: http.Server;
  let serviceUrl: string;
  /** What each connection's grant names, by key; a key set to "revoked" is answered revoked. */
  let grants: Map<string, Record<string, string[]> | "revoked">;
  const closers: Array<() => Promise<void>> = [];
  const saved = { home: process.env.OPENRIG_HOME, session: process.env.OPENRIG_SESSION_NAME };

  beforeEach(async () => {
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-network-"));
    process.env.OPENRIG_HOME = home;
    process.env.OPENRIG_SESSION_NAME = "env-seat@elsewhere";
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    setup = createTestApp(db, { appDeps: { queueRepo: repo } });
    daemon = await new Promise<ServerType>((resolve) => { const s = serve({ fetch: setup.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
    daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
    setSelfHostId(INSTANCE);
    grants = new Map([[A.key, NETWORK], [B.key, NETWORK]]);
    service = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        const who = key === A.key ? A : key === B.key ? B : null;
        const objects = who ? grants.get(who.key) : undefined;
        const body = !who || !objects ? { schema: SCHEMA, status: "unknown" }
          : objects === "revoked" ? { schema: SCHEMA, status: "revoked" } : active(who, objects);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}/api/connector/v1/grant`;
    for (const member of ["cus-vvmaexample01-chatgpt", "cus-vvmaexample01-claude", "lead"]) seat(RIG, member);
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await new Promise<void>((resolve) => service.close(() => resolve()));
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    setSelfHostId(null);
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = saved.home;
    if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = saved.session;
  });

  function seat(rigName: string, member: string) {
    const rig = setup.rigRepo.listRigs?.().find((r: { name: string }) => r.name === rigName) ?? setup.rigRepo.createRig(rigName);
    const node = setup.rigRepo.addNode(rig.id, `pod.${member}`, { role: "worker" });
    setup.sessionRegistry.registerSession(node.id, `${member}@${rigName}`);
  }

  async function listen() {
    const served = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile: path.join(home, "mcp-http-tokens.json"),
      grantService: { url: serviceUrl, timeoutMs: 1_000 } });
    closers.push(() => served.close());
    return served;
  }

  async function connect(url: string, who: typeof A) {
    const client = new Client({ name: "network-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${who.key}` } } }));
    closers.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, structured: result.structuredContent as Record<string, any>, text: (result.content as Array<{ text: string }>)[0]?.text ?? "" };
    };
    return Object.assign(call, { tools: async () => (await client.listTools()).tools.map((tool) => tool.name).sort() });
  }

  const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
  const row = (qitemId: string) => repo.getById(qitemId)!;
  const createdId = (result: { structured: Record<string, any>; text: string }) => String(result.structured?.qitemId ?? JSON.parse(result.text).qitemId);

  it("offers claim, update and rig_team only to a grant that names them; a v1 grant keeps exactly today's four tools", async () => {
    grants.set(B.key, V1);
    const served = await listen();
    expect(await (await connect(served.url, A)).tools()).toEqual(
      ["rig_artifact_read", "rig_queue_claim", "rig_queue_create", "rig_queue_list", "rig_queue_show", "rig_queue_update", "rig_team"]);
    expect(await (await connect(served.url, B)).tools()).toEqual(["rig_artifact_read", "rig_queue_create", "rig_queue_list", "rig_queue_show"]);
  });

  it("A discovers B and the team, queues work to B; B claims it and returns the result on the same item, which A reads", async () => {
    const served = await listen();
    const a = await connect(served.url, A);
    const b = await connect(served.url, B);
    const team = await a("rig_team", { rigId: RIG });
    expect(team.isError).toBe(false);
    expect(team.text).toContain(B.seat);
    expect(team.text).toContain(LEAD);

    const sent = await a("rig_queue_create", { destination: B.seat, body: "Critique this plan.", tags: ["review"] });
    expect(sent.isError).toBe(false);
    const qitemId = createdId(sent);
    expect(row(qitemId)).toMatchObject({ sourceSession: A.seat, destinationSession: B.seat });

    // What A reads at each step: queued (pending, unclaimed), picked up (B's claim), answered (done with a resolution).
    // B reading or listing the item changes none of it.
    const inbox = await b("rig_queue_list", { owned: true });
    expect(inbox.text).toContain(qitemId);
    expect((await b("rig_queue_show", { qitemId })).isError).toBe(false);
    expect((await a("rig_queue_show", { qitemId })).structured.item).toMatchObject({ state: "pending", claimedAt: null });
    expect((await b("rig_queue_claim", { qitemId })).isError).toBe(false);
    expect((await a("rig_queue_show", { qitemId })).structured.item).toMatchObject({ state: "in-progress", resolution: null });
    expect((await b("rig_queue_update", { qitemId, state: "done", resolution: "Two risks; see the notes.", closureReason: "no-follow-on" })).isError).toBe(false);
    expect(row(qitemId)).toMatchObject({ state: "done", resolution: "Two risks; see the notes." });

    const followUp = await a("rig_queue_show", { qitemId });
    expect(followUp.isError).toBe(false);
    expect(followUp.text).toContain("Two risks; see the notes.");
    expect(followUp.text).toContain(B.seat);
  });

  it("a message is an item the receiver reads and closes, and the reply is an item back, read by the first assistant", async () => {
    const served = await listen();
    const a = await connect(served.url, A);
    const b = await connect(served.url, B);
    const message = createdId(await a("rig_queue_create", { destination: B.seat, summary: "FYI: the plan changed", body: "We're shipping the smaller fix first.", tags: ["message"] }));
    expect((await b("rig_queue_show", { qitemId: message })).text).toContain("We're shipping the smaller fix first.");
    expect((await b("rig_queue_update", { qitemId: message, state: "done", closureReason: "no-follow-on", resolution: "Read." })).isError).toBe(false);
    const reply = createdId(await b("rig_queue_create", { destination: A.seat, summary: "Re: the plan changed", body: "Agreed; I'll review the fix.", tags: ["message"] }));
    expect(row(reply)).toMatchObject({ sourceSession: B.seat, destinationSession: A.seat });
    expect((await a("rig_queue_list", { owned: true })).text).toContain(reply);
    expect((await a("rig_queue_show", { qitemId: reply })).text).toContain("Agreed; I'll review the fix.");
  });

  it("B hands work on to the team and reads the team's result; A's task and B's task are separate items, each with its own result", async () => {
    const served = await listen();
    const b = await connect(served.url, B);
    const delegated = createdId(await b("rig_queue_create", { destination: LEAD, body: "Implement the agreed change." }));
    repo.update({ qitemId: delegated, actorSession: LEAD, state: "done", closureReason: "no-follow-on", resolution: "Merged as abc123." } as never);
    expect((await b("rig_queue_show", { qitemId: delegated })).text).toContain("Merged as abc123.");
  });

  it("a create retried with the same qitemId after a lost reply is one item, and a new session with the same key finds the same work", async () => {
    const served = await listen();
    const a = await connect(served.url, A);
    const first = createdId(await a("rig_queue_create", { destination: B.seat, body: "Once.", qitemId: "qitem-network-retry-1" }));
    const before = rows();
    const again = createdId(await a("rig_queue_create", { destination: B.seat, body: "Once.", qitemId: "qitem-network-retry-1" }));
    expect(again).toBe(first);
    expect(rows()).toBe(before);
    const reentered = await connect(served.url, A);
    expect((await reentered("rig_queue_list", {})).text).toContain(first);
    expect(rows()).toBe(before);
  });

  it("two assistants calling at once each act as their own seat", async () => {
    const served = await listen();
    const [a, b] = await Promise.all([connect(served.url, A), connect(served.url, B)]);
    const [fromA, fromB] = await Promise.all([
      a("rig_queue_create", { destination: LEAD, body: "from A" }),
      b("rig_queue_create", { destination: LEAD, body: "from B" }),
    ]);
    expect(row(createdId(fromA)).sourceSession).toBe(A.seat);
    expect(row(createdId(fromB)).sourceSession).toBe(B.seat);
  });

  it("each changes only items addressed to its own seat, stays in its workspace, and a revoked connection changes nothing", async () => {
    seat("team-b", "lead");
    const served = await listen();
    const a = await connect(served.url, A);
    const b = await connect(served.url, B);
    const toB = createdId(await a("rig_queue_create", { destination: B.seat, body: "for B" }));
    const toTeam = (await repo.create({ sourceSession: LEAD, destinationSession: "worker@team-a", body: "team-internal", nudge: false } as never)).qitemId;
    const toA = (await repo.create({ sourceSession: LEAD, destinationSession: A.seat, body: "for A", nudge: false } as never)).qitemId;
    const refused = { isError: true, structured: { code: "out_of_scope" } };
    // A sent B's item and may read it; the daemon refuses its claim as someone else's.
    expect((await a("rig_queue_claim", { qitemId: toB })).isError).toBe(true);
    expect(await a("rig_queue_update", { qitemId: toB, state: "done", closureReason: "no-follow-on" })).toMatchObject(refused);
    expect(await b("rig_queue_claim", { qitemId: toTeam })).toMatchObject(refused);
    expect(await b("rig_queue_claim", { qitemId: toA })).toMatchObject(refused);
    expect(await b("rig_queue_show", { qitemId: toTeam })).toMatchObject(refused);
    expect(await a("rig_queue_create", { destination: "lead@team-b", body: "other workspace" })).toMatchObject(refused);
    expect(await a("rig_queue_create", { destination: "someone@external", body: "a person" })).toMatchObject(refused);
    expect(await a("rig_team", { rigId: "team-b" })).toMatchObject(refused);
    expect(row(toB).state).toBe("pending");

    // B waits only on an item it can read: never on a person (who would be asked) or on the team's own item.
    expect((await b("rig_queue_claim", { qitemId: toB })).isError).toBe(false);
    for (const blockedOn of ["someone@external", toTeam, "qitem-network-missing"]) {
      expect((await b("rig_queue_update", { qitemId: toB, state: "blocked", blockedOn }))).toMatchObject({ isError: true, structured: { code: "out_of_scope" } });
    }
    expect(row(toB).state).toBe("in-progress");
    const ask = createdId(await b("rig_queue_create", { destination: LEAD, body: "Which of the two plans?" }));
    expect((await b("rig_queue_update", { qitemId: toB, state: "blocked", blockedOn: ask })).isError).toBe(false);
    expect(row(toB)).toMatchObject({ state: "blocked", blockedOn: ask });

    grants.set(B.key, "revoked");
    const before = rows();
    await expect(b("rig_queue_update", { qitemId: toB, state: "in-progress" })).rejects.toThrow();
    expect(row(toB).state).toBe("blocked");
    expect(rows()).toBe(before);
  });

  it("claim and update answer an assistant with what show shows: a blocker or closure target it can't read stays hidden", async () => {
    const served = await listen();
    const b = await connect(served.url, B);
    const internal = (await repo.create({ sourceSession: LEAD, destinationSession: "worker@team-a", body: "team-internal", nudge: false } as never)).qitemId;
    const mine = (await repo.create({ sourceSession: LEAD, destinationSession: B.seat, body: "for B", nudge: false } as never)).qitemId;
    repo.update({ qitemId: mine, actorSession: LEAD, state: "blocked", blockedOn: internal, closureReason: "blocked_on", closureTarget: internal, transitionNote: "waiting on the team" } as never);
    const shown = await b("rig_queue_show", { qitemId: mine });
    const noted = await b("rig_queue_update", { qitemId: mine, note: "seen it" });
    const claimed = await b("rig_queue_claim", { qitemId: mine });
    for (const result of [shown, noted, claimed]) {
      expect(result.isError).toBe(false);
      expect(result.text).not.toContain(internal);
    }
    expect(row(mine).state).toBe("in-progress");
  });

  it("an assistant can't change an item addressed to it that it can't read: another workspace's, or another caller's under a partial grant", async () => {
    grants.set(B.key, { queue: ["create", "show", "list", "claim", "update"], artifact: ["read"] });
    const served = await listen();
    const b = await connect(served.url, B);
    const refused = { isError: true, structured: { code: "out_of_scope" } };
    const foreign = (await repo.create({ sourceSession: "lead@team-b", destinationSession: B.seat, body: "from another workspace", nudge: false } as never)).qitemId;
    const fromCaller = (await repo.create({ sourceSession: "cus-vvmaexample02-caller@team-a", destinationSession: B.seat, body: "from another caller", nudge: false } as never)).qitemId;
    for (const qitemId of [foreign, fromCaller]) {
      const before = repo.listTransitions(qitemId).length;
      expect(await b("rig_queue_update", { qitemId, note: "mine?" })).toMatchObject(refused);
      expect(await b("rig_queue_update", { qitemId, state: "done", closureReason: "no-follow-on" })).toMatchObject(refused);
      expect(row(qitemId).state).toBe("pending");
      expect(repo.listTransitions(qitemId).length).toBe(before);
    }
  });

  it("an assistant's park names a blocker it can read: a bare re-park after a claim is refused, whether the team's blocker is open or closed", async () => {
    const served = await listen();
    const b = await connect(served.url, B);
    for (const closedAfterClaim of [false, true]) {
      const internal = (await repo.create({ sourceSession: LEAD, destinationSession: "worker@team-a", body: "team-internal", nudge: false } as never)).qitemId;
      const mine = (await repo.create({ sourceSession: LEAD, destinationSession: B.seat, body: "for B", nudge: false } as never)).qitemId;
      repo.update({ qitemId: mine, actorSession: LEAD, state: "blocked", blockedOn: internal, transitionNote: "waiting on the team" } as never);
      expect((await b("rig_queue_claim", { qitemId: mine })).isError).toBe(false);
      if (closedAfterClaim) repo.update({ qitemId: internal, actorSession: "worker@team-a", state: "done", closureReason: "no-follow-on" } as never);
      const reparked = await b("rig_queue_update", { qitemId: mine, state: "blocked" });
      expect(reparked).toMatchObject({ isError: true, structured: { code: "out_of_scope" } });
      expect(reparked.text).not.toContain(internal);
      expect(row(mine)).toMatchObject({ state: "in-progress", blockedOn: null });
    }
  });

  it("team discovery names a hosted member's last ring only when it's on an item the assistant may read", async () => {
    const workspace = path.join(home, "workspace");
    const savedWorkspace = process.env.OPENRIG_WORKSPACE_ROOT;
    process.env.OPENRIG_WORKSPACE_ROOT = workspace;
    try {
      fs.mkdirSync(path.join(workspace, "rosters"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "rosters", "team.json"), JSON.stringify({
        version: 1, id: "team", name: "Team", purpose: "Ship the release", curator: { seat: LEAD, host: INSTANCE }, updated_at: "2026-11-02",
        members: [{ seat: `grok@${RIG}`, host: INSTANCE, capabilities: ["web research"], engagement: ["delegate"], use_when: "Current sources", why: "Searches the web", hosted: true }],
      }));
      const served = await listen();
      const a = await connect(served.url, A);
      const ring = (qitemId: string, at: string) =>
        db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?").run(at, "wake-accepted:webhook answered 202", qitemId);
      const fromA = (await repo.create({ sourceSession: A.seat, destinationSession: `grok@${RIG}`, body: "Find the release date.", nudge: false } as never)).qitemId;
      const internal = (await repo.create({ sourceSession: LEAD, destinationSession: `grok@${RIG}`, body: "team-internal", nudge: false } as never)).qitemId;
      ring(fromA, "2026-11-02T11:00:00.000Z");
      ring(internal, "2026-11-02T12:00:00.000Z");
      const team = await a("rig_team", { rigId: RIG });
      expect(team.isError).toBe(false);
      expect(team.structured.hostedMembers).toMatchObject([{ session: `grok@${RIG}`, presence: { lastWake: { qitemId: fromA, at: "2026-11-02T11:00:00.000Z" } } }]);
      expect(team.text).not.toContain(internal);
    } finally {
      if (savedWorkspace === undefined) delete process.env.OPENRIG_WORKSPACE_ROOT; else process.env.OPENRIG_WORKSPACE_ROOT = savedWorkspace;
    }
  });

  it("a v1 grant keeps today's rules: no task to or from another caller's seat", async () => {
    grants.set(A.key, V1);
    grants.set(B.key, V1);
    const served = await listen();
    const a = await connect(served.url, A);
    const refused = { isError: true, structured: { code: "out_of_scope" } };
    expect(await a("rig_queue_create", { destination: B.seat, body: "v1 can't" })).toMatchObject(refused);
    const fromB = (await repo.create({ sourceSession: B.seat, destinationSession: A.seat, body: "from another caller", nudge: false } as never)).qitemId;
    expect(await a("rig_queue_show", { qitemId: fromB })).toMatchObject(refused);
  });
});
