// 90840bcb — CLI response-integrity hardening (D-family light atom).
//
// Falsification context: the reported "structured 400 renders as only `}`"
// did NOT reproduce post-saturation; the render path (printResult + errorResponse)
// is correct. The GENUINE gap is response-integrity: a truncated / unparseable /
// transport-failed daemon response bubbles raw (json → cryptic SyntaxError; non-json
// → silent), and slow/no-connect/bad-response are conflated. Under saturation a
// truncated body (e.g. "}") makes res.json() throw with no honest render.
//
// Contract pinned here:
//  (1) client layer distinguishes THREE failure classes with typed errors:
//      - bad-response (unparseable/truncated body) → DaemonResponseError(status)
//      - slow-response (timeout)                   → DaemonTimeoutError
//      - no-connect (refused)                      → DaemonConnectionError (not a timeout)
//      well-formed non-2xx still returns {status,data} WITHOUT throwing (regression guard).
//  (2) the shared error path renders each as a 3-part fact/consequence/action error
//      with an honest NONZERO exit, in BOTH json and human modes, and NEVER daemon-not-running
//      language for a bad/slow response. Exit codes asserted UNPIPED (in-process).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DaemonClient,
  DaemonConnectionError,
  DaemonTimeoutError,
  DaemonResponseError,
} from "../src/client.js";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";
import { runProgram } from "../src/cli-error.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

const URL = "http://localhost:9999";
const jsonResponse = (body: string, status: number): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

// A queue clientFactory whose write throws the given transport error, driving the
// real command → withClient → runProgram render path (no real network).
function depsThrowing(err: Error): { queueDeps: QueueDeps } {
  return {
    queueDeps: {
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async () => { throw err; }),
        getText: vi.fn(async () => ({ status: 200, data: "" })),
        post: vi.fn(async () => { throw err; }),
        delete: vi.fn(async () => ({ status: 204, data: null })),
        postText: vi.fn(async () => ({ status: 200, data: "" })),
        postExpectText: vi.fn(async () => ({ status: 200, data: "" })),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

async function runCli(args: string[], deps?: Parameters<typeof createProgram>[0]) {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode = 0;
  const program = createProgram(deps);
  await runProgram(program, ["node", "rig", ...args], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    exit: (c) => { exitCode = c; },
  });
  return { out: out.join("\n"), err: err.join("\n"), exitCode };
}

const DAEMON_DOWN_PHRASES = [/daemon not running/i, /rig daemon start/i, /rig up/i];

describe("client response integrity — three distinct failure classes", () => {
  it("a non-empty unparseable/truncated body throws a typed DaemonResponseError carrying the status", async () => {
    const client = new DaemonClient(URL, { fetchImpl: jsonResponse("}", 400) });
    const caught = await client.post("/api/queue/x/update", {}).then(() => null, (e) => e);
    expect(caught).toBeInstanceOf(DaemonResponseError);
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect((caught as DaemonResponseError).status).toBe(400);
  });

  it("a well-formed non-2xx body still returns {status,data} WITHOUT throwing (regression guard)", async () => {
    const client = new DaemonClient(URL, { fetchImpl: jsonResponse(JSON.stringify({ error: "conflict" }), 409) });
    const res = await client.post("/api/queue/x/update", {});
    expect(res.status).toBe(409);
    expect(res.data).toEqual({ error: "conflict" });
  });

  it("a timeout throws a typed DaemonTimeoutError distinct from a plain connection refusal", async () => {
    // Honor the abort signal so fetchWithTimeout can reject with its FetchTimeoutError
    // (a mock that ignores the signal would hang instead of timing out).
    const neverFetch: typeof fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) sig.addEventListener("abort", () => reject(sig.reason ?? new Error("aborted")));
      })) as unknown as typeof fetch;
    const client = new DaemonClient(URL, { fetchImpl: neverFetch, timeoutMs: 20 });
    const caught = await client.get("/api/rigs").then(() => null, (e) => e);
    expect(caught).toBeInstanceOf(DaemonTimeoutError);
    // subclass of DaemonConnectionError so existing callers still catch it,
    // but distinguishable for slow-vs-down rendering.
    expect(caught).toBeInstanceOf(DaemonConnectionError);
  });

  it("connection refused throws DaemonConnectionError but NOT DaemonTimeoutError", async () => {
    const refuse: typeof fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const client = new DaemonClient(URL, { fetchImpl: refuse });
    const caught = await client.get("/api/rigs").then(() => null, (e) => e);
    expect(caught).toBeInstanceOf(DaemonConnectionError);
    expect(caught).not.toBeInstanceOf(DaemonTimeoutError);
  });
});

