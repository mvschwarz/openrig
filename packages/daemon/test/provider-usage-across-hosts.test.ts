// Slice 01 (OPR.0.7.0.1) — usage windows across registered hosts. The grouping rule as a pure function, then the
// served routes over real HTTP on loopback: each host is the daemon's real provider and config routes over a real
// provider service, with scripted native readers that count their reads (usage-hosts-harness.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BEARER_REDACTED,
  groupUsageAcrossHosts,
  isSeat,
  isUsageRow,
  remoteRefreshLeg,
  UsageRefreshLegs,
  type UsageAcrossHosts,
  type UsageObservation,
} from "../src/domain/provider/usage-across-hosts.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";
import type { ProviderUsageAllowance, UsageWindowRow } from "../src/domain/provider/provider-types.js";
import { configuredSeatAccounts } from "../src/domain/provider/provider-seat-accounts.js";
import { closedPortUrl, redirectingRelay, UsageHost, type UsageHostOptions } from "./helpers/usage-hosts-harness.js";

const NOW = "2026-10-13T23:30:00.000Z";

function win(window: string, resetsAt: string | null, freshness: UsageWindowRow["freshness"] = "fresh"): UsageWindowRow {
  return { window, durationMins: 10080, usedPercent: 40, remainingPercent: 60, resetsAt, observedAt: NOW, level: "ok", freshness };
}

function codexRow(accountId: string | null, email: string | null, windows: UsageWindowRow[] = [win("secondary", "2026-10-20T00:00:00.000Z")]): ProviderUsageAllowance {
  return {
    provider: "codex",
    identity: { accountId, workspaceId: null, limitId: "codex", email, planType: "team", source: accountId ? "account/rateLimits/read accountId" : "unresolved" },
    source: { kind: "codex_app_server", host: "local" },
    observedAt: NOW,
    seats: "unknown",
    windows,
    limitEvidence: null,
    latestFromSource: true,
    lastRefresh: { at: NOW, outcome: "ok" },
    currentAvailability: "known",
  };
}

function claudeRow(orgId: string, email: string): ProviderUsageAllowance {
  return {
    ...codexRow("x", null),
    provider: "claude",
    identity: { orgId, limitId: "all models", email, orgName: null, subscriptionType: "max", source: "claude auth status orgId and email" },
    source: { kind: "claude_statusline_samples", host: "local" },
  };
}

const obs = (hostId: string, row: ProviderUsageAllowance): UsageObservation => ({ hostId, readAt: NOW, row });

describe("the grouping rule", () => {
  it("one allowance on two hosts is one group with both observations, verbatim and never summed", () => {
    const a = codexRow("acct-1", "dev@example.com");
    const b = { ...codexRow("acct-1", "dev@example.com"), windows: [{ ...win("secondary", "2026-10-20T00:00:30.000Z"), usedPercent: 70, remainingPercent: 30 }] };
    const groups = groupUsageAcrossHosts([obs("a", a), obs("b", b)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ provider: "codex", key: "codex:account:acct-1:codex", linkage: "same", notes: [] });
    expect(groups[0]!.observations.map((o) => o.row)).toEqual([a, b]);
    expect(groups[0]!.observations[0]!.row).toBe(a);
    expect(Object.keys(groups[0]!)).toEqual(["provider", "key", "linkage", "observations", "notes"]);
  });

  it("the same allowance whose fresh resets are more than 60 s apart is a conflict, both kept, none chosen", () => {
    const a = codexRow("acct-1", "dev@example.com", [win("secondary", "2026-10-20T00:00:00.000Z")]);
    const b = codexRow("acct-1", "dev@example.com", [win("secondary", "2026-10-20T02:00:00.000Z")]);
    const [group] = groupUsageAcrossHosts([obs("a", a), obs("b", b)]);
    expect(group!.linkage).toBe("conflict");
    expect(group!.observations.map((o) => o.hostId)).toEqual(["a", "b"]);
    expect(group!.notes).toEqual([
      "window secondary: the hosts report resets more than 60 s apart (a 2026-10-20T00:00:00.000Z; b 2026-10-20T02:00:00.000Z); every observation is kept and none is chosen",
    ]);
  });

  it("resets within 60 s, or a stale observation that disagrees, are not a conflict", () => {
    const fresh = codexRow("acct-1", "e", [win("secondary", "2026-10-20T00:00:00.000Z")]);
    const close = codexRow("acct-1", "e", [win("secondary", "2026-10-20T00:01:00.000Z")]);
    const stale = codexRow("acct-1", "e", [win("secondary", "2026-10-21T00:00:00.000Z", "stale")]);
    expect(groupUsageAcrossHosts([obs("a", fresh), obs("b", close)])[0]!.linkage).toBe("same");
    expect(groupUsageAcrossHosts([obs("a", fresh), obs("b", stale)])[0]!.linkage).toBe("same");
  });

  it("the same Codex account id under different login emails stays apart as unknown linkage, naming the other host and the id", () => {
    const groups = groupUsageAcrossHosts([obs("a", codexRow("acct-1", "one@example.com")), obs("b", codexRow("acct-1", "two@example.com"))]);
    expect(groups.map((g) => [g.linkage, g.observations.map((o) => o.hostId)])).toEqual([["unknown", ["a"]], ["unknown", ["b"]]]);
    expect(groups[0]!.notes[0]).toBe("the same Codex account acct-1, bucket codex is also observed on b under another login email; the source can't tell "
      + "one allowance from a workspace whose members have their own limits, so these observations are not merged");
    expect(groups[1]!.notes[0]).toContain("is also observed on a under another login email");
  });

  it("a missing Codex login email links to nothing: by account id, by workspace id, and beside a reported email", () => {
    const byWorkspace = (email: string | null): ProviderUsageAllowance => {
      const row = codexRow(null, email);
      return { ...row, identity: { ...(row.identity as object), accountId: null, workspaceId: "ws-1", source: "account/read workspace routing" } as never };
    };
    for (const [a, b] of [[codexRow("acct-1", null), codexRow("acct-1", null)], [byWorkspace(null), byWorkspace(null)]] as const) {
      const groups = groupUsageAcrossHosts([obs("a", a), obs("b", b)]);
      expect(groups.map((g) => [g.linkage, g.observations.map((o) => o.hostId)])).toEqual([["unknown", ["a"]], ["unknown", ["b"]]]);
      expect(groups[0]!.notes[0]).toMatch(/^the same Codex (account acct-1|workspace ws-1), bucket codex is also observed on b; no login email was reported here; /);
    }
    const mixed = groupUsageAcrossHosts([obs("a", codexRow("acct-1", "dev@example.com")), obs("b", codexRow("acct-1", null))]);
    expect(mixed.map((g) => [g.linkage, g.observations.map((o) => o.hostId)])).toEqual([["unknown", ["a"]], ["unknown", ["b"]]]);
    expect(mixed.find((g) => g.observations[0]!.hostId === "a")!.notes[0]).toContain("is also observed on b under another login email or with none reported;");
    expect(mixed.find((g) => g.observations[0]!.hostId === "b")!.notes[0]).toContain("is also observed on a; no login email was reported here;");
  });

  it("the same Claude email in two organisations is two allowances", () => {
    const groups = groupUsageAcrossHosts([obs("a", claudeRow("org-1", "dev@example.com")), obs("b", claudeRow("org-2", "dev@example.com"))]);
    expect(groups.map((g) => [g.key, g.linkage])).toEqual([
      ["claude:org:org-1:email:dev@example.com:all models", "single"],
      ["claude:org:org-2:email:dev@example.com:all models", "single"],
    ]);
  });

  it("the same Codex login email under different account ids is two allowances, each its own entry", () => {
    const groups = groupUsageAcrossHosts([obs("a", codexRow("acct-1", "dev@example.com")), obs("b", codexRow("acct-2", "dev@example.com"))]);
    expect(groups.map((g) => [g.key, g.linkage, g.observations.map((o) => o.hostId), g.notes])).toEqual([
      ["codex:account:acct-1:codex", "single", ["a"], []],
      ["codex:account:acct-2:codex", "single", ["b"], []],
    ]);
  });

  it("an unresolved identity, or a source never read, is its own entry and never matched", () => {
    const unresolved = codexRow(null, "dev@example.com");
    const notRead: ProviderUsageAllowance = { ...codexRow(null, null), identity: null, windows: [] };
    const groups = groupUsageAcrossHosts([obs("a", unresolved), obs("b", unresolved), obs("c", notRead)]);
    expect(groups.map((g) => [g.key, g.linkage, g.observations.map((o) => o.hostId)])).toEqual([
      [null, "unknown", ["a"]], [null, "unknown", ["b"]], [null, "unknown", ["c"]],
    ]);
  });
});

