// OPR.0.4.1.21 — Artifacts altitude-scoped file navigator. Read-only projection
// over the existing /api/files/* endpoints. TDD against the 7 ACs; the load-bearing
// one is AC-3 (the lazy-load boundary — no eager file-body fetch, no tree pre-walk).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState, type ReactNode } from "react";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArtifactsNavigator } from "../src/components/project/ArtifactsNavigator.js";
import { EvidenceOpener, type EvidenceContext } from "../src/components/review/EvidenceOpener.js";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { SharedDetailDrawer, type DrawerSelection } from "../src/components/SharedDetailDrawer.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

let calls: string[] = [];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

// Fixture tree under allowlist root "work" (path "/ws"). The mission altitude
// base is missions/release-0.4.1; one slice subtree is included for AC-4.
const TREE: Record<string, Array<{ name: string; type: "dir" | "file" | "other"; size: number | null; mtime: string | null }>> = {
  "missions/release-0.4.1": [
    { name: "README.md", type: "file", size: 4096, mtime: "2026-06-23T22:01:00.000Z" },
    { name: "PROGRESS.md", type: "file", size: 3170, mtime: "2026-06-23T05:00:00.000Z" },
    { name: "slices", type: "dir", size: null, mtime: "2026-06-23T22:52:00.000Z" },
    { name: "digital-twin", type: "dir", size: null, mtime: "2026-06-23T22:52:00.000Z" },
  ],
  "missions/release-0.4.1/slices": [
    { name: "09-seat-restore", type: "dir", size: null, mtime: "2026-06-22T10:00:00.000Z" },
    { name: "15-workspace-ux", type: "dir", size: null, mtime: "2026-06-23T22:52:00.000Z" },
  ],
  "missions/release-0.4.1/slices/15-workspace-ux": [
    { name: "README.md", type: "file", size: 4096, mtime: "2026-06-23T22:01:00.000Z" },
    { name: "batch-1.change.diff", type: "file", size: 12288, mtime: "2026-06-23T22:52:00.000Z" },
    { name: "03-story-dag.intent.png", type: "file", size: 129024, mtime: "2026-06-23T22:53:00.000Z" },
    { name: "proof", type: "dir", size: null, mtime: "2026-06-23T22:52:00.000Z" },
  ],
  // FOUNDER-FIX DELIVERED drill-in target — the slice proof/ folder EvidenceOpener
  // ('proof/') scopes ArtifactsNavigator to; its C1 file must open in the drawer.
  "missions/release-0.4.1/slices/15-workspace-ux/proof": [
    { name: "guard.md", type: "file", size: 480, mtime: "2026-06-23T22:52:00.000Z" },
  ],
};

