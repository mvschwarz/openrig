// The web terminal pins a window's size while a browser is subscribed (FR-7). When the last browser leaves, a native
// client of the same window (Herdr, `tmux attach`) gets its own size back. Real tmux on a private server, driven by
// the real TmuxAdapter through the broker; a control-mode client stands in for the native client.
import { afterAll, describe, expect, it } from "vitest";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TerminalSessionBroker, type TerminalSubscriber } from "../src/terminal/TerminalSessionBroker.js";

const pexec = promisify(execFile);
const SOCK = `openrig-websize-${process.pid}`;
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.TMUX;
const exec = async (cmd: string): Promise<string> =>
  (await pexec("sh", ["-c", cmd.startsWith("tmux ") ? `tmux -L ${SOCK} ${cmd.slice(5)}` : cmd], { env })).stdout;
const tmux = async (...args: string[]): Promise<string> => (await pexec("tmux", ["-L", SOCK, ...args], { env })).stdout.trim();
const available = (() => { try { execFileSync("sh", ["-c", "command -v tmux"], { stdio: "ignore" }); return true; } catch { return false; } })();
const size = (session: string) => tmux("display-message", "-p", "-t", session, "#{window_width}x#{window_height}");
const ownSizing = (target: string) => tmux("show-options", "-w", "-v", "-t", target, "window-size");
const record = (target: string) => tmux("show-options", "-q", "-w", "-v", "-t", target, "@openrig-window-size-prior");
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("timed out");
};
const viewer = (): TerminalSubscriber => ({ send: () => {}, close: () => {} });

