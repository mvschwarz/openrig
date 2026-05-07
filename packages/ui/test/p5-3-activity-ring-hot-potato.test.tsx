import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import type React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ActivityRing } from "../src/components/topology/ActivityRing.js";
import { HotPotatoEdge } from "../src/components/topology/HotPotatoEdge.js";
import { HybridAgentNode } from "../src/components/topology/HybridTopologyNodes.js";
import { fallbackActivityCardState, getActivityCardClasses } from "../src/components/topology/activity-card-visuals.js";
import {
  HOT_POTATO_WITHIN_RIG_DURATION_MS,
  type HotPotatoPacket,
} from "../src/lib/topology-activity.js";

function packet(): HotPotatoPacket {
  return {
    id: "packet-1",
    eventType: "queue.created",
    qitemId: "q1",
    sourceSession: "orch.lead@rig",
    targetSession: "dev.driver@rig",
    sourceNodeId: "orch.lead",
    targetNodeId: "dev.driver",
    sourceRigId: "rig-1",
    targetRigId: "rig-1",
    crossRig: false,
    createdAt: Date.now(),
    durationMs: HOT_POTATO_WITHIN_RIG_DURATION_MS,
  };
}

function edgeProps(reducedMotion: boolean) {
  return {
    id: "edge-1",
    source: "orch.lead",
    target: "dev.driver",
    sourceX: 0,
    sourceY: 0,
    targetX: 120,
    targetY: 40,
    sourcePosition: "right",
    targetPosition: "left",
    markerEnd: undefined,
    markerStart: undefined,
    interactionWidth: 10,
    data: {
      hotPotatoPacket: packet(),
      hotPotatoReducedMotion: reducedMotion,
      hotPotatoCrossRig: false,
    },
    style: {},
    selected: false,
    animated: false,
  } as any;
}

function renderHybridNode(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReactFlowProvider>{children}</ReactFlowProvider>
    </QueryClientProvider>,
  );
}

