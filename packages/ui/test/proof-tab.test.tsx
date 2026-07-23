// OPR.0.4.1.23 Part-3 — PROOF tab. Projects each slice's proof/ + PROOF.md AS-IS
// over the existing /api/files endpoints (reuse, like the slice-21 Artifacts
// navigator). Tests: verdict parse (robust to authored shapes incl. the scaffold
// placeholder), populated card (badge + PROOF.md + gallery), scaffolded empty-state,
// and read-only (no /write).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState, type ReactNode } from "react";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScopeProofRollup, SliceProofTab } from "../src/components/project/ProofTab.js";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { SharedDetailDrawer, type DrawerSelection } from "../src/components/SharedDetailDrawer.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

let calls: string[] = [];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

// Slice relPath -> { proofMd?: string; proofEntries?: [...] }. Absent proofMd = 404.
const SLICES: Record<string, { proofMd?: string; proofEntries?: Array<{ name: string; type: "file" | "dir"; size: number | null; mtime: string | null }> }> = {
  // populated PASS — real-capture shape (`**Verdict: PASS**`) + 2 captures
  "missions/m/slices/16-brief": {
    // includes an INLINE image in the Intent->Proof table (the real PROOF.md shape),
    // so the markdown-image asset-resolution path is exercised, not just the gallery.
    proofMd: "# OPR.0.4.1.16 Proof\n\n**Verdict: PASS** · 2026-06-23\n\n**Method.** Source-build daemon.\n\n**Result.** Brief projected.\n\n## Intent -> Proof\n\n![capture](proof/real-live-a.png)",
    proofEntries: [
      { name: "real-live-a.png", type: "file", size: 120000, mtime: "2026-06-23T22:01:00.000Z" },
      { name: "real-live-b.png", type: "file", size: 130000, mtime: "2026-06-23T22:02:00.000Z" },
    ],
  },
  // PARTIAL — bare `Verdict: pass-with-residue`, one capture
  "missions/m/slices/17-steering": {
    proofMd: "Closed by: qa   Date: 2026-06-23   Verdict: pass-with-residue\n\n## What this proves\n\nSteering renders.",
    proofEntries: [{ name: "cap.png", type: "file", size: 99000, mtime: "2026-06-23T22:03:00.000Z" }],
  },
  // FAIL
  "missions/m/slices/19-story": {
    proofMd: "**Verdict: FAIL** · regression found",
    proofEntries: [{ name: "fail.png", type: "file", size: 1000, mtime: "2026-06-23T22:04:00.000Z" }],
  },
  // SCAFFOLDED-but-unpopulated — the rig-scope template with placeholder verdict + empty proof/
  "missions/m/slices/18-queue": {
    proofMd: "# PROOF — OPR.0.4.1.18 Queue summary\n\nClosed by: <seat>   Date: <date>   Verdict: <pass | pass-with-residue | ...>\n\n## What this proves\n\n<1-3 sentences>",
    proofEntries: [],
  },
  // FOUNDER-FIX drawer slice — a markdown proof-of-work file (guard.md) that must
  // open in the in-app drawer, alongside an image capture that stays in the gallery
  // + an inline PROOF.md image (both preserved on the /api/files/asset path).
  "missions/m/slices/20-drawer": {
    proofMd: "# OPR.0.4.1.20 Proof\n\n**Verdict: PASS** · 2026-07-22\n\n## Intent -> Proof\n\n![cap](proof/shot.png)",
    proofEntries: [
      { name: "guard.md", type: "file", size: 480, mtime: "2026-07-22T22:00:00.000Z" },
      { name: "shot.png", type: "file", size: 120000, mtime: "2026-07-22T22:01:00.000Z" },
    ],
  },
};

// C1 proof contract (docs/reference/sdlc-conventions.md §5): five frontmatter
// fields + a distinctive body, so the drawer render is asserted against real
// proof content (header AND body), never a false green.
const GUARD_C1 = [
  "---",
  "slice: slice-04-review-tab-observability",
  "candidate_sha: 7d0997dddaab59f43bcc658fe2c0457128a64f53",
  "artifact_type: guard",
  "verdict: PASS",
  "money_evidence: proof/guard.md opens in the in-app drawer",
  "---",
  "",
  "# Guard Verdict — slice-04",
  "",
  "DISTINCTIVE-BODY-MARKER: the guard proof-of-work rendered inside the drawer.",
].join("\n");

// Proof-of-work file bodies (proof/<name>, NOT PROOF.md) keyed by slice-relative
// read path — served by the /api/files/read route below only when opened.
const PROOF_FILES: Record<string, string> = {
  "missions/m/slices/20-drawer/proof/guard.md": GUARD_C1,
};

