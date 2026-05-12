import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { LiveNodeDetails } from "../src/components/LiveNodeDetails.js";
import { DrawerSelectionContext, type DrawerSelection } from "../src/components/AppShell.js";

const mockFetch = vi.fn();

// V0.3.1 slice 25 — seat detail page now uses a 2-tab Overview +
// Details layout. Tests target the new structure.
const NODE_DETAIL = {
  rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "dev",
  canonicalSessionName: "dev-impl@test-rig", nodeKind: "agent", runtime: "claude-code",
  sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
  tmuxAttachCommand: "tmux attach -t dev-impl@test-rig", resumeCommand: null,
  latestError: null, model: "opus", agentRef: "local:agents/impl", profile: "default",
  resolvedSpecName: "impl", resolvedSpecVersion: "1.0.0", cwd: "/workspace",
  startupFiles: [{
    path: "role.md",
    deliveryHint: "guidance_merge",
    required: true,
    absolutePath: "/workspace/specs/agents/impl/guidance/role.md",
  }],
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
  contextUsage: {
    availability: "known",
    usedPercentage: 42,
    remainingPercentage: 58,
    contextWindowSize: 320000,
    sampledAt: "2026-05-04T07:58:31.057Z",
    fresh: true,
    totalInputTokens: 120000,
    totalOutputTokens: 14000,
  },
};

const INFRA_DETAIL = {
  ...NODE_DETAIL, logicalId: "infra.server", nodeKind: "infrastructure", runtime: "terminal",
  agentRef: null, profile: null,
  compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 },
};

