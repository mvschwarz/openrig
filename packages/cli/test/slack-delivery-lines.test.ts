// `rig slack status` names inbound delivery beside the socket state, so "connected" is never the only word.
import { describe, it, expect } from "vitest";
import { socketDeliveryLines } from "../src/commands/slack.js";

describe("socketDeliveryLines", () => {
  it("says the last post came back only when no later post is outstanding", () => {
    expect(socketDeliveryLines({ delivery: "delivering", unechoedPosts: 0 })).toEqual(["Delivery: delivering (our last post came back as an event)"]);
    expect(socketDeliveryLines({ delivery: "delivering", unechoedPosts: 1 })).toEqual(["Delivery: delivering, but 1 later post(s) of ours have not come back yet"]);
  });

  it("names missing events, silent pings, a disabled app and an unconfirmed connection", () => {
    expect(socketDeliveryLines({ delivery: "events-missing", eventsMissingSince: "T1", unechoedPosts: 2 })[0]).toBe("Delivery: events missing since T1 (2 of our posts not echoed)");
    expect(socketDeliveryLines({ delivery: "no-server-pings", lastServerPingAt: "T2" })[0]).toBe("Delivery: no server pings since T2; last server ping T2");
    expect(socketDeliveryLines({ delivery: "socket-mode-disabled" })[0]).toContain("Socket Mode is disabled");
    expect(socketDeliveryLines({ delivery: "unknown" })[0]).toContain("not yet confirmed");
  });

  it("says when an automatic reconnect is held back, and until when", () => {
    expect(socketDeliveryLines({ autoReconnectSuppressedUntil: "T3" })).toEqual(["Automatic reconnect held back until T3 (at most one every 5 minutes)."]);
  });

  it("reports another consumer only for connections that are not ours", () => {
    expect(socketDeliveryLines({ numConnections: 2, otherConnections: 0 })).toEqual([]);
    expect(socketDeliveryLines({ numConnections: 3, otherConnections: 1 })).toEqual(["Slack reports 3 open connections for this app, 1 not ours: another consumer may be taking events."]);
  });

  it("says the extra connection may be one of ours just after we closed one", () => {
    expect(socketDeliveryLines({ numConnections: 2, otherConnections: 1, otherConnectionsMayBeOurs: true })).toEqual([
      "Slack reports 2 open connections for this app, 1 more than we have open: possibly one we closed moments before Slack counted (Slack may not have dropped it yet), or another consumer taking events.",
    ]);
  });
});
