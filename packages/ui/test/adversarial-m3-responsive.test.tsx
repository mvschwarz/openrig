// Milestone 3 Adversarial Stress Test Suite
// Rigorous empirical verification of:
// 1. Mobile Clearance & Responsive Scaling (UndoToast, VellumSheet, Toaster)
// 2. Mobile/Tablet AgentPropertiesPanel Accessibility & Drawer Mechanics
// 3. Concurrency Protection in HostConfigCard
// 4. Mutation Feedback Toasts (useExpandRig, useRemoveLibrarySpec, useRenameLibrarySpec)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { hoistedState } = vi.hoisted(() => ({
  hoistedState: {
    mutateAsyncSpy: vi.fn(async () => ({})),
    setSettingPending: false,
    settingsData: {} as Record<string, unknown>,
  },
}));

vi.mock("../src/hooks/useSettings.js", () => ({
  useSettings: () => ({ data: { settings: hoistedState.settingsData } }),
  useSetSetting: () => ({
    mutateAsync: hoistedState.mutateAsyncSpy,
    isPending: hoistedState.setSettingPending,
  }),
}));

import { UndoToast } from "../src/components/for-you/UndoToast.js";
import { VellumSheet } from "../src/components/ui/vellum-sheet.js";
import { AgentPropertiesPanel } from "../src/components/AgentPropertiesPanel.js";
import { LiveNodeDetails } from "../src/components/LiveNodeDetails.js";
import { HostConfigCard } from "../src/components/dashboard/HostConfigCard.js";
import { AppShell } from "../src/components/AppShell.js";
import {
  useExpandRig,
  useRemoveLibrarySpec,
  useRenameLibrarySpec,
} from "../src/hooks/mutations.js";
import * as notifyModule from "../src/lib/notify.js";
import { createTestRouter, createAppTestRouter } from "./helpers/test-router.js";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { resetTopologyActivityStoreForTests } from "../src/hooks/useTopologyActivity.js";

const mockFetch = vi.fn();
let OriginalEventSource: typeof EventSource | undefined;
let OriginalFetch: typeof fetch | undefined;
let currentSelectedHost = "local";

// Mock node detail for LiveNodeDetails and AgentPropertiesPanel tests
const MOCK_NODE_DETAIL = {
  rigId: "rig-adversarial",
  rigName: "adversarial-rig",
  logicalId: "worker.adversary",
  podId: "worker",
  canonicalSessionName: "worker-adversary@adversarial-rig",
  nodeKind: "agent",
  runtime: "claude-code",
  sessionStatus: "running",
  startupStatus: "ready",
  restoreOutcome: "n-a",
  tmuxAttachCommand: "tmux attach -t worker-adversary@adversarial-rig",
  resumeCommand: "rig resume worker.adversary",
  latestError: null,
  model: "opus-4",
  agentRef: "local:agents/adversary",
  profile: "default",
  resolvedSpecName: "adversary",
  resolvedSpecVersion: "1.0.0",
  cwd: "/workspace",
  startupFiles: [],
  startupActions: [],
  recentEvents: [],
  infrastructureStartupCommand: null,
  peers: [{ logicalId: "worker.peer", canonicalSessionName: "worker-peer@adversarial-rig", runtime: "codex" }],
  edges: { outgoing: [], incoming: [] },
  transcript: { enabled: false, path: null, tailCommand: null },
  compactSpec: { name: "adversary", version: "1.0.0", profile: "default", skillCount: 3, guidanceCount: 2 },
  agentActivity: {
    state: "running",
    reason: "stress-test",
    evidenceSource: "runtime_hook",
    sampledAt: "2026-11-07T01:30:00Z",
    evidence: "execution",
  },
  currentQitems: [
    {
      qitemId: "qitem-stress-01",
      bodyExcerpt: "Stress testing mobile accessibility drawer",
      tier: "mode-2",
    },
  ],
  contextUsage: {
    availability: "known",
    usedPercentage: 74,
    remainingPercentage: 26,
    contextWindowSize: 200000,
    sampledAt: "2026-11-07T01:30:00Z",
    fresh: true,
    totalInputTokens: 148000,
    totalOutputTokens: 12000,
  },
};

