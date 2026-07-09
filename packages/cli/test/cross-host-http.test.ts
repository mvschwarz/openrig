// OPR.0.4.6.MH4 C4 — the http transport branch + §4 target-sugar/precedence
// matrix for the four cross-host coordination verbs. Everything runs through
// the shipped depsOverride injection (mock clientFactory + hostRegistryLoader
// + crossHostRun) — no daemon, no tmux, no network, no real ~/.openrig.
//
// The LOCAL zero-regression half lives in the existing suites (send.test.ts,
// capture.test.ts, transcript.test.ts, broadcast.test.ts run the local paths
// against a real local server) and in cross-host-commands.test.ts (the ssh
// argv byte-identity) — both untouched by this slice and both must stay
// green; this file covers the NET-NEW http branch, the sugar, and the
// precedence contract.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendCommand, type SendDeps } from "../src/commands/send.js";
import { captureCommand, type CaptureDeps } from "../src/commands/capture.js";
import { transcriptCommand, type TranscriptDeps } from "../src/commands/transcript.js";
import { broadcastCommand, type BroadcastDeps } from "../src/commands/broadcast.js";
import { resolveCrossHostTarget } from "../src/cross-host-target.js";
import type { CrossHostResult } from "../src/cross-host-executor.js";
import type { HostRegistryLoadResult } from "../src/host-registry.js";

interface CapturedOutput {
  stdoutLines: string[];
  stderrLines: string[];
}

