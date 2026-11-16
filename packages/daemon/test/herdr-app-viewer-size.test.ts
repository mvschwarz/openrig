import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { viewerArgv } from "../src/domain/terminal/herdr-app-provider.js";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";

// The generated viewer with real tmux, as in herdr-app-viewer-gate.test.ts: the seat on its own tmux server, and the
// viewer in a session of a second server standing in for the herdr-app cell's terminal. herdr-core runs a terminal that
// no pane shows at its headless size (200x120 unless configured), so a 200x120 viewer session is a cell nobody sees.
const run = promisify(execFile);
const tmuxBin = (() => { try { return execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
// refresh-client -f (client flags at runtime) needs tmux 3.2 or later.
const tmuxVersion = (() => { try { return execFileSync(tmuxBin, ["-V"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
const flagsAtRuntime = !/^tmux ([12]\.|3\.[01]\b)/.test(tmuxVersion);

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