function defaultMockImplementation(url: string | URL | Request) {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  if (urlStr.includes("/api/rigs/summary")) return { ok: true, json: async () => [] };
  if (urlStr.includes("/api/rigs/ps")) return { ok: true, json: async () => [] };
  if (urlStr.includes("/api/inventory")) return { ok: true, json: async () => [] };
  if (urlStr.includes("/api/hosts")) {
    return {
      ok: true,
      json: async () => ({
        ownName: "localhost",
        selected: currentSelectedHost,
        hosts: [
          {
            id: "remote-host-77",
            transport: "http",
            url: "http://vps-77:7433",
            selected: currentSelectedHost === "remote-host-77",
            status: "reachable",
          },
        ],
      }),
    };
  }
  if (urlStr.includes("/nodes/")) {
    return { ok: true, json: async () => MOCK_NODE_DETAIL };
  }
  if (urlStr.includes("/api/specs/library")) {
    return { ok: true, json: async () => [] };
  }
  if (urlStr.includes("/api/review/fleet")) {
    return {
      ok: true,
      json: async () => ({
        rollup: { needsYouCount: 0, exceptionCount: 0, exceptionsByKind: [], hostCount: 1, unreachableCount: 0 },
        needsYou: { items: [], provenance: "mock" },
        hosts: [],
        settled: [],
        settledProvenance: "mock",
        composedAt: "2026-11-07T00:00:00Z",
      }),
    };
  }
  return { ok: true, json: async () => ({}) };
}

