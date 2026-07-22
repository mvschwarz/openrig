// @vitest-environment jsdom

// OPR.0.4.4.20 rev1 fixback at d6135921 — the two UI-side legs:
//  (1) approveSlice posts the SHIPPED Packet-1 route contract
//      (scopeTier/scopePath/actorSession/approvalScope — routes/scope-approve.ts),
//      not the earlier guessed field names the real route rejects.
//  (2) EvidenceOpener refuses absolute + `..`-traversal refs with a named
//      visible error BEFORE building any URL/scope (slice-boundary containment).

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import React from "react";
import { approveSlice } from "../src/components/review/review-actions.js";
import { EvidenceOpener, evidenceRefContained } from "../src/components/review/EvidenceOpener.js";

// slice-04 REV6 — a capturing double so the opener pins can read the composed
// data.readPath. The opener is NOT changed; this only surfaces its output.
vi.mock("../src/components/drawer-triggers/FileReferenceTrigger.js", () => ({
  FileReferenceTrigger: ({ data, testId, children }: { data: { readPath?: string; kind?: string }; testId?: string; children?: React.ReactNode }) => (
    <span data-testid={testId} data-readpath={data?.readPath ?? ""} data-kind={data?.kind ?? ""}>{children}</span>
  ),
}));

vi.mock("../src/components/project/ArtifactsNavigator.js", () => ({
  ArtifactsNavigator: () => null,
}));

vi.mock("../src/components/project/Lightbox.js", () => ({
  Lightbox: () => null,
}));

vi.mock("../src/hooks/useFiles.js", () => ({
  fileAssetUrl: (root: string, path: string) => `/api/files/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("approveSlice — Packet-1 payload shape", () => {
  it("posts scopeTier/scopePath/actorSession/approvalScope to /api/scope/approve", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    });

    const outcome = await approveSlice("20-living-notes-composer-surfaces", "human@host");
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/scope/approve");
    // The EXACT shipped contract members — and none of the old guessed names.
    expect(calls[0]!.body).toEqual({
      scopeTier: "slice",
      scopePath: "20-living-notes-composer-surfaces",
      actorSession: "human@host",
      approvalScope: "delivery",
    });

    await approveSlice("s", "a@h", "spec");
    expect(calls[1]!.body["approvalScope"]).toBe("spec");
  });
});

describe("EvidenceOpener — slice-boundary containment", () => {
  const ctx = { root: "ws", relPath: "missions/m/slices/s", slicePath: "/tmp/fixture-slice" };

  it("pins the containment predicate: absolute + `..` segments refused, dotted filenames allowed", () => {
    expect(evidenceRefContained("proof/shot.png")).toBe(true);
    expect(evidenceRefContained("proof/ok..png")).toBe(true); // filename dots, not traversal
    expect(evidenceRefContained("../other-slice/shot.png")).toBe(false);
    expect(evidenceRefContained("sub/../../shot.png")).toBe(false);
    expect(evidenceRefContained("..")).toBe(false);
    expect(evidenceRefContained("/abs/anywhere.png")).toBe(false);
  });

  it("renders the named outside-scope error for a traversal ref — no img, no link, no folder scope", () => {
    render(<EvidenceOpener evidenceRef="../other-slice/shot.png" ctx={ctx} testId="ev" />);
    expect(screen.getByTestId("ev-outside-scope").textContent).toContain("escapes the slice scope");
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
  });

  it("refuses traversal folder refs before any ArtifactsNavigator scope is built", () => {
    render(<EvidenceOpener evidenceRef="../sibling-evidence/" ctx={ctx} testId="ev2" />);
    expect(screen.getByTestId("ev2-outside-scope")).toBeTruthy();
    expect(document.querySelector("button")).toBeNull(); // no folder-open affordance
  });

  // slice-04 REV6 (qitem-20260722114922) — pre-fix GREEN characterization pins:
  // the opener joins the current slice-dir relPath with a SLICE-RELATIVE ref
  // exactly once. These prove the opener is correct/unchanged; the defect is that
  // the composer emitted a mission-relative confirm-faithful ref (pinned RED in
  // review-composer.test.ts), NOT any opener behavior.
  it("R2 pin (GREEN): a slice-relative PROOF.md resolves the canonical slice path exactly once (never duplicated)", () => {
    render(<EvidenceOpener evidenceRef="PROOF.md" ctx={ctx} testId="cf" />);
    const readPath = screen.getByTestId("cf-md").getAttribute("data-readpath");
    expect(readPath).toBe("missions/m/slices/s/PROOF.md");
    expect(readPath).not.toBe("missions/m/slices/s/missions/m/slices/s/PROOF.md");
  });

  it("R3 pin (GREEN): an ordinary slice-relative proof/qa.md is preserved/openable, unchanged", () => {
    render(<EvidenceOpener evidenceRef="proof/qa.md" ctx={ctx} testId="pq" />);
    expect(screen.getByTestId("pq-md").getAttribute("data-readpath")).toBe("missions/m/slices/s/proof/qa.md");
  });
});
