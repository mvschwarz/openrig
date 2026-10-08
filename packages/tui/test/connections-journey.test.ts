import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayRoutes } from "../../daemon/src/routes/gateway.js";
import { addHumanFragment, projectionPath } from "../../daemon/src/domain/gateway/human-registry.js";
import { channelStateDigest, runChannelOperation } from "../../daemon/src/domain/gateway/channel-operations.js";
import { DEFAULT_CONFIG, saveConfig, configPathFor } from "../../daemon/src/domain/gateway/slack/config.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { PageRead } from "../src/page-read.js";
import { connectionsLines } from "../src/connections/connections-model.js";
import type { FleetSnapshot } from "../src/types.js";

let home: string;
const secret = "fixture-private-bot-value";
const appSecret = "fixture-private-app-value";
let config: typeof DEFAULT_CONFIG;
let gateway: Record<string, unknown>;
let observed: Array<{ path: string; method: string }>;
let http: Hono;
let external: ReturnType<typeof vi.fn>;
let client: DaemonClient;
let humanBlocker = false;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "s06-connections-"));
  const secrets = join(home, "secret.env");
  writeFileSync(secrets, `SLACK_BOT_TOKEN=${secret}\nSLACK_APP_TOKEN=${appSecret}\n`, { mode: 0o600 });
  config = { ...DEFAULT_CONFIG, enabled: true, channel: "C-FIXTURE", inboundDestination: "orch@demo", secretsEnvFile: secrets };
  saveConfig(config, home);
  expect(addHumanFragment({ entityId: "alex", class: "human", displayName: "Alex",
    address: "alex@external", prefs: { deliveryClass: "B", availability: "focus" },
    connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "vault://HIDDEN-REF", role: "primary", handle: "U-FIXTURE" }],
  }, home).ok).toBe(true);
  const settings = new SettingsStore(join(home, "settings.json"));
  settings.set("host.name", "fixture-host");
  gateway = { state: "active", connector: { outboundReady: true, inboundReady: true, inbound: { state: "connected" }, configurationDigest: channelStateDigest(config) } };
  external = vi.fn(() => { throw new Error("No external calls in passive journey"); });
  vi.stubGlobal("fetch", external);
  http = new Hono();
  http.use("*", async (c, next) => { c.set("gatewaySubsystem" as never, { status: () => gateway, restart: external } as never); c.set("settingsStore" as never, settings as never); await next(); });
  http.route("/api/gateway", gatewayRoutes({ home }));
  observed = []; humanBlocker = false;
  client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url, init) => {
    const path = new URL(String(url)).pathname;
    observed.push({ path, method: init?.method ?? "GET" });
    if (humanBlocker && path === "/api/queue/list" && new URL(String(url)).searchParams.get("state") === "blocked") return Response.json([{ qitemId: "blocked", sourceSession: "author@demo", destinationSession: "worker@demo", state: "blocked", blockedOn: "alex@external", tags: [], body: "Needs a human", summary: "Choose a cover" }]);
    if (path === "/api/queue/alex%40external") return Response.json({ error: "not_found" }, { status: 404 });
    if (path.startsWith("/api/gateway")) return http.request(path, init);
    const fixtures: Record<string, unknown> = {
      "/healthz": { status: "ok", semver: "0.5.11", commit: "fixture-daemon", selfHostId: "fixture-host", selfHostIdSource: "registry" },
      "/api/rigs/summary": [{ id: "r1", name: "demo", lifecycleState: "running" }],
      "/api/rigs/r1/nodes": [{ logicalId: "orch", podNamespace: "ops", nodeKind: "agent", runtime: "codex", lifecycleState: "running", canonicalSessionName: "orch@demo", resolvedSpecName: "worker" }],
      "/api/rigs/r1/spec.json": { name: "demo-spec", pods: [] },
      "/api/specs/library": [{ id: "s1", name: "demo-spec", kind: "rig" }],
      "/api/review/fleet": { needsYou: { items: [] }, hosts: [] },
      "/api/queue/attention-aggregate": { hosts: [] },
      "/api/scopes": { missions: [] }, "/api/views/execution": { rows: [] },
    };
    return Response.json(fixtures[path] ?? []);
  }) as typeof fetch });
});
afterEach(() => { vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });
const hydrate = () => hydrateSnapshot(client, undefined, null, null, "demo", { section: "connections", viewTab: "table", drill: [] });
async function verify(ready: boolean | null) {
  return runChannelOperation({ actor: "tester@fixture", provenance: "claimed:v1", reason: "fixture check", action: "verify", subject: "slack",
    before: { digest: channelStateDigest(config) }, run: async () => ({ value: null, after: { ready }, effect: "observed" }),
  }, home);
}

