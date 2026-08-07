import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { connectGateway } from "../src/domain/gateway/transport.js";
import {
  encodeGatewayMessage,
  decodeGatewayMessage,
  type CapabilityDescriptor,
  type OutboundDecision,
} from "../src/domain/gateway/protocol.js";

// M1 A4a — proof-9 over a REAL unix socket (not an in-memory sink): the gateway out-dials a
// stub connector, exchanges newline-framed JSON, and we prove:
//   1. an UNADVERTISED op is refused, never written to the wire (proof-9 refuse-not-attempt).
//   2. an advertised dispatch reaches the connector; its ack drains the durable buffer.
//   3. connector outage -> durable buffer retains -> reconnect REPLAYS the un-Acked decision
//      (byte-identical) -> ack -> drain: no loss.
//
// sun_path ~104-byte cap: the socket lives in a SHORT mkdtemp under os.tmpdir, never a deep
// scratchpad path.

const CAP: CapabilityDescriptor = {
  kind: "capability", connectorId: "slack-1", platform: "slack", protocolVersion: 1, ops: ["post_message"],
};

interface Stub { server: Server; received: OutboundDecision[]; sockets: Socket[]; }

/** A minimal connector: on connect it sends the CapabilityDescriptor, records inbound
 *  outbound_decisions, and (optionally) acks each one. Unlinks a stale socket file first so a
 *  reconnect to the SAME path (the realistic case) does not EADDRINUSE. */
function startStub(path: string, opts: { ackAll: boolean; sendCap?: boolean; failClass?: string }): Promise<Stub> {
  const received: OutboundDecision[] = [];
  const sockets: Socket[] = [];
  try { if (existsSync(path)) unlinkSync(path); } catch { /* fresh */ }
  const server = createServer((sock) => {
    sockets.push(sock);
    sock.setEncoding("utf8");
    sock.on("error", () => { /* client teardown races — ignore */ });
    if (opts.sendCap !== false) sock.write(encodeGatewayMessage(CAP));
    let acc = "";
    sock.on("data", (chunk: string) => {
      acc += chunk as string;
      let nl: number;
      while ((nl = acc.indexOf("\n")) >= 0) {
        const frame = acc.slice(0, nl); acc = acc.slice(nl + 1);
        if (frame.length === 0) continue;
        const d = decodeGatewayMessage(frame);
        if (d.ok && d.message.kind === "outbound_decision") {
          received.push(d.message);
          const id = d.message.decisionId;
          if (opts.failClass !== undefined) {
            sock.write(encodeGatewayMessage({ kind: "ack", decisionId: id, ok: false, failed: { class: opts.failClass } }));
          } else if (opts.ackAll) {
            sock.write(encodeGatewayMessage({ kind: "ack", decisionId: id, ok: true }));
          }
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(path, () => resolve({ server, received, sockets }));
  });
}

// server.close() only fires its callback once every live connection has ended, so destroy the
// server-side sockets first (otherwise a still-open client wedges the close forever).
const closeStub = (s: Stub): Promise<void> => new Promise((res) => {
  for (const sk of s.sockets) { try { sk.destroy(); } catch { /* best-effort */ } }
  s.server.close(() => res());
});
function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error("waitFor timeout")); }
    }, 10);
  });
}

