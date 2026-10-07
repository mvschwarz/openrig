import { describe, it, expect, vi } from "vitest";
import { StartupController } from "../src/startup.js";
import { DaemonClient } from "../src/daemon-client.js";
import { createLiveRefresh } from "../src/live.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";

describe("S01 entry and page reads", () => {
  it("enters ordinary views on a positive running observation without any launch", async () => {
    const onWork = vi.fn();
    const startDaemon = vi.fn();
    const client = new DaemonClient({ fetchImpl: vi.fn(async () => new Response(JSON.stringify([{ id: "stopped", name: "first", lifecycleState: "stopped" }, { id: "r", name: "active", lifecycleState: "running" }]))) });
    const startup = new StartupController({ client, home: "/fixture", probe: async () => '{"state":"up"}', startDaemon, onWork, onChange: () => {} });
    await startup.refresh();
    expect(startup.state.open).toBe(false);
    expect(onWork).toHaveBeenCalledWith();
    expect(startDaemon).not.toHaveBeenCalled();
  });
  it("marks a terminal source failure stale", async () => {
    const failed = emptySnapshot(); failed.readErrors = ["terminals: timeout"];
    const live = createLiveRefresh({ hydrate: async () => failed, now: () => 0, onFrame: () => {} });
    await live.refresh();
    expect(live.load().stale).toBe(true);
    live.close();
  });
  it.each(["needs", "config", "terminals", "specs"])("%s initial pending does not claim unavailable or zero", (section) => {
    const view = createViewState({ instanceId: "fixture", getSnapshot: emptySnapshot });
    const state = { ...view.get(), section };
    const text = renderScreen(state, emptySnapshot(), { cols: 80, rows: 24, load: { inFlight: true, settled: false } }).lines.join("\n");
    expect(text).toMatch(/loading|pending/i);
    expect(text).not.toMatch(/Unavailable|Saved \(0\)|Derived \(0\)|0 rigs|0 agents/);
  });
});

describe("request identity and partial refresh", () => {
  it("retains a catalog on timeout, accepts a later successful empty answer, and keeps the time basis", async () => {
    const { hydrateSnapshot } = await import("../src/hydrate.js");
    let mode = "success"; let now = 1000;
    const client = new DaemonClient({ fetchImpl: (async () => {
      if (mode === "failure") throw new Error("fixture timeout");
      return new Response(JSON.stringify({ saved: mode === "empty" ? [] : [{ id: "one", name: "One", members: [{ seat: "one" }] }], rigs: [] }));
    }) as typeof fetch });
    const state = { ...createViewState({ instanceId: "fixture" }).get(), section: "terminals", terminalView: null };
    const live = createLiveRefresh({ hydrate: (page, signal) => hydrateSnapshot(client.forPage(page, signal), undefined, undefined, undefined, undefined, state), now: () => now, onFrame: () => {} });
    await live.refresh();
    mode = "failure"; now = 2000; await live.refresh();
    expect(live.snapshot().terminals?.catalog[0]?.name).toBe("One");
    expect(live.snapshot().readErrors.join()).toContain("fixture timeout");
    expect(live.load()).toMatchObject({ stale: true, retainedAt: 1000, lastSuccessAt: 1000 });
    mode = "empty"; now = 3000; await live.refresh();
    expect(live.snapshot().terminals?.catalog).toEqual([]);
    expect(live.load()).toMatchObject({ stale: false, lastSuccessAt: 3000 });
    expect(live.load().retainedAt).toBeUndefined();
    live.close();
  });

  it("rejects an old page's late response, even when its transport ignores cancellation", async () => {
    let scope = "project:a";
    let release!: () => void;
    let oldSignal!: AbortSignal;
    const live = createLiveRefresh({ scopeKey: () => scope, now: () => 0, onFrame: () => {}, hydrate: async (_, signal) => {
      const startedScope = scope;
      if (scope === "project:a") { oldSignal = signal; await new Promise<void>(resolve => { release = resolve; }); }
      return { ...emptySnapshot(), stream: [{ tsEmitted: "", sourceSession: startedScope, body: startedScope, streamSortKey: "" }] };
    } });
    const first = live.refresh();
    scope = "project:b";
    expect(live.snapshot().stream).toEqual([]);
    expect(oldSignal.aborted).toBe(true);
    const second = live.refresh();
    release(); await Promise.all([first, second]);
    expect(live.snapshot().stream[0]?.body).toBe("project:b");
    live.close();
  });

  it("does not retain a file after an access refusal or successful deletion response", async () => {
    const { PageRead } = await import("../src/page-read.js");
    const page = new PageRead(() => 0);
    let status = 200;
    const fetcher = page.fetch((async () => new Response(status === 200 ? '{"content":"private"}' : '{"error":"denied"}', { status })) as typeof fetch, new AbortController().signal);
    await fetcher("http://fixture/api/files/read?root=a&path=b");
    status = 403; expect((await fetcher("http://fixture/api/files/read?root=a&path=b")).status).toBe(403);
    status = 500; await expect(fetcher("http://fixture/api/files/read?root=a&path=b")).rejects.toThrow("HTTP 500");
  });
});