function routeFiles(input: unknown) {
  const url = String(input);
  calls.push(url);
  if (url.includes("/api/files/roots")) {
    return Promise.resolve(jsonResponse({ roots: [{ name: "work", path: "/ws" }] }));
  }
  if (url.includes("/api/files/read")) {
    const path = new URL(url, "http://t.local").searchParams.get("path") ?? "";
    // proof-of-work file read (proof/<name>, not PROOF.md) — the drawer content.
    const proofFile = PROOF_FILES[path];
    if (proofFile != null) {
      return Promise.resolve(jsonResponse({ root: "work", path, absolutePath: `/ws/${path}`, content: proofFile, mtime: "2026-07-22T22:05:00.000Z", contentHash: "pf", size: proofFile.length }));
    }
    const slice = path.replace(/\/PROOF\.md$/, "");
    const md = SLICES[slice]?.proofMd;
    if (md == null) return Promise.resolve(jsonResponse({ error: "not found" }, 404));
    return Promise.resolve(jsonResponse({ root: "work", path, absolutePath: `/ws/${path}`, content: md, mtime: "2026-06-23T22:00:00.000Z", contentHash: "h", size: md.length }));
  }
  if (url.includes("/api/files/list")) {
    const path = new URL(url, "http://t.local").searchParams.get("path") ?? "";
    const slice = path.replace(/\/proof$/, "");
    return Promise.resolve(jsonResponse({ root: "work", path, entries: SLICES[slice]?.proofEntries ?? [] }));
  }
  return Promise.resolve(jsonResponse({}, 404));
}

function row(name: string, displayName: string, slice: string) {
  return { name, displayName, slicePath: `/ws/${slice}` };
}

function renderRollup(rows: ReturnType<typeof row>[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScopeProofRollup rows={rows} />
    </QueryClientProvider>,
  );
}

describe("OPR.0.4.1.23 — PROOF tab", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(routeFiles);
    calls = [];
  });
  afterEach(() => cleanup());

  it("AC-1: a populated slice renders the verdict badge, PROOF.md, and the proof/ gallery", async () => {
    renderRollup([row("16-brief", "OPR.0.4.1.16", "missions/m/slices/16-brief")]);
    await waitFor(() => expect(screen.getByTestId("proof-verdict-OPR.0.4.1.16")).toBeTruthy());
    expect(screen.getByTestId("proof-verdict-OPR.0.4.1.16").textContent).toBe("PASS");
    expect(screen.getByTestId("proof-slice-OPR.0.4.1.16")).toBeTruthy();
    expect(screen.getByTestId("proof-md-OPR.0.4.1.16")).toBeTruthy();
    // gallery shows both real captures (browser-viewable via /api/files/asset src).
    expect(screen.getByTestId("proof-gallery-OPR.0.4.1.16")).toBeTruthy();
    expect(screen.getByTestId("proof-thumb-real-live-a.png")).toBeTruthy();
    expect(screen.getByTestId("proof-thumb-real-live-b.png")).toBeTruthy();
  });

  it("AC-2: a scaffolded-but-unpopulated slice (placeholder verdict + empty proof/) renders the empty-state", async () => {
    renderRollup([row("18-queue", "OPR.0.4.1.18", "missions/m/slices/18-queue")]);
    await waitFor(() => expect(screen.getByTestId("proof-slice-empty-OPR.0.4.1.18")).toBeTruthy());
    expect(screen.getByTestId("proof-empty-state-OPR.0.4.1.18").textContent).toMatch(/no proof yet|scaffolded|closeout/i);
    // a placeholder <pass|...> verdict is NOT a real verdict — no badge.
    expect(screen.queryByTestId("proof-verdict-OPR.0.4.1.18")).toBeNull();
  });

  it("AC-3: verdict parsing is robust — pass-with-residue → PARTIAL, FAIL → FAIL", async () => {
    renderRollup([
      row("17-steering", "OPR.0.4.1.17", "missions/m/slices/17-steering"),
      row("19-story", "OPR.0.4.1.19", "missions/m/slices/19-story"),
    ]);
    await waitFor(() => expect(screen.getByTestId("proof-verdict-OPR.0.4.1.17")).toBeTruthy());
    expect(screen.getByTestId("proof-verdict-OPR.0.4.1.17").textContent).toBe("PARTIAL");
    expect(screen.getByTestId("proof-verdict-OPR.0.4.1.19").textContent).toBe("FAIL");
  });

  it("AC-4: read-only — projects the location AS-IS, never POSTs /api/files/write", async () => {
    renderRollup([row("16-brief", "OPR.0.4.1.16", "missions/m/slices/16-brief")]);
    await waitFor(() => expect(screen.getByTestId("proof-verdict-OPR.0.4.1.16")).toBeTruthy());
    expect(calls.some((c) => c.includes("/api/files/write"))).toBe(false);
    // it reads the slice-root PROOF.md + the proof/ listing (the AS-IS projection).
    expect(calls.some((c) => c.includes("/api/files/read") && c.includes("16-brief%2FPROOF.md"))).toBe(true);
    expect(calls.some((c) => c.includes("/api/files/list") && c.includes("16-brief%2Fproof"))).toBe(true);
  });

  it("AC-7 (guard fcf1126f regression): INLINE PROOF.md images resolve under /api/files/asset (assetBasePath), not broken route-relative", async () => {
    const { container } = renderRollup([row("16-brief", "OPR.0.4.1.16", "missions/m/slices/16-brief")]);
    await waitFor(() => expect(screen.getByTestId("proof-verdict-OPR.0.4.1.16")).toBeTruthy());
    // the inline `![capture](proof/real-live-a.png)` inside the rendered PROOF.md
    const inline = container.querySelector('img[alt="capture"]') as HTMLImageElement | null;
    expect(inline).toBeTruthy();
    const src = inline!.getAttribute("src") ?? "";
    expect(src).toContain("/api/files/asset");
    // resolved against the slice-root asset base -> the proof/ path, NOT a bare route-relative "proof/..."
    expect(src).toContain("16-brief");
    expect(src).toContain("proof/real-live-a.png");
    expect(src.startsWith("proof/")).toBe(false);
  });

  it("AC-5: empty scope renders a self-explanatory empty-state (no slices indexed)", async () => {
    renderRollup([]);
    expect(screen.getByTestId("proof-rollup-empty")).toBeTruthy();
  });

  it("AC-6: slice-altitude SliceProofTab renders the single slice's proof card", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SliceProofTab sliceId="OPR.0.4.1.16" title="brief" slicePath="/ws/missions/m/slices/16-brief" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("proof-verdict-OPR.0.4.1.16")).toBeTruthy());
    expect(screen.getByTestId("proof-verdict-OPR.0.4.1.16").textContent).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// FOUNDER FIX (qitem-20260722234754-e8db7111): proof-of-work file links must