describe("Adversarial Milestone 3: UndoToast Positioning & Interaction Resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("ADV-UT-1: verifies responsive classes: bottom-20 (<1024px clearance) and lg:bottom-6 (desktop)", () => {
    render(
      <UndoToast
        label="Item dismissed"
        onUndo={() => {}}
        onExpire={() => {}}
        durationMs={5000}
      />
    );
    const toast = screen.getByTestId("undo-toast");
    expect(toast).toBeTruthy();
    expect(toast.className).toContain("fixed");
    // Mobile clearance: bottom-20 (80px / 5rem) clears 56px bottom nav
    expect(toast.className).toContain("bottom-20");
    // Desktop anchoring: lg:bottom-6 (24px / 1.5rem)
    expect(toast.className).toContain("lg:bottom-6");
    expect(toast.className).toContain("z-50");
    expect(toast.className).toContain("left-1/2");
    expect(toast.className).toContain("-translate-x-1/2");
  });

  it("ADV-UT-2: rapid spam clicking Undo invokes onUndo exactly once and suppresses onExpire", () => {
    const onUndo = vi.fn();
    const onExpire = vi.fn();
    render(
      <UndoToast
        label="Spam click protection"
        onUndo={onUndo}
        onExpire={onExpire}
        durationMs={4000}
      />
    );
    const button = screen.getByTestId("undo-toast-button");
    // Fire 5 rapid clicks
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onUndo).toHaveBeenCalledTimes(1);

    // Fast-forward past durationMs
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(onExpire).not.toHaveBeenCalled();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("ADV-UT-3: handles durationMs=0 edge condition gracefully", () => {
    const onExpire = vi.fn();
    render(
      <UndoToast
        label="Immediate expiration"
        onUndo={() => {}}
        onExpire={onExpire}
        durationMs={0}
      />
    );
    expect(onExpire).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("ADV-UT-4: survives hostile labels (empty string, massive string, html/unicode entities)", () => {
    const hostileLabels = [
      "",
      "A".repeat(1200),
      "<script>alert('xss')</script>",
      "🚀🔥🎉 Mobile clearance verified with unicode! \u0000\u001f",
    ];

    for (const label of hostileLabels) {
      const { unmount } = render(
        <UndoToast
          label={label}
          onUndo={() => {}}
          onExpire={() => {}}
          durationMs={3000}
        />
      );
      const toast = screen.getByTestId("undo-toast");
      expect(toast).toBeTruthy();
      expect(toast.getAttribute("role")).toBe("status");
      expect(toast.getAttribute("aria-live")).toBe("polite");
      unmount();
    }
  });

  it("ADV-UT-5: unmounting before expiration clears timeout cleanly without callback", () => {
    const onExpire = vi.fn();
    const { unmount } = render(
      <UndoToast
        label="Unmount test"
        onUndo={() => {}}
        onExpire={onExpire}
        durationMs={3000}
      />
    );
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe("Adversarial Milestone 3: VellumSheet Clearance & Layout Resilience", () => {
  afterEach(() => cleanup());

  it("ADV-VS-1: applies pb-16 lg:pb-0 across wide and narrow width variants", () => {
    const widths: Array<"wide" | "narrow"> = ["wide", "narrow"];
    for (const width of widths) {
      const { container, unmount } = render(
        <VellumSheet width={width} testId={`vs-test-${width}`}>
          <div>Content</div>
        </VellumSheet>
      );
      const el = container.querySelector(`[data-testid='vs-test-${width}']`) as HTMLElement;
      expect(el).toBeTruthy();
      expect(el.className).toContain("pb-16");
      expect(el.className).toContain("lg:pb-0");
      expect(el.className).toContain("vellum-heavy");
      if (width === "wide") {
        expect(el.className).toContain("lg:w-[38rem]");
      } else {
        expect(el.className).toContain("lg:w-[22rem]");
      }
      unmount();
    }
  });

  it("ADV-VS-2: applies pb-16 lg:pb-0 across left and right edge variants", () => {
    const edges: Array<"left" | "right"> = ["left", "right"];
    for (const edge of edges) {
      const { container, unmount } = render(
        <VellumSheet edge={edge} testId={`vs-edge-${edge}`}>
          <div>Content</div>
        </VellumSheet>
      );
      const el = container.querySelector(`[data-testid='vs-edge-${edge}']`) as HTMLElement;
      expect(el).toBeTruthy();
      expect(el.className).toContain("pb-16");
      expect(el.className).toContain("lg:pb-0");
      if (edge === "left") {
        expect(el.className).toContain("border-r");
      } else {
        expect(el.className).toContain("border-l");
      }
      unmount();
    }
  });

  it("ADV-VS-3: custom className merges via cn without losing base pb-16 lg:pb-0", () => {
    const { container } = render(
      <VellumSheet className="custom-sheet-padding extra-class" testId="vs-custom">
        <div>Custom Sheet</div>
      </VellumSheet>
    );
    const el = container.querySelector("[data-testid='vs-custom']") as HTMLElement;
    expect(el.className).toContain("custom-sheet-padding");
    expect(el.className).toContain("extra-class");
    expect(el.className).toContain("pb-16");
    expect(el.className).toContain("lg:pb-0");
  });

  it("ADV-VS-4: verifies accessibility attributes and close affordance lifecycle", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <VellumSheet onClose={onClose} testId="vs-a11y">
        <div>A11y Check</div>
      </VellumSheet>
    );
    const el = screen.getByTestId("vs-a11y");
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("false");

    const closeBtn = screen.getByTestId("vs-a11y-close");
    expect(closeBtn.getAttribute("aria-label")).toBe("Close sheet");
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();

    // When onClose is omitted, close button is strictly absent
    render(<VellumSheet testId="vs-no-close">No Close</VellumSheet>);
    expect(screen.queryByTestId("vs-no-close-close")).toBeNull();
  });
});

describe("Adversarial Milestone 3: AppShell Toaster Mobile Offset Verification", () => {
  beforeEach(() => {
    currentSelectedHost = "local";
    hoistedState.setSettingPending = false;
    hoistedState.settingsData = {};
    OriginalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    mockFetch.mockImplementation(defaultMockImplementation);
    OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  });

  afterEach(() => {
    if (OriginalFetch) globalThis.fetch = OriginalFetch;
    if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
    cleanup();
  });

  it("ADV-TOASTER-1: verifies AppShell renders Toaster with mobile bottom clearance class max-lg:!bottom-20 and mobileOffset 5rem", async () => {
    render(
      createAppTestRouter({
        routes: [{ path: "/", component: () => <div data-testid="test-home">Home</div> }],
        initialPath: "/",
        rootComponent: ({ children }) => AppShell({ children }) as ReactNode,
      })
    );

    await screen.findByTestId("test-home");

    // Trigger toast to instantiate Sonner's <ol data-sonner-toaster>
    const { toast } = await import("sonner");
    await act(async () => {
      toast("Mobile clearance check");
      await new Promise((r) => setTimeout(r, 50));
    });

    // Sonner Toaster container in DOM
    const toaster = document.querySelector("[data-sonner-toaster]") as HTMLElement | null;
    expect(toaster).toBeTruthy();
    expect(toaster?.className).toContain("max-lg:!bottom-20");
    expect(toaster?.getAttribute("style")).toContain("--mobile-offset-bottom: 5rem");
  });
});

describe("Adversarial Milestone 3: AgentPropertiesPanel Component State & Edge Cases", () => {
  beforeEach(() => {
    currentSelectedHost = "local";
    OriginalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    mockFetch.mockImplementation(defaultMockImplementation);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (OriginalFetch) globalThis.fetch = OriginalFetch;
    cleanup();
    vi.restoreAllMocks();
  });

  it("ADV-APP-1: renders close button in skeleton loading state when onClose is provided", async () => {
    // Hang fetch for node detail so it stays in loading state
    mockFetch.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/nodes/")) {
        return new Promise(() => {});
      }
      return defaultMockImplementation(url);
    });

    const onClose = vi.fn();
    render(
      createTestRouter({
        component: () => (
          <AgentPropertiesPanel
            rigId="rig-test"
            logicalId="agent-test"
            className="custom-loading-class"
            onClose={onClose}
          />
        ),
        path: "/test",
      })
    );

    const panel = await screen.findByTestId("agent-properties");
    expect(panel.className).toContain("custom-loading-class");
    const closeBtn = screen.getByTestId("agent-properties-close");
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ADV-APP-2: renders close button in error state when onClose is provided", async () => {
    mockFetch.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/nodes/")) {
        throw new Error("Simulated network failure");
      }
      return defaultMockImplementation(url);
    });

    const onClose = vi.fn();
    render(
      createTestRouter({
        component: () => (
          <AgentPropertiesPanel
            rigId="rig-test"
            logicalId="agent-test"
            className="custom-error-class"
            onClose={onClose}
          />
        ),
        path: "/test",
      })
    );

    await screen.findByText("Couldn't load this agent");
    const panel = screen.getByTestId("agent-properties");
    expect(panel.className).toContain("custom-error-class");
    const closeBtn = screen.getByTestId("agent-properties-close");
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ADV-APP-3: clamps extreme context usage values (<0% to 0%, >100% to 100%) and handles null", async () => {
    // Subcase 1: Context usage > 100% (e.g. 165% overrun)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...MOCK_NODE_DETAIL,
        contextUsage: { ...MOCK_NODE_DETAIL.contextUsage, usedPercentage: 165 },
      }),
    });

    const { unmount } = render(
      createTestRouter({
        component: () => <AgentPropertiesPanel rigId="rig-test" logicalId="agent-test" />,
        path: "/test",
      })
    );

    await screen.findByText("165%");
    // The style width for the bar must be clamped to 100%
    const bar = screen.getByText("165%").parentElement?.querySelector(".bg-brand") as HTMLElement;
    expect(bar.style.width).toBe("100%");
    unmount();

    // Subcase 2: Context usage < 0% (e.g. -25% anomalous metric)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...MOCK_NODE_DETAIL,
        contextUsage: { ...MOCK_NODE_DETAIL.contextUsage, usedPercentage: -25 },
      }),
    });

    const { unmount: unmount2 } = render(
      createTestRouter({
        component: () => <AgentPropertiesPanel rigId="rig-test" logicalId="agent-test" />,
        path: "/test",
      })
    );

    await screen.findByText("-25%");
    const barNegative = screen.getByText("-25%").parentElement?.querySelector(".bg-brand") as HTMLElement;
    expect(barNegative.style.width).toBe("0%");
    unmount2();

    // Subcase 3: Context usage null
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...MOCK_NODE_DETAIL,
        contextUsage: null,
      }),
    });

    render(
      createTestRouter({
        component: () => <AgentPropertiesPanel rigId="rig-test" logicalId="agent-test" />,
        path: "/test",
      })
    );

    await screen.findByText("--");
  });

  it("ADV-APP-4: handles missing optional fields (no canonicalSessionName, no error, no qitems)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...MOCK_NODE_DETAIL,
        canonicalSessionName: null,
        latestError: null,
        currentQitems: [],
        tmuxAttachCommand: null,
      }),
    });

    render(
      createTestRouter({
        component: () => <AgentPropertiesPanel rigId="rig-test" logicalId="agent-test" />,
        path: "/test",
      })
    );

    await screen.findByText("None"); // Current work "None"
    expect(screen.queryByTestId("agent-properties-copy-session")).toBeNull();
    expect(screen.queryByTestId("agent-properties-copy-attach")).toBeNull();
  });
});

