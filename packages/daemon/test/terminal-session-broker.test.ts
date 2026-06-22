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
    capturePaneContent: async () => null,
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

  it("test 11b: a dead session at open closes the subscriber (1008, honest) and never starts a pipe", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({ hasSession: async () => false, startPipePane }), {
      pollMs: 10,
    });
    const a = makeSub();
    await broker.attach(a);
    // 1008 (policy / session genuinely absent) mirrors the pre-broker route, distinct
    // from 1011 (server-side pipe failure) below.
    expect(a.closed[0]?.code).toBe(1008);
    expect(a.closed[0]?.reason).toContain("session not found");
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

// ---- lifecycle hardening (dev1-guard watchpoints) ---------------------------

describe("TerminalSessionBroker - lifecycle hardening", () => {
  it("singleflight: CONCURRENT first attaches do not race into two pipes", async () => {
    // A delayed startPipePane widens the race window so all three attaches are
    // in flight together; the synchronous started-guard must still yield one pipe.
    const startPipePane = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true as const };
    });
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ startPipePane }), { pollMs: 10 }));
    await Promise.all([broker.attach(makeSub()), broker.attach(makeSub()), broker.attach(makeSub())]);
    expect(startPipePane).toHaveBeenCalledOnce();
    expect(broker.subscriberCount).toBe(3);
  });

  it("fanout isolation: a throwing subscriber does not break others and is detached", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 }));
    const good = makeSub();
    const bad: FakeSub = {
      received: [],
      closed: [],
      send: () => { throw new Error("dead socket"); },
      close: () => {},
    };
    await broker.attach(good);
    await broker.attach(bad);
    expect(broker.subscriberCount).toBe(2);

    fs.appendFileSync(broker.pipeOutputPath!, "ISOLATION-DATA");
    await vi.waitFor(() => {
      expect(good.received.join("")).toContain("ISOLATION-DATA");
      expect(broker.subscriberCount).toBe(1); // the throwing subscriber was detached
    }, { timeout: 1000 });
  });

  it("last-detach unlinks even a NON-EMPTY pipe file (AC-7 no temp leak)", async () => {
    const broker = new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 });
    const a = makeSub();
    await broker.attach(a);
    const path = broker.pipeOutputPath!;
    fs.appendFileSync(path, "real accumulated terminal output bytes");
    expect(fs.statSync(path).size).toBeGreaterThan(0);

    broker.detach(a);
    await vi.waitFor(() => {
      expect(fs.existsSync(path)).toBe(false);
    }, { timeout: 1000 });
  });

  it("registry: CONCURRENT attaches to one session share ONE broker / ONE pipe", async () => {
    const startPipePane = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true as const };
    });
    const reg = new TerminalBrokerRegistry(makeTmux({ startPipePane }), { pollMs: 10 });
    const [b1, b2] = await Promise.all([
      reg.attach("dev@rig", makeSub()),
      reg.attach("dev@rig", makeSub()),
    ]);
    expect(b1).toBe(b2);
    expect(reg.size).toBe(1);
    expect(startPipePane).toHaveBeenCalledOnce();
    b1.dispose();
  });

  it("registry: attach AFTER final-close creates a FRESH broker (no stale reuse)", async () => {
    const reg = new TerminalBrokerRegistry(makeTmux(), { pollMs: 10 });
    const sub1 = makeSub();
    const first = await reg.attach("dev@rig", sub1);
    first.detach(sub1);
    await vi.waitFor(() => { expect(reg.size).toBe(0); }, { timeout: 1000 });

    const sub2 = makeSub();
    const second = await reg.attach("dev@rig", sub2);
    expect(second).not.toBe(first);
    expect(reg.size).toBe(1);
    second.dispose();
  });
});

