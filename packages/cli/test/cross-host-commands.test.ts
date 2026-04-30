import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendCommand, type SendDeps } from "../src/commands/send.js";
import { captureCommand, type CaptureDeps } from "../src/commands/capture.js";
import { psCommand, type PsDeps } from "../src/commands/ps.js";
import { whoamiCommand, type WhoamiDeps } from "../src/commands/whoami.js";
import type { CrossHostResult } from "../src/cross-host-executor.js";
import type { HostRegistryLoadResult } from "../src/host-registry.js";

// Capture stdout / stderr / exitCode for command actions.
interface CapturedOutput {
  stdoutLines: string[];
  stderrLines: string[];
  stdoutWrites: string[];
  stderrWrites: string[];
  exitCode: number | undefined;
}

let captured: CapturedOutput;
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  captured = { stdoutLines: [], stderrLines: [], stdoutWrites: [], stderrWrites: [], exitCode: undefined };
  originalLog = console.log;
  originalError = console.error;
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  console.log = (...args: unknown[]) => { captured.stdoutLines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { captured.stderrLines.push(args.map(String).join(" ")); };
  process.stdout.write = ((s: string | Uint8Array) => { captured.stdoutWrites.push(typeof s === "string" ? s : Buffer.from(s).toString("utf-8")); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { captured.stderrWrites.push(typeof s === "string" ? s : Buffer.from(s).toString("utf-8")); return true; }) as typeof process.stderr.write;
  process.exitCode = undefined;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  captured.exitCode = process.exitCode;
  process.exitCode = undefined;
});

const KNOWN_REGISTRY: HostRegistryLoadResult = {
  ok: true,
  registry: {
    hosts: [{ id: "vm-a", transport: "ssh", target: "vm-a.local" }],
  },
};

function deps(overrides: { run?: (h: never, argv: readonly string[]) => Promise<CrossHostResult>; registry?: HostRegistryLoadResult } = {}): SendDeps & CaptureDeps {
  const lifecycleDeps = {} as never;
  const clientFactory = (() => ({}) as never) as never;
  return {
    lifecycleDeps,
    clientFactory,
    hostRegistryLoader: () => overrides.registry ?? KNOWN_REGISTRY,
    crossHostRun: overrides.run ?? (async () => ({ ok: true, failedStep: "none", stdout: "", stderr: "", remoteExitCode: 0 })),
  };
}

// ---------------------------------------------------------------------------
// `rig send --host <id>`
// ---------------------------------------------------------------------------