describe("A4a gateway transport e2e (real unix socket)", () => {
  let home: string;
  let sockPath: string;
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanup.splice(0)) { try { c(); } catch { /* best-effort */ } }
    if (home) rmSync(home, { recursive: true, force: true });
  });
  const setup = () => {
    home = mkdtempSync(join(tmpdir(), "a4a-e2e-"));
    sockPath = join(home, "g.sock"); // short: <tmpdir>/a4a-e2eXXXXXX/g.sock
    expect(sockPath.length).toBeLessThan(104); // sun_path guard
  };

  it("proof-9 over the wire: an UNADVERTISED op is refused, never written to the connector", async () => {
    setup();
    const stub = await startStub(sockPath, { ackAll: true });
    const buf = new DispatchBuffer(home);
    const conn = connectGateway({ socketPath: sockPath, buffer: buf });
    cleanup.push(() => conn.close());
    await waitFor(() => conn.dispatcher.connectorId === "slack-1"); // handshake landed

    const r = conn.dispatcher.dispatch("delete_workspace", "mike#slack-1", {});
    expect(r.ok).toBe(false);
    await new Promise((res) => setTimeout(res, 60)); // let any (erroneous) wire write land
    expect(stub.received).toHaveLength(0); // never attempted on the wire
    expect(buf.pending()).toHaveLength(0); // nothing durable-written on a refusal
    conn.close();
    await closeStub(stub);
  });

  it("advertised dispatch round-trips: reaches the connector, ack drains the durable buffer", async () => {
    setup();
    const stub = await startStub(sockPath, { ackAll: true });
    const buf = new DispatchBuffer(home);
    const conn = connectGateway({ socketPath: sockPath, buffer: buf, newDecisionId: () => "d1" });
    cleanup.push(() => conn.close());
    await waitFor(() => conn.dispatcher.connectorId === "slack-1");

    const r = conn.dispatcher.dispatch("post_message", "mike#slack-1", { text: "hi" });
    expect(r.ok).toBe(true);
    await waitFor(() => stub.received.length === 1);
    expect(stub.received[0].decisionId).toBe("d1");
    expect(stub.received[0].op).toBe("post_message");
    await waitFor(() => buf.pending().length === 0); // ack drained it
    conn.close();
    await closeStub(stub);
  });

  it("connector outage -> durable buffer -> reconnect REPLAYS the un-Acked decision (no loss)", async () => {
    setup();
    // round 1: connector receives but the ack path is DOWN (never acks).
    const stub1 = await startStub(sockPath, { ackAll: false });
    const buf = new DispatchBuffer(home);
    const conn1 = connectGateway({ socketPath: sockPath, buffer: buf, newDecisionId: () => "d1" });
    await waitFor(() => conn1.dispatcher.connectorId === "slack-1");
    conn1.dispatcher.dispatch("post_message", "mike#slack-1", { text: "hi" });
    await waitFor(() => stub1.received.length === 1);
    expect(buf.pending().map((x) => x.decisionId)).toEqual(["d1"]); // un-Acked -> retained
    conn1.close();
    await closeStub(stub1);

    // round 2: reconnect a FRESH gateway over the SAME durable buffer + path to a stub that acks.
    // On the handshake the transport replays pending -> connector re-receives d1 (byte-identical)
    // -> acks -> drain. No loss across the outage.
    const stub2 = await startStub(sockPath, { ackAll: true });
    const conn2 = connectGateway({ socketPath: sockPath, buffer: new DispatchBuffer(home) });
    cleanup.push(() => conn2.close());
    await waitFor(() => stub2.received.some((x) => x.decisionId === "d1")); // replayed on reconnect
    await waitFor(() => buf.pending().length === 0); // acked + drained
    conn2.close();
    await closeStub(stub2);
  });

  it("a FAILED delivery (ok:false ack) does NOT drain the row — it is retained + replayed (no loss)", async () => {
    setup();
    // round 1: the connector RECEIVES the decision but its delivery FAILS — it acks ok:false and
    // does NOT record it (its contract: the gateway retains + replays). The gateway MUST NOT drain
    // the buffer on an ok:false ack (draining here = a silently DROPPED notification: invariant-2).
    let failErr = "";
    const stub1 = await startStub(sockPath, { ackAll: true, failClass: "http-500" });
    const buf = new DispatchBuffer(home);
    const conn1 = connectGateway({
      socketPath: sockPath, buffer: buf, newDecisionId: () => "d1",
      onError: (e) => { failErr = e.message; },
    });
    cleanup.push(() => conn1.close());
    await waitFor(() => conn1.dispatcher.connectorId === "slack-1");
    conn1.dispatcher.dispatch("post_message", "mike#slack-1", { text: "hi" });
    await waitFor(() => stub1.received.length === 1);
    // the ok:false ack has been processed; the row MUST survive (this REDs against an
    // unconditional onAck that drains on any ack).
    await new Promise((res) => setTimeout(res, 80));
    expect(buf.pending().map((x) => x.decisionId)).toEqual(["d1"]); // retained, NOT dropped
    expect(failErr).toMatch(/http-500|delivery fail/i);            // surfaced for observability
    conn1.close();
    await closeStub(stub1);

    // round 2: the connector recovers (acks ok:true). Reconnect replays the retained d1 -> delivered
    // -> drained. End-to-end: a failed delivery is never lost.
    const stub2 = await startStub(sockPath, { ackAll: true });
    const conn2 = connectGateway({ socketPath: sockPath, buffer: new DispatchBuffer(home) });
    cleanup.push(() => conn2.close());
    await waitFor(() => stub2.received.some((x) => x.decisionId === "d1")); // replayed after the failure
    await waitFor(() => buf.pending().length === 0); // finally delivered + drained
    conn2.close();
    await closeStub(stub2);
  });
});
