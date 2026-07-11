// VM-005 (release-0.4.7) — TIER A: the DIFFERENTIAL suite at the observable
// (ARCH-RULING-b3-differential-test-architecture-2026-07-11, sha 632ff319…).
//
// Imports ONLY both-ends surfaces (components + DOM harness + router/query).
// Assertions are the CANDIDATE contract values VERBATIM (PRD observables);
// at base 8757593f they fail as NAMED expected/received (the chip renders
// "active"/"unknown" where "complete"/"idle"/"draft" is expected). ONE code
// path — no branch-on-symbol anywhere (ruling P1). V5 vectors pass at BOTH
// ends from these same files.
//
// Vectors: V1 authored-wins (tree + portfolio) · V2 idle-not-unknown ·
// V3 all-draft→draft · V4 no-decay across a clock jump (authored stable;
// derived moves active→idle, never to the retired word) · V5 byte-identity
// (derived corpora render identically at both ends).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { ProjectTreeView } from "../src/components/project/ProjectTreeView.js";
import { WorkspacePortfolioPanel } from "../src/components/project/WorkspacePortfolioPanel.js";
import { WorkspaceScopePage } from "../src/components/project/ScopePages.js";
import { buildStorytellingFeedItems } from "../src/components/feed/cards/storytelling-cards.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => mockFetch.mockReset());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type SliceRowFixture = {
  name: string;
  missionId: string | null;
  displayName: string;
  railItem: string | null;
  status: string;
  rawStatus: string | null;
  qitemCount: number;
  hasProofPacket: boolean;
  lastActivityAt: string | null;
};

