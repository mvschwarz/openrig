// Slice 01 — System → Usage through the actual TUI path: explorer click → hydrate → render, against the daemon's own
// provider and config routes serving fixture read models (plain served JSON). Proves every state renders from the
// served fields verbatim, "off" and "older" are told apart without a probe, a failed or absent route leaves the other
// sections working, and the view only ever GETs the read model: never the refresh route, never a POST.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { providerRoutes } from "../../daemon/src/routes/provider.js";
import { configRoutes } from "../../daemon/src/routes/config.js";
import { gatewayRoutes } from "../../daemon/src/routes/gateway.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { COMMAND_REGISTRY } from "../src/commands/registry.js";
import { renderScreen } from "../src/render.js";
import { resolveEscapeAction } from "../src/input.js";
import { createLiveRefresh } from "../src/live.js";
import { pageReadKey } from "../src/page-read.js";
import type { FleetSnapshot, ViewStateStore, Screen } from "../src/types.js";

const BASE = { accounts: [], bindings: [], signals: [], asOf: "2026-10-13T18:00:00.000Z", hostUsage: [] };

/** One served model with every state the view must show. Strings are the daemon's own wording where it has one. */
const USAGE = [
  {
    provider: "codex",
    identity: { accountId: "acct-1", workspaceId: null, limitId: "codex", email: "a@x.example", planType: "plus", source: "rateLimits accountId" },
    source: { kind: "codex_app_server", host: "local" }, observedAt: "2026-10-13T17:20:00.000Z", seats: "unknown",
    windows: [
      { window: "primary", durationMins: 300, usedPercent: 92, remainingPercent: 8, resetsAt: "2026-10-13T19:00:00.000Z",
        observedAt: "2026-10-13T17:20:00.000Z", level: "nearing", levelReason: "80% or more used",
        freshness: "stale", freshnessReason: "refresh failed at 2026-10-13T17:58:00.000Z; this reading is older" },
      { window: "secondary", durationMins: 10080, usedPercent: 100, remainingPercent: 0, resetsAt: "2026-10-16T09:00:00.000Z",
        observedAt: "2026-10-13T17:20:00.000Z", level: "exhausted", levelReason: "at the limit",
        freshness: "stale", freshnessReason: "refresh failed at 2026-10-13T17:58:00.000Z; this reading is older" },
    ],
    limitEvidence: null, latestFromSource: true,
    lastRefresh: { at: "2026-10-13T17:58:00.000Z", outcome: "failed", reason: "timeout", detail: "no answer within 35 s" },
    currentAvailability: "unknown",
    savedProfiles: { names: ["work-a", "work-b"], note: "saved rig auth profiles: not read (usage unknown); this reading is only the login active in the daemon's CODEX_HOME" },
  },
  {
    provider: "claude",
    identity: { orgId: null, limitId: "all models", email: null, orgName: null, subscriptionType: null, source: "unresolved" },
    source: { kind: "claude_statusline_samples", host: "local" }, observedAt: "2026-10-13T17:59:30.000Z", seats: "unknown",
    windows: [
      { window: "five_hour", durationMins: 300, usedPercent: 40, remainingPercent: 60, resetsAt: "2026-10-13T17:00:00.000Z",
        observedAt: "2026-10-13T17:59:30.000Z", seatSession: "dev-build@r", level: "unknown",
        levelReason: "reset passed at 2026-10-13T17:00:00.000Z; a new reading is needed", freshness: "fresh",
        disagreeingSeats: [{ seatSession: "dev-r1@r", usedPercent: 10, resetsAt: "2026-10-13T21:00:00.000Z", observedAt: "2026-10-13T17:59:00.000Z" }] },
    ],
    limitEvidence: null, latestFromSource: true, lastRefresh: null, currentAvailability: "unknown",
    identityNote: "identity not read yet (rig provider status --refresh); windows: status-line readings from dev-build@r at their own times",
    unresolved: { note: "identity not read yet: not matched to, merged with or replacing any other row", keptReads: 3, droppedReads: 1 },
  },
  {
    provider: "codex",
    identity: { accountId: "acct-0", workspaceId: null, limitId: "codex", email: "a@x.example", planType: "plus", source: "rateLimits accountId" },
    source: { kind: "codex_app_server", host: "local" }, observedAt: "2026-10-13T09:00:00.000Z", seats: "unknown",
    windows: [{ window: "primary", durationMins: 300, usedPercent: 5, remainingPercent: 95, resetsAt: "2026-10-13T13:00:00.000Z",
      observedAt: "2026-10-13T09:00:00.000Z", level: "unknown", levelReason: "reset passed at 2026-10-13T13:00:00.000Z; a new reading is needed",
      freshness: "stale", freshnessReason: "a later read exists" }],
    limitEvidence: null, latestFromSource: false, lastRefresh: null, currentAvailability: "unknown",
  },
];
const UNAVAILABLE = { provider: "codex", identity: null, source: { kind: "codex_app_server", host: "local" }, observedAt: null, seats: "unknown",
  windows: [], limitEvidence: null, latestFromSource: false, lastRefresh: null, currentAvailability: "unknown",
  unavailableReason: "no reading yet: read on request with rig provider status --refresh" };

