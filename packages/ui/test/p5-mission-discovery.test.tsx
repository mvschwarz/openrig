// V1 attempt-3 Phase 5 P5-5 + P5-6 — filesystem-based mission discovery +
// MissionStatusBadge live PROGRESS.md fetch.
//
// Both features ride on the existing /api/files/list + /api/files/read
// daemon routes (no new daemon endpoints; SC-29 honored). When the
// allowlist doesn't expose workspace.root, the tree falls back to the
// legacy railItem-grouped slice listing — also tested here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { parseMissionStatus } from "../src/components/MissionStatusBadge.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

// -----------------------------------------------------------------------
// parseMissionStatus — unit-level (Phase 3 already covered most paths;
// adding a few P5-6 path-specific cases for invariant guard).
// -----------------------------------------------------------------------

describe("parseMissionStatus (P5-6 invariants)", () => {
  it("parses status:active from PROGRESS.md frontmatter", () => {
    expect(
      parseMissionStatus("---\nname: Mission X\nstatus: active\n---\n# body"),
    ).toBe("active");
  });

  it("parses status:shipped variants", () => {
    expect(parseMissionStatus("---\nstatus: shipped\n---")).toBe("shipped");
    expect(parseMissionStatus("---\nstatus: complete\n---")).toBe("shipped");
    expect(parseMissionStatus("---\nstatus: completed\n---")).toBe("shipped");
    expect(parseMissionStatus("---\nstatus: done\n---")).toBe("shipped");
  });

  it("parses status:blocked variants", () => {
    expect(parseMissionStatus("---\nstatus: blocked\n---")).toBe("blocked");
    expect(parseMissionStatus("---\nstatus: stalled\n---")).toBe("blocked");
  });

  it("returns 'unknown' on missing/empty/malformed input", () => {
    expect(parseMissionStatus(null)).toBe("unknown");
    expect(parseMissionStatus(undefined)).toBe("unknown");
    expect(parseMissionStatus("")).toBe("unknown");
    expect(parseMissionStatus("# no frontmatter")).toBe("unknown");
    expect(parseMissionStatus("---\nfoo: bar\n---")).toBe("unknown");
  });
});

// -----------------------------------------------------------------------
// useMissionDiscovery — integration via ProjectTreeView (the real consumer).
// -----------------------------------------------------------------------

import { ProjectTreeView } from "../src/components/project/ProjectTreeView.js";

interface RenderTreeOpts {
  // Settings response: workspace.root absolute path. Pass null to render
  // the unset/unreachable empty-state.
  workspaceRoot: string | null;
  settingsAvailable?: boolean;
  // Files API mocks.
  roots: Array<{ name: string; path: string }>;
  // Map "<root>:<path>" → directory entries.
  listings?: Record<string, Array<{ name: string; type: "dir" | "file" }>>;
  // Map "<root>:<path>" → file content.
  reads?: Record<string, { content: string; mtime?: string }>;
  // useSlices response.
  slices?: Array<{ name: string; missionId?: string | null; displayName: string; railItem: string | null; status: string; rawStatus: string | null; qitemCount: number; hasProofPacket: boolean; lastActivityAt: string | null }>;
}

function setupFetch(opts: RenderTreeOpts) {
  mockFetch.mockImplementation(async (url: string) => {
    // /api/config (settings)
    if (url.includes("/api/config")) {
      if (opts.settingsAvailable === false) {
        return new Response("not implemented", { status: 404 });
      }
      const settings: Record<string, { value: unknown }> = {};
      if (opts.workspaceRoot !== null) {
        settings["workspace.root"] = { value: opts.workspaceRoot };
      }
      return new Response(JSON.stringify({ settings }), { status: 200 });
    }
    // /api/files/roots
    if (url.includes("/api/files/roots")) {
      return new Response(JSON.stringify({ roots: opts.roots }), { status: 200 });
    }
    // /api/files/list?root=<name>&path=<rel>
    if (url.includes("/api/files/list")) {
      const u = new URL(url, "http://localhost");
      const root = u.searchParams.get("root") ?? "";
      const path = u.searchParams.get("path") ?? "";
      const key = `${root}:${path}`;
      const entries = opts.listings?.[key] ?? [];
      return new Response(
        JSON.stringify({ root, path, entries: entries.map((e) => ({ ...e, size: null, mtime: null })) }),
        { status: 200 },
      );
    }
    // /api/files/read?root=<name>&path=<rel>
    if (url.includes("/api/files/read")) {
      const u = new URL(url, "http://localhost");
      const root = u.searchParams.get("root") ?? "";
      const path = u.searchParams.get("path") ?? "";
      const key = `${root}:${path}`;
      const data = opts.reads?.[key];
      if (!data) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({
          root,
          path,
          absolutePath: `/${root}/${path}`,
          content: data.content,
          mtime: data.mtime ?? "2026-05-06T18:00:00Z",
          contentHash: "deadbeef",
          size: data.content.length,
        }),
        { status: 200 },
      );
    }
    // /api/slices?filter=...
    if (url.includes("/api/slices")) {
      return new Response(
        JSON.stringify({
          slices: opts.slices ?? [],
          totalCount: opts.slices?.length ?? 0,
          filter: "all",
        }),
        { status: 200 },
      );
    }
    return new Response("[]");
  });
}

