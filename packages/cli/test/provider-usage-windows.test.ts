import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { providerCommand } from "../src/commands/provider.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

// Slice 01 (OPR.0.7.0.1) — `rig provider status` with Codex usage windows: the USAGE section only
// when the daemon serves `usage` (switch on), level and freshness side by side, a failed refresh
// beside the kept reading, and `--refresh` refusing clearly while the switch is off.

const MODEL = { accounts: [], bindings: [], signals: [], hostUsage: [], asOf: "2026-10-12T20:06:00.000Z" };
const WINDOW = { window: "secondary", durationMins: 10080, usedPercent: 100, remainingPercent: 0, resetsAt: "2026-10-14T00:00:00.000Z", observedAt: "2026-10-12T20:00:00.000Z" };
const READING = {
  provider: "codex",
  identity: { accountId: "acct-1", workspaceId: null, limitId: "codex", email: "dev@example.test", planType: "plus", source: "account/rateLimits/read accountId" },
  source: { kind: "codex_app_server", host: "local" },
  observedAt: "2026-10-12T20:00:00.000Z",
  seats: "unknown",
  windows: [
    { ...WINDOW, window: "primary", durationMins: 300, usedPercent: 41, remainingPercent: 59, level: "ok", freshness: "stale", freshnessReason: "refresh failed at 2026-10-12T20:05:00.000Z; this reading is older" },
    { ...WINDOW, level: "exhausted", levelReason: "at the limit", freshness: "stale", freshnessReason: "refresh failed at 2026-10-12T20:05:00.000Z; this reading is older" },
  ],
  limitEvidence: "rate_limit_reached",
  latestFromSource: true,
  lastRefresh: { at: "2026-10-12T20:05:00.000Z", outcome: "failed", reason: "timeout", detail: "codex app-server did not answer within 35000 ms" },
  currentAvailability: "unknown",
};

let model: Record<string, unknown> = MODEL;
let refreshReply: { status: number; body: unknown } = { status: 200, body: {} };
let refreshByProvider: Record<string, { status: number; body: unknown }> = {};
const posts: unknown[] = [];

function deps(port: number): StatusDeps {
  const lifecycleDeps = {
    spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port, db: "t", startedAt: "x" }) : null)),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((p: string) => p === STATE_FILE), mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  } as unknown as LifecycleDeps;
  return { lifecycleDeps, clientFactory: (url) => new DaemonClient(url) };
}