function routeFiles({ rootsStatus = 200, rootsEmpty = false }: { rootsStatus?: number; rootsEmpty?: boolean } = {}) {
  return (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/api/files/roots")) {
      if (rootsStatus === 503) {
        return Promise.resolve(jsonResponse({ error: "files_routes_unavailable", hint: "Configure a workspace files root" }, 503));
      }
      if (rootsEmpty) {
        // files.ts returns 200 with an empty list + hint when no allowlist is set.
        return Promise.resolve(jsonResponse({ roots: [], hint: "No allowlist roots configured. Set OPENRIG_FILES_ALLOWLIST=..." }, 200));
      }
      return Promise.resolve(jsonResponse({ roots: [{ name: "work", path: "/ws" }] }));
    }
    if (url.includes("/api/files/list")) {
      const u = new URL(url, "http://twin.local");
      const path = u.searchParams.get("path") ?? "";
      return Promise.resolve(jsonResponse({ root: "work", path, entries: TREE[path] ?? [] }));
    }
    // File bodies — served ONLY when a file is opened (never on landing; AC-3 pins this).
    if (url.includes("/api/files/read")) {
      const u = new URL(url, "http://twin.local");
      const path = u.searchParams.get("path") ?? "";
      const content = FILE_BODIES[path];
      if (content == null) return Promise.resolve(jsonResponse({ error: "not found" }, 404));
      return Promise.resolve(jsonResponse({ root: "work", path, absolutePath: `/ws/${path}`, content, mtime: "2026-06-23T22:01:00.000Z", contentHash: "h", size: content.length }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  };
}

// C1 proof contract (docs/reference/sdlc-conventions.md §5) — five valid fields
// (artifact_type in the closed set) + a distinctive body, so the DELIVERED drawer
// render is asserted against real proof content, never a false green.
const GUARD_C1 = [
  "---",
  "slice: slice-15-workspace-ux",
  "candidate_sha: 7d0997dddaab59f43bcc658fe2c0457128a64f53",
  "artifact_type: guard",
  "verdict: PASS",
  "money_evidence: delivered see-all proof/ drill-in opens guard.md in the drawer",
  "---",
  "",
  "# Guard Verdict",
  "",
  "DELIVERED-DRILL-IN-BODY: the proof file opened in the in-app drawer.",
].join("\n");

// Opened-file bodies keyed by slice-relative read path (drawer content).
const FILE_BODIES: Record<string, string> = {
  "missions/release-0.4.1/slices/15-workspace-ux/proof/guard.md": GUARD_C1,
};

function listedPaths(): string[] {
  return calls
    .filter((c) => c.includes("/api/files/list"))
    .map((c) => new URL(c, "http://twin.local").searchParams.get("path") ?? "");
}

function renderNav(scopePath: string | null = "/ws/missions/release-0.4.1", scopeLabel = "release-0.4.1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArtifactsNavigator scopePath={scopePath} scopeLabel={scopeLabel} />
    </QueryClientProvider>,
  );
}

describe("OPR.0.4.1.21 — Artifacts navigator", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    calls = [];
  });
  afterEach(() => cleanup());

  it("AC-1: renders the folder tree (left) + the selected folder's file list (right)", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-navigator")).toBeTruthy());
    expect(screen.getByTestId("artifacts-tree")).toBeTruthy();
    expect(screen.getByTestId("artifacts-file-list")).toBeTruthy();
    // Right pane lists the base folder's FILES (not its dirs); wait for the
    // base /list to resolve before asserting the lazily-rendered tree children.
    await waitFor(() => expect(screen.getByTestId("artifacts-file-row-README.md")).toBeTruthy());
    expect(screen.getByTestId("artifacts-file-row-PROGRESS.md")).toBeTruthy();
    // Tree root expands to show the base folder's subfolders.
    expect(screen.getByTestId("artifacts-tree-folder-missions/release-0.4.1/slices")).toBeTruthy();
  });

  it("AC-2: each file row shows a type badge (from extension), size, and mtime", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-file-row-README.md")).toBeTruthy());
    expect(screen.getByTestId("artifacts-file-badge-README.md").textContent).toBe("MD");
    expect(screen.getByTestId("artifacts-file-size-README.md").textContent).toBe("4.0 KB");
    // mtime sourced from the /list entry (formatted), not fabricated.
    expect(screen.getByTestId("artifacts-file-mtime-README.md").textContent).toMatch(/06-23/);
  });

  it("AC-3: lazy-load boundary — landing fetches only /roots + /list(base); NO file bodies, NO tree pre-walk", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-file-row-README.md")).toBeTruthy());

    // /roots + /list(base) only.
    expect(calls.some((c) => c.includes("/api/files/roots"))).toBe(true);
    expect(listedPaths()).toContain("missions/release-0.4.1");
    // NO file body fetched on landing (the slice-17 over-fetch lesson).
    expect(calls.some((c) => c.includes("/api/files/read"))).toBe(false);
    expect(calls.some((c) => c.includes("/api/files/asset"))).toBe(false);
    // NOT pre-walked: collapsed subfolders are not listed until expanded.
    expect(listedPaths()).not.toContain("missions/release-0.4.1/slices");
  });

  it("AC-3 (expand is lazy): expanding a folder fetches /list for THAT folder only", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-tree-toggle-missions/release-0.4.1/slices")).toBeTruthy());
    expect(listedPaths()).not.toContain("missions/release-0.4.1/slices");

    fireEvent.click(screen.getByTestId("artifacts-tree-toggle-missions/release-0.4.1/slices"));
    await waitFor(() => expect(listedPaths()).toContain("missions/release-0.4.1/slices"));
    // Still no file bodies, and the grandchild slice is not pre-walked.
    expect(calls.some((c) => c.includes("/api/files/read"))).toBe(false);
    expect(listedPaths()).not.toContain("missions/release-0.4.1/slices/15-workspace-ux");
  });

  it("AC-4: altitude scoping — a slice scopePath roots the tree at the slice dir, no sibling slices", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav("/ws/missions/release-0.4.1/slices/15-workspace-ux", "15-workspace-ux");
    await waitFor(() => expect(screen.getByTestId("artifacts-file-row-batch-1.change.diff")).toBeTruthy());
    // Right pane lists the slice's files.
    expect(screen.getByTestId("artifacts-file-badge-batch-1.change.diff").textContent).toBe("DIFF");
    expect(screen.getByTestId("artifacts-file-badge-03-story-dag.intent.png").textContent).toBe("PNG");
    // The tree is rooted at the slice; the base listed is the slice dir, and the
    // sibling slice (09-seat-restore) is never surfaced.
    expect(listedPaths()).toContain("missions/release-0.4.1/slices/15-workspace-ux");
    expect(listedPaths()).not.toContain("missions/release-0.4.1/slices");
    expect(screen.queryByTestId("artifacts-tree-folder-missions/release-0.4.1/slices/09-seat-restore")).toBeNull();
  });

  it("AC-5: no allowlist root configured (503) renders a self-explanatory setup hint", async () => {
    mockFetch.mockImplementation(routeFiles({ rootsStatus: 503 }));
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-navigator-unavailable")).toBeTruthy());
    expect(screen.getByTestId("artifacts-navigator-unavailable").textContent).toMatch(/files root/i);
    // Read-only: never wrote.
    expect(calls.some((c) => c.includes("/api/files/write"))).toBe(false);
  });

  // rev1-r2 regression: the no-allowlist case is NOT a 503 — files.ts returns a
  // 200 with { roots: [], hint }. That must show the SAME setup hint (preferring
  // the daemon's hint), not the misleading "out of scope / no artifacts" state.
  it("AC-5 (empty roots): a 200 roots:[] + hint (no allowlist) renders the setup hint, not 'no artifacts'", async () => {
    mockFetch.mockImplementation(routeFiles({ rootsEmpty: true }));
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-navigator-unavailable")).toBeTruthy());
    // The daemon's own hint is surfaced (the actionable setup instruction).
    expect(screen.getByTestId("artifacts-navigator-unavailable").textContent).toMatch(/OPENRIG_FILES_ALLOWLIST/);
    // NOT the misleading out-of-scope state.
    expect(screen.queryByTestId("artifacts-navigator-no-scope")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // FOUNDER FIX (qitem-20260722234754-e8db7111) — DELIVERED proof/ drill-in leg.
  // The SECOND founder-named site: DELIVERED "see all proof" -> the REAL
  // EvidenceOpener('proof/') folder control -> ArtifactsNavigator scoped to the
  // slice proof/ dir, whose C1 file rows route through FileLink -> the drawer.
  // GREEN preservation: this caller already opens IN-APP, so no production change
  // is needed here — this pins it against regression through the real path.
  // -------------------------------------------------------------------------
  it("DELIVERED preservation: delivered-see-all -> EvidenceOpener('proof/') opens a proof C1 file IN the drawer, not a full-page asset", async () => {
    mockFetch.mockImplementation(routeFiles());
    const ctx: EvidenceContext = {
      root: "work",
      relPath: "missions/release-0.4.1/slices/15-workspace-ux",
      slicePath: "/ws/missions/release-0.4.1/slices/15-workspace-ux",
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DrawerHost>
          <EvidenceOpener evidenceRef="proof/" ctx={ctx} testId="delivered-see-all" />
        </DrawerHost>
      </QueryClientProvider>,
    );
    // pin the exact SPA location + history depth — a raw-asset navigation mutates these.
    const hrefBefore = window.location.href;
    const historyBefore = window.history.length;

    // the DELIVERED "see all proof" folder control is the real founder-named caller.
    const folderBtn = screen.getByTestId("delivered-see-all-folder");
    expect(calls.some((c) => c.includes("/api/files/read"))).toBe(false); // lazy: nothing read yet
    fireEvent.click(folderBtn);

    // the proof/ folder drills into the navigator; its C1 file row is an in-app control.
    const openCtrl = await screen.findByTestId("artifacts-file-open-guard.md");
    expect(openCtrl.closest("a")).toBeNull();
    expect(screen.queryByTestId("file-viewer")).toBeNull();

    fireEvent.click(openCtrl);

    const viewer = await screen.findByTestId("file-viewer");
    // reads the exact slice proof path under the work root — never the /asset escape.
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.includes("/api/files/read") &&
            c.includes("root=work") &&
            c.includes("15-workspace-ux%2Fproof%2Fguard.md"),
        ),
      ).toBe(true),
    );
    expect(calls.some((c) => c.includes("/api/files/asset"))).toBe(false);
    // valid C1 header (five fields) + distinctive body render in the drawer.
    const fm = within(viewer).getByTestId("markdown-frontmatter");
    for (const field of ["slice", "candidate_sha", "artifact_type", "verdict", "money_evidence"]) {
      expect(within(fm).getByText(field)).toBeTruthy();
    }
    expect(within(fm).getByText("guard")).toBeTruthy();
    expect(screen.getByText(/DELIVERED-DRILL-IN-BODY/)).toBeTruthy();

    // close in place — the opener + drilled folder remain; location/history unmoved.
    fireEvent.pointerDown(screen.getByTestId("shared-detail-drawer-outside"));
    await waitFor(() => expect(screen.queryByTestId("file-viewer")).toBeNull());
    expect(screen.getByTestId("delivered-see-all-folder")).toBeTruthy();
    expect(screen.getByTestId("artifacts-file-open-guard.md")).toBeTruthy();
    expect(window.location.href).toBe(hrefBefore);
    expect(window.history.length).toBe(historyBefore);
  });
});

