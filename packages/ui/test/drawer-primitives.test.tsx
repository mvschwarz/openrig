// V1 attempt-3 Phase 4 — drawer primitives reachability proof (ritual #6).
//
// Phase 4 P4-2 site-of-use trigger wiring DEFERRED to Phase 5; with no live
// consumers, the 4 viewers + 4 triggers need a minimum unit-level proof so
// regressions can't slip in unnoticed. Coverage:
//
// - Each viewer renders without crashing when given canonical-shape props.
// - Each trigger fires setSelection on click with the correct DrawerSelection
//   discriminator (`type: "qitem" | "file" | "sub-spec"`) and the matching
//   payload.
// - SharedDetailDrawer routes selection.type to the correct viewer component.
//
// V1 polish slice Phase 5.1 P5.1-D2: SeatDetailViewer + SeatDetailTrigger
// RETIRED. seat-detail navigation goes to /topology/seat/$rigId/$logicalId
// center page (LiveNodeDetails). The 'seat-detail' kind is dropped from
// DrawerSelection union; this file now covers only the 3 remaining
// drawer surfaces (qitem / file / sub-spec). The retirement-regression
// guard lives in test/node-selection-migration.test.tsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import {
  DrawerSelectionContext,
  type DrawerSelection,
} from "../src/components/AppShell.js";
import { QueueItemViewer } from "../src/components/drawer-viewers/QueueItemViewer.js";
import { FileViewer } from "../src/components/drawer-viewers/FileViewer.js";
import { SubSpecPreview } from "../src/components/drawer-viewers/SubSpecPreview.js";
import { QueueItemTrigger } from "../src/components/drawer-triggers/QueueItemTrigger.js";
import { FileReferenceTrigger } from "../src/components/drawer-triggers/FileReferenceTrigger.js";
import { SubSpecTrigger } from "../src/components/drawer-triggers/SubSpecTrigger.js";
import { SharedDetailDrawer } from "../src/components/SharedDetailDrawer.js";

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Viewers — render-without-crash with canonical-shape props
// ---------------------------------------------------------------------------

describe("Drawer viewers (P4-1) render with canonical props", () => {
  it("QueueItemViewer renders header + body preview given canonical qitem shape", () => {
    const { getByTestId } = render(
      <QueueItemViewer
        qitemId="qitem-20260506-test"
        source="orch-lead@openrig-velocity"
        destination="redo3-driver-3@openrig-velocity"
        state="pending"
        tags={["code-review"]}
        createdAt="2026-05-06T18:00:00Z"
        body={"line 1\nline 2\nline 3"}
        related={[{ kind: "file", label: "review-notes.md", href: "/files/review-notes.md" }]}
      />,
    );
    expect(getByTestId("queue-item-viewer")).toBeTruthy();
    expect(getByTestId("qitem-body").textContent).toContain("line 1");
  });

  it("QueueItemViewer empty-state when no qitemId", () => {
    const { getByTestId } = render(<QueueItemViewer qitemId="" />);
    expect(getByTestId("queue-item-viewer-empty")).toBeTruthy();
  });

  it("FileViewer renders markdown content when kind=markdown + content present", () => {
    const { getByTestId } = render(
      <FileViewer path="docs/guide.md" kind="markdown" content="# Hello" />,
    );
    const root = getByTestId("file-viewer");
    expect(root.getAttribute("data-file-kind")).toBe("markdown");
  });

  it("FileViewer infers kind from path extension when kind omitted", () => {
    const { getByTestId } = render(
      <FileViewer path="config/agent.yaml" content="name: test" />,
    );
    expect(getByTestId("file-viewer").getAttribute("data-file-kind")).toBe("yaml");
  });

  it("FileViewer empty-state when no content/imageUrl and not binary", () => {
    const { getByTestId } = render(<FileViewer path="missing.md" kind="markdown" />);
    expect(getByTestId("file-viewer-empty")).toBeTruthy();
  });

  it("FileViewer reads drawer content from an explicit /api/files root + path", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("/api/files/read?root=workspace&path=docs%2Frole.md");
      return {
        ok: true,
        json: async () => ({
          root: "workspace",
          path: "docs/role.md",
          absolutePath: "/workspace/docs/role.md",
          content: "# Role\nLoaded from files API.",
          mtime: "2026-05-07T00:00:00.000Z",
          contentHash: "hash",
          size: 29,
          truncated: false,
          truncatedAtBytes: null,
          totalBytes: 29,
        }),
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderWithQuery(
      <FileViewer path="role.md" kind="markdown" root="workspace" readPath="docs/role.md" />,
    );

    expect(await screen.findByTestId("file-viewer")).toBeTruthy();
    expect(screen.getByText(/Loaded from files API/)).toBeTruthy();
    expect(screen.getByTestId("file-viewer-root-path").textContent).toBe("workspace/docs/role.md");
  });

  it("FileViewer resolves an absolute file path against /api/files roots", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/files/roots") {
        return {
          ok: true,
          json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }),
        };
      }
      expect(url).toBe("/api/files/read?root=workspace&path=agents%2Frole.md");
      return {
        ok: true,
        json: async () => ({
          root: "workspace",
          path: "agents/role.md",
          absolutePath: "/workspace/agents/role.md",
          content: "# Agent Role",
          mtime: "2026-05-07T00:00:00.000Z",
          contentHash: "hash",
          size: 12,
          truncated: false,
          truncatedAtBytes: null,
          totalBytes: 12,
        }),
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderWithQuery(
      <FileViewer path="role.md" kind="markdown" absolutePath="/workspace/agents/role.md" />,
    );

    expect(await screen.findByTestId("file-viewer")).toBeTruthy();
    expect(screen.getByText(/Agent Role/)).toBeTruthy();
    expect(screen.getByTestId("file-viewer-root-path").textContent).toBe("workspace/agents/role.md");
  });

  it("SubSpecPreview renders header + manifest excerpt; no Link when entryId omitted", () => {
    const { getByTestId, queryByTestId } = render(
      <SubSpecPreview
        specKind="rig"
        specName="openrig-velocity"
        version="0.2.0"
        source="builtin"
        manifestExcerpt="name: openrig-velocity\nversion: 0.2.0"
      />,
    );
    expect(getByTestId("sub-spec-preview")).toBeTruthy();
    // entryId omitted → no open-in-center Link rendered (avoids router context dep).
    expect(queryByTestId("sub-spec-open-center")).toBeNull();
  });

  // V1 polish slice Phase 5.1 P5.1-D2: SeatDetailViewer RETIRED.
  // Negative-assertion guard lives in test/node-selection-migration.test.tsx.
});

