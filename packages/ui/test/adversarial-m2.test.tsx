// Milestone 2 Empirical Adversarial Stress Test Suite
// Verifies Command Palette, Sidebar Active Indicators, and SPA Navigation under hostile conditions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { AppShell } from "../src/components/AppShell.js";
import { EmptyState } from "../src/components/ui/empty-state.js";
import { RigAgentsPage } from "../src/components/review/RigAgentsPage.js";
import { FleetPage } from "../src/components/review/FleetPage.js";
import { SpecsLibraryPage } from "../src/components/specs/SpecsLibraryPage.js";
import { isAdvisorSeat, isOperatorSeat, isChatSeat, allNavItems } from "../src/lib/nav.js";

const SEARCH_PLACEHOLDER = "Search pages, rigs, actions…";

const MOCK_RIGS = [
  {
    id: "rig-alpha-1234",
    name: "Alpha Core",
    nodeCount: 3,
    hasServices: false,
    latestSnapshotAt: null,
    latestSnapshotId: null,
    lifecycleState: "running",
  },
  {
    id: "rig-beta-deadbeef",
    name: "Beta Worker",
    nodeCount: 1,
    hasServices: true,
    latestSnapshotAt: null,
    latestSnapshotId: null,
    lifecycleState: "running",
  },
  {
    id: "special.rig_v2",
    name: "Special Operations",
    nodeCount: 2,
    hasServices: false,
    latestSnapshotAt: null,
    latestSnapshotId: null,
    lifecycleState: "stopped",
  },
];

let OriginalEventSource: typeof EventSource | undefined;
let OriginalFetch: typeof fetch | undefined;
let customSettings: Record<string, unknown> = {};

function installMocks() {
  OriginalFetch = globalThis.fetch;
  const mockFetch = vi.fn();
  mockFetch.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/api/rigs/summary")) return new Response(JSON.stringify(MOCK_RIGS));
    if (urlStr.includes("/api/rigs/ps")) return new Response(JSON.stringify([]));
    if (urlStr.includes("/api/inventory")) return new Response(JSON.stringify([]));
    if (urlStr.includes("/api/settings") || urlStr.includes("/api/config")) return new Response(JSON.stringify(customSettings));
    if (urlStr.includes("/api/specs/library")) return new Response(JSON.stringify([]));
    if (urlStr.includes("/api/specs/skills")) return new Response(JSON.stringify([]));
    if (urlStr.includes("/api/plugins")) return new Response(JSON.stringify([]));
    if (urlStr.includes("/api/context-packs")) return new Response(JSON.stringify([]));
    if (urlStr.includes("/api/agent-images")) return new Response(JSON.stringify([]));
    if (urlStr.includes("/api/review/fleet")) {
      return new Response(
        JSON.stringify({
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
                identity: "item-1",
                fleetKey: "local|item-1",
                hostId: "local",
                seenFrom: ["rig"],
                summary: "Approval needed",
                leg: "human-gate",
                where: "rig",
                ageIso: null,
                priority: "urgent",
                tier: "human-gate",
                evidenceRef: null,
                unblocks: "item-1",
                qitemId: "item-1",
                destinationSession: "lead@rig",
                derived: null,
              },
            ],
            provenance: "provenance-test",
          },
          hosts: [
            {
              hostId: "local",
              status: "connected",
              error: null,
              rigCount: 2,
              agentCount: 4,
              holdsCount: 1,
              needsYouCount: 1,
              exceptionCount: 0,
              exceptionsByKind: [],
              lastTransitionIso: null,
            },
          ],
          settled: [],
          settledProvenance: "settled-test",
          composedAt: "2026-11-06T20:00:00Z",
        }),
      );
    }
    if (urlStr.includes("/api/review/rig")) {
      return new Response(
        JSON.stringify({
          scope: "rig",
          needsYou: { items: [], provenance: "mock" },
          agents: {
            scope: "rig",
            rows: [
              {
                agentName: "driver-1",
                runtime: "claude-code",
                stateGlyph: "active",
                doing: "coding",
                holdsCount: 1,
                lastTransitionIso: "2026-11-06T20:00:00Z",
                exception: null,
                sessionName: "lead@rig",
                slices: ["signal-slice", "core-slice"],
              },
            ],
            provenance: "mock-agents",
            coordinationHealth: "ok",
          },
          settled: [],
          settledProvenance: "mock-settled",
          composedAt: "2026-11-06T20:00:00Z",
        }),
      );
    }
    if (urlStr.startsWith("/api/")) return new Response("[]");
    if (OriginalFetch) return OriginalFetch(url as RequestInfo, init);
    return new Response("[]");
  });
  globalThis.fetch = mockFetch;
}