// Minimal real drawer host — mirrors AppShell's DrawerSelection provider +
// SharedDetailDrawer so a FileLink click actually opens the drawer end-to-end.
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

// ---------------------------------------------------------------------------
// PM HALF-PASS (qitem-20260723005752-5ee2eea4): in the proof-directory browser,
// the file HIT TARGET is ONLY the nested FileLink filename button; the row/tree
// WRAPPER surface (the right-pane <li> with badge/size/mtime; the tree-item indent
// <li>) is INERT (no onClick). A user clicking the row/item (PM) gets no
// selection/read/drawer; clicking the exact filename button (QA-local) works. The
// two REDs click the inert wrappers under a REAL drawer host; the GREEN controls
// prove the nested filename buttons still work for BOTH the right and tree paths.
// ---------------------------------------------------------------------------
const PROOF_SCOPE = "/ws/missions/release-0.4.1/slices/15-workspace-ux/proof";
const PROOF_READ_PATH = "missions/release-0.4.1/slices/15-workspace-ux/proof/guard.md";
const TREE_FILE_TID = `artifacts-tree-file-${PROOF_READ_PATH}`;

function renderProofNavInDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DrawerHost>
        <ArtifactsNavigator scopePath={PROOF_SCOPE} scopeLabel="proof" />
      </DrawerHost>
    </QueryClientProvider>,
  );
}