describe("refresh legs", () => {
  it("map each kind of host answer to a leg; a bearer that can't be resolved is never named", () => {
    const at = NOW;
    expect(remoteRefreshLeg({ ok: false, kind: "timeout", phase: "request", detail: "" }, "codex", 50_000, at)).toEqual({
      at, outcome: "failed", reason: "timeout", detail: "no answer within 50000 ms; the host may still finish its read, and its next served reading will show it",
    });
    expect(remoteRefreshLeg({ ok: false, kind: "bearer", detail: "bearer file /secret/path not readable for host a" }, "codex", 1, at).detail)
      .toBe("the bearer configured for this host couldn't be resolved");
    expect(remoteRefreshLeg({ ok: false, kind: "http", status: 409, detail: "" }, "codex", 1, at).reason).toBe("usage_windows_off");
    expect(remoteRefreshLeg({ ok: false, kind: "http", status: 404, detail: "" }, "codex", 1, at).reason).toBe("older");
    expect(remoteRefreshLeg({ ok: true, status: 200, payload: { refresh: { at: "T", outcome: "ok", coalesced: true } } }, "codex", 1, at))
      .toEqual({ at: "T", outcome: "ok", coalesced: true });
  });

  it("a leg asked for while the same (host, provider) leg runs joins it", async () => {
    const legs = new UsageRefreshLegs();
    let starts = 0;
    let release!: () => void;
    const start = async () => { starts += 1; await new Promise<void>((r) => { release = r; }); return { at: NOW, outcome: "ok" as const }; };
    const first = legs.run("a", "codex", start);
    const second = legs.run("a", "codex", start);
    const other = legs.run("a", "claude", async () => ({ at: NOW, outcome: "ok" as const }));
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect((await first).coalesced).toBe(false);
    expect((await second).coalesced).toBe(true);
    expect((await other).coalesced).toBe(false);
    expect(starts).toBe(1);
  });
});

// ——— Served routes over loopback HTTP ———

const open: UsageHost[] = [];
async function host(id: string, opts: UsageHostOptions = {}): Promise<UsageHost> {
  const h = await UsageHost.start(id, opts);
  open.push(h);
  return h;
}
afterEach(async () => {
  setSelfHostId(null);
  await Promise.all(open.splice(0).map((h) => h.close()));
});

/** The answer's body, or its raw text when it isn't JSON (a 500's "Internal Server Error"), so a test's status
 *  assertion is what fails, not the parse. */
async function bodyOf<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return { unparsed: text } as T;
  }
}

async function view(hub: UsageHost, query = ""): Promise<{ status: number; body: UsageAcrossHosts & { error?: string; message?: string } }> {
  const res = await fetch(`${hub.url}/api/provider/usage/hosts${query}`);
  return { status: res.status, body: await bodyOf(res) };
}

