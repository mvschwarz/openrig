import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import { buildPiRunnerCommand, piSeatPaths } from "../src/adapters/pi-runner-protocol.js";

const exec = promisify(execCallback);
const run = promisify(execFile);
let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch { /* optional native dependency */ }
const quote = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";

// The runner entry is deliberately offline: this exercises the real adapter,
// tmux, canonical macOS tty and shell, without starting Pi or touching provider settings.
describe.skipIf(!hasTmux || process.platform === "win32")("Pi launch through a canonical native tty", () => {
  it.each(["fresh", "fork", "resume"])("preserves all %s runner arguments beyond the canonical input limit", async mode => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-"));
    const socket = path.join(temp, "tmux.sock");
    const session = "pi-fixture";
    const long = Array.from({ length: 8 }, () => "nested-directory-" + "x".repeat(35)).join(path.sep);
    const stateRoot = path.join(temp, long, "state");
    const cwd = path.join(temp, long, "project with 'quotes'");
    fs.mkdirSync(cwd, { recursive: true });
    const runner = path.join(temp, "offline-runner.cjs");
    fs.writeFileSync(runner, `const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const at = flag => args[args.indexOf(flag) + 1];
const stateRoot = at('--state-root'), name = at('--session-name');
const dir = path.join(stateRoot, name); fs.mkdirSync(dir, { recursive: true });
const sessionFile = args.includes('--session') ? at('--session') : path.join(dir, 'sessions', 'child.jsonl');
fs.writeFileSync(path.join(dir, 'runner-state.json'), JSON.stringify({ready:true, launchId:at('--launch-id'), sessionFile, sessionId:'offline', updatedAt:new Date().toISOString()}));
fs.writeFileSync(path.join(dir, 'received.json'), JSON.stringify({cwd:at('--cwd'), sessionFile, args}));\n`);
    const parent = path.join(stateRoot, session, "sessions", "parent.jsonl");
    fs.mkdirSync(path.dirname(parent), { recursive: true });
    fs.writeFileSync(parent, "fixture\n");
    const expected = buildPiRunnerCommand({ runnerEntryPath: runner, sessionName: session,
      stateRoot, cwd, launchId: "attempt", trust: "no-approve",
      sessionFile: mode === "resume" ? parent : undefined,
      forkRef: mode === "fork" ? parent : undefined });
    expect(Buffer.byteLength(expected)).toBeGreaterThan(1024);
    const fsOps = { readFile: (p: string) => fs.readFileSync(p, "utf8"),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
      exists: fs.existsSync, mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); } };
    try {
      // The canonical reader models a shell before an interactive line editor
      // takes over. Only the owned fixture socket receives input.
      await run("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", session,
        `env PATH=${quote(process.env.PATH ?? "")} /bin/sh -c 'stty icanon -echo; while IFS= read -r line; do eval "$line"; done'`]);
      const tmux = new TmuxAdapter(async command => (await exec(command.replace(/^tmux /,
        `tmux -S ${quote(socket)} `))).stdout);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (mode === "resume") {
        const adapter = new PiResumeAdapter(tmux, fsOps, { stateRoot, runnerEntryPath: runner },
          { maxWaitMs: 2000, pollMs: 25, newLaunchId: () => "attempt" });
        expect(await adapter.resume(session, "pi_session_file", parent, cwd)).toMatchObject({ ok: true });
      } else {
        const adapter = new PiRuntimeAdapter({ tmux, fsOps, stateRoot, runnerEntryPath: runner,
          sleep: () => new Promise(resolve => setTimeout(resolve, 25)), newLaunchId: () => "attempt" });
        expect(await adapter.launchHarness({ tmuxSession: session, cwd } as never,
          { name: session, ...(mode === "fork" ? { forkSource: { kind: "native_id" as const, value: parent } } : {}) }))
          .toMatchObject({ ok: true });
      }
      const received = JSON.parse(fs.readFileSync(path.join(stateRoot, session, "received.json"), "utf8"));
      expect(received.cwd).toBe(cwd);
      expect(received.args).toContain("--no-approve");
      expect(received.sessionFile).toBe(mode === "resume" ? parent : piSeatPaths(stateRoot, session).sessionsDir + "/child.jsonl");
      if (mode === "fork") expect(received.args[received.args.indexOf("--fork") + 1]).toBe(parent);
    } finally {
      await run("tmux", ["-S", socket, "kill-server"]).catch(() => {});
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 10_000);
});
