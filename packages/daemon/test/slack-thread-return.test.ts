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

describe("L2 return path — bare map seats route straight to the queue-accepted session", () => {
  it("the founder reply on a mapped thread becomes EXACTLY ONE durable qitem to the bare local seat (never dead-lettered)", async () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    // Post-root-invariant reality: the outbound row source is bare, so the map stores bare.
    map.open({ threadTs: "T-ROOT", channel: "C1", human: "human-founder@external", seat: "orch-lead@v-openrig-build", conversationId: "q-root" });
    const port = mirrorQueuePort();
    const fs = memFs();
    const dead = new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock);
    const router = new InboundRouter({
      queue: port,
      seen: new SeenStore("/s.jsonl", fs, clock),
      deadLetter: dead,
      destination: "orch-lead@v-openrig-build",
      resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
      resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "orch-lead@v-openrig-build" }),
    });
    const r = await router.route({ type: "message", user: "U-FOUNDER", text: "reply received on mobile", ts: "200.2", thread_ts: "T-ROOT", channel: "C1" });
    expect(r.landed).toBe(true);
    expect(port.creates).toHaveLength(1);
    expect(port.creates[0]!.destination).toBe("orch-lead@v-openrig-build");
    expect(port.creates[0]!.tags).toContain("thread");
    expect(dead.readAll()).toHaveLength(0);
  });
});