async function refreshVia(hub: UsageHost, body: Record<string, unknown>) {
  const res = await fetch(`${hub.url}/api/provider/usage/hosts/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await bodyOf<{ refresh: Array<Record<string, unknown>>; view: UsageAcrossHosts; error?: string }>(res) };
}

async function refreshDirect(h: UsageHost, provider: "codex" | "claude" = "codex") {
  const res = await fetch(`${h.url}/api/provider/usage/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
  expect(res.status).toBe(200);
}

async function servedRows(h: UsageHost): Promise<ProviderUsageAllowance[]> {
  return ((await (await fetch(`${h.url}/api/provider/status`)).json()) as { usage: ProviderUsageAllowance[] }).usage;
}

const groupFor = (v: UsageAcrossHosts, key: string) => v.items.filter((g) => g.key === key);
const reads = (hs: UsageHost[]) => hs.map((h) => [h.id, h.codexReads, h.claudeReads]);

describe("GET /api/provider/usage/hosts", () => {
  it("one allowance on two hosts appears once, with each host's own served row and the time it was read", async () => {
    const a = await host("a", { now: () => NOW });
    const b = await host("b", { now: () => NOW, codex: { secondaryUsed: 75 } });
    const hub = await host("hub", { registry: [a.entry(), b.entry()] });
    await refreshDirect(a);
    await refreshDirect(b);
    const { status, body } = await view(hub);
    expect(status).toBe(200);
    const groups = groupFor(body, "codex:account:acct-1:codex");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.linkage).toBe("same");
    expect(groups[0]!.observations.map((o) => o.hostId)).toEqual(["a", "b"]);
    const [rowA] = (await servedRows(a)).filter((r) => r.provider === "codex");
    const [rowB] = (await servedRows(b)).filter((r) => r.provider === "codex");
    expect(groups[0]!.observations.map((o) => o.row)).toEqual([rowA, rowB]);
    expect(groups[0]!.observations.every((o) => typeof o.readAt === "string")).toBe(true);
    expect(body.hosts.map((h) => [h.hostId, h.status, h.usage])).toEqual([["local", "ok", "served"], ["a", "ok", "served"], ["b", "ok", "served"]]);
  });

  it("a conflict and an unknown linkage come through the served path", async () => {
    const a = await host("a", { now: () => NOW });
    const b = await host("b", { now: () => NOW, codex: { secondaryResetsAt: "2026-10-20T03:00:00.000Z" } });
    const c = await host("c", { now: () => NOW, codex: { email: "other@example.com" } });
    const hub = await host("hub", { registry: [a.entry(), b.entry(), c.entry()] });
    for (const h of [a, b, c]) await refreshDirect(h);
    const groups = groupFor((await view(hub)).body, "codex:account:acct-1:codex");
    expect(groups.map((g) => [g.linkage, g.observations.map((o) => o.hostId)])).toEqual([["conflict", ["a", "b"]], ["unknown", ["c"]]]);
    expect(groups[0]!.notes.join("\n")).toContain("is also observed on c under another login email");
    expect(groups[0]!.notes.join("\n")).toContain("the hosts report resets more than 60 s apart");
  });

  it("the same Codex login email under different account ids comes through the served path as two allowances", async () => {
    const a = await host("a", { now: () => NOW });
    const b = await host("b", { now: () => NOW, codex: { accountId: "acct-2" } });
    const hub = await host("hub", { registry: [a.entry(), b.entry()] });
    for (const h of [a, b]) await refreshDirect(h);
    const { body } = await view(hub);
    expect(["codex:account:acct-1:codex", "codex:account:acct-2:codex"].map((k) => groupFor(body, k).map((g) => [g.linkage, g.observations.map((o) => o.hostId)])))
      .toEqual([[["single", ["a"]]], [["single", ["b"]]]]);
  });

  it("every registry host appears with its status: unreachable, older, off, ssh; the rest and this host still served", async () => {
    const a = await host("a");
    const older = await host("older", { shape: "no-provider-routes" });
    const predates = await host("predates", { shape: "predates-usage-windows" });
    const off = await host("off", { usageWindows: false });
    const closed = await closedPortUrl();
    const hub = await host("hub", {
      registry: [a.entry(), { id: "down", transport: "http", url: closed }, older.entry(), predates.entry(), off.entry(),
        { id: "shell", transport: "ssh", target: "example.invalid", user: "x" } as never],
    });
    const { status, body } = await view(hub);
    expect(status).toBe(200);
    expect(body.hosts.map((h) => [h.hostId, h.status, h.usage, h.usageReason ?? null])).toEqual([
      ["local", "ok", "served", null],
      ["a", "ok", "served", null],
      ["down", "unreachable", "unavailable", "not read"],
      ["older", "ok", "older", "this host has no provider status route (its daemon predates it)"],
      ["predates", "ok", "older", "this host doesn't know the provider.usage_windows setting (its daemon predates usage windows)"],
      ["off", "ok", "off", "usage windows are off on this host (provider.usage_windows = false)"],
      ["shell", "unsupported-transport", "unavailable", "not read"],
    ]);
    expect(body.items.flatMap((g) => g.observations.map((o) => o.hostId)).sort()).toEqual(["a", "a", "local", "local"]);
  });

  it("an ordinary read never starts a native read, here or on any host; it only GETs served memory", async () => {
    const a = await host("a");
    const off = await host("off", { usageWindows: false });
    const hub = await host("hub", { registry: [a.entry(), off.entry()] });
    for (let i = 0; i < 3; i++) expect((await view(hub)).status).toBe(200);
    expect(reads([hub, a, off])).toEqual([["hub", 0, 0], ["a", 0, 0], ["off", 0, 0]]);
    expect(a.requests).toEqual(Array(3).fill({ method: "GET", path: "/api/provider/status" }));
    expect(off.requests).toEqual(Array(3).fill(null).flatMap(() => [
      { method: "GET", path: "/api/provider/status" }, { method: "GET", path: "/api/config?view=browser" },
    ]));
  });

  it("an entry naming this daemon is skipped and said so; ?hosts narrows; an unknown id is a 400", async () => {
    setSelfHostId("hub-self");
    const a = await host("a");
    const b = await host("b");
    const hub = await host("hub", { registry: [a.entry(), b.entry(), { id: "hub-self", transport: "http", url: "http://127.0.0.1:9" }] });
    const all = (await view(hub)).body;
    expect(all.skipped).toEqual([{ hostId: "hub-self", reason: "this entry names this daemon, which is read once as local" }]);
    expect(all.hosts.map((h) => h.hostId)).toEqual(["local", "a", "b"]);
    const narrowed = (await view(hub, "?hosts=b")).body;
    expect(narrowed.hosts.map((h) => h.hostId)).toEqual(["local", "b"]);
    expect(a.requests).toHaveLength(1);
    expect(await view(hub, "?hosts=b,nope")).toEqual({ status: 400, body: { error: "unknown host ids: nope" } });
  });

  it("with no host registry (the real reader, a missing file) it is this host only, saying so; a malformed one says it's unreadable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-hosts-registry-"));
    try {
      const missing = await host("hub", { registry: { path: path.join(dir, "hosts.yaml") } });
      const { body } = await view(missing);
      expect(body.registry).toEqual({ state: "absent", note: "no hosts.yaml: this host only" });
      expect(body.hosts.map((h) => h.hostId)).toEqual(["local"]);
      fs.writeFileSync(path.join(dir, "bad.yaml"), "hosts: [ { id: x } ]\n");
      const malformed = await host("hub2", { registry: { path: path.join(dir, "bad.yaml") } });
      const bad = (await view(malformed)).body;
      expect(bad.registry.state).toBe("unreadable");
      expect(bad.hosts.map((h) => h.hostId)).toEqual(["local"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("switch off here: both routes refuse with 409 naming the key, and no host is contacted", async () => {
    const a = await host("a");
    const hub = await host("hub", { usageWindows: false, registry: [a.entry()] });
    const got = await view(hub);
    expect(got.status).toBe(409);
    expect(got.body.message).toBe("Usage across hosts needs usage windows on this daemon. Turn them on with: rig config set provider.usage_windows true");
    expect((await refreshVia(hub, { provider: "codex" })).status).toBe(409);
    expect(a.requests).toEqual([]);
    expect(reads([hub, a])).toEqual([["hub", 0, 0], ["a", 0, 0]]);
  });

  it("no bearer, bearer variable or bearer file reaches the served body", async () => {
    const a = await host("a");
    const b = await host("b");
    const c = await host("c");
    process.env["XHOST_TEST_BEARER"] = "s3cret-bearer-value";
    try {
      const hub = await host("hub", {
        registry: [
          a.entry({ bearer_env: "XHOST_TEST_BEARER" } as never),
          b.entry({ bearer_env: "XHOST_UNSET_BEARER_VAR" } as never),
          c.entry({ bearer_file: "/nonexistent/xhost-bearer-file" } as never),
        ],
      });
      const text = JSON.stringify((await view(hub)).body) + JSON.stringify((await refreshVia(hub, { provider: "codex" })).body);
      for (const secret of ["s3cret-bearer-value", "XHOST_TEST_BEARER", "XHOST_UNSET_BEARER_VAR", "/nonexistent/xhost-bearer-file", "bearer_env", "bearer_file"]) {
        expect(text).not.toContain(secret);
      }
      expect((await view(hub)).body.hosts.map((h) => [h.hostId, h.status])).toEqual([["local", "ok"], ["a", "ok"], ["b", "auth-failed"], ["c", "auth-failed"]]);
    } finally {
      delete process.env["XHOST_TEST_BEARER"];
    }
  });
});

describe("POST /api/provider/usage/hosts/refresh", () => {
  it("a refresh slower than the 5 s read class still succeeds, and its reading reaches the view", async () => {
    // Keep the scripted weekly window before its reset while the delay uses real timers.
    const now = () => "2026-10-14T00:00:00.000Z";
    const a = await host("a", { now, codex: { delayMs: 6_000, secondaryUsed: 85 } });
    const hub = await host("hub", { now, registry: [a.entry()] });
    const started = Date.now();
    const { status, body } = await refreshVia(hub, { provider: "codex" });
    expect(Date.now() - started).toBeGreaterThan(5_000);
    expect(status).toBe(200);
    expect(body.refresh.map((l) => [l["hostId"], l["provider"], l["outcome"]])).toEqual([["local", "codex", "ok"], ["a", "codex", "ok"]]);
    const [group] = groupFor(body.view, "codex:account:acct-1:codex");
    const fromA = group!.observations.find((o) => o.hostId === "a")!.row;
    expect(fromA.windows.find((w) => w.window === "secondary")).toMatchObject({ usedPercent: 85, level: "nearing", freshness: "fresh" });
    expect(a.codexReads).toBe(1);
  }, 20_000);

  it("a Claude refresh slower than the 5 s read class still succeeds, and its identity reaches the view", async () => {
    const a = await host("a", { claude: { delayMs: 6_000, orgId: "org-slow" } });
    const hub = await host("hub", { registry: [a.entry()] });
    const started = Date.now();
    const { status, body } = await refreshVia(hub, { provider: "claude", hosts: ["a"] });
    expect(Date.now() - started).toBeGreaterThan(5_000);
    expect(status).toBe(200);
    expect(body.refresh.map((l) => [l["hostId"], l["provider"], l["outcome"]])).toEqual([["local", "claude", "ok"], ["a", "claude", "ok"]]);
    expect(body.view.items.some((g) => g.observations.some((o) => o.hostId === "a" && (o.row.identity as { orgId?: string } | null)?.orgId === "org-slow"))).toBe(true);
    expect(a.claudeReads).toBe(1);
  }, 20_000);

  it("a leg past its bound fails with its own time and reason, and the host's earlier observation stays beside it", async () => {
    const a = await host("a", { now: () => NOW });
    const hub = await host("hub", { registry: [a.entry()], routes: { usageAcrossHosts: { refreshDeadlineMs: { codex: 300 } } } });
    await refreshDirect(a);
    const before = (await servedRows(a)).find((r) => r.provider === "codex")!;
    a.codex = { hang: true };
    const { body } = await refreshVia(hub, { provider: "codex" });
    const leg = body.refresh.find((l) => l["hostId"] === "a")!;
    expect(leg).toMatchObject({ outcome: "failed", reason: "timeout", detail: "no answer within 300 ms; the host may still finish its read, and its next served reading will show it" });
    expect(typeof leg["at"]).toBe("string");
    const later = (await view(hub)).body;
    expect(later.hosts.find((h) => h.hostId === "a")!.lastRefresh!.codex).toEqual(leg);
    const kept = groupFor(later, "codex:account:acct-1:codex")[0]!.observations.find((o) => o.hostId === "a")!.row;
    expect(kept).toEqual(before);
  });

  it("overlapping matching refreshes share one native read on the host, from one hub and from two", async () => {
    const a = await host("a", { codex: { delayMs: 400 } });
    const hub = await host("hub", { registry: [a.entry()] });
    const hub2 = await host("hub2", { registry: [a.entry()] });
    const answers = await Promise.all([
      refreshVia(hub, { provider: "codex" }),
      refreshVia(hub, { provider: "codex" }),
      refreshVia(hub2, { provider: "codex" }),
    ]);
    expect(a.codexReads).toBe(1);
    expect(a.seen("/api/provider/usage/refresh")).toHaveLength(2);
    const legsToA = answers.map((r) => r.body.refresh.find((l) => l["hostId"] === "a")!);
    expect(legsToA.map((l) => l["outcome"])).toEqual(["ok", "ok", "ok"]);
    expect(legsToA.filter((l) => l["coalesced"] === true)).toHaveLength(2);
  });

  it("a host's own failed read comes back as that host's outcome; each other kind of host says why", async () => {
    const failing = await host("failing", { codex: { fail: { reason: "rpc_error", detail: "the app-server said no" } } });
    const older = await host("older", { shape: "no-provider-routes" });
    const off = await host("off", { usageWindows: false });
    const nolaude = await host("nolaude", { claude: { fail: { reason: "binary_not_found", detail: "no claude on PATH" } } });
    const closed = await closedPortUrl();
    const hub = await host("hub", { registry: [failing.entry(), older.entry(), off.entry(), nolaude.entry(), { id: "down", transport: "http", url: closed }] });
    const codex = (await refreshVia(hub, { provider: "codex" })).body.refresh;
    expect(codex.map((l) => [l["hostId"], l["outcome"], l["reason"] ?? null])).toEqual([
      ["local", "ok", null], ["failing", "failed", "rpc_error"], ["older", "failed", "older"], ["off", "failed", "usage_windows_off"],
      ["nolaude", "ok", null], ["down", "failed", "unreachable"],
    ]);
    const claude = (await refreshVia(hub, { provider: "claude", hosts: ["nolaude"] })).body.refresh;
    expect(claude.map((l) => [l["hostId"], l["reason"] ?? null])).toEqual([["local", null], ["nolaude", "binary_not_found"]]);
  });

  it("refuses a bad provider or hosts list", async () => {
    const hub = await host("hub", { registry: [] });
    expect((await refreshVia(hub, { provider: "gemini" })).status).toBe(400);
    expect((await refreshVia(hub, { provider: "codex", hosts: "a" })).status).toBe(400);
    expect((await refreshVia(hub, { provider: "codex", hosts: [] })).body).toEqual({ error: "hosts must be a non-empty array of host ids" });
    expect((await refreshVia(hub, { providers: [] })).status).toBe(400);
    expect((await refreshVia(hub, { providers: ["codex", "gemini"] })).status).toBe(400);
    for (const body of [{ providers: "claude" }, { provider: "codex", providers: ["claude"] }]) {
      expect(await refreshVia(hub, body), JSON.stringify(body)).toEqual({ status: 400, body: { error: "give either providers (a list) or provider, not both" } });
    }
    expect(hub.codexReads + hub.claudeReads).toBe(0);
    expect((await refreshVia(hub, { provider: "codex", hosts: ["nope"] })).body).toEqual({ error: "unknown host ids: nope" });
  });
});

describe("round 2: linkage evidence, a partial answer, and what a host can send back", () => {
  it("F1 through the served route: two hosts with the same Codex account and no login email stay apart as unknown", async () => {
    const a = await host("a", { now: () => NOW, codex: { email: null } });
    const b = await host("b", { now: () => NOW, codex: { email: null } });
    const hub = await host("hub", { registry: [a.entry(), b.entry()] });
    await refreshDirect(a);
    await refreshDirect(b);
    const groups = groupFor((await view(hub)).body, "codex:account:acct-1:codex");
    expect(groups.map((g) => [g.linkage, g.observations.map((o) => o.hostId)])).toEqual([["unknown", ["a"]], ["unknown", ["b"]]]);
    expect(groups[0]!.notes[0]).toContain("is also observed on b; no login email was reported here;");
  });

  it("F2: past its deadline the view answers with what it has, naming each host it didn't hear from; the refresh answers with the same view and every provider's legs", async () => {
    const slow = await host("slow", { slowReadMs: 400 });
    const hub = await host("hub", {
      registry: Array.from({ length: 6 }, (_, i) => slow.entry({ id: `slow${i + 1}` })),
      routes: { usageAcrossHosts: { viewDeadlineMs: 600 } },
    });
    const started = Date.now();
    const { status, body } = await view(hub);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(status).toBe(200);
    expect(body.hosts.map((h) => [h.hostId, h.status, h.usage, h.usageReason ?? null])).toEqual([
      ["local", "ok", "served", null],
      ...[1, 2, 3, 4].map((i) => [`slow${i}`, "ok", "served", null]),
      ...[5, 6].map((i) => [`slow${i}`, "unreachable", "unavailable", "not heard from within the view's 0.6 s"]),
    ]);
    const refreshed = await refreshVia(hub, { providers: ["codex", "claude"] });
    expect(refreshed.status).toBe(200);
    expect(new Set(refreshed.body.refresh.map((l) => `${l["hostId"]}/${l["provider"]}`)).size).toBe(14);
    expect(refreshed.body.view.hosts.filter((h) => h.usageReason === "not heard from within the view's 0.6 s").map((h) => h.hostId)).toEqual(["slow5", "slow6"]);
  });

  it("F3: a host serving a malformed window or identity is unavailable with the reason; the others are served", async () => {
    const good = await host("good");
    const nullWindow = await host("nullwin", { rewrite: (p, b) => p === "/api/provider/status"
      ? { ...(b as object), usage: ((b as { usage: Array<Record<string, unknown>> }).usage).map((r) => ({ ...r, windows: [null] })) } : b });
    const emptyIdentity = await host("noid", { rewrite: (p, b) => p === "/api/provider/status"
      ? { ...(b as object), usage: ((b as { usage: Array<Record<string, unknown>> }).usage).map((r) => ({ ...r, identity: {} })) } : b });
    const hub = await host("hub", { registry: [good.entry(), nullWindow.entry(), emptyIdentity.entry()] });
    const { status, body } = await view(hub);
    expect(status).toBe(200);
    expect(body.hosts.map((h) => [h.hostId, h.usage, h.usageReason ?? null])).toEqual([
      ["local", "served", null], ["good", "served", null],
      ["nullwin", "unavailable", "this host served usage rows in a shape this daemon doesn't recognize"],
      ["noid", "unavailable", "this host served usage rows in a shape this daemon doesn't recognize"],
    ]);
    expect(body.items.flatMap((g) => g.observations.map((o) => o.hostId)).sort()).toEqual(["good", "good", "local", "local"]);
  });

  it("F4: a host echoing its configured bearer in a row or a refresh detail has it replaced, in the answer and the kept record", async () => {
    const marker = "SYNTHETIC-BEARER-MARKER-7f3a9c";
    process.env["XHOST_MARKER_BEARER"] = marker;
    try {
      const echo = await host("echo", {
        rewrite: (p, b) => {
          if (p === "/api/provider/status") {
            return { ...(b as object), usage: ((b as { usage: Array<Record<string, unknown>> }).usage).map((r) => ({ ...r, identityNote: `seen ${marker} here`, [`k-${marker}`]: 1 })) };
          }
          if (p === "/api/provider/usage/refresh") return { refresh: { at: NOW, outcome: "failed", reason: "rpc_error", detail: `token was ${marker}`, coalesced: false } };
          return b;
        },
      });
      const hub = await host("hub", { registry: [echo.entry({ bearer_env: "XHOST_MARKER_BEARER" } as never)] });
      const first = JSON.stringify((await view(hub)).body);
      const refreshed = JSON.stringify((await refreshVia(hub, { provider: "codex" })).body);
      const later = (await view(hub)).body;
      for (const text of [first, refreshed, JSON.stringify(later)]) expect(text).not.toContain(marker);
      expect(first).toContain(BEARER_REDACTED);
      expect(later.hosts.find((h) => h.hostId === "echo")!.lastRefresh!.codex).toMatchObject({ outcome: "failed", reason: "rpc_error", detail: BEARER_REDACTED });
    } finally {
      delete process.env["XHOST_MARKER_BEARER"];
    }
  });

  it("F5: an answer over the byte bound is not read further; that host is unavailable, or its leg failed, and the rest are served", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const good = await host("good");
    const huge = await host("huge", {
      rewrite: (p, b) => p === "/api/provider/status" ? { ...(b as object), padding: big }
        : p === "/api/provider/usage/refresh" ? { ...(b as object), padding: big } : b,
    });
    const hub = await host("hub", { registry: [good.entry(), huge.entry()] });
    const { body } = await view(hub);
    expect(body.hosts.map((h) => [h.hostId, h.status, h.usage, h.usageReason ?? null])).toEqual([
      ["local", "ok", "served", null], ["good", "ok", "served", null], ["huge", "ok", "unavailable", "answer larger than 1048576 bytes"],
    ]);
    const leg = (await refreshVia(hub, { provider: "codex" })).body.refresh.find((l) => l["hostId"] === "huge");
    expect(leg).toMatchObject({ outcome: "failed", reason: "too_large", detail: "answer larger than 1048576 bytes" });
  });

  it("F6: a registered host's redirect is not followed, for the view or the refresh; the other service sees nothing", async () => {
    const target = await host("target");
    const relay = await redirectingRelay(target.url);
    try {
      const hub = await host("hub", { registry: [{ id: "relay", transport: "http", url: relay.url }] });
      const { body } = await view(hub);
      expect(body.hosts.find((h) => h.hostId === "relay")).toMatchObject({ status: "ok", usage: "unavailable", usageReason: "redirected (HTTP 307); not followed" });
      const leg = (await refreshVia(hub, { provider: "codex" })).body.refresh.find((l) => l["hostId"] === "relay");
      expect(leg).toMatchObject({ outcome: "failed", reason: "redirected", detail: "redirected (HTTP 307); not followed" });
      expect(JSON.stringify(body)).not.toContain(target.url);
      expect(relay.hits.length).toBeGreaterThan(0);
      expect(target.requests).toEqual([]);
      expect([target.codexReads, target.claudeReads]).toEqual([0, 0]);
    } finally {
      await relay.close();
    }
  });
});

describe("round 3: every rendered field checked, failures kept to their host, a scrub per exchange", () => {
  // JSON can't carry a function, so an object whose toString and valueOf aren't callable is what a host can send to make
  // a template string or join throw.
  const TRAP = { toString: 1, valueOf: 1 };
  type Body = Record<string, unknown>;
  const rows = (b: unknown) => (b as { usage: Body[] }).usage;
  const withCodexRow = (patch: (r: Body) => Body) => (p: string, b: unknown) =>
    p === "/api/provider/status" ? { ...(b as Body), usage: rows(b).map((r) => (r["provider"] === "codex" ? patch(r) : r)) } : b;
  const firstWindow = (patch: (w: Body) => Body) => withCodexRow((r) => ({ ...r, windows: (r["windows"] as Body[]).map((w, i) => (i === 0 ? patch(w) : w)) }));
  const SEAT = {
    seatSession: "dev-qa@r", rigName: "r", runtime: "codex",
    configured: { source: "registry", profileRef: "work-a", recordedAt: "2026-10-12T10:00:00Z", profileSaved: true },
    registryNotes: ["a note"], allowance: { linked: false, reason: "not linked" },
    observed: { windowsSampled: true, lastSampledAt: "2026-10-13T23:00:00Z", differsFrom: ["dev-b@r"], note: "possibly a different login" },
  };
  const withSeat = (patch: (s: Body) => Body) => (p: string, b: unknown) =>
    p === "/api/provider/status" ? { ...(b as Body), seatAccounts: [patch(structuredClone(SEAT))] } : b;

  it("today's real rows and seat accounts all pass the checks", async () => {
    const h = await host("real", { now: () => NOW, samples: [
      { seatSession: "a@r", window: "five_hour", usedPercent: 40, resetsAt: "2026-10-14T03:00:00.000Z", sampledAt: NOW },
      { seatSession: "b@r", window: "five_hour", usedPercent: 10, resetsAt: "2026-10-14T06:00:00.000Z", sampledAt: NOW },
      { seatSession: "a@r", window: "weekly", usedPercent: 90, resetsAt: "2026-10-18T00:00:00.000Z", sampledAt: NOW },
    ] });
    const before = await servedRows(h);
    await refreshDirect(h, "codex");
    await refreshDirect(h, "claude");
    h.codex = { fail: { reason: "rpc_error", detail: "no" } };
    await refreshDirect(h, "codex");
    h.codex = { accountId: null, email: null };
    await refreshDirect(h, "codex");
    const after = await servedRows(h);
    const all = [...before, ...after];
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(all.some((r) => r.windows.some((w) => w.disagreeingSeats))).toBe(true);
    expect(all.filter((r) => !isUsageRow(r))).toEqual([]);
    const seat = (seatSession: string, runtime: string) => ({ seatSession, rigName: "r", runtime, lifecycleState: "running" });
    const seats = configuredSeatAccounts({
      seats: [seat("q@r", "codex"), seat("d@r", "codex"), seat("a@r", "claude-code"), seat("b@r", "claude-code"), seat("x@r", "pi"), seat("q@r", "codex")],
      auth: { profiles: ["work-a"], seats: [{ seat: "q@r", rig: "r", runtime: "codex", cwd: "/w", authProfile: "work-a", updatedTs: "2026-10-12T10:00:00Z" },
        { seat: "d@r", rig: "r", runtime: "claude-code", cwd: "/w", authProfile: "gone", updatedTs: "2026-10-12T10:00:00Z" }] } as never,
      usage: after, claudeSamples: h.samples, codexHome: "/h/.codex", claudeConfigDir: undefined, home: "/h",
    });
    expect(seats.length).toBe(6);
    expect(new Set(seats.map((s) => s.configured.source))).toEqual(new Set(["registry", "default_login", "unknown"]));
    expect(seats.filter((s) => !isSeat(s))).toEqual([]);
  });

  const cases: Array<[string, UsageHostOptions["rewrite"], string]> = [
    ["seats", withCodexRow((r) => ({ ...r, seats: TRAP })), "rows"],
    ["identity label (plan)", withCodexRow((r) => ({ ...r, identity: { ...(r["identity"] as Body), planType: TRAP } })), "rows"],
    ["window reason", firstWindow((w) => ({ ...w, levelReason: TRAP })), "rows"],
    ["window remaining percent missing", firstWindow(({ remainingPercent: _r, ...w }) => w), "rows"],
    ["disagreeing seat", firstWindow((w) => ({ ...w, disagreeingSeats: [{ seatSession: TRAP, usedPercent: 1, resetsAt: null, observedAt: NOW }] })), "rows"],
    ["last observed exhaustion", withCodexRow((r) => ({ ...r, lastObservedExhausted: { at: TRAP, window: null, evidence: "at the limit" } })), "rows"],
    ["window expectation", firstWindow((w) => ({ ...w, expectation: { expectedFullSince: TRAP, note: "planning" } })), "rows"],
    ["retained", withCodexRow((r) => ({ ...r, retained: TRAP })), "rows"],
    ["account history", withCodexRow((r) => ({ ...r, accountHistory: TRAP })), "rows"],
    ["saved profile", withCodexRow((r) => ({ ...r, savedProfile: TRAP })), "rows"],
    ["seat account label", withSeat((x) => ({ ...x, configured: { ...(x["configured"] as Body), profileRef: TRAP } })), "seats"],
    ["seat registryNotes not a list", withSeat((x) => ({ ...x, registryNotes: 5 })), "seats"],
    ["seat differsFrom not a list", withSeat((x) => ({ ...x, observed: { ...(x["observed"] as Body), differsFrom: "dev-b@r" } })), "seats"],
  ];
  const REASON = { rows: "this host served usage rows in a shape this daemon doesn't recognize", seats: "this host served seat accounts in a shape this daemon doesn't recognize" };

  it("each rendered field class: a malformed host is unavailable with the reason; this host and a healthy one are served", async () => {
    const good = await host("good");
    const bad = await Promise.all(cases.map(([, rewrite], i) => host(`bad${i}`, { rewrite })));
    for (const h of [good, ...bad]) await refreshDirect(h);
    const hub = await host("hub", { registry: [good.entry(), ...bad.map((h) => h.entry())] });
    const { status, body } = await view(hub);
    expect(status).toBe(200);
    expect(body.hosts.map((h) => [h.hostId, h.usage, h.usageReason ?? null])).toEqual([
      ["local", "served", null], ["good", "served", null],
      ...cases.map(([, , kind], i) => [`bad${i}`, "unavailable", REASON[kind as "rows" | "seats"]]),
    ]);
    // The seat that passed is served, and every healthy seat (the fixture SEAT itself) passes.
    expect(isSeat(SEAT)).toBe(true);
  });

  it("a settings value that can't be shown is named as such; the answer is served", async () => {
    const odd = await host("odd", { usageWindows: false, rewrite: (p, b) => p === "/api/config"
      ? { ...(b as Body), entries: ((b as { entries: Body[] }).entries).map((e) => (e["key"] === "provider.usage_windows" ? { ...e, value: TRAP } : e)) } : b });
    const hub = await host("hub", { registry: [odd.entry()] });
    const { status, body } = await view(hub);
    expect(status).toBe(200);
    expect(body.hosts.find((h) => h.hostId === "odd")).toMatchObject({ usage: "off", usageReason: "usage windows are off on this host (provider.usage_windows = an unrecognized value)" });
  });

  it("an answer nested 2,000 deep, with a configured bearer: that host unavailable, its leg failed; the rest served", async () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 2_000; i++) deep = { d: deep };
    process.env["XHOST_DEEP_BEARER"] = "SYNTHETIC-DEEP-MARKER-0c1e";
    try {
      const good = await host("good");
      const nested = await host("nested", { rewrite: (p, b) => (p === "/api/provider/status" || p === "/api/provider/usage/refresh") ? { ...(b as Body), deep } : b });
      const hub = await host("hub", { registry: [good.entry(), nested.entry({ bearer_env: "XHOST_DEEP_BEARER" } as never)] });
      const { status, body } = await view(hub);
      expect(status).toBe(200);
      expect(body.hosts.map((h) => [h.hostId, h.usage, h.usageReason ?? null])).toEqual([
        ["local", "served", null], ["good", "served", null], ["nested", "unavailable", "this host's answer is nested deeper than 32 levels"],
      ]);
      const refreshed = await refreshVia(hub, { provider: "codex" });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.refresh.find((l) => l["hostId"] === "nested")).toMatchObject({ outcome: "failed", reason: "too_deep", detail: "the host's answer is nested deeper than 32 levels" });
      expect(refreshed.body.refresh.find((l) => l["hostId"] === "good")).toMatchObject({ outcome: "ok" });
    } finally {
      delete process.env["XHOST_DEEP_BEARER"];
    }
  });

  it("each exchange is scrubbed with the bearer it sent: a refresh echoing the sent A after a rotation to B, and settings echoing the newer B", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-hosts-bearer-"));
    const file = path.join(dir, "bearer");
    const A = "SYNTHETIC-ROTATE-A-91f0", B = "SYNTHETIC-ROTATE-B-27c4";
    try {
      fs.writeFileSync(file, A);
      // The refresh: the handler rotates the file to B, then answers with the A it was sent.
      const leg = await host("leg", { rewrite: (p, b) => {
        if (p !== "/api/provider/usage/refresh") return b;
        fs.writeFileSync(file, B);
        return { refresh: { at: NOW, outcome: "failed", reason: "rpc_error", detail: `sent ${A}`, coalesced: false } };
      } });
      const hub = await host("hub", { registry: [leg.entry({ bearer_file: file } as never)] });
      const refreshed = JSON.stringify((await refreshVia(hub, { provider: "codex" })).body);
      const later = (await view(hub)).body;
      for (const text of [refreshed, JSON.stringify(later)]) expect(text).not.toContain(A);
      expect(later.hosts.find((h) => h.hostId === "leg")!.lastRefresh!.codex!.detail).toBe(BEARER_REDACTED);

      // The read: the status answer rotates the file to B before the settings fallback, which echoes B.
      fs.writeFileSync(file, A);
      const read = await host("read", { usageWindows: false, rewrite: (p, b) => {
        if (p === "/api/provider/status") fs.writeFileSync(file, B);
        if (p !== "/api/config") return b;
        return { ...(b as Body), entries: ((b as { entries: Body[] }).entries).map((e) => (e["key"] === "provider.usage_windows" ? { ...e, value: `off ${B}` } : e)) };
      } });
      const hub2 = await host("hub2", { registry: [read.entry({ bearer_file: file } as never)] });
      const seen = (await view(hub2)).body;
      expect(JSON.stringify(seen)).not.toContain(B);
      expect(seen.hosts.find((h) => h.hostId === "read")!.usageReason).toBe(`usage windows are off on this host (provider.usage_windows = ${BEARER_REDACTED})`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an empty Codex login email is no evidence either: it links to nothing", () => {
    const groups = groupUsageAcrossHosts([obs("a", codexRow("acct-1", "")), obs("b", codexRow("acct-1", ""))]);
    expect(groups.map((g) => [g.linkage, g.observations.map((o) => o.hostId)])).toEqual([["unknown", ["a"]], ["unknown", ["b"]]]);
    expect(groups[0]!.notes[0]).toContain("is also observed on b; no login email was reported here;");
  });
});

