import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";
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
describe.skipIf(!hasTmux || process.platform === "win32")("Pi launch through native tty", () => {
  it.each(["fresh", "fork", "resume", "short-long-tmpdir"].flatMap(mode => [
    { mode, canonical: true }, { mode, canonical: false },
  ]))("preserves $mode runner arguments (canonical reader: $canonical)", async ({ mode, canonical }) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-"));
    const socket = path.join(temp, "tmux.sock");
    const session = "pi-fixture";
    const long = Array.from({ length: 8 }, () => "nested-directory-" + "x".repeat(35)).join(path.sep);
    const stateRoot = path.join(temp, mode === "short-long-tmpdir" ? "short" : long, "state");
    const cwd = path.join(temp, mode === "short-long-tmpdir" ? "short" : long, "project with 'quotes'");
    fs.mkdirSync(cwd, { recursive: true });
    const runner = path.join(temp, "offline-runner.cjs");
    fs.writeFileSync(runner, `const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const at = flag => args[args.indexOf(flag) + 1];
const stateRoot = at('--state-root'), name = at('--session-name');
const dir = path.join(stateRoot, name); fs.mkdirSync(dir, { recursive: true });
const sessionFile = args.includes('--session') ? at('--session') : path.join(dir, 'sessions', 'child.jsonl');
fs.writeFileSync(path.join(dir, 'runner-state.json'), JSON.stringify({ready:true, launchId:at('--launch-id'), sessionFile, sessionId:'offline', updatedAt:new Date().toISOString()}));
fs.writeFileSync(path.join(dir, 'received.json'), JSON.stringify({cwd:at('--cwd'), sessionFile, args}));
setInterval(() => {}, 1000);\n`);
    const parent = path.join(stateRoot, session, "sessions", "parent.jsonl");
    fs.mkdirSync(path.dirname(parent), { recursive: true });
    fs.writeFileSync(parent, "fixture\n");
    const model = mode === "short-long-tmpdir" ? undefined : "provider/model-" + "m".repeat(7000);
    const expected = buildPiRunnerCommand({ runnerEntryPath: runner, sessionName: session,
      stateRoot, cwd, model, launchId: "attempt", trust: "no-approve",
      sessionFile: mode === "resume" ? parent : undefined,
      forkRef: mode === "fork" ? parent : undefined });
    if (mode === "short-long-tmpdir") expect(Buffer.byteLength(expected)).toBeLessThanOrEqual(512);
    else expect(Buffer.byteLength(expected)).toBeGreaterThan(7000);
    const fsOps = { readFile: (p: string) => fs.readFileSync(p, "utf8"),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
      exists: fs.existsSync, mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); } };
    try {
      // The canonical reader models a shell before an interactive line editor
      // takes over. Only the owned fixture socket receives input.
      await run("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", session,
        `env PATH=${quote(process.env.PATH ?? "")} ${canonical
          ? `/bin/sh -c 'stty icanon -echo; while IFS= read -r line; do eval "$line"; done'`
          : "/bin/bash --noprofile --norc -i"}`]);
      const longTmpdir = path.join(temp, ...Array.from({ length: 9 }, () => "t".repeat(60)));
      let fileOps: TmuxFileOps | undefined;
      if (mode === "short-long-tmpdir") {
        fs.mkdirSync(longTmpdir, { recursive: true });
        let names = 0;
        fileOps = {
          tmpName: () => path.join(longTmpdir, `launch-${names++}.tmp`),
          bufferName: () => `pi-buffer-${names++}`,
          writeFile: (p, text, options) => fs.promises.writeFile(p, text, options),
          unlink: p => fs.promises.unlink(p),
        };
        expect(Buffer.byteLength(`/bin/sh ${quote(fileOps.tmpName())}`)).toBeGreaterThan(512);
      }
      const tmux = new TmuxAdapter(async command => (await exec(command.replace(/^tmux /,
        `tmux -S ${quote(socket)} `))).stdout, fileOps);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (mode === "resume") {
        const adapter = new PiResumeAdapter(tmux, fsOps, { stateRoot, runnerEntryPath: runner },
          { maxWaitMs: 2000, pollMs: 25, newLaunchId: () => "attempt" });
        expect(await adapter.resume(session, "pi_session_file", parent, cwd, model)).toMatchObject({ ok: true });
      } else {
        const adapter = new PiRuntimeAdapter({ tmux, fsOps, stateRoot, runnerEntryPath: runner,
          sleep: () => new Promise(resolve => setTimeout(resolve, 25)), newLaunchId: () => "attempt" });
        expect(await adapter.launchHarness({ tmuxSession: session, cwd, model } as never,
          { name: session, ...(mode === "fork" ? { forkSource: { kind: "native_id" as const, value: parent } } : {}) }))
          .toMatchObject({ ok: true });
      }
      const received = JSON.parse(fs.readFileSync(path.join(stateRoot, session, "received.json"), "utf8"));
      expect(received.cwd).toBe(cwd);
      expect(received.args).toContain("--no-approve");
      expect(received.sessionFile).toBe(mode === "resume" ? parent : piSeatPaths(stateRoot, session).sessionsDir + "/child.jsonl");
      if (mode === "fork") expect(received.args[received.args.indexOf("--fork") + 1]).toBe(parent);
      if (model) expect(received.args[received.args.indexOf("--model") + 1]).toBe(model);
      if (canonical) return; // Argument-delivery floor; readiness needs real interactive shell job control.
      const readiness = new PiRuntimeAdapter({ tmux, fsOps, stateRoot, runnerEntryPath: runner });
      const binding = { tmuxSession: session, cwd } as never;
      expect(await readiness.checkReady(binding)).toEqual({ ready: true });
      await run("tmux", ["-S", socket, "send-keys", "-t", session, "C-c"]);
      for (let attempt = 0; attempt < 100 && (await tmux.getPaneCommand(session)) === "node"; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(await readiness.checkReady(binding)).toMatchObject({ ready: false, code: "runner_exited" });
    } finally {
      await run("tmux", ["-S", socket, "kill-server"]).catch(() => {});
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 10_000);
});
