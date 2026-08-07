import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GatewayDispatcher } from "../src/domain/gateway/dispatcher.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import type { CapabilityDescriptor, OutboundDecision } from "../src/domain/gateway/protocol.js";

// M1 A4a — the gateway dispatcher core (proof-9: unadvertised-op refused; connector-outage
// -> durable buffer -> ack-gated drain, no loss). Transport is an in-memory sink here.

const CAP: CapabilityDescriptor = {
  kind: "capability", connectorId: "slack-1", platform: "slack", protocolVersion: 1, ops: ["post_message"],
};

describe("A4a GatewayDispatcher", () => {
  let home: string;
  let sent: OutboundDecision[];
  let seq: number;
  let buf: DispatchBuffer;
  let d: GatewayDispatcher;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "a4a-disp-"));
    sent = []; seq = 0;
    buf = new DispatchBuffer(home);
    d = new GatewayDispatcher({ buffer: buf, send: (dec) => sent.push(dec), newDecisionId: () => `d${++seq}` });
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("REFUSES dispatch before the handshake (no descriptor yet)", () => {
    const r = d.dispatch("post_message", "mike#slack-1", { text: "hi" });
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
    expect(buf.pending()).toHaveLength(0); // nothing durable-written on a refusal
  });

  it("proof-9: an UNADVERTISED op is REFUSED, not attempted (no send, no buffer write)", () => {
    d.onCapability(CAP);
    const r = d.dispatch("delete_workspace", "mike#slack-1", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not advertised|refused, not attempted/i);
    expect(sent).toHaveLength(0);
    expect(buf.pending()).toHaveLength(0);
  });

  it("advertised dispatch: durable-FIRST (buffer) then send", () => {
    d.onCapability(CAP);
    const r = d.dispatch("post_message", "mike#slack-1", { text: "hi" });
    expect(r.ok).toBe(true);
    expect(buf.pending().map((x) => x.decisionId)).toEqual(["d1"]); // durable
    expect(sent.map((x) => x.decisionId)).toEqual(["d1"]);          // sent
  });

  it("ack drains; un-Acked survives (connector outage = no loss) and replays on reconnect", () => {
    d.onCapability(CAP);
    d.dispatch("post_message", "a#slack-1", {}); // d1
    d.dispatch("post_message", "b#slack-1", {}); // d2
    d.onAck("d1");
    expect(buf.pending().map((x) => x.decisionId)).toEqual(["d2"]); // d2 un-Acked -> retained

    // reconnect: a FRESH dispatcher over the SAME durable buffer replays d2 (no loss)
    const sent2: OutboundDecision[] = [];
    const d2 = new GatewayDispatcher({ buffer: new DispatchBuffer(home), send: (x) => sent2.push(x) });
    d2.replayPending();
    expect(sent2.map((x) => x.decisionId)).toEqual(["d2"]); // byte-identical re-send of the un-Acked decision
  });
});
