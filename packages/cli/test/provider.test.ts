import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { providerCommand } from "../src/commands/provider.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

// Slice-04 (OPR.0.5.0.4) seam A — the `rig provider` CLI grammar, daemon-backed via DaemonClient
// (packet 3ffa3c22 §3). These prove the CLI reaches the real routes and its --json is stable and
// param-faithful; the routes/collection/switch composition are the B/C/D production seams.

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
function runningState(port: number): DaemonState {
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-03-26T00:00:00Z" };
}
function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(runningState(port)) : null)),
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
    await providerCommand(deps).parseAsync(["node", "rig", ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode;
  process.exitCode = origExit;
  return { logs, exitCode };
}

describe("rig provider CLI grammar (daemon-backed)", () => {
  let server: http.Server;
  let port: number;
  const seen: Array<{ url: string; method: string; body: string }> = [];

  const FOUR_BLOCK = {
    accounts: [{ accountId: "cdx-a", label: "Codex A", provider: "codex", authState: "active", profileRef: "p-a", asOf: "2026-08-03T12:00:00.000Z" }],
    bindings: [
      {
        accountId: null,
        seatSession: "seat-9",
        rigName: "r3",
        boundAt: null,
        bindingSource: null,
        anomalies: [{ kind: "seat_with_no_account", seat: "seat-9", evidence: "no bound account", asOf: "2026-08-03T12:00:00.000Z" }],
      },
    ],
    signals: [{ provider: "codex", accountRef: "cdx-a", sourceClass: "unknown", authority: "unknown", asOf: "2026-08-03T12:00:00.000Z", unknownReason: "codex_app_server_unavailable", automationUse: "do_not_automate" }],
    asOf: "2026-08-03T12:00:00.000Z",
  };

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ url: req.url ?? "", method: req.method ?? "", body });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      const path = (req.url ?? "").split("?")[0];
      if (path === "/api/provider/status") return send(200, FOUR_BLOCK);
      if (path === "/api/provider/accounts") {
        if ((req.url ?? "").includes("provider=bad")) return send(404, { error: "unknown provider: bad" });
        return send(200, { accounts: FOUR_BLOCK.accounts });
      }
      if (path === "/api/provider/bindings") return send(200, { bindings: FOUR_BLOCK.bindings });
      if (path === "/api/provider/signals") return send(200, { signals: FOUR_BLOCK.signals });
      if (path === "/api/provider/precheck") return send(200, { safe: false, reasons: ["target_needs_reauth"] });
      if (path === "/api/provider/switch") {
        if (body.includes("bad")) return send(400, { error: "invalid target account" });
        return send(200, { outcome: "succeeded" });
      }
      return send(500, { error: "not found" });
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  it("status --json emits the four-block read model verbatim", async () => {
    const { logs, exitCode } = await run(["status", "--json"], runningDeps(port));
    expect(exitCode).toBeFalsy();
    const out = JSON.parse(logs.join("\n"));
    expect(out).toEqual(FOUR_BLOCK);
  });

  it("accounts --provider passes the filter as a query param and --json emits the block", async () => {
    seen.length = 0;
    const { logs } = await run(["accounts", "--provider", "codex", "--json"], runningDeps(port));
    expect(seen.some((r) => r.url.includes("/api/provider/accounts") && r.url.includes("provider=codex"))).toBe(true);
    expect(JSON.parse(logs.join("\n"))).toEqual({ accounts: FOUR_BLOCK.accounts });
  });

  it("precheck --seat --to-account passes params and --json emits the safety verdict", async () => {
    seen.length = 0;
    const { logs, exitCode } = await run(["precheck", "--seat", "s1", "--to-account", "cdx-b", "--json"], runningDeps(port));
    const req = seen.find((r) => r.url.includes("/api/provider/precheck"));
    expect(req).toBeDefined();
    expect(req!.url).toContain("seat=s1");
    expect(req!.url).toContain("toAccount=cdx-b");
    expect(JSON.parse(logs.join("\n"))).toEqual({ safe: false, reasons: ["target_needs_reauth"] });
    // an unsafe precheck exits nonzero so scripts can gate.
    expect(exitCode).toBe(1);
  });

  it("switch POSTs seat/to-account and --json emits the outcome", async () => {
    seen.length = 0;
    const { logs } = await run(["switch", "--seat", "s1", "--to-account", "cdx-b", "--json"], runningDeps(port));
    const req = seen.find((r) => r.url.includes("/api/provider/switch") && r.method === "POST");
    expect(req).toBeDefined();
    const sentBody = JSON.parse(req!.body);
    expect(sentBody).toMatchObject({ seat: "s1", toAccount: "cdx-b" });
    expect(JSON.parse(logs.join("\n"))).toEqual({ outcome: "succeeded" });
  });

  it("a 4xx on a read is an ERROR (prints daemon payload, exit 1) — never accepted as success", async () => {
    const { logs, exitCode } = await run(["accounts", "--provider", "bad", "--json"], runningDeps(port));
    expect(exitCode).toBe(1);
    expect(logs.join(" ")).toMatch(/unknown provider/i);
  });

  it("a 4xx on switch is an ERROR (prints payload, exit 1) — never outcome-undefined exit-0 success", async () => {
    const { logs, exitCode } = await run(["switch", "--seat", "s1", "--to-account", "bad", "--json"], runningDeps(port));
    expect(exitCode).toBe(1);
    expect(logs.join(" ")).toMatch(/invalid target/i);
  });

  it("status (human) renders the §3 projection: account rows, first-class anomaly flags, signal summary", async () => {
    const { logs } = await run(["status"], runningDeps(port));
    const out = logs.join("\n");
    expect(out).toContain("ACCOUNTS");
    expect(out).toContain("Codex A");
    expect(out).toContain("(codex)");
    expect(out).toContain("ANOMALIES");
    expect(out).toMatch(/seat with no bound account: seat-9/);
    expect(out).toMatch(/SIGNALS \(1;/); // freshest-signal summary
  });

  it("reports honestly when the daemon is not running", async () => {
    const downDeps: StatusDeps = {
      lifecycleDeps: mockLifecycleDeps({ exists: vi.fn(() => false), fetch: vi.fn(async () => { throw new Error("refused"); }) }),
      clientFactory: (u) => new DaemonClient(u),
    };
    const { logs, exitCode } = await run(["status", "--json"], downDeps);
    expect(exitCode).toBe(1);
    expect(logs.join(" ")).toMatch(/not running/i);
  });
});
