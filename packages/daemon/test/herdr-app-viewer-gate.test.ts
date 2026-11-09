import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { viewerArgv } from "../src/domain/terminal/herdr-app-provider.js";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";

// The generated viewer itself, with real tmux: a seat on its own tmux server, and the viewer running in a session of a
// second server (standing in for the herdr-app cell's terminal). Input goes in as bracketed pastes, which take the
// tile's paste path on any tmux; typed first keys need tmux 3.5 (#2816). Which clients attach comes from the real seat
// server, so it follows what the viewer launches.
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
  const start = async (argv: string[]) => { await tmux(view, "-f", "/dev/null", "new-session", "-d", "-s", "v1", "-x", "80", "-y", "20", ...argv); await new Promise((r) => setTimeout(r, 1_500)); };

  beforeEach(async () => {
    // tmux socket paths are limited to about 100 bytes, so not under a long temporary folder.
    dir = mkdtempSync("/tmp/orvg-");
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
    await start(viewerArgv(pane(false), "n1", gate));
    await paste("BEFORE-PASTE");
    await tmux(view, "send-keys", "-t", "v1", "-l", "BEFOREKEYS");
    await tmux(view, "send-keys", "-t", "v1", "Enter"); // a complete line, readable by whatever reads next
    // A bracketed paste as raw bytes (the read-only tile never asks for paste framing, so tmux wouldn't frame it): if
    // anything kept it, the writable tile would deliver it through its paste path, which works on every tmux.
    const hex = (text: string) => [...Buffer.from(text)].map((b) => b.toString(16).padStart(2, "0"));
    await tmux(view, "send-keys", "-t", "v1", "-H", ...hex("\x1b[200~BEFORE-RAW\x1b[201~"));
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await shown()).not.toMatch(/BEFORE/);
    expect(await clients()).toEqual([]); // the read-only tile only shows the seat
    writeFileSync(gate, "");
    await new Promise((r) => setTimeout(r, 1_500));
    await paste("AFTER-PASTE");
    expect(await until(async () => (await shown()).includes("AFTER-PASTE"))).toBe(true);
    expect(await shown()).not.toMatch(/BEFORE/); // dropped, never delivered late
    expect(await clients()).toHaveLength(1); // the viewer's own writable tile attached
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
    await start(viewerArgv(pane(false), "n3", join(dir, "n3.shown")));
    writeFileSync(join(dir, "n4.shown"), "");
    await new Promise((r) => setTimeout(r, 1_500));
    await paste("OTHER-GATE");
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await shown()).not.toMatch(/OTHER-GATE/);
    expect(await clients()).toEqual([]);
  }, 30_000);
});
