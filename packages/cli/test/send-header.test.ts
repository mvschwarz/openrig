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

  // Send/broadcast header (ruling 03c35295) — MUST mirror packages/daemon/test/pane-envelope.test.ts
  // byte-for-byte (the twin parity contract). Envelope=truth, render=projection; scale=anti-storm teeth.
  it("backward-compat: with no meta, the output is exactly today's 6-line DM envelope (no Sent line)", () => {
    expect(wrapSendBody("a@r", "b@r", "hi")).toBe("From: a@r\nTo: b@r\n---\nhi\n---\n↩ Reply: rig send a@r \"...\"");
  });

  it("multi-send renders the FULL recipient list on the To line", () => {
    const out = wrapSendBody("a@r", "b@r", "hi", null, { scope: { kind: "multi", recipients: ["b@r", "c@r", "d@r"] } });
    expect(out).toContain("To: b@r, c@r, d@r");
  });

  it("rig-broadcast renders 'broadcast to <rig> (N seats)' — the anti-storm scale", () => {
    const out = wrapSendBody("a@r", "openrig-pm", "hi", null, { scope: { kind: "rig-broadcast", rig: "openrig-pm", seats: 11 } });
    expect(out).toContain("To: broadcast to openrig-pm (11 seats)");
  });

  it("topology-broadcast renders 'broadcast to topology'", () => {
    const out = wrapSendBody("a@r", "*", "hi", null, { scope: { kind: "topology" } });
    expect(out).toContain("To: broadcast to topology");
  });

  it("stamps the short MM-DD HH:MMZ timestamp from the transport ISO", () => {
    const out = wrapSendBody("a@r", "b@r", "hi", null, { stampISO: "2026-08-06T17:42:09Z" });
    expect(out).toContain("Sent: 08-06 17:42Z");
  });

  it("storm test: DM / multi / rig-bcast / topology each render distinct To lines (header-alone)", () => {
    const to = (out: string) => out.split("\n").find((l) => l.startsWith("To:"));
    const dm = to(wrapSendBody("a@r", "b@r", "x"));
    const multi = to(wrapSendBody("a@r", "b@r", "x", null, { scope: { kind: "multi", recipients: ["b@r", "c@r"] } }));
    const rig = to(wrapSendBody("a@r", "r", "x", null, { scope: { kind: "rig-broadcast", rig: "r", seats: 4 } }));
    const topo = to(wrapSendBody("a@r", "*", "x", null, { scope: { kind: "topology" } }));
    expect(new Set([dm, multi, rig, topo]).size).toBe(4);
  });
});