// ---------------------------------------------------------------------------
// Triggers — click → setSelection with correct DrawerSelection shape
// ---------------------------------------------------------------------------

function renderWithDrawerCtx(
  ui: React.ReactNode,
): { setSelection: ReturnType<typeof vi.fn> } & ReturnType<typeof render> {
  const setSelection = vi.fn();
  const utils = render(
    <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
      {ui}
    </DrawerSelectionContext.Provider>,
  );
  return { setSelection, ...utils };
}

describe("Drawer triggers (P4-2) fire setSelection with correct kind on click", () => {
  it("QueueItemTrigger click → setSelection({ type: 'qitem', data })", () => {
    const data = { qitemId: "qitem-T", body: "preview" };
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <QueueItemTrigger data={data}>open</QueueItemTrigger>,
    );
    fireEvent.click(getByTestId("queue-item-trigger"));
    expect(setSelection).toHaveBeenCalledOnce();
    expect(setSelection).toHaveBeenCalledWith({ type: "qitem", data });
  });

  it("FileReferenceTrigger click → setSelection({ type: 'file', data })", () => {
    const data = { path: "notes.md", kind: "markdown" as const, content: "# h" };
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <FileReferenceTrigger data={data}>open</FileReferenceTrigger>,
    );
    fireEvent.click(getByTestId("file-reference-trigger"));
    expect(setSelection).toHaveBeenCalledWith({ type: "file", data });
  });

  it("SubSpecTrigger click → setSelection({ type: 'sub-spec', data })", () => {
    const data = { specKind: "rig", specName: "openrig-velocity" };
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <SubSpecTrigger data={data}>open</SubSpecTrigger>,
    );
    fireEvent.click(getByTestId("sub-spec-trigger"));
    expect(setSelection).toHaveBeenCalledWith({ type: "sub-spec", data });
  });

  // V1 polish slice Phase 5.1 P5.1-D2: SeatDetailTrigger RETIRED. Click
  // contract for the (now-deleted) primitive is guarded as a
  // file-doesn't-exist negative-assertion in node-selection-migration.test.tsx.

  it("trigger custom testId override is respected (predicate-consistency probe)", () => {
    const data = { qitemId: "q", body: "b" };
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <QueueItemTrigger data={data} testId="custom-q-trigger">x</QueueItemTrigger>,
    );
    fireEvent.click(getByTestId("custom-q-trigger"));
    expect(setSelection).toHaveBeenCalledWith({ type: "qitem", data });
  });
});

// ---------------------------------------------------------------------------
// SharedDetailDrawer routing — selection.type → correct viewer component
// ---------------------------------------------------------------------------

const NOOP_PROPS = {
  events: [],
  selectedDiscoveredId: null as string | null,
  onSelectDiscoveredId: () => {},
  placementTarget: null,
  onClearPlacement: () => {},
};

describe("SharedDetailDrawer (Phase 4) routes selection.type to the correct viewer", () => {
  it("selection=null renders nothing (default-closed contract — SC-6)", () => {
    const { container } = render(
      <SharedDetailDrawer selection={null} onClose={() => {}} {...NOOP_PROPS} />,
    );
    expect(container.querySelector("[data-testid='shared-detail-drawer']")).toBeNull();
  });

  it("selection.type='qitem' → QueueItemViewer mounts in drawer", () => {
    const selection: DrawerSelection = {
      type: "qitem",
      data: { qitemId: "qitem-routing-test", body: "x" },
    };
    const { getByTestId } = render(
      <SharedDetailDrawer selection={selection} onClose={() => {}} {...NOOP_PROPS} />,
    );
    expect(getByTestId("queue-item-viewer")).toBeTruthy();
  });

  it("selection.type='file' → FileViewer mounts in drawer", () => {
    const selection: DrawerSelection = {
      type: "file",
      data: { path: "x.md", kind: "markdown", content: "# h" },
    };
    const { getByTestId } = render(
      <SharedDetailDrawer selection={selection} onClose={() => {}} {...NOOP_PROPS} />,
    );
    expect(getByTestId("file-viewer")).toBeTruthy();
  });

  it("selection.type='sub-spec' → SubSpecPreview mounts in drawer", () => {
    const selection: DrawerSelection = {
      type: "sub-spec",
      data: { specKind: "rig", specName: "openrig-velocity" },
    };
    const { getByTestId } = render(
      <SharedDetailDrawer selection={selection} onClose={() => {}} {...NOOP_PROPS} />,
    );
    expect(getByTestId("sub-spec-preview")).toBeTruthy();
  });

  // V1 polish slice Phase 5.1 P5.1-D2: 'seat-detail' kind RETIRED from
  // DrawerSelection union; navigation to /topology/seat/$rigId/$logicalId
  // center page (LiveNodeDetails) replaces the drawer-mounted variant.
  // Routing-by-type test for 'seat-detail' is gone with the kind itself.
});