describe("Adversarial Milestone 3: LiveNodeDetails Mobile Drawer & Modal Mechanics", () => {
  beforeEach(() => {
    currentSelectedHost = "local";
    OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
    resetTopologyActivityStoreForTests();
    OriginalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    mockFetch.mockImplementation(defaultMockImplementation);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (OriginalFetch) globalThis.fetch = OriginalFetch;
    if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  });

  it("ADV-LND-1: detail-open-properties button is styled with lg:hidden in LOCAL host state", async () => {
    currentSelectedHost = "local";
    render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-adversarial" logicalId="worker.adversary" />,
        path: "/topology/seat/$rigId/$logicalId",
        initialPath: "/topology/seat/rig-adversarial/worker.adversary",
      })
    );

    const btn = await screen.findByTestId("detail-open-properties");
    expect(btn).toBeTruthy();
    expect(btn.className).toContain("lg:hidden");
    expect(btn.getAttribute("aria-label")).toBe("Inspect agent properties");
  });

  it("ADV-LND-2: detail-open-properties button is styled with lg:hidden in REMOTE host state", async () => {
    currentSelectedHost = "remote-host-77";
    render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-adversarial" logicalId="worker.adversary" />,
        path: "/topology/seat/$rigId/$logicalId",
        initialPath: "/topology/seat/rig-adversarial/worker.adversary",
      })
    );

    await screen.findByTestId("live-node-actions-remote-readonly");
    const btn = screen.getByTestId("detail-open-properties");
    expect(btn).toBeTruthy();
    expect(btn.className).toContain("lg:hidden");
  });

  it("ADV-LND-3: clicking inspect opens drawer overlay with proper a11y, pb-16 clearance, and close button", async () => {
    currentSelectedHost = "local";
    render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-adversarial" logicalId="worker.adversary" />,
        path: "/topology/seat/$rigId/$logicalId",
        initialPath: "/topology/seat/rig-adversarial/worker.adversary",
      })
    );

    const openBtn = await screen.findByTestId("detail-open-properties");
    fireEvent.click(openBtn);

    const drawer = screen.getByTestId("agent-properties-drawer");
    expect(drawer).toBeTruthy();
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(drawer.getAttribute("aria-label")).toBe("Properties");
    expect(drawer.className).toContain("fixed");
    expect(drawer.className).toContain("inset-0");
    expect(drawer.className).toContain("z-50");
    expect(drawer.className).toContain("lg:hidden");

    const backdrop = screen.getByTestId("agent-properties-drawer-backdrop");
    expect(backdrop).toBeTruthy();

    const panelContainer = screen.getByTestId("agent-properties-drawer-panel");
    expect(panelContainer).toBeTruthy();
    // Verify 64px (pb-16) bottom clearance to avoid bottom nav bar
    expect(panelContainer.className).toContain("pb-16");
    expect(panelContainer.className).toContain("border-outline-variant");

    // Close button inside drawer
    const closeBtn = screen.getByTestId("agent-properties-close");
    expect(closeBtn).toBeTruthy();
  });

  it("ADV-LND-4: dismisses drawer on close button [×] click", async () => {
    currentSelectedHost = "local";
    render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-adversarial" logicalId="worker.adversary" />,
        path: "/topology/seat/$rigId/$logicalId",
        initialPath: "/topology/seat/rig-adversarial/worker.adversary",
      })
    );

    fireEvent.click(await screen.findByTestId("detail-open-properties"));
    expect(screen.getByTestId("agent-properties-drawer")).toBeTruthy();

    fireEvent.click(screen.getByTestId("agent-properties-close"));
    expect(screen.queryByTestId("agent-properties-drawer")).toBeNull();
  });

  it("ADV-LND-5: dismisses drawer on backdrop click", async () => {
    currentSelectedHost = "local";
    render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-adversarial" logicalId="worker.adversary" />,
        path: "/topology/seat/$rigId/$logicalId",
        initialPath: "/topology/seat/rig-adversarial/worker.adversary",
      })
    );

    fireEvent.click(await screen.findByTestId("detail-open-properties"));
    expect(screen.getByTestId("agent-properties-drawer")).toBeTruthy();

    fireEvent.click(screen.getByTestId("agent-properties-drawer-backdrop"));
    expect(screen.queryByTestId("agent-properties-drawer")).toBeNull();
  });

  it("ADV-LND-6: dismisses drawer on Escape keydown", async () => {
    currentSelectedHost = "local";
    render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-adversarial" logicalId="worker.adversary" />,
        path: "/topology/seat/$rigId/$logicalId",
        initialPath: "/topology/seat/rig-adversarial/worker.adversary",
      })
    );

    fireEvent.click(await screen.findByTestId("detail-open-properties"));
    expect(screen.getByTestId("agent-properties-drawer")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("agent-properties-drawer")).toBeNull();
  });

  it("ADV-LND-7: ignores non-Escape keys (Enter, Space, Tab) and keeps drawer open", async () => {
    currentSelectedHost = "local";
    render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-adversarial" logicalId="worker.adversary" />,
        path: "/topology/seat/$rigId/$logicalId",
        initialPath: "/topology/seat/rig-adversarial/worker.adversary",
      })
    );

    fireEvent.click(await screen.findByTestId("detail-open-properties"));
    expect(screen.getByTestId("agent-properties-drawer")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: " " });
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.keyDown(window, { key: "g" });

    expect(screen.getByTestId("agent-properties-drawer")).toBeTruthy();
  });

  it("ADV-LND-8: clicks inside drawer panel do NOT dismiss drawer", async () => {
    currentSelectedHost = "local";
    render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-adversarial" logicalId="worker.adversary" />,
        path: "/topology/seat/$rigId/$logicalId",
        initialPath: "/topology/seat/rig-adversarial/worker.adversary",
      })
    );

    fireEvent.click(await screen.findByTestId("detail-open-properties"));
    const panel = screen.getByTestId("agent-properties-drawer-panel");

    // Click inside the panel
    fireEvent.click(panel);
    expect(screen.getByTestId("agent-properties-drawer")).toBeTruthy();
  });

  it("ADV-LND-9: rapid cycling of drawer open/close mechanisms preserves state consistency", async () => {
    currentSelectedHost = "local";
    render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-adversarial" logicalId="worker.adversary" />,
        path: "/topology/seat/$rigId/$logicalId",
        initialPath: "/topology/seat/rig-adversarial/worker.adversary",
      })
    );

    const openBtn = await screen.findByTestId("detail-open-properties");

    // Cycle 1: Open -> Close button
    fireEvent.click(openBtn);
    expect(screen.getByTestId("agent-properties-drawer")).toBeTruthy();
    fireEvent.click(screen.getByTestId("agent-properties-close"));
    expect(screen.queryByTestId("agent-properties-drawer")).toBeNull();

    // Cycle 2: Open -> Backdrop
    fireEvent.click(openBtn);
    expect(screen.getByTestId("agent-properties-drawer")).toBeTruthy();
    fireEvent.click(screen.getByTestId("agent-properties-drawer-backdrop"));
    expect(screen.queryByTestId("agent-properties-drawer")).toBeNull();

    // Cycle 3: Open -> Escape
    fireEvent.click(openBtn);
    expect(screen.getByTestId("agent-properties-drawer")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("agent-properties-drawer")).toBeNull();
  });

  it("ADV-LND-10: desktop layout retains hidden lg:block sidebar without close button", async () => {
    currentSelectedHost = "local";
    const { container } = render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-adversarial" logicalId="worker.adversary" />,
        path: "/topology/seat/$rigId/$logicalId",
        initialPath: "/topology/seat/rig-adversarial/worker.adversary",
      })
    );

    await screen.findByTestId("detail-open-properties");
    // The desktop container has hidden lg:block
    const desktopContainer = container.querySelector(".hidden.lg\\:block");
    expect(desktopContainer).toBeTruthy();

    // Inside this container, AgentPropertiesPanel is mounted without onClose, so no close button
    const closeBtnInDesktop = desktopContainer?.querySelector("[data-testid='agent-properties-close']");
    expect(closeBtnInDesktop).toBeNull();
  });

  it("ADV-LND-11: remote host state inside drawer suppresses attach command", async () => {
    currentSelectedHost = "remote-host-77";
    render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-adversarial" logicalId="worker.adversary" />,
        path: "/topology/seat/$rigId/$logicalId",
        initialPath: "/topology/seat/rig-adversarial/worker.adversary",
      })
    );

    await screen.findByTestId("live-node-actions-remote-readonly");
    const openBtn = screen.getByTestId("detail-open-properties");
    fireEvent.click(openBtn);

    expect(screen.getByTestId("agent-properties-drawer")).toBeTruthy();
    const panel = screen.getByTestId("agent-properties-drawer-panel");
    expect(panel).toBeTruthy();

    // Under remote host selection, attach button is suppressed
    expect(screen.queryByTestId("agent-properties-copy-attach")).toBeNull();
  });
});

