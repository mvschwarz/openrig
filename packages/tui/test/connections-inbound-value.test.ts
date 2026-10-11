// The Connections page's inbound line: a connected socket always says how delivery stands.
import { describe, it, expect } from "vitest";
import { inboundValue, type ConnectionsRead } from "../src/connections/connections-model.js";

const running = (inboundState: string, inboundDelivery?: string | null, inboundEventsMissingSince?: string | null): ConnectionsRead["running"] => ({
  state: "active", activatedAt: null, outboundReady: true, inboundReady: true, inboundState, applied: "matching", inboundDelivery, inboundEventsMissingSince,
});

describe("inboundValue", () => {
  it("never shows a bare 'connected' when the daemon reports delivery", () => {
    expect(inboundValue(running("connected", "delivering"))).toBe("connected; delivering");
    expect(inboundValue(running("connected", "unknown"))).toBe("connected; delivery not yet confirmed");
    expect(inboundValue(running("connected", "events-missing", "T1"))).toBe("connected; events missing since T1");
    expect(inboundValue(running("connected", "no-server-pings"))).toBe("connected; no server pings");
  });

  it("keeps the bare state for a daemon that reports no delivery, and for a socket that is not connected", () => {
    expect(inboundValue(running("connected"))).toBe("connected");
    expect(inboundValue(running("disconnected", "unknown"))).toBe("disconnected");
  });
});
