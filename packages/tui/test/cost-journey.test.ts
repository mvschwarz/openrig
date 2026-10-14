// Slice 02 — System → Cost through the actual TUI path (explorer click or command → hydrate → render), with a real
// DaemonClient against the daemon's own cost route over a real seeded store (helpers/cost-fixture.ts). Proves every
// seat draws the line `rig usage cost` prints for the same response, the view only ever GETs that one route and
// writes nothing to the store, an older or failing daemon reads honestly (503 keeps the last view, marked retained;
// 404 drops it), and the other pages read and draw as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { computeExplorerRows, createViewState, emptySnapshot } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { COMMAND_REGISTRY } from "../src/commands/registry.js";
import { renderScreen } from "../src/render.js";
import { createLiveRefresh } from "../src/live.js";
import { pageReadKey } from "../src/page-read.js";
import { COST_HEADER, COST_READ_HINT } from "../src/cost/cost-model.js";
import { costLine } from "../../cli/src/commands/usage.js";
import type { FleetSnapshot, Screen, ViewStateStore } from "../src/types.js";
import { costApp, seededDb } from "./helpers/cost-fixture.js";

const COST_ROUTE = "/api/telemetry/usage/cost";

let db: Database.Database;
let external: ReturnType<typeof vi.fn>;
beforeEach(() => {
  db = seededDb();
  // Anything that leaves the fixture daemon (a provider, OpenRouter, a host) fails the test.
  external = vi.fn(() => { throw new Error("unexpected external request"); });
  vi.stubGlobal("fetch", external);
});
afterEach(() => { vi.unstubAllGlobals(); db.close(); });

type Mode = "serve" | "fail" | "gone" | "malformed";

/** A TUI on the fixture daemon: a real client (every request traced), the real view state, hydrate and render. Only
 *  the cost route is mounted; every other route answers 404, as on a daemon that has none of them. */
function tui(mode: () => Mode = () => "serve") {
  const trace: string[] = [];
  const app = costApp(() => db);
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    trace.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    if (u.pathname === COST_ROUTE && mode() === "gone") return new Response("Not Found", { status: 404 });
    if (u.pathname === COST_ROUTE && mode() === "malformed") return Response.json({ seats: [null], note: "" });
    if (u.pathname === COST_ROUTE && mode() === "fail") return Response.json({ error: "telemetry_unavailable" }, { status: 503 });
    if (u.pathname !== COST_ROUTE) return Response.json({ error: "not_found" }, { status: 404 });
    return app.request(u.pathname + u.search, init);
  }) as unknown as typeof fetch });
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
    click((a) => a.type === "jump" && a.section === "cost");
    await refresh();
  };
  const live = (now: () => number) => createLiveRefresh({ now, scopeKey: () => pageReadKey(view.get()), onFrame: () => {},
    hydrate: (page, signal) => hydrateSnapshot(client.forPage(page, signal), undefined, null, null, null, view.get()),
    setTimeout: () => ({ unref() {} }) as never, clearTimeout: () => {} });
  return { client, trace, view, refresh, draw, click, openView, live, text: () => draw().lines.join("\n"), snap: () => snap };
}

const served = async () => (await (await costApp(() => db).request(COST_ROUTE)).json()) as { seats: Array<Record<string, unknown>>; note: string };
/** Every row in every table, so a read that wrote anything shows up. */
const storeState = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);

