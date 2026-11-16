import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { askCommand } from "../src/commands/ask.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import type { WakeRunner } from "../src/ask-wake.js";

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const ol = console.log, oe = console.error;
    const prev = process.exitCode;
    process.exitCode = undefined;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    console.error = (...a: unknown[]) => logs.push(a.join(" "));
    try { await fn(); } finally { console.log = ol; console.error = oe; }
    const exitCode = process.exitCode;
    process.exitCode = prev;
    resolve({ logs, exitCode });
  });
}

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

// Raw-token wakes never touch the daemon — inert lifecycle/client are fine.
function tokenDeps(runner: WakeRunner): StatusDeps {
  return {
    lifecycleDeps: {} as never,
    clientFactory: () => ({ post: vi.fn() }) as never,
    wakeRunner: runner,
    wakeFileLocator: () => null,
  } as unknown as StatusDeps;
}

// Seat wakes resolve via the daemon first: running status + a post() that returns
// the WakeResolution.
function seatDeps(runner: WakeRunner, resolution: unknown, httpStatus = 200): StatusDeps {
  const post = vi.fn(async () => ({ status: httpStatus, data: resolution }));
  return {
    lifecycleDeps: {
      ...mockLifecycleDeps(),
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) =>
        p === STATE_FILE ? JSON.stringify({ pid: 1, port: 5000, db: "t", startedAt: "2026-01-01T00:00:00Z" } as DaemonState) : null,
      ),
      fetch: vi.fn(async () => ({ ok: true })),
    },
    clientFactory: () => ({ post, get: vi.fn(async () => ({ status: 200, data: { inputRoute: "typed" } })) }) as never,
    wakeRunner: runner,
    wakeFileLocator: () => null,
    __post: post,
  } as unknown as StatusDeps;
}

function makeCmd(deps: StatusDeps): Command {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(askCommand(deps));
  return prog;
}

