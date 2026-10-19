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
import { threadPartMapSchema } from "../src/db/migrations/097_thread_part_map.js";
import { threadSeatMapChannelKeySchema } from "../src/db/migrations/115_thread_seat_map_channel_key.js";
import { ThreadSeatMap, formatPostedStamp, parsePostedStamp } from "../src/domain/gateway/slack/thread-seat-map.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import { InboundRouter, type SlackEvent, type SlackBlockActions } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { buildInProcessWire } from "../src/domain/gateway/gateway-subsystem.js";
import { OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

function mapDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, [threadSeatMapSchema, threadPartMapSchema, threadSeatMapChannelKeySchema]);
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

  it("roots are per channel: one thread_ts in two channels is two roots, and a person's minted root says so", () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T9", channel: "C1", human: "human-founder@kernel", seat: "a@r", conversationId: "qitem-a" });
    map.open({ threadTs: "T9", channel: "C2", human: "human-founder@kernel", seat: "b@r", conversationId: "qitem-b", origin: "person" });
    expect(map.resolveByThread("T9", "C1")).toMatchObject({ seat: "a@r", conversationId: "qitem-a", origin: "posted" });
    expect(map.resolveByThread("T9", "C2")).toMatchObject({ seat: "b@r", conversationId: "qitem-b", origin: "person" });
    expect(map.resolveByThread("T9", "C3")).toBeNull();
  });

  it("a person's root rebuilds from its stamp as theirs; a stamp without an origin is OpenRig's", () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    const base = { messageTs: "T7", channel: "C1", human: "human-founder@kernel", seat: "a@r" };
    const person = `${formatPostedStamp({ ...base, threadTs: "T7", conversationId: "qitem-p" })} origin=person`;
    const posted = formatPostedStamp({ ...base, threadTs: "T8", messageTs: "T8", conversationId: "qitem-o" });
    expect(parsePostedStamp(person)).toMatchObject({ origin: "person" });
    expect(map.rebuildFromStamps([person, posted])).toEqual({ inserted: 2, skipped: 0 });
    expect(map.resolveByThread("T7", "C1")).toMatchObject({ conversationId: "qitem-p", origin: "person" });
    expect(map.resolveByThread("T8", "C1")).toMatchObject({ conversationId: "qitem-o", origin: "posted" });
  });

  it("the channel-key migration keeps every existing root, as one OpenRig posted", () => {
    const db = new Database(":memory:");
    migrate(db, [threadSeatMapSchema, threadPartMapSchema]);
    db.prepare(`INSERT INTO thread_seat_map (thread_ts, channel, human, seat, conversation_id, state, opened_at, closed_at)
      VALUES ('T1', 'C1', 'human-founder@kernel', 'a@r', 'qitem-1', 'closed', '2026-08-27T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`).run();
    migrate(db, [threadSeatMapSchema, threadPartMapSchema, threadSeatMapChannelKeySchema]);
    expect(new ThreadSeatMap(db, clock).resolveByThread("T1", "C1")).toMatchObject({
      seat: "a@r", conversationId: "qitem-1", state: "closed", closedAt: "2026-08-28T00:00:00.000Z", origin: "posted",
    });
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

  it("maps a message posted into a thread to its own ask by channel, and rebuilds it from its stamp (#899)", () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T1", channel: "C1", human: "h1", seat: "s1", conversationId: "q1" });
    const reply = { messageTs: "P2", channel: "C1", threadTs: "T1", seat: "s2", conversationId: "q2" };
    map.recordPart(reply);
    map.recordPart(reply); // a replayed receipt keeps one row
    expect(map.partOf("P2", "C1")).toEqual({ threadTs: "T1", seat: "s2", conversationId: "q2" });
    expect(map.partOf("P2", "C-OTHER")).toBeNull(); // a timestamp is unique only within a channel
    expect(map.resolveByThread("P2")).toBeNull(); // a reply never becomes a thread root
    expect(map.resolveByConversation("q1")!.threadTs).toBe("T1");
    // A lost table rebuilds replies from their stamps, which name the reply, the thread, its seat and its ask.
    const rebuilt = new ThreadSeatMap(mapDb(), clock);
    const stamp = (messageTs: string, seat = "s1", conversationId = "q1") =>
      formatPostedStamp({ threadTs: "T1", messageTs, channel: "C1", human: "h1", seat, conversationId });
    expect(rebuilt.rebuildFromStamps([stamp("T1"), stamp("P2", "s2", "q2"), stamp("P3"), stamp("P2", "s2", "q2")])).toEqual({ inserted: 3, skipped: 1 });
    expect(rebuilt.partOf("P2", "C1")).toEqual({ threadTs: "T1", seat: "s2", conversationId: "q2" });
    expect(rebuilt.resolveByThread("T1")!.seat).toBe("s1");
  });

  it("routes a reaction on a message posted into a thread to its own ask's seat, and ignores any other (#899)", () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T1", channel: "C1", human: "h1", seat: "s1", conversationId: "q1" });
    map.recordPart({ messageTs: "P2", channel: "C1", threadTs: "T1", seat: "s1", conversationId: "q1" }); // q1's own reply part
    map.recordPart({ messageTs: "P3", channel: "C1", threadTs: "T1", seat: "s2", conversationId: "q2" }); // q2, posted into q1's thread
    const route = makeThreadRouteResolver({ map, unroutedDestination: "orch@rig" });
    expect(route({ type: "reaction_added", thread_ts: "P2", channel: "C1" } as never)).toMatchObject({ destination: "s1", correlationQitemId: "q1" });
    // Not the thread owner's: the ask the message was posted for.
    expect(route({ type: "reaction_added", thread_ts: "P3", channel: "C1" } as never)).toMatchObject({ destination: "s2", correlationQitemId: "q2" });
    // A person's reply in the thread was not posted by OpenRig; the same ts in another channel is another message.
    expect(route({ type: "reaction_added", thread_ts: "R9", channel: "C1" } as never).routeClass).toBe("unmapped-thread");
    expect(route({ type: "reaction_added", thread_ts: "P2", channel: "C-OTHER" } as never).routeClass).toBe("unmapped-thread");
    // A typed reply keeps routing by its thread root only.
    expect(route({ type: "message", thread_ts: "P2", channel: "C1" } as never).routeClass).toBe("unmapped-thread");
    // A root elsewhere with the same ts doesn't hide this channel's reply.
    map.open({ threadTs: "P2", channel: "C-OTHER", human: "h1", seat: "s9", conversationId: "q9" });
    expect(route({ type: "reaction_added", thread_ts: "P2", channel: "C1" } as never)).toMatchObject({ destination: "s1", correlationQitemId: "q1" });
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

describe("#192 channel map — one resolved channel per post (post, reconcile scan, upload)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "s192-del-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("posts, reconciles an ambiguous earlier attempt and uploads in the payload's channel, never the default", async () => {
    const fsx = memFs();
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      const method = new URL(url).pathname.split("/").pop() ?? "";
      const raw = String(init?.body ?? "");
      const body: Record<string, unknown> = raw.startsWith("{") ? JSON.parse(raw) as Record<string, unknown>
        : { ...Object.fromEntries(new URL(url).searchParams), ...Object.fromEntries(new URLSearchParams(raw)) };
      calls.push({ method, body });
      const json = method === "conversations.history" ? { ok: true, messages: [], has_more: false }
        : method === "files.getUploadURLExternal" ? { ok: true, upload_url: "https://files.slack.com/upload/v1/x", file_id: "F1" }
        : { ok: true, ts: "1800.1" };
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    };
    const attempted = new SeenStore("/att.jsonl", fsx, clock);
    attempted.mark("d-1", "attempted"); // an earlier attempt with an unknown outcome
    const roots: string[] = [];
    const deliver = subsystemSlackDeliver({
      botToken: "xoxb-EXAMPLE-fake", channel: "C0DEFAULT", sourceLabel: "vm", fetchImpl,
      resolveChannel: (p) => (p.sourceSession === "pr@my-rig" ? "C0EXAMPLE2" : "C0DEFAULT"),
      delivered: new SeenStore("/del.jsonl", fsx, clock), attempted, outboundSeen: new SeenStore("/seen.jsonl", fsx, clock),
      readLocalImage: () => ({ bytes: new Uint8Array([1, 2, 3]), filename: "shot.png" }),
      onPostedRoot: (_p, ts, channel) => { roots.push(`${channel}:${ts}`); },
    });
    const outcome = await deliver({ decisionId: "d-1", op: OUTBOUND_OP, entityBindingRef: "mike@external",
      payload: { qitemId: "q1", summary: "s", body: "b", destinationSession: "mike@external", sourceSession: "pr@my-rig", evidenceRef: "/tmp/shot.png" } } as never);
    expect(outcome).toEqual({ ok: true });
    const channelOf = (method: string) => calls.filter((c) => c.method === method).map((c) => c.body.channel ?? c.body.channel_id);
    expect(channelOf("conversations.history")).toEqual(["C0EXAMPLE2"]);
    expect(channelOf("chat.postMessage")).toEqual(["C0EXAMPLE2"]);
    expect(channelOf("files.completeUploadExternal")).toEqual(["C0EXAMPLE2"]);
    expect(roots).toEqual(["C0EXAMPLE2:1800.1"]);
  });
});

