// Slice 15: the record and read the openrig plugin's hooks use, on the queue's existing fields and routes. A create with
// `--return-route auto` records the conversation's key as a tag beside the issued address; the hook reads its addresses
// back with the exact tag filter (`rig queue list --tag … --all`), through the work's handoffs; another conversation's key
// reads nothing. Only a client on this machine (the CLI, the stdio MCP server) can write the key: from anyone else the tag
// is dropped, never refused.
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";
import { issuedReturnAddress } from "../src/domain/return-route.js";
import { conversationKeyTag } from "../src/conversation-key-surface.js";

/** The request's TCP peer as @hono/node-server gives it to a route (c.env.incoming.socket). */
const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
/** A client on this machine, as the CLI and the stdio MCP server reach the daemon. */
const LOCAL = peer("127.0.0.1");

describe("the conversation key's record and read", () => {
  let db: Database.Database;
  let app: Hono;
  let repo: QueueRepository;
  const servers: ServerType[] = [];
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo); c.set("eventBus" as never, new EventBus(db)); await next(); });
    app.route("/api/queue", queueRoutes());
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    db.close();
  });

  const mine = conversationKeyTag("claude:1a2b3c4d.5000:4242");
  const theirs = conversationKeyTag("claude:1a2b3c4d.6000:5151");
  const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}, env: object = LOCAL) =>
    app.request(`/api/queue${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, env);
  const create = (body: Record<string, unknown>, headers: Record<string, string> = {}, env: object = LOCAL) => post("/create",
    { destinationSession: "operator-agent@kernel", body: "Goal: add word counts", summary: "the goal", nudge: false, ...body }, headers, env);
  // What the hook asks: `rig queue list --tag <its key> --all --json` (compact, every state).
  const read = async (tag: string) => (await (await app.request(`/api/queue/list?tag=${encodeURIComponent(tag)}&compact=1&limit=100`)).json()) as Array<Record<string, unknown>>;

  it("records the key with the issued address, and reads it back under that key only", async () => {
    expect((await create({ qitemId: "qitem-goal-1", returnRoute: "auto", tags: [mine] })).status).toBe(201);
    expect((await create({ qitemId: "qitem-goal-2", returnRoute: "auto", tags: [theirs] })).status).toBe(201);
    const rows = await read(mine);
    expect(rows.map((row) => [row.qitemId, row.returnRoute, row.returnRouteBasis])).toEqual([["qitem-goal-1", issuedReturnAddress("qitem-goal-1"), "issued-actor"]]);
    expect(rows[0]!.tags).toEqual([mine]);
    expect((await read(theirs)).map((row) => row.returnRoute)).toEqual([issuedReturnAddress("qitem-goal-2")]);
    expect(await read(conversationKeyTag("claude:1a2b3c4d.7000:6262"))).toEqual([]);
  });

  // claude8: the person's agent handed a fix over with a second `--return-route auto` from the same conversation, and
  // OpenRig issued that work a second address. The seat's prompts on it then reached no one, and the agent's own wait
  // watched only the first address.
  it("keeps one address for one conversation: a later auto create under its key reuses the address it was issued", async () => {
    expect((await create({ qitemId: "qitem-goal-1", returnRoute: "auto", tags: [mine] })).status).toBe(201);
    const issued = issuedReturnAddress("qitem-goal-1");
    // A later goal with no identity of its own is declared by the conversation's address, as the first was.
    const second = await (await create({ qitemId: "qitem-goal-2", returnRoute: "auto", tags: [mine] })).json() as Record<string, unknown>;
    expect(second).toMatchObject({ sourceSession: issued, returnRoute: issued, returnRouteBasis: "issued-actor" });
    // Sent as that address (OPENRIG_SESSION_NAME, as claude8's agent did): its own identity, and the same route.
    const asAddress = await post("/create", { qitemId: "qitem-goal-3", destinationSession: "dev-build@starter", body: "Fix the commit author",
      summary: "the fix", nudge: false, returnRoute: "auto", tags: [mine] }, { "x-openrig-session": issued });
    expect(await asAddress.json()).toMatchObject({ sourceSession: issued, returnRoute: issued, returnRouteBasis: "issued" });
    // Another conversation, and a create that names no conversation, each still get their own.
    expect((await (await create({ qitemId: "qitem-goal-4", returnRoute: "auto", tags: [theirs] })).json() as { returnRoute: string }).returnRoute)
      .toBe(issuedReturnAddress("qitem-goal-4"));
    expect((await (await create({ qitemId: "qitem-goal-5", returnRoute: "auto" })).json() as { returnRoute: string }).returnRoute)
      .toBe(issuedReturnAddress("qitem-goal-5"));
    // An exact retry of a later create keeps its address.
    expect((await (await create({ qitemId: "qitem-goal-2", returnRoute: "auto", tags: [mine] })).json() as { returnRoute: string }).returnRoute).toBe(issued);
    // The hooks read one address under the key.
    expect([...new Set((await read(mine)).map((row) => row.returnRoute))]).toEqual([issued]);
  });

  it("still reads the address after the work is handed on and its first row closes", async () => {
    expect((await create({ qitemId: "qitem-goal-1", returnRoute: "auto", tags: [mine] })).status).toBe(201);
    const issued = issuedReturnAddress("qitem-goal-1");
    const { created } = await repo.handoff({ qitemId: "qitem-goal-1", fromSession: "operator-agent@kernel", toSession: "dev-build@starter", nudge: false });
    expect(created.returnRoute).toBe(issued);
    const rows = await read(mine);
    expect(rows.find((row) => row.qitemId === "qitem-goal-1")).toMatchObject({ state: "handed-off", returnRoute: issued });
  });

  // #3964 review F1: the hooks take every issued address recorded beside a conversation's key as that conversation's, and
  // an auto create under the key reuses it. An MCP grant holder who could read a person's key off their rows could file
  // work under it, and the team's questions about that work would wake the person's conversation as their own handover.
  const OUTSIDE: Array<[string, Record<string, string>, object]> = [
    ["another machine's peer", {}, peer("192.0.2.10")],
    ["an in-process request, with no socket", {}, {}],
    ["a request another host's daemon relayed", { "x-openrig-relay": "host-b" }, LOCAL],
    ["the MCP HTTP adapter's caller", { "x-openrig-principal": JSON.stringify({ source: "grant-service", id: "cus_A1" }) }, LOCAL],
    ["a scoped MCP caller's request", { "x-openrig-file-roots": "[]" }, LOCAL],
    ["a request through a proxy", { "x-forwarded-for": "198.51.100.7" }, LOCAL],
  ];

  it("keeps the key only from a client on this machine: from anyone else the tag is dropped, the create goes on, and no address is reused", async () => {
    expect((await create({ qitemId: "qitem-goal-1", returnRoute: "auto", tags: [mine] })).status).toBe(201);
    const issued = issuedReturnAddress("qitem-goal-1");
    for (const [index, [label, headers, env]] of OUTSIDE.entries()) {
      const qitemId = `qitem-outside-${index}`;
      const res = await create({ qitemId, returnRoute: "auto", tags: ["mission:m", mine] }, headers, env);
      expect(res.status, label).toBe(201);
      const row = await res.json() as { returnRoute: string; tags: string[] };
      // Its own address, not the conversation's, and its other tags as sent.
      expect(row.returnRoute, label).toBe(issuedReturnAddress(qitemId));
      expect(row.tags, label).toEqual(["mission:m"]);
    }
    // The hooks' read under the key still finds only the conversation's own address.
    expect((await read(mine)).map((row) => row.qitemId)).toEqual(["qitem-goal-1"]);
    expect([...new Set((await read(mine)).map((row) => row.returnRoute))]).toEqual([issued]);
  });

  it("from outside this machine, a key can't be attached to an issued address later either: a handoff's or a tag add's is dropped", async () => {
    // Work filed from outside with an address of its own, which no conversation's key names.
    const [, headers, env] = OUTSIDE[0]!;
    const own = await (await create({ qitemId: "qitem-outside", returnRoute: "auto", destinationSession: "cus-a1-caller@team" }, headers, env)).json() as { returnRoute: string };
    expect(own.returnRoute).toBe(issuedReturnAddress("qitem-outside"));
    for (const [index, [label, extra, from]] of OUTSIDE.entries()) {
      const tagged = await post("/qitem-outside/tags", { add: [mine, `label:${index}`] }, { "x-openrig-session": "cus-a1-caller@team", ...extra }, from);
      expect(tagged.status, label).toBe(200);
      expect((await tagged.json() as { added: string[] }).added, label).toEqual([`label:${index}`]);
    }
    // Only the key, from outside: nothing is added, and nothing is refused.
    const onlyKey = await post("/qitem-outside/tags", { add: [mine] }, { "x-openrig-session": "cus-a1-caller@team" }, env);
    expect(onlyKey.status).toBe(200);
    expect((await onlyKey.json() as { added: string[] }).added).toEqual([]);
    // A successor carries the issued address with it, so a key given to it from outside is dropped too.
    let current = "qitem-outside";
    for (const verb of ["handoff", "handoff-and-complete"]) {
      const handed = await post(`/${current}/${verb}`, { toSession: "dev-build@starter", tags: ["mission:m", mine], nudge: false },
        { "x-openrig-session": "cus-a1-caller@team" }, env);
      expect(handed.status, verb).toBe(201);
      const { created } = await handed.json() as { created: { qitemId: string; tags: string[]; returnRoute: string } };
      expect(created.returnRoute, verb).toBe(own.returnRoute);
      expect(created.tags, verb).toEqual(["mission:m"]);
      current = created.qitemId;
    }
    expect(await read(mine)).toEqual([]);
    // From this machine, the same tag add and handoff keep the key: the filter is the caller's place, not the tag.
    const local = await post("/qitem-outside/tags", { add: [theirs] }, { "x-openrig-session": "cus-a1-caller@team" });
    expect((await local.json() as { added: string[] }).added).toEqual([theirs]);
  });

  it("over a real connection, the CLI's create keeps the key and the same request through the MCP adapter or a relay doesn't", async () => {
    const server = await new Promise<ServerType>((resolve) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/queue/create`;
    const send = async (qitemId: string, headers: Record<string, string> = {}) => (await (await fetch(url, { method: "POST",
      headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ qitemId, destinationSession: "operator-agent@kernel",
        body: "Goal", summary: "the goal", nudge: false, returnRoute: "auto", tags: [mine] }) })).json()) as { returnRoute: string; tags: string[] | null };
    const cli = await send("qitem-cli");
    expect(cli).toMatchObject({ returnRoute: issuedReturnAddress("qitem-cli"), tags: [mine] });
    for (const [qitemId, headers] of [["qitem-adapter", { "x-openrig-principal": JSON.stringify({ source: "file", id: "grok" }) }],
      ["qitem-relayed", { "x-openrig-relay": "host-b" }]] as const) {
      const row = await send(qitemId, headers);
      expect(row.returnRoute, qitemId).toBe(issuedReturnAddress(qitemId));
      expect(row.tags ?? [], qitemId).toEqual([]);
    }
  });

  // A daemon bound to this machine's tailnet address is reached by its own CLI at that address, not at loopback.
  const ownAddress = Object.values(networkInterfaces()).flat().find((info) => info && !info.internal && info.family === "IPv4")?.address;
  it.skipIf(!ownAddress)("counts a peer at one of this machine's own addresses as this machine", async () => {
    const row = await (await create({ qitemId: "qitem-own", returnRoute: "auto", tags: [mine] }, {}, peer(ownAddress!))).json() as { tags: string[] };
    expect(row.tags).toEqual([mine]);
    const mapped = await (await create({ qitemId: "qitem-own-v6", returnRoute: "auto", tags: [mine] }, {}, peer(`::ffff:${ownAddress}`))).json() as { returnRoute: string };
    expect(mapped.returnRoute).toBe(issuedReturnAddress("qitem-own"));
  });
});
