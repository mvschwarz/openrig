// OPR.0.6.0.5 — the Connections page's Slack section, when no Slack app exists yet, shows the
// shipped manifest's create-app link as selectable text and a toggle that expands the manifest.
// Real daemon gateway routes behind a fake client; no writes, no external calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayRoutes } from "../../daemon/src/routes/gateway.js";
import { channelStateDigest } from "../../daemon/src/domain/gateway/channel-operations.js";
import { DEFAULT_CONFIG, saveConfig } from "../../daemon/src/domain/gateway/slack/config.js";
import { buildSlackAppManifest } from "../../daemon/src/domain/gateway/slack/manifest.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { connectionsLines, SLACK_MANIFEST_EXPAND_KEY } from "../src/connections/connections-model.js";
import type { FleetSnapshot } from "../src/types.js";

let home: string;
let external: ReturnType<typeof vi.fn>;
let manifestRoute: boolean;
let config: typeof DEFAULT_CONFIG;

function makeClient(): DaemonClient {
  const http = new Hono();
  http.use("*", async (c, next) => {
    c.set("gatewaySubsystem" as never, { status: () => ({ state: "active", connector: { outboundReady: false, inboundReady: false, configurationDigest: channelStateDigest(config) } }), restart: external } as never);
    await next();
  });
  http.route("/api/gateway", gatewayRoutes({ home }));
  return new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/gateway/slack/manifest" && !manifestRoute) return Response.json({ error: "not_found" }, { status: 404 });
    if (path.startsWith("/api/gateway")) return http.request(path, init);
    const fixtures: Record<string, unknown> = {
      "/healthz": { status: "ok", semver: "0.6.0", commit: "fixture", selfHostId: "fixture-host", selfHostIdSource: "registry" },
      "/api/rigs/summary": [], "/api/review/fleet": { needsYou: { items: [] }, hosts: [] },
      "/api/queue/attention-aggregate": { hosts: [] }, "/api/scopes": { missions: [] }, "/api/views/execution": { rows: [] },
    };
    return Response.json(fixtures[path] ?? []);
  }) as typeof fetch });
}
const hydrate = (client: DaemonClient) =>
  hydrateSnapshot(client, undefined, null, null, "fixture", { section: "connections", viewTab: "table", drill: [] });
const text = (lines: Array<{ text: string }>) => lines.map((l) => l.text).join("\n");
const screenText = (lines: string[]) => lines.join("\n");
/** The link rows: from the first row that starts the URL, through the rows that continue it. */
function linkRows(lines: Array<{ text: string }>): string {
  const start = lines.findIndex((l) => l.text.startsWith("https://api.slack.com/apps?"));
  let joined = "";
  for (let i = start; i >= 0 && i < lines.length && !lines[i]!.text.startsWith(" "); i++) joined += lines[i]!.text;
  return joined;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "s05-connections-"));
  config = { ...DEFAULT_CONFIG };
  manifestRoute = true;
  external = vi.fn(() => { throw new Error("no external calls"); });
  vi.stubGlobal("fetch", external);
  vi.stubEnv("SLACK_BOT_TOKEN", ""); vi.stubEnv("SLACK_APP_TOKEN", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("Connections · Slack not configured (no app tokens)", () => {
  it("shows the not-configured line, the create-app link and a collapsed manifest; Next names the manifest", async () => {
    const snap = await hydrate(makeClient()) as FleetSnapshot;
    const bundle = buildSlackAppManifest();
    expect(snap.slackManifest?.url).toBe(bundle.url);
    expect(snap.connections?.nextAction).toBe("rig slack manifest --url");
    const lines = connectionsLines(snap, 400);
    const body = text(lines);
    expect(body).toContain("not configured · no Slack app tokens yet");
    expect(linkRows(lines)).toBe(bundle.url);
    expect(body).toContain("▸ Show manifest (Enter)");
    expect(body).not.toContain("socket_mode_enabled: true");
    expect(body).toContain("Next: rig slack manifest --url");
    expect(external).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it("the toggle line expands the manifest in place through the real view-state action, and collapses again", async () => {
    const snap = await hydrate(makeClient()) as FleetSnapshot;
    const view = createViewState({ instanceId: "fixture", getSnapshot: () => snap });
    view.dispatch(parseCommand("connections"));
    const toggle = connectionsLines(snap, 400).find((l) => l.text.includes("Show manifest"))!;
    expect(toggle.action).toEqual({ type: "toggle-expand", key: SLACK_MANIFEST_EXPAND_KEY });
    view.dispatch(toggle.action!);
    const expanded = screenText(renderScreen(view.get(), snap, { cols: 160, rows: 200 }).lines);
    expect(expanded).toContain("▾ Hide manifest (Enter)");
    expect(expanded).toContain("socket_mode_enabled: true");
    expect(expanded).toContain("app_mentions:read");
    view.dispatch(toggle.action!);
    const collapsed = screenText(renderScreen(view.get(), snap, { cols: 160, rows: 200 }).lines);
    expect(collapsed).not.toContain("socket_mode_enabled: true");
  });

  it("small terminal: every row fits and the wrapped link rows reassemble to the exact URL", async () => {
    const snap = await hydrate(makeClient()) as FleetSnapshot;
    const narrow = connectionsLines(snap, 44);
    for (const l of narrow) expect(l.text.length).toBeLessThanOrEqual(44);
    expect(linkRows(narrow)).toBe(buildSlackAppManifest().url);
    const view = createViewState({ instanceId: "fixture", getSnapshot: () => snap });
    view.dispatch(parseCommand("connections"));
    const screen = renderScreen(view.get(), snap, { cols: 60, rows: 20 });
    for (const row of screen.lines) expect(row.length).toBeLessThanOrEqual(60);
  });
});

describe("Connections · Slack configured, and older daemons", () => {
  it("configured (tokens resolve): no setup block, existing status unchanged", async () => {
    const secrets = join(home, "secret.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=fixture-bot\nSLACK_APP_TOKEN=fixture-app\n", { mode: 0o600 });
    config = { ...DEFAULT_CONFIG, secretsEnvFile: secrets, channel: "C-FIXTURE" };
    saveConfig(config, home);
    const snap = await hydrate(makeClient()) as FleetSnapshot;
    const body = text(connectionsLines(snap, 400));
    expect(body).not.toContain("not configured · no Slack app tokens yet");
    expect(body).not.toContain("Show manifest");
    expect(snap.connections?.nextAction).not.toContain("manifest");
  });

  it("an older daemon without the manifest route falls back to the CLI command and adds no read error", async () => {
    manifestRoute = false;
    const snap = await hydrate(makeClient()) as FleetSnapshot;
    expect(snap.slackManifest).toBeNull();
    expect(snap.readErrors.join("\n")).not.toMatch(/manifest/i);
    const body = text(connectionsLines(snap, 400));
    expect(body).toContain("rig slack manifest --url (this daemon does not serve the manifest)");
  });
});
