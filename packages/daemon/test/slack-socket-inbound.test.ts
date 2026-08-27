// S10 port: the slice-11 transport receipts, re-homed onto the daemon's socket-inbound
// service (runInboundLoop moved verbatim from the retired CLI runner; the queue seam is the
// in-process port). The receipts themselves are unchanged — B1 periodic drain included.
import { describe, it, expect } from "vitest";
import { startSocketInbound, type WsLike, type SocketInboundDeps } from "../src/domain/gateway/slack/socket-inbound.js";
import { InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p)!;
    },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (from, to) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-07-30T00:00:00.000Z");
const flush = () => new Promise((r) => setTimeout(r, 5));

// A controllable fake Socket Mode WebSocket.
function makeFakeWs() {
  const sent: string[] = [];
  const ws: WsLike = { send: (d) => sent.push(d), close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
  return { ws, sent };
}
// fetchImpl that answers apps.connections.open with a ws url.
const openFetch: FetchImpl = async () =>
  new Response(JSON.stringify({ ok: true, url: "wss://fake-slack/ws" }), { status: 200, headers: { "content-type": "application/json" } });

const envelope = (event: SlackEvent, id = `e-${event.ts}`) => JSON.stringify({ envelope_id: id, type: "events_api", payload: { event } });

describe("Slice-11 INBOUND transport — real runInboundLoop / open / message / ack / periodic retry (B1 + proof gap)", () => {
  it("acks every envelope, lands human messages, and retries dead-letters ON CONNECT and PERIODICALLY while connected", async () => {
    const fsx = memFs();
    const seen = new SeenStore("/s/seen.jsonl", fsx, clock);
    const dead = new DeadLetterStore<SlackEvent>("/s/dead.jsonl", fsx, clock);
    const queue = { createQitem: async () => "qitem-xyz" };
    const router = new InboundRouter({ queue, seen, deadLetter: dead, destination: "operator-agent@kernel", resolveSender: (u) => ({ admitted: true, source: `human-${u}@kernel` }), log: () => {} });

    // pre-seed a dead-letter that will land on the ON-CONNECT retry
    dead.append({ type: "message", user: "U0", text: "queued during outage", ts: "D1", channel: "C0" }, 1);

    const fake = makeFakeWs();
    let resolveWsCreated: () => void;
    const wsCreated = new Promise<void>((r) => (resolveWsCreated = r));
    const deps: SocketInboundDeps = {
      fetchImpl: openFetch,
      wsFactory: () => {
        resolveWsCreated();
        return fake.ws;
      },
      inboundMaxConnects: 1, // stop after this connection closes
      retryIntervalMs: 20, // short so the periodic retry fires in-test
      log: () => {},
    };

    const handle = startSocketInbound("xapp-EXAMPLE-fake", router, deps);
    await wsCreated;

    // open → on-connect dead-letter drain (D1 lands) + periodic interval starts
    fake.ws.onopen!();
    await flush();
    expect(seen.load().has("D1")).toBe(true); // recovered on connect
    expect(dead.readAll()).toHaveLength(0);

    // a human message: fast-ACK + land
    fake.ws.onmessage!({ data: envelope({ type: "message", user: "U1", text: "hi team", ts: "M1", channel: "C0" }) });
    await flush();
    expect(fake.sent.some((s) => s.includes('"envelope_id":"e-M1"'))).toBe(true); // fast-ack sent
    expect(seen.load().has("M1")).toBe(true); // landed via real ack path

    // a bot message: still ACKed, NOT ingested (loop-safety)
    fake.ws.onmessage!({ data: envelope({ type: "message", bot_id: "B1", text: "loop", ts: "B1TS" }, "e-bot") });
    await flush();
    expect(fake.sent.some((s) => s.includes('"envelope_id":"e-bot"'))).toBe(true);
    expect(seen.load().has("B1TS")).toBe(false);

    // B1: a NEW dead-letter appears WHILE connected → the PERIODIC timer drains it
    // (no Slack reconnect). This is the exact gap QA flagged.
    dead.append({ type: "message", user: "U2", text: "outage recovered", ts: "D2", channel: "C0" }, 1);
    await new Promise((r) => setTimeout(r, 70)); // ~3 intervals of 20ms
    expect(seen.load().has("D2")).toBe(true); // retried while the socket stayed open
    expect(dead.readAll()).toHaveLength(0);

    // close → loop resolves (inboundMaxConnects reached)
    fake.ws.onclose!();
    await handle.done;
  });
});