describe("rig ask --wake (L3 CLI)", () => {
  it("help distinguishes full seat targets from runtime IDs and titles", () => {
    const runner: WakeRunner = vi.fn();
    const cmd = askCommand(tokenDeps(runner));
    let output = "";
    cmd.configureOutput({ writeOut: text => { output += text; } });
    cmd.outputHelp();
    const help = output.replace(/\s+/g, " ");
    expect(help).toContain("member@rig or member@rig@N (1 = newest tenure)");
    expect(help).toContain("Values without @ go unchanged to the runtime as a session ID or title");
    expect(help).toContain("a bare member name is not resolved within <rig>");
    expect(help).toContain("--wake dev-planner@my-rig");
    expect(help).toContain("--wake dev-planner@my-rig@2");
    expect(runner).not.toHaveBeenCalled();
  });

  it("passes a bare session title unchanged to the runtime without seat resolution", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "answer", stderr: "", code: 0, timedOut: false }));
    const { exitCode } = await captureLogs(async () => {
      await makeCmd(tokenDeps(runner)).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "dev-build"]);
    });
    expect(runner).toHaveBeenCalledWith("claude", ["-p", "--resume", "dev-build", expect.any(String)], expect.any(Object));
    expect(exitCode).toBeUndefined();
  });

  // B8-1b missed-site fix (census belt catch, 2026-08-07): the seat-resolve
  // precheck must route through the ONE chokepoint (daemonStatusGuard), not a
  // hand-rolled literal render — the epistemic 3-part lands, the wake-specific
  // raw-token tip survives as a supplementary line.
  it("seat-form --wake with the daemon DOWN renders the chokepoint 3-part + the raw-token tip", async () => {
    // hermetic: a leaked OPENRIG_URL/PORT routes getDaemonStatus at the LIVE daemon
    const saved: Record<string, string | undefined> = {};
    for (const k of ["OPENRIG_URL", "OPENRIG_PORT", "RIGGED_URL", "RIGGED_PORT"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }));
    // positive-down: the default-port probe must REFUSE (ok:true would fake a live daemon)
    const refused = vi.fn(async () => {
      const e = new Error("connect ECONNREFUSED 127.0.0.1:7433") as Error & { code: string };
      e.code = "ECONNREFUSED";
      throw e;
    });
    const downDeps = {
      lifecycleDeps: { ...mockLifecycleDeps(), exists: vi.fn(() => false), readFile: vi.fn(() => null), fetch: refused },
      clientFactory: () => ({ post: vi.fn() }) as never,
      wakeRunner: runner,
      wakeFileLocator: () => null,
    } as unknown as StatusDeps;
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(downDeps).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "dev-qa@my-rig"]);
    });
    const out = logs.join("\n");
    expect(exitCode).toBe(1);
    expect(out).toMatch(/rig daemon start/); // the shared guard's action line
    expect(out).toMatch(/Error: /); // 3-part structure, not the old single-line literal
    expect(out).toMatch(/raw session token.*--wake/i); // the site-specific tip survives
    expect(runner).not.toHaveBeenCalled();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("wakes by raw token and prints the snapshot answer (checked-not-believed)", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "the gateway plan is A2 first", stderr: "", code: 0, timedOut: false }));
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(tokenDeps(runner)).parseAsync(["node", "rig", "ask", "my-rig", "summarize", "--wake", "3f2a-abc"]);
    });
    const out = logs.join("\n");
    expect(runner).toHaveBeenCalled();
    expect(out).toMatch(/snapshot answer.*checked, not believed/i);
    expect(out).toContain("the gateway plan is A2 first");
    expect(exitCode).toBeUndefined();
  });

  it("reports a wake timeout honestly with a non-zero exit — never a silent hang", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "", stderr: "", code: null, timedOut: true }));
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(tokenDeps(runner)).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "tok", "--wake-timeout", "5"]);
    });
    const out = logs.join("\n");
    expect(out).toMatch(/did not return|bounded timeout/i);
    expect(exitCode).toBe(2);
  });

  it("rejects a non-numeric --wake-timeout before waking, instead of crashing in execFile", async () => {
    // NaN reached execFile's timeout option, which throws ERR_OUT_OF_RANGE (a stack trace, no JSON).
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "x", stderr: "", code: 0, timedOut: false }));
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(tokenDeps(runner)).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "tok", "--wake-timeout", "abc"]);
    });
    expect(runner).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("--wake-timeout must be a number of seconds from 1 to 2147483; got 'abc'");
    expect(exitCode).toBe(1);
  });

  it.each([
    ["1e308", "overflows to Infinity ms, which execFile rejects"],
    ["2147484", "exceeds 2^31-1 ms, which a Node timer runs after 1ms"],
  ])("rejects --wake-timeout %s before resolving a seat (%s)", async (value) => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "x", stderr: "", code: 0, timedOut: false }));
    const deps = seatDeps(runner, { resolved: true, token: "t", runtime: "claude", sessionId: 1 });
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "dev@my-rig", "--wake-timeout", value]);
    });
    expect((deps as unknown as { __post: ReturnType<typeof vi.fn> }).__post).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(`--wake-timeout must be a number of seconds from 1 to 2147483; got '${value}'`);
    expect(exitCode).toBe(1);
  });

  it("accepts the largest --wake-timeout a Node timer can honour", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "x", stderr: "", code: 0, timedOut: false }));
    await captureLogs(async () => {
      await makeCmd(tokenDeps(runner)).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "tok", "--wake-timeout", "2147483"]);
    });
    const call = (runner as unknown as { mock: { calls: [string, string[], { timeoutMs: number }][] } }).mock.calls[0]!;
    expect(call[2].timeoutMs).toBe(2_147_483_000);
  });

  it("passes a whole-millisecond timeout for fractional --wake-timeout seconds", async () => {
    // execFile also rejects a fractional timeout: 1.0005s must not become 1000.5ms.
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "x", stderr: "", code: 0, timedOut: false }));
    await captureLogs(async () => {
      await makeCmd(tokenDeps(runner)).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "tok", "--wake-timeout", "1.0005"]);
    });
    const call = (runner as unknown as { mock: { calls: [string, string[], { timeoutMs: number }][] } }).mock.calls[0]!;
    expect(Number.isInteger(call[2].timeoutMs)).toBe(true);
  });

  it("renders a FAILED wake honestly (exit N + stderr), non-zero exit — never a fake success", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "", stderr: "resume: invalid session token", code: 1, timedOut: false }));
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(tokenDeps(runner)).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "bad"]);
    });
    const out = logs.join("\n");
    expect(out).toMatch(/wake failed.*exit 1/i);
    expect(out).not.toMatch(/no answer returned/i);
    expect(exitCode).toBe(2);
  });

  it("resolves a SEAT target via the daemon, then wakes with the resolved token+runtime", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "resolved-and-woke", stderr: "", code: 0, timedOut: false }));
    const deps = seatDeps(runner, { resolved: true, token: "resolved-tok", runtime: "codex", sessionId: 7 });
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "dev-planner@my-rig"]);
    });
    const out = logs.join("\n");
    // resolved runtime (codex) and token used; answer rendered
    expect(runner).toHaveBeenCalled();
    const call = (runner as unknown as { mock: { calls: [string, string[], unknown][] } }).mock.calls[0]!;
    expect(call[0]).toBe("codex");
    expect(call[1]).toContain("resolved-tok");
    expect(out).toContain("resolved-and-woke");
    expect(exitCode).toBeUndefined();
  });

  it("renders the teaching REFUSAL for an unresolvable seat (lists tenures), exit 2, no wake", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "x", stderr: "", code: 0, timedOut: false }));
    const deps = seatDeps(runner, {
      resolved: false,
      reason: "Generation 5 does not exist for seat 'dev-planner@my-rig' — only 2 tenure(s) recorded.",
      known: [
        { generation: 1, sessionId: 20, tokenPresent: true, createdAt: "2026-08-06" },
        { generation: 2, sessionId: 10, tokenPresent: false, createdAt: "2026-08-05" },
      ],
    });
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "dev-planner@my-rig@5"]);
    });
    const out = logs.join("\n");
    expect(runner).not.toHaveBeenCalled(); // never a guessed wake
    expect(out).toMatch(/only 2 tenure/i);
    expect(out).toMatch(/gen 1: session 20/);
    expect(out).toMatch(/no resume token/); // gen 2 flagged token-absent
    expect(exitCode).toBe(2);
  });

  it.each(["pi", "custom", ""])("does not run a raw-ID wake as Claude for --runtime %j", async (runtime) => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "wrong runtime", stderr: "", code: 0, timedOut: false }));
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(tokenDeps(runner)).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "fixture-token", "--runtime", runtime]);
    });
    expect(runner).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toMatch(/runtime .*not supported/i);
  });

  it.each([["claude", "claude"], ["claude-code", "claude"], ["codex", "codex"]])("preserves raw-ID runtime %s", async (runtime, binary) => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "answer", stderr: "", code: 0, timedOut: false }));
    const { exitCode } = await captureLogs(async () => {
      await makeCmd(tokenDeps(runner)).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "fixture-token", "--runtime", runtime]);
    });
    expect(runner).toHaveBeenCalledWith(binary, expect.arrayContaining(["fixture-token"]), expect.any(Object));
    expect(exitCode).toBeUndefined();
  });

  it("keeps the seat-resolved runtime authoritative over an unused raw-ID runtime option", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "answer", stderr: "", code: 0, timedOut: false }));
    const deps = seatDeps(runner, { resolved: true, token: "resolved-token", runtime: "codex", sessionId: 7 });
    const { exitCode } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "dev@my-rig", "--runtime", "pi"]);
    });
    expect(runner).toHaveBeenCalledWith("codex", expect.arrayContaining(["resolved-token"]), expect.any(Object));
    expect(exitCode).toBeUndefined();
  });

  it.each(["pi", "custom"])("does not execute an unsupported runtime %s returned by a daemon", async (runtime) => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "wrong runtime", stderr: "", code: 0, timedOut: false }));
    const deps = seatDeps(runner, { resolved: true, token: "unsupported-token", runtime, sessionId: 7 });
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "dev@my-rig"]);
    });
    expect(runner).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toMatch(/runtime .*not supported/i);
  });

});


