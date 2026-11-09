import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "../src/startup.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { execArgvCommand, execTmuxCommand } from "../src/adapters/tmux-exec.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

const require = createRequire(import.meta.url);
let available = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); available = true; } catch { /* no native premise */ }
const cmuxFactory = async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); };
afterEach(() => vi.unstubAllEnvs());

describe("startup seat bearers", () => {
  it.skipIf(!available || process.platform === "win32")("a fresh server has no bearers while its managed seat's CLI forms both auth headers", async () => {
    const home = mkdtempSync(join(tmpdir(), "openrig-seat-bearer-")), socket = join(home, "server.sock");
    vi.stubEnv("OPENRIG_TERMINAL_BEARER_TOKEN", "synthetic-terminal");
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "synthetic-auth");
    vi.stubEnv("OPENRIG_HOME", home); vi.stubEnv("HOME", home); vi.stubEnv("TMUX", undefined);
    vi.stubEnv("OPENRIG_NO_KERNEL", "1");
    const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory, tmuxExec: async () => "",
      bearerToken: process.env.OPENRIG_AUTH_BEARER_TOKEN });
    const run = (args: string[]) => execArgvCommand(["tmux", "-S", socket, ...args]);
    const output = join(home, "headers.json"), script = join(home, "seat.mjs");
    try {
      await run(["-f", "/dev/null", "new-session", "-d", "-s", "anchor", "sleep 60"]);
      await run(["set-option", "-g", "default-shell", "/bin/sh"]);
      // Only the CLI transport is mocked: its real resolver and queue command read the pane's delivered env.
      writeFileSync(script, `import fs from 'node:fs';
import { Command } from ${JSON.stringify(pathToFileURL(require.resolve("commander")).href)};
import { terminalAuthHeaders } from ${JSON.stringify(new URL("../../cli/src/client.ts", import.meta.url).href)};
import { queueCommand } from ${JSON.stringify(new URL("../../cli/src/commands/queue.ts", import.meta.url).href)};
import { STATE_FILE } from ${JSON.stringify(new URL("../../cli/src/daemon-lifecycle.ts", import.meta.url).href)};
let auth;
const client = { get: async () => ({ status: 200, data: { qitemId: 'fixture', state: 'in-progress' } }),
 post: async (_path, _body, options) => { auth = options?.headers?.Authorization; return { status: 200, data: { qitemId: 'fixture', state: 'in-progress' } }; } };
const lifecycleDeps = { readFile: p => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 7777, db: 'scratch', startedAt: new Date().toISOString() }) : null,
 exists: p => p === STATE_FILE, isProcessAlive: () => true, fetch: async () => ({ ok: true }) };
await new Command().addCommand(queueCommand({ lifecycleDeps, clientFactory: () => client })).parseAsync(['node', 'rig', 'queue', 'resolve', 'fixture', '--decision', 'scratch', '--no-notify', '--json']);
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ terminal: terminalAuthHeaders().Authorization, auth }));
`);
      await run(["set-option", "-g", "default-command", [process.execPath, "--import", pathToFileURL(require.resolve("tsx")).href, script].map(shellQuote).join(" ")]);
      const adapter = new TmuxAdapter(execTmuxCommand, undefined, execArgvCommand, ["-S", socket]);
      const env = Object.fromEntries(Object.entries(daemon.deps.sessionEnv!).filter((entry): entry is [string, string] => entry[1] !== undefined));
      expect((await adapter.createSession("seat", home, { ...env, OPENRIG_SESSION_NAME: "seat@fixture" })).ok).toBe(true);
      for (let n = 0; n < 200 && !existsSync(output); n++) await new Promise(resolve => setTimeout(resolve, 25));
      expect(existsSync(output), "scratch seat did not finish CLI header resolution").toBe(true);
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ terminal: "Bearer synthetic-terminal", auth: "Bearer synthetic-auth" });
      expect(existsSync(join(home, "terminal-token"))).toBe(false);
      const global = await run(["show-environment", "-g"]);
      expect(global).not.toMatch(/^OPENRIG_(?:TERMINAL|AUTH)_BEARER_TOKEN=/m);
      expect(daemon.deps.terminalBearerToken).toBe("synthetic-terminal");
      expect(daemon.deps.missionControlBearerToken).toBe("synthetic-auth");
    } finally {
      try { await run(["kill-server"]); } finally { daemon.eventLoopMonitor.stop(); daemon.db.close(); rmSync(home, { recursive: true, force: true }); }
    }
  }, 30_000);

  it.each(["unset", "explicit-null", "override"])("delivers only the resolved bearers: %s", async mode => {
    vi.stubEnv("OPENRIG_TERMINAL_BEARER_TOKEN", mode === "unset" ? undefined : "ambient-terminal");
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", undefined);
    const options = mode === "unset" ? {} : { terminalBearerToken: mode === "explicit-null" ? null : "selected-terminal", bearerToken: mode === "override" ? "selected-auth" : null };
    const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory, tmuxExec: async () => "", ...options });
    try {
      const env = daemon.deps.sessionEnv!;
      expect(env.OPENRIG_TERMINAL_BEARER_TOKEN).toBe(mode === "override" ? "selected-terminal" : undefined);
      expect(env.OPENRIG_AUTH_BEARER_TOKEN).toBe(mode === "override" ? "selected-auth" : undefined);
      expect(daemon.deps.tmuxAdapter.launchEnvironment!().env).toMatchObject(env);
    } finally { daemon.eventLoopMonitor.stop(); daemon.db.close(); }
  });
});
