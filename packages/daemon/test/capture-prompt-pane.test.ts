// A seat sat at a native approval in an 18x12 pane, and `rig capture` showed only the bottom of the menu, so nobody could
// see what it was asking. A capture that shows a prompt in a pane smaller than 80x24 now says the prompt may be cut off,
// and how to resize the seat's window to read it.
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TerminalSessionBroker } from "../src/terminal/TerminalSessionBroker.js";
import { createDb } from "../src/db/connection.js";
import { transportRoutes } from "../src/routes/transport.js";
const exec = promisify(execFile);

// What an 18-column pane shows of a Claude Code approval: the question wraps, and only the bottom of the menu fits.
const NARROW_APPROVAL = ["Do you want to", "proceed?", "❯ 1. Yes", "  2. No", "", "Esc to cancel"].join("\n") + "\n";
const SHELL = ["$ ls", "notes.md", "$"].join("\n") + "\n";

describe("rig capture says when a pane is too small to show the prompt the seat is at", () => {
  const dbs: Array<ReturnType<typeof createDb>> = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  async function make(screen: string, size: { width: number; height: number }) {
    const { SessionTransport } = await import("../src/domain/session-transport.js");
    const listPanes = vi.fn(async () => [{ id: "%1", index: 0, cwd: "/", ...size, active: true }]);
    const tmux = { probeSession: vi.fn(async () => ({ state: "present" })), capturePaneContent: vi.fn(async () => screen), listPanes };
    const db = createDb(); dbs.push(db);
    const transport = Object.create(SessionTransport.prototype) as InstanceType<typeof SessionTransport>;
    Object.assign(transport, {
      db, tmuxAdapter: tmux,
      getSessionMeta: () => ({ runtime: "claude-code", attachmentType: "tmux", nodeId: "n1", pane: "%1", occupant: null, resumeToken: null }),
      absenceProbeTarget: () => null,
      now: () => new Date(),
      recordSessionMissingVerdict: () => {},
      reconcileStartupReadiness: async () => {},
    });
    return { transport, listPanes };
  }

  it("an approval in an 18x12 pane says the prompt may be cut off and how to resize the window", async () => {
    const { transport } = await make(NARROW_APPROVAL, { width: 18, height: 12 });
    const result = await transport.capture("review@rig", { promptPane: true });
    expect(result).toMatchObject({ ok: true, content: NARROW_APPROVAL, promptPane: { width: 18, height: 12 } });
    expect(result.promptPane?.hint).toBe(
      "pane 18x12 is smaller than 80x24, so the prompt may be cut off; read it at a readable size with rig capture review@rig --readable");
  });

  it("the same approval in a normal pane, and a shell in a small pane, add nothing; only a prompt costs the size read", async () => {
    const normal = await make(NARROW_APPROVAL, { width: 120, height: 40 });
    expect(await normal.transport.capture("review@rig", { promptPane: true })).not.toHaveProperty("promptPane");
    const shell = await make(SHELL, { width: 18, height: 12 });
    expect(await shell.transport.capture("review@rig", { promptPane: true })).not.toHaveProperty("promptPane");
    expect(shell.listPanes).not.toHaveBeenCalled();
  });

  it("a caller that doesn't ask (the preview routes, attention recovery) gets main's result with no size read", async () => {
    const { transport, listPanes } = await make(NARROW_APPROVAL, { width: 18, height: 12 });
    expect(await transport.capture("review@rig", { lines: 20 })).toEqual({ ok: true, sessionName: "review@rig", content: NARROW_APPROVAL, lines: 20 });
    expect(listPanes).not.toHaveBeenCalled();
  });

  it("the capture route asks for it with the input box (rig capture and MCP ask; send --verify and walk don't)", async () => {
    const capture = vi.fn(async (sessionName: string, _opts?: unknown) => ({ ok: true, sessionName, content: "x\n", lines: 20 }));
    const transport = { capture, resolveSessions: async () => ({ ok: true, sessions: [{ sessionName: "a@r" }] }) };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport as never); await next(); });
    app.route("/api/transport", transportRoutes());
    for (const body of [{ session: "a@r" }, { session: "a@r", inputBox: true }, { rig: "r", inputBox: true }]) {
      expect((await app.request("/api/transport/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(200);
    }
    expect(capture.mock.calls.map(([, opts]) => (opts as { promptPane?: boolean }).promptPane === true)).toEqual([false, true, true]);
  });
});

