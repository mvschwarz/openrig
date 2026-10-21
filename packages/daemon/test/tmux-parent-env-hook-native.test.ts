// #771 — the parent-identity cleanup restarts only the pane `new-session` created. A tmux
// `after-new-session` hook that links (and so selects) an existing window into the new session is
// ordinary user config; the window it brings in must keep its running process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

const run = promisify(exec);
const runFile = promisify(execFile);

describe.skipIf(process.platform === "win32")("parent-session cleanup with an after-new-session hook (native tmux)", () => {
  it("restarts only the seat's own pane; the linked existing window keeps its process", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-hook-"));
    const socket = path.join(temp, "owned.sock");
    const env = { ...process.env, HOME: temp };
    delete env.TMUX;
    delete env.TMUX_TMPDIR;
    const tmux = async (...args: string[]) => (await runFile("tmux", ["-S", socket, ...args], { env })).stdout.trim();
    try {
      await runFile("tmux", ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-s", "owner", "sleep 600"], { env });
      // The server carries a parent Claude Code identity, so the cleanup has something to remove.
      await tmux("set-environment", "-g", "CLAUDECODE", "1");
      await tmux("set-hook", "-g", "after-new-session", "link-window -s owner:0");
      const [ownerPane, ownerPid] = (await tmux("list-panes", "-t", "owner:0", "-F", "#{pane_id} #{pane_pid}")).split(" ");

      const adapter = new TmuxAdapter(async cmd => {
        expect(cmd).toMatch(/^tmux /);
        return (await run(`tmux -S ${shellQuote(socket)} ${cmd.slice(5)}`, { env })).stdout;
      });
      const result = await adapter.createSession("seat", temp, { OPENRIG_NODE_ID: "n1" });
      expect(result).toMatchObject({ ok: true });

      // The hook did bring the owner's window in, and made it the seat session's current window.
      expect(await tmux("display-message", "-p", "-t", "=seat:", "#{pane_id}")).toBe(ownerPane);
      // The owner's pane was not restarted: same pane, same process, still running. (Not the command
      // name: a default shell that doesn't exec its last command, such as dash, stays the pane's
      // process, so pane_current_command reads `dash`, not `sleep`.)
      expect(await tmux("list-panes", "-t", "owner:0", "-F", "#{pane_id} #{pane_pid} #{pane_dead}")).toBe(`${ownerPane} ${ownerPid} 0`);
      expect(() => process.kill(Number(ownerPid), 0)).not.toThrow();
      // The seat's own pane was restarted without the parent identity.
      const seatPanes = (await tmux("list-panes", "-s", "-t", "=seat", "-F", "#{pane_id} #{pane_pid}")).split("\n").map(line => line.split(" "));
      const own = seatPanes.filter(([id]) => id !== ownerPane);
      expect(own).toHaveLength(1);
      if (process.platform === "linux") {
        const environ = fs.readFileSync(`/proc/${own[0]![1]}/environ`, "utf8").split("\0");
        expect(environ.filter(entry => entry.startsWith("CLAUDECODE="))).toEqual([]);
        expect(environ).toContain("OPENRIG_NODE_ID=n1");
      }
    } finally {
      // This socket belongs to this test, never the user's terminal server.
      await runFile("tmux", ["-S", socket, "kill-server"], { env }).catch(() => {});
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
