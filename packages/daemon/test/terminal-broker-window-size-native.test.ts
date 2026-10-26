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
const ownSizing = (session: string) => tmux("show-options", "-w", "-v", "-t", session, "window-size");
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
  async function browserVisit(name: string): Promise<void> {
    let empty = false;
    const broker = new TerminalSessionBroker(name, new TmuxAdapter(exec), { pollMs: 20, livenessMs: 1000, onEmpty: () => { empty = true; } });
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
});
