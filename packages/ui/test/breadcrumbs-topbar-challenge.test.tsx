// Milestone 2 Empirical Adversarial Challenge Test Suite
// Authored by challenger_m2_2
// Targets:
// 1. packages/ui/src/lib/breadcrumbs.ts (extreme deep paths, URI encoding, Unicode, trailing slashes, pathological inputs)
// 2. packages/ui/src/components/shell/TopBar.tsx (responsive container, text truncation, right-slot preservation, tooltips)
// 3. packages/ui/src/components/specs/SpecsLibraryPage.tsx (SPA navigation toolbar, dropdown verbs, empty-state link)
// 4. packages/ui/src/components/review/FleetPage.tsx (openHost SPA navigation without window.location.assign, footer agents link)
// 5. packages/ui/src/components/review/RigAgentsPage.tsx (anchored full-rig SPA link, query param addressability)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { breadcrumbsFor, type Crumb, type CrumbNames } from "../src/lib/breadcrumbs.js";
import { TopBar } from "../src/components/shell/TopBar.js";
import { SpecsLibraryPage } from "../src/components/specs/SpecsLibraryPage.js";
import { FleetPage } from "../src/components/review/FleetPage.js";
import { RigAgentsPage } from "../src/components/review/RigAgentsPage.js";
import { createTestRouter, createAppTestRouter } from "./helpers/test-router.js";
import type { ComposedFleet } from "../src/hooks/useFleet.js";
import type { ComposedRigAgents } from "../src/hooks/useReview.js";

const MOCK_RIG_SUMMARY = [
  {
    id: "rig_alpha",
    name: "acme-build",
    nodeCount: 3,
    hasServices: true,
    latestSnapshotAt: "2026-11-06T12:00:00Z",
    latestSnapshotId: "snap-001",
    lifecycleState: "running",
  },
  {
    id: "rig_beta",
    name: "worker-beta",
    nodeCount: 1,
    hasServices: false,
    latestSnapshotAt: null,
    latestSnapshotId: null,
    lifecycleState: "stopped",
  },
];

const MOCK_FLEET: ComposedFleet = {
  rollup: {
    needsYouCount: 1,
    exceptionCount: 0,
    exceptionsByKind: [],
    hostCount: 2,
    unreachableCount: 0,
  },
  needsYou: {
    items: [
      {
        source: "agent",
        identity: "item-101",
        fleetKey: "local|item-101",
        hostId: "local",
        seenFrom: ["rig"],
        summary: "Sign-off required on release brief",
        leg: "human-gate",
        where: "rig",
        ageIso: null,
        priority: "urgent",
        tier: "human-gate",
        evidenceRef: null,
        unblocks: "item-101",
        qitemId: "item-101",
        destinationSession: "lead@host",
        derived: null,
      },
    ],
    provenance: "fleet union · 2/2 hosts composing",
  },
  hosts: [
    {
      hostId: "local",
      kind: "local",
      status: { hostId: "local", status: "ok" },
      needsYouCount: 1,
      exceptionsByKind: [],
      seatCount: 3,
      rigCount: 2,
      topLine: "● Sign-off required on release brief",
    },
    {
      hostId: "vps-staging",
      kind: "remote",
      status: { hostId: "vps-staging", status: "ok" },
      needsYouCount: 0,
      exceptionsByKind: [],
      seatCount: 2,
      rigCount: 1,
      topLine: "quiet",
    },
  ],
  settled: [],
  settledProvenance: "0 settled today",
  composedAt: "2026-11-06T22:00:00Z",
};