const SEATS = [
  { seatSession: "dev-qa@r", rigName: "r", runtime: "codex",
    configured: { source: "registry", profileRef: "work-a", recordedAt: "2026-10-12T10:00:00Z", profileSaved: null },
    registryNotes: ["can't tell whether profile work-a is saved on this host: the profile folder couldn't be read (EACCES)", "registry row names rig other; this seat is in rig r"],
    allowance: { linked: false, reason: "a registry profile name and an observed account are different kinds of fact; nothing supported links them without reading the profile's contents" },
    observed: { note: "no per-seat observation for Codex" } },
  { seatSession: "dev-cx@r", rigName: "r", runtime: "codex",
    configured: { source: "unknown", reason: "the seat registry exists but couldn't be read (EACCES)" },
    allowance: { linked: false, reason: "no configured account" }, observed: { note: "no per-seat observation for Codex" } },
  { seatSession: "dev-build@r", rigName: "r", runtime: "claude-code",
    configured: { source: "default_login", home: "/h/.claude", homeNote: "the login in the daemon's Claude config dir, shared by every Claude seat on this daemon" },
    allowance: { linked: false, reason: "the usage read reads the login this home holds now; the seat runs the login that was active when it launched" },
    observed: { windowsSampled: true, lastSampledAt: "2026-10-13T17:59:30.000Z", differsFrom: ["dev-r1@r"],
      note: "possibly a different login: this seat's status line reports windows that differ from another seat's (a reset more than 60 s apart); not a verdict" } },
  { seatSession: "a@r", rigName: "r", runtime: "claude-code",
    configured: { source: "default_login", home: null, homeNote: "CLAUDE_CONFIG_DIR is set but empty: it resolves to each seat's working directory" },
    allowance: { linked: false, reason: "the usage read reads the login this home holds now; the seat runs the login that was active when it launched" },
    observed: { withheld: true, note: "observation withheld: 2 seats share session name a@r; status-line samples are keyed by session name and cannot be attributed to one seat" } },
  { seatSession: "t@r", rigName: "r", runtime: "terminal",
    configured: { source: "unknown", reason: "no account configuration is known for runtime terminal" },
    allowance: { linked: false, reason: "no configured account" } },
];

