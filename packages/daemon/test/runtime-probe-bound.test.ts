// A hung runtime `--version` / `--help` probe must not hold up its caller (daemon startup awaits the Codex probe
// before it listens): boundedProbeExec ends the probe's process group after its bound, and RuntimeVerifier runs
// its version/help probes through it when given one. Fake binaries only; nothing real is started.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { boundedProbeExec, ProbeTimeoutError, RUNTIME_PROBE_TIMEOUT_MS } from "../src/adapters/bounded-probe-exec.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RuntimeVerifier, probeTimeoutOutcome } from "../src/domain/runtime-verifier.js";

// A fake runtime: logs each start's pid and process group, then per mode for --version and --help.
// "hang" ignores stdin, HUP and TERM and leaves a child in its group that ignores them too.
type Mode = "ok" | "fail" | "hang";
function fakeRuntime(name: string, version: Mode, help: Mode): { dir: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-probe-bound-"));
  const log = path.join(dir, "starts.log");
  fs.writeFileSync(path.join(dir, name), `#!${process.execPath}
const fs = require("node:fs");
const { spawn, execFileSync } = require("node:child_process");
const arg = process.argv[2];
const mode = arg === "--version" ? ${JSON.stringify(version)} : arg === "--help" ? ${JSON.stringify(help)} : "fail";
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)]).toString().trim());
if (mode === "hang") {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
  const ready = ${JSON.stringify(dir)} + "/ready-" + process.pid;
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});require('node:fs').writeFileSync(process.argv[1],'');setInterval(()=>{},1000)", ready], { stdio: "ignore" });
  child.unref();
  const until = Date.now() + 5000;
  while (!fs.existsSync(ready) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ arg, pids: [process.pid, child.pid], pgid }) + "\\n");
  setInterval(() => {}, 1000);
} else {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ arg, pids: [process.pid], pgid }) + "\\n");
  if (mode === "ok") { process.stdout.write(arg === "--version" ? "${name} 1.2.3\\n" : "Usage: ${name}\\n"); process.exit(0); }
  process.exit(1);
}
`, { mode: 0o755 });
  return { dir, log };
}
const starts = (log: string): Array<{ arg: string; pids: number[]; pgid: number }> =>
  fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// A killed process keeps its pid until it is reaped (orphans by init, or launchd on macOS): every recorded pid and
// group must be gone within REAP_BOUND_MS; anything left is named with its ps state.
const REAP_BOUND_MS = 2_000;
const exists = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const psRows = () => execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="]).toString().trim().split("\n")
  .map((l) => l.trim().split(/\s+/)).map(([pid, pgid, stat]) => ({ pid: Number(pid), pgid: Number(pgid), stat: stat ?? "" }));
async function leftAfterReapBound(s: { pids: number[]; pgid: number }) {
  const until = Date.now() + REAP_BOUND_MS;
  while (Date.now() < until && (s.pids.some(exists) || psRows().some((r) => r.pgid === s.pgid))) await new Promise((r) => setTimeout(r, 50));
  return psRows().filter((r) => s.pids.includes(r.pid) || r.pgid === s.pgid);
}

