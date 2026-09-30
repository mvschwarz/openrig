// S10 — deterministic thread↔seat routing receipts (proof contract: wrong-seat ABSENCE pinned
// across the four enumerated classes) + map rebuildability from queue-row stamps + outbound
// thread reuse through the REAL delivery path. Zero inference anywhere: every assertion is an
// exact lookup outcome.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/db/migrate.js";
import { threadSeatMapSchema } from "../src/db/migrations/072_thread_seat_map.js";
import { ThreadSeatMap, formatPostedStamp, parsePostedStamp } from "../src/domain/gateway/slack/thread-seat-map.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import { InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { buildInProcessWire } from "../src/domain/gateway/gateway-subsystem.js";
import { OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

function mapDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, [threadSeatMapSchema]);
  return db;
}
function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p)!; },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (a, b) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-08-27T00:00:00.000Z");
const flush = () => new Promise((r) => setTimeout(r, 5));

describe("thread↔seat map — exact-lookup semantics", () => {
  it("open → resolveByThread → close: state transitions, mapping never lost", () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T1", channel: "C1", human: "human-founder@kernel", seat: "dev-driver@v-openrig-build", conversationId: "qitem-1" });
    expect(map.resolveByThread("T1")).toMatchObject({ seat: "dev-driver@v-openrig-build", state: "open" });
    map.close("T1");
    expect(map.resolveByThread("T1")).toMatchObject({ seat: "dev-driver@v-openrig-build", state: "closed" }); // closed ≠ unmapped
  });

  it("open is idempotent on thread_ts (a replayed root keeps ONE row, the first mapping)", () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T1", channel: "C1", human: "h", seat: "seat-a@r", conversationId: "q1" });
    map.open({ threadTs: "T1", channel: "C1", human: "h", seat: "seat-B@r", conversationId: "q2" }); // replay/dup
    expect(map.resolveByThread("T1")!.seat).toBe("seat-a@r"); // never silently remapped
  });

  it("resolveOpenForPair reuses only OPEN conversations of exactly that pair", () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T1", channel: "C1", human: "h1", seat: "s1", conversationId: "q1" });
    map.open({ threadTs: "T2", channel: "C1", human: "h1", seat: "s2", conversationId: "q2" });
    map.close("T1");
    expect(map.resolveOpenForPair("h1", "s1")).toBeNull(); // closed → no reuse
    expect(map.resolveOpenForPair("h1", "s2")!.threadTs).toBe("T2"); // exact pair only
    expect(map.resolveOpenForPair("h2", "s2")).toBeNull(); // wrong human never matches
  });

  it("resolveOpenForConversation never aliases two human gates sharing one human+seat pair", () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T1", channel: "C1", human: "h1", seat: "s1", conversationId: "q1" });
    map.open({ threadTs: "T2", channel: "C1", human: "h1", seat: "s1", conversationId: "q2" });
    expect(map.resolveOpenForConversation("h1", "s1", "q1")?.threadTs).toBe("T1");
    expect(map.resolveOpenForConversation("h1", "s1", "q2")?.threadTs).toBe("T2");
    expect(map.resolveOpenForConversation("h1", "s1", "q3")).toBeNull();
  });

  it("REBUILD from queue-row stamps: lost table re-derives; malformed stamps skipped loudly-countable; live rows never overwritten", () => {
    const db = mapDb();
    const map = new ThreadSeatMap(db, clock);
    const stamp1 = formatPostedStamp({ threadTs: "T1", messageTs: "T1", channel: "C1", human: "h1", seat: "s1", conversationId: "q1" });
    const stamp2 = formatPostedStamp({ threadTs: "T2", messageTs: "T2", channel: "C1", human: "h2", seat: "s2", conversationId: "q2" });
    expect(parsePostedStamp(stamp1)).toMatchObject({ threadTs: "T1", seat: "s1" });
    // Pre-existing live row for T2 with DIFFERENT seat — rebuild must not clobber it.
    map.open({ threadTs: "T2", channel: "C1", human: "h2", seat: "s2-live", conversationId: "q2live" });
    const r = map.rebuildFromStamps([stamp1, stamp2, "unrelated transition note", "slack-posted malformed"]);
    expect(r.inserted).toBe(1); // T1
    expect(r.skipped).toBe(3); // T2 (live) + 2 non-stamps
    expect(map.resolveByThread("T1")!.seat).toBe("s1");
    expect(map.resolveByThread("T2")!.seat).toBe("s2-live"); // untouched
  });

  it("newest root is Slack's latest thread_ts, not when a rebuild happened to re-insert it", () => {
    const root = (threadTs: string) => formatPostedStamp({ threadTs, messageTs: threadTs, channel: "C1", human: "h1", seat: "s1", conversationId: "q1" });
    // Named per lookup, so a failure says which one picked the wrong root.
    const newest = (map: ThreadSeatMap) => ({
      byConversation: map.resolveByConversation("q1")!.threadTs,
      openForConversation: map.resolveOpenForConversation("h1", "s1", "q1")!.threadTs,
      openForPair: map.resolveOpenForPair("h1", "s1")!.threadTs,
    });
    const allNewest = { byConversation: "1700000100.000200", openForConversation: "1700000100.000200", openForPair: "1700000100.000200" };
    // A rebuild stamps opened_at with rebuild time, so an older root read later looks newer.
    let tick = 0;
    const ticking = new ThreadSeatMap(mapDb(), () => new Date(Date.UTC(2026, 7, 27, 0, 0, tick++)));
    ticking.rebuildFromStamps([root("1700000100.000200"), root("1700000000.000100")]);
    expect(newest(ticking)).toEqual(allNewest);
    // Equal opened_at (one fast rebuild): still Slack's order, whichever row went in first.
    for (const order of [["1700000100.000200", "1700000000.000100"], ["1700000000.000100", "1700000100.000200"]]) {
      const tied = new ThreadSeatMap(mapDb(), clock);
      tied.rebuildFromStamps(order.map(root));
      expect(newest(tied)).toEqual(allNewest);
    }
  });
});

