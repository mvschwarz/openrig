import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runSeatPoolDispatchGuard,
  SEAT_POOL_DISPATCH_GUARD_VETO_EXIT,
  type SeatPoolDispatchGuardInput,
} from "../src/domain/seat-pool-dispatch-guard.js";
import { TMUX_CREDENTIAL_ENV_KEYS } from "../src/adapters/tmux-credential-env.js";

// #4061 (Ask 1): the daemon's runner for the pool block's `dispatch_guard`. Each guard here is this test's own Node, by
// absolute path, with a script; `--` ends Node's own options, so the runner's arguments reach the script.

const ROW = { qitemId: "qitem-guard-1", from: "dev-impl@pool-rig", to: "dev-impl-s1@pool-rig" };

/** A guard that runs `script` in this test's Node, with its own arguments after `--`. */
function guard(script: string, own: string[] = []): SeatPoolDispatchGuardInput {
  return { argv: [process.execPath, "-e", script, "--", ...own], ...ROW };
}

/** A temporary folder for one test, removed after it. */
async function inTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-guard-"));
  try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Whether a process is still alive. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Waits up to 2 s for every pid to be gone; returns the ones still alive. */
async function stillAlive(pids: number[]): Promise<number[]> {
  for (let i = 0; i < 40 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 50));
  return pids.filter(alive);
}

/** A script that starts a sleeping child (its own stdio: "inherit" holds the guard's pipes), writes both pids to
 *  `file`, then does `then`. */
function withChild(file: string, stdio: "ignore" | "inherit", then: string): string {
  return `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: '${stdio}' });`
    + ` require('fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify([process.pid, c.pid])); ${then}`;
}

describe("seat-pool dispatch guard runner (#4061)", () => {
  it("Exit 0 lets the move go, and the command gets its own arguments verbatim, then `--qitem=`, `--from=` and `--to=`.", async () => {
    const expected = JSON.stringify(["--strict", "a b; $(x)", `--qitem=${ROW.qitemId}`, `--from=${ROW.from}`, `--to=${ROW.to}`]);
    const script = `process.exit(JSON.stringify(process.argv.slice(-5)) === ${JSON.stringify(expected)} ? 0 : 1)`;
    expect(await runSeatPoolDispatchGuard(guard(script, ["--strict", "a b; $(x)"]))).toEqual({ verdict: "allow" });
  });

  it("Exit 75 vetoes the move, with the first line of its stdout as the message, or none.", async () => {
    expect(SEAT_POOL_DISPATCH_GUARD_VETO_EXIT).toBe(75);
    expect(await runSeatPoolDispatchGuard(guard("console.log('\\n  leased by dev-impl-s2  \\nmore'); process.exit(75)")))
      .toEqual({ verdict: "veto", message: "leased by dev-impl-s2" });
    expect(await runSeatPoolDispatchGuard(guard("process.exit(75)"))).toEqual({ verdict: "veto" });
  });

  it("A message with a character split across two writes is read whole.", async () => {
    // "€" is e2 82 ac in UTF-8: the first two bytes in one write, the last in a later one.
    const script = "process.stdout.write(Buffer.from([0xe2, 0x82])); setTimeout(() => { process.stdout.write(Buffer.from([0xac, 0x20, 0x35, 0x0a])); process.exit(75); }, 100)";
    expect(await runSeatPoolDispatchGuard(guard(script))).toEqual({ verdict: "veto", message: "€ 5" });
  });

  it.each([
    ["exits 1 (a crash, not a veto)", "console.error('boom'); process.exit(1)", "exited 1: boom"],
    ["exits 2 with nothing on stderr", "process.exit(2)", "exited 2"],
    ["is killed by a signal", "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000)", "killed by SIGTERM"],
  ])("A guard that %s is a guard error, never a veto.", async (_title, script, message) => {
    expect(await runSeatPoolDispatchGuard(guard(script))).toEqual({ verdict: "error", message });
  });

  it("A guard gets the daemon's environment without its credentials, as a command run through tmux does.", async () => {
    // every key the tmux client drops, and a run grant, beside an ordinary variable
    const credentials = [...TMUX_CREDENTIAL_ENV_KEYS, "OPENRIG_RUN_GRANT_X"];
    const set: Record<string, string> = { ...Object.fromEntries(credentials.map((key) => [key, `${key}-secret`])),
      OPENRIG_POOL_GUARD_PLAIN: "kept" };
    const before = Object.fromEntries(Object.keys(set).map((key) => [key, process.env[key]]));
    Object.assign(process.env, set);
    try {
      const script = `const e = process.env; const leaked = ${JSON.stringify(credentials)}.filter((k) => k in e);`
        + " if (leaked.length) { console.error('leaked ' + leaked.join(',')); process.exit(3); }"
        + " process.exit(e.OPENRIG_POOL_GUARD_PLAIN === 'kept' ? 0 : 4)";
      expect(await runSeatPoolDispatchGuard(guard(script))).toEqual({ verdict: "allow" });
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("A guard that can't be started is a guard error.", async () => {
    const verdict = await runSeatPoolDispatchGuard({ argv: ["/nonexistent/openrig-pool-guard"], ...ROW });
    expect(verdict).toMatchObject({ verdict: "error" });
    expect((verdict as { message: string }).message).toMatch(/^could not start: .*ENOENT/);
  });

  it("A guard that runs past the timeout is a guard error, without waiting for it, and it is killed with what it started.", async () => {
    await inTemp(async (dir) => {
      const file = path.join(dir, "pids.json");
      const started = process.hrtime.bigint();
      const verdict = await runSeatPoolDispatchGuard(guard(withChild(file, "ignore", "setTimeout(() => {}, 20000)")), { timeoutMs: 1500 });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(verdict).toEqual({ verdict: "error", message: "timed out after 1500 ms" });
      expect(elapsedMs).toBeLessThan(3500);
      const pids = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
      expect(await stillAlive(pids)).toEqual([]);
    });
  });

  it("A guard gets no stdin, so one that reads it is not held up; and one that leaves a child holding its output is read by its exit code, and the child is killed.", async () => {
    expect(await runSeatPoolDispatchGuard(guard("process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"), { timeoutMs: 5000 }))
      .toEqual({ verdict: "allow" });
    await inTemp(async (dir) => {
      const file = path.join(dir, "pids.json");
      const started = process.hrtime.bigint();
      expect(await runSeatPoolDispatchGuard(guard(withChild(file, "inherit", "console.log('busy'); process.exit(75)")), { timeoutMs: 5000 }))
        .toEqual({ verdict: "veto", message: "busy" });
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(2000);
      // the child that held the pipes goes with the guard's group
      const [, childPid] = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
      expect(await stillAlive([childPid!])).toEqual([]);
    });
  });
});
