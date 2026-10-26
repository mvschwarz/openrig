import { expect, it } from "vitest";
import { createLiveRefresh } from "../src/live.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";

it("a newly selected page completes before an old transport releases, and Back keeps its own reads", async () => {
  let scope = "a";
  let release!: () => void;
  let slow = false;
  const live = createLiveRefresh({ scopeKey: () => scope, now: () => 1000, onFrame: () => {}, hydrate: async () => {
    const started = scope;
    if (slow && started === "a") await new Promise<void>(resolve => { release = resolve; });
    return { ...emptySnapshot(), hydratedAt: started };
  } });
  await live.refresh(); slow = true;
  const pending = live.refresh(); scope = "b";
  await live.refresh(); expect(live.snapshot().hydratedAt).toBe("b");
  scope = "a"; expect(live.snapshot().hydratedAt).toBe("a");
  expect(live.load()).toMatchObject({ settled: true, stale: true });
  release(); await pending; expect(live.snapshot().hydratedAt).toBe("a");
  live.close();
});

it.each([[140, 42], [80, 24]])("first-visit navigation keeps scope-labelled prior content and only current navigation targets at %ix%i", (cols, rows) => {
  const snap = demoSnapshot();
  const view = createViewState({ instanceId: "continuity", getSnapshot: () => snap });
  const previous = view.get();
  view.dispatch({ type: "jump", section: "terminals" });
  const screen = renderScreen(view.get(), snap, { cols, rows, load: { inFlight: true, settled: false }, previousPage: { state: previous, snapshot: snap } });
  const text = screen.lines.join("\n");
  expect(text).toContain("Previous: topology");
  expect(text).toContain("Choose a rig");
  expect(screen.explorerRows.some(r => r.key === "section:specs")).toBe(true);
  expect(screen.contentTargets).toEqual([]);
  expect(screen.hitMap.some(hit => hit.action.type === "act")).toBe(false);
});

it("a 24-rig landing fetches names only; a selected rig never reads unrelated inventory, missions or reviews", async () => {
  const calls: string[] = [];
  const rigs = Array.from({ length: 24 }, (_, n) => ({ id: `r${n}`, name: `rig${n}`, lifecycleState: "running" }));
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async input => {
    const u = new URL(String(input)); calls.push(u.pathname + u.search);
    if (u.pathname === "/healthz") return Response.json({ selfHostId: "fixture" });
    if (u.pathname === "/api/hosts") return Response.json({ ownName: "fixture", selected: "local", hosts: [] });
    if (u.pathname === "/api/rigs/summary") return Response.json(rigs);
    if (u.pathname === "/api/rigs/r17/nodes" || u.pathname === "/api/queue/recent-transitions" || u.pathname === "/api/queue/list") return Response.json([]);
    if (u.pathname === "/api/health") return Response.json({ schema: "openrig.health-list/v0alpha1", evaluatedAt: "2026-09-05T12:00:00.000Z", total: 0, limit: 200, truncated: false, records: [] });
    throw Error(`Unrelated request ${u.pathname}`);
  }) as typeof fetch });
  let snap = emptySnapshot();
  const view = createViewState({ instanceId: "request-shape", getSnapshot: () => snap });
  snap = await hydrateSnapshot(client, undefined, null, null, null, view.get());
  // Names only: the rigs, and the host registry so the tree lists every registered host.
  expect(calls.sort()).toEqual(["/api/hosts", "/api/rigs/summary", "/healthz"]);
  expect(snap.hosts[0]?.rigs).toHaveLength(24);
  expect(renderScreen(view.get(), snap).lines.join("\n")).toContain("Choose a rig");
  view.dispatch({ type: "drill", resource: "rig", name: "rig17", target: { host: "fixture" } }); calls.length = 0;
  snap = await hydrateSnapshot(client, undefined, null, null, "rig17", view.get());
  expect(snap.readErrors).toEqual([]);
  expect(calls.filter(c => c.endsWith("/nodes"))).toEqual(["/api/rigs/r17/nodes"]);
  expect(calls.filter(c => c.startsWith("/api/queue/list")).sort()).toEqual([
    "/api/queue/list?attention=1", "/api/queue/list?state=blocked", "/api/queue/list?state=in-progress", "/api/queue/list?state=pending&limit=50",
  ]);
  // The rig Table reads health once without fetching other rigs' node inventories.
  expect(calls.filter(c => c.startsWith("/api/health"))).toEqual(["/api/health?limit=200"]);
  expect(calls).toHaveLength(10);
  expect(snap.health).toMatchObject({ availability: "loaded", total: 0, records: [] });
  expect(renderScreen(view.get(), snap, { cols: 220, rows: 60 }).lines.join("\n")).toContain("no findings served; not a healthy verdict");
});

it.each(["overview", "graph", "health"] as const)("a drilled rig on the %s tab reads no seat queue lists", async (viewTab) => {
  const calls: string[] = [];
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async input => {
    const u = new URL(String(input)); calls.push(u.pathname + u.search);
    if (u.pathname === "/healthz") return Response.json({ selfHostId: "fixture" });
    if (u.pathname === "/api/rigs/summary") return Response.json([{ id: "r1", name: "rig1", lifecycleState: "running" }]);
    return Response.json([]);
  }) as typeof fetch });
  await hydrateSnapshot(client, undefined, null, null, "rig1", { section: "topology", viewTab, drill: [{ kind: "rig", name: "rig1" }] } as never);
  expect(calls.filter(c => c.startsWith("/api/queue/list"))).toEqual([]);
});

it("terminal names never wait for all-rig liveness or any provider preview", async () => {
  const calls: string[] = [];
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async input => {
    calls.push(String(input));
    if (String(input) !== "http://fixture/api/terminal/views") throw Error("Expensive read before selection");
    return Response.json({ saved: [{ id: "watch", name: "Build watch", members: [{ seat: "owner@build" }] }], rigs: Array.from({ length: 24 }, (_, n) => `rig${n}`) });
  }) as typeof fetch });
  const state = { ...createViewState({ instanceId: "names" }).get(), section: "terminals" };
  const snap = await hydrateSnapshot(client, undefined, null, null, null, state);
  expect(snap.terminals?.catalog).toHaveLength(25);
  expect(snap.terminals?.catalog[0]).toMatchObject({ name: "Build watch", readinessUnverified: true });
  expect(calls).toHaveLength(1);
});

it("a denial invalidates older views of the same file, while other page reads survive", async () => {
  let scope = "a"; let status = 200;
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async input => String(input).includes("/roots")
    ? Response.json({ roots: [] })
    : Response.json(status === 200 ? { content: "private", root: "a", path: "x", absolutePath: "/a/x" } : { error: "denied" }, { status })) as typeof fetch });
  const state = { ...createViewState({ instanceId: "denial" }).get(), file: { root: "a", path: "x" } };
  const live = createLiveRefresh({ scopeKey: () => scope, now: () => 0, onFrame: () => {}, hydrate: (page, signal) => hydrateSnapshot(client.forPage(page, signal), undefined, null, null, null, state) });
  await live.refresh(); scope = "b"; await live.refresh(); status = 403; await live.refresh();
  expect(live.snapshot().fileRead?.result).toMatchObject({ error: "denied" });
  scope = "a"; expect(live.snapshot().fileRead).toBeUndefined();
  live.close();
});