describe("inbound routing — the four classes, wrong-seat ABSENCE pinned", () => {
  function harness() {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T-OPEN", channel: "C1", human: "mike@external", seat: "dev-driver@v-openrig-build", conversationId: "q-open" });
    map.open({ threadTs: "T-CLOSED", channel: "C1", human: "mike@external", seat: "review-r1@v-openrig-build", conversationId: "q-closed" });
    map.close("T-CLOSED");
    const creates: { destination: string; tags?: string[] }[] = [];
    const fs = memFs();
    const router = new InboundRouter({
      queue: { createQitem: async (i) => { creates.push({ destination: i.destination, tags: i.tags }); return `qitem-${creates.length}`; } },
      seen: new SeenStore("/s.jsonl", fs, clock),
      deadLetter: new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock),
      destination: "orch-lead@v-openrig-build",
      resolveSender: () => ({ admitted: true, source: "mike@external" }),
      resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "orch-lead@v-openrig-build" }),
    });
    return { router, creates };
  }
  const ev = (ts: string, thread_ts?: string): SlackEvent => ({ type: "message", user: "U1", text: "reply", ts, channel: "C1", ...(thread_ts ? { thread_ts } : {}) });

  it("EXISTING thread: the reply lands on EXACTLY the mapped seat — no other", async () => {
    const { router, creates } = harness();
    await router.route(ev("1.1", "T-OPEN"));
    expect(creates).toHaveLength(1);
    expect(creates[0]!.destination).toBe("dev-driver@v-openrig-build");
    expect(creates[0]!.tags).toContain("thread");
    expect(creates[0]!.tags).toContain("reply-to:q-open");
    expect(creates[0]!.tags).not.toContain("unrouted-signal");
  });

  it("CLOSED thread: STILL exactly the mapped seat (closure is not a routing black hole)", async () => {
    const { router, creates } = harness();
    await router.route(ev("2.1", "T-CLOSED"));
    expect(creates[0]!.destination).toBe("review-r1@v-openrig-build");
  });

  it("UNMAPPED thread: the orchestrator unrouted-signal row — never dropped, never a guessed seat", async () => {
    const { router, creates } = harness();
    const r = await router.route(ev("3.1", "T-NEVER-SEEN"));
    expect(r.landed).toBe(true); // never dropped
    expect(creates[0]!.destination).toBe("orch-lead@v-openrig-build");
    expect(creates[0]!.tags).toContain("unrouted-signal");
    // wrong-seat absence: no mapped seat received it
    expect(creates[0]!.destination).not.toBe("dev-driver@v-openrig-build");
    expect(creates[0]!.destination).not.toBe("review-r1@v-openrig-build");
  });

  it("HUMAN-INITIATED (no thread_ts): unrouted-signal row, landed, never guessed", async () => {
    const { router, creates } = harness();
    const r = await router.route(ev("4.1"));
    expect(r.landed).toBe(true);
    expect(creates[0]!.destination).toBe("orch-lead@v-openrig-build");
    expect(creates[0]!.tags).toContain("unrouted-signal");
  });
});

