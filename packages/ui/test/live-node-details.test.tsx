import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { LiveNodeDetails } from "../src/components/LiveNodeDetails.js";

const mockFetch = vi.fn();

const NODE_DETAIL = {
  rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "dev",
  canonicalSessionName: "dev-impl@test-rig", nodeKind: "agent", runtime: "claude-code",
  sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
  tmuxAttachCommand: "tmux attach -t dev-impl@test-rig", resumeCommand: null,
  latestError: null, model: "opus", agentRef: "local:agents/impl", profile: "default",
  resolvedSpecName: "impl", resolvedSpecVersion: "1.0.0", cwd: "/workspace",
  startupFiles: [{ path: "role.md", deliveryHint: "guidance_merge", required: true }],
  startupActions: [], recentEvents: [],
  infrastructureStartupCommand: null,
  binding: { tmuxSession: "dev-impl@test-rig" },
  peers: [{ logicalId: "dev.qa", canonicalSessionName: "dev-qa@test-rig", runtime: "codex" }],
  edges: {
    outgoing: [{ kind: "delegates_to", to: { logicalId: "dev.qa", sessionName: "dev-qa@test-rig" } }],
    incoming: [],
  },
  transcript: { enabled: true, path: "/tmp/test.log", tailCommand: "rig transcript dev-impl --tail 100" },
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
      bodyExcerpt: "Implement PL-019 edge activity pulse and graph qitem hover.",
      tier: "mode-2",
    },
  ],
};

const INFRA_DETAIL = {
  ...NODE_DETAIL, logicalId: "infra.server", nodeKind: "infrastructure", runtime: "terminal",
  agentRef: null, profile: null,
  compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 },
};

describe("LiveNodeDetails", () => {
  beforeEach(() => {
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function mockNodeDetail(detail: Record<string, unknown>) {
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/nodes/")) {
        return { ok: true, json: async () => detail };
      }
      // Library calls return empty
      if (typeof url === "string" && url.includes("/api/specs/library")) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });
  }

  function renderDetails(logicalId = "dev.impl") {
    return render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-1" logicalId={logicalId} />,
        path: "/test",
      }),
    );
  }

  it("renders with identity section showing peers and edges", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();

    await waitFor(() => {
      // Wait for data to load — peers section proves data arrived
      expect(screen.getByTestId("detail-peers")).toBeDefined();
    });

    expect(screen.getByText("Live Node Details")).toBeDefined();
    expect(screen.getByTestId("detail-edges")).toBeDefined();
    expect(screen.getByTestId("live-node-actions").nextElementSibling?.getAttribute("data-testid")).toBe("live-node-tabs");
    expect(screen.queryByTestId("live-node-status")).toBeNull();
    expect(screen.queryByTestId("detail-transcript")).toBeNull();
    expect(screen.queryByTestId("detail-compact-spec")).toBeNull();
  });

  it("agent spec tab shows unavailable when agentRef is null", async () => {
    mockNodeDetail({ ...NODE_DETAIL, agentRef: null });
    renderDetails();

    fireEvent.click(await screen.findByTestId("live-tab-agent-spec"));

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-unavailable")).toBeDefined();
    });
  });

  it("agent spec tab shows unavailable when agentRef is non-local form", async () => {
    mockNodeDetail({ ...NODE_DETAIL, agentRef: "remote:agents/impl" });
    renderDetails();

    fireEvent.click(await screen.findByTestId("live-tab-agent-spec"));

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-unavailable")).toBeDefined();
    });
  });

  it("infrastructure node does not show agent-spec tab", async () => {
    mockNodeDetail(INFRA_DETAIL);
    renderDetails("infra.server");

    // Wait for data to load and re-render without agent-spec tab
    await screen.findByTestId("live-tab-identity");

    expect(screen.queryByTestId("live-tab-agent-spec")).toBeNull();
    expect(screen.getByTestId("live-tab-identity")).toBeDefined();
    expect(screen.getByTestId("live-tab-startup")).toBeDefined();
  });

  it("startup tab shows startup files", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();

    fireEvent.click(await screen.findByTestId("live-tab-startup"));

    await waitFor(() => {
      expect(screen.getByTestId("live-startup-section")).toBeDefined();
      expect(screen.getByTestId("live-node-status")).toBeDefined();
      expect(screen.getByTestId("live-node-preview")).toBeDefined();
      expect(screen.getByText(/role\.md/)).toBeDefined();
    });
  });

  it("transcript and terminal tabs own their named content", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();

    fireEvent.click(await screen.findByTestId("live-tab-transcript"));
    expect(await screen.findByTestId("detail-transcript")).toBeDefined();

    fireEvent.click(screen.getByTestId("live-tab-terminal"));
    const terminalShell = await screen.findByTestId("live-terminal-shell");
    expect(terminalShell.className).toContain("bg-stone-950/65");
    await waitFor(() => {
      expect(screen.getByTestId("live-terminal-preview-pane").getAttribute("data-variant")).toBe("compact-terminal");
    });
  });

  it("PL-019: full details shows activity and current qitems from node detail", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();

    await waitFor(() => {
      expect(screen.getByTestId("live-node-current-state")).toBeDefined();
    });

    expect(screen.getByTestId("live-node-agent-activity").textContent).toContain("running");
    expect(screen.getByTestId("live-node-current-qitems").textContent).toContain("04001234-driver");
    expect(screen.getByTestId("live-node-current-qitems").textContent).toContain("Implement PL-019 edge activity pulse");
  });
});
