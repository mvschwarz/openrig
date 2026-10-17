// 51-08 A4 — `rig usage` CLI (plan-lock rev-1, PM decision 4: the SAME projection
// serves CLI + HTTP). Param-faithful daemon-backed grammar per the provider.ts
// precedent: values must ARRIVE at the route (option-parity doctrine), --json is
// verbatim, and the human render keeps the honest-unknown rail explicit.
// RED-first: written before commands/usage.ts existed.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import http from "node:http";
import { usageCommand } from "../src/commands/usage.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
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
    ...overrides,
  };
}
function runningDeps(port: number): StatusDeps {
  const state: DaemonState = { pid: 123, port, db: "test.sqlite", startedAt: "2026-03-26T00:00:00Z" };
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(state) : null)),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}
async function run(args: string[], deps: StatusDeps): Promise<{ logs: string[]; errors: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log, origErr = console.error, origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    await usageCommand(deps).parseAsync(["node", "rig", ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode;
  process.exitCode = origExit;
  return { logs, errors, exitCode };
}

const TOP_PAYLOAD = {
  windowHours: 1.5,
  sinceIso: "2026-08-07T10:30:00.000Z",
  ranked: [
    { seatSession: "burner@r", tokensPerHour: 300000, tokensDelta: 600000, resets: 0, spanHours: 2, samples: 3, windows: [] },
  ],
  unknown: [{ seatSession: "stale@r", reason: "no_fresh_samples" }],
  totalRankedSeats: 1,
};
const SERIES_PAYLOAD = { rows: [{ id: 1, lane: "context", seatSession: "a@r", capturedAt: "t1", totalInputTokens: 5 }] };
// What the route serves for since=garbage: main's (empty) rows plus the advisory.
const ADVISED_PAYLOAD = {
  rows: [],
  advisories: ['since "garbage" was not recognised as a date or time; the existing text comparison against captured_at was used'],
};

describe("rig usage CLI grammar (daemon-backed)", () => {
  let server: http.Server;
  let port: number;
  const seen: Array<{ url: string }> = [];
  let failure: { status: number; data: Record<string, unknown> } | undefined;

  beforeEach(() => { failure = undefined; });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? "" });
      res.setHeader("content-type", "application/json");
      if (failure) {
        res.statusCode = failure.status;
        res.end(JSON.stringify(failure.data));
        return;
      }
      if ((req.url ?? "").includes("/usage/top")) res.end(JSON.stringify(TOP_PAYLOAD));
      else if ((req.url ?? "").includes("since=garbage")) res.end(JSON.stringify(ADVISED_PAYLOAD));
      else res.end(JSON.stringify(SERIES_PAYLOAD));
    });
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  it("usage top --window 90m --top 5 --json: the parsed window ARRIVES as window_hours=1.5 and --json is verbatim", async () => {
    seen.length = 0;
    const { logs, exitCode } = await run(["top", "--window", "90m", "--top", "5", "--json"], runningDeps(port));
    expect(exitCode).toBeUndefined();
    expect(seen[0]!.url).toContain("/api/telemetry/usage/top");
    expect(seen[0]!.url).toContain("window_hours=1.5");
    expect(seen[0]!.url).toContain("top=5");
    expect(JSON.parse(logs.join("\n"))).toEqual(TOP_PAYLOAD); // byte-faithful projection
  });

  it("usage top human render: burner ranked with tokens/hour AND the unknown rail explicit (never 0)", async () => {
    const { logs } = await run(["top", "--window", "1h"], runningDeps(port));
    const out = logs.join("\n");
    expect(out).toContain("burner@r");
    expect(out).toMatch(/300[,.]?000|300k/i);
    expect(out).toContain("stale@r");
    expect(out).toMatch(/no_fresh_samples|unknown/i);
  });

  it("usage series --seat a@r --json passes the seat through and serves rows verbatim", async () => {
    seen.length = 0;
    const { logs } = await run(["series", "--seat", "a@r", "--json"], runningDeps(port));
    expect(seen[0]!.url).toContain("/api/telemetry/usage/series");
    expect(seen[0]!.url).toContain("seat=a%40r");
    expect(JSON.parse(logs.join("\n"))).toEqual(SERIES_PAYLOAD);
  });

  it("usage series --since garbage prints the advisory on stderr and keeps the empty series on stdout", async () => {
    const { logs, errors, exitCode } = await run(["series", "--since", "garbage"], runningDeps(port));
    expect(errors).toEqual([`note: ${ADVISED_PAYLOAD.advisories[0]}`]);
    expect(logs).toEqual(["no samples match — the series is empty for this filter"]);
    expect(exitCode).toBeUndefined();
  });

  it("usage series --since garbage --json stays one payload carrying the advisory, nothing on stderr", async () => {
    const { logs, errors, exitCode } = await run(["series", "--since", "garbage", "--json"], runningDeps(port));
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toEqual(ADVISED_PAYLOAD);
    expect(errors).toEqual([]);
    expect(exitCode).toBeUndefined();
  });

  it("usage series with no advisory prints rows and nothing on stderr", async () => {
    const { logs, errors, exitCode } = await run(["series", "--since", "2026-08-07T11"], runningDeps(port));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("a@r");
    expect(errors).toEqual([]);
    expect(exitCode).toBeUndefined();
  });

  it("an unparseable --window is a teaching error, exit 1, no request fired", async () => {
    seen.length = 0;
    const { logs, errors, exitCode } = await run(["top", "--window", "soon"], runningDeps(port));
    expect(exitCode).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toMatch(/--window/);
    expect(errors.join("\n")).toMatch(/1h|90m|2d/); // teaches the accepted forms
    expect(seen.length).toBe(0);
  });

  describe.each(["top", "series"])("usage %s HTTP errors", (command) => {
    it.each([400, 503])("keeps an HTTP %s response intact on stdout with --json", async (status) => {
      failure = { status, data: { error: "usage query failed", detail: "fixture error detail" } };
      const { logs, errors, exitCode } = await run([command, "--json"], runningDeps(port));

      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual(failure.data);
      expect(errors).toEqual([]);
      expect(exitCode).toBe(status >= 500 ? 2 : 1);
    });

    it.each([400, 503])("keeps HTTP %s errors on stderr in human output", async (status) => {
      failure = { status, data: { error: "usage query failed" } };
      const { logs, errors, exitCode } = await run([command], runningDeps(port));

      expect(logs).toEqual([]);
      expect(errors).toEqual([failure.data.error]);
      expect(exitCode).toBe(status >= 500 ? 2 : 1);
    });
  });
});