describe("a click finds its decision by channel and ts", () => {
  it("a click naming its channel only in its container reaches that channel's decision, live and on a retained retry", async () => {
    let tick = 0;
    const map = new ThreadSeatMap(mapDb(), () => new Date(Date.UTC(2026, 7, 27, 0, 0, tick++)));
    map.open({ threadTs: "800.1", channel: "C0A", human: "human-founder@kernel", seat: "a@r", conversationId: "qitem-a" });
    map.open({ threadTs: "800.1", channel: "C0B", human: "human-founder@kernel", seat: "b@r", conversationId: "qitem-b" }); // opened later
    const answered: string[] = [];
    let failContinuation = true;
    const fs = memFs();
    const actionDeadLetter = new DeadLetterStore<SlackBlockActions>("/a.jsonl", fs, clock);
    const router = new InboundRouter({
      queue: { createQitem: async (input: { qitemId: string }) => { if (failContinuation) throw new Error("database is locked"); return input.qitemId; } },
      seen: new SeenStore("/s.jsonl", fs, clock),
      deadLetter: new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock),
      actionDeadLetter,
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "human-founder@kernel" }),
      resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "operator-agent@kernel" }),
      recordHumanAnswer: (input: { qitemId: string }) => {
        answered.push(input.qitemId);
        return { status: "recorded", complete: true, answers: { ship: "yes" }, questions: [{ id: "ship", question: "Ship?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }] };
      },
      resolveHumanReply: async () => "resolved",
    } as never);
    // Slack can name the channel only in the container; the click is on C0A's root.
    const click: SlackBlockActions = {
      type: "block_actions", user: { id: "UFOUNDER" },
      container: { message_ts: "800.1", channel_id: "C0A" },
      actions: [{ block_id: "or-q:ship", action_id: "or-opt:yes", action_ts: "801.5" }],
    };
    expect(await router.routeAction(click)).toMatchObject({ status: "handler-failed" }); // its hand-back fails: kept for retry
    expect(actionDeadLetter.readAll()).toHaveLength(1);
    failContinuation = false;
    await router.retryDeadLetters();
    expect(answered).toEqual(["qitem-a", "qitem-a"]);
    expect(actionDeadLetter.readAll()).toEqual([]);
  });
});