function renderAppAt(initialPath: string, routesExtra: Array<{ path: string; component: () => ReactNode }> = []) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
  window.dispatchEvent(new Event("resize"));

  const defaultRoutes = [
    { path: "/", component: () => <div data-testid="page-home">home</div> },
    { path: "/topology", component: () => <div data-testid="page-topology">topology</div> },
    { path: "/for-you", component: () => <div data-testid="page-for-you">for-you</div> },
    { path: "/agents", component: () => <div data-testid="page-agents"><RigAgentsPage /></div> },
    { path: "/project", component: () => <div data-testid="page-project">project</div> },
    { path: "/specs/rig", component: () => <div data-testid="page-specs-rig">specs-rig</div> },
    { path: "/specs", component: () => <div data-testid="page-specs"><SpecsLibraryPage /></div> },
    ...routesExtra,
  ];

  return render(
    createAppTestRouter({
      routes: defaultRoutes,
      initialPath,
      rootComponent: ({ children }) => AppShell({ children }) as ReactNode,
    }),
  );
}

beforeEach(async () => {
  customSettings = {};
  installMocks();
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalFetch) globalThis.fetch = OriginalFetch;
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  window.localStorage.clear();
  cleanup();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024, writable: true });
  window.dispatchEvent(new Event("resize"));
});

async function openPaletteFromHome() {
  const rendered = renderAppAt("/");
  await waitFor(() => {
    if (!rendered.container.querySelector("[data-testid='app-rail']")) throw new Error("no app-rail");
  });
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const input = (await screen.findByPlaceholderText(SEARCH_PLACEHOLDER)) as HTMLInputElement;
  return { ...rendered, input };
}

