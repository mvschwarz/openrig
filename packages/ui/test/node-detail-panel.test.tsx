import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { NodeDetailPanel } from "../src/components/NodeDetailPanel.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

function renderPanel(props?: { rigId?: string; logicalId?: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <NodeDetailPanel
          rigId={props?.rigId ?? "rig-1"}
          logicalId={props?.logicalId ?? "dev.impl"}
          onClose={onClose}
        />
      </QueryClientProvider>
    ),
    onClose,
  };
}

const AGENT_DETAIL = {
  rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "dev",
  canonicalSessionName: "dev.impl@test-rig", nodeKind: "agent", runtime: "claude-code",
  sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
  tmuxAttachCommand: "tmux attach -t dev.impl@test-rig", resumeCommand: "claude --resume abc-123",
  latestError: null, model: "opus", agentRef: "local:agents/impl", profile: "default",
  resolvedSpecName: "impl", resolvedSpecVersion: "1.0.0", cwd: "/workspace",
  startupFiles: [{ path: "role.md", deliveryHint: "guidance_merge", required: true }],
  startupActions: [], recentEvents: [{ type: "node.startup_ready", createdAt: "2026-03-31T00:00:00Z" }],
  infrastructureStartupCommand: null,
  binding: { tmuxSession: "dev.impl@test-rig" },
  peers: [{ logicalId: "dev.qa", canonicalSessionName: "dev.qa@test-rig", runtime: "codex" }],
  edges: {
    outgoing: [{ kind: "delegates_to", to: { logicalId: "dev.qa", sessionName: "dev.qa@test-rig" } }],
    incoming: [],
  },
  transcript: { enabled: true, path: "/tmp/transcripts/test-rig/dev.impl@test-rig.log", tailCommand: "rig transcript dev.impl@test-rig --tail 100" },
  compactSpec: { name: "impl", version: "1.0.0", profile: "default", skillCount: 2, guidanceCount: 1 },
};

const INFRA_DETAIL = {
  ...AGENT_DETAIL, logicalId: "infra.server", nodeKind: "infrastructure", runtime: "terminal",
  profile: "none", agentRef: "builtin:terminal", resumeCommand: null,
  infrastructureStartupCommand: "npm run dev",
  canonicalSessionName: "infra.server@test-rig",
  tmuxAttachCommand: "tmux attach -t infra.server@test-rig",
  compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 },
};

const FAILED_DETAIL = {
  ...AGENT_DETAIL, startupStatus: "failed", latestError: "harness launch timeout after 30s",
};

// NS-T11: integration test — AppShell selection → NodeDetailPanel mounts
import { NodeSelectionContext } from "../src/components/AppShell.js";
import { useState } from "react";

describe("NodeDetailPanel integration with AppShell selection", () => {
  afterEach(() => cleanup());

  it("NodeDetailPanel mounts when selectedNode is set via AppShell context", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/nodes/dev.impl")) {
        return { ok: true, json: async () => AGENT_DETAIL };
      }
      return { ok: true, json: async () => [] };
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // Replicate AppShell's pattern: context provides selectedNode, conditionally renders panel
    function TestShell() {
      const [selectedNode] = useState<{ rigId: string; logicalId: string } | null>({ rigId: "rig-1", logicalId: "dev.impl" });
      return (
        <NodeSelectionContext.Provider value={{ selectedNode, setSelectedNode: vi.fn() }}>
          <QueryClientProvider client={queryClient}>
            {selectedNode && (
              <NodeDetailPanel
                rigId={selectedNode.rigId}
                logicalId={selectedNode.logicalId}
                onClose={vi.fn()}
              />
            )}
          </QueryClientProvider>
        </NodeSelectionContext.Provider>
      );
    }

    render(<TestShell />);

    // Panel should mount and fetch detail data
    await waitFor(() => {
      expect(screen.getByTestId("node-detail-panel")).toBeDefined();
      expect(screen.getAllByText("dev.impl@test-rig").length).toBeGreaterThan(0);
    });

    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/nodes/dev.impl"));
  });
});

