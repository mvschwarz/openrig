// Slice 15: the record and read the openrig plugin's hooks use, on the queue's existing fields and routes. A create with
// `--return-route auto` records the conversation's key as a tag beside the issued address; the hook reads its addresses
// back with the exact tag filter (`rig queue list --tag … --all`), through the work's handoffs; another conversation's key
// reads nothing.
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";
import { issuedReturnAddress } from "../src/domain/return-route.js";
import { conversationKeyTag } from "../src/conversation-key-surface.js";

describe("the conversation key's record and read", () => {
  let db: Database.Database;
  let app: Hono;
  let repo: QueueRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo); c.set("eventBus" as never, new EventBus(db)); await next(); });
    app.route("/api/queue", queueRoutes());
  });
  afterEach(() => { db.close(); });

  const mine = conversationKeyTag("claude:1a2b3c4d.5000:4242");
  const theirs = conversationKeyTag("claude:1a2b3c4d.6000:5151");
  const create = (body: Record<string, unknown>) => app.request("/api/queue/create", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ destinationSession: "operator-agent@kernel", body: "Goal: add word counts", summary: "the goal", nudge: false, ...body }) });
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
    const asAddress = await app.request("/api/queue/create", { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": issued },
      body: JSON.stringify({ qitemId: "qitem-goal-3", destinationSession: "dev-build@starter", body: "Fix the commit author", summary: "the fix", nudge: false,
        returnRoute: "auto", tags: [mine] }) });
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
});