let captured: CapturedOutput;
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(() => {
  captured = { stdoutLines: [], stderrLines: [] };
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => { captured.stdoutLines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { captured.stderrLines.push(args.map(String).join(" ")); };
  process.exitCode = undefined;
  delete process.env.OPENRIG_HOST_SELECTED;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  // Assertions read the LIVE process.exitCode inside test bodies (the run-1
  // preflight lesson: a copy taken here is invisible to in-body assertions
  // and made the exit-code checks vacuous). This hook only resets state.
  process.exitCode = undefined;
  delete process.env.OPENRIG_HOST_SELECTED;
});

// A registry with BOTH transports + a second http host for precedence cases.
const REGISTRY: HostRegistryLoadResult = {
  ok: true,
  registry: {
    hosts: [
      { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "MH4_TEST_BEARER" },
      { id: "vps-c", transport: "http", url: "http://vps-c:7433", bearer_env: "MH4_TEST_BEARER" },
      { id: "vm-ssh", transport: "ssh", target: "vm-ssh.local" },
    ],
  },
};
process.env["MH4_TEST_BEARER"] = "test-token";

interface RecordedCall {
  url: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  options?: { timeoutMs?: number; headers?: Record<string, string> };
}

interface MockClientHarness {
  calls: RecordedCall[];
  clientFactory: (url: string) => never;
}

function mockClient(respond: (call: RecordedCall) => { status: number; data: unknown } | Error): MockClientHarness {
  const calls: RecordedCall[] = [];
  const clientFactory = (url: string) => ({
    post: async (path: string, body?: unknown, options?: RecordedCall["options"]) => {
      const call: RecordedCall = { url, method: "POST", path, body, options };
      calls.push(call);
      const res = respond(call);
      if (res instanceof Error) throw res;
      return res;
    },
    get: async (path: string, options?: RecordedCall["options"]) => {
      const call: RecordedCall = { url, method: "GET", path, options };
      calls.push(call);
      const res = respond(call);
      if (res instanceof Error) throw res;
      return res;
    },
  }) as never;
  return { calls, clientFactory };
}

const sshRunnerNeverCalled = vi.fn(async (): Promise<CrossHostResult> => {
  throw new Error("ssh runner must not be invoked for an http host");
});

function httpDeps(harness: MockClientHarness, overrides: Partial<SendDeps & CaptureDeps & TranscriptDeps & BroadcastDeps> = {}): SendDeps & CaptureDeps & TranscriptDeps & BroadcastDeps {
  return {
    lifecycleDeps: {} as never,
    clientFactory: harness.clientFactory,
    hostRegistryLoader: () => REGISTRY,
    crossHostRun: sshRunnerNeverCalled as never,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §4 sugar/precedence — the pure helper contract
// ---------------------------------------------------------------------------

describe("resolveCrossHostTarget (§4 sugar + precedence)", () => {
  const loader = () => REGISTRY;

  it("plain 2-part target: untouched, no sugar, no hint, registry never loaded", () => {
    const spy = vi.fn(loader);
    const r = resolveCrossHostTarget("dev-impl@my-rig", undefined, spy);
    expect(r).toEqual({ ok: true, target: "dev-impl@my-rig", sugarHost: undefined, hint: undefined });
    expect(spy).not.toHaveBeenCalled();
  });

  it("3-part with REGISTERED suffix: host-qualified — target stripped, host extracted", () => {
    const r = resolveCrossHostTarget("dev-impl@my-rig@vps-b", undefined, loader);
    expect(r).toEqual({ ok: true, target: "dev-impl@my-rig", sugarHost: "vps-b", hint: undefined });
  });

  it("3-part with UNREGISTERED suffix: passes through UNCHANGED with the loud hint", () => {
    const r = resolveCrossHostTarget("dev-impl@my-rig@nope", undefined, loader);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe("dev-impl@my-rig@nope");
      expect(r.sugarHost).toBeUndefined();
      expect(r.hint).toContain("no registered host 'nope'");
      expect(r.hint).toContain("rig host ls");
    }
  });

  it("registry load failure: passthrough + hint (a plain-target failure mode is never added)", () => {
    const r = resolveCrossHostTarget("a@b@vps-b", undefined, () => ({ ok: false, error: "no file" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe("a@b@vps-b");
      expect(r.sugarHost).toBeUndefined();
      expect(r.hint).toContain("vps-b");
    }
  });

  it("--host X + sugar @Y, X≠Y: structured conflict", () => {
    const r = resolveCrossHostTarget("dev-impl@my-rig@vps-b", "vps-c", loader);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("ambiguous host");
      expect(r.error).toContain("vps-c");
      expect(r.error).toContain("@vps-b");
    }
  });

  it("--host X + sugar @X (same host twice): fine", () => {
    const r = resolveCrossHostTarget("dev-impl@my-rig@vps-b", "vps-b", loader);
    expect(r).toEqual({ ok: true, target: "dev-impl@my-rig", sugarHost: "vps-b", hint: undefined });
  });

  it("adopted/raw 4-part-ish names keep working: only the LAST @ segment is a host candidate", () => {
    const r = resolveCrossHostTarget("weird@name@extra@vps-b", undefined, loader);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe("weird@name@extra");
      expect(r.sugarHost).toBe("vps-b");
    }
  });
});

// ---------------------------------------------------------------------------
// send — the http branch
// ---------------------------------------------------------------------------

describe("send --host (http branch)", () => {
  it("http host: POSTs the LOCAL body shape (wrapped envelope) to /api/transport/send; ssh runner never invoked; BR-1: session stays 2-part", async () => {
    const h = mockClient(() => ({ status: 200, data: { ok: true } }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "dev-impl@my-rig", "hello"], { from: "user" });

    expect(sshRunnerNeverCalled).not.toHaveBeenCalled();
    expect(h.calls.length).toBe(1);
    const call = h.calls[0]!;
    expect(call.url).toBe("http://vps-b:7433");
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/transport/send");
    const body = call.body as Record<string, unknown>;
    expect(body.session).toBe("dev-impl@my-rig"); // BR-1: never member@rig@host
    expect(String(body.text)).toContain("To: dev-impl@my-rig");
    expect(String(body.text)).toContain("hello");
    expect(call.options?.headers?.Authorization).toBe("Bearer test-token");
    expect(captured.stdoutLines).toContain("[via host=vps-b (http://vps-b:7433)]");
    expect(captured.stdoutLines).toContain("Sent to dev-impl@my-rig");
    expect(process.exitCode).toBeUndefined();
  });

  it("--raw skips the envelope: exact text passthrough", async () => {
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "dev-impl@my-rig", "/compact", "--raw"], { from: "user" });
    const body = h.calls[0]!.body as Record<string, unknown>;
    expect(body.text).toBe("/compact");
  });

  it("sugar target dev-impl@my-rig@vps-b routes http with the STRIPPED session", async () => {
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["dev-impl@my-rig@vps-b", "hello"], { from: "user" });
    expect(h.calls.length).toBe(1);
    expect((h.calls[0]!.body as Record<string, unknown>).session).toBe("dev-impl@my-rig");
    expect(h.calls[0]!.url).toBe("http://vps-b:7433");
  });

  it("--host conflict with a DIFFERENT sugar host: structured error, zero remote calls", async () => {
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-c", "dev-impl@my-rig@vps-b", "hello"], { from: "user" });
    expect(h.calls.length).toBe(0);
    expect(captured.stderrLines.join("\n")).toContain("ambiguous host");
    expect(process.exitCode).toBe(1);
  });

  it("persisted selection drives the http branch when no --host and no sugar", async () => {
    process.env.OPENRIG_HOST_SELECTED = "vps-b";
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["dev-impl@my-rig", "hello"], { from: "user" });
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.url).toBe("http://vps-b:7433");
  });

  it("explicit --host beats the persisted selection", async () => {
    process.env.OPENRIG_HOST_SELECTED = "vps-b";
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-c", "dev-impl@my-rig", "hello"], { from: "user" });
    expect(h.calls[0]!.url).toBe("http://vps-c:7433");
  });

  it("sugar beats the persisted selection", async () => {
    process.env.OPENRIG_HOST_SELECTED = "vps-c";
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["dev-impl@my-rig@vps-b", "hello"], { from: "user" });
    expect(h.calls[0]!.url).toBe("http://vps-b:7433");
  });

  it("--verify prints the REMOTE verdict verbatim (remote-authoritative, never locally synthesized)", async () => {
    const h = mockClient(() => ({ status: 200, data: { verified: true, outcome: "delivered" } }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "dev-impl@my-rig", "hello", "--verify"], { from: "user" });
    expect(captured.stdoutLines).toContain("Verified: yes");
    expect(captured.stdoutLines).toContain("Delivery: delivered (message landed; render confirmed)");
    expect((h.calls[0]!.body as Record<string, unknown>).verify).toBe(true);
  });

  it("--verify with no remote verdict field prints Verified: no (no local invention)", async () => {
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "dev-impl@my-rig", "hello", "--verify"], { from: "user" });
    expect(captured.stdoutLines).toContain("Verified: no");
  });

  it("remote advisory (unknown actorSession) surfaces as the non-blocking Advisory line", async () => {
    const h = mockClient(() => ({ status: 200, data: { warning: "actor session unknown on this host" } }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "dev-impl@my-rig", "hello"], { from: "user" });
    expect(captured.stdoutLines.some((l) => l.startsWith("Advisory:"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("G8 auth seam: a 401 surfaces as the structured permission-gate step with the remote's own error text", async () => {
    const h = mockClient(() => ({ status: 401, data: { error: "terminal bearer mismatch" } }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "dev-impl@my-rig", "hello"], { from: "user" });
    const err = captured.stderrLines.join("\n");
    expect(err).toContain("permission-gate");
    expect(err).toContain("terminal bearer mismatch");
    expect(err).toContain("host=vps-b");
    expect(process.exitCode).toBe(1);
  });

  it("network failure surfaces as remote-daemon-unreachable, host named, never a hang", async () => {
    const h = mockClient(() => new Error("connect ECONNREFUSED"));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "dev-impl@my-rig", "hello"], { from: "user" });
    const err = captured.stderrLines.join("\n");
    expect(err).toContain("remote-daemon-unreachable");
    expect(err).toContain("host=vps-b");
    expect(process.exitCode).toBe(1);
  });

  it("--wait-for-idle sizes the http deadline: waitForIdleMs + overhead", async () => {
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "dev-impl@my-rig", "hello", "--wait-for-idle", "30"], { from: "user" });
    expect(h.calls[0]!.options?.timeoutMs).toBe(30_000 + 5_000);
    expect((h.calls[0]!.body as Record<string, unknown>).waitForIdleMs).toBe(30_000);
  });

  it("fan-out×host guard kept verbatim: --host + --rig rejected before any call", async () => {
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "--rig", "my-rig", "hello"], { from: "user" });
    expect(h.calls.length).toBe(0);
    expect(captured.stderrLines.join("\n")).toContain("single-seat sends only");
    expect(process.exitCode).toBe(1);
  });

  it("unknown --host: structured unknown-host with the sugar hint appended when the target was 3-part-shaped", async () => {
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "ghost", "dev-impl@my-rig@nope", "hello"], { from: "user" });
    expect(h.calls.length).toBe(0);
    const err = captured.stderrLines.join("\n");
    expect(err).toContain("host=ghost");
    expect(err).toContain("no registered host 'nope'");
    expect(process.exitCode).toBe(1);
  });

  it("json envelope: cross_host {host, target, transport:http} + the raw result", async () => {
    const h = mockClient(() => ({ status: 200, data: { verified: true } }));
    const cmd = sendCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "dev-impl@my-rig", "hello", "--json"], { from: "user" });
    const parsed = JSON.parse(captured.stdoutLines[0]!) as Record<string, any>;
    expect(parsed.cross_host).toEqual({ host: "vps-b", target: "http://vps-b:7433", transport: "http" });
    expect(parsed.result.ok).toBe(true);
    expect(parsed.result.data.verified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// capture — the http branch
// ---------------------------------------------------------------------------

describe("capture --host (http branch)", () => {
  it("http host: POSTs the LOCAL body shape to /api/transport/capture and renders the single result under the banner", async () => {
    const h = mockClient(() => ({ status: 200, data: { content: "pane content here" } }));
    const cmd = captureCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "dev-impl@my-rig", "--lines", "50"], { from: "user" });
    expect(sshRunnerNeverCalled).not.toHaveBeenCalled();
    const call = h.calls[0]!;
    expect(call.path).toBe("/api/transport/capture");
    expect(call.body).toEqual({ lines: 50, session: "dev-impl@my-rig" });
    expect(captured.stdoutLines).toContain("[via host=vps-b (http://vps-b:7433)]");
    expect(captured.stdoutLines).toContain("pane content here");
  });

  it("multi-target (--rig/--pod) rides the http branch with per-target rendering", async () => {
    const h = mockClient(() => ({
      status: 200,
      data: { results: [
        { sessionName: "a@r", ok: true, content: "aaa" },
        { sessionName: "b@r", ok: false, error: "no pane" },
      ] },
    }));
    const cmd = captureCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "--rig", "r"], { from: "user" });
    expect((h.calls[0]!.body as Record<string, unknown>).rig).toBe("r");
    expect(captured.stdoutLines).toContain("--- a@r ---");
    expect(captured.stdoutLines).toContain("aaa");
    expect(captured.stdoutLines.join("\n")).toContain("no pane");
  });

  it("sugar target routes http with the stripped session (BR-1)", async () => {
    const h = mockClient(() => ({ status: 200, data: { content: "x" } }));
    const cmd = captureCommand(httpDeps(h));
    await cmd.parseAsync(["dev-impl@my-rig@vps-b"], { from: "user" });
    expect((h.calls[0]!.body as Record<string, unknown>).session).toBe("dev-impl@my-rig");
  });

  it("ssh host still takes the ssh shell-out (branch selection)", async () => {
    const sshCalls: { argv?: readonly string[] } = {};
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = captureCommand(httpDeps(h, {
      crossHostRun: (async (_hh: never, argv: readonly string[]) => {
        sshCalls.argv = argv;
        return { ok: true, failedStep: "none", stdout: "remote pane\n", stderr: "", remoteExitCode: 0 } as CrossHostResult;
      }) as never,
    }));
    await cmd.parseAsync(["--host", "vm-ssh", "dev-impl@my-rig"], { from: "user" });
    expect(h.calls.length).toBe(0); // http client never touched for an ssh host
    expect(sshCalls.argv).toEqual(["rig", "capture", "dev-impl@my-rig", "--lines", "20"]);
  });
});