function renderTree(opts: RenderTreeOpts): ReturnType<typeof render> {
  setupFetch(opts);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <ProjectTreeView />,
  });
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("ProjectTreeView P5-5/P5-6 mission discovery", () => {
  it("filesystem-discovered missions surface as tree nodes when allowlist exposes workspace root", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [{ name: "workspace", path: "/Users/admin/.openrig/workspace" }],
      listings: {
        "workspace:missions": [
          { name: "release-readiness", type: "dir" },
          { name: "shell-redesign-v1", type: "dir" },
          { name: "README.md", type: "file" }, // file → filtered out
        ],
      },
      reads: {
        "workspace:missions/release-readiness/PROGRESS.md": {
          content: "---\nstatus: active\n---\n# Release readiness",
        },
        "workspace:missions/shell-redesign-v1/PROGRESS.md": {
          content: "---\nstatus: shipped\n---\n# Shell V1",
        },
      },
      slices: [],
    });
    expect(await findByTestId("project-mission-release-readiness")).toBeTruthy();
    expect((await findByTestId("project-mission-link-release-readiness")).getAttribute("href")).toBe("/project/mission/release-readiness");
    expect(await findByTestId("project-mission-shell-redesign-v1")).toBeTruthy();
  });

  it("file-type entries under missions/ are not surfaced as missions", async () => {
    const { findByTestId, queryByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [{ name: "workspace", path: "/Users/admin/.openrig/workspace" }],
      listings: {
        "workspace:missions": [
          { name: "release-readiness", type: "dir" },
          { name: "README.md", type: "file" },
        ],
      },
      slices: [],
    });
    await findByTestId("project-mission-release-readiness");
    expect(queryByTestId("project-mission-README.md")).toBeNull();
  });

  it("falls back to indexed slice grouping when no allowlist root contains workspace.root", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [{ name: "elsewhere", path: "/Users/admin/code/elsewhere" }],
      slices: [
        {
          name: "slice-a",
          displayName: "Slice A",
          railItem: "release-readiness",
          status: "active",
          rawStatus: "active",
          qitemCount: 1,
          hasProofPacket: false,
          lastActivityAt: null,
        },
      ],
    });
    expect(await findByTestId("project-discovery-degraded")).toBeTruthy();
    expect(await findByTestId("project-mission-release-readiness")).toBeTruthy();
  });

  it("falls back to indexed slice grouping when allowlist is empty", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [],
      slices: [
        {
          name: "slice-x",
          displayName: "Slice X",
          railItem: null,
          status: "active",
          rawStatus: "active",
          qitemCount: 1,
          hasProofPacket: false,
          lastActivityAt: null,
        },
      ],
    });
    expect(await findByTestId("project-discovery-degraded")).toBeTruthy();
    expect(await findByTestId("project-mission-unsorted")).toBeTruthy();
  });

  it("separates live qitem-backed work from stale archived seed slices", async () => {
    const { findByTestId, queryByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [],
      slices: [
        {
          name: "idea-ledger",
          displayName: "Idea Ledger release proof slice",
          railItem: "RELEASE-PROOF",
          status: "done",
          rawStatus: "done",
          qitemCount: 78,
          hasProofPacket: false,
          lastActivityAt: "2026-05-07T22:06:36.083Z",
        },
        {
          name: "seed-slice-active",
          displayName: "seed-slice-active",
          railItem: null,
          status: "active",
          rawStatus: "active",
          qitemCount: 0,
          hasProofPacket: false,
          lastActivityAt: "2000-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(await findByTestId("project-discovery-degraded")).toBeTruthy();
    expect((await findByTestId("project-mission-section-current")).textContent).toContain(
      "Current Work · 1",
    );
    expect((await findByTestId("project-mission-section-archive")).textContent).toContain(
      "Archive · 1",
    );

    const liveMission = await findByTestId("project-mission-RELEASE-PROOF");
    expect(liveMission.getAttribute("data-mission-bucket")).toBe("current");
    expect((await findByTestId("project-slice-idea-ledger-meta")).textContent).toContain(
      "78 qitems",
    );

    const archiveMission = await findByTestId("project-mission-unsorted");
    expect(archiveMission.getAttribute("data-mission-bucket")).toBe("archive");
    expect(queryByTestId("project-slice-seed-slice-active")).toBeNull();
  });

  // Slice 19: list-density collapse. Slice items in the Project tree
  // are single-row (flex layout) with the meta inline + a `title`
  // attribute + `aria-label` carrying the full readable content for
  // screen readers and hover discovery. HG-1/2/3/5 of slice 19's
  // density audit applies here.
  it("slice 19: project tree slice items render single-row with meta inline + a11y attributes", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/example/workspace",
      slices: [
        {
          name: "density-slice",
          mission: "release-proof",
          slicePath: "/Users/example/workspace/missions/release-proof/slices/density-slice",
          missionPath: "/Users/example/workspace/missions/release-proof",
          status: "active",
          rawStatus: "active",
          qitemCount: 42,
          hasProofPacket: true,
          lastActivityAt: "2030-01-01T00:00:00.000Z",
        },
      ],
    });

    const sliceLink = await findByTestId("project-slice-density-slice");
    // HG-1: single-row flex layout (not stacked `block` spans).
    expect(sliceLink.className).toMatch(/\bflex\b/);
    expect(sliceLink.className).not.toMatch(/\bblock\b/);
    // HG-3 + HG-5: meta content preserved in DOM via testid AND
    // accessible via title + aria-label for hover + screen readers.
    expect(sliceLink.getAttribute("title")).toContain("42 qitems");
    expect(sliceLink.getAttribute("aria-label")).toContain("42 qitems");
    const meta = await findByTestId("project-slice-density-slice-meta");
    // Meta still present but now flows inline (shrink-0, not block).
    expect(meta.className).toMatch(/\bshrink-0\b/);
    expect(meta.className).not.toMatch(/\bblock\b/);
    expect(meta.textContent).toContain("42 qitems");
    expect(meta.textContent).toContain("proof");
  });

  it("workspace.root unconfigured renders the no-workspace empty-state (Phase 3 A5 behavior preserved)", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: null,
      roots: [],
      slices: [],
    });
    expect(await findByTestId("project-no-workspace")).toBeTruthy();
  });

  it("matches slices to filesystem missions by missionId first; unmatched mission keys stay reachable", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [{ name: "workspace", path: "/Users/admin/.openrig/workspace" }],
      listings: {
        "workspace:missions": [{ name: "release-readiness", type: "dir" }],
      },
      reads: {
        "workspace:missions/release-readiness/PROGRESS.md": { content: "---\nstatus: active\n---" },
      },
      slices: [
        {
          name: "slice-release",
          missionId: "release-readiness",
          displayName: "Release Slice",
          railItem: null,
          status: "active",
          rawStatus: "active",
          qitemCount: 0,
          hasProofPacket: false,
          lastActivityAt: null,
        },
        {
          name: "slice-orphan",
          displayName: "Orphan Slice",
          railItem: "no-such-mission",
          status: "active",
          rawStatus: "active",
          qitemCount: 0,
          hasProofPacket: false,
          lastActivityAt: null,
        },
      ],
    });
    expect(await findByTestId("project-mission-release-readiness")).toBeTruthy();
    expect(await findByTestId("project-mission-no-such-mission")).toBeTruthy();
  });

  it("preserves unmatched legacy rail groups when filesystem missions are available", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [{ name: "workspace", path: "/Users/admin/.openrig/workspace" }],
      listings: {
        "workspace:missions": [{ name: "demo-seed", type: "dir" }],
      },
      reads: {
        "workspace:missions/demo-seed/PROGRESS.md": { content: "---\nstatus: active\n---" },
      },
      slices: [
        {
          name: "idea-ledger-find-ideas-cycle-4",
          missionId: "demo-seed",
          displayName: "Find Ideas Cycle 4",
          railItem: null,
          status: "active",
          rawStatus: "active",
          qitemCount: 1,
          hasProofPacket: false,
          lastActivityAt: "2026-05-08T00:00:00.000Z",
        },
        {
          name: "idea-ledger",
          displayName: "Idea Ledger release proof slice",
          railItem: "RELEASE-PROOF",
          status: "done",
          rawStatus: "done",
          qitemCount: 78,
          hasProofPacket: false,
          lastActivityAt: "2026-05-07T22:06:36.083Z",
        },
        {
          name: "seed-slice-active",
          displayName: "seed-slice-active",
          railItem: null,
          status: "active",
          rawStatus: "active",
          qitemCount: 0,
          hasProofPacket: false,
          lastActivityAt: "2000-01-01T00:00:00.000Z",
        },
      ],
    });

    expect((await findByTestId("project-mission-section-current")).textContent).toContain(
      "Current Work · 2",
    );
    expect((await findByTestId("project-mission-section-archive")).textContent).toContain(
      "Archive · 1",
    );
    expect(await findByTestId("project-slice-idea-ledger-find-ideas-cycle-4")).toBeTruthy();
    expect((await findByTestId("project-mission-demo-seed")).getAttribute("data-mission-bucket")).toBe("current");
    expect((await findByTestId("project-mission-RELEASE-PROOF")).getAttribute("data-mission-bucket")).toBe("current");
    expect((await findByTestId("project-mission-unsorted")).getAttribute("data-mission-bucket")).toBe("archive");
  });
});
