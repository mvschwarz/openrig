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

describe.skipIf(process.platform === "win32")("native tmux pane paths", () => {
  it("preserves pipe characters in pane cwd and still parses geometry", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-cwd-"));
    const socket = path.join(temp, "owned.sock");
    const cwd = path.join(temp, "work|assets|120");
    fs.mkdirSync(cwd);
    const env = { ...process.env, HOME: temp };
    delete env.TMUX;
    delete env.TMUX_TMPDIR;
    try {
      await runFile("tmux", ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-s", "fixture", "-x", "120", "-y", "30", "-c", cwd, "sleep 60"], { env });
      const adapter = new TmuxAdapter(async cmd => {
        expect(cmd).toMatch(/^tmux /);
        return (await run(`tmux -S ${shellQuote(socket)} ${cmd.slice(5)}`, { env })).stdout;
      });
      const panes = await adapter.listPanes("fixture");
      expect(panes).toHaveLength(1);
      expect(panes[0]).toMatchObject({ cwd: fs.realpathSync(cwd), index: 0, width: 120, height: 30, active: true });
      expect(panes[0]!.id).toMatch(/^%\d+$/);
    } finally {
      // This socket belongs to this test, never the user's terminal server.
      await runFile("tmux", ["-S", socket, "kill-server"], { env }).catch(() => {});
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