let home: string, settings: SettingsStore, client: DaemonClient, snap: FleetSnapshot, view: ViewStateStore;
let trace: string[], model: Record<string, unknown>, providerWired: boolean, hideSwitchKey: boolean;
let refreshUsage: ReturnType<typeof vi.fn>, external: ReturnType<typeof vi.fn>, noProviderRoutes: boolean;
let app: Hono;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "s01-usage-journey-"));
  settings = new SettingsStore(join(home, "config.json"));
  external = vi.fn(() => { throw new Error("unexpected external operation"); });
  vi.stubGlobal("fetch", external);
  refreshUsage = vi.fn(async () => { throw new Error("the view must never refresh"); });
  model = { ...BASE, usage: [...USAGE, UNAVAILABLE], seatAccounts: SEATS };
  providerWired = true; hideSwitchKey = false; noProviderRoutes = false;
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("settingsStore" as never, settings as never);
    c.set("gatewaySubsystem" as never, { status: () => ({ state: "disabled" }), restart: external } as never);
    if (providerWired) c.set("providerService" as never, { getReadModel: async () => model, refreshUsage } as never);
    await next();
  });
  app.route("/api/provider", providerRoutes());
  app.route("/api/config", configRoutes({ home }));
  app.route("/api/gateway", gatewayRoutes({ home }));
  trace = [];
  client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url, init) => {
    const u = new URL(String(url));
    trace.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    if (u.pathname === "/healthz") return Response.json({ status: "ok", selfHostId: "fixture-host", semver: "fixture-version", commit: "fixture-commit" });
    // A daemon from before provider routes: the path isn't mounted.
    if (noProviderRoutes && u.pathname.startsWith("/api/provider/")) return new Response("Not Found", { status: 404 });
    const res = await app.request(u.pathname + u.search, init);
    // An older daemon's config browser: the same contract, without the usage-windows key.
    if (hideSwitchKey && u.pathname === "/api/config") {
      const body = await res.json() as { entries: Array<{ key: string }> };
      return Response.json({ ...body, entries: body.entries.filter((e) => e.key !== "provider.usage_windows") });
    }
    return res;
  }) as typeof fetch });
  snap = emptySnapshot();
  view = createViewState({ instanceId: "fixture-view", getSnapshot: () => snap, timeZone: "Europe/London" });
});
afterEach(() => { vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });

async function refresh() { snap = await hydrateSnapshot(client, undefined, null, null, null, view.get()); }
function draw(cols = 400, rows = 400): Screen {
  const screen = renderScreen(view.get(), snap, { cols, rows });
  view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
  return renderScreen(view.get(), snap, { cols, rows });
}
const text = () => draw().lines.join("\n");
function click(screen: Screen, matches: (action: Screen["hitMap"][number]["action"]) => boolean) {
  const target = screen.hitMap.find((t) => matches(t.action));
  expect(target).toBeDefined();
  view.dispatch(target!.action);
}
async function openUsage() {
  click(draw(), (a) => a.type === "jump" && a.section === "system");
  click(draw(), (a) => a.type === "jump" && a.section === "usage");
  await refresh();
}
/** Every string leaf under the given keys, at any depth: the served facts the view must show verbatim. */
function servedStrings(value: unknown, keys: ReadonlySet<string>, out: string[] = [], key = ""): string[] {
  if (typeof value === "string" && keys.has(key)) out.push(value);
  else if (Array.isArray(value)) for (const v of value) servedStrings(v, keys, out, key);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) servedStrings(v, keys, out, k);
  return out;
}

