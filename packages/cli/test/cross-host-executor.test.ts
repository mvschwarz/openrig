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
    // D13 supersession: the remote command now runs under `sh -lc` (login-shell PATH
    // resolution) — the quoted argv rides inside one further quoting layer.
    expect(capture.args).toEqual([
      "-o", "ConnectTimeout=10",
      "vm-test.local",
      "sh -lc ''\\''rig'\\'' '\\''send'\\'' '\\''dev-impl@rig'\\'' '\\''hello world'\\'' '\\''--verify'\\'''",
    ]);
  });

  // A2 — P23: the SSH relay re-runs `rig` in a NON-login shell that resolves ITS OWN seat identity,
  // degrading the origin. Prefix OPENRIG_SESSION_NAME=<origin triple> INSIDE the sh -lc line so the
  // remote's DaemonClient stamps the ORIGIN identity (matching A4's HTTP header). Byte-exact via the
  // real shellQuote (the design's "byte-asserted, quoting included"): the env assignment precedes the
  // argv, and --from STAYS on the argv (additive per the P23-D1 expiry — a pre-I4 remote reads origin
  // from --from, so an early removal would silently degrade attribution in the mixed-version window).
  it("A2 — prefixes OPENRIG_SESSION_NAME=<origin triple> into the sh -lc line; --from stays additive", async () => {
    const capture: { command?: string; args?: readonly string[] } = {};
    const spawn = mockSpawnFor({ exitCode: 0, stdout: "ok\n", capture });
    const triple = "dev50@v-rig@origin-host";
    const argv = ["rig", "send", "dev-impl@rig", "hi", "--from", triple];
    await runCrossHostCommand(HOST, argv, { spawn, originTriple: triple });
    const line = String(capture.args?.[capture.args.length - 1] ?? "");
    // byte-exact composition, via the same shellQuote the impl uses:
    const expectedInner = `OPENRIG_SESSION_NAME=${shellQuote(triple)} ${argv.map(shellQuote).join(" ")}`;
    expect(line).toBe(`sh -lc ${shellQuote(expectedInner)}`);
    // and the additive-state guarantees, resilient to quoting:
    expect(line).toContain("OPENRIG_SESSION_NAME=");
    expect(line).toContain("--from"); // STAYS (P23-D1) — a premature removal fails here
    expect(line.indexOf("OPENRIG_SESSION_NAME=")).toBeLessThan(line.indexOf("send")); // env precedes the command
  });

  it("A2 — NO originTriple ⇒ NO env prefix (backward-compatible; the local/no-origin path is byte-unchanged)", async () => {
    const capture: { command?: string; args?: readonly string[] } = {};
    const spawn = mockSpawnFor({ exitCode: 0, stdout: "ok\n", capture });
    await runCrossHostCommand(HOST, ["rig", "ps"], { spawn });
    const line = String(capture.args?.[capture.args.length - 1] ?? "");
    expect(line).not.toContain("OPENRIG_SESSION_NAME=");
    expect(line).toBe(`sh -lc ${shellQuote(["rig", "ps"].map(shellQuote).join(" "))}`);
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
      expect(result.sshStderr).toContain("not ssh");
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

// ─── D13 (INTAKE 5674431c): remote rig resolution over ssh ─────────────────────
// Bare quoted argv over ssh runs in a NON-LOGIN shell (no operator PATH) → exit 127.
// Fix: the remote command runs under `sh -lc` (the operator's own login PATH), and a
// 127/command-not-found classifies LOUD as its own step with a teaching hint.
import { runCrossHostCommand as d13Run, classifyResult as d13Classify } from "../src/cross-host-executor.js";
import { EventEmitter } from "node:events";

function d13Child(exitCode: number, stderr = "") {
  const child = new EventEmitter() as import("node:child_process").ChildProcess;
  (child as unknown as { stdin: { write(): void; end(): void } }).stdin = { write() {}, end() {} };
  const out = new EventEmitter(); const err = new EventEmitter();
  (child as unknown as { stdout: EventEmitter }).stdout = out;
  (child as unknown as { stderr: EventEmitter }).stderr = err;
  setImmediate(() => { if (stderr) err.emit("data", stderr); child.emit("close", exitCode); });
  return child;
}

describe("D13 — remote rig resolution + loud 127", () => {
  it("the remote command runs under a login shell (sh -lc) so the operator PATH resolves rig", async () => {
    const capture: { command?: string; args?: readonly string[] } = {};
    const spawn = mockSpawnFor({ exitCode: 0, capture });
    await d13Run(HOST, ["rig", "ps", "--json"], { spawn });
    const full = [capture.command!, ...capture.args!];
    const remote = full[full.length - 1]!;
    expect(full.slice(-2)[0]).toBe("vm-test.local");
    expect(remote).toMatch(/^sh -lc /); // login-shell bootstrap present
    expect(remote).toContain("rig"); // the command rides inside it
  });

  it("exit 127 / command-not-found classifies as remote-command-not-found with a teaching hint", () => {
    const r = d13Classify(127, "", "sh: rig: command not found");
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("remote-command-not-found");
    expect((r as { hint?: string }).hint).toMatch(/PATH|login|rigPath/i);
  });

  it("control: non-127 remote failures keep their existing classification", () => {
    expect(d13Classify(1, "", "boom").failedStep).toBe("remote-command-failed");
    expect(d13Classify(255, "", "Permission denied (publickey)").failedStep).toBe("permission-gate");
  });
});