describe("System → Cost through the TUI", () => {
  it("draws each seat as rig usage cost prints it, with every served kind, source, window, coverage and reason", async () => {
    const body = await served();
    const t = tui();
    await t.openView();
    const lines = t.draw().lines.map((l) => l.slice(l.indexOf("┃") + 1).trim());
    expect(body.seats.length).toBe(7);
    for (const seat of body.seats) expect(lines).toContain(costLine(seat as never));
    expect(lines).toContain(body.note);
    const strings: string[] = [];
    const walk = (v: unknown, k = "") => {
      if (typeof v === "string" && ["kind", "source", "coverage", "reason", "note", "nativeSessionId", "piSessionId", "since", "asOf"].includes(k)) strings.push(v);
      else if (Array.isArray(v)) v.forEach((x) => walk(x, k));
      else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
    };
    walk(body);
    const text = t.text();
    // A long served text wraps across lines; compare the content pane with its wrapping undone.
    const flat = lines.join(" ").replace(/\s+/g, " ");
    expect(strings.length).toBeGreaterThan(20);
    expect(strings.filter((s) => !flat.includes(s.replace(/\s+/g, " ")))).toEqual([]);
    expect(text).toContain(`  ${COST_HEADER}`);
    expect(text).toContain(`  ${COST_READ_HINT}`);
    // a charge beside its estimate, never added; tiny money never zero; Codex without dollars
    expect(text).toContain("provider charge, beside the estimate and never added to it: partial · $0.01 USD (Pi's estimate for the same requests: $0.01)");
    expect(text).toContain("tiny-claude@r  <$0.01 client-side estimate");
    expect(text).not.toContain("$0.00");
    expect(lines.find((l) => l.startsWith("dev-codex@r"))).not.toContain("$");
    expect(text).not.toMatch(/total cost|sum of|fleet-wide(?! ·)/i);
    expect(t.snap().readErrors).toEqual([]);
  });

  it("only ever GETs the cost route and writes nothing: across navigation, the command and three live re-reads", async () => {
    const before = storeState();
    const t = tui();
    await t.openView();
    t.view.dispatch(parseCommand("back"));
    t.view.dispatch(parseCommand("cost"));
    await t.refresh();
    const live = t.live(() => 1_000);
    for (let i = 0; i < 3; i++) await live.refresh();
    live.close();
    expect(t.trace.length).toBe(5);
    expect(new Set(t.trace)).toEqual(new Set([`GET ${COST_ROUTE}`]));
    expect(external).not.toHaveBeenCalled();
    expect(storeState()).toEqual(before);
  });

  it("an older daemon (404) says it doesn't serve the view, and no data says so", async () => {
    const older = tui(() => "gone");
    await older.openView();
    expect(older.text()).toContain("  This daemon doesn't serve the cost view (no /api/telemetry/usage/cost: HTTP 404).");
    expect(older.snap().readErrors.join("\n")).toContain("cost: HTTP 404");
    db.exec("DELETE FROM usage_samples; DELETE FROM pi_usage_charges; DELETE FROM pi_usage_entries;");
    const empty = tui();
    await empty.openView();
    expect(empty.text()).toContain("  no usage samples yet: no seat has reported tokens or cost");
    expect(empty.text()).not.toMatch(/\$\d/);
  });

  it("a 200 with a malformed seat (seats: [null]) draws the unavailable state, never throws, on open and on a live re-read", async () => {
    const t = tui(() => "malformed");
    await t.openView();
    expect(() => t.draw()).not.toThrow();
    expect(t.text()).toContain("  Cost unavailable: the response was not a cost view. Nothing is inferred from the missing read.");
    expect(t.snap().readErrors).toEqual(["cost: the response was not a cost view"]);
    let mode: Mode = "serve";
    const u = tui(() => mode);
    u.view.dispatch(parseCommand("cost"));
    const live = u.live(() => 1_000);
    await live.refresh();
    expect(renderScreen(u.view.get(), live.snapshot(), { cols: 1000, rows: 600, load: live.load() }).lines.join("\n")).toContain("dev-claude@r  $0.45");
    mode = "malformed";
    await live.refresh();
    const screen = () => renderScreen(u.view.get(), live.snapshot(), { cols: 1000, rows: 600, load: live.load() }).lines.join("\n");
    expect(screen).not.toThrow();
    expect(screen()).toContain("Cost unavailable: the response was not a cost view.");
    expect(screen()).not.toContain("dev-claude@r  $0.45");
    live.close();
  });

  it("a good read, then a 503: the previous view stays, marked retained; then a 404 drops it and says so", async () => {
    let mode: Mode = "serve";
    let now = 1_000;
    const t = tui(() => mode);
    t.view.dispatch(parseCommand("cost"));
    const live = t.live(() => now);
    const screen = () => renderScreen(t.view.get(), live.snapshot(), { cols: 1000, rows: 600, load: live.load() }).lines.join("\n");

    await live.refresh();
    expect(screen()).toContain("dev-claude@r  $0.45 client-side estimate");
    expect(live.load().retainedAt).toBeUndefined();

    mode = "fail"; now = 2_000;
    await live.refresh();
    expect(screen()).toContain("dev-claude@r  $0.45 client-side estimate");
    expect(screen()).not.toContain("Cost unavailable");
    expect(live.load()).toMatchObject({ stale: true, retainedAt: 1_000 });
    expect(screen()).toContain("Could not refresh");
    expect(live.snapshot().readErrors.join("\n")).toContain(`${COST_ROUTE}: HTTP 503`);

    mode = "gone"; now = 3_000;
    await live.refresh();
    expect(screen()).toContain("This daemon doesn't serve the cost view (no /api/telemetry/usage/cost: HTTP 404).");
    expect(screen()).not.toContain("dev-claude@r  $0.45");
    live.close();
  });

  it("is discoverable: an explorer row after Usage · all hosts, a cost command, and back to where the person was", async () => {
    const t = tui();
    t.click((a) => a.type === "jump" && a.section === "system");
    const system = computeExplorerRows(t.view.get(), t.snap()).map((r) => r.label).filter((l) => /^ {2}\S/.test(l));
    expect(system).toEqual(["  Health", "  Configuration", "  Connections", "  Usage", "  Usage · all hosts", "  Cost", "  Back"]);
    const command = COMMAND_REGISTRY.find((c) => c.name === "cost");
    expect(command?.description).toBe("System Cost: what each seat's harness reports about cost, beside its tokens, on this daemon (read-only)");
    t.view.dispatch(parseCommand("usage"));
    t.view.dispatch(parseCommand("cost"));
    expect(t.view.get().section).toBe("cost");
    t.view.dispatch(parseCommand("back"));
    expect(t.view.get().section).toBe("usage");
  });

  it("the other pages are unchanged: none reads the cost route or draws cost", async () => {
    for (const section of ["system", "config", "connections", "usage", "usage-hosts", "topology"]) {
      const t = tui();
      t.view.dispatch({ type: "jump", section });
      await t.refresh();
      expect(t.view.get().section).toBe(section);
      expect(t.trace.filter((r) => r.includes(COST_ROUTE))).toEqual([]);
      expect(t.snap().cost).toBeUndefined();
      expect(t.text()).not.toContain("System · Cost");
      expect(t.text()).not.toContain(COST_HEADER);
    }
  });
});