describe("send --host (cross-host short-circuit)", () => {
  it("happy path: forwards reconstructed argv to the executor and surfaces remote stdout verbatim", async () => {
    const captureCalls: { argv?: readonly string[] } = {};
    const cmd = sendCommand(deps({
      run: async (_h, argv) => {
        captureCalls.argv = argv;
        return { ok: true, failedStep: "none", stdout: "Sent to dev-impl@my-rig\nVerified: yes\n", stderr: "", remoteExitCode: 0 };
      },
    }));
    await cmd.parseAsync(["--host", "vm-a", "dev-impl@my-rig", "hello world", "--verify"], { from: "user" });
    expect(captureCalls.argv).toEqual(["rig", "send", "dev-impl@my-rig", "hello world", "--verify"]);
    expect(captured.stdoutLines[0]).toBe("[via host=vm-a (vm-a.local)]");
    const stdoutText = captured.stdoutWrites.join("");
    expect(stdoutText).toContain("Verified: yes");
    expect(process.exitCode).toBeUndefined();
  });

  it("--verify honesty: SSH success + remote 'Verified: no' surfaces in output, NOT collapsed into success+silence", async () => {
    const cmd = sendCommand(deps({
      run: async () => ({ ok: true, failedStep: "none", stdout: "Sent to dev-impl@my-rig\nVerified: no\n", stderr: "", remoteExitCode: 0 }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "dev-impl@my-rig", "hi", "--verify"], { from: "user" });
    const stdoutText = captured.stdoutWrites.join("");
    expect(stdoutText).toContain("Verified: no"); // remote authority surfaced
    // ssh layer succeeded; CLI does NOT inject Verified: yes.
    expect(stdoutText).not.toMatch(/^Verified: yes$/m);
  });

  it("forwards --force, --wait-for-idle, --json flags into the remote argv", async () => {
    const captureCalls: { argv?: readonly string[] } = {};
    const cmd = sendCommand(deps({
      run: async (_h, argv) => {
        captureCalls.argv = argv;
        return { ok: true, failedStep: "none", stdout: "{}", stderr: "", remoteExitCode: 0 };
      },
    }));
    await cmd.parseAsync(["--host", "vm-a", "s@r", "msg", "--force", "--json"], { from: "user" });
    expect(captureCalls.argv).toContain("--force");
    expect(captureCalls.argv).toContain("--json");
  });

  it("JSON output wraps the executor result in a cross_host envelope", async () => {
    const cmd = sendCommand(deps({
      run: async () => ({ ok: true, failedStep: "none", stdout: "{}", stderr: "", remoteExitCode: 0 }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "s@r", "msg", "--json"], { from: "user" });
    const out = JSON.parse(captured.stdoutLines[0]!);
    expect(out.cross_host).toEqual({ host: "vm-a", target: "vm-a.local" });
    expect(out.result.ok).toBe(true);
  });

  it("unknown host id surfaces a friendly error with discoverability hint", async () => {
    const cmd = sendCommand(deps());
    await cmd.parseAsync(["--host", "vm-unknown", "s@r", "msg"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("unknown host id 'vm-unknown'");
    expect(captured.stderrLines.join("\n")).toContain("vm-a"); // known-id hint
    expect(process.exitCode).toBe(1);
  });

  it("registry load failure surfaces the error", async () => {
    const cmd = sendCommand(deps({
      registry: { ok: false, error: "host registry not found at /nope" },
    }));
    await cmd.parseAsync(["--host", "vm-a", "s@r", "msg"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("host registry not found");
    expect(process.exitCode).toBe(1);
  });

  it("ssh-unreachable failure → exit 1 with operator-actionable message", async () => {
    const cmd = sendCommand(deps({
      run: async () => ({ ok: false, failedStep: "ssh-unreachable", sshStderr: "ssh: connect to host: Connection refused" }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "s@r", "msg"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("ssh to host=vm-a");
    expect(captured.stderrLines.join("\n")).toContain("Verify SSH access");
    expect(process.exitCode).toBe(1);
  });

  it("permission-gate failure → exit 1 with field-note hint", async () => {
    const cmd = sendCommand(deps({
      run: async () => ({ ok: false, failedStep: "permission-gate", sshStderr: "Permission denied", hint: "See keychain doc" }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "s@r", "msg"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("permission/auth gate");
    expect(captured.stderrLines.join("\n")).toContain("See keychain doc");
    expect(process.exitCode).toBe(1);
  });

  it("remote-daemon-unreachable → exit 1 with daemon-start hint", async () => {
    const cmd = sendCommand(deps({
      run: async () => ({ ok: false, failedStep: "remote-daemon-unreachable", stdout: "", stderr: "Daemon not running", remoteExitCode: 1 }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "s@r", "msg"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("could not reach the remote daemon");
    expect(captured.stderrLines.join("\n")).toContain("rig daemon start");
    expect(process.exitCode).toBe(1);
  });

  it("remote-command-failed → exit 1 with remote stderr surfaced", async () => {
    const cmd = sendCommand(deps({
      run: async () => ({ ok: false, failedStep: "remote-command-failed", stdout: "", stderr: "session not found", remoteExitCode: 3 }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "s@r", "msg"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("remote rig command on host=vm-a failed");
    expect(captured.stderrLines.join("\n")).toContain("session not found");
    expect(process.exitCode).toBe(1);
  });

  it("JSON output for failure surfaces failedStep + permission-gate hint under result", async () => {
    const cmd = sendCommand(deps({
      run: async () => ({ ok: false, failedStep: "permission-gate", sshStderr: "Permission denied", hint: "See keychain doc" }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "s@r", "msg", "--json"], { from: "user" });
    const out = JSON.parse(captured.stdoutLines[0]!);
    expect(out.cross_host).toEqual({ host: "vm-a", target: "vm-a.local" });
    expect(out.result.ok).toBe(false);
    expect(out.result.failedStep).toBe("permission-gate");
    expect(out.result.hint).toBe("See keychain doc");
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// `rig capture --host <id>`
// ---------------------------------------------------------------------------

describe("capture --host (cross-host short-circuit)", () => {
  it("happy path: forwards reconstructed argv with session + lines", async () => {
    const captureCalls: { argv?: readonly string[] } = {};
    const cmd = captureCommand(deps({
      run: async (_h, argv) => {
        captureCalls.argv = argv;
        return { ok: true, failedStep: "none", stdout: "pane content here\n", stderr: "", remoteExitCode: 0 };
      },
    }));
    await cmd.parseAsync(["--host", "vm-a", "dev-impl@my-rig", "--lines", "50"], { from: "user" });
    expect(captureCalls.argv).toEqual(["rig", "capture", "dev-impl@my-rig", "--lines", "50"]);
    expect(captured.stdoutLines[0]).toBe("[via host=vm-a (vm-a.local)]");
    expect(captured.stdoutWrites.join("")).toContain("pane content here");
  });

  it("multi-target form: forwards --rig and --pod when no session is supplied", async () => {
    const captureCalls: { argv?: readonly string[] } = {};
    const cmd = captureCommand(deps({
      run: async (_h, argv) => {
        captureCalls.argv = argv;
        return { ok: true, failedStep: "none", stdout: "{}", stderr: "", remoteExitCode: 0 };
      },
    }));
    await cmd.parseAsync(["--host", "vm-a", "--rig", "my-rig", "--pod", "dev", "--json"], { from: "user" });
    expect(captureCalls.argv).toEqual(["rig", "capture", "--rig", "my-rig", "--pod", "dev", "--lines", "20", "--json"]);
  });

  it("unknown host id surfaces a friendly error", async () => {
    const cmd = captureCommand(deps());
    await cmd.parseAsync(["--host", "vm-bogus", "s@r"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("unknown host id 'vm-bogus'");
    expect(process.exitCode).toBe(1);
  });

  it("ssh-unreachable failure surfaces actionable error", async () => {
    const cmd = captureCommand(deps({
      run: async () => ({ ok: false, failedStep: "ssh-unreachable", sshStderr: "Connection refused" }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "s@r"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("ssh to host=vm-a");
    expect(process.exitCode).toBe(1);
  });

  it("JSON output wraps result in cross_host envelope", async () => {
    const cmd = captureCommand(deps({
      run: async () => ({ ok: true, failedStep: "none", stdout: "{}", stderr: "", remoteExitCode: 0 }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "s@r", "--json"], { from: "user" });
    const out = JSON.parse(captured.stdoutLines[0]!);
    expect(out.cross_host).toEqual({ host: "vm-a", target: "vm-a.local" });
    expect(out.result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Compat regression: `rig send` and `rig capture` WITHOUT --host MUST NOT add
// the cross-host annotation and MUST NOT call the executor at all.
// ---------------------------------------------------------------------------

describe("compat regression: no --host means no cross-host annotation", () => {
  it("send help text mentions --host (so operators discover it)", () => {
    const cmd = sendCommand(deps());
    expect(cmd.helpInformation()).toContain("--host");
  });

  it("capture help text mentions --host", () => {
    const cmd = captureCommand(deps());
    expect(cmd.helpInformation()).toContain("--host");
  });

  it("send without --host does NOT call the cross-host executor (registry loader untouched, executor untouched)", async () => {
    const loaderSpy = vi.fn();
    const runSpy = vi.fn();
    const cmd = sendCommand({
      lifecycleDeps: makeFailingLifecycleDeps(),
      clientFactory: () => ({} as never),
      hostRegistryLoader: loaderSpy as never,
      crossHostRun: runSpy as never,
    });
    await cmd.parseAsync(["s@r", "msg"], { from: "user" });
    // local path short-circuits at "Daemon not running" without consulting cross-host machinery.
    expect(loaderSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("capture without --host does NOT call the cross-host executor", async () => {
    const loaderSpy = vi.fn();
    const runSpy = vi.fn();
    const cmd = captureCommand({
      lifecycleDeps: makeFailingLifecycleDeps(),
      clientFactory: () => ({} as never),
      hostRegistryLoader: loaderSpy as never,
      crossHostRun: runSpy as never,
    });
    await cmd.parseAsync(["s@r"], { from: "user" });
    expect(loaderSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });
});

function makeFailingLifecycleDeps(): never {
  // Stub LifecycleDeps that responds with "no daemon" on every probe — the
  // local-path branch short-circuits with "Daemon not running" before doing
  // anything cross-host.
  return {
    exists: (_p: string) => false,
    readFileText: (_p: string) => "",
    spawnDetached: () => ({ pid: 0 }),
    isPidAlive: (_p: number) => false,
    fetchHealthDetail: async () => ({ ok: false, code: "unreachable" }),
  } as never;
}

// ---------------------------------------------------------------------------
// `rig ps --host <id>` (C9b)
// ---------------------------------------------------------------------------

function psDeps(overrides: { run?: (h: never, argv: readonly string[]) => Promise<CrossHostResult>; registry?: HostRegistryLoadResult } = {}): PsDeps {
  return {
    lifecycleDeps: {} as never,
    clientFactory: (() => ({}) as never) as never,
    hostRegistryLoader: () => overrides.registry ?? KNOWN_REGISTRY,
    crossHostRun: overrides.run ?? (async () => ({ ok: true, failedStep: "none", stdout: "", stderr: "", remoteExitCode: 0 })),
  };
}

describe("ps --host (cross-host short-circuit)", () => {
  it("argv reconstruction: forwards every shaping flag in operator-declared order", async () => {
    const captureCalls: { argv?: readonly string[] } = {};
    const cmd = psCommand(psDeps({
      run: async (_h, argv) => {
        captureCalls.argv = argv;
        return { ok: true, failedStep: "none", stdout: '[{"rigName":"r1"}]\n', stderr: "", remoteExitCode: 0 };
      },
    }));
    await cmd.parseAsync([
      "--host", "vm-a", "--nodes", "--full", "--limit", "20",
      "--fields", "rigName,status", "--summary", "--filter", "status=running", "--json",
    ], { from: "user" });
    expect(captureCalls.argv).toEqual([
      "rig", "ps", "--nodes", "--full", "--limit", "20", "--fields", "rigName,status",
      "--summary", "--filter", "status=running", "--json",
    ]);
  });

  it("argv reconstruction: bare `--host vm-a` produces ['rig','ps'] with no extra flags", async () => {
    const captureCalls: { argv?: readonly string[] } = {};
    const cmd = psCommand(psDeps({
      run: async (_h, argv) => {
        captureCalls.argv = argv;
        return { ok: true, failedStep: "none", stdout: "", stderr: "", remoteExitCode: 0 };
      },
    }));
    await cmd.parseAsync(["--host", "vm-a"], { from: "user" });
    expect(captureCalls.argv).toEqual(["rig", "ps"]);
  });

  it("verbatim remote stdout passthrough on success — no double-JSON-wrapping", async () => {
    const remoteJson = '[{"rigName":"r1","status":"running"},{"rigName":"r2","status":"stopped"}]\n';
    const cmd = psCommand(psDeps({
      run: async () => ({ ok: true, failedStep: "none", stdout: remoteJson, stderr: "", remoteExitCode: 0 }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "--json"], { from: "user" });
    const stdoutText = captured.stdoutWrites.join("");
    // Output is verbatim remote stdout; NOT wrapped in {cross_host:..., result:...}.
    expect(stdoutText).toBe(remoteJson);
    expect(stdoutText).not.toContain("cross_host");
  });

  it("ssh-unreachable failure surfaces actionable error and exits 1", async () => {
    const cmd = psCommand(psDeps({
      run: async () => ({ ok: false, failedStep: "ssh-unreachable", sshStderr: "ssh: connect refused" }),
    }));
    await cmd.parseAsync(["--host", "vm-a"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("ssh to host=vm-a");
    expect(process.exitCode).toBe(1);
  });

  it("permission-gate failure surfaces hint and exits 1", async () => {
    const cmd = psCommand(psDeps({
      run: async () => ({ ok: false, failedStep: "permission-gate", sshStderr: "Permission denied", hint: "See keychain doc" }),
    }));
    await cmd.parseAsync(["--host", "vm-a"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("permission/auth gate");
    expect(captured.stderrLines.join("\n")).toContain("See keychain doc");
    expect(process.exitCode).toBe(1);
  });

  it("remote-daemon-unreachable surfaces daemon-start hint", async () => {
    const cmd = psCommand(psDeps({
      run: async () => ({ ok: false, failedStep: "remote-daemon-unreachable", stdout: "", stderr: "Daemon not running", remoteExitCode: 1 }),
    }));
    await cmd.parseAsync(["--host", "vm-a"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("could not reach the remote daemon");
    expect(process.exitCode).toBe(1);
  });

  it("remote-command-failed surfaces remote stderr", async () => {
    const cmd = psCommand(psDeps({
      run: async () => ({ ok: false, failedStep: "remote-command-failed", stdout: "", stderr: "Some rig error", remoteExitCode: 3 }),
    }));
    await cmd.parseAsync(["--host", "vm-a"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("remote rig command on host=vm-a failed");
    expect(process.exitCode).toBe(1);
  });

  it("unknown host id surfaces friendly error with discoverability hint", async () => {
    const cmd = psCommand(psDeps());
    await cmd.parseAsync(["--host", "vm-bogus"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("unknown host id 'vm-bogus'");
    expect(process.exitCode).toBe(1);
  });

  it("JSON output for failure surfaces top-level failedStep envelope", async () => {
    const cmd = psCommand(psDeps({
      run: async () => ({ ok: false, failedStep: "permission-gate", sshStderr: "Permission denied", hint: "See keychain doc" }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "--json"], { from: "user" });
    const out = JSON.parse(captured.stdoutLines[0]!);
    expect(out.ok).toBe(false);
    expect(out.cross_host).toEqual({ host: "vm-a", target: "vm-a.local" });
    expect(out.failedStep).toBe("permission-gate");
    expect(out.hint).toBe("See keychain doc");
    expect(process.exitCode).toBe(1);
  });

  it("help text mentions --host (operator discoverability)", () => {
    const cmd = psCommand(psDeps());
    expect(cmd.helpInformation()).toContain("--host");
  });

  it("compat regression: ps without --host does NOT call registry loader OR executor", async () => {
    const loaderSpy = vi.fn();
    const runSpy = vi.fn();
    const cmd = psCommand({
      lifecycleDeps: makeFailingLifecycleDeps(),
      clientFactory: () => ({} as never),
      hostRegistryLoader: loaderSpy as never,
      crossHostRun: runSpy as never,
    });
    await cmd.parseAsync([], { from: "user" });
    expect(loaderSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// `rig whoami --host <id>` (C9b')
// ---------------------------------------------------------------------------

function whoamiDeps(overrides: { run?: (h: never, argv: readonly string[]) => Promise<CrossHostResult>; registry?: HostRegistryLoadResult } = {}): WhoamiDeps {
  return {
    lifecycleDeps: {} as never,
    clientFactory: (() => ({}) as never) as never,
    hostRegistryLoader: () => overrides.registry ?? KNOWN_REGISTRY,
    crossHostRun: overrides.run ?? (async () => ({ ok: true, failedStep: "none", stdout: "", stderr: "", remoteExitCode: 0 })),
  };
}

describe("whoami --host (cross-host short-circuit)", () => {
  it("argv reconstruction: forwards --node-id, --session, --json in operator-declared order", async () => {
    const captureCalls: { argv?: readonly string[] } = {};
    const cmd = whoamiCommand(whoamiDeps({
      run: async (_h, argv) => {
        captureCalls.argv = argv;
        return { ok: true, failedStep: "none", stdout: "{}", stderr: "", remoteExitCode: 0 };
      },
    }));
    await cmd.parseAsync([
      "--host", "vm-a", "--node-id", "01ABC", "--session", "foo@rig", "--json",
    ], { from: "user" });
    expect(captureCalls.argv).toEqual([
      "rig", "whoami", "--node-id", "01ABC", "--session", "foo@rig", "--json",
    ]);
  });

  it("argv reconstruction: bare `--host vm-a` produces ['rig','whoami'] with no extra flags", async () => {
    const captureCalls: { argv?: readonly string[] } = {};
    const cmd = whoamiCommand(whoamiDeps({
      run: async (_h, argv) => {
        captureCalls.argv = argv;
        return { ok: true, failedStep: "none", stdout: "", stderr: "", remoteExitCode: 0 };
      },
    }));
    await cmd.parseAsync(["--host", "vm-a"], { from: "user" });
    expect(captureCalls.argv).toEqual(["rig", "whoami"]);
  });

  it("cross-host runs BEFORE local identity-source resolution (no local --node-id/--session required)", async () => {
    // Critical for whoami: the local resolveIdentitySource() walks env vars and
    // tmux pane metadata. Cross-host must NOT require any of that — the remote
    // rig has its own identity context.
    const cmd = whoamiCommand(whoamiDeps({
      run: async () => ({ ok: true, failedStep: "none", stdout: '{"rigName":"remote"}\n', stderr: "", remoteExitCode: 0 }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "--json"], { from: "user" });
    // Should NOT have errored on "Cannot determine identity"; should have
    // successfully written remote stdout.
    expect(captured.stderrLines.join("\n")).not.toContain("Cannot determine identity");
    const stdoutText = captured.stdoutWrites.join("");
    expect(stdoutText).toContain("remote");
  });

  it("verbatim remote stdout passthrough on success — no double-JSON-wrapping", async () => {
    const remoteJson = '{"resolvedBy":"node_id","identity":{"rigName":"x"}}\n';
    const cmd = whoamiCommand(whoamiDeps({
      run: async () => ({ ok: true, failedStep: "none", stdout: remoteJson, stderr: "", remoteExitCode: 0 }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "--json"], { from: "user" });
    const stdoutText = captured.stdoutWrites.join("");
    expect(stdoutText).toBe(remoteJson);
    expect(stdoutText).not.toContain("cross_host");
  });

  it("ssh-unreachable failure exits 1 with actionable message", async () => {
    const cmd = whoamiCommand(whoamiDeps({
      run: async () => ({ ok: false, failedStep: "ssh-unreachable", sshStderr: "Connection refused" }),
    }));
    await cmd.parseAsync(["--host", "vm-a"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("ssh to host=vm-a");
    expect(process.exitCode).toBe(1);
  });

  it("unknown host id surfaces friendly error", async () => {
    const cmd = whoamiCommand(whoamiDeps());
    await cmd.parseAsync(["--host", "vm-bogus"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("unknown host id 'vm-bogus'");
    expect(process.exitCode).toBe(1);
  });

  it("JSON output for failure surfaces top-level failedStep envelope", async () => {
    const cmd = whoamiCommand(whoamiDeps({
      run: async () => ({ ok: false, failedStep: "remote-daemon-unreachable", stdout: "", stderr: "Daemon not running", remoteExitCode: 1 }),
    }));
    await cmd.parseAsync(["--host", "vm-a", "--json"], { from: "user" });
    const out = JSON.parse(captured.stdoutLines[0]!);
    expect(out.ok).toBe(false);
    expect(out.cross_host).toEqual({ host: "vm-a", target: "vm-a.local" });
    expect(out.failedStep).toBe("remote-daemon-unreachable");
    expect(process.exitCode).toBe(1);
  });

  it("help text mentions --host", () => {
    const cmd = whoamiCommand(whoamiDeps());
    expect(cmd.helpInformation()).toContain("--host");
  });

  it("compat regression: whoami without --host does NOT call registry loader OR executor", async () => {
    const loaderSpy = vi.fn();
    const runSpy = vi.fn();
    const cmd = whoamiCommand({
      lifecycleDeps: makeFailingLifecycleDeps(),
      clientFactory: () => ({} as never),
      hostRegistryLoader: loaderSpy as never,
      crossHostRun: runSpy as never,
    });
    // Passing --node-id avoids the "cannot determine identity" branch; the
    // local daemon-down path runs after that (or partial-result; either way
    // does NOT consult the cross-host machinery).
    await cmd.parseAsync(["--node-id", "abc"], { from: "user" });
    expect(loaderSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });
});