describe("Adversarial Milestone 3: HostConfigCard Concurrency Protection", () => {
  beforeEach(() => {
    hoistedState.mutateAsyncSpy.mockClear();
    hoistedState.setSettingPending = false;
    hoistedState.settingsData = {};
    currentSelectedHost = "remote-host-77";
    OriginalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    mockFetch.mockImplementation(defaultMockImplementation);
  });

  afterEach(() => {
    if (OriginalFetch) globalThis.fetch = OriginalFetch;
    cleanup();
  });

  it("ADV-HCC-1: guards local select, remote select, and rename buttons when mutation isPending", async () => {
    hoistedState.setSettingPending = true;
    currentSelectedHost = "remote-host-77";

    render(
      createTestRouter({
        component: () => <HostConfigCard />,
        path: "/",
      })
    );

    await screen.findByTestId("host-own-name");

    // When pending, host-select-local should be disabled
    const localBtn = (await screen.findByTestId("host-select-local")) as HTMLButtonElement;
    expect(localBtn.disabled).toBe(true);

    const renameBtn = (await screen.findByTestId("host-rename-button")) as HTMLButtonElement;
    expect(renameBtn.disabled).toBe(true);

    // Clicking while pending should not invoke mutateAsync
    fireEvent.click(localBtn);
    expect(hoistedState.mutateAsyncSpy).not.toHaveBeenCalled();
  });
});

