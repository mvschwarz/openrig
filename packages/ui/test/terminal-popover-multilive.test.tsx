// OPR.0.4.0.1 rev1-r2 fix: progressive terminal popovers (the graph/table
// surfaces) must COEXIST under the global LiveTerminalRegistry cap. The old
// single-open TERMINAL_PREVIEW_EVENT force-closed every sibling popover when one
// opened, so only ONE popover (hence <=1 live) could exist at a time -- making
// AC-4 ("watch A while typing in B" + cap=2 oldest-eviction) UNREACHABLE on the
// popover surfaces (only the topology grid in-place path reached it). Progressive
// popovers now open independently; the global cap bounds the live count.
// Heavy leaves (FocusedTerminal xterm+WS, SessionPreviewPane polling) are stubbed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

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

import { TerminalPreviewPopover } from "../src/components/topology/TerminalPreviewPopover.js";
import {
  LiveTerminalProvider,
  __resetFallbackRegistryForTests,
} from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

// Open a progressive popover and click its static trigger to go live.
function goLive(prefix: string) {
  fireEvent.click(screen.getByTestId(`${prefix}-terminal-open`));
  fireEvent.click(screen.getByTestId(`${prefix}-static`));
}

describe("Progressive terminal popovers coexist under the global cap (rev1-r2 fix)", () => {
  it("opening a second progressive popover does NOT close the first -- two live at once", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <TerminalPreviewPopover rigId="r1" logicalId="a" sessionName="a@r" testIdPrefix="pa" progressive />
        <TerminalPreviewPopover rigId="r1" logicalId="b" sessionName="b@r" testIdPrefix="pb" progressive />
      </LiveTerminalProvider>,
    );
    goLive("pa");
    expect(screen.getByTestId("live-a@r")).toBeTruthy();
    goLive("pb");
    // BOTH live simultaneously -- the first popover was NOT force-closed.
    expect(screen.getByTestId("live-a@r")).toBeTruthy();
    expect(screen.getByTestId("live-b@r")).toBeTruthy();
  });

  it("a third live progressive popover evicts the OLDEST to static (global cap=2)", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <TerminalPreviewPopover rigId="r1" logicalId="a" sessionName="a@r" testIdPrefix="pa" progressive />
        <TerminalPreviewPopover rigId="r1" logicalId="b" sessionName="b@r" testIdPrefix="pb" progressive />
        <TerminalPreviewPopover rigId="r1" logicalId="c" sessionName="c@r" testIdPrefix="pc" progressive />
      </LiveTerminalProvider>,
    );
    goLive("pa");
    goLive("pb");
    goLive("pc");
    // cap=2: the oldest (a) reverts to static; b + c stay live.
    expect(screen.queryByTestId("live-a@r")).toBeNull();
    expect(screen.getByTestId("live-b@r")).toBeTruthy();
    expect(screen.getByTestId("live-c@r")).toBeTruthy();
  });
});