describe("outbound threading through the REAL delivery path (one reply root per durable conversation)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "s10-thr-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function capturing(rootTs: string): { fetchImpl: FetchImpl; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    return {
      bodies,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, ts: `${rootTs}.${bodies.length}` }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
  }

  it("two qitems to the same pair get distinct roots; another episode of one qitem reuses only its own root", async () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    const fsx = memFs();
    const { fetchImpl, bodies } = capturing("1724");
    const stamps: string[] = [];
    const deliver = subsystemSlackDeliver({
      botToken: "xoxb-EXAMPLE-fake",
      channel: "C1",
      sourceLabel: "vm",
      fetchImpl,
      delivered: new SeenStore("/del.jsonl", fsx, clock),
      attempted: new SeenStore("/att.jsonl", fsx, clock),
      outboundSeen: new SeenStore("/seen.jsonl", fsx, clock),
      resolveThreadTs: (p) => map.resolveOpenForConversation(p.destinationSession ?? "", p.sourceSession ?? "", p.qitemId)?.threadTs,
      onPostedRoot: (p, ts) => {
        map.open({ threadTs: ts, channel: "C1", human: p.destinationSession ?? "", seat: p.sourceSession ?? "", conversationId: p.qitemId });
        stamps.push(formatPostedStamp({ threadTs: ts, messageTs: ts, channel: "C1", human: p.destinationSession ?? "", seat: p.sourceSession ?? "", conversationId: p.qitemId }));
      },
    });
    const wire = buildInProcessWire({ home, ops: [OUTBOUND_OP], deliver });
    const payload = (q: string) => ({ qitemId: q, summary: "s", body: "b", destinationSession: "mike@external", sourceSession: "dev-driver@v-openrig-build" });
    wire.dispatcher.dispatch(OUTBOUND_OP, "mike@external", payload("q1"));
    await flush();
    expect(bodies[0]!.thread_ts).toBeUndefined(); // class: NEW conversation — a fresh root
    expect(map.resolveByThread("1724.1")).not.toBeNull(); // mapped from the posted root's ts
    wire.dispatcher.dispatch(OUTBOUND_OP, "mike@external", payload("q2"));
    await flush();
    expect(bodies[1]!.thread_ts).toBeUndefined(); // q2 is a distinct reply-correlated gate
    expect(map.resolveByThread("1724.2")?.conversationId).toBe("q2");
    wire.dispatcher.dispatch(OUTBOUND_OP, "mike@external", { ...payload("q2"), notificationKey: "q2:episode-2" });
    await flush();
    expect(bodies[2]!.thread_ts).toBe("1724.2"); // same qitem, exact parent root
    // Both durable conversations have independent rebuild stamps.
    expect(stamps).toHaveLength(2);
    expect(parsePostedStamp(stamps[0]!)).toMatchObject({ threadTs: "1724.1", conversationId: "q1" });
    expect(parsePostedStamp(stamps[1]!)).toMatchObject({ threadTs: "1724.2", conversationId: "q2" });
  });
});
