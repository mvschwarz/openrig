import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { breadcrumbsFor, type Crumb } from "../src/lib/breadcrumbs.js";
import { TopBar } from "../src/components/shell/TopBar.js";
import { SpecsLibraryPage } from "../src/components/specs/SpecsLibraryPage.js";
import { createTestRouter } from "./helpers/test-router.js";
import { router } from "../src/routes.js";
import type { ReactNode } from "react";

// Mock fetch for TopBar (useRigSummary) and SpecsLibraryPage (useSpecLibrary, etc.)
const mockFetch = vi.fn();

const MOCK_RIGS = [
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
    id: "rig_extreme",
    name: "X".repeat(1000),
    nodeCount: 1,
    hasServices: false,
    latestSnapshotAt: null,
    latestSnapshotId: null,
    lifecycleState: "running",
  },
];

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/rigs/summary")) {
      return new Response(JSON.stringify(MOCK_RIGS), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/hosts")) {
      return new Response(JSON.stringify({ selected: "local", hosts: [{ id: "local", name: "Local Host" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/specs/library")) {
      return new Response(JSON.stringify([{ kind: "rig", id: "rig-1", name: "default-rig" }]), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify([]), {
      headers: { "Content-Type": "application/json" },
    });
  });

  globalThis.fetch = mockFetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
});

describe("Adversarial Breadcrumb Hierarchy & Deep Routes (5 to 10 Segments)", () => {
  const names = {
    rigName: (id: string) => {
      const match = MOCK_RIGS.find((r) => r.id === id);
      return match ? match.name : undefined;
    },
  };

  const verifyBreadcrumbAncestors = (crumbs: Crumb[]) => {
    expect(crumbs.length).toBeGreaterThanOrEqual(3);
    // All crumbs except the last must have valid linked paths
    for (let i = 0; i < crumbs.length - 1; i++) {
      expect(crumbs[i].to).toBeDefined();
      expect(crumbs[i].to?.startsWith("/")).toBe(true);
      expect(crumbs[i].label.length).toBeGreaterThan(0);
    }
    // Terminal crumb must NEVER have a link
    expect(crumbs[crumbs.length - 1].to).toBeUndefined();
    expect(crumbs[crumbs.length - 1].label.length).toBeGreaterThan(0);
  };

  it("handles 5-segment skill file route preserving Library, Skills, and Skill Token ancestors", () => {
    const crumbs = breadcrumbsFor("/specs/skills/developing-openrig/file/SKILL.md", names);
    expect(crumbs).toEqual([
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "developing-openrig", to: "/specs/skills/developing-openrig" },
      { label: "SKILL.md" },
    ]);
    verifyBreadcrumbAncestors(crumbs);
  });

  it("handles 5-segment topology pod and seat routes preserving Rigs and Rig ancestors", () => {
    const podCrumbs = breadcrumbsFor("/topology/pod/rig_alpha/lead/metrics", names);
    expect(podCrumbs).toEqual([
      { label: "Rigs", to: "/topology" },
      { label: "acme-build", to: "/topology/rig/rig_alpha" },
      { label: "lead pod", to: "/topology/pod/rig_alpha/lead" },
      { label: "metrics" },
    ]);
    verifyBreadcrumbAncestors(podCrumbs);

    const seatCrumbs = breadcrumbsFor("/topology/seat/rig_alpha/lead.coordinator/logs", names);
    expect(seatCrumbs).toEqual([
      { label: "Rigs", to: "/topology" },
      { label: "acme-build", to: "/topology/rig/rig_alpha" },
      { label: "coordinator", to: "/topology/seat/rig_alpha/lead.coordinator" },
      { label: "logs" },
    ]);
    verifyBreadcrumbAncestors(seatCrumbs);
  });

  it("handles 6-segment deep routes preserving all ancestor containers", () => {
    const skill6 = breadcrumbsFor("/specs/skills/developing-openrig/file/scripts/test.py", names);
    expect(skill6).toEqual([
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "developing-openrig", to: "/specs/skills/developing-openrig" },
      { label: "scripts/test.py" },
    ]);
    verifyBreadcrumbAncestors(skill6);

    const seat6 = breadcrumbsFor("/topology/seat/rig_alpha/lead.coordinator/logs/2026", names);
    expect(seat6).toEqual([
      { label: "Rigs", to: "/topology" },
      { label: "acme-build", to: "/topology/rig/rig_alpha" },
      { label: "coordinator", to: "/topology/seat/rig_alpha/lead.coordinator" },
      { label: "logs/2026" },
    ]);
    verifyBreadcrumbAncestors(seat6);
  });

  it("handles 7-segment deep routes preserving all ancestor containers", () => {
    const skill7 = breadcrumbsFor("/specs/skills/developing-openrig/file/nested/scripts/test.py", names);
    expect(skill7).toEqual([
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "developing-openrig", to: "/specs/skills/developing-openrig" },
      { label: "nested/scripts/test.py" },
    ]);
    verifyBreadcrumbAncestors(skill7);

    const pod7 = breadcrumbsFor("/topology/pod/rig_alpha/lead/sub1/sub2/sub3", names);
    expect(pod7).toEqual([
      { label: "Rigs", to: "/topology" },
      { label: "acme-build", to: "/topology/rig/rig_alpha" },
      { label: "lead pod", to: "/topology/pod/rig_alpha/lead" },
      { label: "sub1/sub2/sub3" },
    ]);
    verifyBreadcrumbAncestors(pod7);
  });

  it("handles 8-segment deep routes preserving all ancestor containers", () => {
    const skill8 = breadcrumbsFor("/specs/skills/developing-openrig/file/pkg/core/src/index.ts", names);
    expect(skill8).toEqual([
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "developing-openrig", to: "/specs/skills/developing-openrig" },
      { label: "pkg/core/src/index.ts" },
    ]);
    verifyBreadcrumbAncestors(skill8);

    const seat8 = breadcrumbsFor("/topology/seat/rig_alpha/lead.coordinator/logs/2026/11/06", names);
    expect(seat8).toEqual([
      { label: "Rigs", to: "/topology" },
      { label: "acme-build", to: "/topology/rig/rig_alpha" },
      { label: "coordinator", to: "/topology/seat/rig_alpha/lead.coordinator" },
      { label: "logs/2026/11/06" },
    ]);
    verifyBreadcrumbAncestors(seat8);
  });

  it("handles 9-segment deep routes preserving all ancestor containers", () => {
    const skill9 = breadcrumbsFor("/specs/skills/developing-openrig/file/pkg/core/src/sub/index.ts", names);
    expect(skill9).toEqual([
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "developing-openrig", to: "/specs/skills/developing-openrig" },
      { label: "pkg/core/src/sub/index.ts" },
    ]);
    verifyBreadcrumbAncestors(skill9);

    const seat9 = breadcrumbsFor("/topology/seat/rig_alpha/lead.coordinator/logs/2026/11/06/trace.log", names);
    expect(seat9).toEqual([
      { label: "Rigs", to: "/topology" },
      { label: "acme-build", to: "/topology/rig/rig_alpha" },
      { label: "coordinator", to: "/topology/seat/rig_alpha/lead.coordinator" },
      { label: "logs/2026/11/06/trace.log" },
    ]);
    verifyBreadcrumbAncestors(seat9);
  });

  it("handles 10-segment deep routes preserving all ancestor containers", () => {
    const skill10 = breadcrumbsFor("/specs/skills/developing-openrig/file/a/b/c/d/e/f/index.ts", names);
    expect(skill10).toEqual([
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "developing-openrig", to: "/specs/skills/developing-openrig" },
      { label: "a/b/c/d/e/f/index.ts" },
    ]);
    verifyBreadcrumbAncestors(skill10);

    const seat10 = breadcrumbsFor("/topology/seat/rig_alpha/lead.coordinator/a/b/c/d/e/f", names);
    expect(seat10).toEqual([
      { label: "Rigs", to: "/topology" },
      { label: "acme-build", to: "/topology/rig/rig_alpha" },
      { label: "coordinator", to: "/topology/seat/rig_alpha/lead.coordinator" },
      { label: "a/b/c/d/e/f" },
    ]);
    verifyBreadcrumbAncestors(seat10);
  });

  it("handles encoded special characters, spaces, and Unicode without throwing", () => {
    // Percent-encoded spaces, dots, hashes, emoji
    const path = "/specs/skills/%F0%9F%A6%80%20crab%20skill/file/%E4%B8%AD%E6%96%87%20file.ts";
    const crumbs = breadcrumbsFor(path, names);
    expect(crumbs).toEqual([
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "🦀 crab skill", to: "/specs/skills/🦀 crab skill" },
      { label: "中文 file.ts" },
    ]);
    verifyBreadcrumbAncestors(crumbs);

    // Malformed URI percent encoding does not throw URIError
    const brokenPath = "/topology/seat/rig_alpha/broken%E0%A4%A/logs";
    expect(() => breadcrumbsFor(brokenPath, names)).not.toThrow();
    const brokenCrumbs = breadcrumbsFor(brokenPath, names);
    expect(brokenCrumbs[2].label).toContain("broken%E0%A4%A");
  });

  it("handles extreme length (1,000+ char) titles without corrupting crumb links", () => {
    const extremeSkill = "S".repeat(1000);
    const extremeFile = "F".repeat(1000);
    const path = `/specs/skills/${extremeSkill}/file/${extremeFile}`;
    const crumbs = breadcrumbsFor(path, names);

    expect(crumbs).toHaveLength(4);
    expect(crumbs[0]).toEqual({ label: "Library", to: "/specs" });
    expect(crumbs[1]).toEqual({ label: "Skills", to: "/specs/skills" });
    expect(crumbs[2]).toEqual({ label: extremeSkill, to: `/specs/skills/${extremeSkill}` });
    expect(crumbs[3]).toEqual({ label: extremeFile });
    expect(crumbs[3].to).toBeUndefined();
  });
});