describe("boundedProbeExec", () => {
  it("answers with stdout on exit 0, and rejects a failing command as before (not as a timeout)", async () => {
    const exec = boundedProbeExec(5_000, 500);
    expect(await exec("printf 'codex-cli 0.200.0\\n'")).toBe("codex-cli 0.200.0\n");
    const failed = await exec("printf oops >&2; exit 3").catch((e) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(ProbeTimeoutError);
    expect(String(failed.message)).toContain("exit 3");
    expect(String(failed.message)).toContain("oops");
  });

  it("closes stdin: a probe that waits for input reads EOF instead of hanging", async () => {
    expect(await boundedProbeExec(5_000, 500)(`${JSON.stringify(process.execPath)} -e "process.stdin.resume();process.stdin.on('end',()=>{console.log('eof');})"`)).toBe("eof\n");
  });

  it("a hung probe rejects within its bound and its whole process group is ended, even when it ignores TERM", async () => {
    const fake = fakeRuntime("hangy", "hang", "ok");
    const started = performance.now();
    const err = await boundedProbeExec(800, 300)(`${path.join(fake.dir, "hangy")} --version`).catch((e) => e);
    const ms = performance.now() - started;
    expect(err).toBeInstanceOf(ProbeTimeoutError);
    expect(err.message).toBe(`${path.join(fake.dir, "hangy")} --version did not answer within 1 s; the probe was ended`);
    // The bound, plus stopGroup's steps (a moment, TERM, KILL, reap wait; 300 ms each at most).
    expect(ms).toBeLessThan(800 + 4 * 300 + 1_000);
    const [s] = starts(fake.log);
    expect(s!.pids).toHaveLength(2);
    expect(await leftAfterReapBound(s!), `pids ${s!.pids.join(",")} group ${s!.pgid}`).toEqual([]);
  });
});

describe("boundedProbeExec where a process group can't be signalled, and with a descendant holding the output", () => {
  it("Windows-like: the group stop reaches nothing, so the probe process itself is killed", async () => {
    const fake = fakeRuntime("hangy", "hang", "ok");
    // A group stop that kills nothing, as on Windows where kill(-pid) throws and stopGroup gives up.
    const noGroupKill = async () => {};
    const started = performance.now();
    // exec, so the probe process is the fake itself, not a shell around it.
    const err = await boundedProbeExec(800, 300, { stopGroup: noGroupKill })(`exec ${path.join(fake.dir, "hangy")} --version`).catch((e) => e);
    expect(err).toBeInstanceOf(ProbeTimeoutError);
    expect(performance.now() - started).toBeLessThan(800 + 300 + 1_000);
    const [s] = starts(fake.log);
    const [probePid, childPid] = s!.pids;
    // The probe itself is gone (killed, and reaped by the runner's bounded wait); its descendant survives, as on Windows.
    expect(exists(probePid!), `probe ${probePid}`).toBe(false);
    expect(exists(childPid!), `descendant ${childPid}`).toBe(true);
    process.kill(-s!.pgid, "SIGKILL");
    expect(await leftAfterReapBound(s!)).toEqual([]);
  });

  it("a probe that prints and exits 0 while a descendant keeps its output open answers at once; the descendant is ended", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-probe-bound-holder-"));
    const log = path.join(dir, "pids");
    const script = path.join(dir, "holder");
    // Prints its version, leaves a child (same group, inheriting stdout) that ignores TERM, and exits 0.
    fs.writeFileSync(script, `#!${process.execPath}
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "inherit"] });
require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, child: child.pid }));
process.stdout.write("holder 4.5.6\\n", () => process.exit(0));
`, { mode: 0o755 });
    const started = performance.now();
    expect(await boundedProbeExec(5_000, 300)(`${script} --version`)).toBe("holder 4.5.6\n");
    expect(performance.now() - started).toBeLessThan(3_000);
    const { child } = JSON.parse(fs.readFileSync(log, "utf8")) as { child: number };
    const until = Date.now() + REAP_BOUND_MS;
    while (Date.now() < until && exists(child)) await new Promise((r) => setTimeout(r, 50));
    expect(exists(child), `descendant ${child}`).toBe(false);
  });
});

describe("boundedProbeExec reads everything the probe wrote before closing the pipes", () => {
  it("a probe that writes a large version output just before exiting, while a descendant holds stdout, is read in full", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-probe-bound-late-"));
    const log = path.join(dir, "pids");
    const script = path.join(dir, "late");
    const SIZE = 300_000; // larger than a pipe buffer: much of it is still in the pipe when the probe exits
    fs.writeFileSync(script, `#!${process.execPath}
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "inherit"] });
require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ child: child.pid }));
process.stdout.write("late 1.0.0 " + "x".repeat(${SIZE}) + "\\n", () => process.exit(0));
`, { mode: 0o755 });
    const out = await boundedProbeExec(5_000, 300)(`${script} --version`);
    expect(out.length).toBe("late 1.0.0 ".length + SIZE + 1);
    expect(out.startsWith("late 1.0.0 ")).toBe(true);
    const { child } = JSON.parse(fs.readFileSync(log, "utf8")) as { child: number };
    const until = Date.now() + REAP_BOUND_MS;
    while (Date.now() < until && exists(child)) await new Promise((r) => setTimeout(r, 50));
    expect(exists(child), `descendant ${child}`).toBe(false);
  });

  it("output written in the last instant before the pipes close (a descendant's final line on TERM) is still read", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-probe-bound-tail-"));
    const script = path.join(dir, "tail");
    // The probe prints its version and exits 0; its descendant holds stdout, and on TERM writes a final line and exits.
    fs.writeFileSync(script, `#!${process.execPath}
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{process.stdout.write('TAIL ' + 'y'.repeat(200000) + '\\\\n',()=>process.exit(0))});setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "inherit"] });
process.stdout.write("tail 2.0.0\\n", () => process.exit(0));
`, { mode: 0o755 });
    const out = await boundedProbeExec(5_000, 300)(`${script} --version`);
    expect(out.startsWith("tail 2.0.0\n")).toBe(true);
    expect(out.endsWith("y\n"), `got ${out.length} bytes`).toBe(true);
  });
});