describe("passive Connections journey", () => {
  it("reads real sources, preserves attribution, navigates to route and spec then returns to work without writes or external calls", async () => {
    await verify(true);
    const before = [configPathFor(home), projectionPath(home), join(home, "state/human-channel-operations.jsonl")].map((p) => readFileSync(p, "utf8"));
    let snap: FleetSnapshot = emptySnapshot();
    const view = createViewState({ instanceId: "fixture", getSnapshot: () => snap });
    view.dispatch(parseCommand(":scopes"));
    const work = view.get();
    view.dispatch(parseCommand("connections"));
    snap = await hydrate();
    snap.launchingCli = "fixture-cli";
    expect(snap.readErrors).toEqual([]);
    expect(snap.connections).toMatchObject({ state: "unverified", running: { applied: "matching" }, verification: { state: "ready-at-check", actor: "tester@fixture" } });
    const content = connectionsLines(snap, 75);
    const rendered = renderScreen(view.get(), snap, { cols: 110, rows: 40 }).lines.join("\n");
    expect(rendered).toContain("CONNECTIONS");
    expect(rendered).toContain("fixture-cli");
    expect(content.map((l) => l.text).join("\n")).toContain("ready-at-check");
    snap.pending.push({ qitemId: "request-1", sourceSession: "orch@demo", destinationSession: "alex@external", state: "pending", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "fixture decision", body: "", claimedAt: null, tsUpdated: "2026-09-07T00:00:00Z" });
    expect(connectionsLines(snap, 100).map((l) => l.text).join("\n")).toContain("request-1 · from orch@demo");
    const response = JSON.stringify(snap.connections);
    for (const value of [secret, appSecret, "HIDDEN-REF", "secretsRef", "secretsEnvFile"]) expect(response + rendered).not.toContain(value);
    const route = content.find((line) => line.action?.type === "drill" && line.action.resource === "agent")!.action!;
    view.dispatch(route); expect(view.get().lastError).toBeNull(); expect(view.get().section).toBe("topology");
    view.dispatch(parseCommand("back")); expect(view.get().section).toBe("connections");
    const spec = content.find((line) => line.action?.type === "drill" && line.action.resource === "spec")!.action!;
    view.dispatch(spec); expect(view.get().lastError).toBeNull(); expect(view.get().drill.at(-1)?.name).toBe("demo-spec");
    view.dispatch(parseCommand("back"));
    snap = await hydrate();
    view.dispatch(parseCommand("back")); expect(view.get().section).toBe(work.section);
    expect(external).not.toHaveBeenCalled();
    expect(observed.every((r) => r.method === "GET")).toBe(true);
    expect(observed.filter((r) => r.path.includes("/readiness"))).toEqual([]);
    expect([configPathFor(home), projectionPath(home), join(home, "state/human-channel-operations.jsonl")].map((p) => readFileSync(p, "utf8"))).toEqual(before);
  });

  it.each(["disabled", "incomplete", "failed", "unavailable", "unapplied", "indeterminate"])("keeps %s distinct with an action", async (mode) => {
    if (mode === "disabled") config.enabled = false;
    if (mode === "incomplete") config.channel = null;
    if (mode === "failed") gateway.state = "failed";
    if (mode === "unavailable") gateway.state = "stopped";
    if (mode === "unapplied") config.channel = "C-CHANGED";
    if (mode === "indeterminate") await verify(null);
    saveConfig(config, home);
    if (mode === "disabled" || mode === "incomplete") {
      gateway.connector = { outboundReady: false, configurationDigest: channelStateDigest(config) };
    }
    const snap = await hydrate();
    expect(snap.connections?.state).toBe(mode);
    expect(snap.connections?.nextAction).toMatch(/^rig /);
    const lines = connectionsLines(snap, 70).map((l) => l.text).join("\n");
    expect(lines).toContain(mode);
    expect(external).not.toHaveBeenCalled();
  });

  it.each([false, true])("distinguishes requested enabled=%s from application, then reflects adoption", async (enabled) => {
    gateway.connector = { outboundReady: !enabled, configurationDigest: channelStateDigest({ ...config, enabled: !enabled }) };
    config.enabled = enabled; saveConfig(config, home);
    const before = [configPathFor(home), projectionPath(home)].map((p) => readFileSync(p, "utf8"));
    const pending = await hydrate();
    expect(pending.connections).toMatchObject({ state: "unapplied", nextAction: "rig daemon logs",
      configuration: { enabled }, running: { applied: "changed", outboundReady: !enabled } });
    const lines = connectionsLines(pending, 140).map((l) => l.text).join("\n");
    expect(lines).toContain("Slack: unapplied");
    expect(lines).toMatch(/delivery.*unapplied/);
    expect(lines).toContain("current external reach is unverified");
    expect(lines).not.toContain("rig slack enable");
    gateway.connector = { outboundReady: enabled, configurationDigest: channelStateDigest(config) };
    expect((await hydrate()).connections).toMatchObject({ state: enabled ? "unverified" : "disabled",
      nextAction: enabled ? "rig slack verify --json" : "rig slack enable",
      running: { applied: "matching", outboundReady: enabled } });
    expect([configPathFor(home), projectionPath(home)].map((p) => readFileSync(p, "utf8"))).toEqual(before);
    expect(external).not.toHaveBeenCalled();
    expect(observed.every((r) => r.method === "GET" && !r.path.includes("/readiness"))).toBe(true);
  });

  it.each([false, true].flatMap((enabled) => ["digest", "connector", "status", "stopped", "failed"].map((missing) => ({ enabled, missing }))))(
    "does not infer application from enabled=$enabled with $missing evidence missing or unavailable", async ({ enabled, missing }) => {
      config.enabled = enabled; saveConfig(config, home);
      if (missing === "digest") gateway.connector = { outboundReady: true };
      if (missing === "connector") delete gateway.connector;
      if (missing === "status") gateway = {};
      if (missing === "stopped" || missing === "failed") gateway.state = missing;
      const snap = await hydrate();
      const state = missing === "failed" ? "failed" : missing === "status" || missing === "stopped" ? "unavailable" : "unverified";
      expect(snap.connections).toMatchObject({ state, nextAction: "rig daemon logs", configuration: { enabled } });
      const lines = connectionsLines(snap, 140).map((l) => l.text).join("\n");
      expect(lines).toContain(`Slack: ${state}`);
      expect(lines).not.toMatch(/delivery.*disabled/);
      expect(lines).not.toContain("rig slack enable");
      expect(external).not.toHaveBeenCalled();
    },
  );

  it("does not turn malformed config or registry into disabled/empty success or leak parser errors", async () => {
    writeFileSync(configPathFor(home), `broken ${secret}`);
    writeFileSync(projectionPath(home), `broken ${appSecret}`);
    const snap = await hydrate();
    expect(snap.connections).toMatchObject({ state: "unavailable", configuration: null, registry: { state: "unavailable" } });
    const body = JSON.stringify(snap.connections);
    expect(body).not.toContain(secret); expect(body).not.toContain(appSecret);
  });

  it("a changed, failed, interrupted or corrupt verification cannot inherit old green", async () => {
    await verify(true);
    config.channel = "C-CHANGED"; saveConfig(config, home);
    expect((await hydrate()).connections?.verification.state).toBe("changed");
    await verify(false);
    expect((await hydrate()).connections?.verification.state).toBe("failed");
    await expect(runChannelOperation({ actor: "tester", provenance: "claimed:v1", reason: "fail", action: "verify", subject: "slack", before: { digest: channelStateDigest(config) }, run: async () => { throw new Error("fixture error"); } }, home)).rejects.toThrow();
    expect((await hydrate()).connections?.verification.state).toBe("indeterminate");
    writeFileSync(join(home, "state/human-channel-operations.jsonl"), "malformed");
    expect((await hydrate()).connections?.verification.state).toBe("indeterminate");
  });

  it("route exclusion is distinct from connector readiness", async () => {
    config.outboundDestinations = ["someone-else@external"]; saveConfig(config, home);
    const snap = await hydrate();
    expect(snap.connections?.humans[0]?.excluded).toBe(true);
    expect(connectionsLines(snap, 80).map((l) => l.text).join("\n")).toContain("excluded by outbound policy");
  });

  it("failed endpoint on refresh clears old evidence and older daemons stay unavailable", async () => {
    const old = await hydrate(); expect(old.connections).not.toBeNull();
    client.connections = async () => { throw new Error("HTTP 404"); };
    const snap = await hydrate(); expect(snap.connections).toBeNull();
    expect(snap.readErrors).toContain("connections: HTTP 404");
    expect(connectionsLines(snap, 80).map((l) => l.text).join("\n")).toContain("Connections unavailable");
    expect(external).not.toHaveBeenCalled();
  });
});