describe("round 4: the identity keys the label reads, from either provider", () => {
  const TRAP = { toString: 1, valueOf: 1 };
  type Body = Record<string, unknown>;
  const withIdentity = (provider: "codex" | "claude", patch: (id: Body) => Body) => (p: string, b: unknown) =>
    p === "/api/provider/status"
      ? { ...(b as Body), usage: (b as { usage: Body[] }).usage.map((r) => (r["provider"] === provider && r["identity"] ? { ...r, identity: patch(r["identity"] as Body) } : r)) }
      : b;
  const CASES: Array<[string, "codex" | "claude", (id: Body) => Body]> = [
    ["codex-subscriptionType", "codex", (id) => ({ ...id, subscriptionType: TRAP })],
    ["codex-orgId", "codex", (id) => ({ ...id, accountId: null, workspaceId: null, orgId: TRAP })],
    ["codex-orgName", "codex", (id) => ({ ...id, accountId: null, workspaceId: null, orgId: "org-x", orgName: TRAP })],
    ["claude-planType", "claude", (id) => ({ ...id, planType: TRAP })],
    ["claude-accountId", "claude", (id) => ({ ...id, accountId: TRAP })],
    ["claude-workspaceId", "claude", (id) => ({ ...id, workspaceId: TRAP })],
  ];

  it("an identity carrying another provider's key with an unprintable value: that host unavailable, this host and a healthy one served", async () => {
    const good = await host("good");
    const bad = await Promise.all(CASES.map(([id, provider, patch]) => host(id, { rewrite: withIdentity(provider, patch) })));
    for (const h of [good, ...bad]) {
      await refreshDirect(h, "codex");
      await refreshDirect(h, "claude");
    }
    const hub = await host("hub", { registry: [good.entry(), ...bad.map((h) => h.entry())] });
    const { status, body } = await view(hub);
    expect(status).toBe(200);
    expect(body.hosts.map((h) => [h.hostId, h.usage, h.usageReason ?? null])).toEqual([
      ["local", "served", null], ["good", "served", null],
      ...CASES.map(([id]) => [id, "unavailable", "this host served usage rows in a shape this daemon doesn't recognize"]),
    ]);
  });

  it("another provider's key with a value of the right type is served (absent or typed is fine)", async () => {
    const extra = await host("extra", { rewrite: withIdentity("codex", (id) => ({ ...id, orgName: null, subscriptionType: "team" })) });
    await refreshDirect(extra, "codex");
    const hub = await host("hub", { registry: [extra.entry()] });
    expect((await view(hub)).body.hosts.find((h) => h.hostId === "extra")).toMatchObject({ usage: "served" });
  });
});