// ---- AC-5 / FR-4 broker-owned shared history ring ---------------------------
// dev1-guard code-review BLOCKING: late subscribers must get the broker-owned
// shared recent-output history (the bytes that scrolled off the first
// subscriber), not only their own visible-screen capture + future fanout.
describe("TerminalSessionBroker - shared history ring (AC-5)", () => {
  it("a LATE subscriber receives the broker-owned history that scrolled off the first subscriber", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    // capturePaneScreen returns null so the ONLY path for B to see the
    // scrolled-off output is the broker-owned ring (not its own visible seed).
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ startPipePane }), { pollMs: 10 }));
    const a = makeSub();
    await broker.attach(a);

    fs.appendFileSync(broker.pipeOutputPath!, "HISTORY-A-SAW-THEN-SCROLLED-OFF");
    await vi.waitFor(() => {
      expect(a.received.join("")).toContain("HISTORY-A-SAW-THEN-SCROLLED-OFF");
    }, { timeout: 1000 });

    const b = makeSub();
    await broker.attach(b);

    // B must receive the broker-owned history even though its capturePaneScreen is null.
    expect(b.received.join("")).toContain("HISTORY-A-SAW-THEN-SCROLLED-OFF");
    // ...and still no second pipe (FR-1 preserved).
    expect(startPipePane).toHaveBeenCalledOnce();
  });

  it("a LATE subscriber skips unsafe TUI repaint history and receives the current screen snapshot", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({
      capturePaneScreen: async () => "CURRENT SCREEN",
      getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 120, height: 40 }),
    }), { pollMs: 10 }));
    const a = makeSub();
    await broker.attach(a);

    fs.appendFileSync(
      broker.pipeOutputPath!,
      "\x1b[2J\x1b[12;1HSTALE TUI PROMPT\x1b[13;1Hoverpainted status",
    );
    await vi.waitFor(() => {
      expect(a.received.join("")).toContain("STALE TUI PROMPT");
    }, { timeout: 1000 });

    const b = makeSub();
    await broker.attach(b);
    const bSeed = b.received.join("");

    expect(bSeed).not.toContain("STALE TUI PROMPT");
    expect(bSeed).not.toContain("overpainted status");
    expect(bSeed).toContain("CURRENT SCREEN");
  });

  it("the history ring is bounded under sustained output", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 5, maxHistoryBytes: 2048 }));
    await broker.attach(makeSub());
    const path = broker.pipeOutputPath!;
    for (let i = 0; i < 20; i++) {
      fs.appendFileSync(path, "Y".repeat(300)); // 300-byte chunks, each < the 2048 cap
      await new Promise((r) => setTimeout(r, 8));
    }
    expect(broker.historyByteLength).toBeGreaterThan(0);
    expect(broker.historyByteLength).toBeLessThanOrEqual(2048);
  });

  it("the history ring is cleared on final detach (no carry-over / leak)", async () => {
    const broker = new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 });
    const a = makeSub();
    await broker.attach(a);
    fs.appendFileSync(broker.pipeOutputPath!, "transient history");
    await vi.waitFor(() => { expect(broker.historyByteLength).toBeGreaterThan(0); }, { timeout: 1000 });

    broker.detach(a);
    await vi.waitFor(() => { expect(broker.historyByteLength).toBe(0); }, { timeout: 1000 });
  });
});

