import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { TmuxDiscoveryScanner } from "../src/domain/tmux-discovery-scanner.js";

const run = promisify(exec);
const runFile = promisify(execFile);

async function withServer(mode: "shell" | "argv", names: string[], check: (adapter: TmuxAdapter) => Promise<void>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-names-"));
  const socket = path.join(home, "owned.sock");
  const env = { ...process.env, HOME: home };
  delete env.TMUX;
  delete env.TMUX_TMPDIR;
  const tmux = async (args: string[]) => (await runFile("tmux", ["-S", socket, ...args], { env })).stdout;
  try {
    for (const name of names) {
      await tmux(["-f", "/dev/null", "new-session", "-d", "-s", name, "-c", home, "printf 'native-session-fixture\\n'; sleep 60"]);
    }
    const shellExec = async (cmd: string) => {
      expect(cmd).toMatch(/^tmux /);
      return (await run(`tmux -S ${shellQuote(socket)} ${cmd.slice(5)}`, { env })).stdout;
    };
    const adapter = new TmuxAdapter(shellExec, undefined, mode === "argv" ? async args => {
      expect(args[0]).toBe("tmux");
      return tmux(args.slice(1));
    } : undefined);
    // Synchronize with output instead of assuming the newly started pane is ready.
    for (const name of names) {
      await expect.poll(() => adapter.capturePaneContent(name), { timeout: 5000 }).toContain("native-session-fixture");
    }
    await check(adapter);
  } finally {
    await tmux(["kill-server"]).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("native tmux literal session names", () => {
  for (const mode of ["shell", "argv"] as const) {
    it(`${mode}: discovers names containing the metadata separator`, async () => {
      const names = ["agent|notes", "agent|12"];
      await withServer(mode, names, async adapter => {
        const sessions = await adapter.listSessions();
        expect(sessions.map(s => s.name).sort()).toEqual([...names].sort());
        for (const session of sessions) {
          expect(session.windows).toBe(1);
          expect(session.created).toMatch(/^\d+$/);
          expect(session.attached).toBe(false);
        }
        const result = await new TmuxDiscoveryScanner({ tmuxAdapter: adapter }).scan();
        expect(result.panes.map(p => p.tmuxSession).sort()).toEqual([...names].sort());
        for (const pane of result.panes) expect(pane.tmuxPane).toMatch(/^%\d+$/);
      });
    });

    it(`${mode}: batched capture preserves leading and trailing spaces`, async () => {
      const names = [" agent ", "agent", "agent|notes"];
      await withServer(mode, names, async adapter => {
        const batch = await adapter.capturePanesContent([...names, "missing"]);
        expect(batch).not.toBeNull();
        for (const name of names) {
          const single = await adapter.capturePaneContent(name);
          expect(single).toContain("native-session-fixture");
          expect(batch!.get(name)?.text).toBe(single);
        }
        expect(batch!.get("missing")?.text).toBeNull();
      });
    });

    it(`${mode}: ordinary session discovery and capture remain unchanged`, async () => {
      await withServer(mode, ["plain"], async adapter => {
        expect(await adapter.listSessions()).toEqual([expect.objectContaining({ name: "plain", windows: 1, attached: false })]);
        const result = await new TmuxDiscoveryScanner({ tmuxAdapter: adapter }).scan();
        expect(result.panes).toHaveLength(1);
        expect(result.panes[0]!.tmuxSession).toBe("plain");
        const batch = await adapter.capturePanesContent(["plain"]);
        expect(batch!.get("plain")?.text).toBe(await adapter.capturePaneContent("plain"));
      });
    });
  }
});
