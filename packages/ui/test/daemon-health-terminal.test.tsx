import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import React from "react";
import type { DaemonHealthSignal } from "../src/hooks/useDaemonHealth.js";

// OPR.0.4.3.21 — the live terminal disambiguates the broker's GENERIC
// "terminal broker unavailable" close from a genuinely unhealthy control plane,
// while preserving every SPECIFIC broker/session error.

const instances: MockWS[] = [];

class MockWS {
  url: string;
  readyState = 1;
  onopen: ((evt?: unknown) => void) | null = null;
  onclose: ((evt: { code: number; reason: string }) => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalled = false;
  constructor(url: string) {
    this.url = url;
    instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send() {}
  close() { this.closeCalled = true; this.readyState = 3; }
  static OPEN = 1;
}

vi.stubGlobal("WebSocket", MockWS);

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    child: HTMLElement | null = null;
    open(el: HTMLElement) {
      this.child = document.createElement("div");
      this.child.className = "xterm";
      el.appendChild(this.child);
    }
    write() {}
    onData() {}
    onResize() {}
    focus() {}
    scrollToBottom() {}
    attachCustomWheelEventHandler() {}
    dispose() { this.child?.remove(); this.child = null; }
    loadAddon() {}
    cols = 80;
    rows = 24;
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

beforeEach(() => {
  instances.length = 0;
  window.localStorage.setItem("openrig.terminalBearerToken", "test-tok");
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.removeItem("openrig.terminalBearerToken");
});

async function renderWithHealth(sessionName: string, signal: DaemonHealthSignal) {
  const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");
  const { DaemonHealthContext } = await import("../src/hooks/useDaemonHealth.js");
  const result = render(
    React.createElement(
      DaemonHealthContext.Provider,
      { value: signal },
      React.createElement(FocusedTerminal, { sessionName }),
    ),
  );
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  return result;
}

const UNHEALTHY: DaemonHealthSignal = {
  controlPlaneUnhealthy: true,
  evidence: { lagMeanMs: 900, lagP99Ms: 1200, utilization: 0.99, lastTickAgeMs: 1500, healthy: false },
};
const HEALTHY: DaemonHealthSignal = { controlPlaneUnhealthy: false, evidence: null };

describe("FocusedTerminal health-aware error disambiguation", () => {
  it("overrides the GENERIC broker-unavailable message when the control plane is unhealthy", async () => {
    const { getByTestId } = await renderWithHealth("dev@rig", UNHEALTHY);
    await act(async () => {
      instances[0]!.onclose?.({ code: 1011, reason: "terminal broker unavailable" });
    });
    const el = getByTestId("focused-terminal-dev@rig");
    expect(el.textContent).toContain("daemon control plane unhealthy");
    expect(el.textContent).not.toContain("terminal broker unavailable");
  });

  it("preserves the GENERIC broker-unavailable message when the control plane is healthy", async () => {
    const { getByTestId } = await renderWithHealth("dev@rig", HEALTHY);
    await act(async () => {
      instances[0]!.onclose?.({ code: 1011, reason: "terminal broker unavailable" });
    });
    const el = getByTestId("focused-terminal-dev@rig");
    expect(el.textContent).toContain("terminal broker unavailable");
    expect(el.textContent).not.toContain("daemon control plane unhealthy");
  });

  it("preserves a SPECIFIC session-missing error even when the control plane is unhealthy", async () => {
    const { getByTestId } = await renderWithHealth("dev@rig", UNHEALTHY);
    await act(async () => {
      instances[0]!.onclose?.({ code: 1008, reason: "session not found: dev@rig" });
    });
    const el = getByTestId("focused-terminal-dev@rig");
    expect(el.textContent).toContain("session not found: dev@rig");
    expect(el.textContent).not.toContain("daemon control plane unhealthy");
  });

  it("preserves a SPECIFIC pipe-pane failure even when the control plane is unhealthy", async () => {
    const { getByTestId } = await renderWithHealth("dev@rig", UNHEALTHY);
    await act(async () => {
      instances[0]!.onclose?.({ code: 1011, reason: "pipe-pane failed: boom" });
    });
    const el = getByTestId("focused-terminal-dev@rig");
    expect(el.textContent).toContain("pipe-pane failed: boom");
    expect(el.textContent).not.toContain("daemon control plane unhealthy");
  });
});
