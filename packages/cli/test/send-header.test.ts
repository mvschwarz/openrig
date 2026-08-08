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

  // A1 REFUSE-LOUD removed the CLI `<unknown sender>` fallback: `wrapSendBody` now REQUIRES a resolved
  // sender (the seat-boundary guard refuses an unattributable send before this renders), so the
  // undefined/blank input this test exercised is unreachable AND a type error. The fallback-render
  // behavior legitimately survives ONLY on the daemon twin `wrapPaneEnvelope` (the non-refusable
  // queue-nudge sender) and is tested there: packages/daemon/test/pane-envelope.test.ts.

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

  // ── GHOST-STAGE (g): sender-generation suffix on the Sent: line ──
  // MIRROR of packages/daemon/test/pane-envelope.test.ts against wrapPaneEnvelope — the
  // cross-package byte-identity contract. Update both twins in lockstep.
  const GEN = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";

  it("(g) stamps the sender's short generation (first8) as a Sent:-line suffix", () => {
    const out = wrapSendBody("a@r", "b@r", "hi", null, { stampISO: "2026-08-06T17:42:09Z", genUuid: GEN });
    expect(out).toContain("Sent: 08-06 17:42Z · gen a1b2c3d4");
  });

  it("(g) byte-exact full envelope with gen (cross-package parity anchor)", () => {
    const out = wrapSendBody("a@r", "b@r", "hi", null, { stampISO: "2026-08-06T17:42:09Z", genUuid: GEN });
    expect(out).toBe('From: a@r\nTo: b@r\nSent: 08-06 17:42Z · gen a1b2c3d4\n---\nhi\n---\n↩ Reply: rig send a@r "..."');
  });

  it("(g) pin-a: OMITS the suffix entirely when the generation is UNKNOWN (never 'gen unknown', never forged)", () => {
    const absent = wrapSendBody("a@r", "b@r", "hi", null, { stampISO: "2026-08-06T17:42:09Z" });
    const empty = wrapSendBody("a@r", "b@r", "hi", null, { stampISO: "2026-08-06T17:42:09Z", genUuid: "" });
    for (const out of [absent, empty]) {
      expect(out.split("\n").find((l) => l.startsWith("Sent:"))).toBe("Sent: 08-06 17:42Z");
      expect(out).not.toContain(" · gen ");
    }
  });

  it("(g) pin-a: no Sent line ⇒ no gen suffix (the gen rides the Sent stamp, absent without it)", () => {
    const out = wrapSendBody("a@r", "b@r", "hi", null, { genUuid: GEN });
    expect(out).not.toContain("Sent:");
    expect(out).not.toContain(" · gen ");
  });

  it("(g) pin-b: a body containing ' · gen …' cannot forge the Sent: line's generation (containment)", () => {
    const body = "totally · gen ffffffff not the real gen";
    const out = wrapSendBody("a@r", "b@r", body, null, { stampISO: "2026-08-06T17:42:09Z", genUuid: GEN });
    const [headerBlock, ...bodyRegion] = out.split("\n---\n");
    expect(headerBlock.split("\n").find((l) => l.startsWith("Sent:"))).toBe("Sent: 08-06 17:42Z · gen a1b2c3d4");
    expect(headerBlock).not.toContain("ffffffff");
    expect(bodyRegion.join("\n---\n")).toContain("· gen ffffffff");
  });

  // (g) INTERIM PIN (orch scope ruling): the queue-handoff nudge passes NO meta today, so it carries
  // no Sent:/gen line — absent=omit. FOLLOW-ON (h): the delivered-at stamp adds the Sent: line, at
  // which point the gen rides this same render for free (one HG-5 baseline change, in h).
  it("(g) interim: the meta-less handoff nudge carries no Sent:/gen line (h will stamp it)", () => {
    const nudge = wrapSendBody("orch-lead@v", "driver-3@v", "Queue handoff: qitem-9 - check your queue.", null);
    expect(nudge).not.toContain("Sent:");
    expect(nudge).not.toContain(" · gen ");
  });
});
