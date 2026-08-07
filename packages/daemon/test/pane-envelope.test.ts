// V0.3.1 slice 23 founder-walk-queue-handoff-envelope.
//
// Daemon-side parity test for wrapPaneEnvelope. The contract:
// byte-identical output with CLI's wrapSendBody for the same inputs.
// The two functions live in separate packages because cli + daemon
// don't cross-import today; this test mirrors the assertions in
// packages/cli/test/send-header.test.ts so if either implementation
// drifts, this test (or its CLI counterpart) fails.
//
// HG-2 from IMPL-PRD §5: "Envelope format byte-identical to rig send
// envelope".

import { describe, it, expect } from "vitest";
import { wrapPaneEnvelope } from "../src/lib/pane-envelope.js";

describe("wrapPaneEnvelope — slice 23 envelope renderer (daemon-side)", () => {
  it("renders From / To / body / reply hint with both session names", () => {
    const out = wrapPaneEnvelope("driver-3@my-rig", "guard-3@my-rig", "Status: ready.");
    expect(out).toContain("From: driver-3@my-rig");
    expect(out).toContain("To: guard-3@my-rig");
    expect(out).toContain("Status: ready.");
    expect(out).toContain('↩ Reply: rig send driver-3@my-rig "..."');
  });

  it("preserves the original body verbatim between the dash separators", () => {
    const body = "Multi-line\nbody with\nthree lines.";
    const out = wrapPaneEnvelope("a@r", "b@r", body);
    const segments = out.split("\n---\n");
    expect(segments).toHaveLength(3);
    expect(segments[1]).toBe(body);
  });

  it("wraps cleanly when the body is empty", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "");
    expect(out).toContain("From: a@r");
    expect(out).toContain("To: b@r");
    expect(out).toContain("---\n\n---");
    expect(out).toContain('↩ Reply: rig send a@r "..."');
  });

  it("falls back to a marker when the sender is undefined or empty", () => {
    const undef = wrapPaneEnvelope(undefined, "b@r", "hi");
    expect(undef).toContain("From: <unknown sender>");
    expect(undef).toContain('↩ Reply: rig send <unknown sender> "..."');
    const blank = wrapPaneEnvelope("   ", "b@r", "hi");
    expect(blank).toContain("From: <unknown sender>");
  });

  it("uses the literal recipient string in the To header so cross-rig addresses survive", () => {
    const out = wrapPaneEnvelope("from@a", "to@b", "x");
    expect(out).toMatch(/^From: from@a\nTo: to@b\n---\n/);
  });

  // V0.3.1 slice 23 — the queue-handoff nudge body MUST remain a
  // grep-able substring (banked compat note in IMPL-PRD §2 BC). This
  // test asserts the canonical bare-line is preserved inside the
  // envelope so parsers that match on it via substring still work.
  it("wraps the canonical 'Queue handoff: qitem-X - check your queue.' bare-body without altering it", () => {
    const bare = "Queue handoff: qitem-20260511200000-abc123 - check your queue.";
    const out = wrapPaneEnvelope("orch-lead@v", "driver-3@v", bare);
    expect(out).toContain(bare);
    // The bare line must appear EXACTLY once, anchored inside the
    // envelope (between the `---` separators), so substring grep on
    // the recipient pane still finds it.
    const matches = out.split(bare).length - 1;
    expect(matches).toBe(1);
  });

  // ── Send/broadcast header (ruling 03c35295) — recipient-visibility projection + timestamp ──
  // Envelope = truth; render = projection. The To-line + scale is the anti-storm teeth (a recipient
  // tells DM vs multi vs rig-broadcast vs topology from the header alone). Stamp is stamped ONCE at
  // transport send-time (an INPUT — render reads it, never re-derives).

  it("backward-compat: with no meta, the output is exactly today's 6-line DM envelope (no Sent line)", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "hi");
    expect(out).toBe("From: a@r\nTo: b@r\n---\nhi\n---\n↩ Reply: rig send a@r \"...\"");
  });

  it("multi-send renders the FULL recipient list on the To line (WHO got it)", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "hi", null, { scope: { kind: "multi", recipients: ["b@r", "c@r", "d@r"] } });
    expect(out).toContain("To: b@r, c@r, d@r");
  });

  it("rig-broadcast renders 'broadcast to <rig> (N seats)' — the anti-storm scale", () => {
    const out = wrapPaneEnvelope("a@r", "openrig-pm", "hi", null, { scope: { kind: "rig-broadcast", rig: "openrig-pm", seats: 11 } });
    expect(out).toContain("To: broadcast to openrig-pm (11 seats)");
  });

  it("topology-broadcast renders 'broadcast to topology'", () => {
    const out = wrapPaneEnvelope("a@r", "*", "hi", null, { scope: { kind: "topology" } });
    expect(out).toContain("To: broadcast to topology");
  });

  it("stamps the short MM-DD HH:MMZ timestamp from the transport ISO (read, never re-derived)", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "hi", null, { stampISO: "2026-08-06T17:42:09Z" });
    expect(out).toContain("Sent: 08-06 17:42Z");
  });

  it("header-alone distinguishability (storm test): DM / multi / rig-bcast / topology each render distinct To lines", () => {
    const to = (out: string) => out.split("\n").find((l) => l.startsWith("To:"));
    const dm = to(wrapPaneEnvelope("a@r", "b@r", "x"));
    const multi = to(wrapPaneEnvelope("a@r", "b@r", "x", null, { scope: { kind: "multi", recipients: ["b@r", "c@r"] } }));
    const rig = to(wrapPaneEnvelope("a@r", "r", "x", null, { scope: { kind: "rig-broadcast", rig: "r", seats: 4 } }));
    const topo = to(wrapPaneEnvelope("a@r", "*", "x", null, { scope: { kind: "topology" } }));
    expect(new Set([dm, multi, rig, topo]).size).toBe(4); // all four visually distinct, zero context
  });

  // ── GHOST-STAGE (g): sender-generation suffix on the Sent: line ──
  // These assertions are MIRRORED byte-for-byte in packages/cli/test/send-header.test.ts against
  // wrapSendBody — the cross-package byte-identity contract. Update both twins in lockstep.
  const GEN = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";

  it("(g) stamps the sender's short generation (first8) as a Sent:-line suffix", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "hi", null, { stampISO: "2026-08-06T17:42:09Z", genUuid: GEN });
    expect(out).toContain("Sent: 08-06 17:42Z · gen a1b2c3d4");
  });

  it("(g) byte-exact full envelope with gen (cross-package parity anchor)", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "hi", null, { stampISO: "2026-08-06T17:42:09Z", genUuid: GEN });
    expect(out).toBe('From: a@r\nTo: b@r\nSent: 08-06 17:42Z · gen a1b2c3d4\n---\nhi\n---\n↩ Reply: rig send a@r "..."');
  });

  it("(g) pin-a: OMITS the suffix entirely when the generation is UNKNOWN (never 'gen unknown', never forged)", () => {
    const absent = wrapPaneEnvelope("a@r", "b@r", "hi", null, { stampISO: "2026-08-06T17:42:09Z" });
    const empty = wrapPaneEnvelope("a@r", "b@r", "hi", null, { stampISO: "2026-08-06T17:42:09Z", genUuid: "" });
    for (const out of [absent, empty]) {
      expect(out.split("\n").find((l) => l.startsWith("Sent:"))).toBe("Sent: 08-06 17:42Z");
      expect(out).not.toContain(" · gen ");
    }
  });

  it("(g) pin-a: no Sent line ⇒ no gen suffix (the gen rides the Sent stamp, absent without it)", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "hi", null, { genUuid: GEN });
    expect(out).not.toContain("Sent:");
    expect(out).not.toContain(" · gen ");
  });

  it("(g) pin-b: a body containing ' · gen …' cannot forge the Sent: line's generation (containment)", () => {
    const body = "totally · gen ffffffff not the real gen";
    const out = wrapPaneEnvelope("a@r", "b@r", body, null, { stampISO: "2026-08-06T17:42:09Z", genUuid: GEN });
    // The Sent: line lives in the header block (before the first "\n---\n"); the body is after it.
    const [headerBlock, ...bodyRegion] = out.split("\n---\n");
    expect(headerBlock.split("\n").find((l) => l.startsWith("Sent:"))).toBe("Sent: 08-06 17:42Z · gen a1b2c3d4");
    expect(headerBlock).not.toContain("ffffffff"); // the forged token never reaches the header
    expect(bodyRegion.join("\n---\n")).toContain("· gen ffffffff"); // it stays verbatim in the body
  });

  // (g) INTERIM PIN (orch scope ruling): g renders the gen ONLY where a Sent: line already exists
  // (the rig-send seam). The queue-handoff nudge (queue-repository:537) passes NO meta today, so it
  // carries no Sent:/gen line — absent=omit, honestly. FOLLOW-ON (h): the delivered-at stamp adds a
  // Sent: line to the nudge, at which point the gen rides this same render for free (one HG-5
  // baseline change, in h, not two). This pin documents the interim gap and its closer.
  it("(g) interim: the meta-less handoff nudge carries no Sent:/gen line (h will stamp it)", () => {
    const nudge = wrapPaneEnvelope("orch-lead@v", "driver-3@v", "Queue handoff: qitem-9 - check your queue.", null);
    expect(nudge).not.toContain("Sent:");
    expect(nudge).not.toContain(" · gen ");
  });
});
