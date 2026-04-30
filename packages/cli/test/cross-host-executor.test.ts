import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  runCrossHostCommand,
  classifyResult,
  shellQuote,
  type SpawnFn,
} from "../src/cross-host-executor.js";
import type { HostEntry } from "../src/host-registry.js";

// ---------------------------------------------------------------------------
// Mock spawn helpers
// ---------------------------------------------------------------------------

interface MockChild extends EventEmitter {
  stdin: { write: (s: string) => void; end: () => void };
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function mockSpawnFor(opts: {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  capture?: { command?: string; args?: readonly string[] };
}): SpawnFn {
  return ((command: string, args: readonly string[]) => {
    if (opts.capture) {
      opts.capture.command = command;
      opts.capture.args = args;
    }
    const child = makeMockChild();
    queueMicrotask(() => {
      if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout, "utf-8"));
      if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr, "utf-8"));
      child.emit("close", opts.exitCode);
    });
    return child as never;
  }) as SpawnFn;
}

const HOST: HostEntry = { id: "vm-test", transport: "ssh", target: "vm-test.local" };
const HOST_WITH_USER: HostEntry = { id: "vm-test", transport: "ssh", target: "vm-test.local", user: "ops" };

// ---------------------------------------------------------------------------
// shellQuote unit
// ---------------------------------------------------------------------------