// ---------------------------------------------------------------------------
// transcript — net-new cross-host observe (http-only)
// ---------------------------------------------------------------------------

describe("transcript --host (net-new, CLI-direct GET)", () => {
  it("tail: GETs the exact local route path against the remote and renders origin shape verbatim", async () => {
    const h = mockClient(() => ({ status: 200, data: { content: "line1\nline2" } }));
    const cmd = transcriptCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "dev-impl@my-rig", "--tail", "100"], { from: "user" });
    const call = h.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.path).toBe("/api/transcripts/dev-impl%40my-rig/tail?lines=100");
    expect(captured.stdoutLines).toContain("[via host=vps-b (http://vps-b:7433)]");
    expect(captured.stdoutLines).toContain("line1");
    expect(captured.stdoutLines).toContain("line2");
  });

  it("grep: GETs the grep route and renders matches", async () => {
    const h = mockClient(() => ({ status: 200, data: { matches: ["hit one", "hit two"] } }));
    const cmd = transcriptCommand(httpDeps(h));
    await cmd.parseAsync(["dev-impl@my-rig@vps-b", "--grep", "hit"], { from: "user" });
    expect(h.calls[0]!.path).toBe("/api/transcripts/dev-impl%40my-rig/grep?pattern=hit");
    expect(captured.stdoutLines).toContain("hit one");
    expect(captured.stdoutLines).toContain("hit two");
  });

  it("ssh host: the structured transport-requirement error (http-only verb, never silent)", async () => {
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = transcriptCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vm-ssh", "dev-impl@my-rig"], { from: "user" });
    expect(h.calls.length).toBe(0);
    const err = captured.stderrLines.join("\n");
    expect(err).toContain("SSH transport");
    expect(err).toContain("host=vm-ssh");
    expect(process.exitCode).toBe(1);
  });

  it("unknown host: the same unknown-host step class as the other verbs", async () => {
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = transcriptCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "ghost", "dev-impl@my-rig"], { from: "user" });
    expect(h.calls.length).toBe(0);
    expect(captured.stderrLines.join("\n")).toContain("host=ghost");
    expect(process.exitCode).toBe(1);
  });

  it("selection-driven cross-host works for the net-new verb too", async () => {
    process.env.OPENRIG_HOST_SELECTED = "vps-b";
    const h = mockClient(() => ({ status: 200, data: { content: "x" } }));
    const cmd = transcriptCommand(httpDeps(h));
    await cmd.parseAsync(["dev-impl@my-rig", "--tail", "10"], { from: "user" });
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.url).toBe("http://vps-b:7433");
  });

  it("arch n2: the transcript read is UNGATED — it SUCCEEDS under the exact wrong-terminal-bearer scenario that permission-gates send", async () => {
    // ONE remote posture, two verbs: /api/transport/* gates on the remote's
    // terminal bearer (401 when it differs); /api/transcripts/* is the
    // shipped ungated read route and serves the same caller fine. The proof
    // matrix must never treat the auth-fail class as uniform across verbs.
    const wrongBearerRemote = (call: RecordedCall) =>
      call.path.startsWith("/api/transport/")
        ? { status: 401, data: { error: "terminal bearer mismatch" } }
        : { status: 200, data: { content: "remote transcript line" } };

    // send: permission-gate.
    const hSend = mockClient(wrongBearerRemote);
    await sendCommand(httpDeps(hSend)).parseAsync(["--host", "vps-b", "dev-impl@my-rig", "hello"], { from: "user" });
    expect(captured.stderrLines.join("\n")).toContain("permission-gate");
    expect(process.exitCode).toBe(1);

    // transcript against the SAME remote: succeeds, renders, exit clean —
    // and never becomes permission-gate.
    process.exitCode = undefined;
    captured.stdoutLines = [];
    captured.stderrLines = [];
    const hTranscript = mockClient(wrongBearerRemote);
    await transcriptCommand(httpDeps(hTranscript)).parseAsync(["--host", "vps-b", "dev-impl@my-rig", "--tail", "5"], { from: "user" });
    expect(captured.stdoutLines).toContain("remote transcript line");
    expect(captured.stderrLines.join("\n")).not.toContain("permission-gate");
    expect(process.exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// broadcast — net-new cross-host coordinate (http-only; --host + selection, NO sugar)
// ---------------------------------------------------------------------------

describe("broadcast --host (net-new, CLI-direct POST)", () => {
  it("http host: POSTs the LOCAL body verbatim; per-target results print verbatim; clean fan-out exits 0", async () => {
    const h = mockClient(() => ({
      status: 200,
      data: { results: [
        { sessionName: "a@remote-rig", ok: true },
        { sessionName: "b@remote-rig", ok: true },
      ], sent: 2, total: 2, failed: 0 },
    }));
    const cmd = broadcastCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "--rig", "remote-rig", "coordinate"], { from: "user" });
    const call = h.calls[0]!;
    expect(call.path).toBe("/api/transport/broadcast");
    expect(call.body).toEqual({ text: "coordinate", force: undefined, rig: "remote-rig" });
    expect(captured.stdoutLines).toContain("[via host=vps-b (http://vps-b:7433)]");
    expect(captured.stdoutLines).toContain("a@remote-rig: sent");
    expect(captured.stdoutLines).toContain("2/2 delivered");
    expect(process.exitCode).toBeUndefined();
  });

  it("partial fan-out: per-target honesty verbatim + NON-ZERO exit (never summarized clean)", async () => {
    const h = mockClient(() => ({
      status: 200,
      data: { results: [
        { sessionName: "a@r", ok: true },
        { sessionName: "b@r", ok: false, error: "seat dead" },
      ], sent: 1, total: 2, failed: 1 },
    }));
    const cmd = broadcastCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "--rig", "r", "msg"], { from: "user" });
    expect(captured.stdoutLines.join("\n")).toContain("b@r: FAILED — seat dead");
    expect(captured.stdoutLines).toContain("1/2 delivered");
    expect(process.exitCode).toBe(1);
  });

  it("names its OWN fan-out budget at the call site (not the read-class default)", async () => {
    const h = mockClient(() => ({ status: 200, data: { results: [], sent: 0, total: 0, failed: 0 } }));
    const cmd = broadcastCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vps-b", "msg"], { from: "user" });
    expect(h.calls[0]!.options?.timeoutMs).toBe(30_000);
  });

  it("the text positional is NEVER sugar-parsed: a message containing a@b@vps-b broadcasts locally intact when no host is set", async () => {
    // No --host, no selection: the local path runs. lifecycleDeps is a stub,
    // so the local path fails on daemon status — the assertion is that the
    // REMOTE client was never called and the message was not reinterpreted.
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = broadcastCommand(httpDeps(h, { lifecycleDeps: { getStatus: async () => ({ state: "stopped" }) } as never }));
    await cmd.parseAsync(["ping a@b@vps-b please"], { from: "user" }).catch(() => undefined);
    expect(h.calls.length).toBe(0);
  });

  it("ssh host: structured transport-requirement error (http-only verb)", async () => {
    const h = mockClient(() => ({ status: 200, data: {} }));
    const cmd = broadcastCommand(httpDeps(h));
    await cmd.parseAsync(["--host", "vm-ssh", "--rig", "r", "msg"], { from: "user" });
    expect(h.calls.length).toBe(0);
    expect(captured.stderrLines.join("\n")).toContain("SSH transport");
    expect(process.exitCode).toBe(1);
  });

  it("selection-driven cross-host broadcast", async () => {
    process.env.OPENRIG_HOST_SELECTED = "vps-b";
    const h = mockClient(() => ({ status: 200, data: { results: [], sent: 0, total: 0, failed: 0 } }));
    const cmd = broadcastCommand(httpDeps(h));
    await cmd.parseAsync(["--rig", "r", "msg"], { from: "user" });
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.url).toBe("http://vps-b:7433");
  });
});
