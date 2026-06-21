// OPR.0.4.0.1 TopologyTab progressive-terminal forward-fix. The project/scope
// Topology-tab seat terminal (TopologyTab SeatRow) must use the shared
// ProgressiveTerminal -- default-static -> click-to-go-live -- AND join the SAME
// global live-terminal registry/cap as the other surfaces (FR-2), instead of a
// raw static SessionPreviewPane on a split fallback registry. Heavy leaves
// (FocusedTerminal xterm+WS, SessionPreviewPane polling) are stubbed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SliceDetail } from "../src/hooks/useSlices.js";

vi.mock("../src/components/terminal/FocusedTerminal.js", () => ({
  FocusedTerminal: ({ sessionName }: { sessionName: string }) => (
    <div data-testid={`live-${sessionName}`}>live terminal</div>
  ),
}));
vi.mock("../src/components/preview/SessionPreviewPane.js", () => ({
  SessionPreviewPane: ({ sessionName }: { sessionName: string }) => (
    <div data-testid={`preview-${sessionName}`}>static preview</div>
  ),
}));

import { createTestRouter } from "./helpers/test-router.js";
import { TopologyTab } from "../src/components/slices/tabs/TopologyTab.js";
import { ProgressiveTerminal } from "../src/components/terminal/ProgressiveTerminal.js";
import {
  LiveTerminalProvider,
  __resetFallbackRegistryForTests,
} from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

function topologyWith(sessions: string[]): SliceDetail["topology"] {
  return {
    affectedRigs: [{ rigId: "rig-1", rigName: "demo", sessionNames: sessions }],
    totalSeats: sessions.length,
    specGraph: null,
  } as SliceDetail["topology"];
}

describe("TopologyTab progressive terminal (OPR.0.4.0.1 forward-fix)", () => {
  it("AC-1: the seat preview is default-STATIC, and a click upgrades it to LIVE", async () => {
    render(
      createTestRouter({
        component: () => (
          <LiveTerminalProvider cap={2}>
            <TopologyTab topology={topologyWith(["a@r"])} />
          </LiveTerminalProvider>
        ),
        path: "/",
      }),
    );

    // expand the seat row (the router mounts asynchronously)
    fireEvent.click(await screen.findByTestId("topology-seat-a@r-toggle"));
    // default-static: the ProgressiveTerminal static trigger is present, no live yet
    expect(screen.getByTestId("topology-preview-a@r-static")).toBeTruthy();
    expect(screen.queryByTestId("live-a@r")).toBeNull();
    // click inside -> go live
    fireEvent.click(screen.getByTestId("topology-preview-a@r-static"));
    expect(screen.getByTestId("topology-preview-a@r-live")).toBeTruthy();
    expect(screen.getByTestId("live-a@r")).toBeTruthy();
  });

  it("AC-2: the topology-tab terminal SHARES the global cap with other surfaces (cap=2 evicts oldest)", async () => {
    render(
      createTestRouter({
        component: () => (
          <LiveTerminalProvider cap={2}>
            <TopologyTab topology={topologyWith(["t@r"])} />
            {/* two OTHER-surface terminals under the SAME provider */}
            <ProgressiveTerminal sessionName="n1@r" terminalKey="node-detail:n1@r" testIdPrefix="other-n1" />
            <ProgressiveTerminal sessionName="n2@r" terminalKey="node-detail:n2@r" testIdPrefix="other-n2" />
          </LiveTerminalProvider>
        ),
        path: "/",
      }),
    );

    // take the topology-tab terminal live first (oldest); router mounts async
    fireEvent.click(await screen.findByTestId("topology-seat-t@r-toggle"));
    fireEvent.click(screen.getByTestId("topology-preview-t@r-static"));
    expect(screen.getByTestId("topology-preview-t@r-live")).toBeTruthy();

    // take the two other-surface terminals live -> the 3rd exceeds cap=2 ->
    // the OLDEST (the topology-tab one) evicts back to static.
    fireEvent.click(screen.getByTestId("other-n1-static"));
    fireEvent.click(screen.getByTestId("other-n2-static"));

    // PROOF the topology-tab terminal joined the SAME registry: it was evicted by
    // OTHER surfaces going live -> reverted to static, not still live.
    expect(screen.queryByTestId("topology-preview-t@r-live")).toBeNull();
    expect(screen.getByTestId("topology-preview-t@r-static")).toBeTruthy();
    expect(screen.getByTestId("live-n1@r")).toBeTruthy();
    expect(screen.getByTestId("live-n2@r")).toBeTruthy();
  });

  it("FR-2: project ScopePages mounts an explicit shared LiveTerminalProvider (not the fallback)", () => {
    // Source guard: the project scope shell wraps its pages in an explicit
    // LiveTerminalProvider (cap from useTerminalCap) so the Topology-tab terminal
    // + the page's other terminals (e.g. HostMultiRigGraph) share ONE registry,
    // instead of TopologyTab landing on the module-singleton fallback.
    const src = readFileSync(path.join(import.meta.dirname, "../src/components/project/ScopePages.tsx"), "utf8");
    expect(src).toContain("LiveTerminalProvider");
    expect(src).toContain("useTerminalCap");
  });
});
