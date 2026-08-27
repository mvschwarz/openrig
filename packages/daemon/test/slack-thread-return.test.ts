// S10 LIVE ACCEPTANCE L2 — the thread-reply RETURN PATH (fix row r055-slack-l2-thread-return-fix).
// Live RED, 2026-08-27: the outbound root's queue row carried the 51-09 self-host-stamped
// SOURCE triple (member@rig@host-…); onPostedRoot stored that triple as the mapped seat; the
// founder's thread reply resolved to it; the local queue REJECTED the triple destination
// (unknown_destination_rig — the greedy first-@ parse reads rig as "rig@host-…"), so the reply
// dead-lettered and never became durable work. Synthetic fixtures only — no live ids, tokens,
// or message bodies.
//
// The fix, ONCE at the route-address seam: a mapped seat whose host suffix IS this daemon's own
// selfHostId resolves to the canonical bare local session the queue accepts. A GENUINELY remote
// suffix is never blindly stripped: it routes honestly as an unrouted signal (never dropped,
// never guessed) until remote routing semantics exist.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { threadSeatMapSchema } from "../src/db/migrations/072_thread_seat_map.js";
import { ThreadSeatMap } from "../src/domain/gateway/slack/thread-seat-map.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import { InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";

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
const clock = () => new Date("2026-08-27T05:00:00.000Z");
const SELF_HOST = "host-84c37990";

function mapDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, [threadSeatMapSchema]);
  return db;
}

/** LIVE-MIRROR queue port: accepts only canonical bare `member@rig` destinations — a triple
 *  fails exactly like the daemon's topology validator (greedy first-@ rig lookup misses). */
function mirrorQueuePort() {
  const creates: { destination: string; tags?: string[] }[] = [];
  return {
    creates,
    createQitem: async (i: { destination: string; tags?: string[] }) => {
      if (i.destination.split("@").length !== 2) {
        throw new Error(`destination_session ${i.destination} references an unknown rig`);
      }
      creates.push({ destination: i.destination, tags: i.tags });
      return `qitem-landed-${creates.length}`;
    },
  };
}

function harness(mappedSeat: string) {
  const map = new ThreadSeatMap(mapDb(), clock);
  // The outbound root, stored exactly as the live path stored it (the row's stamped source).
  map.open({ threadTs: "T-ROOT", channel: "C1", human: "human-founder@external", seat: mappedSeat, conversationId: "q-root" });
  const port = mirrorQueuePort();
  const fs = memFs();
  const dead = new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock);
  const router = new InboundRouter({
    queue: port,
    seen: new SeenStore("/s.jsonl", fs, clock),
    deadLetter: dead,
    destination: "orch-lead@v-openrig-build", // the configured orchestrator slot (bare, canonical)
    resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
    resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "orch-lead@v-openrig-build", selfHostId: SELF_HOST }),
  });
  const reply: SlackEvent = { type: "message", user: "U-FOUNDER", text: "reply received on mobile", ts: "200.2", thread_ts: "T-ROOT", channel: "C1" };
  return { router, port, dead, reply };
}

describe("L2 return path — a mapped LOCAL seat resolves to the canonical session the queue accepts", () => {
  it("THE LIVE SHAPE: seat stored as the self-host-stamped triple → the reply becomes EXACTLY ONE durable qitem to the canonical bare seat (not dead-lettered, not dropped)", async () => {
    const { router, port, dead, reply } = harness(`orch-lead@v-openrig-build@${SELF_HOST}`);
    const r = await router.route(reply);
    expect(r.landed, "the founder's reply must become durable work").toBe(true);
    expect(port.creates).toHaveLength(1);
    expect(port.creates[0]!.destination).toBe("orch-lead@v-openrig-build"); // canonical, queue-accepted
    expect(port.creates[0]!.tags).toContain("thread"); // still the mapped-thread class, not unrouted
    expect(dead.readAll()).toHaveLength(0); // never dead-lettered
  });

  it("a bare 2-part mapped seat passes through unchanged (regression guard)", async () => {
    const { router, port, reply } = harness("dev-driver@v-openrig-build");
    const r = await router.route(reply);
    expect(r.landed).toBe(true);
    expect(port.creates[0]!.destination).toBe("dev-driver@v-openrig-build");
  });

  it("a GENUINELY REMOTE mapped seat (foreign host suffix) is NOT blindly stripped: honest unrouted-signal to the orchestrator slot, never dropped, never guessed", async () => {
    const { router, port, dead, reply } = harness("pm-lead@other-rig@host-ffffffff");
    const r = await router.route(reply);
    expect(r.landed, "never dropped").toBe(true);
    expect(port.creates).toHaveLength(1);
    expect(port.creates[0]!.destination).toBe("orch-lead@v-openrig-build"); // the orchestrator slot
    expect(port.creates[0]!.tags).toContain("unrouted-signal"); // honest: routing semantics refused, not faked
    expect(port.creates[0]!.destination).not.toContain("host-ffffffff"); // the remote triple never reaches the queue
    expect(dead.readAll()).toHaveLength(0);
  });

  it("selfHostId UNKNOWN (null): a triple is never guessed local — honest unrouted-signal", async () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T-ROOT", channel: "C1", human: "h", seat: `orch-lead@v-openrig-build@${SELF_HOST}`, conversationId: "q" });
    const port = mirrorQueuePort();
    const fs = memFs();
    const router = new InboundRouter({
      queue: port,
      seen: new SeenStore("/s2.jsonl", fs, clock),
      deadLetter: new DeadLetterStore<SlackEvent>("/d2.jsonl", fs, clock),
      destination: "orch-lead@v-openrig-build",
      resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
      resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "orch-lead@v-openrig-build", selfHostId: null }),
    });
    const r = await router.route({ type: "message", user: "U1", text: "x", ts: "300.1", thread_ts: "T-ROOT", channel: "C1" });
    expect(r.landed).toBe(true);
    expect(port.creates[0]!.destination).toBe("orch-lead@v-openrig-build");
    expect(port.creates[0]!.tags).toContain("unrouted-signal");
  });
});
