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
const sortedPosts = () => [...posts].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

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

  it("shows why current availability is unknown even when a Claude row has windows", async () => {
    model = { ...MODEL, usage: [{ ...READING, provider: "claude", unavailableReason: "Windows are seat samples, not a current availability check." }] };
    const { out, exitCode } = await run(["status"], port);
    expect(exitCode).toBeFalsy();
    expect(out).toContain("5h (primary)");
    expect(out).toContain("current availability: unknown");
    expect(out).toContain("Windows are seat samples, not a current availability check.");
    const json = await run(["status", "--json"], port);
    expect(JSON.parse(json.out)).toEqual(model);
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

  it("a Claude row: organisation (name and id), bucket, email, subscription, how identity and windows were joined, each window's seat", async () => {
    const note = "identity: the daemon's Claude login (claude auth status) as of the refresh at 2026-10-12T20:05:00.000Z; windows: status-line readings from dev@rig at their own times; not proven to be the same login";
    model = { ...MODEL, usage: [{
      provider: "claude",
      identity: { orgId: "org-1", limitId: "all models", email: "d***@example.test", orgName: "Example Org", subscriptionType: "team", source: "claude auth status orgId and email" },
      source: { kind: "claude_statusline_samples", host: "local" }, observedAt: "2026-10-12T20:00:00.000Z", seats: "unknown",
      windows: [{ window: "weekly", durationMins: 10080, usedPercent: 85, remainingPercent: 15, resetsAt: "2026-10-14T09:00:00.000Z", observedAt: "2026-10-12T20:00:00.000Z", seatSession: "dev@rig", level: "nearing", levelReason: "80% or more used", freshness: "fresh" }],
      limitEvidence: null, latestFromSource: true, lastRefresh: { at: "2026-10-12T20:05:00.000Z", outcome: "ok" }, currentAvailability: "known", identityNote: note,
    }] };
    const { out } = await run(["status"], port);
    expect(out).toContain([
      "  claude  organisation Example Org (org-1) · bucket all models · d***@example.test · team · seats unknown",
      `    ${note}`,
      "    weekly (weekly)  15% left  nearing (80% or more used)  resets 2026-10-14T09:00:00.000Z  observed 2026-10-12T20:00:00.000Z by seat dev@rig (fresh)",
      "    current availability: known",
    ].join("\n"));
  });

  it("seats that disagree: each other seat's own numbers print under the window", async () => {
    model = { ...MODEL, usage: [{
      provider: "claude", identity: { orgId: "org-1", limitId: "all models", email: "d***@example.test", orgName: null, subscriptionType: null, source: "claude auth status orgId and email" },
      source: { kind: "claude_statusline_samples", host: "local" }, observedAt: "2026-10-12T20:00:00.000Z", seats: "unknown", limitEvidence: null, latestFromSource: true,
      currentAvailability: "unknown", lastRefresh: null,
      windows: [{ window: "weekly", durationMins: 10080, usedPercent: 10, remainingPercent: 90, resetsAt: "2026-10-14T09:00:00.000Z", observedAt: "2026-10-12T20:00:00.000Z",
        seatSession: "a@rig", level: "unknown", levelReason: "Claude seats report different windows (possibly different logins): a@rig, b@rig", freshness: "fresh",
        disagreeingSeats: [{ seatSession: "b@rig", usedPercent: 90, resetsAt: "2026-10-16T09:00:00.000Z", observedAt: "2026-10-12T19:59:00.000Z" }] }],
    }] };
    const { out } = await run(["status"], port);
    expect(out).toContain([
      "    weekly (weekly)  90% left  unknown (Claude seats report different windows (possibly different logins): a@rig, b@rig)  resets 2026-10-14T09:00:00.000Z  observed 2026-10-12T20:00:00.000Z by seat a@rig (fresh)",
      "      seat b@rig reports 10% left  resets 2026-10-16T09:00:00.000Z  observed 2026-10-12T19:59:00.000Z",
    ].join("\n"));
  });

  it("a Claude identity refresh that failed says the identity is from the last refresh that worked; no seat yet says so", async () => {
    model = { ...MODEL, usage: [{
      provider: "claude", identity: null, source: { kind: "claude_statusline_samples", host: "local" }, observedAt: null, seats: "unknown", windows: [],
      limitEvidence: null, latestFromSource: true, currentAvailability: "unknown", unavailableReason: "no Claude seat has reported status-line rate limits yet",
      lastRefresh: { at: "2026-10-12T20:05:00.000Z", outcome: "failed", reason: "not_logged_in", detail: "claude auth status reports no login (exit 1)" },
    }, {
      provider: "claude", identity: { orgId: "org-1", limitId: "all models", email: "d***@example.test", orgName: null, subscriptionType: null, source: "claude auth status orgId and email" },
      source: { kind: "claude_statusline_samples", host: "local" }, observedAt: null, seats: "unknown", windows: [], limitEvidence: null, latestFromSource: true,
      currentAvailability: "unknown", unavailableReason: "no Claude seat has reported status-line rate limits yet",
      lastRefresh: { at: "2026-10-12T20:05:00.000Z", outcome: "failed", reason: "not_logged_in", detail: "claude auth status reports no login (exit 1)" },
    }] };
    const { out } = await run(["status"], port);
    expect(out).toContain("  claude  unavailable: no Claude seat has reported status-line rate limits yet");
    expect(out).toContain([
      "  claude  organisation org-1 · bucket all models · d***@example.test · seats unknown",
      "    no Claude seat has reported status-line rate limits yet",
      "    identity refresh failed at 2026-10-12T20:05:00.000Z: not_logged_in (claude auth status reports no login (exit 1)); the identity shown is from the last refresh that worked, if any",
    ].join("\n"));
  });

  it("--refresh reads both providers in parallel; one failure exits 1 and the status still prints", async () => {
    model = { ...MODEL, usage: [READING] };
    refreshByProvider = {
      codex: { status: 200, body: { refresh: { at: "t", outcome: "ok", coalesced: false }, usage: [] } },
      claude: { status: 200, body: { refresh: { at: "t", outcome: "failed", reason: "interaction_required", coalesced: false }, usage: [] } },
    };
    const r = await run(["status", "--refresh"], port);
    // Sent together; which one the server finishes reading first isn't fixed.
    expect(sortedPosts()).toEqual([{ provider: "claude" }, { provider: "codex" }]);
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
    const r = await run(["status", "--refresh", "--provider", "claude"], port);
    expect(r.err).toBe("claude usage windows are not available on this daemon");
    expect(r.out).toContain("USAGE");
    expect(r.exitCode).toBe(1);
    refreshByProvider = { codex: { status: 500, body: { error: "boom" } }, claude: refreshByProvider.claude! };
    const codexFails = await run(["status", "--refresh"], port);
    expect(codexFails.exitCode).toBe(2);
    expect(codexFails.out).toContain("USAGE");
    refreshByProvider = { claude: { status: 503, body: { error: "provider_service_unavailable" } },
      codex: { status: 200, body: { refresh: { at: "t", outcome: "ok", coalesced: false }, usage: [] } } };
    const five = await run(["status", "--refresh"], port);
    expect([five.err, five.exitCode]).toEqual(["provider_service_unavailable", 2]);
    expect(five.out).toContain("USAGE");
  });

  it("bare --refresh keeps main's exit where Claude doesn't apply on this host: one note line, exit unchanged", async () => {
    model = { ...MODEL, usage: [READING] };
    const codexOk = { status: 200, body: { refresh: { at: "t", outcome: "ok", coalesced: false }, usage: [] } };
    for (const reason of ["binary_not_found", "not_logged_in", "not_subscription_login"]) {
      refreshByProvider = { codex: codexOk, claude: { status: 200, body: { refresh: { at: "t", outcome: "failed", reason, detail: "d", coalesced: false }, usage: [] } } };
      const bare = await run(["status", "--refresh"], port);
      expect([bare.exitCode, bare.err], reason).toEqual([undefined, `note: Claude usage not read on this host: ${reason} (d); exit unaffected (name --provider claude to require it)`]);
      expect(bare.out).toContain("USAGE");
      // Named, it counts.
      expect((await run(["status", "--refresh", "--provider", "claude"], port)).exitCode, reason).toBe(1);
    }
    // A daemon without a Claude refresh (400, or 404 from an older route): a note, exit unchanged.
    for (const status of [400, 404]) {
      refreshByProvider = { codex: codexOk, claude: { status, body: { error: "no claude" } } };
      const old = await run(["status", "--refresh"], port);
      expect([old.exitCode, old.err], String(status)).toEqual([undefined, "note: this daemon has no Claude usage refresh; exit unaffected"]);
    }
    // Main's exit when the host has no claude and Codex fails: still 1, from Codex.
    refreshByProvider = {
      codex: { status: 200, body: { refresh: { at: "t", outcome: "failed", reason: "timeout", coalesced: false }, usage: [] } },
      claude: { status: 200, body: { refresh: { at: "t", outcome: "failed", reason: "binary_not_found", detail: "d", coalesced: false }, usage: [] } },
    };
    expect((await run(["status", "--refresh"], port)).exitCode).toBe(1);
    // auth status failing unexpectedly (for example {"loggedIn": false} with exit 9) applies: the bare refresh fails.
    refreshByProvider = { codex: codexOk, claude: { status: 200, body: { refresh: { at: "t", outcome: "failed", reason: "auth_status_failed", detail: "claude auth status failed (exit 9)", coalesced: false }, usage: [] } } };
    const unexpected = await run(["status", "--refresh"], port);
    expect([unexpected.exitCode, unexpected.err]).toEqual([1, ""]);
    // A Claude failure that does apply (it's installed and logged in) still fails the bare refresh.
    refreshByProvider = { codex: codexOk, claude: { status: 200, body: { refresh: { at: "t", outcome: "failed", reason: "timeout", coalesced: false }, usage: [] } } };
    expect((await run(["status", "--refresh"], port)).exitCode).toBe(1);
  });

  it("an older daemon with the switch off (Codex 409, Claude 400): main's one off line, exit 1", async () => {
    refreshByProvider = {
      codex: { status: 409, body: { error: "usage_windows_disabled", message: "Codex usage windows are off. Turn them on with: rig config set provider.usage_windows true" } },
      claude: { status: 400, body: { error: "usage windows can be refreshed for codex only in this version (got claude)" } },
    };
    const r = await run(["status", "--refresh"], port);
    expect([r.err, r.out, r.exitCode]).toEqual(["Codex usage windows are off. Turn them on with: rig config set provider.usage_windows true", "", 1]);
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
    expect(sortedPosts()).toEqual([{ provider: "claude" }, { provider: "codex" }]);
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

  it("seatAccounts (switch on): a SEATS section, one line per seat with its configured account and source, never linked", async () => {
    const notLinked = "a registry profile name and an observed account are different kinds of fact; nothing supported links them without reading the profile's contents";
    model = { ...MODEL, usage: [READING], seatAccounts: [
      { seatSession: "dev-qa@r", rigName: "r", runtime: "codex",
        configured: { source: "registry", profileRef: "work-a", recordedAt: "2026-10-12T10:00:00Z", profileSaved: false },
        registryNotes: ["profile work-a is not saved on this host"],
        allowance: { linked: false, reason: notLinked }, observed: { note: "no per-seat observation for Codex" } },
      { seatSession: "dev-build@r", rigName: "r", runtime: "claude-code",
        configured: { source: "default_login", home: "/h/.claude", homeNote: "the login in the daemon's Claude config dir, shared by every Claude seat on this daemon" },
        allowance: { linked: false, reason: "the usage read reads the login this home holds now; the seat runs the login that was active when it launched" },
        observed: { windowsSampled: true, lastSampledAt: "2026-10-13T14:59:00Z", differsFrom: ["dev-r1@r"], note: "possibly a different login: not a verdict" } },
      { seatSession: "t@r", rigName: "r", runtime: "terminal",
        configured: { source: "unknown", reason: "no account configuration is known for runtime terminal" },
        allowance: { linked: false, reason: "no configured account" } },
    ] };
    const { out } = await run(["status"], port);
    expect(out).toContain([
      "SEATS (configured account; not proof of the login a running session uses)",
      "  dev-qa@r  codex  configured: profile work-a (registry, recorded 2026-10-12T10:00:00Z; profile not saved on this host) · allowance not linked",
      "    profile work-a is not saved on this host",
      "    observed: no per-seat observation for Codex",
      `    allowance not linked: ${notLinked}`,
      "  dev-build@r  claude-code  configured: default login (/h/.claude) · allowance not linked",
      "    the login in the daemon's Claude config dir, shared by every Claude seat on this daemon",
      "    observed: differs from dev-r1@r (possibly a different login: not a verdict)",
      "    allowance not linked: the usage read reads the login this home holds now; the seat runs the login that was active when it launched",
      "  t@r  terminal  configured: unknown (no account configuration is known for runtime terminal) · allowance not linked",
      "    allowance not linked: no configured account",
    ].join("\n"));
    // The usage row itself is unchanged: still "seats unknown".
    expect(out).toContain("· seats unknown");
    expect((await run(["status", "--json"], port)).out).toBe(JSON.stringify(model));
  });

  it("a withheld observation renders its note", async () => {
    const note = "observation withheld: 2 seats share session name a@r; status-line samples are keyed by session name and cannot be attributed to one seat";
    model = { ...MODEL, seatAccounts: [
      { seatSession: "a@r", rigName: "r", runtime: "claude-code",
        configured: { source: "default_login", home: "/h/.claude", homeNote: "shared" },
        allowance: { linked: false, reason: "r" }, observed: { withheld: true, note } },
    ] };
    expect((await run(["status"], port)).out).toContain(`    observed: ${note}`);
  });

  it("an unreadable profile folder: the profile's saved state renders as unknown, never 'not saved'", async () => {
    const note = "can't tell whether profile work-a is saved on this host: the profile folder couldn't be read (EACCES)";
    model = { ...MODEL, seatAccounts: [
      { seatSession: "dev-qa@r", rigName: "r", runtime: "codex",
        configured: { source: "registry", profileRef: "work-a", recordedAt: "2026-10-12T10:00:00Z", profileSaved: null },
        registryNotes: [note], allowance: { linked: false, reason: "r" }, observed: { note: "no per-seat observation for Codex" } },
    ] };
    const { out } = await run(["status"], port);
    expect(out).toContain([
      "  dev-qa@r  codex  configured: profile work-a (registry, recorded 2026-10-12T10:00:00Z; whether the profile is saved: unknown) · allowance not linked",
      `    ${note}`,
    ].join("\n"));
    expect(out).not.toContain("not saved");
  });

  it("a sampled seat names when its status line last reported, never pointing at USAGE", async () => {
    model = { ...MODEL, seatAccounts: [
      { seatSession: "b@r", rigName: "r", runtime: "claude-code",
        configured: { source: "default_login", home: "/h/.claude", homeNote: "shared" },
        allowance: { linked: false, reason: "r" }, observed: { windowsSampled: true, lastSampledAt: "2026-09-22T15:00:00Z" } },
    ] };
    const { out } = await run(["status"], port);
    expect(out).toContain("    observed: this seat's status line last reported windows at 2026-09-22T15:00:00Z");
    expect(out).not.toContain("see USAGE");
  });

  it("review round 1 wordings: an unreadable registry, an empty CLAUDE_CONFIG_DIR, samples not available", async () => {
    model = { ...MODEL, seatAccounts: [
      { seatSession: "dev-cx@r", rigName: "r", runtime: "codex",
        configured: { source: "unknown", reason: "the seat registry exists but couldn't be read (EACCES)" },
        allowance: { linked: false, reason: "no configured account" }, observed: { note: "no per-seat observation for Codex" } },
      { seatSession: "a@r", rigName: "r", runtime: "claude-code",
        configured: { source: "default_login", home: null, homeNote: "CLAUDE_CONFIG_DIR is set but empty: it resolves to each seat's working directory" },
        allowance: { linked: false, reason: "r" }, observed: { note: "status-line samples were not available to this read" } },
    ] };
    expect((await run(["status"], port)).out).toContain([
      "  dev-cx@r  codex  configured: unknown (the seat registry exists but couldn't be read (EACCES)) · allowance not linked",
      "    observed: no per-seat observation for Codex",
      "    allowance not linked: no configured account",
      "  a@r  claude-code  configured: default login · allowance not linked",
      "    CLAUDE_CONFIG_DIR is set but empty: it resolves to each seat's working directory",
      "    observed: status-line samples were not available to this read",
    ].join("\n"));
  });

  it("no seatAccounts key (switch off): no SEATS section", async () => {
    model = { ...MODEL, usage: [READING] };
    expect((await run(["status"], port)).out).not.toContain("SEATS");
  });
});
