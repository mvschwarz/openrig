import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import { stubSeatSidecarPath } from "../src/adapters/stub-runner-protocol.js";
import { powershellQuote } from "../src/adapters/windows-launch.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { ProcessCensus } from "../src/domain/process-census.js";

async function until(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error(description);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// Real owned PowerShell/Node processes, offline runner and real sidecar. The
// tmux facade binds only this test's parent PID; no existing psmux server/seat.
describe.skipIf(process.platform !== "win32")("native runner readiness", () => {
  it.each(["pi", "omp", "stub"] as const)("%s needs its live runner, not a PowerShell label plus old sidecar", async runtime => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-readiness-"));
    const session = "offline@native-fixture", launchId = "owned-native-launch";
    const stateRoot = path.join(root, "state"), entry = path.join(root, "offline runner.mjs");
    const runnerStop = path.join(root, "runner-stop"), shellStop = path.join(root, "shell-stop");
    const sidecar = runtime !== "stub" ? piSeatPaths(stateRoot, session).runnerStatePath : stubSeatSidecarPath(root);
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    fs.writeFileSync(entry, `
      import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(sidecar)},JSON.stringify({ready:true,launchId:${JSON.stringify(launchId)},updatedAt:new Date().toISOString()}));
      const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(runnerStop)})){clearInterval(timer);process.exit(0);}},20);
    `);
    const args = [entry, "--session-name", session, ...(runtime !== "stub" ? ["--state-root", stateRoot] : []), "--cwd", root, "--launch-id", launchId,
      ...(runtime === "omp" ? ["--runtime", "omp"] : [])];
    const command = `& ${[process.execPath, ...args].map(powershellQuote).join(" ")}; [Console]::Out.WriteLine('FIXTURE_IDLE'); while(-not [IO.File]::Exists(${powershellQuote(shellStop)})){[Threading.Thread]::Sleep(20)}`;
    const child = spawn(path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "", closed = false;
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    const finished = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => { closed = true; resolve(); }); });
    const tmux = { hasSession: async () => true, getPaneCommand: async () => "powershell.exe", getPanePid: async () => child.pid!,
      capturePaneContent: async () => `[${runtime}-runner] READY` } as unknown as TmuxAdapter;
    const fsOps = { exists: fs.existsSync, readFile: (file: string) => fs.readFileSync(file, "utf8"),
      writeFile: (file: string, text: string) => fs.writeFileSync(file, text), mkdirp: (dir: string) => { fs.mkdirSync(dir, { recursive: true }); } };
    const census = new ProcessCensus(); // Production's shared, bounded 2-second success cache.
    const adapter = runtime === "pi" ? new PiRuntimeAdapter({ tmux, fsOps, stateRoot, runnerEntryPath: entry, listProcesses: () => census.list() })
      : runtime === "omp" ? new OmpRuntimeAdapter({ tmux, fsOps, stateRoot, runnerEntryPath: entry, listProcesses: () => census.list() })
        : new StubRuntimeAdapter({ tmux, fsOps, runnerEntryPath: entry, listProcesses: () => census.list() });
    const binding = { tmuxSession: session, tmuxPane: "%owned", cwd: root } as NodeBinding;
    try {
      await until(() => fs.existsSync(sidecar) || closed, "offline runner did not start");
      expect(closed, error).toBe(false);
      expect(await adapter.checkReady(binding)).toEqual({ ready: true });
      fs.writeFileSync(runnerStop, "stop");
      await until(() => output.includes("FIXTURE_IDLE") || closed, "owned runner did not return to PowerShell");
      expect(closed, error).toBe(false);
      expect(JSON.parse(fs.readFileSync(sidecar, "utf8")).ready).toBe(true);
      await until(async () => !(await adapter.checkReady(binding)).ready, "stale readiness survived the census window");
    } finally {
      fs.writeFileSync(runnerStop, "stop"); fs.writeFileSync(shellStop, "stop");
      await until(() => closed, "owned PowerShell did not stop; fixture retained");
      await finished;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
