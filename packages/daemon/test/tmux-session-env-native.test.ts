import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";

const run = promisify(exec);
const runFile = promisify(execFile);

async function withServer(mode: "shell" | "argv", check: (adapter: TmuxAdapter, home: string, tmux: (args: string[]) => Promise<string>) => Promise<void>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-env-"));
  const socket = path.join(home, "owned.sock");
  const env = { ...process.env, HOME: home };
  delete env.TMUX;
  delete env.TMUX_TMPDIR;
  const tmux = async (args: string[]) => (await runFile("tmux", ["-S", socket, ...args], { env })).stdout;
  try {
    await tmux(["-f", "/dev/null", "new-session", "-d", "-s", "worker-long", "-e", "OPENRIG_NODE_ID=neighbor-node", "-e", "OPENRIG_SESSION_NAME=worker-long", "-e", "OPENRIG_RUNTIME=terminal", "sleep 60"]);
    const shellExec = async (cmd: string) => {
      expect(cmd).toMatch(/^tmux /);
      return (await run(`tmux -S ${shellQuote(socket)} ${cmd.slice(5)}`, { env })).stdout;
    };
    const adapter = new TmuxAdapter(shellExec, undefined, mode === "argv" ? async args => {
      expect(args[0]).toBe("tmux");
      return tmux(args.slice(1));
    } : undefined);
    await check(adapter, home, tmux);
  } finally {
    await tmux(["kill-server"]).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("native tmux session launch environment", () => {
  for (const mode of ["shell", "argv"] as const) {
    it(`${mode}: rejects an absent prefix rather than reading its neighbor`, async () => {
      await withServer(mode, async adapter => {
        await expect(adapter.getSessionEnv("worker", "OPENRIG_NODE_ID")).rejects.toThrow("Cannot read the session's launch environment.");
        expect(await adapter.getSessionEnv("worker-long", "OPENRIG_NODE_ID")).toBe("neighbor-node");
      });
    });

    it(`${mode}: launch correction does not reassert a stale target's neighbor identity`, async () => {
      await withServer(mode, async (adapter, home) => {
        const cli = path.join(home, "rig-fixture");
        fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const launch = new SeatLaunchEnvironment(adapter, { OPENRIG_HOME: home }, home, cli);
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          // The ordinary launch caller must retain its previous command when
          // its target has gone, without reasserting a neighbor's identity.
          expect(await launch.command("worker", "printf fixture")).toBe("printf fixture");
        } finally { warning.mockRestore(); }
      });
    });

    it(`${mode}: preserves exact literal names and session-id reads`, async () => {
      await withServer(mode, async (adapter, _home, tmux) => {
        const id = (await tmux(["new-session", "-d", "-P", "-F", "#{session_id}", "-s", "worker", "-e", "OPENRIG_NODE_ID=own-node", "sleep 60"])).trim();
        await tmux(["new-session", "-d", "-s", "=worker", "-e", "OPENRIG_NODE_ID=literal-node", "sleep 60"]);
        expect(await adapter.getSessionEnv("worker", "OPENRIG_NODE_ID")).toBe("own-node");
        expect(await adapter.getSessionEnv("=worker", "OPENRIG_NODE_ID")).toBe("literal-node");
        expect(await adapter.getSessionEnv(id, "OPENRIG_NODE_ID")).toBe("own-node");
      });
    });

    it(`${mode}: preserves absent/unset variables and invalid-key rejection`, async () => {
      await withServer(mode, async (adapter, _home, tmux) => {
        expect(await adapter.getSessionEnv("worker-long", "OPENRIG_UNSET_FIXTURE")).toBeUndefined();
        await tmux(["set-environment", "-r", "-t", "=worker-long", "OPENRIG_NODE_ID"]);
        expect(await adapter.getSessionEnv("worker-long", "OPENRIG_NODE_ID")).toBeUndefined();
        await expect(adapter.getSessionEnv("worker-long", "not-a-key")).rejects.toThrow("Invalid session environment key.");
      });
    });
  }
});