// ---- concurrent attach FAILURE (dev1-guard re-review watchpoint) ------------
// A concurrent later attach must not be left live on a torn-down broker when
// the shared open fails. All concurrent attaches await the same open result and
// every subscriber closes honestly (no-live-terminal-lies).
describe("TerminalSessionBroker - concurrent attach failure (honest close)", () => {
  it("concurrent first attaches with a DEAD session close ALL subscribers honestly (1008), none left live", async () => {
    let evicted = 0;
    const broker = new TerminalSessionBroker("dead@rig", makeTmux({
      hasSession: async () => { await new Promise((r) => setTimeout(r, 20)); return false; },
    }), { pollMs: 10, onEmpty: () => { evicted += 1; } });
    const a = makeSub();
    const b = makeSub();

    await Promise.all([broker.attach(a), broker.attach(b)]);

    expect(a.closed[0]?.code).toBe(1008);
    expect(b.closed[0]?.code).toBe(1008); // the co-waiter is NOT left live
    expect(broker.subscriberCount).toBe(0);
    expect(evicted).toBe(1); // evicted exactly once
  });

  it("concurrent first attaches with a PIPE-START failure close ALL subscribers (1011), no temp leak", async () => {
    let capturedPath: string | null = null;
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({
      startPipePane: async (_n: string, p: string) => {
        capturedPath = p;
        await new Promise((r) => setTimeout(r, 20));
        return { ok: false as const, code: "pipe_fail", message: "pipe boom" };
      },
    }), { pollMs: 10 });
    const a = makeSub();
    const b = makeSub();

    await Promise.all([broker.attach(a), broker.attach(b)]);

    expect(a.closed[0]?.code).toBe(1011);
    expect(b.closed[0]?.code).toBe(1011);
    expect(broker.subscriberCount).toBe(0);
    if (capturedPath) expect(fs.existsSync(capturedPath)).toBe(false);
  });

  it("registry: concurrent attaches to a dead session close all and evict the broker (size 0)", async () => {
    const reg = new TerminalBrokerRegistry(makeTmux({
      hasSession: async () => { await new Promise((r) => setTimeout(r, 20)); return false; },
    }), { pollMs: 10 });
    const a = makeSub();
    const b = makeSub();

    await Promise.all([reg.attach("dead@rig", a), reg.attach("dead@rig", b)]);

    expect(a.closed[0]?.code).toBe(1008);
    expect(b.closed[0]?.code).toBe(1008);
    await vi.waitFor(() => { expect(reg.size).toBe(0); }, { timeout: 1000 });
  });
});

// ---- teardown-during-seed race (dev1-guard round-3 watchpoint) --------------
// A late attach blocked in its async seed must NOT be added to a broker that
// got torn down (session death / dispose) while the seed was pending - it must
// close honestly with the remembered teardown reason, never go live silently.
describe("TerminalSessionBroker - teardown during seed (honest close)", () => {
  it("a late attach blocked in seed while the session dies closes honestly (1001) and is NOT added", async () => {
    let releaseCapture!: () => void;
    const blocked = new Promise<string | null>((res) => { releaseCapture = () => res("late-screen"); });
    let captureCalls = 0;
    let alive = true;
    let evicted = 0;
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({
      hasSession: async () => alive,
      capturePaneScreen: async () => {
        captureCalls += 1;
        // The FIRST subscriber's seed resolves immediately; the late
        // subscriber's seed blocks until we release it.
        return captureCalls === 1 ? "first-screen" : blocked;
      },
    }), { pollMs: 10, livenessMs: 15, onEmpty: () => { evicted += 1; } });

    const a = makeSub();
    await broker.attach(a); // first subscriber attached, broker live + liveness running

    const b = makeSub();
    const bAttach = broker.attach(b); // blocks inside seed (capturePaneScreen)

    // Session dies while B is mid-seed; liveness fires and tears the broker down.
    alive = false;
    await vi.waitFor(() => { expect(a.closed[0]?.code).toBe(1001); }, { timeout: 1000 });

    releaseCapture(); // B's seed now resolves
    await bAttach;

    expect(b.closed[0]?.code).toBe(1001); // honest close with the remembered death reason
    expect(broker.subscriberCount).toBe(0); // B was NOT added to the dead broker
    expect(evicted).toBe(1);
  });
});

