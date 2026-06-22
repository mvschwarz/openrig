import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import React from "react";

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

const terminalWrites: string[] = [];
let terminalDisposeCount = 0;

vi.stubGlobal("WebSocket", MockWS);

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    child: HTMLElement | null = null;
    open(el: HTMLElement) {
      this.child = document.createElement("div");
      this.child.className = "xterm";
      this.child.textContent = "xterm child";
      el.appendChild(this.child);
    }
    write(data: string) { terminalWrites.push(data); }
    onData(_cb: (data: string) => void) {}
    onResize(_cb: (size: { cols: number; rows: number }) => void) {}
    // The real xterm Terminal exposes focus() + scrollToBottom(); FocusedTerminal
    // calls both (focus on open, scrollToBottom in the scroll-to-prompt path).
    // Stub them so the component's setup does not throw in the mock.
    focus() {}
    scrollToBottom() {}
    // OPR.0.4.0.39: FocusedTerminal attaches a wheel handler for tmux scroll-back.
    attachCustomWheelEventHandler(_h: (ev: WheelEvent) => boolean) {}
    dispose() {
      terminalDisposeCount++;
      this.child?.remove();
      this.child = null;
    }
    loadAddon() {}
    cols = 80;
    rows = 24;
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit() {} },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

beforeEach(() => {
  instances.length = 0;
  terminalWrites.length = 0;
  terminalDisposeCount = 0;
  window.localStorage.setItem("openrig.terminalBearerToken", "test-tok");
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.removeItem("openrig.terminalBearerToken");
});

describe("FocusedTerminal reconnect behavior", () => {
  it("close triggers reconnecting message + new WebSocket after 3s", async () => {
    const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");

    render(React.createElement(FocusedTerminal, { sessionName: "dev-impl@test-rig" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(instances.length).toBe(1);
    expect(instances[0]!.url).toContain("/api/terminal/dev-impl%40test-rig");
    expect(instances[0]!.url).toContain("token=test-tok");

    // Simulate session death -> onclose
    await act(async () => {
      instances[0]!.onclose?.({ code: 1006, reason: "connection lost" });
    });

    expect(terminalWrites.some((w) => w.includes("[disconnected - reconnecting...]"))).toBe(true);

    // Advance 3s -> reconnect
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(instances.length).toBe(2);
    expect(instances[1]!.url).toContain("/api/terminal/dev-impl%40test-rig");
    expect(instances[1]!.url).toContain("token=test-tok");
  });

  it("unmount after reconnect closes the reconnected socket", async () => {
    const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");

    const { unmount } = render(React.createElement(FocusedTerminal, { sessionName: "cleanup-test" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    // Trigger close + reconnect
    await act(async () => { instances[0]!.onclose?.({ code: 1006, reason: "connection lost" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(instances.length).toBe(2);

    unmount();

    expect(instances[1]!.closeCalled).toBe(true);

    // No third socket after unmount
    const countAfterUnmount = instances.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(instances.length).toBe(countAfterUnmount);
  });

  it("unmount before reconnect timer fires prevents new socket", async () => {
    const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");

    const { unmount } = render(React.createElement(FocusedTerminal, { sessionName: "early-unmount" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    // Trigger close to schedule reconnect
    await act(async () => { instances[0]!.onclose?.({ code: 1006, reason: "connection lost" }); });

    // Unmount before 3s
    unmount();

    // Advance past reconnect timer
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    // No second socket created
    expect(instances.length).toBe(1);
  });

  it("session change invalidates old socket's reconnect (no stale reconnect)", async () => {
    const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");

    const { rerender } = render(
      React.createElement(FocusedTerminal, { sessionName: "old-session" }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(instances.length).toBe(1);
    const oldSocket = instances[0]!;
    expect(oldSocket.url).toContain("old-session");

    // Rerender with new session (triggers cleanup + new effect)
    rerender(React.createElement(FocusedTerminal, { sessionName: "new-session" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    // New session socket should be created
    const newSessionSockets = instances.filter((i) => i.url.includes("new-session"));
    expect(newSessionSockets.length).toBeGreaterThanOrEqual(1);

    // Old socket's onclose fires (stale close from cleanup)
    await act(async () => { oldSocket.onclose?.({ code: 1006, reason: "cleanup" }); });

    // Advance past reconnect timer
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    // No stale reconnect to old-session
    const oldSessionSockets = instances.filter((i) => i.url.includes("old-session"));
    expect(oldSessionSockets.length).toBe(1);
  });

  it("definitive close (code 1008 session not found) shows unavailable and does NOT reconnect", async () => {
    const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");

    const { container } = render(
      React.createElement(FocusedTerminal, { sessionName: "missing-session" }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(instances.length).toBe(1);

    await act(async () => {
      instances[0]!.onclose?.({ code: 1008, reason: "session not found: missing-session" });
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(container.textContent).toContain("Terminal unavailable");
    expect(container.textContent).toContain("session not found");
    expect(container.querySelector(".xterm")).toBeNull();
    expect(terminalDisposeCount).toBe(1);

    const countBefore = instances.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(instances.length).toBe(countBefore);
  });

  it("transient close (code 1006) still reconnects", async () => {
    const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");

    render(React.createElement(FocusedTerminal, { sessionName: "transient-test" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    await act(async () => {
      instances[0]!.onclose?.({ code: 1006, reason: "" });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(instances.length).toBe(2);
  });
});