async function run(args: string[], port: number): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [], err: string[] = [];
  const origLog = console.log, origErr = console.error;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  try {
    await providerCommand(deps(port)).parseAsync(["node", "rig", ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return { out: out.join("\n"), err: err.join("\n"), exitCode };
}

describe("rig provider status — usage windows", () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
        if (req.method === "GET" && req.url === "/api/provider/status") return send(200, model);
        if (req.method === "POST" && req.url === "/api/provider/usage/refresh") {
          const parsed = JSON.parse(body || "{}") as { provider: string };
          posts.push(parsed);
          const reply = refreshByProvider[parsed.provider] ?? refreshReply;
          return send(reply.status, reply.body);
        }
        send(404, { error: "not found" });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => { model = MODEL; posts.length = 0; refreshByProvider = {}; });

  it("switch off (no usage key): no USAGE section", async () => {
    const { out } = await run(["status"], port);
    expect(out).not.toContain("USAGE");
  });

  it("an allowance row: identity labels, each window's level and freshness with its own time, limit evidence, the failure beside the reading", async () => {
    model = { ...MODEL, usage: [READING] };
    const { out } = await run(["status"], port);
    expect(out).toContain([
      "USAGE (read on request: rig provider status --refresh)",
      "  codex  account acct-1 · bucket codex · dev@example.test · plus · seats unknown",
      "    5h (primary)  59% left  ok  resets 2026-10-14T00:00:00.000Z  observed 2026-10-12T20:00:00.000Z (stale: refresh failed at 2026-10-12T20:05:00.000Z; this reading is older)",
      "    weekly (secondary)  0% left  exhausted (at the limit)  resets 2026-10-14T00:00:00.000Z  observed 2026-10-12T20:00:00.000Z (stale: refresh failed at 2026-10-12T20:05:00.000Z; this reading is older)",
      "    limit evidence: rate_limit_reached",
      "    refresh failed at 2026-10-12T20:05:00.000Z: timeout (codex app-server did not answer within 35000 ms); last reading kept, marked old",
      "    current availability: unknown",
    ].join("\n"));
  });

  it("an unavailable row and a last-seen row say so", async () => {
    model = { ...MODEL, usage: [
      { provider: "codex", identity: null, windows: [], unavailableReason: "no reading since the daemon started at T; refresh with rig provider status --refresh" },
      { ...READING, identity: { ...READING.identity, accountId: null, workspaceId: "ws-a", source: "account/read workspace routing" }, latestFromSource: false, lastRefresh: { at: "x", outcome: "ok" } },
      { ...READING, identity: { ...READING.identity, accountId: null, source: "unresolved" }, lastRefresh: { at: "x", outcome: "ok" },
        unresolved: { note: "identity unresolved: not matched to, merged with or replacing any other row", keptReads: 3, droppedReads: 2 } },
    ] };
    const { out } = await run(["status"], port);
    expect(out).toContain("  codex  unavailable: no reading since the daemon started at T; refresh with rig provider status --refresh");
    expect(out).toContain("  codex  workspace ws-a (from account/read; no usage account id) · bucket codex · dev@example.test · plus · seats unknown  [from an earlier read; the latest read didn't match this row]");
    expect(out).toContain("  codex  identity unresolved · bucket codex · dev@example.test · plus · seats unknown\n    not matched to, merged with or replacing any other row; kept from the 3 most recent unresolved reads (2 older dropped)");
    expect(out).not.toContain("last reading kept, marked old");
  });

  it("an older unresolved row says only that it's from an earlier read, never 'another account'", async () => {
    const unresolved = { note: "identity unresolved: not matched to, merged with or replacing any other row", keptReads: 3, droppedReads: 0 };
    const id = { ...READING.identity, accountId: null, source: "unresolved" };
    model = { ...MODEL, usage: [
      { ...READING, identity: id, latestFromSource: false, unresolved },
      { ...READING, identity: id, latestFromSource: true, unresolved },
    ] };
    const { out } = await run(["status"], port);
    const heads = out.split("\n").filter((l) => l.startsWith("  codex  identity unresolved"));
    expect(heads).toEqual([
      "  codex  identity unresolved · bucket codex · dev@example.test · plus · seats unknown  [from an earlier read; possibly this same login]",
      "  codex  identity unresolved · bucket codex · dev@example.test · plus · seats unknown",
    ]);
    expect(out).not.toContain("another account");
  });

  it("a resolved row followed by an unresolved read is labelled by the read, not as another account", async () => {
    model = { ...MODEL, usage: [
      { ...READING, latestFromSource: false },
      { ...READING, identity: { ...READING.identity, accountId: null, source: "unresolved" }, latestFromSource: true,
        unresolved: { note: "identity unresolved: not matched to, merged with or replacing any other row", keptReads: 3, droppedReads: 0 } },
    ] };
    const { out } = await run(["status"], port);
    expect(out).toContain("  codex  account acct-1 · bucket codex · dev@example.test · plus · seats unknown  [from an earlier read; the latest read didn't match this row]");
    expect(out).not.toContain("another account");
  });

  it("saved rig auth profiles: one line when the daemon says they weren't read; nothing otherwise", async () => {
    const savedProfiles = { names: ["personal", "work"], note: "saved rig auth profiles: not read (usage unknown); this reading is only the login active in the daemon's CODEX_HOME" };
    model = { ...MODEL, usage: [{ ...READING, savedProfiles }] };
    const { out } = await run(["status"], port);
    expect(out.split("\n").filter((l) => l.includes("saved rig auth profiles"))).toEqual([
      "  saved rig auth profiles: not read (usage unknown); this reading is only the login active in the daemon's CODEX_HOME: personal, work",
    ]);
    expect(JSON.parse((await run(["status", "--json"], port)).out).usage[0].savedProfiles).toEqual(savedProfiles);
    model = { ...MODEL, usage: [READING] };
    expect((await run(["status"], port)).out).not.toContain("saved rig auth profiles");
  });

  it("a Claude row: organisation identity, bucket, email label, its windows", async () => {
    model = { ...MODEL, usage: [{
      provider: "claude",
      identity: { orgId: "org-1", limitId: "all models", email: "d***@example.test", source: "claude auth status orgId" },
      source: { kind: "claude_usage_screen", host: "local" }, observedAt: "2026-10-12T20:00:00.000Z", seats: "unknown",
      windows: [{ window: "current_week", durationMins: 10080, usedPercent: 85, remainingPercent: 15, resetsAt: "2026-10-14T09:00:00.000Z", observedAt: "2026-10-12T20:00:00.000Z", level: "nearing", levelReason: "80% or more used", freshness: "fresh" }],
      limitEvidence: null, latestFromSource: true, lastRefresh: { at: "2026-10-12T20:00:00.000Z", outcome: "ok" }, currentAvailability: "known",
    }] };
    const { out } = await run(["status"], port);
    expect(out).toContain([
      "  claude  organisation org-1 · bucket all models · d***@example.test · seats unknown",
      "    weekly (current_week)  15% left  nearing (80% or more used)  resets 2026-10-14T09:00:00.000Z  observed 2026-10-12T20:00:00.000Z (fresh)",
      "    current availability: known",
    ].join("\n"));
  });

  it("--refresh reads both providers in parallel; one failure exits 1 and the status still prints", async () => {
    model = { ...MODEL, usage: [READING] };
    refreshByProvider = {
      codex: { status: 200, body: { refresh: { at: "t", outcome: "ok", coalesced: false }, usage: [] } },
      claude: { status: 200, body: { refresh: { at: "t", outcome: "failed", reason: "interaction_required", coalesced: false }, usage: [] } },
    };
    const r = await run(["status", "--refresh"], port);
    expect(posts).toEqual([{ provider: "codex" }, { provider: "claude" }]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("USAGE");
    posts.length = 0;
    const one = await run(["status", "--refresh", "--provider", "claude"], port);
    expect(posts).toEqual([{ provider: "claude" }]);
    expect(one.exitCode).toBe(1);
  });

  it("one provider's HTTP error is printed, the status still prints, and the exit is 1", async () => {
    model = { ...MODEL, usage: [READING] };
    refreshByProvider = {
      codex: { status: 200, body: { refresh: { at: "t", outcome: "ok", coalesced: false }, usage: [] } },
      claude: { status: 400, body: { error: "claude usage windows are not available on this daemon" } },
    };
    const r = await run(["status", "--refresh"], port);
    expect(r.err).toBe("claude usage windows are not available on this daemon");
    expect(r.out).toContain("USAGE");
    expect(r.exitCode).toBe(1);
    refreshByProvider = { claude: { status: 503, body: { error: "provider_service_unavailable" } },
      codex: { status: 200, body: { refresh: { at: "t", outcome: "ok", coalesced: false }, usage: [] } } };
    const five = await run(["status", "--refresh"], port);
    expect([five.err, five.exitCode]).toEqual(["provider_service_unavailable", 2]);
    expect(five.out).toContain("USAGE");
  });

  it("--provider takes codex or claude only", async () => {
    const r = await run(["status", "--refresh", "--provider", "gemini"], port);
    expect([r.err, r.exitCode]).toEqual(["--provider must be codex or claude (got gemini)", 1]);
    expect(posts).toEqual([]);
  });

  it("--json stays verbatim", async () => {
    model = { ...MODEL, usage: [READING] };
    expect(JSON.parse((await run(["status", "--json"], port)).out)).toEqual(model);
  });

  it("--refresh while the switch is off: the daemon's message, exit 1, no status", async () => {
    refreshReply = { status: 409, body: { error: "usage_windows_disabled", message: "Codex usage windows are off. Turn them on with: rig config set provider.usage_windows true" } };
    const r = await run(["status", "--refresh"], port);
    expect(r.err).toBe("Codex usage windows are off. Turn them on with: rig config set provider.usage_windows true");
    expect(r.out).toBe("");
    expect(r.exitCode).toBe(1);
    // Without --provider both are read; the switch-off line is printed once.
    expect(posts).toEqual([{ provider: "codex" }, { provider: "claude" }]);
    posts.length = 0;
    const codexOnly = await run(["status", "--refresh", "--provider", "codex"], port);
    expect([codexOnly.err, codexOnly.out, codexOnly.exitCode]).toEqual([r.err, r.out, r.exitCode]);
    expect(posts).toEqual([{ provider: "codex" }]);
  });

  it("--refresh ok prints the status; a failed refresh prints it too and exits 1", async () => {
    model = { ...MODEL, usage: [READING] };
    refreshReply = { status: 200, body: { refresh: { at: "t", outcome: "ok", coalesced: false }, usage: [] } };
    const ok = await run(["status", "--refresh"], port);
    expect(ok.exitCode).toBeUndefined();
    expect(ok.out).toContain("USAGE");
    refreshReply = { status: 200, body: { refresh: { at: "t", outcome: "failed", reason: "binary_not_found", coalesced: false }, usage: [] } };
    const failed = await run(["status", "--refresh", "--json"], port);
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.out)).toEqual(model);
  });
});
