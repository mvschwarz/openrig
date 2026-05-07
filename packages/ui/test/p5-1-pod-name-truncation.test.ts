// V1 polish slice Phase 5.1 P5.1-3 — pod name truncation regression guard.
//
// Founder noticed pod names rendering as "covery" / "anning" / etc.
// at the live VM walk post-V1-ship. Root cause: displayPodName was
// calling shortId(podId, 6) which returns the LAST 6 chars of any
// input — designed for 26-char ULIDs but WRONG for human-readable pod
// namespaces. The fix returns podId verbatim. This test permanently
// guards the symptoms the founder reported plus the underlying contract.

import { describe, it, expect } from "vitest";
import { displayPodName, inferPodName, displayAgentName } from "../src/lib/display-name.js";

describe("displayPodName P5.1-3 regression: human-readable pod names pass through verbatim", () => {
  it("'discovery' stays 'discovery' (NOT 'covery')", () => {
    expect(displayPodName("discovery")).toBe("discovery");
  });

  it("'planning' stays 'planning' (NOT 'anning')", () => {
    expect(displayPodName("planning")).toBe("planning");
  });

  it("'kernel' stays 'kernel'", () => {
    expect(displayPodName("kernel")).toBe("kernel");
  });

  it("'orch' stays 'orch'", () => {
    expect(displayPodName("orch")).toBe("orch");
  });

  it("'product-lab' stays 'product-lab'", () => {
    expect(displayPodName("product-lab")).toBe("product-lab");
  });

  it("'recursive-self-improvement-v2' stays full (NOT '-v2')", () => {
    expect(displayPodName("recursive-self-improvement-v2")).toBe(
      "recursive-self-improvement-v2",
    );
  });

  it("null / empty returns 'ungrouped' fallback", () => {
    expect(displayPodName(null)).toBe("ungrouped");
    expect(displayPodName(undefined)).toBe("ungrouped");
    expect(displayPodName("")).toBe("ungrouped");
  });

  it("source-assertion: displayPodName does NOT call shortId for pod names (ritual #9)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(__dirname, "../src/lib/display-name.ts"),
      "utf8",
    );
    // Strip comments to ignore historical mention.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*\n/gm, "");
    // Locate displayPodName function body.
    const fnMatch = codeOnly.match(/export function displayPodName[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![0];
    expect(body).not.toMatch(/shortId\s*\(/);
  });
});

describe("inferPodName + displayAgentName preserved (P5.1-3 cleanup didn't regress neighbors)", () => {
  it("inferPodName splits 'discovery.intake-router' → 'discovery'", () => {
    expect(inferPodName("discovery.intake-router")).toBe("discovery");
  });

  it("displayAgentName splits 'discovery.intake-router' → 'intake-router'", () => {
    expect(displayAgentName("discovery.intake-router")).toBe("intake-router");
  });

  it("inferPodName returns the whole id when no dot", () => {
    expect(inferPodName("solo-agent")).toBe("solo-agent");
  });

  it("inferPodName returns null for null/undefined", () => {
    expect(inferPodName(null)).toBe(null);
    expect(inferPodName(undefined)).toBe(null);
  });
});
