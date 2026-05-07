import { describe, it, expect } from "vitest";
import { wrapSendBody } from "../src/commands/send.js";

describe("wrapSendBody — pre-release CLI/daemon Item 2 (email-style envelope)", () => {
  it("renders From / To / body / reply hint with both session names", () => {
    const out = wrapSendBody("driver-3@my-rig", "guard-3@my-rig", "Status: ready.");
    expect(out).toContain("From: driver-3@my-rig");
    expect(out).toContain("To: guard-3@my-rig");
    expect(out).toContain("Status: ready.");
    expect(out).toContain('↩ Reply: rig send driver-3@my-rig "..."');
  });

  it("preserves the original body verbatim between the dash separators", () => {
    const body = "Multi-line\nbody with\nthree lines.";
    const out = wrapSendBody("a@r", "b@r", body);
    const segments = out.split("\n---\n");
    expect(segments).toHaveLength(3);
    expect(segments[1]).toBe(body);
  });

  it("wraps cleanly when the body is empty", () => {
    const out = wrapSendBody("a@r", "b@r", "");
    expect(out).toContain("From: a@r");
    expect(out).toContain("To: b@r");
    expect(out).toContain("---\n\n---");
    expect(out).toContain('↩ Reply: rig send a@r "..."');
  });

  it("falls back to a marker when the sender is undefined or empty", () => {
    const undef = wrapSendBody(undefined, "b@r", "hi");
    expect(undef).toContain("From: <unknown sender>");
    expect(undef).toContain('↩ Reply: rig send <unknown sender> "..."');
    const blank = wrapSendBody("   ", "b@r", "hi");
    expect(blank).toContain("From: <unknown sender>");
  });

  it("uses the literal recipient string in the To header so cross-rig addresses survive", () => {
    const out = wrapSendBody("from@a", "to@b", "x");
    expect(out).toMatch(/^From: from@a\nTo: to@b\n---\n/);
  });
});
