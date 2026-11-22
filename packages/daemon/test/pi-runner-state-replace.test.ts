import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { piSeatPaths, type PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

// On these two paths, the launch-error exit record and the OMP sidecar write, the real runner entry
// replaces runner-state.json (temporary file + rename, mode 0600) instead of truncating it in place.
// The fixture pre-creates the record as 0644: an in-place write would keep that mode,
// whatever the umask. Keep a descriptor open to its original inode while checking the
// helper's rename; the runner can replace the sidecar multiple times, and an unlinked inode
// number can then be reused by the filesystem.
const RUNNER = nodePath.join(__dirname, "..", "src", "adapters", "pi-runner.ts");
const FAKE_OMP = String.raw`
const argv = process.argv.slice(2), sessionFile = argv[argv.indexOf("--session") + 1] || process.env.FAKE_SESSION;
process.stdout.write(JSON.stringify({ type: "ready" }) + "\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile, sessionId: "s" } }) + "\n");
}).on("close", () => process.exit(0));
`;

let root: string | null = null;
let priorRecordFd: number | null = null;
afterEach(() => {
  if (priorRecordFd !== null) {
    fs.closeSync(priorRecordFd);
    priorRecordFd = null;
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

function seatWithPriorRecord(withOmp: boolean): { bin: string; stateRoot: string; sidecar: string; seatDir: string; sessionFile: string; priorFd: number } {
  root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-runner-state-")));
  const bin = nodePath.join(root, "bin");
  fs.mkdirSync(bin);
  if (withOmp) {
    fs.writeFileSync(nodePath.join(root, "fake-omp.cjs"), FAKE_OMP);
    fs.writeFileSync(nodePath.join(bin, "omp"), `#!/bin/sh\nexec "${process.execPath}" "${nodePath.join(root, "fake-omp.cjs")}" "$@"\n`, { mode: 0o755 });
  }
  const stateRoot = nodePath.join(root, "state");
  const seat = piSeatPaths(stateRoot, "fixture");
  const seatDir = nodePath.dirname(seat.runnerStatePath);
  fs.mkdirSync(nodePath.join(seatDir, "sessions"), { recursive: true });
  const sessionFile = nodePath.join(seatDir, "sessions", "s.jsonl");
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "s" })}\n`);
  fs.writeFileSync(seat.runnerStatePath, JSON.stringify({ ready: false, updatedAt: "2026-11-17T00:00:00Z", lastEntryId: "e-1" }));
  fs.chmodSync(seat.runnerStatePath, 0o644);
  priorRecordFd = fs.openSync(seat.runnerStatePath, "r");
  return { bin, stateRoot, sidecar: seat.runnerStatePath, seatDir, sessionFile, priorFd: priorRecordFd };
}

function runOmpRunner(path: string, stateRoot: string, sessionFile: string) {
  const child = spawn(process.execPath, [
    "--import", "tsx", RUNNER, "--runtime", "omp", "--approval-mode", "always-ask", "--session-name", "fixture",
    "--state-root", stateRoot, "--cwd", root!, "--launch-id", "launch-1", "--session", sessionFile,
  ], { env: { PATH: path, HOME: root!, TMPDIR: os.tmpdir() }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  child.stdin.on("error", () => {});
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return { child, closed, output: () => output };
}

function expectReplacedByHelper(sidecar: string, seatDir: string, priorFd: number): void {
  const stat = fs.statSync(sidecar);
  expect(stat.mode & 0o777).toBe(0o600);
  // Keep the old inode open so repeated atomic writes cannot cause its number to be recycled.
  expect(stat.ino).not.toBe(fs.fstatSync(priorFd).ino);
  expect(fs.readdirSync(seatDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
}

describe.skipIf(process.platform === "win32")("runner-state.json is replaced, never written in place", () => {
  it("the launch-error exit record (the runtime executable does not resolve)", async () => {
    // Given a prior 0644 record and a PATH that is only an empty directory, so `omp` cannot resolve on any host.
    const { bin, stateRoot, sidecar, seatDir, sessionFile, priorFd } = seatWithPriorRecord(false);
    const run = runOmpRunner(bin, stateRoot, sessionFile);
    await run.closed;
    // Then the runner exits 127 and records it through the helper, keeping the durable cursor.
    expect(run.child.exitCode, run.output()).toBe(127);
    const state = JSON.parse(fs.readFileSync(sidecar, "utf8")) as PiRunnerState;
    expect(state).toMatchObject({ ready: false, launchId: "launch-1", lastEntryId: "e-1", exited: { code: 127 } });
    expectReplacedByHelper(sidecar, seatDir, priorFd);
  }, 20_000);

  it("the OMP sidecar record (writeSidecar)", async () => {
    // Given a prior 0644 record and an `omp` that answers ready and get_state.
    const { bin, stateRoot, sidecar, seatDir, sessionFile, priorFd } = seatWithPriorRecord(true);
    const run = runOmpRunner(`${bin}:/usr/bin:/bin`, stateRoot, sessionFile);
    try {
      // When the core reports the seat ready (the readiness wait, not a timing race).
      let state: PiRunnerState | null = null;
      for (const deadline = Date.now() + 15_000; Date.now() < deadline && !state?.ready;) {
        await new Promise((r) => setTimeout(r, 100));
        try { state = JSON.parse(fs.readFileSync(sidecar, "utf8")) as PiRunnerState; } catch { state = null; }
      }
      // Then the ready record went through the helper.
      expect(state?.ready, run.output()).toBe(true);
      expect(state?.launchId).toBe("launch-1");
      expectReplacedByHelper(sidecar, seatDir, priorFd);
    } finally {
      run.child.kill();
      await run.closed;
    }
  }, 20_000);
});