describe("boundedProbeExec leaves a descendant that closed its stdio alone, as main does", () => {
  it("a probe that exits 0 leaving a descendant with its stdio closed answers at once, and the descendant keeps running", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-probe-bound-bg-"));
    const log = path.join(dir, "pids");
    const script = path.join(dir, "updater");
    // Prints its version, starts a background child (same group, stdio closed: like an updater without setsid), exits 0.
    fs.writeFileSync(script, `#!${process.execPath}
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
child.unref();
require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ child: child.pid }));
process.stdout.write("updater 7.8.9\\n", () => process.exit(0));
`, { mode: 0o755 });
    const started = performance.now();
    expect(await boundedProbeExec(5_000, 300)(`${script} --version`)).toBe("updater 7.8.9\n");
    expect(performance.now() - started).toBeLessThan(3_000);
    const { child } = JSON.parse(fs.readFileSync(log, "utf8")) as { child: number };
    await new Promise((r) => setTimeout(r, 500));
    expect(exists(child), `background descendant ${child}`).toBe(true);
    process.kill(child, "SIGKILL");
    const until = Date.now() + REAP_BOUND_MS;
    while (Date.now() < until && exists(child)) await new Promise((r) => setTimeout(r, 50));
    expect(exists(child)).toBe(false);
  });
});

describe("RuntimeVerifier with a bounded probe", () => {
  let db: Database.Database;
  let restorePath: string | undefined;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    restorePath = process.env.PATH;
  });
  afterEach(() => {
    db.close();
    process.env.PATH = restorePath;
  });
  const onPath = (dir: string) => { process.env.PATH = `${dir}${path.delimiter}${restorePath}`; };
  const verifier = () => new RuntimeVerifier({ exec: vi.fn(async () => { throw new Error("exec must not run the probes"); }), db, probeExec: boundedProbeExec(800, 300) });

  it("a healthy probe is unchanged: verified with its version, one start", async () => {
    const fake = fakeRuntime("codex", "ok", "ok");
    onPath(fake.dir);
    expect(await verifier().verifyCodex()).toMatchObject({ runtime: "codex", status: "verified", version: "1.2.3", error: null });
    expect(starts(fake.log).map((s) => s.arg)).toEqual(["--version"]);
  });

  it("a hung --version returns within the bound, ends the probe, records error with what happened, and doesn't try --help", async () => {
    const fake = fakeRuntime("codex", "hang", "ok");
    onPath(fake.dir);
    const started = performance.now();
    const result = await verifier().verifyCodex();
    expect(performance.now() - started).toBeLessThan(2 * (800 + 4 * 300) + 1_000);
    expect(starts(fake.log).map((s) => s.arg)).toEqual(["--version"]);
    expect(result).toMatchObject({ status: "error", version: null, error: "codex --version did not answer within 1 s; the probe was ended" });
    for (const s of starts(fake.log)) expect(await leftAfterReapBound(s), `${s.arg}: pids ${s.pids.join(",")} group ${s.pgid}`).toEqual([]);
    // Persisted like any verification.
    expect(db.prepare("SELECT status FROM runtime_verifications WHERE runtime = 'codex'").get()).toEqual({ status: result.status });
  }, 20_000);

  it("a failed --version and a hung --help fallback return within the bound and end the probe", async () => {
    const fake = fakeRuntime("codex", "fail", "hang");
    onPath(fake.dir);
    const started = performance.now();
    const result = await verifier().verifyCodex();
    expect(performance.now() - started).toBeLessThan(800 + 4 * 300 + 1_000);
    expect(result).toMatchObject({ status: "error", version: null, error: "codex --help did not answer within 1 s; the probe was ended" });
    expect(starts(fake.log).map((s) => s.arg)).toEqual(["--version", "--help"]);
    for (const s of starts(fake.log)) expect(await leftAfterReapBound(s), `${s.arg}: pids ${s.pids.join(",")} group ${s.pgid}`).toEqual([]);
  }, 20_000);

  it("the timeout outcome is error with the probe's own detail, for --version and --help alike", () => {
    for (const probe of ["version", "help"] as const) {
      expect(probeTimeoutOutcome("codex", probe, new ProbeTimeoutError(`codex --${probe}`, RUNTIME_PROBE_TIMEOUT_MS)))
        .toEqual({ status: "error", error: `codex --${probe} did not answer within 30 s; the probe was ended` });
    }
  });

  it("a failed --version (not a timeout) still falls back to --help, and a missing binary is still not_found", async () => {
    const fake = fakeRuntime("codex", "fail", "ok");
    onPath(fake.dir);
    expect(await verifier().verifyCodex()).toMatchObject({ status: "verified", version: null });
    expect(starts(fake.log).map((s) => s.arg)).toEqual(["--version", "--help"]);
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-probe-bound-empty-"));
    expect(await verifier().verifyCodex()).toMatchObject({ status: "not_found", error: "codex not found" });
  });

  it("without a probe exec, the verifier probes through exec exactly as before", async () => {
    const exec = vi.fn(async (cmd: string) => (cmd === "codex --version" ? "codex-cli 0.9.1" : ""));
    expect(await new RuntimeVerifier({ exec, db }).verifyCodex()).toMatchObject({ status: "verified", version: "0.9.1" });
    expect(exec).toHaveBeenCalledWith("codex --version");
  });
});
