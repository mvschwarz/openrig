import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

const run = promisify(execFile);

// tmux keeps a stack of pane modes, and #{pane_in_mode} counts them. A person who scrolled back (copy mode) can end up
// with another mode on top: run-shell output shown in view-mode, a chooser, customize or clock mode. A delivery must
// leave all of them, or Enter never reaches the agent. A private tmux server; no seat or daemon is involved.
describe.skipIf(process.platform === "win32")("native tmux: leaving a pane's modes before a delivery", () => {
  async function server() {
    const scratch = mkdtempSync(join(tmpdir(), "mode-"));
    const socket = join(scratch, "s");
    const env = { ...process.env }; delete env.TMUX; delete env.TMUX_TMPDIR;
    const tmux = async (args: string[]) => (await run("tmux", ["-S", socket, ...args], { env })).stdout;
    const close = async () => { await tmux(["kill-server"]).catch(() => {}); rmSync(scratch, { recursive: true, force: true }); };
    let pane = "";
    try {
      // No shell prompt: the pane prints its lines and then sleeps, so its screen stops changing once "line 35" is drawn.
      pane = (await tmux(["-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pane_id}", "-x", "100", "-y", "30",
        "sh -c 'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35; do echo line $i; done; exec sleep 600'"])).trim();
      await vi.waitFor(async () => expect(await tmux(["capture-pane", "-p", "-t", pane])).toContain("line 35"), { timeout: 5000, interval: 25 });
    } catch (error) {
      await close(); // a failed setup leaves no private server or sleeper behind
      throw error;
    }
    const adapter = new TmuxAdapter(async () => { throw new Error("Native fixture requires argv execution"); }, undefined,
      async args => tmux(args.slice(1)));
    const modes = async () => Number((await tmux(["display-message", "-p", "-t", pane, "#{pane_in_mode}"])).trim());
    return { tmux, pane, adapter, modes, close };
  }

  it.each([
    ["run-shell output (view-mode)", (pane: string) => ["run-shell", "-t", pane, "echo hook output"]],
    ["a chooser (tree-mode)", (pane: string) => ["choose-tree", "-t", pane]],
    ["clock mode", (pane: string) => ["clock-mode", "-t", pane]],
  ])("one cancel leaves copy mode with %s on top of it", async (_label, over) => {
    const s = await server();
    try {
      await s.tmux(["copy-mode", "-t", s.pane]);
      await s.tmux(over(s.pane));
      await vi.waitFor(async () => expect(await s.modes()).toBe(2), { timeout: 5000, interval: 25 });
      expect(await s.adapter.cancelPaneMode(s.pane)).toEqual({ ok: true });
      expect(await s.modes()).toBe(0);
      expect(await s.adapter.isPaneInMode(s.pane)).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("leaves a pane in no mode untouched", async () => {
    const s = await server();
    try {
      const before = await s.tmux(["capture-pane", "-p", "-t", s.pane]);
      expect(await s.modes()).toBe(0);
      expect(await s.adapter.cancelPaneMode(s.pane)).toEqual({ ok: true });
      expect(await s.modes()).toBe(0);
      expect(await s.tmux(["capture-pane", "-p", "-t", s.pane])).toBe(before);
    } finally {
      await s.close();
    }
  });
});
