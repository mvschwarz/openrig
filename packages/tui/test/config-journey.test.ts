import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configRoutes } from "../../daemon/src/routes/config.js";
import { gatewayRoutes } from "../../daemon/src/routes/gateway.js";
import { SettingsStore, SETTINGS_VALID_KEYS } from "../../daemon/src/domain/user-settings/settings-store.js";
import { DEFAULT_CONFIG, saveConfig, configPathFor } from "../../daemon/src/domain/gateway/slack/config.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot, computeExplorerRows } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { resolveKeyAction, resolveEscapeAction, resolveMouseAction } from "../src/input.js";
import type { FleetSnapshot, ViewStateStore, Screen } from "../src/types.js";

let home: string, settings: SettingsStore, client: DaemonClient, snap: FleetSnapshot, view: ViewStateStore;
let trace: string[], external: ReturnType<typeof vi.fn>, fail: boolean;
const secret = "fixture-private-config-credential";
const longPath = "/fixture/" + "a-long-work-folder/".repeat(16) + "exact-tail";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "s06-config-journey-"));
  settings = new SettingsStore(join(home, "config.json"));
  settings.set("host.name", "config-fixture");
  settings.set("workspace.root", longPath);
  settings.set("queue.wake_retry_interval_seconds", "300");
  writeFileSync(join(home, "private.env"), `SLACK_BOT_TOKEN=${secret}\n`, { mode: 0o600 });
  saveConfig({ ...DEFAULT_CONFIG, enabled: false, secretsEnvFile: join(home, "private.env") }, home);
  const app = new Hono();
  external = vi.fn(() => { throw new Error("unexpected external operation"); });
  vi.stubGlobal("fetch", external);
  app.use("*", async (c, next) => {
    c.set("settingsStore" as never, settings as never);
    c.set("gatewaySubsystem" as never, { status: () => ({ state: "disabled" }), restart: external } as never);
    await next();
  });
  app.route("/api/config", configRoutes({ home }));
  app.route("/api/gateway", gatewayRoutes({ home }));
  trace = []; fail = false;
  client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url, init) => {
    const u = new URL(String(url));
    trace.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    if (u.pathname === "/healthz") return Response.json({ status: "ok", selfHostId: "fixture-host", semver: "fixture-version", commit: "fixture-commit" });
    if (fail) throw new Error(secret);
    return app.request(u.pathname + u.search, init);
  }) as typeof fetch });
  snap = emptySnapshot();
  view = createViewState({ instanceId: "fixture-view", getSnapshot: () => snap, timeZone: "Europe/London" });
});
afterEach(() => { vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });
async function refresh() { snap = await hydrateSnapshot(client, undefined, null, null, null, view.get()); }
function draw(cols = 80, rows = 24): Screen {
  let screen = renderScreen(view.get(), snap, { cols, rows });
  view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
  return renderScreen(view.get(), snap, { cols, rows });
}
function key(key: "up" | "down" | "left" | "right" | "enter", screen = draw()) {
  const action = resolveKeyAction({ type: "key", key } as never, view.get(), screen, computeExplorerRows(view.get(), snap).length);
  if (action) view.dispatch(action);
}
function escape() { const action = resolveEscapeAction({ type: "key", key: "escape" }, view.get()); if (action) view.dispatch(action); }
function click(screen: Screen, matches: (action: Screen["hitMap"][number]["action"]) => boolean) {
  const target = screen.hitMap.find((t) => matches(t.action));
  expect(target).toBeDefined();
  view.dispatch(target!.action);
}