describe("Adversarial Milestone 3: Mutation Toast Notification Feedback", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    OriginalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    if (OriginalFetch) globalThis.fetch = OriginalFetch;
    cleanup();
    vi.restoreAllMocks();
  });

  function ProbeWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  it("ADV-MUT-1: useExpandRig triggers notifySuccess on 200 and notifyError on HTTP error", async () => {
    const notifySuccessSpy = vi.spyOn(notifyModule, "notifySuccess");
    const notifyErrorSpy = vi.spyOn(notifyModule, "notifyError");

    function ExpandProbe() {
      const mutation = useExpandRig();
      return (
        <div>
          <button
            type="button"
            data-testid="trigger-expand"
            onClick={() => mutation.mutate({ rigId: "rig-1", pod: {} })}
          >
            expand
          </button>
        </div>
      );
    }

    // Success path
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: "ok" }),
    });

    render(
      <ProbeWrapper>
        <ExpandProbe />
      </ProbeWrapper>
    );

    fireEvent.click(screen.getByTestId("trigger-expand"));
    await waitFor(() => {
      expect(notifySuccessSpy).toHaveBeenCalledWith("Rig expanded");
    });

    // Error path
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: "Disk full" }),
    });

    fireEvent.click(screen.getByTestId("trigger-expand"));
    await waitFor(() => {
      expect(notifyErrorSpy).toHaveBeenCalledWith(
        "Couldn't expand rig",
        expect.any(Error)
      );
    });
  });

  it("ADV-MUT-2: useRemoveLibrarySpec triggers notifySuccess on 200 and notifyError on error", async () => {
    const notifySuccessSpy = vi.spyOn(notifyModule, "notifySuccess");
    const notifyErrorSpy = vi.spyOn(notifyModule, "notifyError");

    function RemoveProbe() {
      const mutation = useRemoveLibrarySpec();
      return (
        <button
          type="button"
          data-testid="trigger-remove"
          onClick={() => mutation.mutate("spec-entry-123")}
        >
          remove
        </button>
      );
    }

    // Success path
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    render(
      <ProbeWrapper>
        <RemoveProbe />
      </ProbeWrapper>
    );

    fireEvent.click(screen.getByTestId("trigger-remove"));
    await waitFor(() => {
      expect(notifySuccessSpy).toHaveBeenCalledWith("Spec removed");
    });

    // Error path
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: "Not found" }),
    });

    fireEvent.click(screen.getByTestId("trigger-remove"));
    await waitFor(() => {
      expect(notifyErrorSpy).toHaveBeenCalledWith(
        "Couldn't remove spec",
        expect.any(Error)
      );
    });
  });

  it("ADV-MUT-3: useRenameLibrarySpec triggers notifySuccess on 200 and notifyError on error", async () => {
    const notifySuccessSpy = vi.spyOn(notifyModule, "notifySuccess");
    const notifyErrorSpy = vi.spyOn(notifyModule, "notifyError");

    function RenameProbe() {
      const mutation = useRenameLibrarySpec();
      return (
        <button
          type="button"
          data-testid="trigger-rename"
          onClick={() => mutation.mutate({ entryId: "spec-entry-123", name: "new-spec-name" })}
        >
          rename
        </button>
      );
    }

    // Success path
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    render(
      <ProbeWrapper>
        <RenameProbe />
      </ProbeWrapper>
    );

    fireEvent.click(screen.getByTestId("trigger-rename"));
    await waitFor(() => {
      expect(notifySuccessSpy).toHaveBeenCalledWith("Spec renamed");
    });

    // Error path
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid name" }),
    });

    fireEvent.click(screen.getByTestId("trigger-rename"));
    await waitFor(() => {
      expect(notifyErrorSpy).toHaveBeenCalledWith(
        "Couldn't rename spec",
        expect.any(Error)
      );
    });
  });
});