describe("entry never takes navigation from the user", () => {
  it.each(["?", "w", "L", "escape"])("preserves %s during a late positive observation", async key => {
    let release!: () => void;
    const onWork = vi.fn(); const onHelp = vi.fn();
    const client = new DaemonClient({ fetchImpl: (async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return new Response('[{"id":"r","name":"active","lifecycleState":"running"}]');
    }) as typeof fetch });
    const startup = new StartupController({ client, home: "/fixture", probe: async () => '{"state":"up"}', startDaemon: vi.fn(), onWork, onHelp, onChange: () => {} });
    const pending = startup.refresh();
    await vi.waitFor(() => expect(release).toBeDefined());
    await startup.key(key);
    const calls = onWork.mock.calls.length;
    release(); await pending;
    expect(onWork).toHaveBeenCalledTimes(calls);
    if (key === "?") expect(onHelp).toHaveBeenCalledOnce();
  });
  it.each(["stopped", "recoverable", "degraded", "attention_required", undefined])("opens ordinary views while retaining the %s observation, without effects", async lifecycleState => {
    const onWork = vi.fn(); const startDaemon = vi.fn(); const probe = vi.fn();
    const rigs = [{ id: "r", name: "r", lifecycleState }];
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(rigs));
    const client = new DaemonClient({ fetchImpl });
    const startup = new StartupController({ client, home: "/fixture", probe, startDaemon, onWork, onChange: () => {} });
    await startup.refresh();
    expect(startup.state.open).toBe(false); expect(onWork).toHaveBeenCalledOnce(); expect(onWork).toHaveBeenCalledWith();
    expect(startup.state.rigs).toEqual(rigs);
    expect(startDaemon).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.method).not.toBe("POST");
  });
  it("opens ordinary views for an empty instance and keeps explicit recovery open across refreshes", async () => {
    const onWork = vi.fn(); const startDaemon = vi.fn();
    const client = new DaemonClient({ fetchImpl: async () => Response.json([]) });
    const startup = new StartupController({ client, home: "/fixture", probe: vi.fn(), startDaemon, onWork, onChange: () => {} });
    await startup.refresh();
    expect(startup.state.open).toBe(false); expect(onWork).toHaveBeenCalledOnce();
    await startup.open(); // The ordinary view's S key deliberately opens Start and return.
    await startup.refresh();
    expect(startup.state).toMatchObject({ open: true, page: "rigs", connection: "up", rigs: [] });
    expect(onWork).toHaveBeenCalledOnce(); expect(startDaemon).not.toHaveBeenCalled();
  });
});

it("a missing-file response clears content without advancing the last successful read", async () => {
  const { hydrateSnapshot } = await import("../src/hydrate.js");
  let now = 1000; let missing = false;
  const client = new DaemonClient({ fetchImpl: (async input => {
    if (String(input).includes('/roots')) return Response.json({ roots: [{ name: 'workspace', path: '/fixture' }] });
    return missing ? Response.json({ error: 'stat_failed', message: 'File missing' }, { status: 404 })
      : Response.json({ root: 'workspace', path: 'SPEC.md', absolutePath: '/fixture/SPEC.md', content: 'Retain this until a refusal', mtime: '2026-09-10T00:00:00Z', contentHash: 'abc', truncated: false });
  }) as typeof fetch });
  const state = { ...createViewState({ instanceId: 'fixture' }).get(), file: { root: 'workspace', path: 'SPEC.md' } };
  const live = createLiveRefresh({ now: () => now, onFrame: () => {}, hydrate: (page, signal) => hydrateSnapshot(client.forPage(page, signal), undefined, undefined, undefined, undefined, state) });
  await live.refresh(); missing = true; now = 2000; await live.refresh();
  expect(live.snapshot().fileRead?.result).toMatchObject({ error: 'stat_failed' });
  expect(live.load()).toMatchObject({ stale: true, lastSuccessAt: 1000 });
  live.close();
});
