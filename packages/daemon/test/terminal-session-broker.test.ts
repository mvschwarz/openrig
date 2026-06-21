import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import {
  TerminalSessionBroker,
  TerminalBrokerRegistry,
  screenSnapshotEscape,
  cursorPositionEscape,
  type BrokerTmux,
  type TerminalSubscriber,
} from "../src/terminal/TerminalSessionBroker.js";

// ---- test doubles -----------------------------------------------------------

interface FakeSub extends TerminalSubscriber {
  received: string[];
  closed: { code: number; reason: string }[];
}

function makeSub(): FakeSub {
  const received: string[] = [];
  const closed: { code: number; reason: string }[] = [];
  return {
    received,
    closed,
    send: (d: string) => { received.push(d); },
    close: (code: number, reason: string) => { closed.push({ code, reason }); },
  };
}

function makeTmux(overrides: Partial<BrokerTmux> = {}): BrokerTmux {
  return {
    hasSession: async () => true,
    setWindowOption: async () => ({ ok: true }),
    resizeWindow: async () => ({ ok: true }),
    startPipePane: async () => ({ ok: true }),
    stopPipePane: async () => ({ ok: true }),
    sendKeys: async () => ({ ok: true }),
    sendText: async () => ({ ok: true }),
    capturePaneScreen: async () => null,
    getPaneCursorPosition: async () => null,
    ...overrides,
  };
}

// Track brokers created so we always tear down (clears intervals + temp files).
const liveBrokers: TerminalSessionBroker[] = [];
function track(b: TerminalSessionBroker): TerminalSessionBroker {
  liveBrokers.push(b);
  return b;
}
afterEach(() => {
  for (const b of liveBrokers.splice(0)) b.dispose();
});

// ---- pure cursor-safe seed helpers (test #9 row-drift discriminator) --------

describe("cursor-safe seed helpers", () => {
  it("cursorPositionEscape emits a 1-based absolute cursor move", () => {
    expect(cursorPositionEscape(0, 0)).toBe("\x1b[1;1H");
    expect(cursorPositionEscape(4, 7)).toBe("\x1b[8;5H");
  });

  it("screenSnapshotEscape paints each row with an ABSOLUTE move (no row drift)", () => {
    const out = screenSnapshotEscape("alpha\nbeta\ngamma", { x: 2, y: 1, height: 24 });
    expect(out.startsWith("\x1b[2J")).toBe(true);
    expect(out).toContain("\x1b[1;1Halpha");
    expect(out).toContain("\x1b[2;1Hbeta");
    expect(out).toContain("\x1b[3;1Hgamma");
    expect(out.endsWith(cursorPositionEscape(2, 1))).toBe(true);
  });

  it("keeps only the last `height` rows when rows exceed height (scroll-safe)", () => {
    const out = screenSnapshotEscape(["r1", "r2", "r3", "r4", "r5"].join("\n"), { x: 0, y: 0, height: 2 });
    expect(out).not.toContain("r1");
    expect(out).not.toContain("r3");
    expect(out).toContain("\x1b[1;1Hr4");
    expect(out).toContain("\x1b[2;1Hr5");
  });

  it("normalizes CRLF and drops exactly one trailing newline; null cursor homes", () => {
    expect(screenSnapshotEscape("a\r\nb\r\n", null)).toBe("\x1b[2J\x1b[1;1Ha\x1b[2;1Hb\x1b[H");
  });
});

// ---- broker behavior --------------------------------------------------------