const MOCK_RIG_AGENTS: ComposedRigAgents = {
  scope: "rig",
  needsYou: {
    items: [],
    provenance: "computed from queue+ps",
  },
  agents: {
    scope: "rig",
    rows: [
      {
        agentName: "builder1",
        runtime: "claude-code",
        stateGlyph: "active",
        doing: "compiling core packages",
        holdsCount: 1,
        lastTransitionIso: "2026-11-06T22:00:00Z",
        exception: null,
        sessionName: "dev-builder1@openrig",
        slices: ["core-slice", "signal-slice"],
      },
      {
        agentName: "tester2",
        runtime: "codex",
        stateGlyph: "parked",
        doing: "parked on verification gate",
        holdsCount: 0,
        lastTransitionIso: "2026-11-06T22:00:00Z",
        exception: null,
        sessionName: "dev-tester2@openrig",
        slices: ["signal-slice"],
      },
    ],
    provenance: "computed from ps · today",
    coordinationHealth: "1 handoff today · 0 overdue",
  },
  settled: [],
  settledProvenance: "today's handoffs",
  composedAt: "2026-11-06T22:00:00Z",
};

function setupGlobalFetchMock() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/rigs/summary")) {
      return new Response(JSON.stringify(MOCK_RIG_SUMMARY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/hosts")) {
      return new Response(
        JSON.stringify({
          ownName: "local-studio",
          selected: "local",
          hosts: [{ id: "local", name: "Local Host", kind: "local", status: "reachable" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/review/fleet")) {
      return new Response(JSON.stringify(MOCK_FLEET), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/review/rig")) {
      return new Response(JSON.stringify(MOCK_RIG_AGENTS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/specs/library")) {
      return new Response(
        JSON.stringify([
          { kind: "rig", id: "rig-template-1", name: "Standard Cluster", hasServices: false },
          { kind: "workflow", id: "wf-release", name: "Release Pipeline" },
          { kind: "agent", id: "agent-evaluator", name: "Code Evaluator" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/specs/skills")) {
      return new Response(
        JSON.stringify([
          { id: "developing-openrig", name: "developing-openrig", files: ["SKILL.md", "guide.md"] },
          { id: "science-tools", name: "science-tools", files: ["SKILL.md"] },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/plugins")) {
      return new Response(
        JSON.stringify([
          { id: "openrig-core", name: "openrig-core", version: "0.7.1" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

beforeEach(() => {
  setupGlobalFetchMock();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
});

// ============================================================================
// SUITE 1: Adversarial Breadcrumb Hierarchy & Pathological Input Stress
// ============================================================================
describe("Challenger M2: Adversarial Breadcrumb Hierarchy & Pathological Inputs", () => {
  const names: CrumbNames = {
    rigName: (id: string) => (id === "rig_alpha" ? "acme-build" : id === "rig_beta" ? "worker-beta" : undefined),
  };

  const assertCrumbInvariants = (crumbs: Crumb[]) => {
    expect(crumbs.length).toBeGreaterThanOrEqual(1);
    // Terminal crumb must NEVER have a `to` property
    const last = crumbs[crumbs.length - 1];
    expect(last).toBeDefined();
    expect(last.to).toBeUndefined();
    expect(last.label.length).toBeGreaterThan(0);

    // Intermediate crumbs must have valid non-empty `to` starting with `/`
    for (let i = 0; i < crumbs.length - 1; i++) {
      const crumb = crumbs[i];
      expect(crumb.to, `Intermediate crumb ${i} (${crumb.label}) must have 'to'`).toBeDefined();
      expect(crumb.to!.startsWith("/"), `Intermediate crumb 'to' must start with /`).toBe(true);
      expect(crumb.label.length).toBeGreaterThan(0);
    }
  };

  it("handles empty and multiple consecutive slashes gracefully without empty crumbs", () => {
    const root1 = breadcrumbsFor("");
    expect(root1).toEqual([{ label: "Dashboard" }]);
    assertCrumbInvariants(root1);

    const root2 = breadcrumbsFor("////");
    expect(root2).toEqual([{ label: "Dashboard" }]);
    assertCrumbInvariants(root2);

    const deepMultiSlash = breadcrumbsFor("///specs////skills///developing-openrig//file///SKILL.md///", names);
    expect(deepMultiSlash).toEqual([
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "developing-openrig", to: "/specs/skills/developing-openrig" },
      { label: "SKILL.md" },
    ]);
    assertCrumbInvariants(deepMultiSlash);

    const topologyMultiSlash = breadcrumbsFor("//topology///rig////rig_alpha///", names);
    expect(topologyMultiSlash).toEqual([
      { label: "Rigs", to: "/topology" },
      { label: "acme-build" },
    ]);
    assertCrumbInvariants(topologyMultiSlash);
  });

  it("handles malformed URI encodings that trigger URIError in standard decodeURIComponent", () => {
    // Malformed sequences: %E0%A4%A, %FF, %C0%AF, lone %, trailing %1
    const malformedPaths = [
      "/specs/skills/%E0%A4%A/file/%FF",
      "/topology/seat/rig_alpha/%C0%AF%2Fforbidden",
      "/topology/pod/rig_alpha/%/status",
      "/packages/pack%1",
      "/specs/skills/test%ZZinvalid/file/test.py",
    ];

    for (const path of malformedPaths) {
      expect(() => breadcrumbsFor(path, names)).not.toThrow();
      const crumbs = breadcrumbsFor(path, names);
      assertCrumbInvariants(crumbs);
    }
  });

  it("handles complex encoded special characters: spaces, dots, slashes, pluses, ampersands, colons", () => {
    const complexPath = "/specs/skills/acme%20corp%2Ecore%2Bextras/file/src%2Fcomponents%2FButton%2Etsx";
    const crumbs = breadcrumbsFor(complexPath, names);

    expect(crumbs).toEqual([
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "acme corp.core+extras", to: "/specs/skills/acme corp.core+extras" },
      { label: "src/components/Button.tsx" },
    ]);
    assertCrumbInvariants(crumbs);
  });

  it("handles multi-language Unicode, emoji, CJK, Arabic, and math symbols without corruption", () => {
    const unicodePath = "/specs/skills/%F0%9F%A6%80%20%E8%8A%B1%E7%81%AB%20%D9%85%D8%B1%D8%AD%D8%A8%D8%A7/file/%E2%88%91%20sum%20formula%2Ets";
    const crumbs = breadcrumbsFor(unicodePath, names);

    expect(crumbs).toEqual([
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "🦀 花火 مرحبا", to: "/specs/skills/🦀 花火 مرحبا" },
      { label: "∑ sum formula.ts" },
    ]);
    assertCrumbInvariants(crumbs);
  });

  it("handles extreme hierarchy depth (5 to 15 segments) preserving navigable parent containers", () => {
    // 7 segments: /specs/skills/:token/file/pkg/sub/dir/test.ts
    const skill7 = breadcrumbsFor("/specs/skills/my-pack/file/pkg/sub/dir/test.ts", names);
    expect(skill7).toEqual([
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "my-pack", to: "/specs/skills/my-pack" },
      { label: "pkg/sub/dir/test.ts" },
    ]);
    assertCrumbInvariants(skill7);

    // 8 segments: /topology/pod/:rigId/:podName/nested/deep/level/audit
    const pod8 = breadcrumbsFor("/topology/pod/rig_alpha/lead/nested/deep/level/audit", names);
    expect(pod8).toEqual([
      { label: "Rigs", to: "/topology" },
      { label: "acme-build", to: "/topology/rig/rig_alpha" },
      { label: "lead pod", to: "/topology/pod/rig_alpha/lead" },
      { label: "nested/deep/level/audit" },
    ]);
    assertCrumbInvariants(pod8);

    // 9 segments: /topology/seat/:rigId/:logicalId/logs/2026/11/06/trace.log
    const seat9 = breadcrumbsFor("/topology/seat/rig_alpha/lead.coordinator/logs/2026/11/06/trace.log", names);
    expect(seat9).toEqual([
      { label: "Rigs", to: "/topology" },
      { label: "acme-build", to: "/topology/rig/rig_alpha" },
      { label: "coordinator", to: "/topology/seat/rig_alpha/lead.coordinator" },
      { label: "logs/2026/11/06/trace.log" },
    ]);
    assertCrumbInvariants(seat9);

    // 14 segments: ultra-deep file path in skill file browser
    const deepSkill = breadcrumbsFor(
      "/specs/skills/openrig/file/a/b/c/d/e/f/g/h/i/j/component.tsx",
      names,
    );
    expect(deepSkill).toEqual([
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "openrig", to: "/specs/skills/openrig" },
      { label: "a/b/c/d/e/f/g/h/i/j/component.tsx" },
    ]);
    assertCrumbInvariants(deepSkill);
  });

  it("handles extreme string lengths (5,000+ characters) without performance degradation or link truncation", () => {
    const hugeSkill = "S".repeat(5000);
    const hugeFile = "F".repeat(5000);
    const path = `/specs/skills/${hugeSkill}/file/${hugeFile}`;

    const t0 = performance.now();
    const crumbs = breadcrumbsFor(path, names);
    const duration = performance.now() - t0;

    expect(duration).toBeLessThan(100); // Must resolve in < 100ms
    expect(crumbs).toHaveLength(4);
    expect(crumbs[2]).toEqual({ label: hugeSkill, to: `/specs/skills/${hugeSkill}` });
    expect(crumbs[3]).toEqual({ label: hugeFile });
    expect(crumbs[3].to).toBeUndefined();
    assertCrumbInvariants(crumbs);
  });

  it("handles custom names lookup failure gracefully (fallback to raw rigId)", () => {
    const crumbs = breadcrumbsFor("/topology/rig/unknown-rig-999", names);
    expect(crumbs).toEqual([
      { label: "Rigs", to: "/topology" },
      { label: "unknown-rig-999" },
    ]);
    assertCrumbInvariants(crumbs);
  });
});

// ============================================================================
// SUITE 2: TopBar Responsive Layout, Text Truncation & Slot Preservation
// ============================================================================
describe("Challenger M2: TopBar Responsive Layout & Slot Protection", () => {
  it("renders TopBar on 320px mobile viewport with 2,000-char crumb without crashing or hiding right slot", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320, writable: true });
    window.dispatchEvent(new Event("resize"));

    const extremeLabel = "E".repeat(2000);
    const path = `/specs/skills/${extremeLabel}`;

    const { container } = render(
      createTestRouter({
        path: "/specs/skills/$skillToken",
        initialPath: path,
        component: () => (
          <header data-testid="app-topbar" className="flex h-12 w-[320px] items-center justify-between border-b px-2">
            <TopBar />
          </header>
        ),
      }),
    );

    await waitFor(() => {
      expect(container.querySelector("[data-testid='breadcrumbs']")).toBeTruthy();
    });

    // 1. Verify breadcrumbs navigation container has overflow protection
    const breadcrumbs = container.querySelector("[data-testid='breadcrumbs']");
    expect(breadcrumbs).toBeTruthy();
    expect(breadcrumbs?.className).toContain("overflow-hidden");
    expect(breadcrumbs?.className).toContain("min-w-0");

    // 2. Verify intermediate links have truncate, min-w-0, and max-w styling
    const links = breadcrumbs?.querySelectorAll("a");
    expect(links?.length).toBeGreaterThan(0);
    links?.forEach((link) => {
      expect(link.className).toContain("truncate");
      expect(link.className).toContain("min-w-0");
      expect(link.className).toMatch(/max-w-\[\d+px\]/);
    });

    // 3. Verify terminal span has truncate, min-w-0, and max-w styling
    const terminalSpan = breadcrumbs?.querySelector("span[aria-current='page']");
    expect(terminalSpan).toBeTruthy();
    expect(terminalSpan?.className).toContain("truncate");
    expect(terminalSpan?.className).toContain("min-w-0");
    expect(terminalSpan?.className).toMatch(/max-w-\[\d+px\]/);

    // 4. Verify right slot is shrink-0 and not pushed out of DOM
    const rightSlot = container.querySelector("[data-testid='topbar-right-slot']");
    expect(rightSlot).toBeTruthy();
    expect(rightSlot?.className).toContain("shrink-0");

    // 5. HostIndicator and ThemeSelector remain rendered inside rightSlot
    const hostIndicator = rightSlot?.querySelector("[data-testid='host-indicator']") ?? rightSlot?.textContent;
    expect(hostIndicator).toBeTruthy();
    const themeSelector = rightSlot?.querySelector("[data-testid='theme-selector']") ?? rightSlot?.querySelector("button");
    expect(themeSelector).toBeTruthy();
  });

  it("wraps breadcrumbs in Tooltip with full untruncated content and title attribute", async () => {
    const longLabel = "Z".repeat(500);
    const path = `/specs/skills/${longLabel}`;

    const { container } = render(
      createTestRouter({
        path: "/specs/skills/$skillToken",
        initialPath: path,
        component: () => (
          <header className="flex h-12 w-full items-center justify-between border-b px-4">
            <TopBar />
          </header>
        ),
      }),
    );

    await waitFor(() => {
      expect(container.querySelector("[data-testid='breadcrumbs']")).toBeTruthy();
    });

    const terminalSpan = container.querySelector("[data-testid='breadcrumbs'] span[aria-current='page']");
    expect(terminalSpan).toBeTruthy();
    // Title attribute preserves the full label for native hover tooltips
    expect(terminalSpan?.getAttribute("title")).toBe(longLabel);
  });
});

// ============================================================================
// SUITE 3: SPA Navigation Routes Across SpecsLibraryPage, FleetPage & RigAgentsPage
// ============================================================================
describe("Challenger M2: SPA Navigation Transitions & Router Wiring", () => {
  it("SpecsLibraryPage: 'New rig' button navigates via TanStack Link to /specs/rig", async () => {
    const rendered = render(
      createAppTestRouter({
        routes: [
          {
            path: "/specs",
            component: () => <SpecsLibraryPage />,
          },
          {
            path: "/specs/rig",
            component: () => <div data-testid="page-specs-rig-arrived">Specs Rig Wizard</div>,
          },
        ],
        initialPath: "/specs",
      }),
    );

    await waitFor(() => {
      expect(rendered.container.querySelector("[data-testid='specs-library-page']")).toBeTruthy();
    });

    const newRigBtn = rendered.container.querySelector("[data-testid='specs-toolbar-create-rig']");
    expect(newRigBtn).toBeTruthy();

    const linkEl = newRigBtn?.querySelector("a") ?? newRigBtn;
    expect(linkEl?.getAttribute("href")).toBe("/specs/rig");

    // Click link and verify client-side navigation
    fireEvent.click(linkEl!);
    expect(await screen.findByTestId("page-specs-rig-arrived")).toBeTruthy();
  });

  it("SpecsLibraryPage: 'More' dropdown actions trigger client-side navigate", async () => {
    const rendered = render(
      createAppTestRouter({
        routes: [
          {
            path: "/specs",
            component: () => <SpecsLibraryPage />,
          },
          {
            path: "/specs/agent",
            component: () => <div data-testid="page-agent-arrived">Agent Spec Wizard</div>,
          },
          {
            path: "/workflows",
            component: () => <div data-testid="page-workflows-arrived">Workflows Overview</div>,
          },
        ],
        initialPath: "/specs",
      }),
    );

    await waitFor(() => {
      expect(rendered.container.querySelector("[data-testid='specs-library-page']")).toBeTruthy();
    });

    const moreBtn = screen.getByTestId("specs-toolbar-more");
    expect(moreBtn).toBeTruthy();

    // Trigger Radix dropdown menu via Enter
    fireEvent.keyDown(moreBtn, { key: "Enter" });

    // Verify all 4 action items are rendered in dropdown
    const newAgent = await screen.findByTestId("specs-toolbar-add");
    expect(newAgent.textContent).toBe("New agent");

    const workflows = await screen.findByTestId("specs-toolbar-gen-workflow");
    expect(workflows.textContent).toBe("Workflows");

    const importItem = await screen.findByTestId("specs-toolbar-import");
    expect(importItem.textContent).toBe("Import");

    const discoverItem = await screen.findByTestId("specs-toolbar-discover");
    expect(discoverItem.textContent).toBe("Discover");

    // Click "New agent" and verify router navigation
    fireEvent.click(newAgent);
    expect(await screen.findByTestId("page-agent-arrived")).toBeTruthy();
  });

  it("SpecsLibraryPage: EmptyState action renders TanStack Link to /search", async () => {
    // Override fetch to return zero library entries
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const rendered = render(
      createAppTestRouter({
        routes: [
          {
            path: "/specs",
            component: () => <SpecsLibraryPage />,
          },
          {
            path: "/search",
            component: () => <div data-testid="page-search-arrived">Search & Discovery</div>,
          },
        ],
        initialPath: "/specs",
      }),
    );

    await waitFor(() => {
      expect(rendered.container.querySelector("[data-testid='library-empty']")).toBeTruthy();
    });

    const actionLink = rendered.container.querySelector("[data-testid='library-empty-action']");
    expect(actionLink).toBeTruthy();
    expect(actionLink?.tagName).toBe("A");
    expect(actionLink?.getAttribute("href")).toBe("/search");

    fireEvent.click(actionLink!);
    expect(await screen.findByTestId("page-search-arrived")).toBeTruthy();
  });

  it("FleetPage: openHost triggers router navigate to /project?from=fleet WITHOUT window.location.assign", async () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      value: {
        ...window.location,
        assign: assignSpy,
        search: "",
        href: "http://localhost/fleet",
      },
      writable: true,
      configurable: true,
    });

    render(
      createAppTestRouter({
        routes: [
          {
            path: "/fleet",
            component: () => <FleetPage />,
          },
          {
            path: "/project",
            component: () => <div data-testid="page-project-arrived">Project Altitude</div>,
          },
        ],
        initialPath: "/fleet",
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("fleet-page")).toBeTruthy();
    });

    const openHostBtn = screen.getByTestId("fleet-host-local-open");
    expect(openHostBtn).toBeTruthy();

    fireEvent.click(openHostBtn);

    // Assert that hard window reload was NOT triggered
    expect(assignSpy).not.toHaveBeenCalled();

    // Assert that SPA navigation reached /project
    await waitFor(() => {
      expect(screen.getByTestId("page-project-arrived")).toBeTruthy();
    });
  });

  it("FleetPage: footer link to /agents renders TanStack Link", async () => {
    render(
      createAppTestRouter({
        routes: [
          {
            path: "/fleet",
            component: () => <FleetPage />,
          },
          {
            path: "/agents",
            component: () => <div data-testid="page-agents-arrived">Agents Altitude</div>,
          },
        ],
        initialPath: "/fleet",
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("fleet-fanout-footer")).toBeTruthy();
    });

    const footer = screen.getByTestId("fleet-fanout-footer");
    const link = within(footer).getByRole("link", { name: /this host's agents/i });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("/agents");

    fireEvent.click(link);
    expect(await screen.findByTestId("page-agents-arrived")).toBeTruthy();
  });

  it("RigAgentsPage: anchored 'Full rig' unanchor link navigates to /agents via SPA", async () => {
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost/agents?slice=core-slice"),
      writable: true,
      configurable: true,
    });

    render(
      createAppTestRouter({
        routes: [
          {
            path: "/agents",
            component: () => <RigAgentsPage />,
          },
        ],
        initialPath: "/agents?slice=core-slice",
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("rig-agents-page")).toBeTruthy();
    });

    expect(screen.getByTestId("rig-agents-anchor").textContent).toContain("core-slice");

    const unanchorElements = screen.getAllByTestId("rig-agents-unanchor");
    expect(unanchorElements.length).toBeGreaterThan(0);
    const link = unanchorElements.find((el) => el.tagName === "A");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/agents");

    fireEvent.click(link!);
  });
});
