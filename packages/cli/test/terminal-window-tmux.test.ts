import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DaemonClient } from "../src/client.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";

// Real isolated tmux servers; the desktop launcher alone is inert.
const sockets: string[] = [];
const env = { ...process.env }; delete env["TMUX"];
function tmux(socket: string, args: string[]): string {
  return execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", env, timeout: 5000 });
}
afterEach(() => {
  for (const socket of sockets.splice(0)) {
    try { tmux(socket, ["kill-server"]); } catch { /* Already exited after a failing setup. */ }
  }
});

it("opens three real viewer panes while original sessions keep the same pane and process", async () => {
  // Short names also fit macOS Unix sockets under CI's existing TMPDIR.
  const source = `ws-${randomUUID().slice(0, 12)}`;
  const viewer = `wv-${randomUUID().slice(0, 12)}`;
  sockets.push(source, viewer);
  const names = ["tui", "advisor", "operator"];
  for (const name of names) tmux(source, ["new-session", "-d", "-s", name, "sleep 60"]);
  const original = tmux(source, ["list-panes", "-a", "-F", "#{session_name} #{pane_id} #{pane_pid}"]);
  const panes = names.map(seat => ({ seat, label: seat, paneCommand: `tmux -L ${source} attach-session -t '=${seat}'` }));
  const client = { baseUrl: "http://localhost:7433", get: async () => ({ status: 200, data: { planId: "fixture", status: {}, composed: { opened: panes, pages: [panes], columns: 3, absent: [], degraded: [] } } }) } as unknown as DaemonClient;
  const desktop = vi.fn(async () => "window");
  const deps: WindowDeps = {
    platform: "darwin", env: { HOME: "/fixture" }, exists: () => false,
    exec: async (file, args) => {
      if (file === "/bin/sh") return "tmux";
      if (file === "/usr/bin/osascript") return desktop();
      if (file === "tmux") return tmux(viewer, args);
      throw new Error(`unexpected executable ${file}`);
    },
    launch: vi.fn(async () => {}), sleep: async () => {}, id: () => "owned-view",
  };
  const result = await openTerminalWindow(client, "saved:kernel", "tmux", deps);
  expect(result).toMatchObject({ ok: true, opened: names });
  expect(desktop).toHaveBeenCalledTimes(1);
  const actual = tmux(viewer, ["list-panes", "-t", "openrig-view-owned-view:view-1", "-F", "#{pane_title}|#{pane_top}|#{pane_left}|#{pane_dead}"]).trim().split("\n").map(line => line.split("|"));
  expect(actual.map(row => row[0])).toEqual(names);
  expect(actual.map(row => row[1])).toEqual(["0", "0", "0"]);
  expect(actual.map(row => Number(row[2]))).toEqual([...actual.map(row => Number(row[2]))].sort((a, b) => a - b));
  expect(actual.every(row => row[3] === "0")).toBe(true);
  expect(tmux(source, ["list-panes", "-a", "-F", "#{session_name} #{pane_id} #{pane_pid}"])).toBe(original);
});