it("a recognized older seat status without inputRoute keeps the legacy wake path", async () => {
  const runner: WakeRunner = vi.fn(async () => ({ stdout: "old answer", stderr: "", code: 0, timedOut: false }));
  const deps = seatDeps(runner, { resolved: true, token: "saved-session", runtime: "claude", sessionId: 7 });
  const client = deps.clientFactory();
  deps.clientFactory = () => ({ ...client, get: async () => ({ status: 200, data: {
    seat_ref: "dev@r", rig_id: "rig", rig_name: "r", logical_id: "dev", runtime: "claude-code",
    current_occupant: "dev@r", session_status: "running", runner: false,
  } }) }) as never;
  await captureLogs(() => makeCmd(deps).parseAsync(["node", "rig", "ask", "r", "question", "--wake", "dev@r"]));
  expect((deps as unknown as { __post: ReturnType<typeof vi.fn> }).__post).toHaveBeenCalled();
  expect(runner).toHaveBeenCalledOnce();
});

it.each(["http", "missing", "unknown", "throw", "redirect", "old-error", "old-unknown"])("an unavailable or unknown wake route refuses without a legacy request (%s)", async failure => {
  const runner: WakeRunner = vi.fn(); const deps = seatDeps(runner, {});
  const post = vi.fn();
  deps.clientFactory = () => ({ post, get: async () => {
    if (failure === "throw") throw new Error("status unavailable");
    const legacy = { seat_ref: "dev@r", rig_id: "rig", rig_name: "r", logical_id: "dev", runtime: "claude-code", session_status: "running", runner: false };
    return { status: failure === "http" ? 503 : failure === "redirect" ? 302 : 200,
      data: failure === "unknown" ? { inputRoute: "future" } : failure === "redirect" ? { inputRoute: "native" }
        : failure === "old-error" ? { ...legacy, error: "status unavailable" } : failure === "old-unknown" ? { ...legacy, inputRoute: "future" } : {} };
  } }) as never;
  const result = await captureLogs(() => makeCmd(deps).parseAsync(["node", "rig", "ask", "r", "question", "--wake", "dev@r", "--json"]).catch(error => { console.log(JSON.stringify({ thrown: error.message })); }));
  expect(post).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled();
  expect(result.exitCode).toBe(2);
  expect(JSON.parse(result.logs[0]!)).toMatchObject({ unavailable: true });
});

