import { describe, expect, it } from "vitest";
import {
  bridgeEventDedupeKey,
  isBridgeHandshake,
  OMP_BRIDGE_PROTOCOL_VERSION,
} from "../src/adapters/omp-bridge-protocol.js";

describe("OMP bridge handshake protocol version", () => {
  it("accepts the supported version for the bridge role", () => {
    expect(isBridgeHandshake({ role: "bridge", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION })).toBe(true);
  });

  it("accepts the supported version for the control role", () => {
    expect(isBridgeHandshake({ role: "control", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION })).toBe(true);
  });

  it("rejects a different numeric protocol version", () => {
    expect(isBridgeHandshake({ role: "bridge", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION + 1 })).toBe(false);
  });

  it("rejects a non-numeric protocol version", () => {
    expect(isBridgeHandshake({ role: "bridge", protocolVersion: "1" })).toBe(false);
  });

  it("rejects an unknown role", () => {
    expect(isBridgeHandshake({ role: "unknown", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION })).toBe(false);
  });
});

describe("OMP bridge event deduplication", () => {
  it("does not deduplicate tool execution updates, even with tool call identity", () => {
    expect(bridgeEventDedupeKey({
      type: "tool_execution_update",
      toolCallId: "tool-1",
    })).toBeNull();
  });

  it("does not deduplicate message updates, even with message identity", () => {
    expect(bridgeEventDedupeKey({
      type: "message_update",
      message: { id: "message-1" },
      id: "message-1",
    })).toBeNull();
  });

  it("deduplicates tool execution starts with the same tool call identity", () => {
    const first = bridgeEventDedupeKey({
      type: "tool_execution_start",
      toolCallId: "tool-1",
    });
    const repeated = bridgeEventDedupeKey({
      type: "tool_execution_start",
      toolCallId: "tool-1",
    });

    expect(first).not.toBeNull();
    expect(repeated).toBe(first);
  });

  it("deduplicates message starts with the same message identity", () => {
    const first = bridgeEventDedupeKey({ type: "message_start", id: "message-1" });
    const repeated = bridgeEventDedupeKey({ type: "message_start", id: "message-1" });

    expect(first).not.toBeNull();
    expect(repeated).toBe(first);
  });

  it("does not deduplicate lifecycle markers", () => {
    expect(bridgeEventDedupeKey({ type: "agent_start" })).toBeNull();
  });
});
