// OPR.0.4.0.1 round-two QA fix: the rig-scope graph node popover
// (RigNode -> TerminalPreviewPopover) must participate in the progressive
// default-static -> click-inside-to-go-live model, NOT open an immediate
// always-live FocusedTerminal. QA BLOCKING (qitem-20260621025642-b4c89c72)
// proved RigNode mounted the popover without the `progressive` prop, so
// opening it produced a live xterm/WebSocket immediately. The heavy leaves
// (FocusedTerminal -> xterm+WS, SessionPreviewPane -> polling) are stubbed so
// the test exercises the RigNode -> popover -> ProgressiveTerminal wiring.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";

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

import { RigNode } from "../src/components/RigNode.js";
import { __resetFallbackRegistryForTests } from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

describe("RigNode terminal popover (OPR.0.4.0.1 round-two QA fix)", () => {
  it("opens default-STATIC (ProgressiveTerminal), not an immediate live FocusedTerminal", () => {
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
            startupStatus: "ready" as const,
            canonicalSessionName: "dev-impl@test-rig",
            binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: "s1" },
            resumeToken: "abc-123",
          }}
        />
      </ReactFlowProvider>,
    );

    fireEvent.click(screen.getByTestId("rig-node-dev.impl-terminal-open"));

    // The popover renders ProgressiveTerminal, whose default mode is the STATIC
    // SessionPreviewPane -- so the static preview is present...
    expect(screen.getByTestId("preview-dev-impl@test-rig")).toBeTruthy();
    // ...and NO live xterm/WebSocket terminal is mounted on open.
    expect(screen.queryByTestId("live-dev-impl@test-rig")).toBeNull();
  });
});
