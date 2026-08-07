// 51-08 A4 — `rig usage` CLI (plan-lock rev-1, PM decision 4: the SAME projection
// serves CLI + HTTP). Param-faithful daemon-backed grammar per the provider.ts
// precedent: values must ARRIVE at the route (option-parity doctrine), --json is
// verbatim, and the human render keeps the honest-unknown rail explicit.
// RED-first: written before commands/usage.ts existed.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
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
async function run(args: string[], deps: StatusDeps): Promise<{ logs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const origLog = console.log, origErr = console.error, origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    await usageCommand(deps).parseAsync(["node", "rig", ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode;
  process.exitCode = origExit;
  return { logs, exitCode };
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

describe("rig usage CLI grammar (daemon-backed)", () => {
  let server: http.Server;
  let port: number;
  const seen: Array<{ url: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? "" });
      res.setHeader("content-type", "application/json");
      if ((req.url ?? "").includes("/usage/top")) res.end(JSON.stringify(TOP_PAYLOAD));
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

  it("an unparseable --window is a teaching error, exit 1, no request fired", async () => {
    seen.length = 0;
    const { logs, exitCode } = await run(["top", "--window", "soon"], runningDeps(port));
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toMatch(/--window/);
    expect(logs.join("\n")).toMatch(/1h|90m|2d/); // teaches the accepted forms
    expect(seen.length).toBe(0);
  });
});