it("never resolves an external human blocker as a queue-item ID or poisons the page read", async () => {
  humanBlocker = true;
  const page = new PageRead(Date.now); page.begin();
  await hydrateSnapshot(client.forPage(page, new AbortController().signal), undefined, null, null, "demo", { section: "connections", viewTab: "table", drill: [] });
  page.end();
  expect(observed.map(r => r.path)).not.toContain("/api/queue/alex%40external");
  expect(page.errors).toEqual([]);
});

describe("#192 channel map on the Connections page", () => {
  it("shows each mapped rig or seat with its channel; an absent map shows nothing extra", async () => {
    expect(connectionsLines(await hydrate(), 140).map((l) => l.text).join("\n")).not.toContain("channel map");
    config = { ...config, channelMap: [{ match: "demo", channel: "C-FIXTURE-2" }, { match: "pr@demo", channel: "C-FIXTURE-3" }] };
    saveConfig(config, home);
    gateway.connector = { ...(gateway.connector as object), configurationDigest: channelStateDigest(config) };
    const snap = await hydrate();
    expect(snap.connections?.configuration?.channelMap).toEqual([
      { match: "demo", channel: "C-FIXTURE-2" }, { match: "pr@demo", channel: "C-FIXTURE-3" },
    ]);
    const lines = connectionsLines(snap, 140).map((l) => l.text).join("\n");
    expect(lines).toMatch(/channel map.*demo → C-FIXTURE-2/);
    expect(lines).toMatch(/channel map.*pr@demo → C-FIXTURE-3/);
    expect(external).not.toHaveBeenCalled();
  });
});