describe("LiveNodeDetails (slice 25 Overview + Details)", () => {
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

  function renderDetailsWithDrawerSelection(setSelection: (sel: DrawerSelection) => void, logicalId = "dev.impl") {
    return render(
      createTestRouter({
        component: () => (
          <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
            <LiveNodeDetails rigId="rig-1" logicalId={logicalId} />
          </DrawerSelectionContext.Provider>
        ),
        path: "/test",
      }),
    );
  }

  // HG-1 — default tab is Overview.
  it("HG-1: default tab is Overview on landing", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();

    const overviewTab = await screen.findByTestId("live-tab-overview");
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("live-overview-section")).toBeDefined();
    // Details exists but is not active on first paint.
    const detailsTab = screen.getByTestId("live-tab-details");
    expect(detailsTab.getAttribute("aria-selected")).toBe("false");
  });

  // HG-7 — Terminal tab no longer exists; identity / agent-spec /
  // startup / transcript tabs no longer exist as named tabs either.
  it("HG-7: legacy 5-tab structure is gone — only overview + details remain", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    await screen.findByTestId("live-tab-overview");

    expect(screen.queryByTestId("live-tab-terminal")).toBeNull();
    expect(screen.queryByTestId("live-tab-identity")).toBeNull();
    expect(screen.queryByTestId("live-tab-agent-spec")).toBeNull();
    expect(screen.queryByTestId("live-tab-startup")).toBeNull();
    expect(screen.queryByTestId("live-tab-transcript")).toBeNull();
    expect(screen.getByTestId("live-tab-overview")).toBeDefined();
    expect(screen.getByTestId("live-tab-details")).toBeDefined();
  });

  // HG-2 — Overview stack order: info table -> terminal -> Activity +
  // Recent Events. Asserts DOM order via compareDocumentPosition.
  it("HG-2: Overview tab DOM order is info table -> terminal -> activity -> recent events", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();

    const table = await screen.findByTestId("seat-overview-table");
    const terminal = await screen.findByTestId("live-terminal-shell");
    const activity = await screen.findByTestId("live-node-current-state");
    // Recent events only renders when there's at least one event;
    // NODE_DETAIL has recentEvents: [] so this section is conditional.
    // The order assertion focuses on the always-rendered trio.

    expect(table.compareDocumentPosition(terminal)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(terminal.compareDocumentPosition(activity)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  // HG-3 — 9 info-table fields (7 compact + 2 full-width). Every row
  // testid present.
  it("HG-3: info table renders all 9 fields (7 compact + 2 full-width)", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    await screen.findByTestId("seat-overview-table");

    // 7 compact rows
    expect(screen.getByTestId("seat-overview-row-runtime").getAttribute("data-row-shape")).toBe("compact");
    expect(screen.getByTestId("seat-overview-row-model").getAttribute("data-row-shape")).toBe("compact");
    expect(screen.getByTestId("seat-overview-row-profile").getAttribute("data-row-shape")).toBe("compact");
    expect(screen.getByTestId("seat-overview-row-spec").getAttribute("data-row-shape")).toBe("compact");
    expect(screen.getByTestId("seat-overview-row-activity").getAttribute("data-row-shape")).toBe("compact");
    expect(screen.getByTestId("seat-overview-row-context-percent").getAttribute("data-row-shape")).toBe("compact");
    expect(screen.getByTestId("seat-overview-row-total-tokens").getAttribute("data-row-shape")).toBe("compact");
    // 2 full-width rows
    expect(screen.getByTestId("seat-overview-row-cwd").getAttribute("data-row-shape")).toBe("full-width");
    expect(screen.getByTestId("seat-overview-row-current-work").getAttribute("data-row-shape")).toBe("full-width");

    expect(screen.getByTestId("seat-overview-cell-model").textContent).toContain("opus");
    expect(screen.getByTestId("seat-overview-cell-profile").textContent).toContain("default");
    expect(screen.getByTestId("seat-overview-cell-spec").textContent).toContain("impl@1.0.0");
    expect(screen.getByTestId("seat-overview-cell-cwd").textContent).toContain("/workspace");
    expect(screen.getByTestId("seat-overview-cell-context-percent").textContent).toContain("42%");
  });

  // HG-3a — activity row wires to data.agentActivity via
  // getActivityState (the SAME helper LiveNodeCurrentState uses; the
  // SAME source the topology baseline reads). When agentActivity.state
  // is "running", the cell shows label "active" matching topology
  // graph/table naming.
  it("HG-3a: activity row wires live and shows 'active' for state=running with shimmer", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    await screen.findByTestId("seat-overview-table");

    const cell = screen.getByTestId("seat-overview-cell-activity");
    expect(cell.textContent?.trim()).toContain("active");
    const stateEl = screen.getByTestId("seat-overview-activity-state");
    expect(stateEl.getAttribute("data-activity-state")).toBe("running");
    // HG-3c shimmer reuse: slice-14 shimmer class applied on active.
    expect(stateEl.className).toContain("topology-table-active-shimmer");
  });

  it("HG-3a: activity row shows 'idle' label and NO shimmer when agentActivity.state=idle", async () => {
    mockNodeDetail({
      ...NODE_DETAIL,
      agentActivity: { ...NODE_DETAIL.agentActivity, state: "idle" },
    });
    renderDetails();
    await screen.findByTestId("seat-overview-table");
    const cell = screen.getByTestId("seat-overview-cell-activity");
    expect(cell.textContent?.trim()).toContain("idle");
    const stateEl = screen.getByTestId("seat-overview-activity-state");
    expect(stateEl.getAttribute("data-activity-state")).toBe("idle");
    expect(stateEl.className).not.toContain("topology-table-active-shimmer");
  });

  // HG-3b — current-work row wires live to data.currentQitems[0].
  // Shows qitemId + bodyExcerpt when present.
  it("HG-3b: current-work row wires live and surfaces the in-progress qitem", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    await screen.findByTestId("seat-overview-table");
    const cell = screen.getByTestId("seat-overview-cell-current-work");
    expect(cell.textContent).toContain("qitem-20260504001234-driver");
    expect(cell.textContent).toContain("Implement PL-019 edge activity pulse");
  });

  it("HG-3b: current-work row renders em-dash when no in-progress qitem", async () => {
    mockNodeDetail({ ...NODE_DETAIL, currentQitems: [] });
    renderDetails();
    await screen.findByTestId("seat-overview-table");
    const cell = screen.getByTestId("seat-overview-cell-current-work");
    expect(cell.textContent).toContain("—");
  });

  // HG-3d — cwd full-width with truncate-ellipsis + title attribute.
  it("HG-3d: cwd renders as full-width row with truncate-ellipsis + tooltip", async () => {
    const longCwd = "/Users/example/very/long/workspace/path/that/should/truncate/at/the/end";
    mockNodeDetail({ ...NODE_DETAIL, cwd: longCwd });
    renderDetails();
    const row = await screen.findByTestId("seat-overview-row-cwd");
    expect(row.getAttribute("data-row-shape")).toBe("full-width");
    const cell = screen.getByTestId("seat-overview-cell-cwd");
    expect(cell.getAttribute("title")).toBe(longCwd);
    // The inner truncate span carries the truncate class so the cwd
    // doesn't overflow the row.
    expect(cell.innerHTML).toContain("truncate");
  });

  // HG-4 — model graceful absence: row visible with em-dash, NOT
  // "undefined" rendered as a string.
  it("HG-4: model row renders em-dash gracefully when model field is absent", async () => {
    mockNodeDetail({ ...NODE_DETAIL, model: null });
    renderDetails();
    await screen.findByTestId("seat-overview-table");

    const modelCell = screen.getByTestId("seat-overview-cell-model");
    expect(modelCell).toBeDefined();
    // Row still visible.
    expect(screen.getByTestId("seat-overview-row-model")).toBeDefined();
    // No literal "undefined".
    expect(modelCell.textContent).not.toContain("undefined");
    // Em-dash placeholder.
    expect(modelCell.textContent).toContain("—");
  });

  // HG-5 — black-glass terminal renders inline in Overview (not in a
  // separate tab). The terminal shell wrapper carries the black-glass
  // chrome class.
  it("HG-5: black-glass terminal renders inline in Overview", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    const terminalShell = await screen.findByTestId("live-terminal-shell");
    expect(terminalShell.className).toContain("bg-stone-950/65");
    await waitFor(() => {
      expect(screen.getByTestId("live-terminal-preview-pane").getAttribute("data-variant")).toBe("compact-terminal");
    });
    // The terminal sits inside the Overview section, NOT a separate
    // tab body. The Overview section wraps it.
    const overview = screen.getByTestId("live-overview-section");
    expect(overview.contains(terminalShell)).toBe(true);
  });

  // HG-6 — Details tab contains edges, peers, agent spec, startup
  // content (no preview), transcript content.
  it("HG-6: Details tab composes edges + peers + agent spec + startup (no preview) + transcript", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));

    await waitFor(() => {
      expect(screen.getByTestId("live-details-section")).toBeDefined();
    });
    expect(screen.getByTestId("detail-edges")).toBeDefined();
    expect(screen.getByTestId("detail-peers")).toBeDefined();
    expect(screen.getByTestId("live-startup-section")).toBeDefined();
    expect(screen.getByTestId("live-transcript-section")).toBeDefined();
    // PreviewPane is intentionally absent from Startup in slice 25
    // (terminal moved to Overview).
    expect(screen.queryByTestId("live-node-preview")).toBeNull();
  });

  // Infrastructure nodes still have the same 2-tab structure; the
  // agent-spec section just doesn't render inside Details.
  it("infrastructure node renders Overview + Details (no agent-spec card inside Details)", async () => {
    mockNodeDetail(INFRA_DETAIL);
    renderDetails("infra.server");
    await screen.findByTestId("live-tab-overview");
    expect(screen.getByTestId("live-tab-overview")).toBeDefined();
    expect(screen.getByTestId("live-tab-details")).toBeDefined();
    expect(screen.queryByTestId("live-tab-agent-spec")).toBeNull();

    fireEvent.click(screen.getByTestId("live-tab-details"));
    await waitFor(() => {
      expect(screen.getByTestId("live-details-section")).toBeDefined();
    });
    // No live-agent-spec-section for infra nodes.
    expect(screen.queryByTestId("live-agent-spec-section")).toBeNull();
  });

  // Agent spec unavailable cases — switch to Details, then exercise the
  // null + non-local agentRef shapes.
  it("Details tab: agent spec section shows unavailable when agentRef is null", async () => {
    mockNodeDetail({ ...NODE_DETAIL, agentRef: null });
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));
    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-unavailable")).toBeDefined();
    });
  });

  it("Details tab: agent spec section shows unavailable when agentRef is non-local form", async () => {
    mockNodeDetail({ ...NODE_DETAIL, agentRef: "remote:agents/impl" });
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));
    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-unavailable")).toBeDefined();
    });
  });

  // Startup files surface inside Details > Startup section.
  it("Details tab: Startup section shows startup files", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));
    await waitFor(() => {
      expect(screen.getByTestId("live-startup-section")).toBeDefined();
      expect(screen.getByTestId("live-node-status")).toBeDefined();
      expect(screen.getByText(/role\.md/)).toBeDefined();
    });
  });

  it("Details tab: Startup file trigger threads file provenance for drawer loading", async () => {
    const setSelection = vi.fn();
    mockNodeDetail(NODE_DETAIL);
    renderDetailsWithDrawerSelection(setSelection as (sel: DrawerSelection) => void);
    fireEvent.click(await screen.findByTestId("live-tab-details"));
    fireEvent.click(await screen.findByTestId("live-startup-file-trigger-role.md"));

    expect(setSelection).toHaveBeenCalledWith({
      type: "file",
      data: {
        path: "role.md",
        absolutePath: "/workspace/specs/agents/impl/guidance/role.md",
      },
    });
  });

  it("Details tab: Transcript section owns transcript content", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));
    expect(await screen.findByTestId("detail-transcript")).toBeDefined();
  });

  // Slice 3.3 fix-B preserved — Plugins section inside Details > Agent
  // spec area. Renders empty state on builds without batch 1.
  it("slice 3.3 fix-B preserved: Plugins section in Details tab agent-spec area", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/nodes/")) {
        return { ok: true, json: async () => NODE_DETAIL };
      }
      if (typeof url === "string" && url === "/api/specs/library?kind=agent") {
        return { ok: true, json: async () => [{ id: "agent-1", kind: "agent", name: "impl", version: "1.0.0", sourceType: "builtin", sourcePath: "/x/agent.yaml", relativePath: "x/agent.yaml" }] };
      }
      if (typeof url === "string" && url.includes("/api/specs/library/agent-1/review")) {
        return { ok: true, json: async () => ({ kind: "agent", name: "impl", version: "1.0.0", raw: "", sourcePath: "/x/agent.yaml", sourceState: "library_item", libraryEntryId: "agent-1", description: null, profiles: [], resources: { plugins: [], skills: [], guidance: [], hooks: [] }, startup: { files: [], actions: [] } }) };
      }
      if (typeof url === "string" && url.startsWith("/api/specs/library")) {
        return { ok: true, json: async () => [] };
      }
      if (typeof url === "string" && url === "/api/plugins") {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));
    await waitFor(() => {
      expect(screen.getByTestId("live-agent-plugins-section")).toBeDefined();
    });
    expect(screen.getByTestId("agent-plugins-empty")).toBeDefined();
  });

  // PL-019 preserved — activity + current qitems surface in the
  // Overview tab (LiveNodeCurrentState now sits under the terminal).
  it("PL-019 preserved: Overview shows activity + current qitems from node detail", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    await waitFor(() => {
      expect(screen.getByTestId("live-node-current-state")).toBeDefined();
    });
    expect(screen.getByTestId("live-node-agent-activity").textContent).toContain("running");
    expect(screen.getByTestId("live-node-current-qitems").textContent).toContain("04001234-driver");
    expect(screen.getByTestId("live-node-current-qitems").textContent).toContain("Implement PL-019 edge activity pulse");
  });

  // Resume action glyph remains independent of tab structure.
  it("uses a resume action glyph instead of a runtime mark on the copy resume command", async () => {
    mockNodeDetail({ ...NODE_DETAIL, resumeCommand: "rig seat resume dev.impl" });
    renderDetails();
    const resumeButton = await screen.findByTestId("detail-copy-resume");
    expect(resumeButton.textContent).toContain("Copy resume command");
    expect(resumeButton.textContent).not.toContain("Claude");
    expect(resumeButton.querySelector("svg")).toBeDefined();
  });
});