// `rig capture --readable`: read a small seat at a readable size, then give its window back exactly: its size, and its
// own window-size (resize-window sets that to manual, which would stop Herdr or attach sizing the window).
describe("rig capture --readable reads a small seat, then gives its window back", () => {
  const dbs: Array<ReturnType<typeof createDb>> = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  function transportOver(tmuxAdapter: unknown, sleep: (ms: number) => Promise<void> = async () => {}, now: () => Date = () => new Date()) {
    return import("../src/domain/session-transport.js").then(({ SessionTransport }) => {
      const db = createDb(); dbs.push(db);
      const transport = Object.create(SessionTransport.prototype) as InstanceType<typeof SessionTransport>;
      Object.assign(transport, {
        db, tmuxAdapter,
        getSessionMeta: () => ({ runtime: "claude-code", attachmentType: "tmux", nodeId: "n1", pane: "%1", occupant: null, resumeToken: null }),
        absenceProbeTarget: () => null,
        now,
        sleep,
        recordSessionMissingVerdict: () => {},
        reconcileStartupReadiness: async () => {},
      });
      return transport;
    });
  }

  /** One fake window `@2`, the seat's current window: its own window-size and the pin record. Holder tokens read as H. */
  function fakeTmux(opts: { panes?: Array<{ width: number; height: number }>; own?: string | null | undefined; recorded?: string;
    read?: () => Promise<string | null>; screen?: () => string; recordWrite?: "fails" | "throws"; beforePanes?: () => Promise<void>;
    onRecord?: () => void; sizeBackFails?: boolean } = {}) {
    const calls: string[] = [];
    const window = { own: "own" in opts ? opts.own : null as string | null | undefined, recorded: opts.recorded ?? "" };
    const norm = (value: string) => value.replace(/\b\d+\.\d+\b/g, "H");
    const tmux = {
      probeSession: vi.fn(async () => ({ state: "present" })),
      readWindow: vi.fn(async (target: string) => (target === "review@rig" || target === "@2" ? { id: "@2", userOption: window.recorded } : null)),
      listPanes: vi.fn(async (_t: string) => {
        await opts.beforePanes?.();
        return (opts.panes ?? [{ width: 18, height: 12 }]).map((size, i) => ({ id: `%${i + 1}`, index: i, cwd: "/", ...size, active: i === 0 }));
      }),
      getWindowLocalOption: vi.fn(async () => window.own),
      setWindowOption: vi.fn(async (target: string, option: string, value: string) => {
        if (option !== "window-size" && opts.recordWrite === "throws") throw new Error("tmux went away");
        if (option !== "window-size" && opts.recordWrite === "fails") return { ok: false, code: "unavailable", message: "busy" };
        calls.push(norm(`set ${target} ${option}=${value}`));
        if (option !== "window-size") opts.onRecord?.();
        if (option === "window-size") window.own = value; else window.recorded = value;
        return { ok: true };
      }),
      resizeWindow: vi.fn(async (target: string, w: number, h: number) => {
        if (opts.sizeBackFails && w < 120) return { ok: false, code: "unavailable", message: "busy" };
        calls.push(`resize ${target} ${w}x${h}`); window.own = "manual"; return { ok: true };
      }),
      restoreWindowOption: vi.fn(async (target: string, option: string, value: string | null) => {
        calls.push(`restore ${target} ${option}=${value}`);
        if (option === "window-size") window.own = value; else window.recorded = value ?? "";
        return { ok: true };
      }),
      capturePaneScreen: vi.fn(async () => opts.screen?.() ?? "screen"),
      capturePaneContent: vi.fn(async () => { calls.push("capture"); return opts.read ? opts.read() : "the whole prompt\n"; }),
    };
    return { tmux, calls, window };
  }

  const norm = (value: string) => value.replace(/\b\d+\.\d+\b/g, "H");
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  /** A clock that only moves when the transport sleeps, so a budget's spending is exact. */
  function fakeClock() {
    let t = 0;
    return { now: () => new Date(t), sleep: async (ms: number) => { t += ms; } };
  }

  it.each([
    ["inherited sizing is unset again", null],
    ["the window's own sizing is set again", "largest"],
  ])("reads at 120x40, then puts back its size and its sizing: %s", async (_, own) => {
    const { tmux, calls, window } = fakeTmux({ own });
    const result = await (await transportOver(tmux)).capture("review@rig", { readable: { width: 120, height: 40 } });
    expect(result).toMatchObject({ ok: true, content: "the whole prompt\n", readable: { resized: true, width: 120, height: 40, release: "given-back" } });
    expect(calls).toEqual([
      `set @2 @openrig-window-size-prior=${own ?? "inherit"} H`,
      "resize @2 120x40", "capture", "resize @2 18x12",
      `restore @2 window-size=${own}`, "restore @2 @openrig-window-size-prior=null",
    ]);
    expect(window).toEqual({ own, recorded: "" });
  });

  it("a web terminal that opens during the read keeps its pin: the read leaves the size to it and drops only itself", async () => {
    const browser = `${process.ppid}.1`; // a live holder in another process, as another daemon's broker
    const { tmux, calls, window } = fakeTmux({
      read: async () => {
        Object.assign(window, { own: "manual", recorded: `${window.recorded} ${browser}` });
        return "the whole prompt\n";
      },
    });
    await (await transportOver(tmux)).capture("review@rig", { readable: { width: 120, height: 40 } });
    expect(calls.slice(-1)).toEqual([`set @2 @openrig-window-size-prior=inherit ${browser.replace(/\d+\.\d+/, "H")}`]);
    expect(tmux.resizeWindow).toHaveBeenCalledTimes(1); // not put back to 18x12 under the browser
    expect(window).toEqual({ own: "manual", recorded: `inherit ${browser}` });
  });

  it("a web terminal that opens while a read takes the pin waits its turn, so neither holder is lost (one daemon)", async () => {
    let reachPanes!: () => void;
    const atPanes = new Promise<void>((resolve) => { reachPanes = resolve; });
    let releasePanes!: () => void;
    const panesHeld = new Promise<void>((resolve) => { releasePanes = resolve; });
    let firstPanes = true;
    const { tmux, window } = fakeTmux({ beforePanes: async () => { if (firstPanes) { firstPanes = false; reachPanes(); await panesHeld; } } });
    const reading = (await transportOver(tmux)).capture("review@rig", { readable: { width: 120, height: 40 } });
    await atPanes; // the read has the window's sizing, and hasn't recorded its pin yet
    const ok = async () => ({ ok: true as const });
    const broker = new TerminalSessionBroker("review@rig", { ...tmux, hasSession: async () => true, startPipePane: ok, stopPipePane: ok,
      sendKeys: ok, sendText: ok, getPaneCursorPosition: async () => null } as never, { pollMs: 10, livenessMs: 60_000 });
    const browser = { send: () => {}, close: () => {} };
    const attaching = broker.attach(browser);
    await new Promise((r) => setTimeout(r, 20));
    releasePanes();
    const [result] = await Promise.all([reading, attaching]);
    expect(result.readable).toMatchObject({ resized: true, release: "kept-by-another-holder" });
    expect(window.own).toBe("manual"); // the browser still watches: not given back under it
    expect(norm(window.recorded)).toBe("inherit H");
    expect(tmux.resizeWindow.mock.calls.map(([, w, h]) => `${w}x${h}`)).toEqual(["120x40", "90x27"]); // never back to 18x12 under it
    broker.detach(browser);
    await vi.waitFor(() => expect(window).toEqual({ own: null, recorded: "" }));
  });

  it("a fan-out's readable reads share one budget: once it's spent, seats are read as they are, and each window is given back", async () => {
    const clock = fakeClock();
    let look = 0;
    const { tmux, window } = fakeTmux({ screen: () => `frame ${look++}` }); // a busy seat: every look differs
    const transport = await transportOver(tmux, clock.sleep, clock.now);
    const readableBudget = { remainingMs: 1_000 };
    const first = await transport.capture("review@rig", { readable: { width: 120, height: 40 }, readableBudget });
    expect(first.readable).toMatchObject({ resized: true, release: "given-back" });
    expect(clock.now().getTime()).toBeLessThanOrEqual(1_000); // the redraw wait stopped at the budget
    const second = await transport.capture("review@rig", { readable: { width: 120, height: 40 }, readableBudget });
    expect(second.readable).toEqual({ resized: false, reason: "this capture's 8 s for readable reads ran out" });
    expect(tmux.resizeWindow).toHaveBeenCalledTimes(2); // the first seat's resize and give-back only
    expect(window).toEqual({ own: null, recorded: "" });
  });

  it("once the shared budget is spent, a seat takes no readable setup: no sizing reads, queue wait or resize", async () => {
    const { tmux } = fakeTmux();
    const result = await (await transportOver(tmux)).capture("review@rig", { readable: { width: 120, height: 40 }, readableBudget: { remainingMs: 0 } });
    expect(result.readable).toEqual({ resized: false, reason: "this capture's 8 s for readable reads ran out" });
    for (const call of [tmux.readWindow, tmux.getWindowLocalOption, tmux.listPanes, tmux.setWindowOption, tmux.resizeWindow]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("a record that lands after the deadline: no resize, and the pin is let go", async () => {
    const clock = fakeClock();
    const { tmux, window } = fakeTmux({ onRecord: () => { void clock.sleep(900); } }); // the record write takes 0.9 s
    const result = await (await transportOver(tmux, clock.sleep, clock.now))
      .capture("review@rig", { readable: { width: 120, height: 40 }, readableBudget: { remainingMs: 1_000 } });
    expect(result.readable).toEqual({ resized: false, reason: "this capture's 8 s for readable reads ran out" });
    expect(tmux.resizeWindow).not.toHaveBeenCalled();
    expect(window).toEqual({ own: null, recorded: "" });
  });

  it("a size that couldn't be put back is said, while the window's own sizing is still given back", async () => {
    const { tmux, window } = fakeTmux({ sizeBackFails: true });
    const result = await (await transportOver(tmux)).capture("review@rig", { readable: { width: 120, height: 40 } });
    expect(result.readable).toEqual({ resized: true, width: 120, height: 40, release: "given-back", sizeBack: "putting its size back failed: busy" });
    expect(window).toEqual({ own: null, recorded: "" });
  });

  it.each([
    ["a small pane: resized, read, then given back", [{ width: 18, height: 12 }]],
    ["a pane the leftover left big: read as it is, then given back", [{ width: 130, height: 45 }]],
  ])("a pin whose holders are gone (a crash) is taken over and given back: %s", async (_, panes) => {
    const { tmux, window } = fakeTmux({ own: "manual", recorded: `largest ${deadPid}.1`, panes });
    const result = await (await transportOver(tmux)).capture("review@rig", { readable: { width: 120, height: 40 } });
    expect(window).toEqual({ own: "largest", recorded: "" });
    expect(result.readable).toEqual(panes[0]!.width < 120
      ? { resized: true, width: 120, height: 40, release: "given-back" }
      : { resized: false, reason: "the pane is already 130x45; a pin left on its window was given back" });
  });

  it.each(["fails", "throws"] as const)("a restore record that can't be written (it %s) means no resize", async (recordWrite) => {
    const { tmux, window } = fakeTmux({ recordWrite });
    const result = await (await transportOver(tmux)).capture("review@rig", { readable: { width: 120, height: 40 } });
    expect(result.readable).toEqual({ resized: false, reason: "its restore record couldn't be written, so it wasn't resized" });
    expect(tmux.resizeWindow).not.toHaveBeenCalled();
    expect(window).toEqual({ own: null, recorded: "" });
  });

  it("a failed read still gives the window back", async () => {
    const { tmux, window } = fakeTmux({ read: async () => { throw new Error("tmux went away"); } });
    await expect((await transportOver(tmux)).capture("review@rig", { readable: { width: 120, height: 40 } })).rejects.toThrow("tmux went away");
    expect(tmux.resizeWindow.mock.calls.map(([, w, h]) => `${w}x${h}`)).toEqual(["120x40", "18x12"]);
    expect(window).toEqual({ own: null, recorded: "" });
  });

  it.each([
    ["already big enough", { panes: [{ width: 130, height: 45 }] }, "the pane is already 130x45"],
    ["pinned, as while the web terminal shows it", { own: "manual" }, "the window's size is pinned (its window-size is manual)"],
    ["pinned by a live holder in another daemon", { own: "manual", recorded: `inherit ${process.ppid}.1` }, "the window's size is pinned (its window-size is manual)"],
    ["sizing unreadable", { own: undefined }, "the window's sizing couldn't be read, so it couldn't be given back"],
    ["several panes", { panes: [{ width: 9, height: 12 }, { width: 9, height: 12 }] }, "the window has several panes"],
  ])("leaves the window as it is when it's %s, and says why", async (_, opts, reason) => {
    const { tmux, calls } = fakeTmux(opts as Parameters<typeof fakeTmux>[0]);
    const result = await (await transportOver(tmux)).capture("review@rig", { readable: { width: 120, height: 40 } });
    expect(result).toMatchObject({ ok: true, readable: { resized: false, reason } });
    expect(calls).toEqual(["capture"]);
    expect(tmux.restoreWindowOption).not.toHaveBeenCalled();
  });

  it("a capture that doesn't ask resizes nothing", async () => {
    const { tmux, calls } = fakeTmux();
    const result = await (await transportOver(tmux)).capture("review@rig", { lines: 20 });
    expect(result).not.toHaveProperty("readable");
    expect(calls).toEqual(["capture"]);
  });

  it("the route refuses a size that isn't two whole numbers from 1 to 1000", async () => {
    const capture = vi.fn(async (sessionName: string) => ({ ok: true, sessionName, content: "x\n", lines: 20 }));
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, { capture } as never); await next(); });
    app.route("/api/transport", transportRoutes());
    const post = (readable: unknown) => app.request("/api/transport/capture", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "a@r", readable }) });
    for (const bad of [{ width: 0, height: 40 }, { width: 120 }, { width: 120.5, height: 40 }, { width: 2000, height: 40 }, "120x40"]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect((await post({ width: 120, height: 40 })).status).toBe(200);
    expect(capture.mock.calls.map(([, opts]) => (opts as { readable?: unknown }).readable)).toEqual([{ width: 120, height: 40 }]);
  });

  it("the route gives a fan-out's seats one readable budget", async () => {
    const capture = vi.fn(async (sessionName: string) => ({ ok: true, sessionName, content: "x\n", lines: 20 }));
    const resolveSessions = vi.fn(async () => ({ ok: true, sessions: [{ sessionName: "a@r" }, { sessionName: "b@r" }, { sessionName: "c@r" }] }));
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, { capture, resolveSessions } as never); await next(); });
    app.route("/api/transport", transportRoutes());
    const res = await app.request("/api/transport/capture", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "r", readable: { width: 120, height: 40 } }) });
    expect(res.status).toBe(200);
    const budgets = capture.mock.calls.map(([, opts]) => (opts as { readableBudget?: { remainingMs: number } }).readableBudget);
    expect(budgets[0]).toEqual({ remainingMs: 8_000 });
    expect(budgets.every((budget) => budget === budgets[0])).toBe(true);
  });

  // Real private tmux server. The seat's pane prints its own size, so the capture shows what the seat drew.
  it.skipIf(process.platform === "win32")("on real tmux: reads the seat at 120x40, puts back 18x12 and its sizing, and never touches a same-named window elsewhere", async () => {
    const root = mkdtempSync(join(tmpdir(), "readable-")), socket = join(root, "s");
    const env = { ...process.env }; delete env.TMUX;
    const tmux = async (args: string[]) => (await exec("tmux", ["-S", socket, ...args], { env })).stdout.trim();
    const shellExec = async (cmd: string) => (await exec("/bin/sh", ["-c", cmd.startsWith("tmux ") ? `tmux -S ${socket} ${cmd.slice(5)}` : cmd], { env })).stdout;
    const adapter = new TmuxAdapter(shellExec);
    const sizes = async () => (await tmux(["list-windows", "-a", "-F", "#{session_name} #{window_width}x#{window_height}"])).split("\n").sort();
    const own = (target: string) => tmux(["show-options", "-w", "-v", "-t", target, "window-size"]);
    try {
      await tmux(["-f", "/dev/null", "new-session", "-d", "-s", "review@rig", "-x", "18", "-y", "12", "sh -c 'while :; do clear; stty size; sleep 0.1; done'"]);
      await tmux(["new-session", "-d", "-s", "other", "-n", "review@rig", "-x", "90", "-y", "30", "sleep 60"]);
      const transport = await transportOver(adapter, (ms) => new Promise((r) => setTimeout(r, ms)));

      const read = await transport.capture("review@rig", { readable: { width: 120, height: 40 } });
      expect(read).toMatchObject({ ok: true, readable: { resized: true, width: 120, height: 40 } });
      expect(read.content).toContain("40 120");
      expect(await sizes()).toEqual(["other 90x30", "review@rig 18x12"]);
      expect(await own("=review@rig:")).toBe("");
      expect(await own("=other:")).toBe("");

      await tmux(["set-option", "-w", "-t", "=review@rig:", "window-size", "largest"]);
      expect((await transport.capture("review@rig", { readable: { width: 120, height: 40 } })).readable).toMatchObject({ resized: true });
      expect(await own("=review@rig:")).toBe("largest");

      await tmux(["set-option", "-w", "-t", "=review@rig:", "window-size", "manual"]);
      expect((await transport.capture("review@rig", { readable: { width: 120, height: 40 } })).readable).toMatchObject({ resized: false });
      expect(await sizes()).toEqual(["other 90x30", "review@rig 18x12"]);
      expect(await own("=review@rig:")).toBe("manual");

      // A browser opens the seat in the web terminal while the read is resized: it keeps the window's own value, and
      // the read leaves the window pinned to it; when the browser leaves, the window gets its own value back.
      await tmux(["set-option", "-w", "-u", "-t", "=review@rig:", "window-size"]);
      let broker: TerminalSessionBroker | null = null;
      let empty = false;
      const browser = { send: () => {}, close: () => {} };
      class BrowserOpensDuringRead extends TmuxAdapter {
        override async capturePaneContent(target: string, lines: number) {
          if (!broker) {
            broker = new TerminalSessionBroker("review@rig", adapter, { pollMs: 20, livenessMs: 60000, onEmpty: () => { empty = true; } });
            await broker.attach(browser);
          }
          return super.capturePaneContent(target, lines);
        }
      }
      const during = await transportOver(new BrowserOpensDuringRead(shellExec), (ms) => new Promise((r) => setTimeout(r, ms)));
      expect((await during.capture("review@rig", { readable: { width: 120, height: 40 } })).readable)
        .toMatchObject({ resized: true, release: "kept-by-another-holder" });
      expect(await sizes()).toEqual(["other 90x30", "review@rig 90x27"]); // the browser's fixed geometry, not put back under it
      expect(await own("=review@rig:")).toBe("manual");
      broker!.detach(browser);
      for (let i = 0; i < 100 && !empty; i++) await new Promise((r) => setTimeout(r, 20));
      expect(await own("=review@rig:")).toBe("");
      expect(await tmux(["show-options", "-q", "-w", "-v", "-t", "=review@rig:", "@openrig-window-size-prior"])).toBe("");

      // A capture that ended before giving the window back (its daemon crashed) left it manual at 120x40 with a record
      // whose holder is gone: the next readable capture takes the pin over and gives back the window's own value.
      await tmux(["resize-window", "-t", "=review@rig:", "-x", "120", "-y", "40"]);
      await tmux(["set-option", "-w", "-t", "=review@rig:", "@openrig-window-size-prior", `largest ${deadPid}.1`]);
      expect(await own("=review@rig:")).toBe("manual");
      expect((await transport.capture("review@rig", { readable: { width: 120, height: 40 } })).readable)
        .toEqual({ resized: false, reason: "the pane is already 120x40; a pin left on its window was given back" });
      expect(await own("=review@rig:")).toBe("largest");
      expect(await tmux(["show-options", "-q", "-w", "-v", "-t", "=review@rig:", "@openrig-window-size-prior"])).toBe("");
    } finally {
      await tmux(["kill-server"]).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});