function sliceRow(over: Partial<SliceRowFixture>): SliceRowFixture {
  return {
    name: "s1",
    missionId: "m1",
    displayName: "S1",
    railItem: null,
    status: "active",
    rawStatus: null,
    qitemCount: 0,
    hasProofPacket: false,
    lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

function setupFetch(opts: {
  slices: SliceRowFixture[];
  missions?: Record<string, { authoredStatus: string | null }>;
}) {
  // Harness robustness: fetch may be invoked with a Request/URL object (or a
  // transitive caller passing undefined) — coerce to a string before routing.
  // Mechanics only; assertion strength unchanged.
  mockFetch.mockImplementation(async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input ?? "");
    if (url.includes("/api/hosts")) {
      return new Response(
        JSON.stringify({ ownName: "localhost", selected: "local", hosts: [] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/config")) {
      return new Response(
        JSON.stringify({
          settings: {
            "workspace.name": { value: "testws" },
            "workspace.root": { value: "/ws" },
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/files/roots")) {
      return new Response(JSON.stringify({ roots: [] }), { status: 200 });
    }
    if (url.includes("/api/slices")) {
      return new Response(
        JSON.stringify({
          slices: opts.slices,
          totalCount: opts.slices.length,
          filter: "all",
          missions: opts.missions ?? {},
        }),
        { status: 200 },
      );
    }
    return new Response("[]");
  });
}

function mount(node: React.ReactNode): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{node}</>,
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

const WINDOW_MS = 36 * 60 * 60 * 1000; // PROJECT_CURRENT_ACTIVITY_WINDOW_MS (literal: no lib import needed)

describe("V1 — authored-when-present wins at the observable (FR-1)", () => {
  it("tree chip renders the authored word 'complete' over a recently-active slice", async () => {
    setupFetch({
      slices: [sliceRow({ missionId: "relx", name: "target" })],
      missions: { relx: { authoredStatus: "complete" } },
    });
    const { findByTestId } = mount(<ProjectTreeView />);
    const badge = await findByTestId("project-mission-relx-badge");
    expect(badge.textContent).toContain("complete");
    // Q1 Option A: zero PROGRESS.md status reads — the live override is retired.
    const fileReads = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/files/read"));
    expect(fileReads).toEqual([]);
  });

  it("portfolio badge renders the authored word", async () => {
    setupFetch({
      slices: [sliceRow({ missionId: "relx", name: "target" })],
      missions: { relx: { authoredStatus: "complete" } },
    });
    const { findByText } = mount(<WorkspacePortfolioPanel />);
    expect(await findByText("complete")).toBeTruthy();
  });

  it("the workspace OVERVIEW tab renders the authored word; FR-4 buckets it under ARCHIVE in the tree", async () => {
    // GROUNDED (fallback-run finding): WorkspaceOverviewPanel is an ORPHAN —
    // ScopePages:744 renders WorkspacePortfolioPanel on the overview tab
    // ("Supersedes the prior WorkspaceOverviewPanel mission grid"). The REAL
    // overview observable is the portfolio row inside WorkspaceScopePage;
    // the FR-4 bucket observable is the tree's Current/Archive sections.
    setupFetch({
      slices: [sliceRow({ missionId: "relx", name: "target" })],
      missions: { relx: { authoredStatus: "complete" } },
    });
    const page = mount(<WorkspaceScopePage />);
    await page.findByTestId("portfolio-open-relx"); // the overview-tab surface exists
    expect(await page.findByText("complete")).toBeTruthy(); // authored word renders
    page.unmount();

    setupFetch({
      slices: [sliceRow({ missionId: "relx", name: "target" })],
      missions: { relx: { authoredStatus: "complete" } },
    });
    const tree = mount(<ProjectTreeView />);
    await tree.findByTestId("project-mission-relx"); // the mission node exists
    // The section testid is the header <li>; missions render as siblings —
    // the bucket observable is the header COUNT (base: "Archive · 0").
    const archive = await tree.findByTestId("project-mission-section-archive");
    expect(archive.textContent).toContain("Archive · 1");
    tree.unmount();
  });

  it("storytelling complete-and-hide agrees: the authored-complete mission is filtered from the band", () => {
    // C8 reads the RAW authored word (both-ends surface, byte-unchanged);
    // this pins the V1 fixture's storytelling cell of the matrix.
    const items = buildStorytellingFeedItems(
      [{ name: "relx", path: "/ws/missions/relx", status: "complete" }],
      [],
    );
    expect(items.some((i) => JSON.stringify(i).includes("relx"))).toBe(false);
  });

  // Mission DETAIL cell (plan §C-v reachability): the detail page renders NO
  // mission-status chip at all (grep-verified: MissionScopePage renders
  // per-slice chips only) — the detail surface's status observable is the
  // GET /api/missions/:id payload carrying the RAW authored word (C7,
  // byte-unchanged; pinned by the daemon lockstep test + missions-routes
  // suite in the proof bar). The matrix marks the detail DOM cell N/A per
  // §C-v rather than pretending a chip exists.
});

describe("V2 — honest known states at the observable (FR-2)", () => {
  it("an aged-out mission with no authored status renders 'idle', never the retired word", async () => {
    const stale = new Date(Date.now() - WINDOW_MS - 4 * 60 * 60 * 1000).toISOString();
    setupFetch({
      slices: [sliceRow({ missionId: "sleepy", name: "old-slice", lastActivityAt: stale })],
      missions: {},
    });
    const { findByTestId } = mount(<ProjectTreeView />);
    const badge = await findByTestId("project-mission-sleepy-badge");
    expect(badge.textContent).toContain("idle");
    expect(badge.textContent).not.toContain("unknown");
  });
});

describe("V3 — an all-draft mission reads 'draft', not active (Q2 / FR-3)", () => {
  it("fresh scaffolded drafts with recent activity render the draft chip", async () => {
    setupFetch({
      slices: [
        sliceRow({ missionId: "fresh", name: "d1", status: "draft" }),
        sliceRow({ missionId: "fresh", name: "d2", status: "draft" }),
      ],
      missions: {},
    });
    const { findByTestId } = mount(<ProjectTreeView />);
    const badge = await findByTestId("project-mission-fresh-badge");
    expect(badge.textContent).toContain("draft");
  });
});

describe("V4 — no clock decay at the observable (FR-2)", () => {
  it("an AUTHORED chip is byte-stable across a clock jump; a DERIVED chip moves active→idle (never the retired word)", async () => {
    // t0: authored mission + derived mission, both with a recent slice.
    // NO value assertion before the jump — the boundary is crossed FIRST so
    // the base RED is the ruled V4 clock differential, not a V1 repeat
    // (guard recheck R4). t0 texts are CAPTURED for the stability compare.
    const recent = new Date(Date.now() - 60_000).toISOString();
    setupFetch({
      slices: [
        sliceRow({ missionId: "auth", name: "a1", lastActivityAt: recent }),
        sliceRow({ missionId: "derv", name: "d1", lastActivityAt: recent }),
      ],
      missions: { auth: { authoredStatus: "complete" } },
    });
    const first = mount(<ProjectTreeView />);
    const t0Auth = (await first.findByTestId("project-mission-auth-badge")).textContent;
    const t0Derv = (await first.findByTestId("project-mission-derv-badge")).textContent;
    expect(t0Derv).toContain("active"); // both-ends true at t0 (base derives active too)
    first.unmount();

    // Cross the boundary: jump the wall clock far past the recency window;
    // fresh mount, identical data.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + WINDOW_MS * 10);
    setupFetch({
      slices: [
        sliceRow({ missionId: "auth", name: "a1", lastActivityAt: recent }),
        sliceRow({ missionId: "derv", name: "d1", lastActivityAt: recent }),
      ],
      missions: { auth: { authoredStatus: "complete" } },
    });
    const second = mount(<ProjectTreeView />);
    const t1Auth = (await second.findByTestId("project-mission-auth-badge")).textContent;
    const t1Derv = (await second.findByTestId("project-mission-derv-badge")).textContent;
    // THE V4 DIFFERENTIAL, post-jump: derived decays honestly to idle —
    // at base this is the named RED (the badge reads the retired word).
    expect(t1Derv).toContain("idle");
    expect(t1Derv).not.toContain("unknown");
    // authored: BYTE-STABLE across pure time passage (t1 == t0), and the
    // candidate anchor pins the actual word.
    expect(t1Auth).toBe(t0Auth);
    expect(t1Auth).toContain("complete");
    second.unmount();
  });
});

describe("V5 — byte-identity carve at the observable (both-ends green)", () => {
  it("authored == derived AGREE-cases render the same word at both SHAs", async () => {
    // (a) authored 'shipped' + all-done stale corpus: base derives shipped,
    // candidate renders the authored word — the SAME observable either way.
    // (b) authored 'active' + recent-active corpus: same agreement.
    const stale = new Date(Date.now() - WINDOW_MS - 4 * 60 * 60 * 1000).toISOString();
    setupFetch({
      slices: [
        sliceRow({ missionId: "agree-ship", name: "as1", status: "done", lastActivityAt: stale }),
        sliceRow({ missionId: "agree-act", name: "aa1" }),
      ],
      missions: {
        "agree-ship": { authoredStatus: "shipped" },
        "agree-act": { authoredStatus: "active" },
      },
    });
    const { findByTestId } = mount(<ProjectTreeView />);
    expect((await findByTestId("project-mission-agree-ship-badge")).textContent).toContain("shipped");
    expect((await findByTestId("project-mission-agree-act-badge")).textContent).toContain("active");
  });

  it("derived corpora render today's words identically (active · blocked · shipped)", async () => {
    setupFetch({
      slices: [
        sliceRow({ missionId: "run", name: "r1" }), // recent active → active
        sliceRow({ missionId: "stuck", name: "b1", status: "blocked" }),
        sliceRow({ missionId: "landed", name: "l1", status: "done", lastActivityAt: null, qitemCount: 0 }),
      ],
      missions: {},
    });
    const { findByTestId } = mount(<ProjectTreeView />);
    expect((await findByTestId("project-mission-run-badge")).textContent).toContain("active");
    expect((await findByTestId("project-mission-stuck-badge")).textContent).toContain("blocked");
    expect((await findByTestId("project-mission-landed-badge")).textContent).toContain("shipped");
  });
});
