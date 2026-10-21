// Slice 01 (OPR.0.7.0.1) — `rig provider status --all-hosts | --hosts` against a loopback hub daemon that joins
// loopback hosts (the daemon's real provider and config routes, scripted native readers; usage-hosts-harness.ts).
// The human view prints every served fact verbatim; --json prints the served body; a refresh across hosts reports
// each failed leg and keeps the view.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerCommand, USAGE_ACROSS_HOSTS_READ_TIMEOUT_MS, USAGE_ACROSS_HOSTS_REFRESH_TIMEOUT_MS } from "../src/commands/provider.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import { closedPortUrl, SEAT_SHAPES, UsageHost, usageAcrossHostsFacts, type UsageHostOptions } from "../../daemon/test/helpers/usage-hosts-harness.js";
import { BEARER_REDACTED, REMOTE_USAGE_REFRESH_DEADLINE_MS, USAGE_HOSTS_VIEW_DEADLINE_MS } from "../../daemon/src/domain/provider/usage-across-hosts.js";
import { CODEX_USAGE_READ_DEADLINE_MS, CODEX_USAGE_READ_GRACE_MS } from "../../daemon/src/domain/provider/codex-usage-reader.js";
import { CLAUDE_AUTH_STATUS_TIMEOUT_MS, GRACE_MS as CLAUDE_AUTH_STATUS_GRACE_MS } from "../../daemon/src/domain/provider/claude-auth-status-reader.js";
import { USAGE_HOSTS_VIEW_WAIT_MS } from "../../tui/src/daemon-client.js";

const NOW = "2026-10-13T23:30:00.000Z";

function deps(url: string): StatusDeps {
  const port = Number(new URL(url).port);
  const lifecycleDeps = {
    spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port, db: "t", startedAt: "x" }) : null)),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((p: string) => p === STATE_FILE), mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  } as unknown as LifecycleDeps;
  return { lifecycleDeps, clientFactory: (u) => new DaemonClient(u) };
}

