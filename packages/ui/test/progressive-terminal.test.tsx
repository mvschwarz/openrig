// OPR.0.4.0.1 — ProgressiveTerminal behavior: default-static, click-to-live, and
// the GLOBAL cap with oldest-eviction-to-static. The heavy children
// (FocusedTerminal -> xterm+WS, SessionPreviewPane -> polling) are stubbed so the
// test exercises the interaction model + cap, not xterm/WebSocket internals.

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

import { ProgressiveTerminal } from "../src/components/terminal/ProgressiveTerminal.js";
import {
  LiveTerminalProvider,
  __resetFallbackRegistryForTests,
} from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

describe("ProgressiveTerminal (OPR.0.4.0.1 interaction model)", () => {
  it("AC-1: defaults to the STATIC preview on render (no live terminal)", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <ProgressiveTerminal sessionName="a@r" terminalKey="a" />
      </LiveTerminalProvider>,
    );
    expect(screen.getByTestId("preview-a@r")).toBeTruthy();
    expect(screen.queryByTestId("live-a@r")).toBeNull();
  });

  it("AC-2: a click upgrades that terminal to LIVE (FocusedTerminal)", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <ProgressiveTerminal sessionName="a@r" terminalKey="a" />
      </LiveTerminalProvider>,
    );
    fireEvent.click(screen.getByTestId("progressive-terminal-static"));
    expect(screen.getByTestId("live-a@r")).toBeTruthy();
    expect(screen.queryByTestId("preview-a@r")).toBeNull();
  });

  it("AC-4: GLOBAL cap=2 — opening a 3rd live evicts the OLDEST back to static; static previews uncapped", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <ProgressiveTerminal sessionName="a@r" terminalKey="a" testIdPrefix="pt-a" />
        <ProgressiveTerminal sessionName="b@r" terminalKey="b" testIdPrefix="pt-b" />
        <ProgressiveTerminal sessionName="c@r" terminalKey="c" testIdPrefix="pt-c" />
      </LiveTerminalProvider>,
    );
    fireEvent.click(screen.getByTestId("pt-a-static")); // a -> live (oldest)
    fireEvent.click(screen.getByTestId("pt-b-static")); // b -> live
    fireEvent.click(screen.getByTestId("pt-c-static")); // c -> live, evicts a

    // a reverted to static; b + c remain live; total live == cap.
    expect(screen.getByTestId("pt-a-static")).toBeTruthy();
    expect(screen.queryByTestId("live-a@r")).toBeNull();
    expect(screen.getByTestId("live-b@r")).toBeTruthy();
    expect(screen.getByTestId("live-c@r")).toBeTruthy();
  });

  it("AC-5: the cap is config-driven — cap=3 admits three live before evicting", () => {
    render(
      <LiveTerminalProvider cap={3}>
        <ProgressiveTerminal sessionName="a@r" terminalKey="a" testIdPrefix="pt-a" />
        <ProgressiveTerminal sessionName="b@r" terminalKey="b" testIdPrefix="pt-b" />
        <ProgressiveTerminal sessionName="c@r" terminalKey="c" testIdPrefix="pt-c" />
      </LiveTerminalProvider>,
    );
    fireEvent.click(screen.getByTestId("pt-a-static"));
    fireEvent.click(screen.getByTestId("pt-b-static"));
    fireEvent.click(screen.getByTestId("pt-c-static"));
    // cap=3 -> all three live, none evicted.
    expect(screen.getByTestId("live-a@r")).toBeTruthy();
    expect(screen.getByTestId("live-b@r")).toBeTruthy();
    expect(screen.getByTestId("live-c@r")).toBeTruthy();
  });
});
