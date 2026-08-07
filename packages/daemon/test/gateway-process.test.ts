import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGatewayProcess, type GatewayProcessHandle } from "../src/domain/gateway/gateway-process.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { encodeGatewayMessage, decodeGatewayMessage, type CapabilityDescriptor, type OutboundDecision } from "../src/domain/gateway/protocol.js";

// M1 A4a — the process BRAIN in-process (fast, fine-grained). This does NOT prove liveness
// (a spawned process's silent-exit is masked by vitest's own event loop — that is proven by
// gateway-spawn-e2e.test.ts). Here we prove the brain composes buffer+transport correctly:
// on a re-dial it REPLAYS the un-Acked decision through the process layer (no-loss recovery).

const CAP: CapabilityDescriptor = {
  kind: "capability", connectorId: "slack-1", platform: "slack", protocolVersion: 1, ops: ["post_message"],
};

interface Stub { server: Server; received: OutboundDecision[]; sockets: Socket[]; }
function startStub(path: string, ackAll: boolean): Promise<Stub> {
  const received: OutboundDecision[] = []; const sockets: Socket[] = [];
  try { if (existsSync(path)) unlinkSync(path); } catch { /* fresh */ }
  const server = createServer((sock) => {
    sockets.push(sock); sock.setEncoding("utf8"); sock.on("error", () => {});
    sock.write(encodeGatewayMessage(CAP));
    let acc = "";
    sock.on("data", (chunk: string) => {
      acc += chunk; let nl: number;
      while ((nl = acc.indexOf("\n")) >= 0) {
        const f = acc.slice(0, nl); acc = acc.slice(nl + 1); if (!f) continue;
        const d = decodeGatewayMessage(f);
        if (d.ok && d.message.kind === "outbound_decision") {
          received.push(d.message);
          if (ackAll) sock.write(encodeGatewayMessage({ kind: "ack", decisionId: d.message.decisionId, ok: true }));
        }
      }
    });
  });
  return new Promise((resolve, reject) => { server.on("error", reject); server.listen(path, () => resolve({ server, received, sockets })); });
}
const closeStub = (s: Stub): Promise<void> => new Promise((res) => { for (const sk of s.sockets) { try { sk.destroy(); } catch {} } s.server.close(() => res()); });
function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => { if (pred()) { clearInterval(iv); resolve(); } else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error("waitFor timeout")); } }, 15);
  });
}

describe("A4a runGatewayProcess (in-process brain)", () => {
  let home: string;
  let handle: GatewayProcessHandle | undefined;
  afterEach(() => { handle?.stop(); handle = undefined; if (home) rmSync(home, { recursive: true, force: true }); });

  it("connects, exposes a live dispatcher, and stop() tears down", async () => {
    home = mkdtempSync(join(tmpdir(), "a4a-proc-"));
    const sockPath = join(home, "g.sock");
    const stub = await startStub(sockPath, true);
    handle = runGatewayProcess({ socketPath: sockPath, home, reconnectMs: 100 });
    await waitFor(() => handle!.connected() && handle!.connection()?.dispatcher.connectorId === "slack-1");
    expect(handle.connected()).toBe(true);
    handle.stop();
    expect(handle.connected()).toBe(false);
    await closeStub(stub);
  });

  it("re-dials after an outage and REPLAYS the un-Acked decision (no-loss through the brain)", async () => {
    home = mkdtempSync(join(tmpdir(), "a4a-proc-"));
    const sockPath = join(home, "g.sock");

    // round 1: connector never acks; dispatch d1 -> retained durably.
    const stub1 = await startStub(sockPath, false);
    handle = runGatewayProcess({ socketPath: sockPath, home, reconnectMs: 100 });
    await waitFor(() => handle!.connection()?.dispatcher.connectorId === "slack-1");
    const r = handle.connection()!.dispatcher.dispatch("post_message", "mike#slack-1", { text: "hi" });
    expect(r.ok).toBe(true);
    await waitFor(() => stub1.received.length === 1);
    expect(new DispatchBuffer(home).pending().map((x) => x.decisionId)).toEqual([r.ok ? r.decisionId : ""]);
    await closeStub(stub1); // OUTAGE

    // round 2: a new connector (acks) comes up on the same path; the brain re-dials and the
    // transport replays the un-Acked d1 on handshake -> connector re-receives -> acks -> drain.
    const stub2 = await startStub(sockPath, true);
    await waitFor(() => stub2.received.length >= 1); // replayed after re-dial
    await waitFor(() => new DispatchBuffer(home).pending().length === 0); // acked + drained: no loss
    await closeStub(stub2);
  });
});