it("uses a live declared native wake and polls its exact request instead of a saved-session runner", async () => {
  const vendor: WakeRunner = vi.fn(); const deps = seatDeps(vendor, {});
  const calls: string[] = []; let requestId = "";
  deps.clientFactory = () => ({
    get: async (path: string) => {
      calls.push(path);
      return path.includes("/status/") ? { status: 200, data: { inputRoute: "native", nativeInput: { wake: true } } }
        : { status: 200, data: { receipt: { requestId, stage: "completed", result: { kind: "wake", completion: "completed", answer: "dedicated answer" } } } };
    },
    post: async (path: string, body: { requestId: string }) => { calls.push(path); requestId = body.requestId;
      return { status: 202, data: { runnerReceipt: { requestId, stage: "accepted" } } }; },
  }) as never;
  const result = await captureLogs(() => makeCmd(deps).parseAsync(["node", "rig", "ask", "r", "question", "--wake", "dev@r", "--json"]));
  expect(vendor).not.toHaveBeenCalled(); expect(requestId).toMatch(/^wake-/);
  expect(calls).toContain(`/api/seat/command/dev%40r?requestId=${requestId}`);
  expect(calls).not.toContain("/api/wake-resolve");
  expect(JSON.parse(result.logs[0]!)).toMatchObject({ requestId, receipt: { result: { answer: "dedicated answer" } } });
});
it("receiver state loss returns the uncertain native request without further polling or legacy fallback", async () => {
  const vendor: WakeRunner = vi.fn(); const deps = seatDeps(vendor, {}); let requestId = "";
  const get = vi.fn(async (path: string) => path.includes("/status/")
    ? { status: 200, data: { inputRoute: "native" } }
    : { status: 200, data: { receipt: { requestId, stage: "submitted", reconciliation: "receiver_state_lost" } } });
  const post = vi.fn(async (_path: string, body: { requestId: string }) => { requestId = body.requestId; return { status: 202, data: { runnerReceipt: { requestId, stage: "submitted" } } }; });
  deps.clientFactory = () => ({ get, post }) as never;
  const result = await captureLogs(() => makeCmd(deps).parseAsync(["node", "rig", "ask", "r", "question", "--wake", "dev@r", "--wake-timeout", "1", "--json"]));
  expect(result.exitCode).toBe(2); expect(vendor).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledOnce();
  expect(get).toHaveBeenCalledTimes(2);
  expect(JSON.parse(result.logs[0]!)).toMatchObject({ requestId, unavailable: true, receipt: { reconciliation: "receiver_state_lost" } });
});

