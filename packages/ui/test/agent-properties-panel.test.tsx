import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { AgentPropertiesPanel } from "../src/components/AgentPropertiesPanel.js";

const mockFetch = vi.fn();

const NODE_DETAIL = {
  rigId: "rig-1",
  rigName: "test-rig",
  logicalId: "dev.impl",
  podId: "dev",
  canonicalSessionName: "dev-impl@test-rig",
  nodeKind: "agent",
  runtime: "claude-code",
  sessionStatus: "running",
  startupStatus: "ready",
  restoreOutcome: "n-a",
  tmuxAttachCommand: "tmux attach -t dev-impl@test-rig",
  resumeCommand: null,
  recoveryGuidance: null,
  latestError: null,
  model: "opus",
  agentRef: "local:agents/impl",
  profile: "default",
  resolvedSpecName: "impl",
  resolvedSpecVersion: "1.0.0",
  cwd: "/workspace",
  startupFiles: [],
  startupActions: [],
  recentEvents: [],
  infrastructureStartupCommand: null,
  peers: [],
  edges: { outgoing: [], incoming: [] },
  transcript: { enabled: false, path: null, tailCommand: null },
  compactSpec: { name: "impl", version: "1.0.0", profile: "default", skillCount: 2, guidanceCount: 1 },
  agentActivity: {
    state: "running",
    reason: "edit",
    evidenceSource: "runtime_hook",
    sampledAt: "2026-05-04T07:58:31.057Z",
    evidence: "edit",
  },
  currentQitems: [
    {
      qitemId: "qitem-20260504001234-driver",
      bodyExcerpt: "Implement PL-019 edge activity pulse.",
      tier: "mode-2",
    },
  ],
  contextUsage: {
    availability: "known",
    usedPercentage: 58,
    remainingPercentage: 42,
    contextWindowSize: 320000,
    sampledAt: "2026-05-04T07:58:31.057Z",
    fresh: true,
    totalInputTokens: 120000,
    totalOutputTokens: 14000,
  },
};

function renderPanel() {
  return render(
    createTestRouter({
      component: () => <AgentPropertiesPanel rigId="rig-1" logicalId="dev.impl" />,
      path: "/test",
    }),
  );
}

describe("AgentPropertiesPanel", () => {
  beforeEach(() => {
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders seeded data: Runtime claude-code and Context used 58%", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => NODE_DETAIL });
    renderPanel();

    // Wait for the data rows (the loading skeleton shares the testid).
    await screen.findByTestId("agent-properties-copy-attach");
    const panels = screen.getAllByTestId("agent-properties");
    const panel = panels[panels.length - 1]!;
    expect(panel.tagName.toLowerCase()).toBe("section");
    expect(panel.getAttribute("aria-label")).toBe("Properties");
    expect(panel.className).toContain("w-80");
    expect(panel.className).toContain("border-l");

    expect(panel.textContent).toContain("Properties");
    expect(panel.textContent).toContain("claude-code");
    expect(panel.textContent).toContain("58%");
  });

  it("copy button calls navigator.clipboard.writeText with the attach command", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => NODE_DETAIL });
    renderPanel();

    const copyBtn = await screen.findByTestId("agent-properties-copy-attach");
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith(
        "tmux attach -t dev-impl@test-rig",
      );
    });
    expect(await screen.findByText("Copied")).toBeDefined();
  });

  it("error state shows Couldn't load this agent", async () => {
    mockFetch.mockRejectedValue(new Error("boom"));
    renderPanel();

    expect(await screen.findByText("Couldn't load this agent")).toBeDefined();
  });
});