// open IN-APP in the SharedDetailDrawer — rendering the C1 proof content — NOT
// navigate the whole browser to the raw /api/files/asset (a full-page escape
// out of the SPA). These tests mount the REAL drawer stack (DrawerSelection +
// SharedDetailDrawer + FileViewer) so a click exercises the true in-app path,
// and pin the preservation of images/lightbox + inline PROOF.md and the lazy
// no-read-before-click boundary. RED against ProofTab.tsx's raw <a target=_blank>.
// ---------------------------------------------------------------------------

// Minimal real drawer host — mirrors AppShell's DrawerSelection provider +
// SharedDetailDrawer so a FileReferenceTrigger click actually opens the drawer.
function DrawerHost({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<DrawerSelection>(null);
  return (
    <DrawerSelectionContext.Provider value={{ selection, setSelection }}>
      {children}
      <SharedDetailDrawer
        selection={selection}
        onClose={() => setSelection(null)}
        events={[]}
        selectedDiscoveredId={null}
        onSelectDiscoveredId={() => {}}
        placementTarget={null}
        onClearPlacement={() => {}}
      />
    </DrawerSelectionContext.Provider>
  );
}

const DRAWER_SLICE = { id: "OPR.0.4.1.20", path: "/ws/missions/m/slices/20-drawer" };
// The canonical slice-relative proof path the drawer must read (URL-encoded).
const GUARD_READ = "missions%2Fm%2Fslices%2F20-drawer%2Fproof%2Fguard.md";

function renderSliceInDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DrawerHost>
        <SliceProofTab sliceId={DRAWER_SLICE.id} title="brief" slicePath={DRAWER_SLICE.path} />
      </DrawerHost>
    </QueryClientProvider>,
  );
}

