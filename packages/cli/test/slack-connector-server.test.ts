import { describe, it, expect, afterEach } from "vitest";
import { createConnection, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startConnectorServer, type ConnectorServer } from "../src/slack/connector-server.js";
import { slackDeliverFn } from "../src/slack/slack-delivery.js";
import { SeenStore } from "../src/slack/state-store.js";
import type { FetchImpl } from "../src/slack/slack-api.js";

// M1 A5 — the Slack connector as a socket SERVER, driven end-to-end through its REAL loop by a raw
// gateway-like client; only fetch is faked (at the shipped postWebhook HTTP boundary). Proves:
//   proof-1  ack-AFTER-delivery via an INDUCED failure: a 500 -> ok:false ack + NOT recorded (the
//            gateway would replay); a subsequent 200 -> ok:true ack + recorded delivered.
//   dedup    a replay of an already-delivered decisionId is RE-ACKED without a second post.
//   hygiene  the SHIPPED redaction path runs (a secret in the body never reaches the wire).

interface RawClient {
  sock: Socket;
  nextFrame(): Promise<Record<string, unknown>>;
  send(msg: unknown): void;
  close(): void;
}
function rawClient(socketPath: string): RawClient {
  const sock = createConnection(socketPath);
  sock.setEncoding("utf8");
  const frames: Record<string, unknown>[] = [];
  const waiters: ((f: Record<string, unknown>) => void)[] = [];
  let acc = "";
  sock.on("error", () => { /* server teardown races */ });
  sock.on("data", (c: string) => {
    acc += c;
    let nl: number;
    while ((nl = acc.indexOf("\n")) >= 0) {
      const f = acc.slice(0, nl); acc = acc.slice(nl + 1);
      if (!f) continue;
      const obj = JSON.parse(f) as Record<string, unknown>;
      const w = waiters.shift();
      if (w) w(obj); else frames.push(obj);
    }
  });
  return {
    sock,
    nextFrame: () => new Promise((res) => { const f = frames.shift(); if (f) res(f); else waiters.push(res); }),
    send: (msg) => sock.write(JSON.stringify(msg) + "\n"),
    close: () => sock.destroy(),
  };
}

describe("A5 Slack connector server (real loop, faked fetch)", () => {
  let home: string;
  let server: ConnectorServer | undefined;
  let client: RawClient | undefined;
  afterEach(async () => {
    client?.close(); client = undefined;
    if (server) { await server.close(); server = undefined; }
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("greets with its CapabilityDescriptor; proof-1 ack-after-delivery (induced failure -> replay -> success); dedup; hygiene", async () => {
    home = mkdtempSync(join(tmpdir(), "a5-conn-"));
    const sockPath = join(home, "c.sock");
    expect(sockPath.length).toBeLessThan(104); // sun_path guard
    const delivered = new SeenStore(join(home, "delivered.jsonl"));

    // Fake fetch at the HTTP boundary of the SHIPPED postWebhook path.
    let httpStatus = 500; // induced failure first
    let postCount = 0;
    let lastBody = "";
    const fakeFetch: FetchImpl = async (_url, init) => {
      postCount += 1;
      lastBody = String(init?.body ?? "");
      return new Response(httpStatus === 200 ? "ok" : "boom", { status: httpStatus });
    };

    server = await startConnectorServer({
      socketPath: sockPath,
      connectorId: "slack-1",
      platform: "slack",
      ops: ["post_message"],
      delivered,
      deliver: slackDeliverFn({ webhookUrl: "https://hooks.slack.com/services/T/B/x", sourceLabel: "host/rig", fetchImpl: fakeFetch }),
    });

    client = rawClient(sockPath);
    const desc = await client.nextFrame();
    expect(desc.kind).toBe("capability");
    expect(desc.ops).toEqual(["post_message"]);
    expect(desc.connectorId).toBe("slack-1");

    const decision = {
      kind: "outbound_decision", decisionId: "d1", op: "post_message", entityBindingRef: "mike#slack-1",
      payload: { qitemId: "q1", summary: "needs review", body: "here is a token xoxb-XXXX-secret to leak" },
    };

    // 1. induced failure: connector delivers on the shipped path -> 500 -> ok:false, NOT recorded.
    client.send(decision);
    const a1 = await client.nextFrame();
    expect(a1.kind).toBe("ack");
    expect(a1.ok).toBe(false);
    expect((a1.failed as { class: string }).class).toBe("http-500");
    expect(delivered.load().has("d1")).toBe(false); // gateway would retain + replay
    expect(postCount).toBe(1);
    // hygiene: the SHIPPED redaction ran even on the attempt — the secret never hit the wire.
    expect(lastBody).not.toContain("xoxb-XXXX-secret");
    expect(lastBody).toContain("[redacted-secret]");

    // 2. connector recovers (200): replay d1 -> ack ok:true AFTER delivery, recorded delivered.
    httpStatus = 200;
    client.send(decision);
    const a2 = await client.nextFrame();
    expect(a2.ok).toBe(true);
    expect(delivered.load().has("d1")).toBe(true);
    expect(postCount).toBe(2);

    // 3. dup replay of a delivered decisionId: RE-ACKED, NO second post (idempotent).
    client.send(decision);
    const a3 = await client.nextFrame();
    expect(a3.ok).toBe(true);
    expect(postCount).toBe(2); // no re-post
  });
});
