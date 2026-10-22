import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon, STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { acquireDaemonStartLock } from "../src/daemon-start-lock.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  const files = new Map<string, string>();
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null, unref: vi.fn() }) as unknown as ChildProcess;
  let spawned = false;
  const lock = { recordChild: vi.fn(), release: vi.fn() };
  const body = { pid: child.pid, bind: { mode: "explicit" as const, hosts: ["127.0.0.1"], tailscaleDetected: false } };
  const deps: LifecycleDeps = {
    acquireStartLock: vi.fn(() => lock),
    spawn: vi.fn(() => { spawned = true; return child; }),
    fetch: vi.fn(async () => { if (!spawned) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); return { ok: true, json: async () => body }; }),
    kill: vi.fn(() => { child.exitCode = 0; child.emit("exit", 0, "SIGTERM"); return true; }),
    readFile: (p) => files.get(p) ?? null,
    writeFile: vi.fn((p, value) => { files.set(p, value); }),
    removeFile: (p) => { files.delete(p); },
    exists: (p) => files.has(p), mkdirp: vi.fn(), openForAppend: () => 3,
    isProcessAlive: () => child.exitCode === null,
  };
  return { deps, child, body, files, lock };
}
const opts = { port: 19873, host: "127.0.0.1", db: "fixture.sqlite" };

