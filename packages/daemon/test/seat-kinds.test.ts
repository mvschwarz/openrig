// The seat boundary's resolver: today's two kinds, and a stored value that's neither read as unknown, never as tmux.
import { describe, it, expect } from "vitest";
import { resolveSeatKind, seatInboundTransport, seatProcessOwner } from "../src/domain/seat-kinds.js";

describe("resolveSeatKind", () => {
  it.each([
    [null, { kind: "tmux" }],
    [undefined, { kind: "tmux" }],
    ["tmux", { kind: "tmux" }],
    ["external_cli", { kind: "external_cli" }],
    ["herdr", { kind: "unknown", stored: "herdr" }],
    ["", { kind: "unknown", stored: "" }],
    ["TMUX", { kind: "unknown", stored: "TMUX" }],
  ] as const)("reads %j as %j", (stored, expected) => {
    expect(resolveSeatKind(stored)).toEqual(expected);
  });

  it("gives an external CLI seat no inbound transport, and every other kind today's tmux path", () => {
    expect(seatInboundTransport({ kind: "external_cli" })).toBe("none");
    expect(seatInboundTransport({ kind: "tmux" })).toBe("tmux");
    // An unknown stored kind keeps the path it takes today; the resolver still names it unknown.
    expect(seatInboundTransport({ kind: "unknown", stored: "herdr" })).toBe("tmux");
  });

  it("leaves an external CLI seat's process to its own program, and every other kind to OpenRig's lifecycle as today", () => {
    expect(seatProcessOwner({ kind: "external_cli" })).toBe("external");
    expect(seatProcessOwner({ kind: "tmux" })).toBe("openrig");
    // As for the transport: an unknown stored kind keeps today's path, and the resolver still names it unknown.
    expect(seatProcessOwner({ kind: "unknown", stored: "herdr" })).toBe("openrig");
  });
});
