import { describe, it, expect } from "vitest";
import {
  decodeGatewayMessage,
  encodeGatewayMessage,
  isAdvertisedOp,
  GATEWAY_PROTOCOL_VERSION,
  type CapabilityDescriptor,
} from "../src/domain/gateway/protocol.js";

// M1 A4a — the gateway<->connector framed-JSON CLOSED union. proof-9 foundation:
// unknown kind = LOUD refuse; an unadvertised op is refused-not-attempted.

const CAP: CapabilityDescriptor = {
  kind: "capability", connectorId: "slack-1", platform: "slack",
  protocolVersion: GATEWAY_PROTOCOL_VERSION, ops: ["post_message", "upload_file"],
};

describe("A4a gateway wire protocol (closed union)", () => {
  it("decodes a CapabilityDescriptor", () => {
    const r = decodeGatewayMessage(JSON.stringify(CAP));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.kind === "capability") expect(r.message.ops).toEqual(["post_message", "upload_file"]);
  });

  it("decodes an OutboundDecision (round-trips through encode)", () => {
    const dec = { kind: "outbound_decision", decisionId: "d1", op: "post_message", entityBindingRef: "mike#slack-1", payload: { text: "hi" } };
    const r = decodeGatewayMessage(encodeGatewayMessage(dec as never));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.kind === "outbound_decision") expect(r.message.decisionId).toBe("d1");
  });

  it("decodes both Ack shapes (ok + failed)", () => {
    expect(decodeGatewayMessage(JSON.stringify({ kind: "ack", decisionId: "d1", ok: true })).ok).toBe(true);
    const f = decodeGatewayMessage(JSON.stringify({ kind: "ack", decisionId: "d1", ok: false, failed: { class: "rate_limited", detail: "429" } }));
    expect(f.ok).toBe(true);
    if (f.ok && f.message.kind === "ack" && f.message.ok === false) expect(f.message.failed.class).toBe("rate_limited");
  });

  it("REFUSES an unknown message kind (proof-9: closed union)", () => {
    const r = decodeGatewayMessage(JSON.stringify({ kind: "exec_shell", decisionId: "x" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown gateway message kind.*refused/i);
  });

  it("REFUSES a partial/malformed message (no silent partials)", () => {
    expect(decodeGatewayMessage(JSON.stringify({ kind: "outbound_decision", decisionId: "d1" })).ok).toBe(false); // no op
    expect(decodeGatewayMessage(JSON.stringify({ kind: "ack", decisionId: "d1", ok: false })).ok).toBe(false);    // failed missing
    expect(decodeGatewayMessage("not json{").ok).toBe(false);
    expect(decodeGatewayMessage(JSON.stringify({ kind: "capability", connectorId: "c", platform: "p", protocolVersion: 1, ops: "nope" })).ok).toBe(false);
  });

  it("isAdvertisedOp: advertised true, unadvertised false (proof-9 dispatch guard)", () => {
    expect(isAdvertisedOp(CAP, "post_message")).toBe(true);
    expect(isAdvertisedOp(CAP, "delete_workspace")).toBe(false); // unadvertised -> refuse, never attempt
  });
});