describe("rig usage cost lines (OPR.0.7.0.2)", () => {
  it("labels a Claude estimate, its window and staleness; never prints a dollar figure for absent or Codex seats", async () => {
    const { costLine } = await import("../src/commands/usage.js");
    const reported = costLine({ seatSession: "dev@r", status: "reported", costUsd: 1.5, resets: 1, stale: true, ageSeconds: 900,
      window: { nativeSessionId: "s1", since: "2026-10-13T10:00:00.000Z", asOf: "2026-10-13T10:05:00.000Z" }, tokens: { input: 10, output: 2 } });
    expect(reported).toContain("$1.50 client-side estimate (Claude statusline) for session s1 since 2026-10-13T10:00:00.000Z");
    expect(reported).toContain("1 reset");
    expect(reported).toContain("STALE (900s old; kept as history)");
    const absent = costLine({ seatSession: "dev@r", status: "absent", reason: "Claude's statusline has reported no cost for this session", tokens: { input: 1, output: 1 } });
    expect(absent).toContain("cost: not reported");
    expect(absent).not.toContain("$");
    const codex = costLine({ seatSession: "cx@r", status: "no-cost-method", note: "no cost reported by the inspected method (Codex token_count events carry tokens only)", tokens: { input: 5000, output: 400 } });
    expect(codex).toContain("tokens in 5000 / out 400");
    expect(codex).not.toContain("$");
  });
});

