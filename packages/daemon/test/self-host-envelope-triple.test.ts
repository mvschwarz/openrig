// SUPERSEDED CONTRACT FLIPPED (founder root invariant 2026-08-27, was 51-09 incr 3
// always-suffix): the envelope renders the sender EXACTLY AS RECEIVED — bare locally, and an
// arriving origin triple verbatim. This file keeps its distinctive job: the BYTE-IDENTICAL
// cross-package parity anchor with the CLI twin (cli/test/self-host-triple.test.ts holds the
// same literal).
import { describe, it, expect } from "vitest";
import { wrapPaneEnvelope } from "../src/lib/pane-envelope.js";

describe("wrapPaneEnvelope — bare-as-received sender (CLI twin, byte-identical)", () => {
  it("renders the BARE local sender in From: and the reply hint (byte-identical to the CLI twin's expected literal)", () => {
    const out = wrapPaneEnvelope("dev50-driver@v-openrig-build", "guard@my-rig", "hi");
    expect(out).toBe(
      'From: dev50-driver@v-openrig-build\nTo: guard@my-rig\n---\nhi\n---\n\u21a9 Reply: rig send dev50-driver@v-openrig-build "..."',
    );
  });

  it("an arriving ORIGIN triple renders verbatim (the cross-host boundary constructed it; never re-stamped)", () => {
    const out = wrapPaneEnvelope("dev50-driver@v-openrig-build@mm2-openrig1", "guard@my-rig", "hi");
    expect(out).toContain("From: dev50-driver@v-openrig-build@mm2-openrig1");
    expect(out).toContain('\u21a9 Reply: rig send dev50-driver@v-openrig-build@mm2-openrig1 "..."');
  });
});