// Assert the guard.md C1 file drawer opened: exact read, one file viewer, five C1
// labels+values, and the distinctive body.
async function assertGuardC1Drawer() {
  await screen.findByTestId("file-viewer");
  // exactly ONE /api/files/read for guard.md — parsed (not substring): pathname
  // /api/files/read, root=work, path EXACTLY the slice-relative proof path.
  await waitFor(() => {
    const guardReads = calls
      .map((c) => new URL(c, "http://nav.local"))
      .filter(
        (u) =>
          u.pathname === "/api/files/read" &&
          u.searchParams.get("root") === "work" &&
          u.searchParams.get("path") === PROOF_READ_PATH,
      );
    expect(guardReads.length).toBe(1);
  });
  // exactly one file viewer opened.
  expect(screen.getAllByTestId("file-viewer").length).toBe(1);
  const fm = within(screen.getByTestId("file-viewer")).getByTestId("markdown-frontmatter");
  const C1: Array<[string, string | RegExp]> = [
    ["slice", "slice-15-workspace-ux"],
    ["candidate_sha", "7d0997dddaab59f43bcc658fe2c0457128a64f53"],
    ["artifact_type", "guard"],
    ["verdict", "PASS"],
    ["money_evidence", /delivered see-all proof/],
  ];
  for (const [k, v] of C1) {
    expect(within(fm).getByText(k)).toBeTruthy();
    expect(within(fm).getByText(v)).toBeTruthy();
  }
  expect(screen.getByText(/DELIVERED-DRILL-IN-BODY/)).toBeTruthy();
}

