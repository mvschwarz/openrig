import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { execFile, execFileSync, exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { buildPiRunnerCommand, piSeatPaths } from "../src/adapters/pi-runner-protocol.js";

const exec = promisify(execCallback);
const run = promisify(execFile);
let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch { /* optional native dependency */ }
const quote = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";

// The runner entry is deliberately offline: this exercises the real adapter,
// tmux, canonical macOS tty and shell, without starting Pi or touching provider settings.
describe.skipIf(!hasTmux || process.platform === "win32")("Pi launch through native tty", () => {
  it.each([...["fresh", "fork", "resume", "short-long-tmpdir", "fresh-long-tmpdir", "fork-long-tmpdir", "resume-long-tmpdir"].flatMap(mode => [
    { mode, canonical: true }, { mode, canonical: false },
  ]), ...["fresh-routing", "fork-routing", "resume-routing", "fork-routing-long-tmpdir", "resume-routing-long-tmpdir"].map(mode => ({ mode, canonical: false }))])("preserves $mode runner arguments (canonical reader: $canonical)", async ({ mode, canonical }) => {
    const launchMode = mode.split("-")[0];
    const longTmp = mode.endsWith("long-tmpdir");
    const routing = mode.includes("-routing");
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-"));
    const socket = path.join(temp, "tmux.sock");
    const session = "pi-fixture";
    const long = Array.from({ length: 8 }, () => "nested-directory-" + "x".repeat(35)).join(path.sep);
    const stateRoot = path.join(temp, longTmp ? "short" : long, "state");
    const cwd = path.join(temp, longTmp ? "short" : long, "project with 'quotes'");
    fs.mkdirSync(cwd, { recursive: true });
    const routeServer = routing ? createServer((req, res) => {
      res.end(JSON.stringify({ instance: "intended", node: req.headers["x-node"] }));
    }) : undefined;
    const sessionEnv = { PATH: process.env.PATH ?? "", OPENRIG_HOME: path.join(temp, "instance"),
      OPENRIG_URL: "", OPENRIG_NODE_ID: "fixture-node", OPENRIG_SESSION_NAME: session,
      OPENRIG_RUNTIME: "pi", OPENRIG_OCCUPANT_GENERATION: "existing-generation" };
    const cli = path.join(temp, "paired-cli");
    const rc = path.join(temp, "pane.rc");
    if (routing) {
      const userBin = path.join(temp, "user-bin"); fs.mkdirSync(userBin);
      fs.writeFileSync(path.join(userBin, "rig"), `#!${process.execPath}\nconsole.log(JSON.stringify({body:{instance:'wrong-cli'}, home:process.env.OPENRIG_HOME, node:process.env.OPENRIG_NODE_ID}));\n`, { mode: 0o700 });
      fs.writeFileSync(cli, `#!${process.execPath}
const http=require('node:http');
http.get(process.env.OPENRIG_URL+'/identity', {headers:{'x-node':process.env.OPENRIG_NODE_ID}}, r=>{
  let body='';r.on('data',c=>body+=c);r.on('end',()=>console.log(JSON.stringify({body:JSON.parse(body), home:process.env.OPENRIG_HOME, node:process.env.OPENRIG_NODE_ID, generation:process.env.OPENRIG_OCCUPANT_GENERATION, runtime:process.env.OPENRIG_RUNTIME, agentDir:process.env.PI_CODING_AGENT_DIR, sessionsDir:process.env.PI_CODING_AGENT_SESSION_DIR, HOME:process.env.HOME, PATH:process.env.PATH, extraPresent:process.env.UNRELATED_SECRET!==undefined})));
}).on('error',()=>{process.exitCode=1;});\n`, { mode: 0o700 });
      fs.writeFileSync(rc, `export OPENRIG_HOME=/wrong OPENRIG_URL=http://127.0.0.1:1 OPENRIG_NODE_ID=wrong OPENRIG_RUNTIME=wrong OPENRIG_OCCUPANT_GENERATION=wrong\nexport PATH=${quote(userBin + ":" + sessionEnv.PATH)} HOME=${quote(temp)} UNRELATED_SECRET=synthetic\nprintf ready > ${quote(path.join(temp, "rc-ready"))}\n`);
    }
    const runner = path.join(temp, "offline-runner.cjs");
    fs.writeFileSync(runner, `const fs = require('node:fs'); const path = require('node:path');
(async () => {
const args = process.argv.slice(2); const at = flag => args[args.indexOf(flag) + 1];
const stateRoot = at('--state-root'), name = at('--session-name');
const dir = path.join(stateRoot, name); fs.mkdirSync(dir, { recursive: true });
const sessionFile = args.includes('--session') ? at('--session') : path.join(dir, 'sessions', 'child.jsonl');
let route;
${routing ? `const {buildPiChildEnv} = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../dist/adapters/pi-runner-protocol.js")).href)});
const childEnv=buildPiChildEnv(process.env,{agentDir:path.join(dir,'agent'),sessionsDir:path.join(dir,'sessions'),model:at('--model')});
route=JSON.parse(require('node:child_process').execFileSync('rig',['whoami'],{env:childEnv,encoding:'utf8',timeout:3000}));` : ""}
fs.writeFileSync(path.join(dir, 'received.json'), JSON.stringify({cwd:at('--cwd'), sessionFile, args, route}));
// Publish readiness after the test artifact: launch/resume can return as soon as this file exists.
fs.writeFileSync(path.join(dir, 'runner-state.json'), JSON.stringify({ready:true, launchId:at('--launch-id'), sessionFile, sessionId:'offline', updatedAt:new Date().toISOString()}));
setInterval(() => {}, 1000);
})().catch(e=>{console.error(e);process.exitCode=1;});\n`);
    const parent = path.join(stateRoot, session, "sessions", "parent.jsonl");
    fs.mkdirSync(path.dirname(parent), { recursive: true });
    fs.writeFileSync(parent, "fixture\n");
    const model = mode === "short-long-tmpdir" ? undefined : "provider/model-" + "m".repeat(longTmp ? 400 : 7000);
    const expected = buildPiRunnerCommand({ runnerEntryPath: runner, sessionName: session,
      stateRoot, cwd, model, launchId: "attempt", trust: "no-approve",
      sessionFile: launchMode === "resume" ? parent : undefined,
      forkRef: launchMode === "fork" ? parent : undefined });
    if (mode === "short-long-tmpdir") expect(Buffer.byteLength(expected)).toBeLessThanOrEqual(512);
    else if (longTmp) {
      expect(Buffer.byteLength(expected)).toBeGreaterThan(512);
      expect(Buffer.byteLength(expected)).toBeLessThan(1024);
    } else expect(Buffer.byteLength(expected)).toBeGreaterThan(7000);
    const fsOps = { readFile: (p: string) => fs.readFileSync(p, "utf8"),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
      exists: fs.existsSync, mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); } };
    try {
      if (routeServer) {
        await new Promise<void>(resolve => routeServer.listen(0, "127.0.0.1", resolve));
        sessionEnv.OPENRIG_URL = `http://127.0.0.1:${(routeServer.address() as { port: number }).port}`;
      }
      // The canonical reader models a shell before an interactive line editor
      // takes over. Only the owned fixture socket receives input.
      await run("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", session,
        ...(routing ? Object.entries(sessionEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]) : []),
        `env PATH=${quote(process.env.PATH ?? "")} ${canonical
          ? `/bin/sh -c 'stty icanon -echo; while IFS= read -r line; do eval "$line"; done'`
          : routing ? `/bin/bash --noprofile --rcfile ${quote(rc)} -i` : "/bin/bash --noprofile --norc -i"}`]);
      const longTmpdir = path.join(temp, ...Array.from({ length: 9 }, () => "t".repeat(60)));
      let fileOps: TmuxFileOps | undefined;
      if (longTmp) {
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
      const send = vi.spyOn(tmux, "sendShellCommand");
      await new Promise(resolve => setTimeout(resolve, 100));
      if (routing) {
        for (let i = 0; i < 100 && !fs.existsSync(path.join(temp, "rc-ready")); i++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(fs.existsSync(path.join(temp, "rc-ready"))).toBe(true);
      }
      const seatLaunchEnvironment = routing ? new SeatLaunchEnvironment(tmux, sessionEnv, cwd, cli) : undefined;
      if (launchMode === "resume") {
        const adapter = new PiResumeAdapter(tmux, fsOps, { stateRoot, runnerEntryPath: runner },
          { seatLaunchEnvironment, maxWaitMs: 4000, pollMs: 25, newLaunchId: () => "attempt" });
        const result = await adapter.resume(session, "pi_session_file", parent, cwd, model);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      } else {
        const adapter = new PiRuntimeAdapter({ tmux, fsOps, stateRoot, runnerEntryPath: runner, seatLaunchEnvironment,
          sleep: () => new Promise(resolve => setTimeout(resolve, 25)), newLaunchId: () => "attempt" });
        const result = await adapter.launchHarness({ tmuxSession: session, cwd, model, nodeId: "fixture-node", launchGeneration: "reserved-generation" } as never,
          { name: session, ...(launchMode === "fork" ? { forkSource: { kind: "native_id" as const, value: parent } } : {}) });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      }
      const received = JSON.parse(fs.readFileSync(path.join(stateRoot, session, "received.json"), "utf8"));
      if (routing && longTmp) {
        expect(send).toHaveBeenCalledTimes(2);
        expect(Buffer.byteLength(send.mock.calls[0]![1])).toBeGreaterThanOrEqual(1024);
        expect(await send.mock.results[0]!.value).toMatchObject({ ok: false, code: "launch_path_too_long" });
        expect(send.mock.calls[1]![1]).toBe(expected);
        // The supported bare fallback launches; routing correction is best-effort here.
        expect(received.route).toMatchObject({ body: { instance: "wrong-cli" }, home: "/wrong", node: "wrong" });
      } else if (routing) {
        expect(received.route).toMatchObject({ body: { instance: "intended", node: "fixture-node" },
          home: sessionEnv.OPENRIG_HOME, node: "fixture-node", runtime: "pi", HOME: temp,
          generation: launchMode === "resume" ? "existing-generation" : "reserved-generation",
          agentDir: piSeatPaths(stateRoot, session).agentDir,
          sessionsDir: piSeatPaths(stateRoot, session).sessionsDir, extraPresent: false });
        const [owned, ...rest] = received.route.PATH.split(":");
        expect(fs.readlinkSync(path.join(owned, "rig"))).toBe(cli);
        expect(rest.join(":")).toBe(path.join(temp, "user-bin") + ":" + sessionEnv.PATH);
      }
      expect(received.cwd).toBe(cwd);
      expect(received.args).toContain("--no-approve");
      expect(received.sessionFile).toBe(launchMode === "resume" ? parent : piSeatPaths(stateRoot, session).sessionsDir + "/child.jsonl");
      if (launchMode === "fork") expect(received.args[received.args.indexOf("--fork") + 1]).toBe(parent);
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
      if (routeServer?.listening) await new Promise<void>(resolve => routeServer.close(() => resolve()));
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 10_000);
});