// ---- OPR.0.4.0.39 per-subscriber scroll-back (tmux capture-pane window) ------
// The live xterm screen is only the current `rows`; scrolling UP must show tmux
// SCROLLBACK. Because the broker fans ONE pipe out to many viewers, scroll-back is
// per-subscriber and READ-ONLY on the pane (capture-pane history window), not a
// pane-global copy-mode (which would freeze every viewer). A scrolled subscriber is
// painted a static history window and SKIPPED by the live fanout until it returns to
// the bottom (offset 0), where it repaints the live screen and rejoins the fanout.
describe("TerminalSessionBroker - per-subscriber scroll-back (OPR.0.4.0.39)", () => {
  it("scroll(offset>0) paints a BOTTOM-anchored tmux history window (offset lines up) to ONLY that subscriber", async () => {
    // Model REAL tmux: `capture-pane -p -S -N` returns a buffer that ENDS at the live
    // bottom and contains ~N lines of history ABOVE the visible screen PLUS the screen
    // (so ~N + rows lines). L1..L200 with L200 = the live bottom row.
    const BUF = Array.from({ length: 200 }, (_, i) => `L${i + 1}`);
    const ROWS = 3;
    const capturePaneContent = vi.fn(async (_n: string, n: number) => {
      const count = Math.min(BUF.length, n + ROWS); // -S -N => ~N + rows lines, bottom-anchored
      return BUF.slice(BUF.length - count).join("\n");
    });
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ capturePaneContent }), { pollMs: 10, rows: ROWS }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);
    const aBefore = a.received.length;
    const bBefore = b.received.length;

    await broker.scroll(a, 3); // wheel up 3 lines from the live bottom (L200)

    // Captures (offset + rows) = 3 + 3 = 6 lines back; the painted window is `rows` (3)
    // lines ending `offset` (3) ABOVE the live bottom: bottom row = L200 - 3 = L197,
    // so the window is L195..L197 (NOT the older top of the capture, NOT the live tail).
    expect(capturePaneContent).toHaveBeenCalledWith("dev@rig", 6);
    expect(a.received.length).toBe(aBefore + 1);
    const painted = a.received[a.received.length - 1]!;
    expect(painted.startsWith("\x1b[2J")).toBe(true);
    expect(painted).toContain("\x1b[1;1HL195");
    expect(painted).toContain("\x1b[2;1HL196");
    expect(painted).toContain("\x1b[3;1HL197");
    expect(painted).not.toContain("L198"); // L198..L200 are within the offset (toward live)
    expect(painted).not.toContain("L194"); // above the rows-tall window
    // b (live, never scrolled) is untouched by a's scroll - per-subscriber.
    expect(b.received.length).toBe(bBefore);
  });

  it("a scrolled-back subscriber is SKIPPED by the live fanout; the live viewer still streams", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({
      capturePaneContent: async () => "x1\nx2\nx3\nx4",
    }), { pollMs: 10, rows: 3 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);

    await broker.scroll(a, 2); // a is now viewing a static history window
    const aAfterScroll = a.received.length;

    fs.appendFileSync(broker.pipeOutputPath!, "LIVE-AFTER-SCROLL");
    await vi.waitFor(() => {
      expect(b.received.join("")).toContain("LIVE-AFTER-SCROLL");
    }, { timeout: 1000 });
    // a was scrolled back: the live byte must NOT overwrite its history view.
    expect(a.received.length).toBe(aAfterScroll);
    expect(a.received.join("")).not.toContain("LIVE-AFTER-SCROLL");
  });

  it("scroll(offset 0) repaints the live screen and the subscriber REJOINS the fanout", async () => {
    const capturePaneScreen = vi.fn(async () => "LIVE SCREEN");
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({
      capturePaneContent: async () => "g1\ng2\ng3\ng4",
      capturePaneScreen,
      getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 90, height: 3 }),
    }), { pollMs: 10, rows: 3 }));
    const a = makeSub();
    await broker.attach(a);

    await broker.scroll(a, 2); // into history (skipped by fanout)
    capturePaneScreen.mockClear();
    const beforeReturn = a.received.length;

    await broker.scroll(a, 0); // back to the live bottom

    expect(capturePaneScreen).toHaveBeenCalledWith("dev@rig");
    expect(a.received.length).toBe(beforeReturn + 1);
    expect(a.received[a.received.length - 1]!).toContain("LIVE SCREEN");

    // ...and it rejoins the live fanout (no longer skipped).
    fs.appendFileSync(broker.pipeOutputPath!, "BACK-TO-LIVE-STREAM");
    await vi.waitFor(() => {
      expect(a.received.join("")).toContain("BACK-TO-LIVE-STREAM");
    }, { timeout: 1000 });
  });

  it("scroll on an UNKNOWN subscriber is a no-op (never throws, sends nothing)", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10, rows: 3 }));
    await broker.attach(makeSub());
    const ghost = makeSub(); // never attached
    await broker.scroll(ghost, 5);
    expect(ghost.received.length).toBe(0);
    expect(ghost.closed.length).toBe(0);
  });
});