describe("TerminalSessionBroker", () => {
  it("test 1: fans output bytes out to ALL subscribers", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);

    const path = broker.pipeOutputPath!;
    expect(path).toBeTruthy();
    fs.appendFileSync(path, "hello-world");

    await vi.waitFor(() => {
      expect(a.received.join("")).toContain("hello-world");
      expect(b.received.join("")).toContain("hello-world");
    }, { timeout: 1000 });
  });

  it("test 2: a 2nd subscriber does NOT start a second pipe-pane", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ startPipePane }), { pollMs: 10 }));
    await broker.attach(makeSub());
    await broker.attach(makeSub());
    expect(startPipePane).toHaveBeenCalledOnce();
    expect(broker.subscriberCount).toBe(2);
  });

  it("test 3: input from a subscriber forwards to tmux sendText / sendKeys", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ sendText, sendKeys }), { pollMs: 10 }));
    await broker.attach(makeSub());

    await broker.input({ type: "text", text: "echo hi" });
    await broker.input({ type: "keys", keys: ["Enter"] });

    expect(sendText).toHaveBeenCalledWith("dev@rig", "echo hi");
    expect(sendKeys).toHaveBeenCalledWith("dev@rig", ["Enter"]);
  });

  it("test 3b: serializes rapid input before calling tmux (ordering preserved)", async () => {
    const order: string[] = [];
    const sendText = vi.fn(async (_n: string, t: string) => {
      await new Promise((r) => setTimeout(r, t === "e" ? 20 : 0));
      order.push(t);
      return { ok: true as const };
    });
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ sendText }), { pollMs: 10 }));
    await broker.attach(makeSub());

    void broker.input({ type: "text", text: "e" });
    void broker.input({ type: "text", text: "c" });
    void broker.input({ type: "text", text: "h" });
    await broker.input({ type: "text", text: "o" });

    expect(order.join("")).toBe("echo");
  });

  it("test 4: disconnecting one subscriber keeps the broker alive for the rest", async () => {
    const stopPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ stopPipePane }), { pollMs: 10 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);

    broker.detach(a);
    expect(broker.subscriberCount).toBe(1);
    expect(stopPipePane).not.toHaveBeenCalled();

    fs.appendFileSync(broker.pipeOutputPath!, "still-live");
    await vi.waitFor(() => {
      expect(b.received.join("")).toContain("still-live");
    }, { timeout: 1000 });
    expect(a.received.join("")).not.toContain("still-live");
  });

  it("test 5: the FINAL disconnect stops pipe-pane and deletes the temp file", async () => {
    const stopPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({ stopPipePane }), { pollMs: 10 });
    const a = makeSub();
    await broker.attach(a);
    const path = broker.pipeOutputPath!;
    expect(fs.existsSync(path)).toBe(true);

    broker.detach(a);
    await vi.waitFor(() => {
      expect(stopPipePane).toHaveBeenCalledWith("dev@rig");
      expect(fs.existsSync(path)).toBe(false);
    }, { timeout: 1000 });
    expect(broker.subscriberCount).toBe(0);
  });

  it("test 6: session death closes ALL subscribers honestly (1001), no silent stale-live", async () => {
    let alive = true;
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ hasSession: async () => alive }), {
      pollMs: 10,
      livenessMs: 20,
    }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);

    alive = false;
    await vi.waitFor(() => {
      expect(a.closed[0]?.code).toBe(1001);
      expect(b.closed[0]?.code).toBe(1001);
    }, { timeout: 1000 });
    expect(a.closed[0]?.reason).toContain("terminated");
  });

  it("test 7 (broker side): input has no resize path — a resize never reaches tmux.resizeWindow via input", async () => {
    const resizeWindow = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ resizeWindow }), { pollMs: 10 }));
    await broker.attach(makeSub());
    resizeWindow.mockClear(); // ignore the one canonical-geometry resize at open
    // The broker input API only accepts keys/text; there is no client-driven resize.
    await broker.input({ type: "text", text: "x" });
    expect(resizeWindow).not.toHaveBeenCalled();
  });

  it("test 7b: canonical geometry is set ONCE at open (window-size manual + 120xN, NOT aggressive-resize)", async () => {
    const setWindowOption = vi.fn(async () => ({ ok: true as const }));
    const resizeWindow = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ setWindowOption, resizeWindow }), {
      pollMs: 10,
      cols: 120,
      rows: 40,
    }));
    await broker.attach(makeSub());
    await broker.attach(makeSub());

    expect(resizeWindow).toHaveBeenCalledOnce();
    expect(resizeWindow).toHaveBeenCalledWith("dev@rig", 120, 40);
    expect(setWindowOption).toHaveBeenCalledWith("dev@rig", "window-size", "manual");
    // aggressive-resize fights fixed geometry (shrinks to smallest client) — must NOT be set.
    expect(setWindowOption).not.toHaveBeenCalledWith("dev@rig", "aggressive-resize", expect.anything());
  });

  it("test 8: seeds on FIRST attach with NO resize message, as the first bytes the subscriber sees", async () => {
    const tmux = makeTmux({
      capturePaneScreen: async () => "line one\nline two",
      getPaneCursorPosition: async () => ({ x: 3, y: 1, width: 120, height: 40 }),
    });
    const broker = track(new TerminalSessionBroker("dev@rig", tmux, { pollMs: 10 }));
    const a = makeSub();
    await broker.attach(a);

    expect(a.received[0]).toBe(screenSnapshotEscape("line one\nline two", { x: 3, y: 1, height: 40 }));
    expect(a.received[0]!.startsWith("\x1b[2J")).toBe(true);
  });

  it("test 8b: EACH subscriber gets its own seed (2nd subscriber seeded too, no shared pipe)", async () => {
    const tmux = makeTmux({ capturePaneScreen: async () => "screen" });
    const broker = track(new TerminalSessionBroker("dev@rig", tmux, { pollMs: 10 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);
    expect(a.received[0]).toContain("screen");
    expect(b.received[0]).toContain("screen");
  });

  it("test 9: the seed uses the VISIBLE-screen capture + cursor (absolute paint), never scrollback", async () => {
    const capturePaneScreen = vi.fn(async () => "r1\nr2\nr3");
    const getPaneCursorPosition = vi.fn(async () => ({ x: 1, y: 2, width: 80, height: 24 }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ capturePaneScreen, getPaneCursorPosition }), {
      pollMs: 10,
    }));
    const a = makeSub();
    await broker.attach(a);

    expect(capturePaneScreen).toHaveBeenCalledWith("dev@rig");
    const seed = a.received[0]!;
    expect(seed).toContain("\x1b[1;1Hr1");
    expect(seed).toContain("\x1b[3;1Hr3");
    expect(seed.endsWith(cursorPositionEscape(1, 2))).toBe(true);
  });

  it("test 11: a pipe-pane failure leaks no temp file, closes the subscriber, and evicts the broker", async () => {
    let evicted: string | null = null;
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({
      startPipePane: async () => ({ ok: false, code: "session_not_found", message: "gone" }),
    }), { pollMs: 10, onEmpty: (n) => { evicted = n; } });
    const a = makeSub();
    await broker.attach(a);

    const path = broker.pipeOutputPath;
    expect(a.closed[0]?.code).toBe(1011);
    expect(evicted).toBe("dev@rig");
    expect(broker.subscriberCount).toBe(0);
    if (path) expect(fs.existsSync(path)).toBe(false);
  });

  it("test 11b: a dead session at open closes the subscriber and never starts a pipe", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({ hasSession: async () => false, startPipePane }), {
      pollMs: 10,
    });
    const a = makeSub();
    await broker.attach(a);
    expect(a.closed[0]?.code).toBe(1011);
    expect(startPipePane).not.toHaveBeenCalled();
  });
});