describe("System → Usage in the normal TUI journey", () => {
  it("is discoverable from the explorer and the command list, and draws every served state with the scope header", async () => {
    view.dispatch(parseCommand(":scopes"));
    await openUsage();
    const out = text();
    expect(out).toContain("System · Usage windows and seat accounts");
    expect(out).toContain("this host's daemon only · not fleet-wide · not proof of the login a running session uses");
    expect(out).toContain("This view shows what this daemon already holds and never reads the logins itself. To read them now: rig provider status --refresh [--provider codex|claude]");
    expect(out).not.toContain("never refreshes");
    // Fresh/nearing, exhausted, stale, failed refresh beside the kept reading, unavailable, unresolved, earlier rows.
    expect(out).toContain("codex  account acct-1 · bucket codex · a@x.example · plus · seats unknown");
    expect(out).toContain("5h (primary)  8% left");
    expect(out).toContain("level: nearing (80% or more used)");
    expect(out).toContain("level: exhausted (at the limit)");
    expect(out).toContain("freshness: stale: refresh failed at 2026-10-13T17:58:00.000Z; this reading is older");
    expect(out).toContain("refresh failed at 2026-10-13T17:58:00.000Z: timeout (no answer within 35 s); last reading kept, marked old");
    expect(out).toContain("codex  unavailable: no reading yet: read on request with rig provider status --refresh");
    expect(out).toContain("claude  identity unresolved · bucket all models · email not reported · seats unknown");
    expect(out).toContain("identity not read yet: not matched to, merged with or replacing any other row");
    expect(out).toContain("kept from the 3 most recent unresolved reads (1 older dropped)");
    expect(out).toContain("level: unknown (reset passed at 2026-10-13T17:00:00.000Z; a new reading is needed)");
    expect(out).toContain("freshness: fresh");
    expect(out).toContain("seat dev-r1@r reports 10% used");
    expect(out).toContain("account acct-0 · bucket codex · a@x.example · plus · seats unknown  [from an earlier read; the latest read didn't match this row]");
    expect(out).toContain("freshness: stale: a later read exists");
    // Seats: configured, can't-tell, unknown, mismatched, withheld, never linked.
    expect(out).toContain("dev-qa@r  codex  configured: profile work-a (registry, recorded 2026-10-12T10:00:00Z; whether the profile is saved: unknown) · allowance not linked");
    expect(out).not.toContain("not saved");
    expect(out).toContain("dev-cx@r  codex  configured: unknown (the seat registry exists but couldn't be read (EACCES)) · allowance not linked");
    expect(out).toContain("observed: this seat's status line last reported windows at 2026-10-13T17:59:30.000Z");
    expect(out).toContain("observed: differs from dev-r1@r (possibly a different login:");
    expect(out).toContain("t@r  terminal  configured: unknown (no account configuration is known for runtime terminal) · allowance not linked");
    expect((out.match(/allowance not linked/g) ?? []).length).toBeGreaterThanOrEqual(SEATS.length);
  });

  it("shows every served reason, note and time verbatim: the same facts rig provider status prints", async () => {
    await openUsage();
    const out = text();
    const keys = new Set(["levelReason", "freshnessReason", "resetsAt", "observedAt", "identityNote", "unavailableReason", "note", "reason", "detail",
      "homeNote", "registryNotes", "lastSampledAt", "recordedAt", "profileRef", "home", "accountId", "email", "planType", "seatSession", "at"]);
    const facts = servedStrings({ usage: model["usage"], seatAccounts: model["seatAccounts"] }, keys);
    expect(facts.length).toBeGreaterThan(40);
    for (const fact of facts) expect(out, fact).toContain(fact);
  });

  it("reads only GET /api/provider/status across navigation and re-renders: no refresh, no POST, no other provider route", async () => {
    await openUsage();
    for (let i = 0; i < 3; i++) { await refresh(); draw(); }
    expect(new Set(trace)).toEqual(new Set(["GET /api/provider/status"]));
    expect(trace.filter((t) => t.startsWith("POST"))).toEqual([]);
    expect(refreshUsage).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
  });

  it("switch off: says usage windows are off on this daemon and how to turn them on; reads the config only then", async () => {
    model = { ...BASE };
    await openUsage();
    const out = text();
    expect(out).toContain("Usage windows are off on this daemon (provider.usage_windows = false");
    expect(out).toContain("Turn them on with: rig config set provider.usage_windows true");
    expect(out).toContain("Seat accounts are served only while usage windows are.");
    expect(new Set(trace)).toEqual(new Set(["GET /api/provider/status", "GET /api/config?view=browser"]));
    expect(refreshUsage).not.toHaveBeenCalled();
  });

  it("an older daemon: no usage key and no such setting reads as not served, never as off", async () => {
    model = { ...BASE }; hideSwitchKey = true;
    await openUsage();
    const out = text();
    expect(out).toContain("This daemon doesn't serve usage windows (it doesn't know the provider.usage_windows setting).");
    expect(out).not.toContain("are off");
  });

  it("the seats label is the served seats value: a served value shows as served, a missing one reads unknown", async () => {
    const withoutSeats: Record<string, unknown> = { ...USAGE[1]! };
    delete withoutSeats["seats"];
    model = { ...BASE, usage: [{ ...USAGE[0]!, seats: "fixture-served-seats" }, withoutSeats] };
    await openUsage();
    expect(text()).toContain("codex  account acct-1 · bucket codex · a@x.example · plus · seats fixture-served-seats");
    expect(text()).toContain("claude  identity unresolved · bucket all models · email not reported · seats unknown");
  });

  it("usage served without seat accounts (before seat accounts existed): the usage rows show, and the seats say so", async () => {
    model = { ...BASE, usage: USAGE };
    await openUsage();
    expect(text()).toContain("This daemon doesn't serve seat accounts.");
    expect(text()).toContain("level: exhausted (at the limit)");
  });

  it("a daemon without provider routes (404) or an unwired service (503): the view says so, and other sections still work", async () => {
    for (const [setup, expected] of [
      [() => { noProviderRoutes = true; }, "This daemon doesn't serve usage windows (no provider read model: HTTP 404)."],
      [() => { noProviderRoutes = false; providerWired = false; }, "Usage windows unavailable: provider_service_unavailable. Nothing is inferred from the missing read."],
    ] as const) {
      setup();
      view = createViewState({ instanceId: "fixture-view", getSnapshot: () => snap, timeZone: "Europe/London" });
      await openUsage();
      expect(text()).toContain(expected);
      expect(snap.readErrors.join("\n")).toContain("provider status:");
      // Leaving Usage: the other System sections render as before.
      while (view.get().section !== "topology" && view.get().section !== "system") {
        const action = resolveEscapeAction({ type: "key", key: "escape" }, view.get()); if (!action) break; view.dispatch(action);
      }
      view.dispatch(parseCommand("connections")); await refresh();
      expect(text()).toContain("Connections · this daemon's instance");
    }
    expect(refreshUsage).not.toHaveBeenCalled();
  });

  it("the usage command is listed and jumps to the view", () => {
    expect(COMMAND_REGISTRY.find((c) => c.name === "usage")).toMatchObject({ context: "standard", description: expect.stringContaining("read-only") });
    expect(parseCommand("usage")).toEqual({ type: "jump", section: "usage" });
    expect(parseCommand(":usage")).toEqual({ type: "jump", section: "usage" });
  });

  it("leaves the user's place: back from Usage returns to the work they were on", async () => {
    view.dispatch(parseCommand(":scopes"));
    const work = view.get();
    await openUsage();
    while (["usage", "system"].includes(view.get().section)) {
      const action = resolveEscapeAction({ type: "key", key: "escape" }, view.get()); if (!action) break; view.dispatch(action);
    }
    expect(view.get()).toMatchObject({ section: work.section, selection: work.selection, filter: work.filter });
  });
});