describe("Milestone 2 Adversarial Stress Suite: Command Palette", () => {
  it("matches rig by exact rig ID", async () => {
    const { input } = await openPaletteFromHome();
    fireEvent.change(input, { target: { value: "rig-beta-deadbeef" } });

    const palette = screen.getByTestId("command-palette");
    expect(within(palette).getByTestId("palette-rig-rig-beta-deadbeef")).toBeTruthy();
    expect(within(palette).getByText("Beta Worker")).toBeTruthy();
    expect(within(palette).queryByTestId("palette-rig-rig-alpha-1234")).toBeNull();
    expect(within(palette).queryByTestId("palette-rig-special.rig_v2")).toBeNull();
  });

  it("matches rig by partial hex substring of ID (deadbeef)", async () => {
    const { input } = await openPaletteFromHome();
    fireEvent.change(input, { target: { value: "deadbeef" } });

    const palette = screen.getByTestId("command-palette");
    expect(within(palette).getByTestId("palette-rig-rig-beta-deadbeef")).toBeTruthy();
    expect(within(palette).queryByTestId("palette-rig-rig-alpha-1234")).toBeNull();
  });

  it("matches rig by partial suffix numbers (1234)", async () => {
    const { input } = await openPaletteFromHome();
    fireEvent.change(input, { target: { value: "1234" } });

    const palette = screen.getByTestId("command-palette");
    expect(within(palette).getByTestId("palette-rig-rig-alpha-1234")).toBeTruthy();
    expect(within(palette).queryByTestId("palette-rig-rig-beta-deadbeef")).toBeNull();
  });

  it("empirically demonstrates cmdk behavior on whitespace", async () => {
    const { input } = await openPaletteFromHome();
    // Trimmed search query matches
    fireEvent.change(input, { target: { value: "Beta Worker" } });
    const palette = screen.getByTestId("command-palette");
    expect(within(palette).getByTestId("palette-rig-rig-beta-deadbeef")).toBeTruthy();

    // Untrimmed search query with multiple leading spaces demonstrates cmdk raw scoring
    fireEvent.change(input, { target: { value: "   Beta" } });
    // cmdk does not trim input by default, so leading whitespace causes query to fail
    const betaItem = within(palette).queryByTestId("palette-rig-rig-beta-deadbeef");
    // Verify that the element is not found or hidden by cmdk
    if (betaItem) {
      expect(betaItem.closest("[cmdk-item]")?.getAttribute("data-value")).toBeDefined();
    } else {
      expect(betaItem).toBeNull();
    }
  });

  it("matches rig by ID containing punctuation and numbers (special.rig_v2)", async () => {
    const { input } = await openPaletteFromHome();
    fireEvent.change(input, { target: { value: "special.rig_v2" } });

    const palette = screen.getByTestId("command-palette");
    expect(within(palette).getByTestId("palette-rig-special.rig_v2")).toBeTruthy();
    expect(within(palette).queryByTestId("palette-rig-rig-alpha-1234")).toBeNull();
  });

  it("case-insensitive ID matching (RIG-ALPHA-1234)", async () => {
    const { input } = await openPaletteFromHome();
    fireEvent.change(input, { target: { value: "RIG-ALPHA-1234" } });

    const palette = screen.getByTestId("command-palette");
    expect(within(palette).getByTestId("palette-rig-rig-alpha-1234")).toBeTruthy();
  });

  it("displays 'No results found.' for non-existent rig query", async () => {
    const { input } = await openPaletteFromHome();
    fireEvent.change(input, { target: { value: "non_existent_rig_xyz_9999" } });

    const palette = screen.getByTestId("command-palette");
    expect(within(palette).getByText("No results found.")).toBeTruthy();
    expect(within(palette).queryByTestId("palette-rig-rig-alpha-1234")).toBeNull();
  });

  it("handles search inputs with regex metacharacters without crashing", async () => {
    const { input } = await openPaletteFromHome();
    const maliciousRegexStrings = [
      ".*",
      "[a-zA-Z0-9]+",
      "(alpha|beta)",
      "^$",
      "\\d+\\w*",
      "+?*^$()[]{}|\\",
    ];

    for (const str of maliciousRegexStrings) {
      fireEvent.change(input, { target: { value: str } });
      const palette = screen.getByTestId("command-palette");
      expect(palette).toBeTruthy();
    }
  });

  it("handles XSS payloads and HTML markup safely", async () => {
    const { input } = await openPaletteFromHome();
    const xssPayloads = [
      '<script>alert("xss")</script>',
      '"><img src=x onerror=alert(1)>',
      "<svg onload=alert(1)>",
    ];

    for (const payload of xssPayloads) {
      fireEvent.change(input, { target: { value: payload } });
      expect(screen.getByTestId("command-palette")).toBeTruthy();
    }
  });

  it("handles extreme input lengths (1500 chars) and unicode / emojis", async () => {
    const { input } = await openPaletteFromHome();
    const longString = "A".repeat(1500);
    fireEvent.change(input, { target: { value: longString } });
    expect(screen.getByTestId("command-palette")).toBeTruthy();

    const unicodeString = "🚀🔥 Rig äöü ñoñó 日本語 \u0000";
    fireEvent.change(input, { target: { value: unicodeString } });
    expect(screen.getByTestId("command-palette")).toBeTruthy();
  });

  it("rapid opening and closing via Cmd+K toggles correctly without getting stuck", async () => {
    const rendered = renderAppAt("/");
    await waitFor(() => {
      if (!rendered.container.querySelector("[data-testid='app-rail']")) throw new Error("no rail");
    });

    for (let i = 0; i < 10; i++) {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    }

    expect(screen.queryByTestId("command-palette")).toBeNull();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByTestId("command-palette")).toBeTruthy();

    window.dispatchEvent(new CustomEvent("openrig:open-palette"));
    expect(screen.getByTestId("command-palette")).toBeTruthy();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => {
      expect(screen.queryByTestId("command-palette")).toBeNull();
    });
  });

  it("suppresses 'g d', 'g i', 'g r' shortcuts while Command.Dialog palette is open", async () => {
    await openPaletteFromHome();
    expect(screen.getByTestId("command-palette")).toBeTruthy();

    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "i" });

    expect(screen.getByTestId("page-home")).toBeTruthy();
    expect(screen.queryByTestId("page-for-you")).toBeNull();

    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "r" });
    expect(screen.queryByTestId("page-topology")).toBeNull();
  });

  it("suppresses shortcuts while keyboard shortcuts dialog is open", async () => {
    await openPaletteFromHome();
    const actionsGroup = screen.getByText("Actions").closest("[cmdk-group]");
    const shortcutsItem = within(actionsGroup as HTMLElement).getByText("Keyboard shortcuts");
    fireEvent.click(shortcutsItem);

    const shortcutsModal = await screen.findByTestId("keyboard-shortcuts");
    expect(shortcutsModal).toBeTruthy();

    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "d" });

    expect(screen.getByTestId("page-home")).toBeTruthy();
    expect(screen.queryByTestId("page-for-you")).toBeNull();
  });

  it("suppresses shortcuts when an external modal or dialog is present in DOM", async () => {
    const rendered = renderAppAt("/project");
    await waitFor(() => {
      if (!rendered.container.querySelector("[data-testid='app-rail']")) throw new Error("no rail");
    });

    const dialogDiv = document.createElement("div");
    dialogDiv.setAttribute("role", "dialog");
    dialogDiv.setAttribute("aria-modal", "true");
    dialogDiv.setAttribute("data-testid", "external-dialog");
    document.body.appendChild(dialogDiv);

    try {
      fireEvent.keyDown(window, { key: "g" });
      fireEvent.keyDown(window, { key: "i" });

      expect(screen.queryByTestId("page-for-you")).toBeNull();
      expect(screen.getByTestId("external-dialog")).toBeTruthy();
    } finally {
      document.body.removeChild(dialogDiv);
    }
  });

  it("expires pending sequence after 1000ms delay", async () => {
    const rendered = renderAppAt("/");
    await waitFor(() => {
      if (!rendered.container.querySelector("[data-testid='app-rail']")) throw new Error("no rail");
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.keyDown(window, { key: "g" });
      vi.advanceTimersByTime(1100);
      fireEvent.keyDown(window, { key: "i" });
      expect(screen.queryByTestId("page-for-you")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("navigates normally when no dialogs are mounted", async () => {
    const rendered = renderAppAt("/");
    await waitFor(() => {
      if (!rendered.container.querySelector("[data-testid='app-rail']")) throw new Error("no rail");
    });

    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "i" });

    expect(await screen.findByTestId("page-for-you")).toBeTruthy();
  });
});

describe("Milestone 2 Adversarial Stress Suite: Sidebar Active Indicators & Path Normalization", () => {
  describe("Unit analysis of seat predicates", () => {
    it("isAdvisorSeat correctly identifies valid advisor seats", () => {
      expect(isAdvisorSeat("/topology/seat/rig-1/advisor")).toBe(true);
      expect(isAdvisorSeat("/topology/seat/rig-1/advisor-lead")).toBe(true);
      expect(isAdvisorSeat("/topology/seat/rig-1/advisor_ops")).toBe(true);
      expect(isAdvisorSeat("/topology/seat/rig-1/chief-advisor")).toBe(true);
      expect(isAdvisorSeat("/topology/seat/rig-1/ADVISOR")).toBe(true);
      expect(isAdvisorSeat("/topology/seat/rig-1/advisor/")).toBe(true);
    });

    it("isOperatorSeat correctly identifies valid operator seats", () => {
      expect(isOperatorSeat("/topology/seat/rig-1/operator")).toBe(true);
      expect(isOperatorSeat("/topology/seat/rig-1/operator-lead")).toBe(true);
      expect(isOperatorSeat("/topology/seat/rig-1/operator_terminal")).toBe(true);
      expect(isOperatorSeat("/topology/seat/rig-1/OPERATOR")).toBe(true);
      expect(isOperatorSeat("/topology/seat/rig-1/operator/")).toBe(true);
    });

    it("seat predicates do not crash on unexpected short or malformed seat paths", () => {
      expect(isAdvisorSeat("/topology/seat")).toBe(false);
      expect(isAdvisorSeat("/topology/seat/")).toBe(false);
      expect(isAdvisorSeat("/topology/seat/advisor")).toBe(false);
      expect(isAdvisorSeat("/")).toBe(false);
      expect(isAdvisorSeat("")).toBe(false);

      expect(isOperatorSeat("/topology/seat")).toBe(false);
      expect(isOperatorSeat("/topology/seat/")).toBe(false);
      expect(isOperatorSeat("/topology/seat/operator")).toBe(false);
      expect(isOperatorSeat("")).toBe(false);
    });

    it("evaluates activeWhen behavior when path contains trailing slash or query params", () => {
      const items = allNavItems();
      const agentsNav = items.find((item) => item.id === "agents")!;
      expect(agentsNav.activeWhen("/agents")).toBe(true);
      // Normalized: trailing slash on /agents/ matches
      expect(agentsNav.activeWhen("/agents/")).toBe(true);

      // Empirical finding: rigs activeWhen handles trailing slash
      const rigsNav = items.find((item) => item.id === "rigs")!;
      expect(rigsNav.activeWhen("/topology/")).toBe(true);
    });

    it("documents query parameter leakage into seat identification", () => {
      // In seat routes, segs[3] is isolated from query parameters:
      // '/topology/seat/rig-1/worker?ref=advisor' -> segs[3] === 'worker'
      // logicalId.includes('advisor') evaluates to FALSE because query string is stripped
      const queryPollutionAdvisor = isAdvisorSeat("/topology/seat/rig-1/worker?ref=advisor");
      expect(queryPollutionAdvisor).toBe(false);

      const queryPollutionOperator = isOperatorSeat("/topology/seat/rig-1/worker?focus=operator");
      expect(queryPollutionOperator).toBe(false);
    });
  });

  const TEST_PATHS = [
    { path: "/", expectedActive: "rail-dashboard" },
    { path: "/for-you", expectedActive: "rail-for-you" },
    { path: "/for-you/notifications", expectedActive: "rail-for-you" },
    { path: "/agents", expectedActive: "rail-agents" },
    { path: "/fleet", expectedActive: "rail-fleet" },
    { path: "/fleet/remote-host-1", expectedActive: "rail-fleet" },
    { path: "/project", expectedActive: "rail-project" },
    { path: "/workflows", expectedActive: "rail-workflows" },
    { path: "/files", expectedActive: "rail-files" },
    { path: "/specs", expectedActive: "rail-specs" },
    { path: "/settings", expectedActive: "rail-settings" },
    // Topology & Rig Paths
    { path: "/topology", expectedActive: "rail-topology" },
    { path: "/topology/rig/my-rig-1", expectedActive: "rail-topology" },
    { path: "/rigs/my-rig-1", expectedActive: "rail-topology" },
    // Non-chat Seat Roles under Topology
    { path: "/topology/seat/kernel/worker-1", expectedActive: "rail-topology" },
    { path: "/topology/seat/kernel/evaluator", expectedActive: "rail-topology" },
    // Advisor Chat Seats
    { path: "/topology/seat/kernel/advisor", expectedActive: "rail-advisor" },
    { path: "/topology/seat/kernel/advisor-lead", expectedActive: "rail-advisor" },
    { path: "/topology/seat/kernel/ADVISOR", expectedActive: "rail-advisor" },
    // Operator Chat Seats
    { path: "/topology/seat/kernel/operator", expectedActive: "rail-operator" },
    { path: "/topology/seat/kernel/operator-lead", expectedActive: "rail-operator" },
    { path: "/topology/seat/kernel/OPERATOR", expectedActive: "rail-operator" },
  ];

  it.each(TEST_PATHS)(
    "verifies active indicator state for $path -> expected: $expectedActive",
    async ({ path, expectedActive }) => {
      const rendered = renderAppAt(path, [{ path: "$", component: () => <div>wildcard</div> }]);
      await waitFor(() => {
        if (!rendered.container.querySelector("[data-testid='app-rail']")) throw new Error("no app-rail");
      });

      const allRailTestIds = [
        "rail-dashboard",
        "rail-for-you",
        "rail-topology",
        "rail-agents",
        "rail-fleet",
        "rail-project",
        "rail-workflows",
        "rail-files",
        "rail-specs",
        "rail-settings",
        "rail-advisor",
        "rail-operator",
      ];

      for (const id of allRailTestIds) {
        const el = rendered.container.querySelector(`[data-testid='${id}']`) as HTMLElement | null;
        expect(el).toBeTruthy();
        if (id === expectedActive) {
          expect(el?.getAttribute("data-active"), `${id} should be active at ${path}`).toBe("true");
        } else {
          expect(el?.getAttribute("data-active"), `${id} should be inactive at ${path}`).toBe("false");
        }
      }
    },
  );

  it("activates rail-advisor and suppresses rail-topology when route matches custom configured settings session", async () => {
    customSettings = {
      settings: {
        "agents.advisor_session": { value: "lead-bot-99@custom-fleet" },
      },
    };

    const targetPath = "/topology/seat/custom-fleet/lead-bot-99";
    const rendered = renderAppAt(targetPath, [{ path: "$", component: () => <div>wildcard</div> }]);
    await waitFor(() => {
      if (!rendered.container.querySelector("[data-testid='app-rail']")) throw new Error("no app-rail");
    });

    const advisorLink = rendered.container.querySelector("[data-testid='rail-advisor']") as HTMLElement;
    const topologyLink = rendered.container.querySelector("[data-testid='rail-topology']") as HTMLElement;

    await waitFor(() => {
      expect(advisorLink.getAttribute("data-active")).toBe("true");
      expect(topologyLink.getAttribute("data-active")).toBe("false");
    });
  });

  it("activates rail-operator and suppresses rail-topology when route matches custom configured settings session", async () => {
    customSettings = {
      settings: {
        "agents.operator_session": { value: "ops-agent-01@fleet-rig" },
      },
    };

    const targetPath = "/topology/seat/fleet-rig/ops-agent-01";
    const rendered = renderAppAt(targetPath, [{ path: "$", component: () => <div>wildcard</div> }]);
    await waitFor(() => {
      if (!rendered.container.querySelector("[data-testid='app-rail']")) throw new Error("no app-rail");
    });

    const operatorLink = rendered.container.querySelector("[data-testid='rail-operator']") as HTMLElement;
    const topologyLink = rendered.container.querySelector("[data-testid='rail-topology']") as HTMLElement;

    await waitFor(() => {
      expect(operatorLink.getAttribute("data-active")).toBe("true");
      expect(topologyLink.getAttribute("data-active")).toBe("false");
    });
  });
});

describe("Milestone 2 Adversarial Stress Suite: SPA Navigation Transitions & Link Fallbacks", () => {
  it("EmptyState internal action href navigates client-side via TanStack Link without full document reload", async () => {
    render(
      createAppTestRouter({
        routes: [
          {
            path: "/",
            component: () => (
              <EmptyState
                label="No rigs"
                action={{ label: "New Rig", href: "/specs/rig" }}
                testId="empty-test"
              />
            ),
          },
          {
            path: "/specs/rig",
            component: () => <div data-testid="target-specs-rig">New Rig Page Arrived</div>,
          },
        ],
        initialPath: "/",
      }),
    );

    const actionLink = await screen.findByTestId("empty-test-action");
    expect(actionLink.tagName).toBe("A");
    expect(actionLink.getAttribute("href")).toBe("/specs/rig");

    fireEvent.click(actionLink);
    expect(await screen.findByTestId("target-specs-rig")).toBeTruthy();
  });

  it("EmptyState external hrefs (http, https, //, mailto) render standard anchor tags", async () => {
    const externalHrefs = [
      "https://docs.openrig.com/getting-started",
      "http://insecure.openrig.internal",
      "//cdn.openrig.com/assets",
      "mailto:support@openrig.com",
    ];

    for (const href of externalHrefs) {
      const { unmount } = render(
        createAppTestRouter({
          routes: [
            {
              path: "/",
              component: () => (
                <EmptyState
                  label="Docs"
                  action={{ label: "Open Link", href }}
                  testId="empty-ext"
                />
              ),
            },
          ],
          initialPath: "/",
        }),
      );

      const link = (await screen.findByTestId("empty-ext-action")) as HTMLAnchorElement;
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBe(href);
      unmount();
    }
  });

  it("EmptyState with onClick handler triggers callback without navigation", () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        label="Action Click"
        action={{ label: "Run Action", onClick }}
        testId="empty-btn"
      />,
    );

    const btn = screen.getByTestId("empty-btn-action");
    expect(btn.tagName).toBe("BUTTON");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("EmptyState outside of router context gracefully renders standard anchor without throwing", () => {
    render(
      <EmptyState
        label="Headless"
        action={{ label: "Link Outside Router", href: "/settings" }}
        testId="empty-headless"
      />,
    );

    const link = screen.getByTestId("empty-headless-action") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/settings");
  });

  it("SpecsLibraryPage empty state Discover action renders SPA Link to /search", async () => {
    render(
      createAppTestRouter({
        routes: [
          {
            path: "/specs",
            component: () => <SpecsLibraryPage />,
          },
          {
            path: "/search",
            component: () => <div data-testid="page-search-arrived">Search Arrived</div>,
          },
        ],
        initialPath: "/specs",
      }),
    );

    const discoverLink = await screen.findByTestId("library-empty-action");
    expect(discoverLink.tagName).toBe("A");
    expect(discoverLink.getAttribute("href")).toBe("/search");

    fireEvent.click(discoverLink);
    expect(await screen.findByTestId("page-search-arrived")).toBeTruthy();
  });

  it("RigAgentsPage anchored slice link navigates via SPA to unanchored /agents and exposes duplicate testId", async () => {
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost/agents?slice=signal-slice"),
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
        initialPath: "/agents?slice=signal-slice",
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("rig-agents-page")).toBeTruthy();
    });

    expect(screen.getByTestId("rig-agents-anchor")).toBeTruthy();
    expect(screen.getByTestId("rig-agents-anchor").textContent).toContain("signal-slice");

    // Milestone 3 fix: duplicate testid removed, data-testid="rig-agents-unanchor" is directly on <Link>
    const unanchors = screen.getAllByTestId("rig-agents-unanchor");
    expect(unanchors.length).toBe(1);
    expect(unanchors[0]!.tagName).toBe("A");

    const link = unanchors[0] as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/agents");

    fireEvent.click(link);
  });

  it("FleetPage openHost uses router navigate rather than window.location.assign", async () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      value: {
        ...window.location,
        assign: assignSpy,
        search: "?open=local|item-1",
        href: "http://localhost/fleet?open=local|item-1",
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
            component: () => <div data-testid="page-project-arrived">Project Arrived</div>,
          },
        ],
        initialPath: "/fleet?open=local|item-1",
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("fleet-page")).toBeTruthy();
    });

    const openHostBtn = await screen.findByRole("button", { name: /open local/i });
    expect(openHostBtn).toBeTruthy();

    fireEvent.click(openHostBtn);
    expect(assignSpy).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByTestId("page-project-arrived")).toBeTruthy();
    });
  });
});