describe("rig usage cost: a tiny estimate never reads as zero (OPR.0.7.0.2)", () => {
  it("prints <$0.01 below half a cent, rounds normally above, and keeps an exact reported zero", async () => {
    const { formatUsd, costLine } = await import("../src/commands/usage.js");
    expect(formatUsd(0.0004)).toBe("<$0.01");
    expect(formatUsd(0.0049)).toBe("<$0.01");
    expect(formatUsd(0.005)).toBe("$0.01");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0)).toBe("$0.00");
    const line = costLine({ seatSession: "dev@r", status: "reported", costUsd: 0.0003, resets: 0, stale: false, ageSeconds: 5,
      window: { nativeSessionId: "s1", since: "2026-10-13T10:00:00.000Z", asOf: "2026-10-13T10:00:05.000Z" }, tokens: { input: 1, output: 1 } });
    expect(line).toContain("<$0.01 client-side estimate");
    expect(line).not.toContain("$0.00");
  });
});

describe("rig usage cost: Pi seats (OPR.0.7.0.2)", () => {
  it("names the model-priced estimate, its session and what isn't in it", async () => {
    const { costLine } = await import("../src/commands/usage.js");
    const line = costLine({ seatSession: "devpi@r", runtime: "pi", status: "reported", costUsd: 0.0675,
      window: { piSessionId: "fork-1", since: "2026-10-13T16:00:09.000Z", asOf: "2026-10-13T16:00:10.000Z" },
      entries: { own: 2, ownWithoutCost: 1, errorOrAborted: 2, inherited: { count: 5, costUsd: 0.0175 }, unknownOrigin: { count: 0, costUsd: null } },
      tokens: { input: 200, output: 40 } });
    expect(line).toContain("$0.07 model-priced estimate (Pi persisted entries, 2 own entries) for Pi session fork-1");
    expect(line).toContain("1 entry without a cost");
    expect(line).toContain("2 error/aborted turns included");
    expect(line).toContain("5 inherited from the fork, not counted ($0.02)");
    const absent = costLine({ seatSession: "devpi@r", runtime: "pi", status: "absent", reason: "Pi recorded no cost on this session's own entries",
      window: { piSessionId: "s" }, entries: { own: 1, ownWithoutCost: 1 }, tokens: { input: 1, output: 1 } });
    expect(absent).toContain("cost: not reported (Pi recorded no cost on this session's own entries)");
    expect(absent).not.toContain("$0.00");
  });
});

describe("rig usage cost: OpenRouter charge beside the Pi estimate (OPR.0.7.0.2 K4)", () => {
  const seat = (providerCharge: Record<string, unknown>) => ({ seatSession: "devpi@r", runtime: "pi", status: "reported", costUsd: 0.18,
    window: { piSessionId: "s1" }, entries: { own: 4 }, tokens: { input: 1, output: 1 }, providerCharge });
  it("names the provider charge, its coverage and account context, apart from the estimate", async () => {
    const { costLine } = await import("../src/commands/usage.js");
    const line = costLine(seat({ status: "partial", costUsd: 0.042, estimateForChargedUsd: 0.03,
      requests: { covered: 3, charged: 2, pending: 0, unavailable: { count: 1, reasons: { "not available after 5 lookups (last: HTTP 404)": 1 } }, notCovered: { count: 1 } },
      accountContext: { credentialSources: ["OPENROUTER_API_KEY (forwarded by OpenRig)"] } }));
    expect(line).toContain("$0.18 model-priced estimate");
    expect(line).toContain("OpenRouter charge $0.04 USD for 2 of 3 requests via OPENROUTER_API_KEY (forwarded by OpenRig), Pi estimate for them $0.03");
    expect(line).toContain("1 unavailable (not available after 5 lookups (last: HTTP 404)), 1 not covered (provider-reported, not added to the estimate)");
  });
  it("says unavailable or not looked up, never a $0 charge", async () => {
    const { costLine } = await import("../src/commands/usage.js");
    const unavailable = costLine(seat({ status: "unavailable", requests: { covered: 1, unavailable: { count: 1, reasons: { "HTTP 401": 1 } }, notCovered: { count: 0 } } }));
    expect(unavailable).toContain("OpenRouter charge unavailable (HTTP 401)");
    expect(unavailable).not.toContain("$0.00");
    expect(costLine(seat({ status: "none", requests: { covered: 2, notCovered: { count: 0 } } }))).toContain("OpenRouter charge not looked up");
    expect(costLine(seat({ status: "not-applicable", requests: { covered: 0, notCovered: { count: 0 } } }))).not.toContain("OpenRouter");
  });
});
