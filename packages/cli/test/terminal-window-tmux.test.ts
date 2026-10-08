import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "../src/client.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";
import { composeView } from "../../daemon/src/domain/terminal/view-composer.js";

// Real isolated tmux servers; the desktop launcher alone is inert.
const sockets: string[] = [];
const dirs: string[] = [];
const env = { ...process.env }; delete env["TMUX"];
function tmux(socket: string, args: string[]): string {
  return execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", env, timeout: 5000 });
}
afterEach(() => {
  for (const socket of sockets.splice(0)) {
    try { tmux(socket, ["kill-server"]); } catch { /* Already exited after a failing setup. */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([
  ["shared", "80x24"], ["shared", "120x40"], ["separate", "120x40"],
])("opens nineteen composed seats on %s servers at configured size %s", async (placement, size) => {
  const id = randomUUID().slice(0, 12);
  const source = `ws-${id}`;
  const viewer = placement === "shared" ? source : `wv-${id}`;
  sockets.push(...new Set([source, viewer]));
  const dir = mkdtempSync(path.join(tmpdir(), "window-test-"));
  dirs.push(dir);
  const wrapper = path.join(dir, "tmux");
  writeFileSync(wrapper, `#!/bin/sh\nexec tmux -L ${source} -f /dev/null "$@"\n`, { mode: 0o755 });
  const names = Array.from({ length: 19 }, (_, index) => `source${index}`);
  for (const name of names) tmux(source, ["new-session", "-d", "-s", name, "sleep 120"]);
  if (viewer !== source) tmux(viewer, ["new-session", "-d", "-s", "viewer-fixture", "sleep 120"]);
  tmux(viewer, ["set-option", "-g", "default-size", size]);
  tmux(viewer, ["set-option", "-gw", "window-size", "latest"]);
  const snapshot = () => names.map(name => tmux(source, ["list-panes", "-t", `=${name}`, "-F", "#{pane_id}|#{pane_pid}"]));
  const original = snapshot();
  const composed = composeView("saved:fixture", names.map(seat => ({
    seat, label: seat, tmuxSession: seat, host: null, readOnly: true, alive: true,
  })), { resolveHost: () => null, panesPerPage: 16, localTmux: wrapper });
  expect(composed.pages.map(page => page.length)).toEqual([16, 3]);
  const client = { baseUrl: "http://localhost:7433", get: async () => ({ status: 200, data: { planId: "fixture", status: {}, composed } }) } as unknown as DaemonClient;
  const desktop = vi.fn(async () => "window");
  const beforeSplits: string[] = [];
  const deps: WindowDeps = {
    platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HOME: dir }, exists: () => false,
    exec: async (file, args) => {
      if (file === "/bin/sh") return "tmux";
      if (file === "/usr/bin/osascript") return desktop();
      if (file === "tmux") {
        if (args[0] === "split-window") {
          beforeSplits.push(tmux(viewer, ["display-message", "-p", "-t", args[args.indexOf("-t") + 1]!, "#{window_width}x#{window_height}"]).trim());
        }
        return tmux(viewer, args);
      }
      throw new Error(`unexpected executable ${file}`);
    },
    launch: vi.fn(async () => {}), sleep: async () => {}, id: () => id,
  };
  const result = await openTerminalWindow(client, "saved:fixture", "tmux", deps);
  expect(snapshot()).toEqual(original);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, opened: names, pages: 2 });
  expect(desktop).toHaveBeenCalledTimes(1);
  expect(beforeSplits).toEqual(Array(17).fill(size));
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(tmux(viewer, ["list-panes", "-s", "-t", `=openrig-view-${id}`, "-F", "#{pane_dead}"]).trim().split("\n")).toEqual(Array(19).fill("0"));
  for (const page of [1, 2]) {
    expect(tmux(viewer, ["show-options", "-Awv", "-t", `openrig-view-${id}:view-${page}`, "window-size"]).trim()).toBe("latest");
  }
}, 40_000);

it.each([false, true])("opens real viewer panes and preserves source processes (one role per window=%s)", async paged => {
  // Short names also fit macOS Unix sockets under CI's existing TMPDIR.
  const source = `ws-${randomUUID().slice(0, 12)}`;
  const viewer = `wv-${randomUUID().slice(0, 12)}`;
  sockets.push(source, viewer);
  const names = paged ? ["operator", "tui", "advisor"] : ["tui", "advisor", "operator"];
  for (const name of names) tmux(source, ["new-session", "-d", "-s", name, "sleep 60"]);
  const original = tmux(source, ["list-panes", "-a", "-F", "#{session_name} #{pane_id} #{pane_pid}"]);
  const panes = names.map(seat => ({ seat, label: seat, paneCommand: `tmux -L ${source} attach-session -t '=${seat}'` }));
  const client = { baseUrl: "http://localhost:7433", get: async () => ({ status: 200, data: { planId: "fixture", status: {}, composed: { opened: panes, pages: paged ? panes.map(pane => [pane]) : [panes], columns: paged ? 1 : 3, absent: [], degraded: [] } } }) } as unknown as DaemonClient;
  const desktop = vi.fn(async () => "window");
  const deps: WindowDeps = {
    platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" }, exists: () => false,
    exec: async (file, args) => {
      if (file === "/bin/sh") return "tmux";
      if (file === "/usr/bin/osascript") return desktop();
      if (file === "tmux") return tmux(viewer, args);
      throw new Error(`unexpected executable ${file}`);
    },
    launch: vi.fn(async () => {}), sleep: async () => {}, id: () => "owned-view",
  };
  const result = await openTerminalWindow(client, "saved:kernel", "tmux", deps);
  expect(result).toMatchObject({ ok: true, opened: names, pages: paged ? 3 : 1 });
  expect(desktop).toHaveBeenCalledTimes(1);
  expect(tmux(viewer, ["display-message", "-p", "-t", "=openrig-view-owned-view", "#{window_name}"]).trim()).toBe("view-1");
  for (const [index, expected] of (paged ? names.map(name => [name]) : [names]).entries()) {
    const actual = tmux(viewer, ["list-panes", "-t", `openrig-view-owned-view:view-${index + 1}`, "-F", "#{pane_title}|#{pane_top}|#{pane_left}|#{pane_dead}"]).trim().split("\n").map(line => line.split("|"));
    expect(actual.map(row => row[0])).toEqual(expected);
    expect(actual.map(row => row[1])).toEqual(expected.map(() => "0"));
    expect(actual.map(row => Number(row[2]))).toEqual([...actual.map(row => Number(row[2]))].sort((a, b) => a - b));
    expect(actual.every(row => row[3] === "0")).toBe(true);
  }
  expect(tmux(source, ["list-panes", "-a", "-F", "#{session_name} #{pane_id} #{pane_pid}"])).toBe(original);
});
