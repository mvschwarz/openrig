import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TMUX_CREDENTIAL_ENV_KEYS } from "../src/adapters/tmux-credential-env.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";

const run = promisify(exec);
const runFile = promisify(execFile);

async function withServer(mode: "shell" | "argv", check: (adapter: TmuxAdapter, home: string, tmux: (args: string[]) => Promise<string>) => Promise<void>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-env-"));
  const socket = path.join(home, "owned.sock");
  const env = { ...process.env, HOME: home };
  for (const key of [...TMUX_CREDENTIAL_ENV_KEYS, ...Object.keys(env).filter(key => key.startsWith("OPENRIG_RUN_GRANT_"))]) delete env[key];
  delete env.TMUX;
  delete env.TMUX_TMPDIR;
  const tmux = async (args: string[]) => (await runFile("tmux", ["-S", socket, ...args], { env })).stdout;
  // The adapter reads the host registry from OPENRIG_HOME: this fixture's, never the runner's.
  vi.stubEnv("OPENRIG_HOME", home);
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
    vi.unstubAllEnvs();
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

    // What a pane started in the session afterwards would have in its environment.
    const nextPaneEnv = async (home: string, tmux: (args: string[]) => Promise<string>, session: string) => {
      const file = path.join(home, `next-${Math.random().toString(36).slice(2)}.env`);
      await tmux(["new-window", "-d", "-t", `=${session}:`, `env > ${shellQuote(file)}.part && mv ${shellQuote(file)}.part ${shellQuote(file)}`]);
      for (let i = 0; i < 50 && !fs.existsSync(file); i++) await new Promise(r => setTimeout(r, 100));
      return fs.readFileSync(file, "utf8").split("\n");
    };

    it(`${mode}: unsetting a name gives later panes the server's value, except the launching session's identity, which stays removed`, async () => {
      await withServer(mode, async (adapter, home, tmux) => {
        await tmux(["set-environment", "-g", "CLAUDECODE", "1"]);
        await tmux(["set-environment", "-g", "CLAUDE_EFFORT", "from-parent"]);
        await tmux(["set-environment", "-g", "PLAIN_NAME", "from-server"]);
        await tmux(["set-environment", "-t", "=worker-long", "CLAUDE_EFFORT", "one-off"]);
        await tmux(["set-environment", "-t", "=worker-long", "PLAIN_NAME", "one-off"]);
        await adapter.unsetSessionEnv("worker-long", "CLAUDE_EFFORT");
        await adapter.unsetSessionEnv("worker-long", "PLAIN_NAME");
        const env = await nextPaneEnv(home, tmux, "worker-long");
        expect(env).toContain("PLAIN_NAME=from-server");
        expect(env.some(line => line.startsWith("CLAUDE_EFFORT="))).toBe(false);
      });
    });

    it(`${mode}: unsetting credential names never reveals a server-global value`, async () => {
      await withServer(mode, async (adapter, home, tmux) => {
        const keys = [...TMUX_CREDENTIAL_ENV_KEYS, "OPENRIG_RUN_GRANT_SYNTHETIC"];
        const seedConfig = path.join(home, "seed-global-credentials.conf");
        const seed = keys.map(key => `set-environment -g ${key} ${randomBytes(24).toString("hex")}`).join("\n");
        fs.writeFileSync(seedConfig, `${seed}\n`, { mode: 0o600 });
        await tmux(["source-file", seedConfig]);

        for (const key of keys) {
          await adapter.setSessionEnv("worker-long", key, randomBytes(24).toString("hex"));
          await adapter.unsetSessionEnv("worker-long", key);
        }

        const resultFile = path.join(home, "credential-presence.json");
        const probe = path.join(home, "credential-presence.cjs");
        fs.writeFileSync(probe,
          `const fs=require("node:fs");const keys=${JSON.stringify(keys)};`
            + `const present=Object.fromEntries(keys.map(key=>[key,Object.hasOwn(process.env,key)]));`
            + `fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(present));\n`,
          { mode: 0o600 });
        await tmux(["new-window", "-d", "-t", "=worker-long:", `${shellQuote(process.execPath)} ${shellQuote(probe)}`]);
        for (let i = 0; i < 50 && !fs.existsSync(resultFile); i++) await new Promise(r => setTimeout(r, 100));
        const present = JSON.parse(fs.readFileSync(resultFile, "utf8")) as Record<string, boolean>;
        expect(present).toEqual(Object.fromEntries(keys.map(key => [key, false])));
      });
    });

    // Synthetic values only. A seat given one of the daemon's Slack, notification or host-registry bearer names
    // explicitly has it; removing it marks it removed, so a server-global value never comes back to the seat.
    it(`${mode}: explicit seat values of the daemon's Slack, notification and registry bearer names work, and their removal never reveals a server-global value`, async () => {
      await withServer(mode, async (adapter, home, tmux) => {
        fs.writeFileSync(path.join(home, "hosts.yaml"),
          "hosts:\n  - id: remote-a\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: SYNTH_REMOTE_A_BEARER\n");
        const keys = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "OPENRIG_SLACK_BOT_TOKEN", "OPENRIG_SLACK_APP_TOKEN",
          "OPENRIG_NOTIFICATIONS_TARGET", "SYNTH_REMOTE_A_BEARER"];
        const seedConfig = path.join(home, "seed-global-daemon-credentials.conf");
        fs.writeFileSync(seedConfig, `${keys.map(key => `set-environment -g ${key} ${randomBytes(24).toString("hex")}`).join("\n")}\n`, { mode: 0o600 });
        await tmux(["source-file", seedConfig]);
        await tmux(["set-environment", "-g", "SYNTH_ORDINARY_SETTING", "from-server"]);
        await tmux(["set-environment", "-t", "=worker-long", "SYNTH_ORDINARY_SETTING", "one-off"]);

        const explicit = Object.fromEntries(keys.map(key => [key, `seat-${randomBytes(12).toString("hex")}`]));
        for (const key of keys) await adapter.setSessionEnv("worker-long", key, explicit[key]!);
        const withExplicit = await nextPaneEnv(home, tmux, "worker-long");
        for (const key of keys) expect(withExplicit).toContain(`${key}=${explicit[key]}`);

        for (const key of [...keys, "SYNTH_ORDINARY_SETTING"]) await adapter.unsetSessionEnv("worker-long", key);
        const afterRemoval = await nextPaneEnv(home, tmux, "worker-long");
        expect(keys.filter(key => afterRemoval.some(line => line.startsWith(`${key}=`)))).toEqual([]);
        expect(afterRemoval).toContain("SYNTH_ORDINARY_SETTING=from-server");
      });
    });

    it(`${mode}: a CLAUDE_EFFORT that is user configuration (no parent Claude Code session) is inherited as before`, async () => {
      await withServer(mode, async (adapter, home, tmux) => {
        await tmux(["set-environment", "-g", "-u", "CLAUDECODE"]); // the test runner may itself be inside Claude Code
        await tmux(["set-environment", "-g", "CLAUDE_EFFORT", "user-setting"]);
        await tmux(["set-environment", "-t", "=worker-long", "CLAUDE_EFFORT", "one-off"]);
        await adapter.unsetSessionEnv("worker-long", "CLAUDE_EFFORT");
        expect(await nextPaneEnv(home, tmux, "worker-long")).toContain("CLAUDE_EFFORT=user-setting");
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
