// #899 — a thread reply sent with "Also send to #channel" ticked arrives as
// `message` with subtype `thread_broadcast`, still carrying its thread_ts. It
// used to be ignored with reason=subtype, so the asking seat never saw the
// answer. It is a thread reply and must route like one.
import { describe, it, expect } from "vitest";
import { InboundRouter, ingestDecision, handleEnvelope, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";

function memFs() {
  const files = new Map<string, string>();
  return {
    readFileSync: (p: string) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    existsSync: (p: string) => files.has(p),
    writeFileSync: (p: string, d: string) => { files.set(p, d); },
    appendFileSync: (p: string, d: string) => { files.set(p, (files.get(p) ?? "") + d); },
    rename: (a: string, b: string) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-10-06T01:00:00Z");

interface Landed { source: string; destination: string; body: string }

function harness(mapped: Record<string, string>) {
  const fs = memFs();
  const rows: Landed[] = [];
  const logs: string[] = [];
  const threadMap = {
    resolveByThread: (threadTs: string) => (mapped[threadTs] ? { seat: mapped[threadTs]!, state: "open" } : null),
    resolveByConversation: () => null,
  } as never;
  const router = new InboundRouter({
    queue: { createQitem: async (input: Landed) => { rows.push(input); return `qitem-${rows.length}`; } },
    seen: new SeenStore("/s.jsonl", fs, clock),
    deadLetter: new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock),
    destination: "operator-agent@kernel",
    resolveSender: () => ({ admitted: true, source: "founder@humans" }),
    resolveRoute: makeThreadRouteResolver({
      map: threadMap,
      unroutedDestination: "orch-lead@v-openrig-build",
      log: (m: string) => logs.push(m),
    }),
    log: (m: string) => logs.push(m),
  } as never);
  return { router, rows, logs };
}

async function deliver(h: ReturnType<typeof harness>, ev: SlackEvent) {
  const logs: string[] = [];
  const result = await handleEnvelope({ envelope_id: "env-1", type: "events_api", payload: { event: ev } }, () => {}, h.router, (m) => logs.push(m));
  return { result, logs };
}

const broadcast = (over?: Partial<SlackEvent>): SlackEvent => ({
  type: "message",
  subtype: "thread_broadcast",
  user: "U1",
  text: "Yes!",
  ts: "500.1",
  thread_ts: "400.0",
  channel: "C1",
  ...over,
});

describe("#899 thread_broadcast replies", () => {
  it("are admitted", () => {
    expect(ingestDecision(broadcast())).toEqual({ ingest: true });
  });

  it("route to the seat that owns the thread, the same as a plain reply", async () => {
    const h = harness({ "400.0": "asker@rig" });
    const { result, logs } = await deliver(h, broadcast());
    expect(result.status).toBe("accepted");
    expect(logs.some((m) => m.includes("ignored non-ingestible"))).toBe(false);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]!.destination).toBe("asker@rig");
    expect(h.rows[0]!.body).toContain("Yes!");

    const plain = harness({ "400.0": "asker@rig" });
    await deliver(plain, broadcast({ subtype: undefined }));
    expect(plain.rows.map((r) => r.destination)).toEqual(h.rows.map((r) => r.destination));
  });

  it("from a bot are still ignored", () => {
    expect(ingestDecision(broadcast({ bot_id: "B1" }))).toEqual({ ingest: false, reason: "bot_id" });
  });

  it("without a thread_ts, or as the root itself, are still ignored as a subtype", () => {
    expect(ingestDecision(broadcast({ thread_ts: undefined }))).toEqual({ ingest: false, reason: "subtype" });
    expect(ingestDecision(broadcast({ thread_ts: "500.1" }))).toEqual({ ingest: false, reason: "subtype" });
  });

  it("leave other subtypes rejected", () => {
    expect(ingestDecision(broadcast({ subtype: "message_changed" }))).toEqual({ ingest: false, reason: "subtype" });
  });
});
