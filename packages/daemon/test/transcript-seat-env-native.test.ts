import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
const run = promisify(exec);
const runFile = promisify(execFile);
const keys = ["OPENRIG_TRANSCRIPTS_LINES", "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS"];

describe.skipIf(process.platform === "win32")("native transcript seat environment", () => {
  it.each([false, true])("does not pin daemon transcript defaults inside a seat (argv=%s)", async (argv) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-env-"));
    // Unix sockets have a much shorter path bound than filesystem paths.
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "socket-"));
    const socket = path.join(socketDir, "owned.sock");
    const captured = path.join(temp, "seat.env");
    const config = path.join(temp, "config.json");
    const env = { ...process.env, HOME: temp, OPENRIG_TRANSCRIPTS_LINES: "777", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "44" };
    delete env.TMUX;
    delete env.TMUX_TMPDIR;
    const prior = keys.map((key) => process.env[key]);
    try {
      await runFile("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "server", "sleep 60"], { env });
      const adapter = new TmuxAdapter(async (cmd) => (await run(`tmux -S ${shellQuote(socket)} ${cmd.slice(5)}`, { env })).stdout,
        undefined, argv ? async (args) => (await runFile(args[0]!, ["-S", socket, ...args.slice(1)], { env })).stdout : undefined);
      expect(await adapter.createSession("fixture", temp)).toEqual({ ok: true });
      await runFile("tmux", ["-S", socket, "respawn-pane", "-k", "-t", "=fixture:", `/usr/bin/env > ${shellQuote(captured)}; sleep 60`], { env });
      const deadline = Date.now() + 2000;
      while (!fs.existsSync(captured) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      const seatEnv = Object.fromEntries(fs.readFileSync(captured, "utf8").split("\n").filter((line) => line.includes("=")).map((line) => {
        const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)];
      }));
      for (const key of keys) {
        if (seatEnv[key] === undefined) delete process.env[key]; else process.env[key] = seatEnv[key];
      }
      fs.writeFileSync(config, JSON.stringify({ transcripts: { lines: 123, pollIntervalSeconds: 15 } }));
      const store = new SettingsStore(config);
      expect(store.resolveOne("transcripts.lines")).toMatchObject({ value: 123, source: "file" });
      expect(store.resolveOne("transcripts.poll_interval_seconds")).toMatchObject({ value: 15, source: "file" });
      // A deliberate seat override remains authoritative.
      expect(await adapter.createSession("explicit", temp, { OPENRIG_TRANSCRIPTS_LINES: "321" })).toEqual({ ok: true });
      const explicit = (await runFile("tmux", ["-S", socket, "show-environment", "-t", "=explicit:", "OPENRIG_TRANSCRIPTS_LINES"], { env })).stdout;
      expect(explicit.trim()).toBe("OPENRIG_TRANSCRIPTS_LINES=321");
      // The daemon/server retains its own capture policy.
      const server = (await runFile("tmux", ["-S", socket, "show-environment", "-g", "OPENRIG_TRANSCRIPTS_LINES"], { env })).stdout;
      expect(server.trim()).toBe("OPENRIG_TRANSCRIPTS_LINES=777");
    } finally {
      for (const [index, key] of keys.entries()) {
        if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index];
      }
      await runFile("tmux", ["-S", socket, "kill-server"], { env }).catch(() => {});
      fs.rmSync(temp, { recursive: true, force: true });
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });
});