describe("Artifacts navigator — proof-file hit target (PM half-pass 5ee2eea4)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(routeFiles());
    calls = [];
  });
  afterEach(() => cleanup());

  it("R-right (RED): clicking a REAL inert visible right-row child (the size cell, not artifacts-file-open) opens the file drawer with C1", async () => {
    renderProofNavInDrawer();
    await screen.findByTestId("artifacts-file-row-guard.md");
    // a real visible row child a user targets — currently a sibling of the filename
    // button, so inert. Wrapping ALL row content in the FileLink makes this green
    // (the click bubbles to the button); it is NOT a synthetic wrapper click.
    const sizeCell = screen.getByTestId("artifacts-file-size-guard.md");
    expect(calls.some((c) => c.includes("/api/files/read"))).toBe(false);
    expect(screen.queryByTestId("file-viewer")).toBeNull();
    const hrefBefore = window.location.href;
    const historyBefore = window.history.length;
    fireEvent.click(sizeCell);
    await assertGuardC1Drawer();
    // in-app: no navigation.
    expect(window.location.href).toBe(hrefBefore);
    expect(window.history.length).toBe(historyBefore);
  });

  it("R-tree (RED, structural hitbox): the noninteractive <li> owns no indentation; the artifacts-tree-file button owns the depth indentation + full-width hit area", async () => {
    renderProofNavInDrawer();
    // artifacts-tree-file-* IS the working FileLink button (see the GREEN control
    // below); this RED pins the HITBOX STRUCTURE, not a synthetic li click.
    const treeBtn = await screen.findByTestId(TREE_FILE_TID);
    const treeLi = treeBtn.closest("li");
    expect(treeLi).toBeTruthy();
    // DESIRED: the noninteractive wrapper <li> carries NO indentation padding...
    expect(treeLi!.style.paddingLeft).toBe("");
    // ...and the interactive FileLink button owns the depth indentation + full width,
    // so the whole indented row (not just the filename glyphs) is a real hit target.
    expect(treeBtn.style.paddingLeft).not.toBe("");
    expect(treeBtn.className).toContain("w-full");
  });

  it("GREEN control (right): clicking the nested right-pane filename button opens the file drawer with C1", async () => {
    renderProofNavInDrawer();
    const btn = await screen.findByTestId("artifacts-file-open-guard.md");
    expect(screen.queryByTestId("file-viewer")).toBeNull();
    fireEvent.click(btn);
    await assertGuardC1Drawer();
  });

  it("GREEN control (tree): clicking the nested tree filename button opens the file drawer with C1", async () => {
    renderProofNavInDrawer();
    const btn = await screen.findByTestId(TREE_FILE_TID);
    expect(screen.queryByTestId("file-viewer")).toBeNull();
    fireEvent.click(btn);
    await assertGuardC1Drawer();
  });
});
