import { describe, it, expect, vi } from "vitest";

describe("FocusedTerminal lifecycle", () => {
  it("source guard: FocusedTerminal imports @xterm/xterm/css/xterm.css", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/FocusedTerminal.tsx"),
      "utf-8",
    );
    expect(src).toContain('@xterm/xterm/css/xterm.css');
  });

  it("source guard: OPR.0.4.0.38 FR-7 - no client resize-send to the daemon", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/FocusedTerminal.tsx"),
      "utf-8",
    );
    // The broker owns fixed canonical geometry; the client must NOT send a
    // resize (it would shrink the shared pane for every other viewer).
    expect(src).not.toMatch(/type:\s*["']resize["']/);
    // OPR.0.4.0.38 forward-fix: the client now PINS to the broker canonical
    // geometry (cols=100 rows=40) and scrolls/pans its container - FitAddon was
    // removed entirely (no container-fit resize-fight), which is the stronger
    // form of fixed-geometry mirroring.
    expect(src).not.toContain("FitAddon");
    expect(src).toContain("cols: LIVE_TERMINAL_COLS");
  });

  it("source guard: cleanup closes wsRef.current not local ws", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/FocusedTerminal.tsx"),
      "utf-8",
    );
    expect(src).toContain("const activeWs = wsRef.current");
    expect(src).toContain("activeWs.close()");
    expect(src).not.toMatch(/\bws\?\.close\(\)/);
  });

  it("source guard: onclose schedules reconnect via connect()", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/FocusedTerminal.tsx"),
      "utf-8",
    );
    expect(src).toContain("[disconnected - reconnecting...]");
    expect(src).toContain("mountedRef.current");
    expect(src).toMatch(/setTimeout\(\s*\(\)\s*=>\s*\{/);
    // The reconnect schedules connectForGeneration(gen). (The prior
    // toContain("connect()") was a false-positive match on resizeObs.disconnect()
    // - now removed with FitAddon - so it is corrected to the real reconnect call.)
    expect(src).toContain("connectForGeneration(gen)");
  });

  it("source guard: cleanup sets mountedRef false and clears reconnect timer", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/FocusedTerminal.tsx"),
      "utf-8",
    );
    expect(src).toContain("mountedRef.current = false");
    expect(src).toContain("clearTimeout(reconnectTimerRef.current)");
  });

  it("mapXtermInput is exported for direct testing", async () => {
    const { mapXtermInput } = await import("../src/components/terminal/FocusedTerminal.js");
    expect(typeof mapXtermInput).toBe("function");
  });
});
