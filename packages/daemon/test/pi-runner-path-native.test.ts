import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  piSeatPaths, buildPiChildArgs, PI_RUNNER_READY_MARKER, PI_RUNNER_ERROR_MARKER, PI_RUNNER_EXIT_MARKER,
} from "../src/adapters/pi-runner-protocol.js";

// Real runner and offline children: no installed provider, account or model call.
describe.skipIf(process.platform === "win32")("Pi native PATH semantics", () => {
  it.each(["argv0", "fallback", "mise", "relative", "empty", "stubborn-version"])(
    "preserves Pi lookup (%s)", async kind => {
      const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-path-")));
      const first = path.join(temp, "first"), second = path.join(temp, "second");
      fs.mkdirSync(first); fs.mkdirSync(second);
      const session = path.join(temp, "session.jsonl");
      fs.writeFileSync(session, "fixture\n");
      const good = path.join(second, "pi");
      fs.writeFileSync(good, `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line); if(c.type==='get_state') console.log(JSON.stringify({type:'response',id:c.id,success:true,
data:{sessionFile:${JSON.stringify(session)},sessionId:'offline'}}));});
`, { mode: 0o700 });
      const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
      if (kind === "argv0" || kind === "mise") {
        const shim = path.join(temp, kind === "mise" ? "mise" : "multiplexer");
        fs.writeFileSync(shim, `#!/bin/sh
${kind === "mise" ? `if [ "$1" = which ]; then printf '%s\\n' ${quote(good)}; exit 0; fi` : ""}
if [ "\${0##*/}" != pi ]; then
  # Consume the first request so an EPIPE cannot mask the dispatch failure.
  IFS= read -r request || :
  printf '%s\\n' 'SHIM_DISPATCH_NAME_MISMATCH' >&2
  exit 7
fi
[ "$PWD" = ${quote(temp)} ] || exit 8
exec ${quote(process.execPath)} ${quote(good)}
`, { mode: 0o700 });
        fs.symlinkSync(shim, path.join(first, "pi"));
      } else if (kind === "fallback") {
        fs.writeFileSync(path.join(first, "pi"), "#!/no/such/interpreter\n", { mode: 0o700 });
      } else if (kind === "stubborn-version") {
        fs.writeFileSync(path.join(first, "pi"), `#!${process.execPath}
if(process.argv.includes('--version')) { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
else { process.stdin.resume(); console.error('Error: Unknown options: --name, --no-approve'); setTimeout(()=>process.exit(1),100); }
`, { mode: 0o700 });
      } else if (kind === "relative") fs.copyFileSync(good, path.join(first, "pi"));
      else fs.copyFileSync(good, path.join(temp, "pi"));
      const stateRoot = path.join(temp, "state");
      const searchPath = kind === "relative" ? "first" : kind === "empty" ? ":" : [first, second].join(path.delimiter);
      const started = Date.now();
      const child = spawn(process.execPath, ["--import", "tsx",
        fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url)),
        "--session-name", "fixture", "--state-root", stateRoot, "--cwd", temp,
        "--launch-id", "path-attempt", "--no-approve"], {
        env: { OPENRIG_PI_ACCOUNT_HOME: "/ignored/ambient", PI_CODING_AGENT_DIR: "/ambient/must-not-be-used", PATH: searchPath, HOME: temp, OPENRIG_HOME: path.join(temp, "home") },
        detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "", ready = false, timedOut = false;
      const stop = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } };
      child.stdin.on("error", () => {});
      const take = (d: Buffer) => {
        output += d.toString();
        if (!ready && output.includes(PI_RUNNER_READY_MARKER)) { ready = true; stop(); }
      };
      child.stdout.on("data", take); child.stderr.on("data", take);
      const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
      const timer = setTimeout(() => { timedOut = true; stop(); }, 6500);
      try {
        await closed;
        const elapsedMs = Date.now() - started;
        const state = JSON.parse(fs.readFileSync(piSeatPaths(stateRoot, "fixture").runnerStatePath, "utf8"));
        console.log("PI_LOOKUP_PROBE " + JSON.stringify({ kind, elapsedMs, ready, timedOut, exit: child.exitCode, state }));
        expect(timedOut, output).toBe(false);
        if (kind === "stubborn-version") {
          expect(ready).toBe(false);
          expect(elapsedMs).toBeGreaterThanOrEqual(2900);
          expect(elapsedMs).toBeLessThan(6500);
          expect(child.exitCode, output).toBe(1);
          expect(state.exited.code).toBe(1);
          expect(output).toContain("unknown version");
        } else expect(ready, output).toBe(true);
      } finally {
        clearTimeout(timer); stop();
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }, 12000);

  it.each(["fresh", "resume", "fork", "mise"] as const)(
    "wraps resolved Pi child (%s) with pipe stdio, literal args, and host runner outside wrapper",
    async (mode) => {
      const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-wrap-child-")));
      const first = path.join(temp, "first"), second = path.join(temp, "second");
      fs.mkdirSync(first); fs.mkdirSync(second);
      const account = path.join(temp, "account"); fs.mkdirSync(account);
      fs.writeFileSync(path.join(account, "auth.json"), "synthetic-selected-account");
      const session = path.join(temp, "session.jsonl");
      fs.writeFileSync(session, "fixture\n");
      const piLogPath = path.join(temp, "pi-child-log.json");
      const wrapperLogPath = path.join(temp, "wrapper-log.json");
      const bareVersionMarker = path.join(temp, "bare-version-probed.marker");
      const good = path.join(second, "pi");
      fs.writeFileSync(good, `#!${process.execPath}
const fs = require("node:fs"), tty = require("node:tty");
if (process.argv.includes("--version")) {
  fs.writeFileSync(${JSON.stringify(bareVersionMarker)}, "unwrapped-version-ran");
  process.exit(99);
}
fs.writeFileSync(${JSON.stringify(piLogPath)}, JSON.stringify({
  piPid: process.pid,
  piPpid: process.ppid,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  tty: [0, 1, 2].map(fd => Boolean(tty.isatty(fd))),
  env: {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    sessionsDir: process.env.PI_CODING_AGENT_SESSION_DIR,
    nodeId: process.env.OPENRIG_NODE_ID,
  },
}));
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const c = JSON.parse(line);
  if (c.type === "get_state") {
    console.log(JSON.stringify({
      type: "response", id: c.id, success: true,
      data: { sessionFile: ${JSON.stringify(session)}, sessionId: "offline" },
    }));
  }
});
`, { mode: 0o700 });
      const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
      if (mode === "mise") {
        const shim = path.join(temp, "mise");
        fs.writeFileSync(shim, `#!/bin/sh
if [ "$1" = which ]; then printf '%s\\n' ${quote(good)}; exit 0; fi
exit 97
`, { mode: 0o700 });
        fs.symlinkSync(shim, path.join(first, "pi"));
      } else {
        fs.copyFileSync(good, path.join(first, "pi"));
      }

      const wrapperBin = path.join(temp, "real-wrapper");
      fs.writeFileSync(wrapperBin, `#!/bin/sh
WRAPPER_SH_PID="$$" WRAPPER_PPID="$PPID" ${quote(process.execPath)} -e '
  const fs = require("node:fs"), tty = require("node:tty");
  const argv = process.argv.slice(1);
  const sep = argv.indexOf("--");
  fs.writeFileSync(${JSON.stringify(wrapperLogPath)}, JSON.stringify({
    wrapperPid: Number(process.env.WRAPPER_SH_PID),
    wrapperPpid: Number(process.env.WRAPPER_PPID),
    wrapperArgs: argv.slice(0, sep),
    execArgv: argv.slice(sep + 1),
    auth: fs.readFileSync(require("node:path").join(process.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8"),
    cwd: process.cwd(),
    tty: [0, 1, 2].map(fd => Boolean(tty.isatty(fd))),
  }));
' -- "$@"
while [ "$#" -gt 0 ]; do
  arg="$1"; shift
  [ "$arg" = "--" ] && break
done
exec "$@"
`, { mode: 0o700 });

      const stateRoot = path.join(temp, "state");
      const seat = piSeatPaths(stateRoot, "fixture");
      const wrapperArgs = ["arg with spaces", "quote's", "$UNEXPANDED;false", "--leading-flag", ""];
      const runnerArgv = [
        "--import", "tsx",
        fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url)),
        "--session-name", "fixture",
        "--state-root", stateRoot,
        "--cwd", temp,
        "--launch-id", "wrap-attempt",
        "--no-approve",
        "--model", "zai/glm-5.2",
        "--thinking", "high",
        ...(mode === "resume" ? ["--session", session] : []),
        ...(mode === "fork" ? ["--fork", session] : []),
        "--launch-wrapper-arg", wrapperBin,
        ...wrapperArgs.flatMap((a) => ["--launch-wrapper-arg", a]),
        "--launch-wrapper-arg", "--",
      ];

      runnerArgv.push("--account-home", account);
      const child = spawn(process.execPath, runnerArgv, {
        env: { OPENRIG_PI_ACCOUNT_HOME: "/ignored/ambient", PI_CODING_AGENT_DIR: "/ambient/must-not-be-used", PATH: [first, second, "/usr/bin", "/bin"].join(path.delimiter), HOME: temp, OPENRIG_HOME: path.join(temp, "home"), OPENRIG_NODE_ID: "node-1" },
        detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "", ready = false, timedOut = false;
      const stop = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } };
      child.stdin.on("error", () => {});
      const take = (d: Buffer) => {
        output += d.toString();
        if (!ready && output.includes(PI_RUNNER_READY_MARKER)) { ready = true; stop(); }
      };
      child.stdout.on("data", take); child.stderr.on("data", take);
      const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
      const timer = setTimeout(() => { timedOut = true; stop(); }, 6500);
      try {
        await closed;
        expect(timedOut, output).toBe(false);
        expect(ready, output).toBe(true);
        expect(fs.existsSync(bareVersionMarker)).toBe(false);
        const state = JSON.parse(fs.readFileSync(seat.runnerStatePath, "utf8"));
        expect(state).toMatchObject({ ready: true, launchId: "wrap-attempt", sessionFile: session, sessionId: "offline" });

        const wrapperRec = JSON.parse(fs.readFileSync(wrapperLogPath, "utf8"));
        const piRec = JSON.parse(fs.readFileSync(piLogPath, "utf8"));
        expect(wrapperRec.auth).toBe("synthetic-selected-account");
        expect(fs.realpathSync(path.join(seat.agentDir, "auth.json"))).toBe(fs.realpathSync(path.join(account, "auth.json")));
        const expectedPiPath = mode === "mise" ? fs.realpathSync(good) : fs.realpathSync(path.join(first, "pi"));
        const expectedChildArgs = buildPiChildArgs({
          sessionsDir: seat.sessionsDir,
          sessionName: "fixture",
          trust: "no-approve",
          model: "zai/glm-5.2",
          thinking: "high",
          ...(mode === "resume" ? { sessionFile: session } : {}),
          ...(mode === "fork" ? { forkRef: session } : {}),
        });

        expect(wrapperRec.wrapperPpid).toBe(child.pid);
        expect(wrapperRec.wrapperPid).toBe(piRec.piPid);
        expect(piRec.piPpid).toBe(child.pid);
        expect(wrapperRec.wrapperArgs).toEqual(wrapperArgs);
        expect(wrapperRec.execArgv).toEqual([expectedPiPath, ...expectedChildArgs]);
        expect(piRec.argv).toEqual(expectedChildArgs);
        expect(wrapperRec.cwd).toBe(temp);
        expect(piRec.cwd).toBe(temp);
        expect(wrapperRec.tty).toEqual([false, false, false]);
        expect(piRec.tty).toEqual([false, false, false]);
        expect(piRec.env).toEqual({
          agentDir: seat.agentDir,
          sessionsDir: seat.sessionsDir,
          nodeId: "node-1",
        });
      } finally {
        clearTimeout(timer); stop();
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }, 12000,
  );

  it.each([
    "missing-wrapper",
    "wrapper-exit-7",
    "wrapper-non-exec-0",
    "wrapped-capability-no-bare-version",
  ] as const)("reports child wrapper failure (%s) via sidecar/markers without running bare Pi", async (kind) => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-wrap-neg-")));
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    const barePiMarker = path.join(temp, "bare-pi-ran.marker");
    const piBin = path.join(bin, "pi");
    if (kind === "wrapped-capability-no-bare-version") {
      fs.writeFileSync(piBin, `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  fs.writeFileSync(${JSON.stringify(barePiMarker)}, "bare-version-probed");
  console.log("9.9.9");
  process.exit(0);
}
console.error("Error: Unknown options: --name, --no-approve");
process.exit(1);
`, { mode: 0o700 });
    } else {
      fs.writeFileSync(piBin, `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(barePiMarker)}, "bare-pi-ran");
`, { mode: 0o700 });
    }

    const wrapperPath = path.join(temp, "wrapper");
    if (kind === "wrapper-exit-7") {
      fs.writeFileSync(wrapperPath, "#!/bin/sh\necho wrapper-boom >&2\nexit 7\n", { mode: 0o700 });
    } else if (kind === "wrapper-non-exec-0") {
      fs.writeFileSync(wrapperPath, "#!/bin/sh\necho wrapper-noop\nexit 0\n", { mode: 0o700 });
    } else if (kind === "wrapped-capability-no-bare-version") {
      fs.writeFileSync(wrapperPath, "#!/bin/sh\nshift\nexec \"$@\"\n", { mode: 0o700 });
    }

    const stateRoot = path.join(temp, "state");
    const seat = piSeatPaths(stateRoot, "fixture");
    const child = spawn(process.execPath, [
      "--import", "tsx",
      fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url)),
      "--session-name", "fixture", "--state-root", stateRoot, "--cwd", temp,
      "--launch-id", "neg-attempt", "--no-approve",
      "--launch-wrapper-arg", kind === "missing-wrapper" ? path.join(temp, "no-such-wrapper") : wrapperPath,
      "--launch-wrapper-arg", "--",
    ], {
      env: { PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter), HOME: temp, OPENRIG_HOME: path.join(temp, "home") },
      detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", timedOut = false;
    const stop = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } };
    child.stdin.on("error", () => {});
    child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { output += d.toString(); });
    const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
    const timer = setTimeout(() => { timedOut = true; stop(); }, 6500);
    try {
      await closed;
      expect(timedOut, output).toBe(false);
      expect(fs.existsSync(barePiMarker)).toBe(false);
      const state = JSON.parse(fs.readFileSync(seat.runnerStatePath, "utf8"));
      expect(state.ready).toBe(false);
      expect(state.launchId).toBe("neg-attempt");
      if (kind === "missing-wrapper") {
        expect(child.exitCode, output).toBe(127);
        expect(state.exited.code).toBe(127);
        expect(output).toContain(PI_RUNNER_ERROR_MARKER);
      } else if (kind === "wrapper-exit-7") {
        expect(child.exitCode, output).toBe(7);
        expect(state.exited.code).toBe(7);
        expect(output).toContain(PI_RUNNER_EXIT_MARKER);
      } else if (kind === "wrapper-non-exec-0") {
        expect(state.exited.code).toBe(0);
        expect(output).not.toContain(PI_RUNNER_READY_MARKER);
      } else {
        expect(child.exitCode, output).toBe(1);
        expect(state.exited.code).toBe(1);
        expect(output).toContain("unknown version");
      }
    } finally {
      clearTimeout(timer); stop();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 12000);

  it.each([
    ["relative-wrapper", ["--no-approve", "--launch-wrapper-arg", "relative-wrapper"]],
    ["empty-wrapper", ["--no-approve", "--launch-wrapper-arg", ""]],
    ["newline-in-arg", ["--no-approve", "--launch-wrapper-arg", "/bin/sh", "--launch-wrapper-arg", "bad\narg"]],
    ["nul-in-arg", ["--no-approve", "--launch-wrapper-arg", "/bin/sh", "--launch-wrapper-arg", "bad\0arg"]],
    ["dangling-flag", ["--no-approve", "--launch-wrapper-arg"]],
    ["omp-runtime", ["--runtime", "omp", "--approval-mode", "yolo", "--launch-wrapper-arg", "/bin/sh"]],
  ] as const)("exits 2 before state write or spawn on malformed wrapper argv (%s)", async (label, extraArgs) => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-wrap-bad-")));
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    const spawnedMarker = path.join(temp, "spawned.marker");
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(spawnedMarker)}, "ran");\n`, { mode: 0o700 });
    const stateRoot = path.join(temp, "state");
    const seat = piSeatPaths(stateRoot, "fixture");
    const runnerEntry = fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url));
    const baseRunnerArgs = [
      "--session-name", "fixture", "--state-root", stateRoot, "--cwd", temp,
      "--launch-id", "bad-attempt",
      ...extraArgs,
    ];
    // OS execve rejects NUL in argv before Node starts; invoke main(argv) inside the child for nul-in-arg.
    const spawnArgv = label === "nul-in-arg"
      ? [
          "--import", "tsx", "--input-type=module", "-e",
          `import { main } from ${JSON.stringify(new URL("../src/adapters/pi-runner.ts", import.meta.url).href)}; await main(${JSON.stringify(baseRunnerArgs)});`,
        ]
      : ["--import", "tsx", runnerEntry, ...baseRunnerArgs];
    const child = spawn(process.execPath, spawnArgv, {
      env: { PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter), HOME: temp, OPENRIG_HOME: path.join(temp, "home") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { output += d.toString(); });
    await new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
    try {
      expect(child.exitCode, output).toBe(2);
      expect(output).toContain(PI_RUNNER_ERROR_MARKER);
      expect(fs.existsSync(seat.runnerStatePath)).toBe(false);
      expect(fs.existsSync(spawnedMarker)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 12000);
});