describe("child-bound startup", () => {
  it("publishes a single verified child and rejects a sequential duplicate", async () => {
    const f = fixture();
    const state = await startDaemon(opts, f.deps);
    expect(state.pid).toBe(f.child.pid);
    const before = f.files.get(STATE_FILE);
    await expect(startDaemon(opts, f.deps)).rejects.toThrow(/already running/);
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect(f.files.get(STATE_FILE)).toBe(before);
    expect(f.lock.release).toHaveBeenLastCalledWith(false);
  });
  it.each(["alive", "dead"])("preserves the winner when the losing child is %s", async (state) => {
    const f = fixture();
    const winner = JSON.stringify({ pid: 45678, port: opts.port, host: opts.host, db: opts.db, startedAt: "2026-09-07T00:00:00Z" });
    f.deps.spawn = vi.fn(() => {
      f.files.set(STATE_FILE, winner);
      if (state === "dead") { f.child.exitCode = 1; queueMicrotask(() => f.child.emit("exit", 1, null)); }
      return f.child;
    });
    f.deps.fetch = vi.fn(async () => { if (!f.files.has(STATE_FILE)) throw new Error("refused"); return { ok: true, json: async () => ({ ...f.body, pid: 45678 }) }; });
    await expect(startDaemon(opts, f.deps)).rejects.toThrow(/identity mismatch|exited/);
    expect(f.files.get(STATE_FILE)).toBe(winner);
    expect(f.deps.writeFile).not.toHaveBeenCalledWith(STATE_FILE, expect.anything());
    for (const [pid] of vi.mocked(f.deps.kill).mock.calls) expect(pid).toBe(12345);
  });
  it.each([undefined, 888, "12345"])("does not publish missing/mismatched process identity %s", async (pid) => {
    const f = fixture();
    (f.body as { pid: unknown }).pid = pid;
    await expect(startDaemon(opts, f.deps)).rejects.toThrow(/identity mismatch/);
    expect(f.files.has(STATE_FILE)).toBe(false);
  });
  it("requires the same child on every listener", async () => {
    const f = fixture(); f.body.bind.hosts.push("127.0.0.2");
    const fetch = f.deps.fetch;
    f.deps.fetch = async (url) => url.includes("127.0.0.2")
      ? { ok: true, json: async () => ({ ...f.body, pid: 888 }) } : fetch(url);
    await expect(startDaemon(opts, f.deps)).rejects.toThrow(/identity mismatch.*127.0.0.2/);
    expect(f.files.has(STATE_FILE)).toBe(false);
  });
  it("publishes the verified child, naming the unverified listener, when only a secondary listener stays uncertain", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const f = fixture(); f.body.bind.hosts.push("127.0.0.2");
      const fetch = f.deps.fetch;
      f.deps.fetch = async (url) => { if (url.includes("127.0.0.2")) throw new Error("timeout"); return fetch(url); };
      const result = startDaemon(opts, f.deps).catch((e: Error) => e);
      await vi.runAllTimersAsync();
      const outcome = await result;
      expect(outcome instanceof Error ? outcome.message : outcome.pid).toBe(f.child.pid);
      expect(JSON.parse(f.files.get(STATE_FILE)!)).toMatchObject({ pid: f.child.pid, port: opts.port });
      expect(f.lock.release).toHaveBeenLastCalledWith(false);
      expect(errors.mock.calls.flat().join(" ")).toMatch(/127\.0\.0\.2 could not be verified/);
    } finally {
      errors.mockRestore();
    }
  });
  it("tracks child exit while the health response is pending", async () => {
    const f = fixture(); const fetch = f.deps.fetch;
    f.deps.fetch = async (url) => {
      await fetch(url);
      queueMicrotask(() => { f.child.exitCode = 1; f.child.emit("exit", 1, null); });
      return { ok: true, json: () => new Promise(() => {}) };
    };
    await expect(startDaemon(opts, f.deps)).rejects.toThrow(/exited/);
    expect(f.files.has(STATE_FILE)).toBe(false);
  });
  it("handles an asynchronous native spawn error without a PID", async () => {
    const f = fixture();
    f.deps.spawn = () => {
      (f.child as { pid: number | undefined }).pid = undefined;
      queueMicrotask(() => f.child.emit("error", new Error("ENOENT")));
      return f.child;
    };
    await expect(startDaemon(opts, f.deps)).rejects.toThrow(/valid child PID|failed to spawn/);
    await Promise.resolve();
    expect(f.files.has(STATE_FILE)).toBe(false); expect(f.deps.kill).not.toHaveBeenCalled();
  });
  it("observes owned-child cleanup even when process inspection cannot confirm liveness", async () => {
    const f = fixture(); f.body.pid = 999;
    f.deps.isProcessAlive = () => false;
    const kill = f.deps.kill;
    f.deps.kill = vi.fn((...args) => {
      expect(f.lock.release).not.toHaveBeenCalled();
      return kill(...args);
    });
    await expect(startDaemon(opts, f.deps)).rejects.toThrow(/identity mismatch/);
    expect(f.deps.kill).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(f.child.exitCode).toBe(0);
    expect(f.lock.release).toHaveBeenCalledWith(false);
  });
  it.each([false, true])("rejects physical death during publication and preserves a replacement owner: %s", async (replacement) => {
    const f = fixture(); let physicallyAlive = true;
    f.deps.isProcessAlive = () => physicallyAlive;
    const write = f.deps.writeFile;
    const winner = JSON.stringify({ pid: 45678, port: opts.port, host: opts.host, db: opts.db, startedAt: "2026-09-07T00:00:00Z" });
    f.deps.writeFile = (p, value) => {
      write(p, value);
      if (p === STATE_FILE) {
        physicallyAlive = false; // exitCode/event still undelivered during this turn
        if (replacement) f.files.set(p, winner);
      }
    };
    await expect(startDaemon(opts, f.deps)).rejects.toThrow(/at state publication/);
    expect(f.files.get(STATE_FILE)).toBe(replacement ? winner : undefined);
    for (const [pid] of vi.mocked(f.deps.kill).mock.calls) expect(pid).toBe(12345);
  });
  it.each([true, false])("retains the reservation for an unconfirmed child exit when isProcessAlive is %s", async (observedAlive) => {
    vi.useFakeTimers();
    const f = fixture(); f.body.pid = 999; f.deps.kill = vi.fn(() => true);
    f.deps.isProcessAlive = () => observedAlive;
    const result = startDaemon(opts, f.deps).catch((e: Error) => e);
    await vi.runAllTimersAsync();
    expect((await result as Error).message).toMatch(/reservation retained/);
    expect(f.lock.release).toHaveBeenCalledWith(true);
    expect(f.files.has(STATE_FILE)).toBe(false);
  });
  it("does not mistake a child error event for confirmed exit", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.body.pid = 999;
    f.deps.kill = () => {
      queueMicrotask(() => f.child.emit("error", new Error("signal failed")));
      return false;
    };
    const result = startDaemon(opts, f.deps).catch((e: Error) => e);
    await vi.runAllTimersAsync();
    expect((await result as Error).message).toMatch(/exit is unconfirmed/);
    expect(f.child.exitCode).toBeNull();
    expect(f.lock.release).toHaveBeenCalledWith(true);
  });
});

describe("local startup reservation", () => {
  it("excludes the second launcher and releases after the owner completes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-start-lock-"));
    try {
      const lock = acquireDaemonStartLock(home); lock.recordChild(1234);
      expect(fs.readFileSync(path.join(home, "daemon-start.lock"), "utf8")).toContain('"childPid":1234');
      expect(() => acquireDaemonStartLock(home)).toThrow(/already reserved/);
      lock.release(); const next = acquireDaemonStartLock(home); next.release();
      expect(fs.existsSync(path.join(home, "daemon-start.lock"))).toBe(false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  it("preserves abandoned evidence and never releases a replacement owner's file", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-start-lock-"));
    try {
      const file = path.join(home, "daemon-start.lock"), archive = file + ".previous";
      const first = acquireDaemonStartLock(home); first.release(true);
      expect(() => acquireDaemonStartLock(home)).toThrow(/already reserved/);
      fs.renameSync(file, archive);
      const second = acquireDaemonStartLock(home); fs.renameSync(file, file + ".second");
      const third = acquireDaemonStartLock(home); second.release();
      expect(fs.existsSync(file)).toBe(true); third.release();
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