async function run(args: string[], hub: UsageHost): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [], err: string[] = [];
  const origLog = console.log, origErr = console.error;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  try {
    await providerCommand(deps(hub.url)).parseAsync(["node", "rig", ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return { out: out.join("\n"), err: err.join("\n"), exitCode };
}

const open: UsageHost[] = [];
async function host(id: string, opts: UsageHostOptions = {}): Promise<UsageHost> {
  const h = await UsageHost.start(id, { now: () => NOW, routes: { usageAcrossHosts: { now: () => NOW } }, ...opts });
  open.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

async function refreshDirect(h: UsageHost): Promise<void> {
  const res = await fetch(`${h.url}/api/provider/usage/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "codex" }) });
  expect(res.status).toBe(200);
}

describe("rig provider status --all-hosts", () => {
  it("prints every served fact verbatim: one entry per allowance with each host's observation, and every host's status", async () => {
    // a also serves a seat in each observed shape, so the seat facts are held to the same list.
    const a = await host("a", { rewrite: (p, body) => p === "/api/provider/status" ? { ...(body as object), seatAccounts: SEAT_SHAPES } : body });
    const b = await host("b", { codex: { secondaryUsed: 90, secondaryResetsAt: "2026-10-20T04:00:00.000Z" } });
    const c = await host("c", { codex: { email: "other@example.com" } });
    const off = await host("off", { usageWindows: false });
    const down = await closedPortUrl();
    // d's reading is older than its failed refresh: its windows carry a freshness reason; it serves a seats value too.
    const d = await host("d", { codex: { accountId: "acct-d" }, rewrite: (p, body) => p === "/api/provider/status"
      ? { ...(body as object), usage: ((body as { usage: Array<Record<string, unknown>> }).usage).map((r) => ({ ...r, seats: "configured on 2 seats" })) } : body });
    const hub = await host("hub", { registry: [a.entry(), b.entry(), c.entry(), off.entry(), { id: "down", transport: "http", url: down }, d.entry()] });
    for (const h of [a, b, c, d]) await refreshDirect(h);
    d.codex = { fail: { reason: "rpc_error", detail: "the app-server said no" } };
    await refreshDirect(d);

    const served = await (await fetch(`${hub.url}/api/provider/usage/hosts`)).json() as Record<string, unknown>;
    expect(JSON.stringify(served)).toContain('"freshnessReason":"refresh failed at 2026-10-13T23:30:00.000Z; this reading is older"');
    const { out, exitCode } = await run(["status", "--all-hosts"], hub);
    expect(exitCode).toBeUndefined();
    const missing = usageAcrossHostsFacts(served).filter((f) => !out.includes(f));
    expect(missing).toEqual([]);
    expect(usageAcrossHostsFacts(served).length).toBeGreaterThan(20);
    expect(usageAcrossHostsFacts(served)).toEqual(expect.arrayContaining(["seat-withheld-differs@r", "differs from peer-b@r", "differs from peer-c@r, peer-d@r", "differs from peer-e@r"]));
    // One entry for the shared login on a and b (disagreeing), one for c's other login, never a sum.
    expect(out).toContain("codex  account acct-1 · bucket codex  [the same allowance on 2 hosts, disagreeing: a, b]");
    expect(out).toContain("codex  account acct-1 · bucket codex  [linkage unknown; observed on c]");
    expect(out).toContain("  down  unreachable (");
    expect(out).toContain("  off  answered · usage off: usage windows are off on this host (provider.usage_windows = false)");
    expect(out).toContain("codex  account acct-d · bucket codex · dev@example.com · team · seats configured on 2 seats");
  });

  it("waits for a view that takes the daemon longer than 5 s: a switched-off host answering its status and settings after 4.5 s each", async () => {
    const slow = await host("slow", { usageWindows: false, slowReadMs: 4_500 });
    const hub = await host("hub", { registry: [slow.entry()] });
    const started = Date.now();
    const got = await run(["status", "--all-hosts"], hub);
    expect(Date.now() - started).toBeGreaterThan(5_000);
    expect([got.exitCode, got.err]).toEqual([undefined, ""]);
    expect(got.out).toContain("  slow  answered · usage off: usage windows are off on this host (provider.usage_windows = false)");
    expect(slow.requests.map((r) => r.path)).toEqual(["/api/provider/status", "/api/config?view=browser"]);
  }, 20_000);

  it("--json prints the served body", async () => {
    const a = await host("a");
    const hub = await host("hub", { registry: [a.entry()] });
    await refreshDirect(a);
    const served = await (await fetch(`${hub.url}/api/provider/usage/hosts`)).json();
    const { out } = await run(["status", "--all-hosts", "--json"], hub);
    expect(JSON.parse(out)).toEqual(served);
  });

  it("one allowance agreeing on two hosts is one entry naming both, never a sum", async () => {
    const a = await host("a");
    const b = await host("b");
    const hub = await host("hub", { registry: [a.entry(), b.entry()] });
    for (const h of [a, b]) await refreshDirect(h);
    const { out, exitCode } = await run(["status", "--all-hosts"], hub);
    expect(exitCode).toBeUndefined();
    // An entry's line carries its linkage in brackets; each host's row under it doesn't.
    const entries = out.split("\n").filter((l) => / {2}codex {2}account acct-1 · bucket codex {2}\[/.test(l));
    expect(entries).toEqual(["  codex  account acct-1 · bucket codex  [the same allowance on 2 hosts: a, b]"]);
    expect(out).toContain("    on a (read ");
    expect(out).toContain("    on b (read ");
    expect(out).not.toMatch(/\d+% left \+|total|sum of/i);
  });

  it("the view starts no native read, here or on any host, and sends only GETs: three runs", async () => {
    const a = await host("a");
    const off = await host("off", { usageWindows: false });
    const hub = await host("hub", { registry: [a.entry(), off.entry()] });
    for (let i = 0; i < 3; i++) expect((await run(["status", "--all-hosts"], hub)).exitCode).toBeUndefined();
    expect([hub, a, off].map((h) => [h.id, h.codexReads, h.claudeReads])).toEqual([["hub", 0, 0], ["a", 0, 0], ["off", 0, 0]]);
    expect([hub, a, off].flatMap((h) => h.requests).filter((r) => r.method !== "GET")).toEqual([]);
    expect(hub.seen("/api/provider/usage/hosts")).toHaveLength(3);
  });

  it("--hosts narrows to those hosts (this host always included)", async () => {
    const a = await host("a");
    const b = await host("b");
    const hub = await host("hub", { registry: [a.entry(), b.entry()] });
    const { out } = await run(["status", "--hosts", "b", "--json"], hub);
    expect((JSON.parse(out) as { hosts: Array<{ hostId: string }> }).hosts.map((h) => h.hostId)).toEqual(["local", "b"]);
    expect(a.requests).toEqual([]);
    const unknown = await run(["status", "--hosts", "nope"], hub);
    expect([unknown.exitCode, unknown.err]).toEqual([1, "unknown host ids: nope"]);
    const before = hub.requests.length;
    for (const empty of ["", " , ,"]) {
      const got = await run(["status", "--hosts", empty], hub);
      expect([got.exitCode, got.out, got.err]).toEqual([1, "", "--hosts needs at least one registered host id (comma-separated); for every host use --all-hosts"]);
    }
    expect(hub.requests.length).toBe(before);
  });

  it("switch off here: one line naming the key, exit 1", async () => {
    const hub = await host("hub", { usageWindows: false, registry: [] });
    const got = await run(["status", "--all-hosts"], hub);
    expect([got.exitCode, got.err]).toEqual([1, "Usage across hosts needs usage windows on this daemon. Turn them on with: rig config set provider.usage_windows true"]);
  });

  it("--refresh: a failed leg prints and sets exit 1, the view still prints with the failure beside the kept reading", async () => {
    const a = await host("a");
    const hub = await host("hub", { registry: [a.entry()] });
    await refreshDirect(a);
    a.codex = { fail: { reason: "rpc_error", detail: "the app-server said no" } };
    const got = await run(["status", "--all-hosts", "--refresh", "--provider", "codex"], hub);
    expect(got.exitCode).toBe(1);
    expect(got.err).toBe("refresh codex on a failed: rpc_error (the app-server said no)");
    expect(got.out).toContain("refresh failed at 2026-10-13T23:30:00.000Z: rpc_error (the app-server said no); last reading kept, marked old");
    expect(a.codexReads).toBe(2);
  });

  it("--refresh: a host whose Codex read takes longer than the 5 s read class still answers, and its new reading prints", async () => {
    const a = await host("a", { codex: { delayMs: 6_000, secondaryUsed: 85 } });
    const hub = await host("hub", { registry: [a.entry()] });
    const started = Date.now();
    const got = await run(["status", "--all-hosts", "--refresh", "--provider", "codex"], hub);
    expect(Date.now() - started).toBeGreaterThan(5_000);
    expect([got.exitCode, got.err]).toEqual([undefined, ""]);
    expect(got.out).toContain("  a  answered · usage windows served");
    expect(got.out).toContain("    refresh from here (codex) answered at ");
    const lines = got.out.split("\n");
    const onA = lines.findIndex((l) => l.startsWith("    on a (read "));
    expect(lines.slice(onA + 1, onA + 5).some((l) => l.includes("weekly (secondary)  15% left"))).toBe(true);
    expect(a.codexReads).toBe(1);
  }, 20_000);

  it("--refresh: a host where Claude doesn't apply is a note under a bare --refresh, a failure when named", async () => {
    const a = await host("a", { claude: { fail: { reason: "binary_not_found", detail: "no claude on PATH" } } });
    const hub = await host("hub", { registry: [a.entry()] });
    const bare = await run(["status", "--all-hosts", "--refresh"], hub);
    expect(bare.exitCode).toBeUndefined();
    expect(bare.err).toBe("note: refresh claude on a failed: binary_not_found (no claude on PATH); exit unaffected (name --provider claude to require it)");
    const named = await run(["status", "--all-hosts", "--refresh", "--provider", "claude"], hub);
    expect(named.exitCode).toBe(1);
  });

  it("no bearer, bearer variable or bearer file reaches the output", async () => {
    const a = await host("a");
    const b = await host("b");
    process.env["XHOST_CLI_BEARER"] = "cli-s3cret-bearer";
    try {
      const hub = await host("hub", {
        registry: [a.entry({ bearer_env: "XHOST_CLI_BEARER" } as never), b.entry({ bearer_file: "/nonexistent/xhost-cli-bearer" } as never)],
      });
      const text = [await run(["status", "--all-hosts"], hub), await run(["status", "--all-hosts", "--json"], hub), await run(["status", "--all-hosts", "--refresh"], hub)]
        .map((r) => r.out + r.err).join("\n");
      for (const secret of ["cli-s3cret-bearer", "XHOST_CLI_BEARER", "/nonexistent/xhost-cli-bearer", "bearer_file", "bearer_env"]) expect(text).not.toContain(secret);
      expect(text).toContain("b  auth-failed (the bearer configured for this host couldn't be resolved)");
    } finally {
      delete process.env["XHOST_CLI_BEARER"];
    }
  });
});

describe("round 2 through the CLI", () => {
  // Nine registry entries for one host whose status and settings each answer after 4.5 s: four at a time, the view
  // needs about 27 s, past the CLI's 20 s wait. The daemon answers at its 15 s deadline with what it has.
  async function nineSlowEntries(): Promise<UsageHost> {
    const slow = await host("slow", { usageWindows: false, slowReadMs: 4_500 });
    return host("hub", { registry: Array.from({ length: 9 }, (_, i) => slow.entry({ id: `slow${i + 1}` } as never)) });
  }

  it("a registry larger than the view's deadline allows: a partial view naming the late hosts, exit 0", async () => {
    const hub = await nineSlowEntries();
    const started = Date.now();
    const got = await run(["status", "--all-hosts"], hub);
    const took = Date.now() - started;
    expect(took).toBeGreaterThan(14_000);
    expect(took).toBeLessThan(20_000);
    expect([got.exitCode, got.err]).toEqual([undefined, ""]);
    for (const i of [1, 2, 3, 4]) expect(got.out).toContain(`  slow${i}  answered · usage off: usage windows are off on this host`);
    for (const i of [5, 6, 7, 8, 9]) {
      expect(got.out).toContain(`  slow${i}  unreachable (not heard from within the view's 15 s) · usage unavailable: not heard from within the view's 15 s`);
    }
  }, 40_000);

  it("--refresh prints the view its own answer carries, with both providers' legs, partial in the same way", async () => {
    const hub = await nineSlowEntries();
    const got = await run(["status", "--all-hosts", "--refresh", "--json"], hub);
    expect(got.exitCode).toBe(1);
    const view = JSON.parse(got.out) as { hosts: Array<{ hostId: string; usageReason?: string }> };
    expect(view.hosts.filter((h) => h.usageReason === "not heard from within the view's 15 s").map((h) => h.hostId))
      .toEqual(["slow5", "slow6", "slow7", "slow8", "slow9"]);
    // Usage windows are off on the slow host, so each of its legs fails; one line per provider and host.
    for (const provider of ["codex", "claude"]) expect(got.err).toContain(`refresh ${provider} on slow9 failed: usage_windows_off (usage windows are off on this host)`);
    expect(hub.seen("/api/provider/usage/hosts")).toEqual([{ method: "POST", path: "/api/provider/usage/hosts/refresh" }]);
  }, 40_000);

  it("a host serving a malformed window: that host unavailable with the reason, the rest printed", async () => {
    const good = await host("good");
    const bad = await host("bad", { rewrite: (p, b) => p === "/api/provider/status"
      ? { ...(b as object), usage: ((b as { usage: Array<Record<string, unknown>> }).usage).map((r) => ({ ...r, windows: [null] })) } : b });
    const hub = await host("hub", { registry: [good.entry(), bad.entry()] });
    await refreshDirect(good);
    const got = await run(["status", "--all-hosts"], hub);
    expect(got.exitCode).toBeUndefined();
    expect(got.out).toContain("  bad  answered · usage unavailable: this host served usage rows in a shape this daemon doesn't recognize");
    expect(got.out).toContain("    on good (read ");
  });

  it("a host echoing its bearer: replaced in the printed view and the failed-leg line", async () => {
    const marker = "SYNTHETIC-BEARER-MARKER-cli-51d2";
    process.env["XHOST_CLI_MARKER"] = marker;
    try {
      const echo = await host("echo", { rewrite: (p, b) => p === "/api/provider/status"
        ? { ...(b as object), usage: ((b as { usage: Array<Record<string, unknown>> }).usage).map((r) => ({ ...r, identityNote: `seen ${marker}` })) }
        : p === "/api/provider/usage/refresh" ? { refresh: { at: NOW, outcome: "failed", reason: "rpc_error", detail: `token ${marker}`, coalesced: false } } : b });
      const hub = await host("hub", { registry: [echo.entry({ bearer_env: "XHOST_CLI_MARKER" } as never)] });
      const got = await run(["status", "--all-hosts", "--refresh", "--provider", "codex"], hub);
      const json = await run(["status", "--all-hosts", "--json"], hub);
      const text = got.out + got.err + json.out + json.err;
      expect(text).not.toContain(marker);
      expect(got.err).toContain(`refresh codex on echo failed: rpc_error (${BEARER_REDACTED})`);
      expect(json.out).toContain(BEARER_REDACTED);
    } finally {
      delete process.env["XHOST_CLI_MARKER"];
    }
  });
});

describe("round 3 through the CLI", () => {
  const TRAP = { toString: 1, valueOf: 1 };
  type Body = Record<string, unknown>;
  const rows = (b: unknown) => (b as { usage: Body[] }).usage;
  const withCodexRow = (patch: (r: Body) => Body) => (p: string, b: unknown) =>
    p === "/api/provider/status" ? { ...(b as Body), usage: rows(b).map((r) => (r["provider"] === "codex" ? patch(r) : r)) } : b;
  const firstWindow = (patch: (w: Body) => Body) => withCodexRow((r) => ({ ...r, windows: (r["windows"] as Body[]).map((w, i) => (i === 0 ? patch(w) : w)) }));
  const seat = (patch: Body) => (p: string, b: unknown) => p === "/api/provider/status" ? { ...(b as Body), seatAccounts: [{
    seatSession: "dev-qa@r", rigName: "r", runtime: "codex",
    configured: { source: "registry", profileRef: "work-a", recordedAt: "2026-10-12T10:00:00Z", profileSaved: true },
    allowance: { linked: false, reason: "not linked" }, ...patch,
  }] } : b;
  let deep: unknown = "leaf";
  for (let i = 0; i < 2_000; i++) deep = { d: deep };

  it("a malformed host of each rendered field class, or nested 2,000 deep: named unavailable, the rest printed, exit 0", async () => {
    const bad: Array<[string, UsageHostOptions]> = [
      ["seats", { rewrite: withCodexRow((r) => ({ ...r, seats: TRAP })) }],
      ["plan", { rewrite: withCodexRow((r) => ({ ...r, identity: { ...(r["identity"] as Body), planType: TRAP } })) }],
      ["reason", { rewrite: firstWindow((w) => ({ ...w, freshnessReason: TRAP })) }],
      ["left", { rewrite: firstWindow(({ remainingPercent: _r, ...w }) => w) }],
      ["disagree", { rewrite: firstWindow((w) => ({ ...w, disagreeingSeats: [{ seatSession: "x@r", usedPercent: TRAP, resetsAt: null, observedAt: NOW }] })) }],
      ["notes", { rewrite: seat({ registryNotes: 5 }) }],
      ["differs", { rewrite: seat({ observed: { differsFrom: "dev-b@r", note: "n" } }) }],
      ["setting", { usageWindows: false, rewrite: (p, b) => p === "/api/config"
        ? { ...(b as Body), entries: ((b as { entries: Body[] }).entries).map((e) => (e["key"] === "provider.usage_windows" ? { ...e, value: TRAP } : e)) } : b }],
      ["deep", { rewrite: (p, b) => (p === "/api/provider/status" ? { ...(b as Body), deep } : b) }],
    ];
    const good = await host("good");
    const hosts = await Promise.all(bad.map(([id, opts]) => host(id, opts)));
    for (const h of [good, ...hosts]) await refreshDirect(h).catch(() => {});
    const hub = await host("hub", { registry: [good.entry(), ...hosts.map((h) => h.entry())] });
    const got = await run(["status", "--all-hosts"], hub);
    expect([got.exitCode, got.err]).toEqual([undefined, ""]);
    expect(got.out).toContain("    on good (read ");
    for (const id of ["seats", "plan", "reason", "left", "disagree"]) {
      expect(got.out).toContain(`  ${id}  answered · usage unavailable: this host served usage rows in a shape this daemon doesn't recognize`);
    }
    for (const id of ["notes", "differs"]) {
      expect(got.out).toContain(`  ${id}  answered · usage unavailable: this host served seat accounts in a shape this daemon doesn't recognize`);
    }
    expect(got.out).toContain("  setting  answered · usage off: usage windows are off on this host (provider.usage_windows = an unrecognized value)");
    expect(got.out).toContain("  deep  answered · usage unavailable: this host's answer is nested deeper than 32 levels");
    expect(got.out).not.toContain("undefined");
  });

  it("a rotated bearer: the sent one echoed back by a refresh never reaches the printed lines", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-hosts-bearer-"));
    const file = path.join(dir, "bearer");
    const A = "SYNTHETIC-ROTATE-CLI-A-5b2e", B = "SYNTHETIC-ROTATE-CLI-B-80d1";
    try {
      fs.writeFileSync(file, A);
      const leg = await host("leg", { rewrite: (p, b) => {
        if (p !== "/api/provider/usage/refresh") return b;
        fs.writeFileSync(file, B);
        return { refresh: { at: NOW, outcome: "failed", reason: "rpc_error", detail: `sent ${A}`, coalesced: false } };
      } });
      const hub = await host("hub", { registry: [leg.entry({ bearer_file: file } as never)] });
      const refreshed = await run(["status", "--all-hosts", "--refresh", "--provider", "codex"], hub);
      const later = await run(["status", "--all-hosts"], hub);
      for (const text of [refreshed.out, refreshed.err, later.out]) expect(text).not.toContain(A);
      expect(refreshed.err).toContain(`refresh codex on leg failed: rpc_error (${BEARER_REDACTED})`);
      expect(later.out).toContain(`refresh from here (codex) failed at ${NOW}: rpc_error (${BEARER_REDACTED})`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("round 4 through the CLI", () => {
  const TRAP = { toString: 1, valueOf: 1 };
  type Body = Record<string, unknown>;
  const statusRows = (patch: (r: Body) => Body) => (p: string, b: unknown) =>
    p === "/api/provider/status" ? { ...(b as Body), usage: (b as { usage: Body[] }).usage.map(patch) } : b;
  const withIdentity = (provider: string, patch: (id: Body) => Body) => statusRows((r) =>
    r["provider"] === provider && r["identity"] ? { ...r, identity: patch(r["identity"] as Body) } : r);

  async function refreshBoth(h: UsageHost): Promise<void> {
    for (const provider of ["codex", "claude"]) {
      const res = await fetch(`${h.url}/api/provider/usage/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
      expect(res.status).toBe(200);
    }
  }

  it("an identity carrying another provider's key with an unprintable value: named unavailable, the rest printed, exit 0", async () => {
    const cases: Array<[string, UsageHostOptions]> = [
      ["codex-subscriptionType", { rewrite: withIdentity("codex", (id) => ({ ...id, subscriptionType: TRAP })) }],
      ["codex-orgId", { rewrite: withIdentity("codex", (id) => ({ ...id, accountId: null, workspaceId: null, orgId: TRAP })) }],
      ["codex-orgName", { rewrite: withIdentity("codex", (id) => ({ ...id, accountId: null, workspaceId: null, orgId: "org-x", orgName: TRAP })) }],
      ["claude-planType", { rewrite: withIdentity("claude", (id) => ({ ...id, planType: TRAP })) }],
      ["claude-accountId", { rewrite: withIdentity("claude", (id) => ({ ...id, accountId: TRAP })) }],
      ["claude-workspaceId", { rewrite: withIdentity("claude", (id) => ({ ...id, workspaceId: TRAP })) }],
    ];
    const good = await host("good");
    const bad = await Promise.all(cases.map(([id, opts]) => host(id, opts)));
    for (const h of [good, ...bad]) await refreshBoth(h);
    const hub = await host("hub", { registry: [good.entry(), ...bad.map((h) => h.entry())] });
    const got = await run(["status", "--all-hosts"], hub);
    expect([got.exitCode, got.err]).toEqual([undefined, ""]);
    expect(got.out).toContain("    on good (read ");
    for (const [id] of cases) expect(got.out).toContain(`  ${id}  answered · usage unavailable: this host served usage rows in a shape this daemon doesn't recognize`);
  });

  it("absent optional text reads honestly: a failure without reason or detail, on a row and a leg, and differs-from without a note", async () => {
    const quiet = await host("quiet", {
      rewrite: (p, b) => {
        if (p === "/api/provider/usage/refresh") return { refresh: { at: NOW, outcome: "failed", coalesced: false } };
        if (p !== "/api/provider/status") return b;
        const body = b as Body;
        return {
          ...body,
          usage: (body["usage"] as Body[]).map((r) => (r["provider"] === "codex" ? { ...r, lastRefresh: { at: NOW, outcome: "failed" } } : r)),
          seatAccounts: [{
            seatSession: "dev-qa@r", rigName: "r", runtime: "claude-code",
            configured: { source: "default_login", home: null, homeNote: "the daemon's home" },
            allowance: { linked: false, reason: "not linked" }, observed: { windowsSampled: true, differsFrom: ["dev-b@r"] },
          }],
        };
      },
    });
    await refreshDirect(quiet);
    const hub = await host("hub", { registry: [quiet.entry()] });
    const got = await run(["status", "--all-hosts", "--refresh", "--provider", "codex"], hub);
    const text = got.out + "\n" + got.err;
    expect(text).not.toContain("undefined");
    expect(got.err).toBe("refresh codex on quiet failed: no reason given");
    expect(got.out).toContain(`    refresh from here (codex) failed at ${NOW}: no reason given; this host's earlier observations are kept`);
    expect(got.out).toContain(`refresh failed at ${NOW}: no reason given; last reading kept, marked old`);
    expect(got.out).toContain("    observed: differs from dev-b@r\n");
  });
});

describe("the bounds chain: every wait outlasts what it waits for", () => {
  it("a host's own read and its cleanup fit its leg; the slowest leg and the view fit the CLI's refresh wait; the view fits both views' wait", () => {
    // Codex: after the read, stopGroup waits up to the grace at each of three steps (none, TERM, KILL) and once more for
    // the reap (codex-network-default.ts:210-218).
    const codexWorst = CODEX_USAGE_READ_DEADLINE_MS + 4 * CODEX_USAGE_READ_GRACE_MS;
    // Claude: up to 200 ms for its output after exit (claude-auth-status-reader.ts:153), a first wait of at most 200 ms
    // (:102), the grace after TERM and after KILL, and the grace for the reap (:136).
    const claudeWorst = CLAUDE_AUTH_STATUS_TIMEOUT_MS + 200 + Math.min(CLAUDE_AUTH_STATUS_GRACE_MS, 200) + 3 * CLAUDE_AUTH_STATUS_GRACE_MS;
    expect(codexWorst).toBeLessThan(REMOTE_USAGE_REFRESH_DEADLINE_MS.codex);
    expect(claudeWorst).toBeLessThan(REMOTE_USAGE_REFRESH_DEADLINE_MS.claude);
    const slowestLeg = Math.max(...Object.values(REMOTE_USAGE_REFRESH_DEADLINE_MS));
    expect(slowestLeg + USAGE_HOSTS_VIEW_DEADLINE_MS).toBeLessThan(USAGE_ACROSS_HOSTS_REFRESH_TIMEOUT_MS);
    expect(USAGE_HOSTS_VIEW_DEADLINE_MS).toBeLessThan(USAGE_ACROSS_HOSTS_READ_TIMEOUT_MS);
    expect(USAGE_HOSTS_VIEW_DEADLINE_MS).toBeLessThan(USAGE_HOSTS_VIEW_WAIT_MS);
  });
});