describe.skipIf(!available)("web terminal window sizing with a native client (real tmux)", () => {
  const clients: ChildProcess[] = [];
  afterAll(async () => {
    for (const client of clients) client.kill();
    await tmux("kill-server").catch(() => {});
  });

  /** A session with a native client sized 150x45, optionally with its own `window-size`. */
  async function nativeSession(name: string, own?: string): Promise<void> {
    await tmux("new-session", "-d", "-s", name, "-x", "120", "-y", "40");
    if (own) await tmux("set-option", "-w", "-t", name, "window-size", own);
    const client = spawn("tmux", ["-L", SOCK, "-C", "attach-session", "-t", name], { env, stdio: ["pipe", "ignore", "ignore"] });
    clients.push(client);
    client.stdin!.write("refresh-client -C 150x45\n");
    await until(async () => (await size(name)) === "150x45");
  }

  /** One browser viewer comes and goes through the broker. */
  async function browserVisit(name: string, adapter = new TmuxAdapter(exec)): Promise<void> {
    let empty = false;
    const broker = new TerminalSessionBroker(name, adapter, { pollMs: 20, livenessMs: 1000, onEmpty: () => { empty = true; } });
    const browser = viewer();
    await broker.attach(browser);
    expect(await size(name)).toBe("90x27"); // the fixed geometry while a browser watches
    broker.detach(browser);
    await until(async () => empty);
  }

  it("a window that inherited its sizing inherits again, and the native client's size comes back", async () => {
    await nativeSession("inherits");
    await browserVisit("inherits");
    expect(await ownSizing("inherits")).toBe("");
    await until(async () => (await size("inherits")) === "150x45");
  });

  it("a window with its own sizing keeps that value", async () => {
    await nativeSession("own", "largest");
    await browserVisit("own");
    expect(await ownSizing("own")).toBe("largest");
    await until(async () => (await size("own")) === "150x45");
  });

  it("a native client switching windows meanwhile: the pinned window gets its sizing back, and the other keeps its own", async () => {
    await nativeSession("switch");
    const pinned = await tmux("display-message", "-p", "-t", "=switch:", "#{window_id}");
    let empty = false;
    const broker = new TerminalSessionBroker("switch", new TmuxAdapter(exec), { pollMs: 20, livenessMs: 1000, onEmpty: () => { empty = true; } });
    const browser = viewer();
    await broker.attach(browser);
    const other = await tmux("new-window", "-d", "-P", "-F", "#{window_id}", "-t", "=switch:");
    await tmux("set-option", "-w", "-t", other, "window-size", "largest");
    await tmux("select-window", "-t", other); // the native client now shows the other window
    broker.detach(browser);
    await until(async () => empty);
    expect(await ownSizing(pinned)).toBe("");
    expect(await record(pinned)).toBe("");
    expect(await ownSizing(other)).toBe("largest");
  });

  it.each([
    ["inherits", undefined],
    ["own", "largest"],
  ])("a pin left by a daemon that stopped while a browser watched is given back by the next visit (%s)", async (kind, own) => {
    const name = `restart-${kind}`;
    await nativeSession(name, own);
    // The first daemon's process ends before its broker gives anything back.
    class EndsBeforeGiveBack extends TmuxAdapter {
      override async restoreWindowOption() { return { ok: true as const }; }
    }
    await browserVisit(name, new EndsBeforeGiveBack(exec));
    expect(await ownSizing(name)).toBe("manual");
    expect(await size(name)).toBe("90x27");
    await browserVisit(name);
    expect(await ownSizing(name)).toBe(own ?? "");
    expect(await record(name)).toBe("");
    await until(async () => (await size(name)) === "150x45");
  });

  it("a probe that couldn't reach tmux doesn't leave the window pinned", async () => {
    await nativeSession("probe");
    let reachable = true;
    class Unreachable extends TmuxAdapter {
      override async hasSession(name: string) { return reachable ? super.hasSession(name) : false; }
    }
    let empty = false;
    const closed: number[] = [];
    const broker = new TerminalSessionBroker("probe", new Unreachable(exec), { pollMs: 20, livenessMs: 50, onEmpty: () => { empty = true; } });
    await broker.attach({ send: () => {}, close: (code) => { closed.push(code); } });
    expect(await size("probe")).toBe("90x27");
    reachable = false;
    await until(async () => empty);
    expect(closed).toEqual([1001]);
    expect(await ownSizing("probe")).toBe("");
    await until(async () => (await size("probe")) === "150x45");
  });

  it.each(["first", "second"])("two brokers on one window keep it pinned until the last leaves, whichever leaves %s", async (order) => {
    const name = `two-${order}`;
    await nativeSession(name, "largest");
    const adapter = new TmuxAdapter(exec);
    const empty = [false, false];
    const brokers = [0, 1].map((i) => new TerminalSessionBroker(name, adapter, { pollMs: 20, livenessMs: 1000, onEmpty: () => { empty[i] = true; } }));
    const browsers = [viewer(), viewer()];
    await brokers[0].attach(browsers[0]);
    await brokers[1].attach(browsers[1]);
    const [leaving, staying] = order === "first" ? [0, 1] : [1, 0];
    brokers[leaving].detach(browsers[leaving]);
    await until(async () => empty[leaving]);
    expect(await ownSizing(name)).toBe("manual"); // the other browser still watches
    expect(await size(name)).toBe("90x27");
    brokers[staying].detach(browsers[staying]);
    await until(async () => empty[staying]);
    expect(await ownSizing(name)).toBe("largest");
    expect(await record(name)).toBe("");
    await until(async () => (await size(name)) === "150x45");
  });

  it("after the tmux server restarts under a live broker, its give-back leaves the new server's window alone", async () => {
    const sock = `${SOCK}-reborn`;
    const t = async (...args: string[]): Promise<string> => (await pexec("tmux", ["-L", sock, ...args], { env })).stdout.trim();
    const execOn = async (cmd: string): Promise<string> =>
      (await pexec("sh", ["-c", cmd.startsWith("tmux ") ? `tmux -L ${sock} ${cmd.slice(5)}` : cmd], { env })).stdout;
    try {
      await t("new-session", "-d", "-s", "reborn", "-x", "120", "-y", "40");
      let empty = false;
      const broker = new TerminalSessionBroker("reborn", new TmuxAdapter(execOn), { pollMs: 20, livenessMs: 60000, onEmpty: () => { empty = true; } });
      const browser = viewer();
      await broker.attach(browser);
      const pinned = await t("display-message", "-p", "-t", "=reborn:", "#{window_id}");
      await t("kill-server");
      await t("new-session", "-d", "-s", "reborn", "-x", "120", "-y", "40");
      await t("set-option", "-w", "-t", "=reborn:", "window-size", "smallest");
      expect(await t("display-message", "-p", "-t", "=reborn:", "#{window_id}")).toBe(pinned); // ids start again
      broker.detach(browser);
      await until(async () => empty);
      expect(await t("show-options", "-w", "-v", "-t", pinned, "window-size")).toBe("smallest");
    } finally {
      await t("kill-server").catch(() => {});
    }
  });
});