describe("PROOF tab — proof file opens in the in-app drawer (founder fix e8db7111)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(routeFiles);
    calls = [];
  });
  afterEach(() => cleanup());

  it("FX-1 (RED): a markdown proof link is an in-app control, not a full-page raw-asset anchor", async () => {
    renderSliceInDrawer();
    const list = await screen.findByTestId(`proof-files-${DRAWER_SLICE.id}`);
    const label = within(list).getByText("proof/guard.md");
    // desired: an in-app button (FileReferenceTrigger), NOT an <a> that escapes the SPA.
    expect(label.closest("button")).toBeTruthy();
    expect(label.closest("a")).toBeNull();
    // no full-page raw-asset escape anywhere in the proof-files list.
    expect(list.querySelector('a[target="_blank"]')).toBeNull();
    expect(list.querySelector('a[href*="/api/files/asset"]')).toBeNull();
  });

  it("FX-2 (RED): the read is LAZY — clicking opens the drawer and reads the slice-relative proof path exactly", async () => {
    renderSliceInDrawer();
    const list = await screen.findByTestId(`proof-files-${DRAWER_SLICE.id}`);
    // lazy: no read of guard.md before the click (only PROOF.md + the proof/ listing so far).
    expect(calls.some((c) => c.includes("/api/files/read") && c.includes("guard.md"))).toBe(false);
    expect(screen.queryByTestId("file-viewer")).toBeNull();

    fireEvent.click(within(list).getByText("proof/guard.md"));

    const viewer = await screen.findByTestId("file-viewer");
    // reads the canonical slice-relative proof path under the work root — the money assertion.
    await waitFor(() =>
      expect(
        calls.some((c) => c.includes("/api/files/read") && c.includes("root=work") && c.includes(GUARD_READ)),
      ).toBe(true),
    );
    expect(within(viewer).getByTestId("file-viewer-root-path").textContent).toContain(
      "missions/m/slices/20-drawer/proof/guard.md",
    );
    // DISPLAY path stays the friendly slice-relative label proof/guard.md (the drawer
    // header), distinct from the resolved read path above — pins the FileLink display.
    expect(within(viewer).getByText("proof/guard.md")).toBeTruthy();
  });

  it("FX-3 (RED): the drawer renders the C1 proof contract — five frontmatter fields + the distinctive body", async () => {
    renderSliceInDrawer();
    const list = await screen.findByTestId(`proof-files-${DRAWER_SLICE.id}`);
    fireEvent.click(within(list).getByText("proof/guard.md"));
    await screen.findByTestId("file-viewer");

    const fm = await screen.findByTestId("markdown-frontmatter");
    for (const field of ["slice", "candidate_sha", "artifact_type", "verdict", "money_evidence"]) {
      expect(within(fm).getByText(field)).toBeTruthy();
    }
    // distinctive field VALUES (not just keys) — prevents a false green on an empty header.
    expect(within(fm).getByText("guard")).toBeTruthy();
    expect(within(fm).getByText("7d0997dddaab59f43bcc658fe2c0457128a64f53")).toBeTruthy();
    // the BODY (not just the header) renders inside the drawer.
    expect(screen.getByText(/DISTINCTIVE-BODY-MARKER/)).toBeTruthy();
  });

  it("FX-4 (RED): the drawer closes in place — same PROOF surface, location/history unchanged (no navigation)", async () => {
    renderSliceInDrawer();
    const list = await screen.findByTestId(`proof-files-${DRAWER_SLICE.id}`);
    // pin the exact SPA location + history depth BEFORE the interaction — a full-page
    // raw-asset navigation (the defect) is precisely what mutates these.
    const hrefBefore = window.location.href;
    const historyBefore = window.history.length;

    fireEvent.click(within(list).getByText("proof/guard.md"));
    await screen.findByTestId("file-viewer");
    // opening the drawer is in-app: no navigation, no history push.
    expect(window.location.href).toBe(hrefBefore);
    expect(window.history.length).toBe(historyBefore);

    fireEvent.pointerDown(screen.getByTestId("shared-detail-drawer-outside"));
    await waitFor(() => expect(screen.queryByTestId("file-viewer")).toBeNull());
    // still on the same slice proof card, and the location/history never moved.
    expect(screen.getByTestId(`proof-slice-${DRAWER_SLICE.id}`)).toBeTruthy();
    expect(screen.getByTestId(`proof-files-${DRAWER_SLICE.id}`)).toBeTruthy();
    expect(window.location.href).toBe(hrefBefore);
    expect(window.history.length).toBe(historyBefore);
  });

  it("FX-5 (GREEN preservation): image captures + inline PROOF.md images still resolve via /api/files/asset (drawer is markdown-only)", async () => {
    const { container } = renderSliceInDrawer();
    await screen.findByTestId(`proof-slice-${DRAWER_SLICE.id}`);
    // the proof/ image capture stays in the gallery/lightbox path (browser-viewable asset), not the drawer.
    expect(screen.getByTestId(`proof-gallery-${DRAWER_SLICE.id}`)).toBeTruthy();
    expect(screen.getByTestId("proof-thumb-shot.png")).toBeTruthy();
    // inline PROOF.md image still resolves under /api/files/asset (guard fcf1126f invariant).
    const inline = container.querySelector('img[alt="cap"]') as HTMLImageElement | null;
    expect(inline).toBeTruthy();
    expect(inline!.getAttribute("src") ?? "").toContain("/api/files/asset");
    // and the guard.md control never triggered a read (drawer stays closed here).
    expect(calls.some((c) => c.includes("/api/files/read") && c.includes("guard.md"))).toBe(false);
  });
});