// ---- registry: create-if-absent + eviction ---------------------------------

describe("TerminalBrokerRegistry", () => {
  it("create-if-absent: two subscribers on one session share ONE broker / ONE pipe", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    const reg = new TerminalBrokerRegistry(makeTmux({ startPipePane }), { pollMs: 10 });
    const b1 = await reg.attach("dev@rig", makeSub());
    const b2 = await reg.attach("dev@rig", makeSub());
    expect(b1).toBe(b2);
    expect(reg.size).toBe(1);
    expect(startPipePane).toHaveBeenCalledOnce();
    b1.dispose();
  });

  it("distinct sessions get distinct brokers", async () => {
    const reg = new TerminalBrokerRegistry(makeTmux(), { pollMs: 10 });
    const b1 = await reg.attach("a@rig", makeSub());
    const b2 = await reg.attach("b@rig", makeSub());
    expect(b1).not.toBe(b2);
    expect(reg.size).toBe(2);
    b1.dispose();
    b2.dispose();
  });

  it("evicts a broker from the registry once its last subscriber detaches", async () => {
    const reg = new TerminalBrokerRegistry(makeTmux(), { pollMs: 10 });
    const sub = makeSub();
    const broker = await reg.attach("dev@rig", sub);
    expect(reg.size).toBe(1);
    broker.detach(sub);
    await vi.waitFor(() => {
      expect(reg.size).toBe(0);
    }, { timeout: 1000 });
  });
});