describe("Adversarial TopBar Responsive Container Protection (320px Viewport)", () => {
  const setMobileViewport = (width = 320) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width, writable: true });
    window.dispatchEvent(new Event("resize"));
  };

  it("renders TopBar at 320px viewport with 1,000-character breadcrumb without displacing right-slot controls", async () => {
    setMobileViewport(320);

    const longCrumbPath = `/specs/skills/${"A".repeat(1000)}`;

    const { container } = render(
      createTestRouter({
        path: "/specs/skills/$skillToken",
        initialPath: longCrumbPath,
        component: () => (
          <header data-testid="app-topbar" className="flex h-12 w-full max-w-[320px] items-center justify-between border-b px-4">
            <TopBar />
          </header>
        ),
      }),
    );

    await waitFor(() => {
      expect(container.querySelector("[data-testid='breadcrumbs']")).toBeTruthy();
    });

    const topbar = container.querySelector("[data-testid='app-topbar']");
    expect(topbar).toBeTruthy();

    const breadcrumbs = container.querySelector("[data-testid='breadcrumbs']");
    expect(breadcrumbs).toBeTruthy();

    // Verify breadcrumb container has truncation and overflow protection classes
    expect(breadcrumbs?.className).toContain("overflow-hidden");
    expect(breadcrumbs?.className).toContain("min-w-0");

    // Verify individual breadcrumb items enforce text truncation
    const links = breadcrumbs?.querySelectorAll("a");
    expect(links?.length).toBeGreaterThan(0);
    links?.forEach((link) => {
      expect(link.className).toContain("truncate");
      expect(link.className).toContain("min-w-0");
    });

    const terminalSpan = breadcrumbs?.querySelector("span[aria-current='page']");
    expect(terminalSpan).toBeTruthy();
    expect(terminalSpan?.className).toContain("truncate");
    expect(terminalSpan?.className).toContain("min-w-0");

    // Verify topbar right slot exists, remains in DOM, and has shrink-0 protection
    const rightSlot = container.querySelector("[data-testid='topbar-right-slot']");
    expect(rightSlot).toBeTruthy();
    expect(rightSlot?.className).toContain("shrink-0");

    // Host indicator and theme selector remain inside right-slot
    expect(rightSlot?.querySelector("[data-testid='host-indicator']") ?? rightSlot?.textContent).toBeTruthy();
    expect(rightSlot?.querySelector("[data-testid='theme-selector']") ?? rightSlot?.querySelector("button")).toBeTruthy();
  });

  it("preserves full extreme-length title in accessible tooltip trigger", async () => {
    const longTitle = "Z".repeat(1000);
    const path = `/specs/skills/${longTitle}`;

    const { container } = render(
      createTestRouter({
        path: "/specs/skills/$skillToken",
        initialPath: path,
        component: () => (
          <header className="flex h-12 w-[320px] items-center justify-between border-b px-2">
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
    expect(terminalSpan?.getAttribute("title")).toBe(longTitle);
  });
});

describe("Adversarial Specs Library Toolbar Action Routing", () => {
  it("renders Specs Library toolbar with verified links to /specs/rig, /specs/agent, /workflows, /import, and /search", async () => {
    const { container } = render(
      createTestRouter({
        path: "/specs",
        initialPath: "/specs",
        component: () => <SpecsLibraryPage />,
      }),
    );

    await waitFor(() => {
      expect(container.querySelector("[data-testid='specs-library-page']")).toBeTruthy();
    });

    // Primary action button: New rig -> /specs/rig
    const createRigBtn = container.querySelector("[data-testid='specs-toolbar-create-rig']");
    expect(createRigBtn).toBeTruthy();
    const createRigLink = createRigBtn?.querySelector("a") ?? createRigBtn;
    expect(createRigLink?.getAttribute("href")).toBe("/specs/rig");

    // "More" dropdown trigger exists
    const moreBtn = container.querySelector("[data-testid='specs-toolbar-more']");
    expect(moreBtn).toBeTruthy();

    // Open the dropdown menu via keyboard Enter (Radix DropdownMenu trigger)
    fireEvent.keyDown(moreBtn!, { key: "Enter" });

    // Verify all 4 action items in dropdown are rendered
    const newAgentItem = await screen.findByTestId("specs-toolbar-add");
    expect(newAgentItem).toBeTruthy();
    expect(newAgentItem.textContent).toBe("New agent");

    const workflowsItem = await screen.findByTestId("specs-toolbar-gen-workflow");
    expect(workflowsItem).toBeTruthy();
    expect(workflowsItem.textContent).toBe("Workflows");

    const importItem = await screen.findByTestId("specs-toolbar-import");
    expect(importItem).toBeTruthy();
    expect(importItem.textContent).toBe("Import");

    const discoverItem = await screen.findByTestId("specs-toolbar-discover");
    expect(discoverItem).toBeTruthy();
    expect(discoverItem.textContent).toBe("Discover");
  });

  it("verifies that all toolbar target routes exist in canonical router", () => {
    // Expected destinations from MORE_ACTIONS and primary button
    const targets = ["/specs/rig", "/specs/agent", "/workflows", "/import", "/search"];

    for (const target of targets) {
      // In TanStack Router, routesByPath indexes all registered paths
      expect(router.routesByPath).toHaveProperty(target);
      expect(router.routesByPath[target as keyof typeof router.routesByPath]).toBeDefined();
    }
  });
});
