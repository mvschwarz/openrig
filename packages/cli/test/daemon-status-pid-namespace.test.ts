// #2860 — a sandbox that cuts loopback often also hides the daemon's pid. A refused probe plus a
// missing pid then looked exactly like a stopped daemon, and the guard told the agent to run `rig up`.
//
// Contract pinned here: "stopped" needs positive evidence, either the daemon's own clean-shutdown
// receipt or a missing pid seen from the daemon's pid namespace. Otherwise status says the CLI
// couldn't connect from this shell and the daemon may still be running, and never advises starting
// another daemon.
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  daemonStatusGuard,
  getDaemonStatus,
  statusGuardMessage,
  STATE_FILE,
  type DaemonState,
  type LifecycleDeps,
} from "../src/daemon-lifecycle.js";
import { daemonCommand } from "../src/commands/daemon.js";
import { daemonMayAnswer, shouldAutoStartDaemon } from "../src/daemon-reachability.js";

const INITIAL_NAMESPACE = "pid:[4026531836]";
const DAEMON_NAMESPACE = "pid:[4026532001]";
const SANDBOX_NAMESPACE = "pid:[4026532777]";
const START = "2026-01-01T00:00:00Z";

const REFUSED: LifecycleDeps["fetch"] = async () => {
  const err = new Error("fetch failed") as Error & { cause?: { code: string } };
  err.cause = { code: "ECONNREFUSED" };
  throw err;
};

function cleanReceipt(pid: number): string {
  const now = new Date().toISOString();
  return JSON.stringify({ schema: "openrig.daemon-shutdown/v1", pid, startedAt: START, completedAt: now, outcome: "clean", phase: "complete", failures: [] });
}

function deps(state: DaemonState, over: Partial<LifecycleDeps> = {}, receipt?: string): LifecycleDeps {
  return {
    spawn: vi.fn() as unknown as LifecycleDeps["spawn"],
    fetch: vi.fn(REFUSED),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(state) : p.endsWith("daemon-shutdown.json") ? receipt ?? null : null)),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE || (receipt !== undefined && p.endsWith("daemon-shutdown.json"))),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 0),
    isProcessAlive: vi.fn(() => false),
    processLiveness: vi.fn(() => "dead" as const),
    pidNamespace: () => SANDBOX_NAMESPACE,
    sleep: async () => {},
    ...over,
  };
}

const recorded = (extra: Partial<DaemonState> = {}): DaemonState =>
  ({ pid: 4242, port: 7433, db: "x.db", startedAt: START, pidNamespace: DAEMON_NAMESPACE, ...extra });

afterEach(() => vi.restoreAllMocks());

