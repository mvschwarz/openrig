// @vitest-environment jsdom

// OPR.0.4.4.20 retro-demo fixback — the FileViewer eternal-Loading defect:
// the demo proof caught the drawer stuck at "NO CONTENT / Loading ..." for
// PROOF.md while /api/files/read 200'd — the caller (a review-surface SSOT
// door) passed neither a root nor an absolutePath, so the viewer never had
// a target to fetch. Three legs pinned here (re-targeted to the CORRECTIVE
// one-structure surface — the old compare column is a DELETED file):
//  (1) FileViewer renders an HONEST "NOT RESOLVABLE" state (never eternal
//      Loading) when given no content and no readable target.
//  (2) FileViewer still fetches + renders content for an explicit root
//      target (the successful-read rendering regression the fixback asks).
//  (3) The PLAN section's "full PRD →" door emits a RESOLVABLE data shape
//      (root + readPath + absolutePath fallback) built from the slice
//      context — including the exact-allowlist-root (relPath "") class.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FileViewer } from "../src/components/drawer-viewers/FileViewer.js";
import type { ComposedSliceReview } from "../src/hooks/useReview.js";

const captured: Array<Record<string, unknown>> = [];
vi.mock("../src/components/drawer-triggers/FileReferenceTrigger.js", () => ({
  FileReferenceTrigger: ({ data, children }: { data: Record<string, unknown>; children: React.ReactNode }) => {
    captured.push(data);
    return <button type="button">{children}</button>;
  },
}));

// The PLAN-door regression drives the REAL SliceReviewTab; the orthogonal
// bands + markdown renderer are stubbed so the test isolates the door shape.
vi.mock("../src/components/review/NeedsYouAccordion.js", () => ({ NeedsYouAccordion: () => null }));
vi.mock("../src/components/review/AgentsBandView.js", () => ({ AgentsBandView: () => null }));
vi.mock("../src/components/review/VerifyLineageCard.js", () => ({ VerifyLineageCard: () => null }));
// Render-through stub: FileViewer's fetched-content assertion (leg 2) reads
// the markdown TEXT, so the stub must pass content through, not blank it.
vi.mock("../src/components/markdown/MarkdownViewer.js", () => ({
  MarkdownViewer: ({ content }: { content?: string }) => <div>{content}</div>,
}));

const reviewState: { data: ComposedSliceReview | null } = { data: null };
vi.mock("../src/hooks/useReview.js", () => ({
  useSliceReview: () => ({ isLoading: false, isError: false, data: reviewState.data, error: null }),
}));

const scopeState: { resolved: { rootName: string; relPath: string } | null } = { resolved: null };
vi.mock("../src/hooks/useScopeMarkdown.js", () => ({
  useScopeMarkdown: () => ({ resolved: scopeState.resolved, isLoading: false }),
}));

import { SliceReviewTab } from "../src/components/review/SliceReviewTab.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  captured.length = 0;
});

