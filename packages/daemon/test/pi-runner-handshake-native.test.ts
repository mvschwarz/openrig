import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { piSeatPaths, PI_RUNNER_READY_MARKER, PI_RUNNER_ERROR_MARKER } from "../src/adapters/pi-runner-protocol.js";

// Real runner + real offline JSONL child, never a provider API or installed Pi.
describe.skipIf(process.platform === "win32")("Pi startup RPC handshake", () => {
  it.each(["missing", "old"])("reports the pane's actual %s executable failure", async kind => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-startup-"));
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    if (kind === "old") fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('0.73.1'); process.exit(0); }
if(process.argv.includes('--help')) { console.log('old Pi help'); process.exit(0); }
console.error('Error: Unknown options: --name, --no-approve'); process.exit(1);
`, { mode: 0o700 });
    const stateRoot = path.join(temp, "state");
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url)),
      "--session-name", "fixture", "--state-root", stateRoot, "--cwd", temp,
      "--launch-id", "owned-attempt", "--no-approve"], {
      env: { PATH: bin, HOME: temp, OPENRIG_HOME: path.join(temp, "home") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", d => { output += d.toString(); });
    child.stderr.on("data", d => { output += d.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    try {
      await new Promise<void>(resolve => child.once("close", () => resolve()));
      expect(child.signalCode, output).toBeNull();
      expect(child.exitCode, output).not.toBe(0);
      expect(output).not.toContain(PI_RUNNER_READY_MARKER);
      const state = JSON.parse(fs.readFileSync(piSeatPaths(stateRoot, "fixture").runnerStatePath, "utf8"));
      expect(state).toMatchObject({ ready: false, launchId: "owned-attempt" });
      if (kind === "old") {
        expect(output).toContain(`${bin}/pi (version 0.73.1)`);
        expect(output).toContain("@earendil-works/pi-coding-agent");
        expect(state.exited.code).toBe(1);
      } else {
        expect(output).toContain("not found on PATH");
        expect(state.exited.code).toBe(127);
      }
    } finally {
      clearTimeout(timer);
      child.kill("SIGTERM");
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 20000);

  it.each([false, true])("publishes ready only after successful get_state (success=%s)", async success => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-"));
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    const pidPath = path.join(temp, "child.pid");
    const sessionFile = path.join(temp, "session.jsonl");
    fs.writeFileSync(sessionFile, "fixture\n");
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nconst fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const cmd=JSON.parse(line); if(cmd.type==='get_state') console.log(JSON.stringify({type:'response',id:cmd.id,success:${success},
${success ? `data:{sessionFile:${JSON.stringify(sessionFile)},sessionId:'offline'}` : `error:'cannot load saved session'`}}));});\n`, { mode: 0o700 });
    const stateRoot = path.join(temp, "state");
    const runnerStatePath = piSeatPaths(stateRoot, "fixture").runnerStatePath;
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url)),
      "--session-name", "fixture", "--state-root", stateRoot, "--cwd", temp,
      "--launch-id", "owned-attempt", "--no-approve"], {
      env: { PATH: bin + path.delimiter + path.dirname(process.execPath), HOME: temp, OPENRIG_HOME: path.join(temp, "home") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", d => { output += d.toString(); });
    child.stderr.on("data", d => { output += d.toString(); });
    try {
      const deadline = Date.now() + 15000;
      while (!output.includes(PI_RUNNER_READY_MARKER) && !output.includes(PI_RUNNER_ERROR_MARKER) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(pidPath), output).toBe(true);
      const state = JSON.parse(fs.readFileSync(runnerStatePath, "utf8"));
      expect(state.ready, output).toBe(success);
      expect(state.launchId).toBe("owned-attempt");
      if (success) expect(state.sessionFile).toBe(sessionFile);
      else {
        expect(output).toContain("cannot load saved session");
        expect(output).not.toContain(PI_RUNNER_READY_MARKER);
      }
    } finally {
      if (fs.existsSync(pidPath)) {
        try { process.kill(Number(fs.readFileSync(pidPath, "utf8")), "SIGTERM"); } catch { /* child exited */ }
      }
      child.kill("SIGTERM");
      await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 20000);
});