describe("NodeDetailPanel", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => cleanup());

  function mockDetail(detail: Record<string, unknown>) {
    mockFetch.mockResolvedValue({ ok: true, json: async () => detail });
  }

  // Test 1: Panel renders with correct identity fields
  it("renders identity fields from fetched detail", async () => {
    mockDetail(AGENT_DETAIL);
    renderPanel();
    await waitFor(() => {
      expect(screen.getAllByText("dev.impl@test-rig").length).toBeGreaterThan(0);
      expect(screen.getByText("claude-code")).toBeDefined();
      expect(screen.getAllByText("impl").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("Full Name")).toBeNull();
  });

  // Test 2: Panel shows startup status with correct color
  it("shows startup status", async () => {
    mockDetail(AGENT_DETAIL);
    renderPanel();
    await waitFor(() => {
      const status = screen.getByTestId("detail-startup-status");
      expect(status.textContent).toBe("ready");
    });
  });

  // Test 3: Copy tmux attach button present
  it("shows Copy tmux attach action", async () => {
    mockDetail(AGENT_DETAIL);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("detail-copy-attach")).toBeDefined();
    });
  });

  // Test 4: Failed node shows error
  it("shows error prominently for failed node", async () => {
    mockDetail(FAILED_DETAIL);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("detail-failure-banner")).toBeDefined();
      expect(screen.getByText("harness launch timeout after 30s")).toBeDefined();
    });
  });

  // Test PNS-T10: restoreOutcome is prominently displayed
  it("shows restoreOutcome prominently with color class", async () => {
    mockDetail({ ...AGENT_DETAIL, restoreOutcome: "resumed" });
    renderPanel();
    await waitFor(() => {
      const el = screen.getByTestId("detail-restore-outcome");
      expect(el).toBeDefined();
      expect(el.textContent).toBe("resumed");
      expect(el.className).toContain("text-success");
    });
  });

  // Test PNS-T10: failure banner includes actionable guidance
  it("failure banner includes actionable next-step guidance", async () => {
    mockDetail(FAILED_DETAIL);
    renderPanel();
    await waitFor(() => {
      const banner = screen.getByTestId("detail-failure-banner");
      expect(banner.textContent).toContain("rig ps");
    });
  });

  // Test 5: Infrastructure node simplified
  it("infrastructure node shows startup command, no profile", async () => {
    mockDetail(INFRA_DETAIL);
    renderPanel({ logicalId: "infra.server" });
    await waitFor(() => {
      expect(screen.getByText("npm run dev")).toBeDefined();
      // No agent spec or profile for infra nodes
      expect(screen.queryByText("Agent Spec")).toBeNull();
    });
  });

  // Test 6: Resume command shown when exists
  it("shows resume command when available", async () => {
    mockDetail(AGENT_DETAIL);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("detail-copy-resume")).toBeDefined();
    });
  });

  // Test 7: Resume command hidden when no token
  it("hides resume command when not available", async () => {
    mockDetail({ ...AGENT_DETAIL, resumeCommand: null });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("detail-copy-attach")).toBeDefined();
    });
    expect(screen.queryByTestId("detail-copy-resume")).toBeNull();
  });

  // Test 8: Startup files displayed
  it("shows startup files list", async () => {
    mockDetail(AGENT_DETAIL);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/role\.md/)).toBeDefined();
    });
  });

  // Task 5: New drawer sections
  it("shows peers section from node detail", async () => {
    mockDetail(AGENT_DETAIL);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("detail-peers")).toBeDefined();
      expect(screen.getAllByText("dev.qa").length).toBeGreaterThan(0);
      expect(screen.getByText("codex")).toBeDefined();
      expect(screen.getByText("dev.qa@test-rig")).toBeDefined();
    });
  });

  it("shows edges section from node detail", async () => {
    mockDetail(AGENT_DETAIL);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("detail-edges")).toBeDefined();
      expect(screen.getByText("delegates_to")).toBeDefined();
    });
  });

  it("shows transcript section with tail command", async () => {
    mockDetail(AGENT_DETAIL);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("detail-transcript")).toBeDefined();
      expect(screen.getByText("Copy tail command")).toBeDefined();
    });
  });

  it("shows compact spec section from node detail", async () => {
    mockDetail(AGENT_DETAIL);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("detail-compact-spec")).toBeDefined();
    });
  });

  it("shows Open Full Details button", async () => {
    mockDetail(AGENT_DETAIL);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("detail-open-full")).toBeDefined();
      expect(screen.getByText("Open Full Details")).toBeDefined();
    });
  });
});
