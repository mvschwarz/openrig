// #2234: Slack can accept a reply to a deleted thread root as a new top-level message (ok, a new ts, no message.thread_ts).
// OpenRig records where Slack actually put the message, so a person's reply to it reaches the seat that posted it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { ThreadSeatMap } from "../src/domain/gateway/slack/thread-seat-map.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";

const channel = "C-EXAMPLE";
const seat = "author@example";
const human = "human@external";
const root = "1900000000.000001";
const posted = "1900000100.000001";

describe("recording where Slack actually placed a reply (#2234)", () => {
  let db: Database.Database;
  let map: ThreadSeatMap;
  let placed: Array<{ messageTs: string; threadTs?: string }>;
  let missing: Array<{ threadTs: string; channel: string }>;
  beforeEach(() => {
    db = createFullTestDb();
    map = new ThreadSeatMap(db);
    // An OPEN mapping remains for a root that was deleted in Slack.
    map.open({ threadTs: root, channel, seat, human, conversationId: "q-root" });
    placed = [];
    missing = [];
  });
  afterEach(() => { db.close(); });

  const store = () => {
    const values = new Set<string>();
    return { load: () => values, mark: (id: string) => { values.add(id); } };
  };
  const deliverWith = (response: Record<string, unknown>) => subsystemSlackDeliver({
    botToken: "xoxb-EXAMPLE-fake", channel, sourceLabel: "example",
    delivered: store(), attempted: store(), outboundSeen: store(),
    resolveThreadTs: () => root,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, channel, ts: posted, ...response }),
      { status: 200, headers: { "content-type": "application/json" } }),
    onPostedRoot: (p, ts, ch) => map.open({ threadTs: ts, channel: ch, human, seat, conversationId: p.qitemId! }),
    onPostedPart: (p, ts, threadTs, ch) => map.recordPart({ messageTs: ts, channel: ch, threadTs, seat, conversationId: p.qitemId! }),
    onPosted: (_p, messageTs, threadTs) => { placed.push({ messageTs, ...(threadTs ? { threadTs } : {}) }); },
    onThreadMissing: (_p, threadTs, ch) => { missing.push({ threadTs, channel: ch }); map.close(threadTs, ch); },
  });
  const update = { decisionId: "d-update", op: "post_message" as const, entityBindingRef: human,
    payload: { qitemId: "q-update", sourceSession: seat, destinationSession: human, humanIntent: "update", summary: "Update", body: "Synthetic update." } };
  const route = () => makeThreadRouteResolver({ map, unroutedDestination: "operator@example" });

  it("a reply Slack posted as a new top-level message becomes that conversation's root, and a person's reply to it reaches the seat", async () => {
    const result = await deliverWith({ message: { ts: posted, text: "Synthetic update" } })(update as never);
    expect(result.ok).toBe(true);
    expect(map.resolveByThread(posted, channel)).toMatchObject({ seat, conversationId: "q-update", state: "open" });
    expect(map.partOf(posted, channel)).toBeNull();
    expect(placed).toEqual([{ messageTs: posted }]);
    // The deleted root's mapping is closed, so later posts don't reuse it.
    expect(missing).toEqual([{ threadTs: root, channel }]);
    expect(map.resolveByThread(root, channel)?.state).toBe("closed");
    expect(route()({ type: "message", channel, thread_ts: posted } as never)).toMatchObject({ destination: seat, routeClass: "existing-thread" });
  });

  it("a reply Slack threaded where it was asked to is a part of that thread, as before", async () => {
    expect((await deliverWith({ message: { ts: posted, thread_ts: root, text: "Synthetic update" } })(update as never)).ok).toBe(true);
    expect(map.partOf(posted, channel)).toMatchObject({ threadTs: root, conversationId: "q-update" });
    expect(map.resolveByThread(posted, channel)).toBeNull();
    expect(placed).toEqual([{ messageTs: posted, threadTs: root }]);
    expect(missing).toEqual([]);
  });

  it("a later part of a long message, promoted because the first part's root was deleted, becomes an open root a person's reply reaches", async () => {
    const paragraph = (n: number) => `Paragraph ${n}: the plan touches the service and needs a yes. `.repeat(12);
    const long = { ...update, decisionId: "d-long", payload: { ...update.payload, qitemId: "q-long",
      body: `${Array.from({ length: 12 }, (_, i) => paragraph(i + 1)).join("\n\n")}\nAction: approve or hold.` } };
    let calls = 0;
    const deliver = subsystemSlackDeliver({
      botToken: "xoxb-EXAMPLE-fake", channel, sourceLabel: "example",
      delivered: store(), attempted: store(), outboundSeen: store(),
      // The first part opens a new root; the root is deleted before the second part, which Slack posts top-level.
      fetchImpl: async () => {
        const ts = `1900000200.00000${++calls}`;
        return new Response(JSON.stringify({ ok: true, channel, ts, message: { ts, text: "part" } }), { status: 200, headers: { "content-type": "application/json" } });
      },
      onPostedRoot: (p, ts, ch) => map.open({ threadTs: ts, channel: ch, human, seat, conversationId: p.qitemId! }),
      onPostedPart: (p, ts, threadTs, ch) => map.recordPart({ messageTs: ts, channel: ch, threadTs, seat, conversationId: p.qitemId! }),
      onThreadMissing: (_p, threadTs, ch) => { missing.push({ threadTs, channel: ch }); map.close(threadTs, ch); },
    });
    expect((await deliver(long as never)).ok).toBe(true);
    expect(calls).toBeGreaterThan(1);
    const first = "1900000200.000001";
    const second = "1900000200.000002";
    expect(missing[0]).toEqual({ threadTs: first, channel });
    expect(map.resolveByThread(second, channel)).toMatchObject({ seat, conversationId: "q-long", state: "open" });
    expect(route()({ type: "message", channel, thread_ts: second } as never)).toMatchObject({ destination: seat, routeClass: "existing-thread" });
  });

  it("an answer without the posted message keeps the requested placement, as before", async () => {
    expect((await deliverWith({})(update as never)).ok).toBe(true);
    expect(map.partOf(posted, channel)).toMatchObject({ threadTs: root });
    expect(placed).toEqual([{ messageTs: posted, threadTs: root }]);
    expect(missing).toEqual([]);
  });
});
