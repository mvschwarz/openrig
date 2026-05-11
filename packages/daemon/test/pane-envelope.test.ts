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
});
