import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { coreViewerArgv, viewerArgv } from "../src/domain/terminal/herdr-app-provider.js";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";

// The generated viewer with real tmux, as in herdr-app-viewer-gate.test.ts: the seat on its own tmux server, and the
// viewer in a session of a second server standing in for the herdr-app cell's terminal. herdr-core runs a terminal that
// no pane shows at its headless size (200x120 unless configured), so a 200x120 viewer session is a cell nobody sees.
const run = promisify(execFile);
const tmuxBin = (() => { try { return execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
// refresh-client -f (client flags at runtime) needs tmux 3.2 or later.
const tmuxVersion = (() => { try { return execFileSync(tmuxBin, ["-V"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
// 3.0 and 3.1 with or without a patch letter (3.1c) lack it; 3.10 and later have it.
const flagsAtRuntime = !/^tmux ([12]\.|3\.[01](?:\D|$))/.test(tmuxVersion);

// The watcher's own version gate, taken from the generated viewer and run by sh: which tmux versions it leaves alone.
describe("the viewer's tmux version gate", () => {
  const script = () => {
    const argv = viewerArgv({ attachArgv: tileAttachArgv("tmux", ["-S", "/nonexistent/s"], "seat1", false), paneCommand: "", readOnly: false }, "g1", { path: "/nonexistent/g1.shown", until: 0, expired: "x" });
    const text = argv.find((a) => a.includes('-V 2>/dev/null)" in')) ?? "";
    const gate = /case "\$\("\$x" -V 2>\/dev\/null\)" in (.*?)\) exit 0;; esac;/.exec(text)?.[1];
    expect(gate, "the gate is in the generated viewer").toBeTruthy();
    return gate as string;
  };
  const leftAlone = (version: string) => execFileSync("sh", ["-c", `case "$1" in ${script()}) echo old;; *) echo new;; esac`, "gate", version], { encoding: "utf8" }).trim() === "old";
  it("leaves tmux 1.x, 2.x, 3.0 and 3.1 alone, with or without a patch letter", () => {
    for (const v of ["tmux 1.8", "tmux 2.9a", "tmux 3.0", "tmux 3.0a", "tmux 3.1", "tmux 3.1b", "tmux 3.1c"]) expect(leftAlone(v), v).toBe(true);
  });
  it("sets flags from tmux 3.2 on, including 3.10 and later", () => {
    for (const v of ["tmux 3.2", "tmux 3.2a", "tmux 3.3a", "tmux 3.5a", "tmux 3.10", "tmux 3.11a", "tmux next-3.6"]) expect(leftAlone(v), v).toBe(false);
  });
});

describe.skipIf(!tmuxBin || !flagsAtRuntime)("the generated herdr-app viewer (real tmux): a cell no screen shows never sizes the seat", () => {
  let dir: string;
  let seat: string;
  let view: string;
  const tmux = (sock: string, ...args: string[]) => run(tmuxBin, ["-S", sock, ...args], { timeout: 10_000 });
  const pane = () => ({ attachArgv: tileAttachArgv(tmuxBin, ["-S", seat], "seat1", false), paneCommand: "", readOnly: false });
  const windowSize = async () => (await tmux(seat, "list-windows", "-t", "=seat1", "-F", "#{window_width}x#{window_height}")).stdout.trim();
  const clients = async () => (await tmux(seat, "list-clients", "-F", "#{client_tty} #{client_width}x#{client_height} #{client_flags}")).stdout.split("\n").filter(Boolean);
  const until = async (check: () => Promise<boolean>, ms = 8_000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  const settle = (ms = 2_000) => new Promise((r) => setTimeout(r, ms));
  const gateAt = (path: string) => ({ path, until: Math.floor(Date.now() / 1000) + 3_600, expired: "WINDOW-PASSED" });
  // A person's own client of the seat, in a 57x16 terminal.
  const person = async () => {
    await tmux(view, "-f", "/dev/null", "new-session", "-d", "-s", "p1", "-x", "57", "-y", "16", "env", "-u", "TMUX", tmuxBin, "-S", seat, "attach", "-t", "=seat1");
    expect(await until(async () => (await clients()).length === 1)).toBe(true);
    expect(await until(async () => (await windowSize()) !== "80x20")).toBe(true);
    return windowSize();
  };
  // The viewer in a cell of the given size, its gate opened, until its writable client is attached to the seat.
  const viewer = async (cols: number, rows: number, nonce: string) => {
    const gate = join(dir, `${nonce}.shown`);
    await tmux(view, "-f", "/dev/null", "new-session", "-d", "-s", "v1", "-x", String(cols), "-y", String(rows), ...viewerArgv(pane(), nonce, gateAt(gate)));
    await settle(1_000);
    writeFileSync(gate, "");
    expect(await until(async () => (await clients()).length === 2)).toBe(true);
  };

  beforeEach(async () => {
    // Short names under the system's temporary folder: tmux socket paths are limited to about 100 bytes.
    dir = mkdtempSync(join(tmpdir(), "orvs-"));
    seat = join(dir, "s");
    view = join(dir, "v");
    await tmux(seat, "-f", "/dev/null", "new-session", "-d", "-s", "seat1", "-x", "80", "-y", "20", "cat");
    await tmux(seat, "set-environment", "-t", "seat1", "OPENRIG_NODE_ID", "node-1");
  });
  afterEach(async () => {
    await tmux(view, "kill-server").catch(() => {});
    await tmux(seat, "kill-server").catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("a writable viewer whose cell is at the headless size leaves the person's window size alone", async () => {
    const before = await person();
    await viewer(200, 120, "h1");
    await settle();
    expect(await windowSize()).toBe(before);
  }, 30_000);

  it("after the seat session is replaced, the hidden viewer's new client still leaves the person's window size alone", async () => {
    await person();
    await viewer(200, 120, "h3");
    await settle();
    // The seat is replaced (same name and node id): the tile attaches a NEW tmux client on the same terminal, which the
    // terminal's size never changed for. The person attaches first, so the viewer's new client is the latest one: the
    // tile reattaches only once the new session carries the node id, so it is published after the person's baseline.
    await tmux(seat, "kill-session", "-t", "=seat1");
    await tmux(view, "kill-session", "-t", "p1").catch(() => {});
    await tmux(seat, "-f", "/dev/null", "new-session", "-d", "-s", "seat1", "-x", "80", "-y", "20", "cat");
    const before = await person();
    await tmux(seat, "set-environment", "-t", "seat1", "OPENRIG_NODE_ID", "node-1");
    expect(await until(async () => (await clients()).length === 2)).toBe(true); // the viewer's tile attached again
    expect(await until(async () => (await windowSize()) === before)).toBe(true);
    await settle();
    expect(await windowSize()).toBe(before);
  }, 40_000);

  it("a viewer placed in herdr-core attaches at once, with no gate, and at the headless size leaves the person's window size alone", async () => {
    const before = await person();
    await tmux(view, "-f", "/dev/null", "new-session", "-d", "-s", "v1", "-x", "200", "-y", "120", ...coreViewerArgv(pane(), "c1"));
    expect(await until(async () => (await clients()).length === 2)).toBe(true);
    await settle();
    expect(await windowSize()).toBe(before);
    // Shown in a pane elsewhere and typed in: it sizes the seat like any client a person types in.
    await tmux(view, "resize-window", "-t", "v1", "-x", "90", "-y", "24");
    await settle(1_000);
    await tmux(view, "send-keys", "-t", "v1", "-l", "x");
    expect(await until(async () => (await windowSize()).startsWith("90x"))).toBe(true);
  }, 30_000);

  it("once the cell is shown and typed in, the seat follows the viewer's own size again", async () => {
    const before = await person();
    await viewer(200, 120, "h2");
    await settle();
    // herdr-app shows the cell in a pane: its terminal takes the pane's size, and the person types in it.
    await tmux(view, "resize-window", "-t", "v1", "-x", "90", "-y", "24");
    await settle(1_000);
    await tmux(view, "send-keys", "-t", "v1", "-l", "x");
    expect(await until(async () => (await windowSize()) !== before && (await windowSize()).startsWith("90x"))).toBe(true);
  }, 30_000);
});