describe("System → Usage through the live page reader", () => {
  it("a good read, then a 503: the previous model stays, marked retained; then a 404 drops it and says so", async () => {
    let now = 1_000;
    view.dispatch(parseCommand("usage"));
    const live = createLiveRefresh({ now: () => now, scopeKey: () => pageReadKey(view.get()), onFrame: () => {},
      hydrate: (page, signal) => hydrateSnapshot(client.forPage(page, signal), undefined, null, null, null, view.get()),
      setTimeout: () => ({ unref() {} }) as never, clearTimeout: () => {} });
    const screen = () => renderScreen(view.get(), live.snapshot(), { cols: 400, rows: 400, load: live.load() }).lines.join("\n");

    await live.refresh();
    expect(screen()).toContain("level: exhausted (at the limit)");
    expect(live.load()).toMatchObject({ stale: false });
    expect(live.load().retainedAt).toBeUndefined();

    // The provider service stops answering (503): the page reader keeps the last answer, marked retained.
    providerWired = false; now = 2_000;
    await live.refresh();
    expect(screen()).toContain("level: exhausted (at the limit)");
    expect(screen()).not.toContain("Usage windows unavailable");
    expect(live.load()).toMatchObject({ stale: true, retainedAt: 1_000 });
    expect(screen()).toContain("Could not refresh");
    expect(live.snapshot().readErrors.join("\n")).toContain("/api/provider/status: HTTP 503");

    // The route is gone (404): the kept answer is dropped and the view says so.
    noProviderRoutes = true; now = 3_000;
    await live.refresh();
    expect(screen()).toContain("This daemon doesn't serve usage windows (no provider read model: HTTP 404).");
    expect(screen()).not.toContain("level: exhausted");
    expect(refreshUsage).not.toHaveBeenCalled();
    live.close();
  });
});