describe("render response integrity — 3-part error + honest exit, never daemon-down language", () => {
  // P21 HERMETIC: queue update derives the actor from the seat env (X-OpenRig-Session); stub a
  // deterministic seat so the daemon-response path under test is REACHED, not aborted pre-POST on an
  // env-less harness. Unstubbed per test (singleFork shares the process).
  beforeEach(() => { vi.stubEnv("OPENRIG_SESSION_NAME", "harness@rig"); process.exitCode = undefined; });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("bad-response renders fact/consequence/action JSON with nonzero exit (json)", async () => {
    const err = new DaemonResponseError(502, "<html>502 Bad Gateway</html>");
    const { out, exitCode } = await runCli(
      // P21: --actor is deprecated + IGNORED; queue update derives the actor from the seat env, which the
      // describe's beforeEach now stubs (harness@rig) so this reaches the daemon-response path under test.
      // (--actor left in the argv is harmless — the daemon ignores it.)
      ["queue", "update", "qitem-x", "--actor", "harness@rig", "--state", "done", "--closure-reason", "denied", "--json"],
      depsThrowing(err),
    );
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatchObject({
      fact: expect.any(String),
      consequence: expect.any(String),
      action: expect.any(String),
    });
    for (const p of DAEMON_DOWN_PHRASES) expect(out).not.toMatch(p);
  });

  it("bad-response renders 3-part guidance to stderr with nonzero exit, never daemon-down (human)", async () => {
    const err = new DaemonResponseError(502, "<html>truncated");
    const { err: stderr, exitCode } = await runCli(
      ["queue", "update", "qitem-x", "--actor", "harness@rig", "--state", "done", "--closure-reason", "denied"],
      depsThrowing(err),
    );
    expect(exitCode).toBe(1);
    expect(stderr.trim().length).toBeGreaterThan(0); // NOT silent
    for (const p of DAEMON_DOWN_PHRASES) expect(stderr).not.toMatch(p);
  });

  it("slow-response (timeout) renders slow guidance, not daemon-down, nonzero exit", async () => {
    const err = new DaemonTimeoutError("Request to http://localhost:7433/api/queue/x/update timed out after 5000ms");
    const { err: stderr, exitCode } = await runCli(
      ["queue", "update", "qitem-x", "--actor", "harness@rig", "--state", "done", "--closure-reason", "denied"],
      depsThrowing(err),
    );
    expect(exitCode).toBe(1);
    for (const p of DAEMON_DOWN_PHRASES) expect(stderr).not.toMatch(p);
    expect(stderr).toMatch(/timed out|slow|unresponsive/i);
    expect(stderr).toMatch(/check the command's effect before any retry/i);
    expect(stderr).not.toMatch(/retry once conditions ease/i);
  });

  it("S4b preserve: a timed-out queue read is loud on stderr and exits nonzero", async () => {
    const timeout = new DaemonTimeoutError("Request to http://localhost:7433/api/queue/list timed out after 25ms");
    const { err: stderr, exitCode } = await runCli(
      ["queue", "list"],
      depsThrowing(timeout),
    );
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/timed out|slow|unresponsive/i);
    expect(stderr.trim().length).toBeGreaterThan(0);
  });
});