describe("#2860: a refused probe with an invisible pid is not a stopped daemon", () => {
  it("reads 'couldn't connect from this shell' when the pid is missing, the probe is refused and there is no clean shutdown", async () => {
    const status = await getDaemonStatus(deps(recorded()));
    expect(status.state).toBe("unverified");
    expect(status.pidUnseen).toBe(true);
    const message = statusGuardMessage(status);
    expect(message.fact).toMatch(/couldn't connect to the daemon from this shell.*may still be running/i);
    expect(`${message.fact} ${message.consequence} ${message.action}`).not.toMatch(/rig up|rig daemon start/i);
    expect(message.action).toMatch(/don't start another daemon/i);
    expect(shouldAutoStartDaemon(status)).toBe(false);
  });

  it("blocks commands through the guard with the same message", async () => {
    const status = await getDaemonStatus(deps(recorded()));
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => { lines.push(line); });
    const savedExit = process.exitCode;
    try {
      expect(daemonStatusGuard(status)).toBe(false);
    } finally { process.exitCode = savedExit; }
    const message = statusGuardMessage(status);
    expect(lines).toEqual([`Error: ${message.fact}`, `  ${message.consequence}`, `  ${message.action}`]);
  });

  it("is the same on an older record that names no namespace", async () => {
    const status = await getDaemonStatus(deps({ pid: 4242, port: 7433, db: "x.db", startedAt: START }));
    expect(status.pidUnseen).toBe(true);
  });

  it("is the same when this shell cannot read its own namespace", async () => {
    const status = await getDaemonStatus(deps(recorded(), { pidNamespace: () => undefined }));
    expect(status.pidUnseen).toBe(true);
  });

  it("is the same when the pid exists but cannot be inspected (unknown liveness) and the probe is refused", async () => {
    const status = await getDaemonStatus(deps(recorded(), { processLiveness: vi.fn(() => "unknown" as const) }));
    expect(status.state).toBe("unverified");
    expect(status.pidUnseen).toBe(true);
  });

  it("still answers 'running' when the probe gets through, whatever the pid looks like", async () => {
    const status = await getDaemonStatus(deps(recorded(), { fetch: vi.fn(async () => ({ ok: true })) }));
    expect(status.state).toBe("running");
  });

  it("does not remove state it cannot prove stale", async () => {
    const d = deps(recorded());
    await getDaemonStatus(d);
    expect(d.removeFile).not.toHaveBeenCalled();
  });
});

describe("#2860: the real stopped cases keep reading as down", () => {
  it("a clean shutdown for the recorded pid reads stopped from any shell", async () => {
    const d = deps(recorded(), {}, cleanReceipt(4242));
    const status = await getDaemonStatus(d);
    expect(status.state).toBe("stale");
    expect(statusGuardMessage(status).fact).toBe("Daemon not running.");
    expect(shouldAutoStartDaemon(status)).toBe(true);
    expect(d.removeFile).toHaveBeenCalledWith(STATE_FILE);
  });

  it("a clean shutdown plus a refused probe reads stopped even when the pid state is unknown", async () => {
    const status = await getDaemonStatus(deps(recorded(), { processLiveness: vi.fn(() => "unknown" as const) }, cleanReceipt(4242)));
    expect(status.state).toBe("stopped");
  });

  it("a receipt for another pid is no evidence", async () => {
    const status = await getDaemonStatus(deps(recorded(), {}, cleanReceipt(1111)));
    expect(status.pidUnseen).toBe(true);
  });

  it.each([
    ["the daemon's own namespace", recorded(), () => DAEMON_NAMESPACE],
    ["the initial namespace it was started in", recorded({ pidNamespace: INITIAL_NAMESPACE }), () => INITIAL_NAMESPACE],
    ["an older record, from the initial namespace", recorded({ pidNamespace: undefined }), () => INITIAL_NAMESPACE],
    ["an older record, on a platform without pid namespaces", recorded({ pidNamespace: undefined }), () => "host"],
  ])("a dead pid in a normal shell (%s) still reads down so 'rig up' can start it", async (_label, state, namespace) => {
    const status = await getDaemonStatus(deps(state, { pidNamespace: namespace }));
    expect(status.state).toBe("stale");
    expect(statusGuardMessage(status).fact).toBe("Daemon not running.");
    expect(shouldAutoStartDaemon(status)).toBe(true);
  });

  it("a number recorded in a nested namespace says nothing from the initial one, whatever it finds there", async () => {
    const fetch = vi.fn(REFUSED);
    const status = await getDaemonStatus(deps(recorded(), { pidNamespace: () => INITIAL_NAMESPACE, fetch }));
    expect(status.state).toBe("unverified");
    expect(status.pidUnseen).toBe(true);
    expect(fetch).toHaveBeenCalled();
  });

  it("...and a healthy endpoint reads running, not stale", async () => {
    const status = await getDaemonStatus(deps(recorded(), { pidNamespace: () => INITIAL_NAMESPACE, fetch: vi.fn(async () => ({ ok: true })) }));
    expect(status.state).toBe("running");
  });

  it("deps without namespace evidence keep the old rule", async () => {
    const d = deps(recorded());
    delete d.pidNamespace;
    expect((await getDaemonStatus(d)).state).toBe("stale");
  });
});

describe("#2860: a selected loopback OPENRIG_URL is judged like the record", () => {
  const withUrl = async (url: string, d: LifecycleDeps) => {
    process.env.OPENRIG_URL = url;
    try { return await getDaemonStatus(d); } finally { delete process.env.OPENRIG_URL; }
  };
  const URL_OF_DAEMON = "http://127.0.0.1:7433";

  it("a refusal with an invisible pid and no clean shutdown is not stopped, and 'rig up' is not advised", async () => {
    const status = await withUrl(URL_OF_DAEMON, deps(recorded()));
    expect(status.state).toBe("unverified");
    expect(status.pidUnseen).toBe(true);
    expect(shouldAutoStartDaemon(status)).toBe(false);
    expect(daemonMayAnswer(status)).toBe(false);
  });

  it("a missing pid in the daemon's own namespace reads stopped", async () => {
    expect((await withUrl(URL_OF_DAEMON, deps(recorded(), { pidNamespace: () => DAEMON_NAMESPACE }))).state).toBe("stopped");
  });

  it("a matching clean shutdown reads stopped from any shell", async () => {
    expect((await withUrl(URL_OF_DAEMON, deps(recorded(), {}, cleanReceipt(4242)))).state).toBe("stopped");
  });

  it("with no record for that endpoint a refusal keeps reading stopped", async () => {
    expect((await withUrl("http://127.0.0.1:9999", deps(recorded()))).state).toBe("stopped");
    expect((await withUrl(URL_OF_DAEMON, deps(recorded(), { exists: vi.fn(() => false), readFile: vi.fn(() => null) }))).state).toBe("stopped");
  });

  it("a remote URL keeps reading stopped on a refusal", async () => {
    expect((await withUrl("http://daemon.example:7433", deps(recorded()))).state).toBe("stopped");
  });
});

describe("#2860: `rig daemon status` says what the guard says", () => {
  it("prints the guard's three lines", async () => {
    const d = deps(recorded());
    const status = await getDaemonStatus(d);
    const message = statusGuardMessage(status);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
    await daemonCommand(d).parseAsync(["status"], { from: "user" });
    expect(lines).toEqual([message.fact, `  ${message.consequence}`, `  ${message.action}`]);
  });
});