function withQuery(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function fixtureReview(): ComposedSliceReview {
  return {
    slice: "s",
    sliceId: null,
    title: "s",
    missionId: "m",
    phase: "spec",
    laneLabel: "PLAN",
    intent: { text: "i", media: [], ssotPath: "m/slices/s/README.md", degrade: null },
    plan: { concise: { text: "1. m", media: [] }, lockedArtifacts: [], lock: null, ssotPath: "m/slices/s/IMPLEMENTATION-PRD.md" },
    delivered: { items: [], extraProof: [], lock: null, proofDirPath: null },
    needsYou: { items: [], provenance: "0" },
    agents: { scope: "slice:s", rows: [], provenance: "0", coordinationHealth: null },
    lineage: { candidateSha: null, mergeSha: null, mainTip: "tip", freshness: "unknown", staleBehind: null, gateCells: [] },
    defects: [],
    composedAt: "2026-07-06T00:00:00.000Z",
  };
}

describe("FileViewer — resolvable-target honesty (retro-demo fixback)", () => {
  it.each([
    ["C:\\work", "C:/work/docs/note.md", "docs/note.md"],
    ["\\\\host\\share", "\\\\host\\share\\docs\\note.md", "docs/note.md"],
    ["/work", "/work/literal\\name.md", "literal\\name.md"],
    ["/work", "/work/..notes/note.md", "..notes/note.md"],
  ])("reads the exact server path under %s", async (root, absolutePath, relative) => {
    const reads: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(String(input), "http://fixture");
      if (url.pathname === "/api/files/roots") return Response.json({ roots: [{ name: "ws", path: root }] });
      if (url.pathname === "/api/files/read") { reads.push(url.searchParams.get("path")!); return Response.json({ content: "exact native body", truncated: false }); }
      throw Error("Unexpected fixture request");
    });
    render(withQuery(<FileViewer path="note.md" kind="markdown" absolutePath={absolutePath} />));
    await waitFor(() => expect(document.body.textContent).toContain("exact native body"));
    expect(reads).toEqual([relative]);
  });
  it("renders NOT RESOLVABLE (never eternal Loading) when given no content and no target", () => {
    render(withQuery(<FileViewer path="missions/m/slices/s/PROOF.md" kind="markdown" absolutePath={null} />));
    expect(screen.getByTestId("file-viewer-unresolvable")).toBeTruthy();
    expect(screen.queryByText(/Loading/)).toBeNull();
  });

  it("still renders inline content without any target (inline callers unaffected)", () => {
    render(withQuery(<FileViewer path="x.md" kind="markdown" content="# hello inline" />));
    expect(screen.queryByTestId("file-viewer-unresolvable")).toBeNull();
    expect(screen.getByTestId("file-viewer")).toBeTruthy();
  });

  it("fetches and RENDERS the 200 /api/files/read content for an explicit root target", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).startsWith("/api/files/read")) {
        return new Response(JSON.stringify({ content: "# Proof body from read API", truncated: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    render(withQuery(<FileViewer path="PROOF.md" kind="markdown" root="workspace" readPath="missions/m/slices/s/PROOF.md" />));
    await waitFor(() => {
      // The drawer must show the ACTUAL fetched content — the acceptance pin.
      expect(document.body.textContent).toContain("Proof body from read API");
    });
    expect(screen.queryByTestId("file-viewer-unresolvable")).toBeNull();
    expect(screen.queryByTestId("file-viewer-error")).toBeNull();
  });
});

describe("PLAN 'full PRD →' door — emits a resolvable FileViewer target", () => {
  it("joins the resolved root relPath with the slice-dir FILENAME (never the workspace-relative ssotPath)", () => {
    reviewState.data = fixtureReview();
    scopeState.resolved = { rootName: "workspace", relPath: "missions/m/slices/s" };
    render(withQuery(<SliceReviewTab sliceName="s" slicePath="/abs/m/slices/s" />));
    const door = captured.find((d) => d["path"] === "m/slices/s/IMPLEMENTATION-PRD.md");
    expect(door).toBeDefined();
    expect(door).toMatchObject({
      root: "workspace",
      readPath: "missions/m/slices/s/IMPLEMENTATION-PRD.md", // relPath + FILE — no double prefix
      absolutePath: "/abs/m/slices/s/IMPLEMENTATION-PRD.md",
    });
  });

  it("exact-allowlist-root ctx (relPath = '') yields the BARE filename readPath, never a dropped or over-prefixed one", () => {
    // Guard code-review fold (23ca5031 class): useScopeMarkdown exact-root
    // resolution legally returns relPath "" (the slice dir IS the allowlist
    // root). The readPath must then be the file alone — the mission-prefixed
    // ssotPath under that root would fetch an over-prefixed wrong path.
    reviewState.data = fixtureReview();
    scopeState.resolved = { rootName: "slice-root", relPath: "" };
    render(withQuery(<SliceReviewTab sliceName="s" slicePath="/abs/m/slices/s" />));
    const door = captured.find((d) => d["path"] === "m/slices/s/IMPLEMENTATION-PRD.md");
    expect(door).toMatchObject({ root: "slice-root", readPath: "IMPLEMENTATION-PRD.md" });
  });

  it("unresolved root (relPath null) keeps the absolutePath fallback — never the dead {no root, null absolutePath} shape", () => {
    reviewState.data = fixtureReview();
    scopeState.resolved = null;
    render(withQuery(<SliceReviewTab sliceName="s" slicePath="/abs/m/slices/s" />));
    const door = captured.find((d) => d["path"] === "m/slices/s/IMPLEMENTATION-PRD.md");
    expect(door).toBeDefined();
    expect(door!["readPath"]).toBeUndefined();
    expect(door).toMatchObject({ absolutePath: "/abs/m/slices/s/IMPLEMENTATION-PRD.md" });
    // The fetchable-target invariant: a root+readPath pair OR an absolutePath.
    for (const d of captured) {
      expect(d["root"] !== undefined || d["absolutePath"] !== null).toBe(true);
    }
  });
});
