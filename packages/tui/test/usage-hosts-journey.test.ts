// Slice 01 — System → Usage across hosts through the actual TUI path (explorer click → hydrate → render), with a real
// DaemonClient against a loopback hub daemon that reads loopback hosts: the daemon's real provider and config routes
// over real provider services, with scripted native readers that count their reads (usage-hosts-harness.ts). Proves
// every state draws from the served fields verbatim, the same facts as `rig provider status --all-hosts`, and that
// the view only ever GETs the served view: no refresh, no native read anywhere.
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { COMMAND_REGISTRY } from "../src/commands/registry.js";
import { renderScreen } from "../src/render.js";
import { createLiveRefresh } from "../src/live.js";
import { pageReadKey } from "../src/page-read.js";
import { USAGE_HOSTS_HEADER, USAGE_HOSTS_HINT } from "../src/usage/usage-hosts-model.js";
import type { FleetSnapshot, Screen, ViewStateStore } from "../src/types.js";
import { closedPortUrl, redirectingRelay, SEAT_SHAPES, UsageHost, usageAcrossHostsFacts, type UsageHostOptions } from "../../daemon/test/helpers/usage-hosts-harness.js";

const NOW = "2026-10-13T23:30:00.000Z";

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

/** A TUI on the hub: a real client (every request traced), the real view state, hydrate and render. */
function tuiOn(hub: UsageHost, opts: { gone?: () => boolean; hold?: () => boolean } = {}) {
  const trace: string[] = [];
  const client = new DaemonClient({ baseUrl: hub.url, fetchImpl: (async (url, init) => {
    const u = new URL(String(url));
    trace.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    // A daemon from before usage across hosts: the route isn't mounted.
    if (opts.gone?.() && u.pathname === "/api/provider/usage/hosts") return new Response("Not Found", { status: 404 });
    // A read that doesn't answer until its page is left (its signal aborts).
    if (opts.hold?.() && u.pathname === "/api/provider/usage/hosts") {
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    return fetch(url as string, init);
  }) as typeof fetch });
  let snap: FleetSnapshot = emptySnapshot();
  const view: ViewStateStore = createViewState({ instanceId: "fixture-view", getSnapshot: () => snap, timeZone: "Europe/London" });
  const refresh = async () => { snap = await hydrateSnapshot(client, undefined, null, null, null, view.get()); };
  const draw = (): Screen => {
    const screen = renderScreen(view.get(), snap, { cols: 1000, rows: 600 });
    view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    return renderScreen(view.get(), snap, { cols: 1000, rows: 600 });
  };
  const click = (matches: (a: Screen["hitMap"][number]["action"]) => boolean) => {
    const target = draw().hitMap.find((t) => matches(t.action));
    expect(target).toBeDefined();
    view.dispatch(target!.action);
  };
  const openView = async () => {
    click((a) => a.type === "jump" && a.section === "system");
    click((a) => a.type === "jump" && a.section === "usage-hosts");
    await refresh();
  };
  return { client, trace, view, refresh, draw, click, openView, text: () => draw().lines.join("\n"), snap: () => snap };
}

describe("System → Usage across hosts", () => {
  it("draws every served fact verbatim, the same facts the CLI prints, with each host's status and the groups", async () => {
    // a also serves a seat in each observed shape, so the seat facts are held to the same list.
    const a = await host("a", { rewrite: (p, body) => p === "/api/provider/status" ? { ...(body as object), seatAccounts: SEAT_SHAPES } : body });
    const b = await host("b", { codex: { secondaryUsed: 90, secondaryResetsAt: "2026-10-20T04:00:00.000Z" } });
    const c = await host("c", { codex: { email: "other@example.com" } });
    const off = await host("off", { usageWindows: false });
    const older = await host("older", { shape: "no-provider-routes" });
    const down = await closedPortUrl();
    const failing = await host("failing");
    const hub = await host("hub", {
      registry: [a.entry(), b.entry(), c.entry(), off.entry(), older.entry(), { id: "down", transport: "http", url: down }, failing.entry(),
        { id: "shell", transport: "ssh", target: "example.invalid", user: "x" } as never],
      routes: { usageAcrossHosts: { now: () => NOW, refreshDeadlineMs: { codex: 300 } } },
    });
    for (const h of [a, b, c, failing]) await refreshDirect(h);
    failing.codex = { hang: true };
    await fetch(`${hub.url}/api/provider/usage/hosts/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "codex", hosts: ["failing"] }) });

    const served = await (await fetch(`${hub.url}/api/provider/usage/hosts`)).json() as Record<string, unknown>;
    const tui = tuiOn(hub);
    await tui.openView();
    const text = tui.text();
    const facts = usageAcrossHostsFacts(served);
    expect(facts.length).toBeGreaterThan(30);
    expect(facts.filter((f) => !text.includes(f))).toEqual([]);
    expect(facts).toEqual(expect.arrayContaining(["seat-withheld-differs@r", "differs from peer-b@r", "differs from peer-c@r, peer-d@r", "differs from peer-e@r"]));
    expect(text).toContain("codex  account acct-1 · bucket codex  [the same allowance on 4 hosts, disagreeing: local, a, b, failing]");
    expect(text).toContain("codex  account acct-1 · bucket codex  [linkage unknown; observed on c]");
    expect(text).toContain("  older  answered · usage older: this host has no provider status route (its daemon predates it)");
    expect(text).toContain("  shell  unsupported-transport (");
    expect(text).toContain("refresh from here (codex) failed at");
    expect(text).toContain("; this host's earlier observations are kept");
    expect(text).not.toMatch(/\d+% left \+|total|sum of/i);
  });

  it("one allowance agreeing on two hosts is one entry naming both, never a sum", async () => {
    const a = await host("a");
    const b = await host("b");
    const hub = await host("hub", { registry: [a.entry(), b.entry()] });
    for (const h of [a, b]) await refreshDirect(h);
    const tui = tuiOn(hub);
    await tui.openView();
    const text = tui.text();
    // An entry's line carries its linkage in brackets; each host's row under it doesn't.
    const entries = text.split("\n").filter((l) => / {2}codex {2}account acct-1 · bucket codex {2}\[/.test(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("codex  account acct-1 · bucket codex  [the same allowance on 2 hosts: a, b]");
    expect(text).toContain("    on a (read ");
    expect(text).toContain("    on b (read ");
    expect(text).not.toMatch(/\d+% left \+|total|sum of/i);
  });

  it("says what it is: the header and hint as worded, never 'never refreshes', and no fleet-wide claim", async () => {
    const hub = await host("hub", { registry: [] });
    const tui = tuiOn(hub);
    await tui.openView();
    const text = tui.text();
    expect(USAGE_HOSTS_HEADER).toBe("registered hosts, as this daemon reads them · not proof of the login a running session uses");
    expect(USAGE_HOSTS_HINT).toBe("This view shows what the hosts already hold. It never starts a refresh or reads the logins. To read them now: rig provider status --all-hosts --refresh [--provider codex|claude]");
    expect(text).toContain(`  ${USAGE_HOSTS_HEADER}`);
    expect(text).toContain(`  ${USAGE_HOSTS_HINT}`);
    expect(text.toLowerCase()).not.toContain("never refreshes");
    expect(text.toLowerCase()).not.toMatch(/fleet-wide(?! ·)|all machines|every machine/);
  });

  it("never starts a native read or a refresh: across navigation, the command and three live re-reads, only GETs", async () => {
    const a = await host("a");
    const off = await host("off", { usageWindows: false });
    const hub = await host("hub", { registry: [a.entry(), off.entry()] });
    const tui = tuiOn(hub);
    await tui.openView();
    tui.view.dispatch(parseCommand("back"));
    tui.view.dispatch(parseCommand("usage-hosts"));
    await tui.refresh();
    const live = createLiveRefresh({ now: () => 1_000, scopeKey: () => pageReadKey(tui.view.get()), onFrame: () => {},
      hydrate: (page, signal) => hydrateSnapshot(tui.client.forPage(page, signal), undefined, null, null, null, tui.view.get()),
      setTimeout: () => ({ unref() {} }) as never, clearTimeout: () => {} });
    for (let i = 0; i < 3; i++) await live.refresh();
    live.close();
    expect([hub, a, off].map((h) => [h.id, h.codexReads, h.claudeReads])).toEqual([["hub", 0, 0], ["a", 0, 0], ["off", 0, 0]]);
    const usageTrace = tui.trace.filter((t) => t.includes("/api/provider"));
    expect(usageTrace.length).toBe(5);
    expect(new Set(usageTrace)).toEqual(new Set(["GET /api/provider/usage/hosts"]));
    expect(tui.trace.every((t) => t.startsWith("GET "))).toBe(true);
    for (const h of [hub, a, off]) expect(h.requests.every((r) => r.method === "GET")).toBe(true);
    expect(new Set(a.requests.map((r) => r.path))).toEqual(new Set(["/api/provider/status"]));
    expect(new Set(off.requests.map((r) => r.path))).toEqual(new Set(["/api/provider/status", "/api/config?view=browser"]));
  });

  it("off or older at this daemon: the daemon's own message, or that it doesn't serve the view", async () => {
    const offHub = await host("hub", { usageWindows: false, registry: [] });
    const off = tuiOn(offHub);
    await off.openView();
    expect(off.text()).toContain("  Usage across hosts needs usage windows on this daemon. Turn them on with: rig config set provider.usage_windows true");
    const hub = await host("hub2", { registry: [] });
    const older = tuiOn(hub, { gone: () => true });
    await older.openView();
    expect(older.text()).toContain("  This daemon doesn't serve usage across hosts (HTTP 404).");
    expect(older.snap().readErrors.join("\n")).toContain("usage across hosts: HTTP 404");
  });

  it("a good read, then a 503: the previous view stays, marked retained; then a 404 drops it and says so", async () => {
    const a = await host("a");
    const hub = await host("hub", { registry: [a.entry()] });
    await refreshDirect(a);
    let gone = false;
    let now = 1_000;
    const tui = tuiOn(hub, { gone: () => gone });
    tui.view.dispatch(parseCommand("usage-hosts"));
    const live = createLiveRefresh({ now: () => now, scopeKey: () => pageReadKey(tui.view.get()), onFrame: () => {},
      hydrate: (page, signal) => hydrateSnapshot(tui.client.forPage(page, signal), undefined, null, null, null, tui.view.get()),
      setTimeout: () => ({ unref() {} }) as never, clearTimeout: () => {} });
    const screen = () => renderScreen(tui.view.get(), live.snapshot(), { cols: 1000, rows: 600, load: live.load() }).lines.join("\n");

    await live.refresh();
    expect(screen()).toContain("on a (read ");
    expect(live.load().retainedAt).toBeUndefined();

    hub.wired = false; now = 2_000;
    await live.refresh();
    expect(screen()).toContain("on a (read ");
    expect(screen()).not.toContain("Usage across hosts unavailable");
    expect(live.load()).toMatchObject({ stale: true, retainedAt: 1_000 });
    expect(screen()).toContain("Could not refresh");
    expect(live.snapshot().readErrors.join("\n")).toContain("/api/provider/usage/hosts: HTTP 503");

    gone = true; now = 3_000;
    await live.refresh();
    expect(screen()).toContain("This daemon doesn't serve usage across hosts (HTTP 404).");
    expect(screen()).not.toContain("on a (read ");
    live.close();
    expect(a.codexReads).toBe(1);
  });

  it("a slow read here holds up no other page: leaving it aborts it, and the next page reads and draws at once", async () => {
    const a = await host("a");
    const hub = await host("hub", { registry: [a.entry()] });
    await refreshDirect(hub);
    const tui = tuiOn(hub, { hold: () => true });
    tui.view.dispatch(parseCommand("usage-hosts"));
    const live = createLiveRefresh({ now: () => 1_000, scopeKey: () => pageReadKey(tui.view.get()), onFrame: () => {},
      hydrate: (page, signal) => hydrateSnapshot(tui.client.forPage(page, signal), undefined, null, null, null, tui.view.get()),
      setTimeout: () => ({ unref() {} }) as never, clearTimeout: () => {} });
    const stuck = live.refresh();
    await new Promise((r) => setTimeout(r, 50));
    expect(live.load().inFlight).toBe(true);
    tui.view.dispatch(parseCommand("usage"));
    await live.refresh();
    const screen = renderScreen(tui.view.get(), live.snapshot(), { cols: 1000, rows: 600, load: live.load() }).lines.join("\n");
    expect(screen).toContain("System · Usage windows and seat accounts");
    expect(screen).toContain("account acct-1");
    await stuck;
    live.close();
  });

  it("is discoverable: an explorer row after Usage, a usage-hosts command, and back to where the person was", async () => {
    const hub = await host("hub", { registry: [] });
    const tui = tuiOn(hub);
    tui.click((a) => a.type === "jump" && a.section === "system");
    const rows = tui.draw().lines.join("\n");
    expect(rows.indexOf("Usage · all hosts")).toBeGreaterThan(rows.indexOf("  Usage"));
    const command = COMMAND_REGISTRY.find((c) => c.name === "usage-hosts");
    expect(command?.description).toBe("System Usage across hosts: usage windows on the registered hosts, as each holds them (read-only)");
    tui.view.dispatch(parseCommand("connections"));
    tui.view.dispatch(parseCommand("usage-hosts"));
    expect(tui.view.get().section).toBe("usage-hosts");
    tui.view.dispatch(parseCommand("back"));
    expect(tui.view.get().section).toBe("connections");
  });
});

describe("System → Usage across hosts: what #1246 serves since the plan", () => {
  type Body = Record<string, unknown>;
  const TRAP = { toString: 1, valueOf: 1 };
  const rows = (b: unknown) => (b as { usage: Body[] }).usage;

  it("each way a host can't be used draws with its reason: late, malformed, too large, redirected, nested too deep, couldn't be read", async () => {
    const slow = await host("late", { slowReadMs: 800 });
    const malformed = await host("malformed", { rewrite: (p, b) => p === "/api/provider/status" ? { ...(b as Body), usage: rows(b).map((r) => ({ ...r, windows: [null] })) } : b });
    const huge = await host("huge", { rewrite: (p, b) => p === "/api/provider/status" ? { ...(b as Body), padding: "x".repeat(2 * 1024 * 1024) } : b });
    let deep: unknown = "leaf";
    for (let i = 0; i < 100; i++) deep = { d: deep };
    const nested = await host("nested", { rewrite: (p, b) => p === "/api/provider/status" ? { ...(b as Body), deep } : b });
    const target = await host("target");
    const relay = await redirectingRelay(target.url);
    const broken = await host("broken");
    try {
      // A host whose answer throws while it's read (its status can't be read at all).
      const remoteFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const res = await fetch(url, init);
        if (!String(url).startsWith(broken.url)) return res;
        return new Proxy(res, { get: (t, k) => (k === "status" ? (() => { throw new Error("unreadable"); })() : Reflect.get(t, k, t)) });
      }) as typeof fetch;
      const hub = await host("hub", {
        remoteFetch,
        routes: { usageAcrossHosts: { now: () => NOW, viewDeadlineMs: 500 } },
        registry: [malformed.entry(), huge.entry(), nested.entry(), { id: "relay", transport: "http", url: relay.url }, broken.entry(), slow.entry()],
      });
      const tui = tuiOn(hub);
      await tui.openView();
      const text = tui.text();
      for (const line of [
        "  malformed  answered · usage unavailable: this host served usage rows in a shape this daemon doesn't recognize",
        "  huge  answered · usage unavailable: answer larger than 1048576 bytes",
        "  nested  answered · usage unavailable: this host's answer is nested deeper than 32 levels",
        "  relay  answered · usage unavailable: redirected (HTTP 307); not followed",
        "  broken  answered · usage unavailable: this host's answer couldn't be read",
        "  late  unreachable (not heard from within the view's 0.5 s) · usage unavailable: not heard from within the view's 0.5 s",
      ]) expect(text).toContain(line);
      expect(text).not.toContain("unreadable");
      expect(target.requests).toEqual([]);
    } finally {
      await relay.close();
    }
  });

  it("absent optional text reads as the CLI words it: no reason given, and an absent detail or note drops its clause", async () => {
    const quiet = await host("quiet", {
      rewrite: (p, b) => {
        if (p === "/api/provider/usage/refresh") return { refresh: { at: NOW, outcome: "failed", coalesced: false } };
        if (p !== "/api/provider/status") return b;
        return {
          ...(b as Body),
          usage: rows(b).map((r) => (r["provider"] === "codex" ? { ...r, lastRefresh: { at: NOW, outcome: "failed" } } : r)),
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
    await fetch(`${hub.url}/api/provider/usage/hosts/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "codex", hosts: ["quiet"] }) });
    const tui = tuiOn(hub);
    await tui.openView();
    const lines = tui.draw().lines.map((l) => l.trimEnd());
    const text = lines.join("\n");
    expect(text).not.toContain("undefined");
    expect(text).not.toMatch(/failed at [^:]*: unknown/);
    expect(text).toContain(`    refresh from here (codex) failed at ${NOW}: no reason given; this host's earlier observations are kept`);
    expect(text).toContain(`refresh failed at ${NOW}: no reason given; last reading kept, marked old`);
    expect(lines.some((l) => l.endsWith("observed: differs from dev-b@r"))).toBe(true);
  });

  it("a seat's difference draws as the CLI prints it, whatever windowsSampled or withheld say (sampled false, absent, withheld)", async () => {
    const seats = await host("seats", { rewrite: (p, b) => p === "/api/provider/status" ? { ...(b as Body), seatAccounts: SEAT_SHAPES } : b });
    const hub = await host("hub", { registry: [seats.entry()] });
    const tui = tuiOn(hub);
    await tui.openView();
    const lines = tui.draw().lines.map((l) => l.slice(l.indexOf("┃") + 2).trimEnd());
    // Each seat's observed lines, in order, as `rig provider status --all-hosts` prints them.
    const observed = (seat: string) => {
      const at = lines.findIndex((l) => l.startsWith(`  ${seat}  `));
      const end = lines.findIndex((l, i) => i > at && !l.startsWith("    "));
      return lines.slice(at + 1, end).filter((l) => l.startsWith("    observed: "));
    };
    expect(observed("seat-false-differs@r")).toEqual(["    observed: differs from peer-b@r (false-sampled note)"]);
    expect(observed("seat-absent-differs@r")).toEqual(["    observed: differs from peer-c@r, peer-d@r"]);
    expect(observed("seat-withheld-differs@r")).toEqual(["    observed: differs from peer-e@r (withheld-differs note)"]);
    expect(observed("seat-differs@r")).toEqual(["    observed: differs from peer-a@r (possibly a different login)"]);
    expect(observed("seat-sampled@r")).toEqual(["    observed: this seat's status line last reported windows at 2026-10-13T23:01:00Z"]);
    expect(observed("seat-unsampled@r")).toEqual(["    observed: no status-line windows from this seat yet"]);
    expect(observed("seat-withheld@r")).toEqual(["    observed: observation withheld: 2 seats share it"]);
  });

  it("a field no view draws passes through as served, whatever it holds, and the view still draws", async () => {
    const odd = await host("odd", { rewrite: (p, b) => p === "/api/provider/status" ? { ...(b as Body), usage: rows(b).map((r) => ({ ...r, source: TRAP, extra: TRAP })) } : b });
    await refreshDirect(odd);
    const hub = await host("hub", { registry: [odd.entry()] });
    const tui = tuiOn(hub);
    await tui.openView();
    expect(tui.text()).toContain("    on odd (read ");
    expect(tui.snap().readErrors).toEqual([]);
  });
});
