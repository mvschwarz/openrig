import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MOVE_REPORT_TAG } from "../src/domain/provider/subscription-move-report.js";
import { providerRoutes } from "../src/routes/provider.js";
import { moveReport } from "./helpers/move-report-fixture.js";

// Slice 18 — filing a move report makes one queue item to whoever asked, tagged subscription-move, as the sender; the
// read gives the Fleet app and the agent the reports back, with follow-ups chained and anything unreadable named.

const AGENT = "fleet-agent@fleet";
const ASKER = "operator-agent@kernel";
const PERSON = "human-owner@kernel";

describe("subscription move report routes", () => {
  let db: Database.Database;
  let queue: QueueRepository;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    queue = new QueueRepository(db, new EventBus(db));
    app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, queue); await next(); });
    app.route("/api/provider", providerRoutes());
  });
  afterEach(() => db.close());

  const file = (body: unknown, session: string | null = AGENT) => app.request("/api/provider/moves", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(session ? { "X-OpenRig-Session": session } : {}) },
    body: JSON.stringify(body),
  });
  const reports = () => queue.list({ tag: MOVE_REPORT_TAG, limit: 100 });
  // The list is newest first by creation time, to the millisecond. Two creates in one millisecond tie and come back in
  // either order, so a case that reads an order waits for the next millisecond between them.
  const nextMillisecond = async () => { const now = Date.now(); while (Date.now() === now) await new Promise((r) => setTimeout(r, 1)); };
  const list = async (query = "") => {
    const res = await app.request(`/api/provider/moves${query}`);
    return { status: res.status, data: await res.json() as Record<string, any> };
  };

  it("files a report as one queue item to whoever asked, from the sender, and it switches nothing", async () => {
    const res = await file({ to: ASKER, report: moveReport() });
    expect(res.status).toBe(201);
    const { qitemId } = await res.json() as { qitemId: string };
    const [item] = reports();
    expect(item).toMatchObject({ qitemId, sourceSession: AGENT, destinationSession: ASKER, state: "pending", tags: [MOVE_REPORT_TAG] });
    expect(item!.summary).toBe("Subscription move codex-1 → codex-2 on build-box: 1 moved, 1 unconfirmed, 1 peer");
    expect(item!.body).toContain("```openrig-subscription-move");
  });

  it("to a person's seat, follows the queue's rule for human-routed items: it names its evidence", async () => {
    const refused = await file({ to: PERSON, report: moveReport() });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "human_route_fields_required", message: expect.stringContaining("the move itself is unchanged") });
    expect(reports()).toEqual([]);
    const filed = await file({ to: PERSON, report: moveReport(), evidenceRef: "moves/2026-10-23-build-box-verify.json" });
    expect(filed.status).toBe(201);
    expect(reports()[0]).toMatchObject({ destinationSession: PERSON, evidenceRef: "moves/2026-10-23-build-box-verify.json" });
  });

  it("refuses a report that fails its checks, records nothing, and says the move itself is unchanged", async () => {
    const res = await file({ to: ASKER, report: moveReport({ seats: [{ seat: "dev-impl@team", result: "moved" }] }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "move_report_invalid",
      errors: [expect.stringContaining("report it unconfirmed")],
      message: expect.stringContaining("don't repeat the switch or restart"),
    });
    expect((await file({ report: moveReport() })).status).toBe(400);
    expect((await file({ to: ASKER, report: moveReport() }, null)).status).toBeGreaterThanOrEqual(400);
    expect(reports()).toEqual([]);
  });

  it("refuses a credential anywhere the queue would keep or repeat it, and never repeats it back", async () => {
    const token = `Bearer ${"t".repeat(30)}`, keyToken = `ghp_${"k".repeat(36)}`;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ to: ASKER, report: moveReport(), evidenceRef: `https://evidence.example/move?auth=${token}` }, "evidenceRef holds what looks like a bearer token"],
      [{ to: `${token}@kernel`, report: moveReport() }, "to holds what looks like a bearer token"],
      [{ to: ASKER, report: moveReport({ [keyToken]: "ordinary" }) }, "report has a key that looks like a GitHub token"],
    ];
    for (const [body, error] of cases) {
      const res = await file(body);
      const text = await res.text();
      expect(res.status).toBe(400);
      expect(JSON.parse(text)).toMatchObject({ error: "move_report_invalid", errors: [expect.stringContaining(error)], message: expect.stringContaining("the move itself is unchanged") });
      expect(text).not.toContain("t".repeat(30));
      expect(text).not.toContain("k".repeat(36));
    }
    expect(reports()).toEqual([]);
  });

  it("reads reports newest first, chains follow-ups, filters by seat or peer, and names unreadable items", async () => {
    const first = (await (await file({ to: ASKER, report: moveReport() })).json() as { qitemId: string }).qitemId;
    const followUp = moveReport({
      follows: first, readings: [{ subject: "codex-2", basis: "observed", observedAt: "2026-10-23T13:00:00.000Z", summary: "weekly 3% used" }],
      seats: [{ seat: "dev-qa@team", result: "moved", accountEvidence: { state: "matched" }, toolTurn: { state: "observed" } }], peers: [],
    });
    await nextMillisecond();
    const second = (await (await file({ to: ASKER, report: followUp })).json() as { qitemId: string }).qitemId;
    // A tagged item someone wrote by hand, holding a token: listed as unreadable, by where and what, never the value.
    const token = `Bearer ${"z".repeat(30)}`;
    const handMade = await queue.create({
      sourceSession: AGENT, destinationSession: ASKER, tags: [MOVE_REPORT_TAG], nudge: false,
      body: `\`\`\`openrig-subscription-move\n${JSON.stringify(moveReport({ reason: token }))}\n\`\`\``,
    });
    // And one whose report has a token-shaped key: named by where it is, not by the key.
    const keyToken = `ghp_${"k".repeat(36)}`;
    await nextMillisecond();
    const keyed = await queue.create({
      sourceSession: AGENT, destinationSession: ASKER, tags: [MOVE_REPORT_TAG], nudge: false,
      body: `\`\`\`openrig-subscription-move\n${JSON.stringify(moveReport({ peers: [{ seat: "x", note: "y", [keyToken]: "z" }] }))}\n\`\`\``,
    });

    const all = await list();
    expect(all.status).toBe(200);
    expect(all.data.moves.map((move: { qitemId: string }) => move.qitemId)).toEqual([second, first]);
    expect(all.data.moves[1]).toMatchObject({ reportedBy: AGENT, reportedTo: ASKER, state: "pending", followedBy: [second] });
    expect(all.data.moves[0].report.follows).toBe(first);
    expect(all.data.unreadable).toEqual([
      { qitemId: keyed.qitemId, reason: expect.stringContaining("report.peers[0] has a key that looks like a GitHub token") },
      { qitemId: handMade.qitemId, reason: expect.stringContaining("report.reason holds what looks like a bearer token") },
    ]);
    expect(JSON.stringify(all.data)).not.toContain("z".repeat(30));
    expect(JSON.stringify(all.data)).not.toContain("k".repeat(36));
    expect(all.data.truncated).toBe(false);

    expect((await list("?seat=dev-lead%40team")).data.moves.map((move: { qitemId: string }) => move.qitemId)).toEqual([first]);
    expect((await list("?seat=dev-qa%40team")).data.moves).toHaveLength(2);
    expect((await list("?limit=1")).data).toMatchObject({ truncated: true });
    expect((await list("?limit=0")).status).toBe(400);
  });

  it("answers 503 when the queue isn't wired", async () => {
    const bare = new Hono();
    bare.route("/api/provider", providerRoutes());
    expect((await bare.request("/api/provider/moves")).status).toBe(503);
  });
});
