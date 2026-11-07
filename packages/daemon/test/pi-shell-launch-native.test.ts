import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFile, execFileSync, exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { buildPiRunnerCommand, buildPiChildArgs, piSeatPaths } from "../src/adapters/pi-runner-protocol.js";

const exec = promisify(execCallback);
const run = promisify(execFile);
let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch { /* optional native dependency */ }
const quote = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";

// The runner entry is deliberately offline: this exercises the real adapter,
// tmux, canonical macOS tty and shell, without starting Pi or touching provider settings.
describe.skipIf(!hasTmux || process.platform === "win32")("Pi launch through native tty", () => {
  it.each([...(process.platform === "linux" ? [{ mode: "fresh-linux-long", canonical: true }] : []), ...["fresh", "fork", "resume", "short-long-tmpdir", "fresh-long-tmpdir", "fork-long-tmpdir", "resume-long-tmpdir"].flatMap(mode => [
    { mode, canonical: true }, { mode, canonical: false },
  ]), ...["fresh-routing", "fork-routing", "resume-routing", "fork-routing-long-tmpdir", "resume-routing-long-tmpdir"].map(mode => ({ mode, canonical: false }))])("preserves $mode runner arguments (canonical reader: $canonical)", async ({ mode, canonical }) => {
    const launchMode = mode.split("-")[0];
    const longTmp = mode.endsWith("long-tmpdir");
    const routing = mode.includes("-routing");
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMUX_TMPDIR ?? (process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "pi-shell-")));
    const socket = path.join(temp, "tmux.sock");
    const session = "pi-fixture";
    const long = Array.from({ length: 14 }, () => "nested-directory-" + "x".repeat(35)).join(path.sep);
    const stateRoot = path.join(temp, longTmp ? "short" : long, "state");
    // Keep session tokens below 1024 characters; Linux's oversized command comes from cwd instead.
    const projectPath = mode === "fresh-linux-long"
      ? Array.from({ length: 64 }, () => "nested-directory-" + "x".repeat(35)).join(path.sep) : long;
    const cwd = path.join(temp, longTmp ? "short" : projectPath, "project with 'quotes'");
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
    // Long paths exceed the terminal bound without an unrealistic multi-kilobyte model argument.
    const model = mode === "short-long-tmpdir" ? undefined : "provider/model-" + "m".repeat(400);
    const expected = buildPiRunnerCommand({ runnerEntryPath: runner, sessionName: session,
      stateRoot, cwd, model, launchId: "attempt", trust: "no-approve",
      sessionFile: launchMode === "resume" ? parent : undefined,
      forkRef: launchMode === "fork" ? parent : undefined });
    if (mode === "short-long-tmpdir") expect(Buffer.byteLength(expected)).toBeLessThanOrEqual(512);
    else if (longTmp) {
      expect(Buffer.byteLength(expected)).toBeGreaterThan(512);
      expect(Buffer.byteLength(expected)).toBeLessThan(1024);
    } else expect(Buffer.byteLength(expected)).toBeGreaterThan(mode === "fresh-linux-long" ? 4096 : 2000);
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
          // The adapter polls 60 times for readiness; 100 ms each gives a loaded runner ~6 s, like the resume path's 4 s.
          sleep: () => new Promise(resolve => setTimeout(resolve, 100)), newLaunchId: () => "attempt" });
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

  it.each(["fresh", "fork", "resume", "staged-long", "long-tmpdir-retry"] as const)("executes launch_wrapper in native tmux for Pi %s with real host runner and wrapped Pi child over pipe stdio", async mode => {
    const launchMode = mode === "staged-long" || mode === "long-tmpdir-retry" ? "fresh" : mode;
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMUX_TMPDIR ?? (process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "pi-w-")));
    const socket = path.join(temp, "tmux.sock");
    const session = "pi-wrapped";
    const cwd = path.join(temp, "work dir with 'quotes'");
    const stateRoot = path.join(temp, "state");
    const daemonBin = path.join(temp, "daemon-bin");
    const userBin = path.join(temp, "user-bin");
    for (const d of [cwd, stateRoot, daemonBin, userBin]) fs.mkdirSync(d, { recursive: true });

    const wrapperRecordPath = path.join(temp, "wrapper-record.json");
    const runnerHostPath = path.join(temp, "runner-host.json");
    const bareVersionMarker = path.join(temp, "bare-version.marker");
    // Decoy wrapper and decoy pi in userBin prove daemon PATH resolution for wrapper and runner PATH resolution for pi.
    fs.writeFileSync(path.join(userBin, "generic-wrapper"), "#!/bin/sh\necho wrong-user-wrapper >&2\nexit 88\n", { mode: 0o700 });
    const wrapperBin = path.join(daemonBin, "generic-wrapper");
    fs.writeFileSync(wrapperBin, `#!/bin/sh
WRAPPER_SH_PID="$$" WRAPPER_PPID="$PPID" ${quote(process.execPath)} -e '
  const fs = require("node:fs"), tty = require("node:tty");
  const argv = process.argv.slice(1);
  const sep = argv.indexOf("--");
  fs.writeFileSync(${JSON.stringify(wrapperRecordPath)}, JSON.stringify({
    wrapperPid: Number(process.env.WRAPPER_SH_PID),
    helperPpid: Number(process.env.WRAPPER_PPID),
    wrapperArgs: argv.slice(0, sep),
    execArgv: argv.slice(sep + 1),
    cwd: process.cwd(),
    tty: [0, 1, 2].map(fd => Boolean(tty.isatty(fd))),
    env: {
      nodeId: process.env.OPENRIG_NODE_ID,
      sessionName: process.env.OPENRIG_SESSION_NAME,
      runtime: process.env.OPENRIG_RUNTIME,
      generation: process.env.OPENRIG_OCCUPANT_GENERATION,
      home: process.env.OPENRIG_HOME,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      sessionsDir: process.env.PI_CODING_AGENT_SESSION_DIR,
    },
  }));
' -- "$@"
while [ "$#" -gt 0 ]; do
  arg="$1"; shift
  [ "$arg" = "--" ] && break
done
exec "$@"
`, { mode: 0o700 });

    const cli = path.join(temp, "paired-cli");
    fs.writeFileSync(cli, `#!${process.execPath}\nconsole.log(JSON.stringify({cli:"paired",node:process.env.OPENRIG_NODE_ID,generation:process.env.OPENRIG_OCCUPANT_GENERATION,runtime:process.env.OPENRIG_RUNTIME,agentDir:process.env.PI_CODING_AGENT_DIR,sessionsDir:process.env.PI_CODING_AGENT_SESSION_DIR}));\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(userBin, "rig"), `#!${process.execPath}\nconsole.log(JSON.stringify({cli:"user-fallback",node:process.env.OPENRIG_NODE_ID}));\n`, { mode: 0o700 });

    const piBin = path.join(daemonBin, "pi");
    fs.writeFileSync(piBin, `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), tty = require("node:tty"), readline = require("node:readline");
if (process.argv.includes("--version")) {
  fs.writeFileSync(${JSON.stringify(bareVersionMarker)}, "bare-version-probed");
  process.exit(99);
}
const args = process.argv.slice(2);
const at = flag => args[args.indexOf(flag) + 1];
const sessionsDir = at("--session-dir");
const dir = path.dirname(sessionsDir);
fs.mkdirSync(sessionsDir, { recursive: true });
const sessionFile = args.includes("--session") ? at("--session") : path.join(sessionsDir, "child.jsonl");
const whoami = JSON.parse(require("node:child_process").execFileSync("rig", ["whoami"], { env: process.env, encoding: "utf8", timeout: 3000 }));
fs.writeFileSync(path.join(dir, "received.json"), JSON.stringify({
  piPid: process.pid,
  piPpid: process.ppid,
  cwd: process.cwd(),
  sessionFile,
  args,
  tty: [0, 1, 2].map(fd => Boolean(tty.isatty(fd))),
  whoami,
}));
readline.createInterface({ input: process.stdin }).on("line", line => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") {
    console.log(JSON.stringify({
      type: "response", id: cmd.id, success: true,
      data: { sessionFile, sessionId: "offline" },
    }));
  }
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });

    const tsxEsmUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    const realRunnerUrl = new URL("../src/adapters/pi-runner.ts", import.meta.url).href;
    const runner = path.join(temp, "real-runner-entry.mjs");
    fs.writeFileSync(runner, `import fs from "node:fs";
import tty from "node:tty";
await import(${JSON.stringify(tsxEsmUrl)});
fs.writeFileSync(${JSON.stringify(runnerHostPath)}, JSON.stringify({
  runnerPid: process.pid,
  tty: [0, 1, 2].map(fd => Boolean(tty.isatty(fd))),
  argv: process.argv.slice(2),
}));
const { main } = await import(${JSON.stringify(realRunnerUrl)});
await main();
`);

    const parent = path.join(stateRoot, session, "sessions", "parent.jsonl");
    fs.mkdirSync(path.dirname(parent), { recursive: true });
    fs.writeFileSync(parent, "fixture\n");

    const sessionEnv = {
      PATH: `${daemonBin}:${process.env.PATH ?? ""}`,
      OPENRIG_HOME: path.join(temp, "instance"),
      OPENRIG_URL: "http://127.0.0.1:7433",
      OPENRIG_NODE_ID: "fixture-node",
      OPENRIG_SESSION_NAME: session,
      OPENRIG_RUNTIME: "pi",
      OPENRIG_OCCUPANT_GENERATION: "existing-generation",
    };
    const rc = path.join(temp, "pane.rc");
    fs.writeFileSync(rc, `export PATH=${quote(userBin + ":" + sessionEnv.PATH)}\nprintf ready > ${quote(path.join(temp, "rc-ready"))}\n`);

    const fsOps = {
      readFile: (p: string) => fs.readFileSync(p, "utf8"),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
      exists: fs.existsSync,
      mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
    };
    const wrapper = ["generic-wrapper", "arg with spaces", "quote's", "$UNEXPANDED;false", "", "--"];
    const model =
      mode === "staged-long" ? "provider/model-" + "m".repeat(1200)
      : mode === "long-tmpdir-retry" ? "provider/model-" + "m".repeat(100)
      : "provider/model-short";

    try {
      await run("tmux", [
        "-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", session,
        ...Object.entries(sessionEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        `/bin/bash --noprofile --rcfile ${quote(rc)} -i`,
      ]);
      for (let i = 0; i < 100 && !fs.existsSync(path.join(temp, "rc-ready")); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      let fileOps: TmuxFileOps | undefined;
      if (mode === "long-tmpdir-retry") {
        const longTmpdir = path.join(temp, ...Array.from({ length: 9 }, () => "t".repeat(60)));
        fs.mkdirSync(longTmpdir, { recursive: true });
        let n = 0;
        fileOps = {
          tmpName: () => path.join(longTmpdir, `launch-${n++}.tmp`),
          bufferName: () => `buf-${n++}`,
          writeFile: (p, text, options) => fs.promises.writeFile(p, text, options),
          unlink: p => fs.promises.unlink(p),
        };
      }
      const tmux = new TmuxAdapter(async command => (await exec(command.replace(/^tmux /, `tmux -S ${quote(socket)} `), { cwd })).stdout, fileOps);
      const send = vi.spyOn(tmux, "sendShellCommand");
      const seatLaunchEnvironment = new SeatLaunchEnvironment(tmux, sessionEnv, cwd, cli);

      if (launchMode === "resume") {
        const adapter = new PiResumeAdapter(tmux, fsOps, { stateRoot, runnerEntryPath: runner }, {
          seatLaunchEnvironment, maxWaitMs: 6000, pollMs: 25, newLaunchId: () => "attempt",
        });
        const result = await adapter.resume(session, "pi_session_file", parent, cwd, model, "floor", "high", wrapper);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      } else {
        const adapter = new PiRuntimeAdapter({
          tmux, fsOps, stateRoot, runnerEntryPath: runner, seatLaunchEnvironment,
          // Match the resume fixture's six-second readiness allowance for wrapper and child startup.
          sleep: () => new Promise(resolve => setTimeout(resolve, 100)), newLaunchId: () => "attempt",
        });
        const result = await adapter.launchHarness(
          { tmuxSession: session, cwd, model, effort: "high", nodeId: "fixture-node", launchGeneration: "reserved-generation", launchWrapper: wrapper } as never,
          { name: session, ...(launchMode === "fork" ? { forkSource: { kind: "native_id" as const, value: parent } } : {}) },
        );
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      }

      expect(fs.existsSync(bareVersionMarker)).toBe(false);
      const runnerHost = JSON.parse(fs.readFileSync(runnerHostPath, "utf8"));
      const wrapperRec = JSON.parse(fs.readFileSync(wrapperRecordPath, "utf8"));
      const received = JSON.parse(fs.readFileSync(path.join(stateRoot, session, "received.json"), "utf8"));
      const seat = piSeatPaths(stateRoot, session);
      const expectedChildArgs = buildPiChildArgs({
        sessionsDir: seat.sessionsDir,
        sessionName: session,
        model,
        thinking: "high",
        trust: "no-approve",
        ...(launchMode === "resume" ? { sessionFile: parent } : {}),
        ...(launchMode === "fork" ? { forkRef: parent } : {}),
      });

      if (mode === "long-tmpdir-retry") {
        expect(send).toHaveBeenCalledTimes(2);
        expect(await send.mock.results[0]!.value).toMatchObject({ ok: false, code: "launch_path_too_long" });
        expect(send.mock.calls[1]![1]).toMatch(/^node '/);
        expect(send.mock.calls[0]![1]).toContain(`--launch-wrapper-arg ${quote(wrapperBin)}`);
        expect(send.mock.calls[1]![1]).toContain(`--launch-wrapper-arg ${quote(wrapperBin)}`);
      }

      // Host runner runs in the tmux pane TTY; wrapper is spawned by the runner over pipes and execs resolved Pi.
      expect(runnerHost.tty).toEqual([true, true, true]);
      expect(wrapperRec.helperPpid).toBe(runnerHost.runnerPid);
      expect(wrapperRec.wrapperPid).toBe(received.piPid);
      expect(received.piPpid).toBe(runnerHost.runnerPid);
      expect(wrapperRec.wrapperArgs).toEqual(["arg with spaces", "quote's", "$UNEXPANDED;false", ""]);
      expect(wrapperRec.execArgv).toEqual([fs.realpathSync(piBin), ...expectedChildArgs]);
      expect(received.args).toEqual(expectedChildArgs);
      expect(wrapperRec.tty).toEqual([false, false, false]);
      expect(received.tty).toEqual([false, false, false]);
      expect(wrapperRec.cwd).toBe(cwd);
      expect(received.cwd).toBe(cwd);
      if (mode !== "long-tmpdir-retry") {
        expect(received.whoami).toEqual({
          cli: "paired",
          node: "fixture-node",
          generation: launchMode === "resume" ? "existing-generation" : "reserved-generation",
          runtime: "pi",
          agentDir: seat.agentDir,
          sessionsDir: seat.sessionsDir,
        });
      }

      const readiness = new PiRuntimeAdapter({ tmux, fsOps, stateRoot, runnerEntryPath: runner });
      const binding = { tmuxSession: session, cwd } as never;
      expect(await readiness.checkReady(binding)).toEqual({ ready: true });

      process.kill(received.piPid, "SIGTERM");
      for (let i = 0; i < 100 && (await tmux.getPaneCommand(session)) === "node"; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(await readiness.checkReady(binding)).toMatchObject({ ready: false, code: "runner_exited" });
    } finally {
      await run("tmux", ["-S", socket, "kill-server"]).catch(() => {});
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 15_000);

  it.each(["missing-wrapper", "failing-wrapper-exit-7", "non-exec-zero-exit", "long-tmpdir-too-long"] as const)("fails closed in native tmux on %s without starting bare Pi", async failure => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMUX_TMPDIR ?? (process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "pi-f-")));
    const socket = path.join(temp, "tmux.sock");
    const session = "pi-fail";
    const cwd = path.join(temp, "work");
    const stateRoot = path.join(temp, "state");
    const daemonBin = path.join(temp, "daemon-bin");
    for (const d of [cwd, stateRoot, daemonBin]) fs.mkdirSync(d, { recursive: true });

    // The runner keeps the child's stderr, so each wrapper leaves its own marker: a 127 then names its cause.
    const wrapperRanPath = path.join(temp, "wrapper-ran.marker");
    fs.writeFileSync(path.join(daemonBin, "fail-wrapper"), `#!/bin/sh\nprintf wrapper-failed-7 > ${quote(wrapperRanPath)}\necho wrapper-failed-7 >&2\nexit 7\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(daemonBin, "zero-wrapper"), `#!/bin/sh\nprintf wrapper-exited-0-without-exec > ${quote(wrapperRanPath)}\necho wrapper-exited-0-without-exec\nexit 0\n`, { mode: 0o700 });
    const okWrapper = path.join(daemonBin, "ok-wrapper");
    fs.writeFileSync(okWrapper, "#!/bin/sh\nshift\nexec \"$@\"\n", { mode: 0o700 });

    const barePiRanPath = path.join(stateRoot, session, "received.json");
    fs.writeFileSync(path.join(daemonBin, "pi"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
fs.mkdirSync(${JSON.stringify(path.dirname(barePiRanPath))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(barePiRanPath)}, "bare-pi-should-never-start");
`, { mode: 0o700 });

    const cli = path.join(temp, "paired-cli");
    fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const tsxEsmUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    const realRunnerUrl = new URL("../src/adapters/pi-runner.ts", import.meta.url).href;
    const runner = path.join(temp, "real-runner-entry.mjs");
    fs.writeFileSync(runner, `await import(${JSON.stringify(tsxEsmUrl)});
const { main } = await import(${JSON.stringify(realRunnerUrl)});
await main();
`);

    const sessionEnv = {
      PATH: `${daemonBin}:${process.env.PATH ?? ""}`,
      OPENRIG_HOME: path.join(temp, "instance"),
      OPENRIG_URL: "http://127.0.0.1:7433",
      OPENRIG_NODE_ID: "fixture-node",
      OPENRIG_SESSION_NAME: session,
      OPENRIG_RUNTIME: "pi",
      OPENRIG_OCCUPANT_GENERATION: "gen-1",
    };
    const rc = path.join(temp, "pane.rc");
    fs.writeFileSync(rc, `export PATH=${quote(sessionEnv.PATH)}\nprintf ready > ${quote(path.join(temp, "rc-ready"))}\n`);
    const fsOps = {
      readFile: (p: string) => fs.readFileSync(p, "utf8"),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
      exists: fs.existsSync,
      mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
    };

    try {
      await run("tmux", [
        "-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", session,
        ...Object.entries(sessionEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        `/bin/bash --noprofile --rcfile ${quote(rc)} -i`,
      ]);
      for (let i = 0; i < 100 && !fs.existsSync(path.join(temp, "rc-ready")); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(path.join(temp, "rc-ready"))).toBe(true);

      let fileOps: TmuxFileOps | undefined;
      if (failure === "long-tmpdir-too-long") {
        const longTmpdir = path.join(temp, ...Array.from({ length: 9 }, () => "t".repeat(60)));
        fs.mkdirSync(longTmpdir, { recursive: true });
        let n = 0;
        fileOps = {
          tmpName: () => path.join(longTmpdir, `launch-${n++}.tmp`),
          bufferName: () => `buf-${n++}`,
          writeFile: (p, text, options) => fs.promises.writeFile(p, text, options),
          unlink: p => fs.promises.unlink(p),
        };
      }
      const tmux = new TmuxAdapter(async command => (await exec(command.replace(/^tmux /, `tmux -S ${quote(socket)} `))).stdout, fileOps);
      const send = vi.spyOn(tmux, "sendShellCommand");
      const seatLaunchEnvironment = new SeatLaunchEnvironment(tmux, sessionEnv, cwd, cli);

      const wrapper =
        failure === "missing-wrapper" ? ["no-such-wrapper", "--"]
        : failure === "failing-wrapper-exit-7" ? ["fail-wrapper", "--"]
        : failure === "non-exec-zero-exit" ? ["zero-wrapper", "--"]
        : ["ok-wrapper", "--"];
      const model = failure === "long-tmpdir-too-long" ? "provider/model-" + "m".repeat(950) : "provider/short";

      const adapter = new PiRuntimeAdapter({
        tmux, fsOps, stateRoot, runnerEntryPath: runner, seatLaunchEnvironment,
        sleep: () => new Promise(r => setTimeout(r, 25)),
        newLaunchId: () => "attempt",
      });
      const result = await adapter.launchHarness(
        { tmuxSession: session, cwd, model, nodeId: "fixture-node", launchGeneration: "gen-1", launchWrapper: wrapper } as never,
        { name: session },
      );
      expect(result.ok).toBe(false);
      expect(fs.existsSync(barePiRanPath)).toBe(false);
      if (failure === "missing-wrapper") {
        expect(result.error).toBe("launch_wrapper unavailable; no agent started.");
        expect(send).not.toHaveBeenCalled();
        expect(fs.existsSync(piSeatPaths(stateRoot, session).runnerStatePath)).toBe(false);
      } else if (failure === "long-tmpdir-too-long") {
        expect(send).toHaveBeenCalledTimes(2);
        const expectedWrapperFlags = `--launch-wrapper-arg ${quote(okWrapper)} --launch-wrapper-arg '--'`;
        expect(send.mock.calls[0]![1]).toContain(expectedWrapperFlags);
        expect(send.mock.calls[1]![1]).toContain(expectedWrapperFlags);
      } else {
        const state = JSON.parse(fs.readFileSync(piSeatPaths(stateRoot, session).runnerStatePath, "utf8"));
        expect(state.ready).toBe(false);
        // The pane holds the runner's error line when the wrapper never ran.
        const pane = await tmux.capturePaneContent(session, 200);
        const marker = failure === "failing-wrapper-exit-7" ? "wrapper-failed-7" : "wrapper-exited-0-without-exec";
        expect(fs.existsSync(wrapperRanPath) ? fs.readFileSync(wrapperRanPath, "utf8") : `wrapper never ran; pane:\n${pane}`).toBe(marker);
        expect(state.exited.code, `pane:\n${pane}`).toBe(failure === "failing-wrapper-exit-7" ? 7 : 0);
      }
      expect((await adapter.checkReady({ tmuxSession: session, cwd } as never)).ready).toBe(false);
    } finally {
      await run("tmux", ["-S", socket, "kill-server"]).catch(() => {});
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 15_000);

  it.each(["fresh", "fork", "resume"] as const)("executes launch_wrapper in native tmux for Codex %s with resolved interpreter+entry, intact pid, cwd, tty, env and exit code", async mode => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMUX_TMPDIR ?? (process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "cx-w-")));
    const socket = path.join(temp, "tmux.sock");
    const session = "codex-wrapped";
    const cwd = path.join(temp, "codex work 'quotes'");
    const daemonBin = path.join(temp, "daemon-bin");
    const userBin = path.join(temp, "user-bin");
    for (const d of [cwd, daemonBin, userBin]) fs.mkdirSync(d, { recursive: true });

    const wrapperRecordPath = path.join(temp, "codex-wrapper-record.json");
    const codexRecordPath = path.join(temp, "codex-record.json");
    const codexExitFile = path.join(temp, "codex-exit.json");

    fs.writeFileSync(path.join(userBin, "generic-wrapper"), "#!/bin/sh\nexit 91\n", { mode: 0o700 });
    fs.writeFileSync(path.join(userBin, "codex"), "#!/bin/sh\nexit 92\n", { mode: 0o700 });
    fs.symlinkSync(process.execPath, path.join(daemonBin, "node"));

    fs.writeFileSync(path.join(daemonBin, "generic-wrapper"), `#!/bin/sh
WRAPPER_SH_PID="$$" node -e '
  const fs = require("node:fs"), tty = require("node:tty");
  const argv = process.argv.slice(1);
  const sep = argv.indexOf("--");
  fs.writeFileSync(${JSON.stringify(wrapperRecordPath)}, JSON.stringify({
    wrapperPid: Number(process.env.WRAPPER_SH_PID),
    wrapperArgs: argv.slice(0, sep),
    execArgv: argv.slice(sep + 1),
    cwd: process.cwd(),
    tty: [0, 1, 2].map(fd => tty.isatty(fd)),
    nodeId: process.env.OPENRIG_NODE_ID,
    sessionName: process.env.OPENRIG_SESSION_NAME,
    runtime: process.env.OPENRIG_RUNTIME,
    generation: process.env.OPENRIG_OCCUPANT_GENERATION,
  }));
' -- "$@"
while [ "$#" -gt 0 ]; do
  arg="$1"; shift
  [ "$arg" = "--" ] && break
done
exec "$@"
`, { mode: 0o700 });

    const codexBin = path.join(daemonBin, "codex");
    fs.writeFileSync(codexBin, `#!/usr/bin/env node
const fs = require("node:fs"), tty = require("node:tty");
if (process.argv.includes("--help")) {
  console.log("Usage: codex\\n  --no-daemon");
  process.exit(0);
}
function writeJsonAtomic(targetPath, data) {
  const tmp = \`\${targetPath}.tmp.\${process.pid}.\${Date.now()}\`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, targetPath);
}
process.on("SIGUSR2", () => {
  writeJsonAtomic(${JSON.stringify(codexExitFile)}, { code: 13, pid: process.pid });
  process.exit(13);
});
writeJsonAtomic(${JSON.stringify(codexRecordPath)}, {
  codexPid: process.pid,
  signalHandlerReady: true,
  nodeExecPath: process.execPath,
  scriptPath: process.argv[1],
  args: process.argv.slice(2),
  cwd: process.cwd(),
  tty: [0, 1, 2].map(fd => tty.isatty(fd)),
  nodeId: process.env.OPENRIG_NODE_ID,
  sessionName: process.env.OPENRIG_SESSION_NAME,
  runtime: process.env.OPENRIG_RUNTIME,
  generation: process.env.OPENRIG_OCCUPANT_GENERATION,
});
console.log("OpenAI Codex (v0.0.0)\\n› Ask Codex to do anything");
setInterval(() => {}, 1000);
`, { mode: 0o700 });

    const cli = path.join(temp, "paired-cli");
    fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    const sessionEnv = {
      PATH: `${daemonBin}:${process.env.PATH ?? ""}`,
      OPENRIG_HOME: path.join(temp, "instance"),
      OPENRIG_URL: "http://127.0.0.1:7433",
      OPENRIG_NODE_ID: "codex-node",
      OPENRIG_SESSION_NAME: session,
      OPENRIG_RUNTIME: "codex",
      OPENRIG_OCCUPANT_GENERATION: "codex-gen-1",
    };

    try {
      await run("tmux", [
        "-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "-c", cwd,
        ...Object.entries(sessionEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        "/bin/bash --noprofile --norc -i",
      ]);
      await new Promise(resolve => setTimeout(resolve, 100));
      const tmux = new TmuxAdapter(async command => (await exec(command.replace(/^tmux /, `tmux -S ${quote(socket)} `), { cwd })).stdout);
      const seatLaunchEnvironment = new SeatLaunchEnvironment(tmux, sessionEnv, cwd, cli);
      const wrapper = ["generic-wrapper", "literal $ARG", "--"];

      if (mode === "resume") {
        const adapter = new CodexResumeAdapter(tmux, {
          seatLaunchEnvironment, launchPath: sessionEnv.PATH, maxWaitMs: 4000, pollMs: 25,
          detectDaemonSupport: async () => ({ kind: "supported" }),
        });
        const res = await adapter.resume(session, "codex_id", "thread-123", cwd, undefined, "floor", "gpt-5", "high", false, false, false, undefined, undefined, undefined, wrapper);
        expect(res).toMatchObject({ ok: true });
      } else {
        const adapter = new CodexRuntimeAdapter({
          tmux, seatLaunchEnvironment, launchPath: sessionEnv.PATH,
          detectDaemonSupport: async () => ({ kind: "supported" }),
          resolveGitAddDirs: async () => [],
          listProcesses: () => [],
          sleep: () => new Promise(resolve => setTimeout(resolve, 25)),
          fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, homedir: temp },
        });
        vi.spyOn(adapter as any, "dismissSkippableCodexUpdatePrompt").mockResolvedValue(undefined);
        vi.spyOn(adapter as any, "captureFreshThreadId").mockResolvedValue("fresh-id");
        vi.spyOn(adapter as any, "captureVerifiedForkId").mockResolvedValue("fork-id");
        const res = await adapter.launchHarness(
          { id: "b", nodeId: "codex-node", tmuxSession: session, tmuxPane: "%1", tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd, launchGeneration: "codex-gen-2", launchWrapper: wrapper },
          { name: session, ...(mode === "fork" ? { forkSource: { kind: "native_id", value: "parent-id" } } : {}) },
        );
        expect(res).toMatchObject({ ok: true });
      }

      // The wrapper and its Node child can take more than two seconds to start under suite load.
      await vi.waitFor(() => expect(fs.existsSync(codexRecordPath)).toBe(true), { timeout: 10_000, interval: 25 });
      const wrapperRec = JSON.parse(fs.readFileSync(wrapperRecordPath, "utf8"));
      const codexRec = JSON.parse(fs.readFileSync(codexRecordPath, "utf8"));
      expect(wrapperRec.wrapperPid).toBe(codexRec.codexPid);
      expect(wrapperRec.wrapperArgs).toEqual(["literal $ARG"]);
      expect(wrapperRec.execArgv[0]).toBe(path.join(daemonBin, "node"));
      expect(wrapperRec.execArgv[1]).toBe(codexBin);
      expect(wrapperRec.cwd).toBe(cwd);
      expect(codexRec.cwd).toBe(cwd);
      expect(wrapperRec.tty).toEqual([true, true, true]);
      expect(codexRec.tty).toEqual([true, true, true]);
      expect(codexRec.nodeId).toBe("codex-node");
      expect(codexRec.sessionName).toBe(session);
      expect(codexRec.runtime).toBe("codex");
      expect(codexRec.generation).toBe(mode === "resume" ? "codex-gen-1" : "codex-gen-2");

      process.kill(codexRec.codexPid, "SIGUSR2");
      await vi.waitFor(() => expect(fs.existsSync(codexExitFile)).toBe(true), { timeout: 10_000, interval: 25 });
      expect(codexRec.signalHandlerReady).toBe(true);
      expect(JSON.parse(fs.readFileSync(codexExitFile, "utf8"))).toEqual({ code: 13, pid: codexRec.codexPid });
    } finally {
      await run("tmux", ["-S", socket, "kill-server"]).catch(() => {});
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 30_000);
});
