import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { viewerArgv } from "../src/domain/terminal/herdr-app-provider.js";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";

// The generated viewer itself, with real tmux: a seat on its own tmux server, and the viewer running in a session of a
// second server (standing in for the herdr-app cell's terminal). Input goes in as bracketed pastes and as typed keys.
// Which clients attach comes from the real seat server, so it follows what the viewer launches.
const run = promisify(execFile);
const tmuxBin = (() => { try { return execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim(); } catch { return ""; } })();

describe.skipIf(!tmuxBin)("the generated herdr-app viewer (real tmux): nothing reaches the seat before its gate opens", () => {
  let dir: string;
  let seat: string;
  let view: string;
  const tmux = (sock: string, ...args: string[]) => run(tmuxBin, ["-S", sock, ...args], { timeout: 10_000 });
  const pane = (readOnly: boolean) => ({ attachArgv: tileAttachArgv(tmuxBin, ["-S", seat], "seat1", readOnly), paneCommand: "", readOnly });
  const shown = async () => (await tmux(seat, "capture-pane", "-p", "-t", "seat1")).stdout;
  const clients = async () => (await tmux(seat, "list-clients", "-F", "#{client_tty}")).stdout.split("\n").filter(Boolean);
  const paste = async (text: string) => { await tmux(view, "set-buffer", "-b", "p", text); await tmux(view, "paste-buffer", "-p", "-b", "p", "-t", "v1"); };
  const until = async (check: () => Promise<boolean>, ms = 8_000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  const gateAt = (path: string, seconds = 3_600) => ({ path, until: Math.floor(Date.now() / 1000) + seconds, expired: "WINDOW-PASSED: reopen it with rig terminal open rig:demo" });
  // The read-only tile is ready once its own script loops in its view (a sleep child, after stty -echo).
  // The writable tile is ready once a native tmux client under this viewer is attached to the seat server.
  const tileReady = async (kind: "read-only" | "writable") => {
    const pid = (await tmux(view, "display-message", "-p", "-t", "v1", "#{pane_pid}")).stdout.trim();
    const procs = (await run("ps", ["-e", "-ww", "-o", "pid=,ppid=,args="])).stdout.split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m)
      .map(([, p, pp, args]) => ({ pid: p!, ppid: pp!, args: args! }));
    const under = new Set([pid]);
    for (let grew = true; grew;) { grew = false; for (const p of procs) if (under.has(p.ppid) && !under.has(p.pid)) { under.add(p.pid); grew = true; } }
    if (kind === "writable") {
      const attached = (await tmux(seat, "list-clients", "-F", "#{client_pid}")).stdout.trim().split("\n");
      return attached.some((clientPid) => under.has(clientPid));
    }
    const tile = procs.find((p) => under.has(p.pid) && p.args.startsWith("/bin/sh -c umask 077") && p.args.includes("stty -echo -isig -ixon"));
    return !!tile && procs.some((p) => p.ppid === tile.pid && /^sleep /.test(p.args));
  };
  const start = async (argv: string[]) => {
    await tmux(view, "-f", "/dev/null", "new-session", "-d", "-s", "v1", "-x", "80", "-y", "20", ...argv);
    expect(await until(() => tileReady("read-only"))).toBe(true);
  };

  beforeEach(async () => {
    // Under the system's temporary folder (a sandbox may allow sockets only there), with short names: tmux socket paths
    // are limited to about 100 bytes.
    dir = mkdtempSync(join(tmpdir(), "orvg-"));
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

  it("an interactive viewer takes no input before its gate, drops what came before, and takes input after", async () => {
    const gate = join(dir, "n1.shown");
    await start(viewerArgv(pane(false), "n1", gateAt(gate)));
    // Nor may the cell echo it: the read-only tile turns echo off on the viewer's own terminal. The tile redraws the
    // cell (once more a second after its first draw, and after seat activity), which would wipe an echo, so the cell is
    // watched from before the first byte to the end of the window rather than read once.
    const cell = async () => (await tmux(view, "capture-pane", "-p", "-t", "v1")).stdout;
    const echoed = until(async () => /BEFOREKEYS|BEFORE-PASTE/.test(await cell()), 3_000);
    await paste("BEFORE-PASTE");
    await tmux(view, "send-keys", "-t", "v1", "-l", "BEFOREKEYS");
    await tmux(view, "send-keys", "-t", "v1", "Enter"); // a complete line, readable by whatever reads next
    // A bracketed paste as raw bytes (the read-only tile never asks for paste framing, so tmux wouldn't frame it): if
    // anything kept it, the writable tile would deliver it through its paste path, which works on every tmux.
    const hex = (text: string) => [...Buffer.from(text)].map((b) => b.toString(16).padStart(2, "0"));
    await tmux(view, "send-keys", "-t", "v1", "-H", ...hex("\x1b[200~BEFORE-RAW\x1b[201~"));
    expect(await echoed).toBe(false); // also the window anything wrongly delivered had to show up in
    expect(await shown()).not.toMatch(/BEFORE/);
    expect(await clients()).toEqual([]); // the read-only tile only shows the seat
    writeFileSync(gate, "");
    expect(await until(() => tileReady("writable"))).toBe(true);
    await paste("AFTER-PASTE");
    expect(await until(async () => (await shown()).includes("AFTER-PASTE"))).toBe(true);
    expect(await shown()).not.toMatch(/BEFORE/); // dropped, never delivered late
    // The viewer's own native writable client stays attached.
    expect(await until(async () => (await clients()).length === 1)).toBe(true);
  }, 30_000);

  it("a read-only viewer has no gate and takes no input", async () => {
    await start(viewerArgv(pane(true), "n2"));
    writeFileSync(join(dir, "n2.shown"), ""); // a gate-shaped file changes nothing for it
    await paste("RO-PASTE");
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await shown()).not.toMatch(/RO-PASTE/);
    expect(await clients()).toEqual([]);
  }, 30_000);

  it("one viewer's gate never opens another's", async () => {
    await start(viewerArgv(pane(false), "n3", gateAt(join(dir, "n3.shown"))));
    writeFileSync(join(dir, "n4.shown"), "");
    await new Promise((r) => setTimeout(r, 1_500));
    await paste("OTHER-GATE");
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await shown()).not.toMatch(/OTHER-GATE/);
    expect(await clients()).toEqual([]);
  }, 30_000);

  it("when its window ends with the gate closed, the cell says so and still takes no input", async () => {
    await start(viewerArgv(pane(false), "n5", gateAt(join(dir, "n5.shown"), 5)));
    const cell = async () => (await tmux(view, "capture-pane", "-p", "-t", "v1")).stdout;
    expect(await until(async () => (await cell()).includes("WINDOW-PASSED"), 15_000)).toBe(true);
    writeFileSync(join(dir, "n5.shown"), ""); // a gate that comes too late opens nothing
    await paste("LATE-PASTE");
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await shown()).not.toMatch(/LATE-PASTE/);
    expect(await clients()).toEqual([]);
    expect(await cell()).toContain("reopen it with rig terminal open rig:demo");
  }, 30_000);

  // The path people use: keys typed in the cell.
  it("typed keys reach the seat after the gate, and keys typed before it never do", async () => {
    const gate = join(dir, "n6.shown");
    await start(viewerArgv(pane(false), "n6", gateAt(gate)));
    await tmux(view, "send-keys", "-t", "v1", "-l", "TYPED-BEFORE");
    await tmux(view, "send-keys", "-t", "v1", "Enter");
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await shown()).not.toMatch(/TYPED-BEFORE/);
    expect(await clients()).toEqual([]);
    writeFileSync(gate, "");
    expect(await until(() => tileReady("writable"))).toBe(true);
    await tmux(view, "send-keys", "-t", "v1", "-l", "TYPED-AFTER");
    await tmux(view, "send-keys", "-t", "v1", "Enter");
    expect(await until(async () => (await shown()).includes("TYPED-AFTER"))).toBe(true);
    expect(await shown()).not.toMatch(/TYPED-BEFORE/);
    expect(await until(async () => (await clients()).length === 1)).toBe(true);
  }, 30_000);
});