describe("shellQuote", () => {
  it("wraps simple strings in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });
  it("escapes embedded single quotes via the standard '\\'' trick", () => {
    expect(shellQuote("it's fine")).toBe("'it'\\''s fine'");
  });
  it("preserves spaces, equals signs, and special chars literally inside the quotes", () => {
    expect(shellQuote("a b=c d?e")).toBe("'a b=c d?e'");
  });
});

// ---------------------------------------------------------------------------
// classifyResult — unit table
// ---------------------------------------------------------------------------

describe("classifyResult", () => {
  it("exit 0 → ok / failedStep=none", () => {
    const r = classifyResult(0, "Sent to dev-impl@rig\nVerified: yes\n", "");
    expect(r).toEqual({
      ok: true,
      failedStep: "none",
      stdout: "Sent to dev-impl@rig\nVerified: yes\n",
      stderr: "",
      remoteExitCode: 0,
    });
  });

  it("exit 255 with Permission denied → permission-gate (with field-note hint)", () => {
    const r = classifyResult(255, "", "ssh: Permission denied (publickey).");
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("permission-gate");
    if (r.failedStep === "permission-gate") {
      expect(r.sshStderr).toContain("Permission denied");
      expect(r.hint).toContain("Keychain-over-SSH");
    }
  });

  it("exit 255 with Keychain pattern → permission-gate", () => {
    const r = classifyResult(255, "", "Could not query Keychain entry for ...");
    expect(r.failedStep).toBe("permission-gate");
  });

  it("exit 255 with unknown stderr → ssh-unreachable", () => {
    const r = classifyResult(255, "", "ssh: connect to host vm-test.local port 22: Connection refused");
    expect(r.failedStep).toBe("ssh-unreachable");
    if (r.failedStep === "ssh-unreachable") {
      expect(r.sshStderr).toContain("Connection refused");
    }
  });

  it("exit 1 with Daemon-not-running stderr → remote-daemon-unreachable", () => {
    const r = classifyResult(1, "", "Daemon not running. Start it with: rig daemon start\n");
    expect(r.failedStep).toBe("remote-daemon-unreachable");
    if (r.failedStep === "remote-daemon-unreachable") {
      expect(r.remoteExitCode).toBe(1);
    }
  });

  it("exit 2 with daemon-fetch-failure stderr → remote-daemon-unreachable", () => {
    const r = classifyResult(2, "", "Failed to fetch rig list from daemon (HTTP 500). Check daemon status with: rig status\n");
    expect(r.failedStep).toBe("remote-daemon-unreachable");
  });

  it("exit non-zero without daemon signal → remote-command-failed", () => {
    const r = classifyResult(1, "", "Send failed: session not found\n");
    expect(r.failedStep).toBe("remote-command-failed");
    if (r.failedStep === "remote-command-failed") {
      expect(r.remoteExitCode).toBe(1);
      expect(r.stderr).toContain("session not found");
    }
  });

  it("exit -1 (spawn error) → ssh-unreachable", () => {
    const r = classifyResult(-1, "", "[spawn error] ENOENT");
    expect(r.failedStep).toBe("ssh-unreachable");
  });
});

// ---------------------------------------------------------------------------
// runCrossHostCommand — integration with mocked spawn
// ---------------------------------------------------------------------------

describe("runCrossHostCommand", () => {
  it("constructs the ssh argv with ConnectTimeout and quoted remote command line", async () => {
    const capture: { command?: string; args?: readonly string[] } = {};
    const spawn = mockSpawnFor({ exitCode: 0, stdout: "ok\n", capture });
    await runCrossHostCommand(HOST, ["rig", "send", "dev-impl@rig", "hello world", "--verify"], { spawn });
    expect(capture.command).toBe("ssh");
    expect(capture.args).toEqual([
      "-o", "ConnectTimeout=10",
      "vm-test.local",
      "'rig' 'send' 'dev-impl@rig' 'hello world' '--verify'",
    ]);
  });

  it("includes -l <user> when host.user is set", async () => {
    const capture: { command?: string; args?: readonly string[] } = {};
    const spawn = mockSpawnFor({ exitCode: 0, capture });
    await runCrossHostCommand(HOST_WITH_USER, ["rig", "ps"], { spawn });
    expect(capture.args?.[0]).toBe("-l");
    expect(capture.args?.[1]).toBe("ops");
  });

  it("happy path returns stdout/stderr verbatim", async () => {
    const spawn = mockSpawnFor({
      exitCode: 0,
      stdout: "Sent to dev-impl@rig\nVerified: yes\n",
      stderr: "",
    });
    const result = await runCrossHostCommand(HOST, ["rig", "send", "dev-impl@rig", "hello"], { spawn });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout).toContain("Verified: yes");
      expect(result.remoteExitCode).toBe(0);
    }
  });

  it("--verify honest pass-through: ssh exit 0 + remote 'Verified: no' surfaces in stdout (NOT collapsed)", async () => {
    // This is the slice's load-bearing rule: ssh success is NOT verify success.
    const spawn = mockSpawnFor({
      exitCode: 0,
      stdout: "Sent to dev-impl@rig\nVerified: no\n",
    });
    const result = await runCrossHostCommand(HOST, ["rig", "send", "dev-impl@rig", "hi", "--verify"], { spawn });
    expect(result.ok).toBe(true); // ssh layer succeeded
    if (result.ok) {
      // remote verify result is in stdout, not synthesized into ok=false.
      // Callers (send command) are responsible for surfacing 'Verified: no' to the user.
      expect(result.stdout).toContain("Verified: no");
    }
  });

  it("classifies 255 + Permission denied as permission-gate", async () => {
    const spawn = mockSpawnFor({ exitCode: 255, stderr: "ssh: Permission denied (publickey)." });
    const result = await runCrossHostCommand(HOST, ["rig", "ps"], { spawn });
    expect(result.failedStep).toBe("permission-gate");
  });

  it("classifies 255 + connection refused as ssh-unreachable", async () => {
    const spawn = mockSpawnFor({
      exitCode: 255,
      stderr: "ssh: connect to host vm-test.local port 22: Connection refused",
    });
    const result = await runCrossHostCommand(HOST, ["rig", "ps"], { spawn });
    expect(result.failedStep).toBe("ssh-unreachable");
  });

  it("classifies remote daemon-not-running as remote-daemon-unreachable", async () => {
    const spawn = mockSpawnFor({
      exitCode: 1,
      stderr: "Daemon not running. Start it with: rig daemon start\n",
    });
    const result = await runCrossHostCommand(HOST, ["rig", "send", "x", "y"], { spawn });
    expect(result.failedStep).toBe("remote-daemon-unreachable");
  });

  it("classifies other remote non-zero as remote-command-failed", async () => {
    const spawn = mockSpawnFor({ exitCode: 3, stderr: "Some other rig error\n" });
    const result = await runCrossHostCommand(HOST, ["rig", "send", "x", "y"], { spawn });
    expect(result.failedStep).toBe("remote-command-failed");
    if (result.failedStep === "remote-command-failed") {
      expect(result.remoteExitCode).toBe(3);
    }
  });

  it("rejects non-ssh transport (defense-in-depth on top of registry validation)", async () => {
    const result = await runCrossHostCommand(
      { id: "vm-x", transport: "tailscale" as never, target: "vm-x.local" } as HostEntry,
      ["rig", "ps"],
      { spawn: mockSpawnFor({ exitCode: 0 }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.failedStep === "ssh-unreachable") {
      expect(result.sshStderr).toContain("not supported");
    }
  });

  it("forwards stdin to the spawned process when provided", async () => {
    const writes: string[] = [];
    let stdinEnded = false;
    const spawn: SpawnFn = ((command: string, _args: readonly string[]) => {
      const child = makeMockChild();
      child.stdin.write = (s: string) => writes.push(s);
      child.stdin.end = () => { stdinEnded = true; };
      queueMicrotask(() => child.emit("close", 0));
      return child as never;
    }) as SpawnFn;
    await runCrossHostCommand(HOST, ["cat"], { spawn, stdin: "from-stdin\n" });
    expect(writes).toEqual(["from-stdin\n"]);
    expect(stdinEnded).toBe(true);
  });

  it("respects custom connect timeout", async () => {
    const capture: { args?: readonly string[] } = {};
    await runCrossHostCommand(HOST, ["rig", "ps"], {
      spawn: mockSpawnFor({ exitCode: 0, capture }),
      connectTimeoutSeconds: 30,
    });
    expect(capture.args).toContain("ConnectTimeout=30");
  });
});
