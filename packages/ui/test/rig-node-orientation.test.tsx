// OPR.0.4.3.06 forward-fix — the topology node must CONSUME + render the
// startup-proof orientation verdict, not carry it silently in node data while
// defaulting green. Keystone: a `rejected`/`missing` orientation renders its
// own non-verified label; a bare-ACK-derived `rejected` NEVER renders as
// verified/proven; `verified` renders verified; `n-a` (resumed/non-agent) is
// hidden (mirrors the RESTORE badge).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";

// Heavy leaves are only mounted when the terminal popover opens; stub them so a
// plain node render never reaches xterm/WebSocket.
vi.mock("../src/components/terminal/FocusedTerminal.js", () => ({
  FocusedTerminal: ({ sessionName }: { sessionName: string }) => <div data-testid={`live-${sessionName}`} />,
}));
vi.mock("../src/components/preview/SessionPreviewPane.js", () => ({
  SessionPreviewPane: ({ sessionName }: { sessionName: string }) => <div data-testid={`preview-${sessionName}`} />,
}));

import { RigNode } from "../src/components/RigNode.js";
import { __resetFallbackRegistryForTests } from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

function renderNode(oriented: string | undefined) {
  render(
    <ReactFlowProvider>
      <RigNode
        data={{
          logicalId: "dev.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          // `ready` = delivered/interactive — the exact green-default state the
          // 19/21 gap hides an unverified orientation behind.
          startupStatus: "ready" as const,
          canonicalSessionName: "dev-impl@test-rig",
          binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: "s1" },
          oriented,
        }}
      />
    </ReactFlowProvider>,
  );
}

describe("RigNode startup-proof orientation badge (OPR.0.4.3.06)", () => {
  it("renders the verdict label for a REJECTED orientation, never as verified/proven", () => {
    renderNode("rejected");
    const badge = screen.getByTestId("orientation-badge");
    expect(badge.textContent).toContain("rejected");
    // Keystone: a rejected (incl. bare-ACK) proof must NEVER read as verified.
    expect(badge.textContent).not.toMatch(/verified|proven|oriented(?!:)/i);
  });

  it("renders the verdict label for a MISSING orientation (challenged, unproven)", () => {
    renderNode("missing");
    expect(screen.getByTestId("orientation-badge").textContent).toContain("missing");
  });

  it("renders the verdict label for a VERIFIED orientation", () => {
    renderNode("verified");
    expect(screen.getByTestId("orientation-badge").textContent).toContain("verified");
  });

  it("hides the badge for n-a (resumed / non-agent — nothing to prove)", () => {
    renderNode("n-a");
    expect(screen.queryByTestId("orientation-badge")).toBeNull();
  });

  it("hides the badge when the node data carries no orientation", () => {
    renderNode(undefined);
    expect(screen.queryByTestId("orientation-badge")).toBeNull();
  });
});