describe("CONFIG in the normal TUI journey", () => {
  it("enters from the explorer, answers non-Slack questions, opens Slack as a child and returns to work passively", async () => {
    view.dispatch(parseCommand(":scopes"));
    const work = view.get();
    const sources = [join(home, "config.json"), configPathFor(home), join(home, "private.env")];
    const before = sources.map((p) => readFileSync(p, "utf8"));
    click(draw(), (a) => a.type === "jump" && a.section === "system");
    click(draw(), (a) => a.type === "jump" && a.section === "config");
    await refresh();
    expect(draw().lines.join("\n")).toContain("Your instance settings");
    click(draw(), (a) => a.type === "config-category" && a.category === "waiting");
    expect(draw().lines.join("\n")).toContain("5 min");
    key("right"); key("enter");
    expect(view.get().configKey).toBeTruthy();
    escape();
    click(draw(), (a) => a.type === "config-category" && a.category === "slack");
    expect(draw().lines.join("\n")).toContain("disabled");
    expect(snap.config!.entries.filter((e) => e.group === "general").map((e) => e.key)).toEqual(expect.arrayContaining([...SETTINGS_VALID_KEYS]));
    while (["config", "system"].includes(view.get().section)) escape();
    expect(view.get()).toMatchObject({ section: work.section, selection: work.selection, filter: work.filter, contentOffset: work.contentOffset });
    expect(new Set(trace)).toEqual(new Set(["GET /api/config?view=browser", "GET /healthz", "GET /api/gateway/connections", "GET /api/hosts/pair-requests"]));
    expect(sources.map((p) => readFileSync(p, "utf8"))).toEqual(before);
    expect(external).not.toHaveBeenCalled();
    expect(JSON.stringify(snap)).not.toContain(secret);
  });
  it.each([[80, 24], [120, 40]])("finds and retrieves the entire long value with normal controls at %ix%i", async (cols, rows) => {
    view.dispatch(parseCommand("config")); await refresh();
    view.dispatch(parseCommand("/workspace.root"));
    const list = view.get();
    let screen = draw(cols, rows);
    expect(screen.lines.join("\n")).toContain("1 settings");
    key("enter", screen);
    expect(view.get().configKey).toBe("workspace.root");
    const seen: string[] = [];
    for (let step = 0; step < 100; step++) {
      screen = draw(cols, rows);
      expect(screen.lines).toHaveLength(rows);
      expect(screen.lines.every((l) => l.length <= cols)).toBe(true);
      seen.push(...screen.lines.map((l) => l.slice(screen.explorerWidth + 2)));
      if (view.get().contentOffset === view.get().contentMaxOffset) break;
      key("down", screen);
    }
    expect(seen.join(" ")).toContain("exact-tail");
    expect(snap.config!.entries.find((e) => e.key === "workspace.root")!.value).toBe(longPath);
    view.dispatch(parseCommand("select-text")); expect(view.get().copyMode).toBe(true);
    // Search clears before back; explicit back restores the exact list frame.
    view.dispatch(parseCommand("back"));
    expect(view.get()).toMatchObject({ configKey: null, filter: list.filter, contentOffset: list.contentOffset });
  });
  it("refreshes the selected key, keeps failures local and does not expose raw read errors", async () => {
    view.dispatch(parseCommand("config display")); await refresh();
    view.dispatch(parseCommand("setting ui.timezone"));
    settings.set("ui.timezone", "America/New_York");
    writeFileSync(configPathFor(home), "broken: [");
    await refresh();
    expect(view.get().configKey).toBe("ui.timezone");
    expect(draw(120, 40).lines.join("\n")).toContain("America/New_York");
    expect(snap.config!.sources.find((s) => s.id === "slack")!.state).toBe("malformed");
    fail = true; await refresh();
    expect(snap.config).toBeNull();
    expect(draw().lines.join("\n")).toContain("unavailable after refresh");
    expect(JSON.stringify(snap)).not.toContain(secret);
    expect(external).not.toHaveBeenCalled();
  });
  it("wheel scrolls the content and a removed setting has an honest detail", async () => {
    view.dispatch(parseCommand("config all")); await refresh();
    const screen = draw();
    const wheel = resolveMouseAction({ type: "mouse", button: 65, x: 70, y: 10, release: false } as never, view.get(), screen, 20);
    view.dispatch(wheel!);
    expect(view.get().contentOffset).toBe(3);
    view.dispatch(parseCommand("setting removed.setting"));
    expect(draw().lines.join("\n")).toContain("unavailable after refresh");
  });
  it("treats an older daemon's raw config response as unavailable", async () => {
    client = new DaemonClient({ baseUrl: "http://older", fetchImpl: (async () => Response.json({ settings: { private: secret } })) as typeof fetch });
    view.dispatch(parseCommand("config")); await refresh();
    expect(snap.config).toBeNull();
    expect(draw().lines.join("\n")).toContain("CONFIG unavailable");
    expect(draw().lines.join("\n")).not.toContain(secret);
  });
  it("advertises arrow scrolling only when detail actually overflows", async () => {
    view.dispatch(parseCommand("config")); await refresh();
    view.dispatch(parseCommand("setting ui.timezone"));
    expect(draw(120, 40).lines.join("\n")).toContain("↑↓ move");
    view.dispatch(parseCommand("setting workspace.root"));
    const screen = draw(80, 16);
    expect(screen.lines.join("\n")).toContain("↑↓ scroll");
    const selection = view.get().selection;
    key("down", screen);
    expect(view.get().contentOffset).toBe(1);
    expect(view.get().selection).toBe(selection);
  });
  it("Escape returns from a searched detail to work without a history cycle", async () => {
    view.dispatch(parseCommand(":scopes"));
    view.dispatch(parseCommand("config waiting")); await refresh();
    view.dispatch(parseCommand("/timezone")); key("enter");
    expect(view.get().configKey).toBe("ui.timezone");
    for (let n = 0; n < 10 && view.get().section === "config"; n++) escape();
    expect(view.get().section).toBe("scopes");
  });
});