describe("P5.3 ActivityRing and HotPotatoEdge", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders no ring for idle state", () => {
    render(
      <ActivityRing state="idle" testId="idle-ring">
        <span>agent</span>
      </ActivityRing>,
    );
    expect(screen.queryByTestId("idle-ring")).toBeNull();
  });

  it("renders active ring with reduced-motion data and without pulse class", () => {
    render(
      <ActivityRing state="active" reducedMotion testId="active-ring">
        <span>agent</span>
      </ActivityRing>,
    );
    const ring = screen.getByTestId("active-ring");
    expect(ring.getAttribute("data-activity-ring-state")).toBe("active");
    expect(ring.getAttribute("data-reduced-motion")).toBe("true");
    expect(ring.className).not.toContain("activity-ring-active");
  });

  it("HotPotatoEdge uses animateMotion when motion is allowed", () => {
    const { container } = render(
      <svg>
        <HotPotatoEdge {...edgeProps(false)} />
      </svg>,
    );
    expect(container.querySelector("animateMotion")).not.toBeNull();
    expect(screen.getByTestId("hot-potato-packet-packet-1").getAttribute("data-reduced-motion")).toBe("false");
  });

  it("HotPotatoEdge substitutes a static packet under reduced motion", () => {
    const { container } = render(
      <svg>
        <HotPotatoEdge {...edgeProps(true)} />
      </svg>,
    );
    expect(container.querySelector("animateMotion")).toBeNull();
    expect(screen.getByTestId("hot-potato-packet-packet-1").getAttribute("data-reduced-motion")).toBe("true");
  });

  it("whole-card activity classes make active and handoff states visible", () => {
    expect(fallbackActivityCardState("running")).toBe("active");
    expect(fallbackActivityCardState("idle")).toBe("idle");
    expect(getActivityCardClasses({ state: "active" })).toContain("activity-card-active");
    expect(getActivityCardClasses({ state: "needs_input" })).toContain("activity-card-needs-input");
    expect(getActivityCardClasses({ state: "blocked" })).toContain("activity-card-blocked");
    expect(getActivityCardClasses({ state: "active", flash: "target" })).toContain("activity-card-target-flash");
    expect(getActivityCardClasses({ state: "active", flash: "source", reducedMotion: true })).toContain("activity-card-reduced-motion");
  });

  it("hybrid agent card renders compact context and token totals", () => {
    renderHybridNode(
      <HybridAgentNode
        data={{
          logicalId: "driver",
          role: "driver",
          runtime: "claude-code",
          model: null,
          status: "running",
          contextAvailability: "known",
          contextUsedPercentage: 14,
          contextFresh: true,
          contextTotalInputTokens: 200_000,
          contextTotalOutputTokens: 19_000,
          canonicalSessionName: "velocity-driver@openrig-velocity",
        }}
      />,
    );

    expect(screen.getByTestId("hybrid-context-badge").textContent).toBe("14%");
    expect(screen.getByTestId("hybrid-token-total").textContent).toBe("219k");
  });

  it("hybrid terminal hover action opens a single canvas-local terminal popover", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/config") {
        return new Response(JSON.stringify({ settings: {} }));
      }
      if (url.includes("/api/sessions/")) {
        return new Response(JSON.stringify({
          sessionName: "velocity-driver@openrig-velocity",
          content: "latest terminal line",
          lines: 1,
          capturedAt: "2026-05-07T08:00:00Z",
        }));
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    renderHybridNode(
      <>
        <HybridAgentNode
          data={{
            logicalId: "driver",
            role: "driver",
            runtime: "claude-code",
            model: null,
            status: "running",
            rigId: "rig-1",
            canonicalSessionName: "velocity-driver@openrig-velocity",
          }}
        />
        <HybridAgentNode
          data={{
            logicalId: "guard",
            role: "guard",
            runtime: "codex",
            model: null,
            status: "running",
            rigId: "rig-1",
            canonicalSessionName: "velocity-guard@openrig-velocity",
          }}
        />
      </>,
    );

    fireEvent.click(screen.getByTestId("hybrid-driver-terminal-open"));

    expect(screen.getByTestId("hybrid-driver-terminal-popover")).toBeDefined();
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/sessions/velocity-driver%40openrig-velocity/preview?lines=80");
    });
    await screen.findByText("latest terminal line");
    expect(screen.queryByText(/terminal preview/i)).toBeNull();
    expect(screen.queryByTestId("hybrid-driver-terminal-close")).toBeNull();
    expect(screen.queryByText(/live preview/i)).toBeNull();
    expect(screen.queryByText(/captured/i)).toBeNull();
    expect(screen.queryByText(/1 lines/i)).toBeNull();
    expect(screen.getByTestId("hybrid-driver-terminal-preview-pane").getAttribute("data-variant")).toBe("compact-terminal");
    const driverPopover = screen.getByTestId("hybrid-driver-terminal-popover");
    expect(driverPopover.parentElement).toBe(document.body);
    expect(driverPopover.className).toContain("fixed");
    expect(driverPopover.className).toContain("z-[1000]");
    expect(driverPopover.style.left).not.toBe("");
    expect(driverPopover.style.top).not.toBe("");

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("hybrid-driver-terminal-popover")).toBeNull();

    fireEvent.click(screen.getByTestId("hybrid-driver-terminal-open"));
    expect(screen.getByTestId("hybrid-driver-terminal-popover")).toBeDefined();

    fireEvent.click(screen.getByTestId("hybrid-guard-terminal-open"));
    expect(screen.getByTestId("hybrid-guard-terminal-popover")).toBeDefined();
    expect(screen.queryByTestId("hybrid-driver-terminal-popover")).toBeNull();
  });

  it("source scan keeps activity and packet layers production-reachable", () => {
    const srcRoot = path.resolve(__dirname, "../src");
    const host = readFileSync(path.join(srcRoot, "components/topology/HostMultiRigGraph.tsx"), "utf8");
    const rigGraph = readFileSync(path.join(srcRoot, "components/RigGraph.tsx"), "utf8");
    const rigNode = readFileSync(path.join(srcRoot, "components/RigNode.tsx"), "utf8");
    const hybridNodes = readFileSync(path.join(srcRoot, "components/topology/HybridTopologyNodes.tsx"), "utf8");
    const terminalPopover = readFileSync(path.join(srcRoot, "components/topology/TerminalPreviewPopover.tsx"), "utf8");
    const activityCards = readFileSync(path.join(srcRoot, "components/topology/activity-card-visuals.ts"), "utf8");
    const table = readFileSync(path.join(srcRoot, "components/topology/TopologyTableView.tsx"), "utf8");
    const ring = readFileSync(path.join(srcRoot, "components/topology/ActivityRing.tsx"), "utf8");
    const edge = readFileSync(path.join(srcRoot, "components/topology/HotPotatoEdge.tsx"), "utf8");
    const activity = readFileSync(path.join(srcRoot, "lib/topology-activity.ts"), "utf8");
    const hybridLayout = readFileSync(path.join(srcRoot, "lib/hybrid-layout.ts"), "utf8");
    const css = readFileSync(path.join(srcRoot, "globals.css"), "utf8");

    expect(host).toMatch(/useTopologyActivity/);
    expect(host).toMatch(/applyHotPotatoEdges/);
    expect(host).toMatch(/edgeTypes=\{edgeTypes\}/);
    expect(rigGraph).toMatch(/useTopologyActivity/);
    expect(rigGraph).toMatch(/applyHotPotatoEdges/);
    expect(rigGraph).toMatch(/edgeTypes=\{edgeTypes\}/);
    expect(hybridNodes).toMatch(/ActivityRing/);
    expect(hybridNodes).toMatch(/getActivityCardClasses/);
    expect(hybridNodes).toMatch(/TerminalPreviewPopover/);
    expect(rigNode).toMatch(/getActivityCardClasses/);
    expect(rigNode).toMatch(/TerminalPreviewPopover/);
    expect(terminalPopover).toMatch(/SessionPreviewPane/);
    expect(terminalPopover).toMatch(/createPortal/);
    expect(terminalPopover).toMatch(/document\.body/);
    expect(terminalPopover).toMatch(/variant="compact-terminal"/);
    expect(terminalPopover).toMatch(/bg-stone-950/);
    expect(terminalPopover).toMatch(/z-\[1000\]/);
    expect(terminalPopover).not.toMatch(/absolute left-full/);
    expect(terminalPopover).not.toMatch(/terminal preview/);
    expect(terminalPopover).not.toMatch(/terminal-close/);
    expect(activityCards).toMatch(/activity-card-active/);
    expect(rigGraph).toMatch(/activityRing/);
    expect(table).toMatch(/ActivityRing/);
    expect(table).toMatch(/group-hover:opacity-100/);
    expect(ring).not.toMatch(/StatusPip/);
    expect(edge).toMatch(/animateMotion/);
    expect(activity).toMatch(/TOPOLOGY_NODE_ACTIVITY_TTL_MS/);
    expect(activity).toMatch(/HYBRID_CROSS_RIG_STROKE_DASH/);
    expect(activity).not.toMatch(/HOT_POTATO_CROSS_RIG_STROKE_DASH/);
    expect(hybridLayout).toContain('export const HYBRID_CROSS_RIG_STROKE_DASH = "6 7"');
    const sourceFiles = [activity, hybridLayout];
    expect(sourceFiles.join("\n").match(/"6 7"/g) ?? []).toHaveLength(1);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/activity-ring-active/);
    expect(css).toMatch(/activity-card-active/);
    expect(css).toMatch(/activity-card-target-flash/);
    expect(edge).toMatch(/non-scaling-stroke/);
    expect(css).toMatch(/rig-activity-frame-pulse/);
  });
});
