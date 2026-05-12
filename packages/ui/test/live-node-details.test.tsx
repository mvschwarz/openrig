import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { LiveNodeDetails } from "../src/components/LiveNodeDetails.js";
import { DrawerSelectionContext, type DrawerSelection } from "../src/components/AppShell.js";
import {
  resetTopologyActivityStoreForTests,
  useTopologyActivity,
} from "../src/hooks/useTopologyActivity.js";
import { buildTopologySessionIndex } from "../src/lib/topology-activity.js";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";

const mockFetch = vi.fn();
let OriginalEventSource: typeof EventSource | undefined;

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
    OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
    resetTopologyActivityStoreForTests();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (OriginalEventSource) {
      globalThis.EventSource = OriginalEventSource;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).EventSource;
    }
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

  function TopologyActivityWarmup() {
    useTopologyActivity(buildTopologySessionIndex([{
      nodeId: "rig-1::dev.impl",
      rigId: "rig-1",
      rigName: "test-rig",
      logicalId: "dev.impl",
      canonicalSessionName: "dev-impl@test-rig",
    }]));
    return <div data-testid="activity-warmup" />;
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

  // HG-2 (follow-on) — Overview stack order: notification banner
  // (optional) -> info table -> inline terminal -> recent events
  // (at bottom). LiveNodeCurrentState is REMOVED. Order asserted via
  // compareDocumentPosition between always-rendered elements.
  it("HG-2: Overview tab DOM order is notification -> info table -> terminal -> recent events", async () => {
    // Inject a startupStatus that surfaces the notification banner so
    // the assertion covers the full 4-element order.
    mockNodeDetail({
      ...NODE_DETAIL,
      startupStatus: "attention_required",
      latestError: "synthetic attention",
      recentEvents: [
        { type: "agent.activity", createdAt: "2026-05-12T00:00:00Z" },
      ],
    });
    renderDetails();

    const banner = await screen.findByTestId("seat-notification-banner");
    const table = await screen.findByTestId("seat-overview-table");
    const terminal = await screen.findByTestId("live-terminal-shell");
    const events = await screen.findByTestId("live-node-recent-events");

    expect(banner.compareDocumentPosition(table)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(table.compareDocumentPosition(terminal)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(terminal.compareDocumentPosition(events)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // HG-4: LiveNodeCurrentState no longer mounts inside Overview.
    expect(screen.queryByTestId("live-node-current-state")).toBeNull();
  });

  // HG-1 (follow-on) — info table renders as column-headers + data
  // row for the 7 compact fields, plus 2 full-width rows below.
  it("HG-1: info table renders column-headers + single data row (7 fields)", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    await screen.findByTestId("seat-overview-table");

    // 7 column headers + 1 data row in the column-oriented section.
    const headerRow = screen.getByTestId("seat-overview-header-row");
    expect(headerRow).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-runtime")).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-model")).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-profile")).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-spec")).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-activity")).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-context-percent")).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-total-tokens")).toBeDefined();

    const dataRow = screen.getByTestId("seat-overview-data-row");
    expect(dataRow.getAttribute("data-row-shape")).toBe("data");

    // HG-2 (follow-on) — cwd + current-work remain in the same table
    // primitive as full-width rows below the data row.
    expect(screen.getByTestId("seat-overview-row-cwd").getAttribute("data-row-shape")).toBe("full-width");
    expect(screen.getByTestId("seat-overview-row-current-work").getAttribute("data-row-shape")).toBe("full-width");

    // Data-cell content reads from the same NodeDetailData fields.
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
    expect(stateEl.getAttribute("data-activity-state")).toBe("active");
    // HG-3c shimmer reuse: slice-14 shimmer class applied on active.
    expect(stateEl.className).toContain("topology-table-active-shimmer");
  });

  it("HG-3a: activity row shows 'idle' label and NO shimmer when agentActivity.state=idle", async () => {
    mockNodeDetail({
      ...NODE_DETAIL,
      agentActivity: { ...NODE_DETAIL.agentActivity, state: "idle" },
      currentQitems: [],
    });
    renderDetails();
    await screen.findByTestId("seat-overview-table");
    const cell = screen.getByTestId("seat-overview-cell-activity");
    expect(cell.textContent?.trim()).toContain("idle");
    const stateEl = screen.getByTestId("seat-overview-activity-state");
    expect(stateEl.getAttribute("data-activity-state")).toBe("idle");
    expect(stateEl.className).not.toContain("topology-table-active-shimmer");
  });

  it("HG-3a: seat page reuses recent topology activity across graph/table -> seat navigation", async () => {
    const warmup = render(<TopologyActivityWarmup />);
    await waitFor(() => {
      expect(instances).toHaveLength(1);
    });

    instances[0]!.simulateMessage(JSON.stringify({
      type: "agent.activity",
      sessionName: "dev-impl@test-rig",
      activity: { state: "running" },
    }));
    warmup.unmount();

    mockNodeDetail({
      ...NODE_DETAIL,
      agentActivity: {
        ...NODE_DETAIL.agentActivity,
        state: "unknown",
        reason: "no_activity_signal",
        fallback: true,
      },
      currentQitems: [],
    });
    renderDetails();
    const stateEl = await screen.findByTestId("seat-overview-activity-state");
    expect(stateEl.textContent).toBe("active");
    expect(stateEl.getAttribute("data-activity-state")).toBe("active");
    expect(stateEl.className).toContain("topology-table-active-shimmer");
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

  // HG-4 (preserved) — model graceful absence: column cell shows
  // em-dash, NOT "undefined". The header row remains; the model cell
  // in the data row carries the placeholder.
  it("HG-4: model cell renders em-dash gracefully when model field is absent", async () => {
    mockNodeDetail({ ...NODE_DETAIL, model: null });
    renderDetails();
    await screen.findByTestId("seat-overview-table");

    // Header row still present for model.
    expect(screen.getByTestId("seat-overview-header-model")).toBeDefined();
    // Data cell carries placeholder, not literal "undefined".
    const modelCell = screen.getByTestId("seat-overview-cell-model");
    expect(modelCell).toBeDefined();
    expect(modelCell.textContent).not.toContain("undefined");
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

  // HG-6 (follow-on) — Details tab re-ordered. New top-to-bottom
  // order: Startup → AgentSpec → Edges → Peers → (Context usage) →
  // Transcript. Asserted via DOM order between always-rendered
  // section testids.
  it("HG-6: Details tab order is Startup -> Spec/Topology (AgentSpec + Edges + Peers) -> Transcript", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));

    await waitFor(() => {
      expect(screen.getByTestId("live-details-section")).toBeDefined();
    });
    const startup = screen.getByTestId("live-startup-section");
    const agentSpec = screen.getByTestId("live-agent-spec-section");
    const edges = screen.getByTestId("detail-edges");
    const peers = screen.getByTestId("detail-peers");
    const transcript = screen.getByTestId("live-transcript-section");

    expect(startup.compareDocumentPosition(agentSpec)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(agentSpec.compareDocumentPosition(edges)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(edges.compareDocumentPosition(peers)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(peers.compareDocumentPosition(transcript)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // PreviewPane is intentionally absent from Startup (terminal lives
    // in Overview; preserved invariant from the slice-25 baseline).
    expect(screen.queryByTestId("live-node-preview")).toBeNull();
  });

  // HG-3 (follow-on) — Notification banner renders only when an
  // active message exists; nothing renders otherwise.
  it("HG-3: notification banner renders when latestError + attention_required is set", async () => {
    mockNodeDetail({
      ...NODE_DETAIL,
      startupStatus: "attention_required",
      latestError: "Synthetic test error.",
      recoveryGuidance: {
        summary: "Synthetic guidance summary.",
        commands: ["rig restore <snap>"],
        notes: [],
      },
    });
    renderDetails();
    const banner = await screen.findByTestId("seat-notification-banner");
    expect(banner.getAttribute("data-startup-status")).toBe("attention_required");
    expect(screen.getByTestId("seat-notification-headline").textContent).toContain("Attention required");
    expect(screen.getByTestId("seat-notification-error").textContent).toContain("Synthetic test error");
    expect(screen.getByTestId("seat-notification-guidance").textContent).toContain("Synthetic guidance summary");
  });

  it("HG-3: notification banner does NOT render when no active message", async () => {
    mockNodeDetail({
      ...NODE_DETAIL,
      startupStatus: "ready",
      latestError: null,
      recoveryGuidance: null,
    });
    renderDetails();
    await screen.findByTestId("seat-overview-table");
    expect(screen.queryByTestId("seat-notification-banner")).toBeNull();
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

  // PL-019 preserved (follow-on) — activity + current-work surface
  // in the Overview info table now (LiveNodeCurrentState card removed
  // in the follow-on). Activity is the column cell; current-work is
  // the full-width row.
  it("PL-019 preserved: Overview info table surfaces activity + current qitem", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    await screen.findByTestId("seat-overview-table");

    // Activity column cell carries the active label (topology naming).
    expect(screen.getByTestId("seat-overview-cell-activity").textContent?.trim()).toContain("active");
    // Current-work full-width row carries the qitem id + body excerpt.
    const cwCell = screen.getByTestId("seat-overview-cell-current-work");
    expect(cwCell.textContent).toContain("04001234-driver");
    expect(cwCell.textContent).toContain("Implement PL-019 edge activity pulse");
    // LiveNodeCurrentState card removed.
    expect(screen.queryByTestId("live-node-current-state")).toBeNull();
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
