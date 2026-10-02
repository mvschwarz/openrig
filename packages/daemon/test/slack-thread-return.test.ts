// S10 LIVE ACCEPTANCE L2 (final shape after the founder root invariant, transitions
// 10816/10817/10818): inside one instance the queue row source is BARE member@rig, so the
// Slack thread map stores the bare seat and a founder thread reply routes straight to the
// canonical session the queue accepts. The interim self-host localizer was deleted with the
// root stamping; historical triple map rows are the operator adoption's one-time cleanup.
// Synthetic fixtures only.
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

function mapDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, [threadSeatMapSchema]);
  return db;
}

/** LIVE-MIRROR queue port: accepts only canonical bare member@rig destinations, exactly like
 *  the daemon topology validator (a triple greedy-parses to an unknown rig and is refused). */
function mirrorQueuePort() {
  const creates: { qitemId?: string; destination: string; tags?: string[] }[] = [];
  return {
    creates,
    createQitem: async (i: { qitemId?: string; destination: string; tags?: string[] }) => {
      if (i.destination.split("@").length !== 2) {
        throw new Error(`destination_session ${i.destination} references an unknown rig`);
      }
      creates.push({ qitemId: i.qitemId, destination: i.destination, tags: i.tags });
      return i.qitemId ?? `qitem-landed-${creates.length}`;
    },
  };
}

describe("L2 return path — bare map seats route straight to the queue-accepted session", () => {
  it("the founder reply on a mapped thread becomes EXACTLY ONE durable qitem to the bare local seat (never dead-lettered)", async () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    // Post-root-invariant reality: the outbound row source is bare, so the map stores bare.
    map.open({ threadTs: "T-ROOT", channel: "C1", human: "human-founder@external", seat: "orch-lead@v-openrig-build", conversationId: "q-root" });
    const port = mirrorQueuePort();
    const fs = memFs();
    const dead = new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock);
    const resolutions: Array<{ qitemId: string; actorSession: string; decision: string }> = [];
    const router = new InboundRouter({
      queue: port,
      seen: new SeenStore("/s.jsonl", fs, clock),
      deadLetter: dead,
      destination: "orch-lead@v-openrig-build",
      resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
      resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "orch-lead@v-openrig-build" }),
      resolveHumanReply: async (input) => { resolutions.push(input); return "resolved"; },
    });
    const r = await router.route({ type: "message", user: "U-FOUNDER", text: "reply received on mobile", ts: "200.2", thread_ts: "T-ROOT", channel: "C1" });
    await router.route({ type: "message", user: "U-FOUNDER", text: "reply received on mobile", ts: "200.2", thread_ts: "T-ROOT", channel: "C1" });
    expect(r.landed).toBe(true);
    expect(r.correlationQitemId).toBe("q-root");
    expect(r.replyResolution).toBe("resolved");
    expect(port.creates).toHaveLength(1);
    expect(port.creates[0]!.qitemId).toMatch(/^qitem-slack-inbound-/);
    expect(port.creates[0]!.destination).toBe("orch-lead@v-openrig-build");
    expect(port.creates[0]!.tags).toContain("thread");
    expect(port.creates[0]!.tags).toContain("reply-to:q-root");
    expect(resolutions).toEqual([{ qitemId: "q-root", actorSession: "human-founder@external", decision: "reply received on mobile" }]);
    expect(dead.readAll()).toHaveLength(0);
  });

  it("a continuation failure retries the deterministic inbound row and resolves the original gate exactly once", async () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T-ROOT", channel: "C1", human: "human-founder@external", seat: "orch-lead@v-openrig-build", conversationId: "q-root" });
    const fs = memFs();
    const dead = new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock);
    const seen = new SeenStore("/s.jsonl", fs, clock);
    const created = new Set<string>();
    let creates = 0;
    let resolves = 0;
    const router = new InboundRouter({
      queue: {
        createQitem: async (input) => {
          creates++;
          const id = input.qitemId!;
          created.add(id); // mirrors QueueRepository's idempotent same-id re-delivery
          return id;
        },
      },
      seen,
      deadLetter: dead,
      destination: "orch-lead@v-openrig-build",
      resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
      resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "orch-lead@v-openrig-build" }),
      resolveHumanReply: async () => {
        resolves++;
        if (resolves === 1) throw new Error("temporary continuation failure");
        return "resolved";
      },
    });
    const event: SlackEvent = { type: "message", user: "U-FOUNDER", text: "approved", ts: "201.2", thread_ts: "T-ROOT", channel: "C1" };
    const first = await router.route(event);
    expect(first).toMatchObject({ landed: false, disposition: "dead-lettered", reason: "resolve_failed" });
    expect(dead.readAll()).toHaveLength(1);
    expect(seen.load().has("C1:201.2")).toBe(false);

    expect(await router.retryDeadLetters()).toEqual({ retried: 1, landed: 1 });
    expect(created.size).toBe(1);
    expect(creates).toBe(2); // retry reaches the idempotent create seam; no duplicate row exists
    expect(resolves).toBe(2);
    expect(dead.readAll()).toHaveLength(0);
    expect(seen.load().has("C1:201.2")).toBe(true);
  });
});