it("a native caller timeout keeps its request ID/stage and never cancels or submits a fallback", async () => {
  const vendor: WakeRunner = vi.fn(); const deps = seatDeps(vendor, {}); const calls: string[] = []; let requestId = "";
  deps.clientFactory = () => ({
    get: async (path: string) => { calls.push(path); return path.includes("/status/")
      ? { status: 200, data: { inputRoute: "native", nativeInput: { wake: true } } }
      : { status: 200, data: { receipt: { requestId, stage: "accepted" } } }; },
    post: async (path: string, body: { requestId: string }) => { calls.push(path); requestId = body.requestId; return { status: 202, data: { runnerReceipt: { requestId, stage: "accepted" } } }; },
  }) as never;
  const result = await captureLogs(() => makeCmd(deps).parseAsync(["node", "rig", "ask", "r", "question", "--wake", "dev@r", "--wake-timeout", "1", "--json"]));
  expect(vendor).not.toHaveBeenCalled(); expect(calls.some(path => path.includes("cancel") || path.includes("wake-resolve"))).toBe(false);
  expect(JSON.parse(result.logs[0]!)).toMatchObject({ requestId: expect.stringMatching(/^wake-/), timedOut: true, receipt: { stage: "accepted" } });
  expect(result.exitCode).toBe(2);
});

it.each(["claude", "codex"])("keeps the historical %s wake on a typed route even when a runner advertises wake", async runtime => {
  const runner: WakeRunner = vi.fn(async () => ({ stdout: "legacy answer", stderr: "", code: 0, timedOut: false }));
  const deps = seatDeps(runner, { resolved: true, token: "original-token", runtime, sessionId: 7 });
  const client = deps.clientFactory();
  deps.clientFactory = () => ({ ...client, get: vi.fn(async () => ({ status: 200, data: { inputRoute: "typed", nativeInput: { wake: true } } })) }) as never;
  const result = await captureLogs(() => makeCmd(deps).parseAsync(["node", "rig", "ask", "r", "question", "--wake", "dev@r"]));
  expect(runner).toHaveBeenCalledOnce(); expect(result.exitCode).toBeUndefined();
  expect((deps as any).__post).toHaveBeenCalledWith("/api/wake-resolve", expect.anything());
});

it("refuses an explicitly selected native wake without a capable runner and never falls back", async () => {
  const runner: WakeRunner = vi.fn(); const deps = seatDeps(runner, {}); const calls: string[] = [];
  deps.clientFactory = () => ({
    get: async (path: string) => { calls.push(path); return { status: 200, data: { inputRoute: "native", nativeInput: { wake: false } } }; },
    post: async (path: string) => { calls.push(path); return { status: 409, data: { reason: "runner_unavailable" } }; },
  }) as never;
  const result = await captureLogs(() => makeCmd(deps).parseAsync(["node", "rig", "ask", "r", "question", "--wake", "dev@r", "--json"]));
  expect(runner).not.toHaveBeenCalled(); expect(result.exitCode).toBe(2);
  expect(calls).toEqual(["/api/seat/status/dev%40r", "/api/seat/command/dev%40r"]);
  expect(JSON.parse(result.logs[0]!)).toMatchObject({ error: "runner_unavailable" });
});
