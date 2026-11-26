// Topology opens on a busy daemon: its first paint waits only on its own reads (rigs, hosts, seats), and the other
// reads (health findings, the queue lists, check-ins) arrive after it, shown as pending, never as a Topology failure.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, TOPOLOGY_READ_WAIT_MS } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createLiveRefresh } from "../src/live.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

const NODE = {
  nodeId: "01JNODEIMPL", rigId: "01JRIG", rigName: "myrig", logicalId: "dev.impl", podId: "01JPOD", podNamespace: "dev",
  role: "implementer", canonicalSessionName: "dev-impl@myrig", nodeKind: "agent", runtime: "claude-code",
  sessionStatus: "running", startupStatus: "ready", restoreOutcome: "resumed", oriented: "verified",
  terminalActive: false, lastActivityAt: "2026-08-02T09:15:00.000Z",
  lifecycleState: "running", occupantLifecycle: "active", continuityOutcome: null, handoverResult: null,
  previousOccupant: null, handoverAt: null, tmuxAttachCommand: null, resumeCommand: null,
  recoveryGuidance: null, latestError: null, model: null, agentRef: "implementer", profile: "default",
  resolvedSpecName: "implementer", resolvedSpecVersion: "0.1.0", resolvedSpecHash: "ab12", cwd: "/repo",
  restorePolicy: "resume_if_possible", resumeType: "native", resumeToken: "sess-abc", startupCompletedAt: null,
  contextUsage: null, hasAssignedWork: false, pendingWorkCount: 0,
};
// Topology's own reads answer at once.
const TOPOLOGY: Record<string, unknown> = {
  "/healthz": { ok: true, selfHostId: "host-a" },
  "/api/hosts": { ownName: "localhost", selected: "local", hosts: [] },
  "/api/rigs/summary": [{ id: "01JRIG", name: "myrig", nodeCount: 1, hasServices: false, latestSnapshotAt: null, latestSnapshotId: null, archivedAt: null, lifecycleState: "running" }],
  "/api/rigs/01JRIG/nodes": [NODE],
};
// The rest answers once released: the health list, the queue lists and the check-ins.
const LATER: Record<string, unknown> = {
  "/api/health?limit=200": { schema: "openrig.health-list/v0alpha1", evaluatedAt: "2026-09-05T12:00:00.000Z", total: 0, limit: 200, truncated: false, records: [] },
  "/api/queue/list?attention=1": [],
  "/api/queue/list?state=blocked": [],
  "/api/queue/list?state=in-progress": [],
  "/api/queue/list?state=pending&limit=50": [],
  "/api/queue/hosted-members": { members: [] },
};
// A rig's Table page: it shows the rig's seats, its health line and its seats' queue rows.
const RIG_TABLE = { section: "topology" as const, viewTab: "table" as const, drill: [{ kind: "rig" as const, name: "myrig" }] };

function slowDaemon(answer: (route: string) => Promise<Response> | null = () => null) {
  const calls: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl = (async (url: unknown) => {
    const route = String(url).replace("http://x", "");
    calls.push(route);
    if (route in TOPOLOGY) return new Response(JSON.stringify(TOPOLOGY[route]), { status: 200 });
    if (!(route in LATER) && !route.startsWith("/api/queue/recent-transitions")) throw new Error(`unexpected route in test: ${route}`);
    await released;
    return answer(route) ?? new Response(JSON.stringify(LATER[route] ?? []), { status: 200 });
  }) as typeof fetch;
  return { client: new DaemonClient({ baseUrl: "http://x", fetchImpl }), calls, release };
}

function view(snapshot: () => FleetSnapshot) {
  const store = createViewState({ instanceId: "first-paint", getSnapshot: snapshot });
  return { ...store.get(), ...RIG_TABLE };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("Topology's first paint on a busy daemon", () => {
  it("draws the rig's seats while health and the queue lists are still being read, then fills them in", async () => {
    const daemon = slowDaemon((route) => route === "/api/queue/hosted-members"
      ? Promise.resolve(new Response(JSON.stringify({ members: [{ seat: "helper@myrig", status: "unknown" }] }), { status: 200 })) : null);
    let firstPaint: { snapshot: FleetSnapshot; calls: string[]; inFlight: boolean } | undefined;
    const live = createLiveRefresh({
      hydrate: (page, signal, first) => hydrateSnapshot(daemon.client.forPage(page, signal), undefined, null, null, "myrig", { ...view(() => live.snapshot()), ...RIG_TABLE }, { firstPaint: first }),
      onFrame: () => {
        if (!firstPaint && live.snapshot().pendingReads) firstPaint = { snapshot: live.snapshot(), calls: [...daemon.calls], inFlight: live.load().inFlight };
      },
      now: () => Date.now(),
    });
    let answered = false;
    void live.answered().then(() => { answered = true; });
    const done = live.refresh();
    await vi.waitFor(() => expect(firstPaint).toBeDefined());
    // The page has its answer at the first paint, while the held reads are still out.
    await vi.waitFor(() => expect(answered).toBe(true));

    // The first paint read only Topology's own routes; nothing waited on the held reads.
    expect(firstPaint!.calls.sort()).toEqual(["/api/hosts", "/api/rigs/01JRIG/nodes", "/api/rigs/summary", "/healthz"]);
    expect(firstPaint!.inFlight).toBe(true);
    const painted = firstPaint!.snapshot;
    expect(painted.hosts[0]!.rigs[0]!.pods[0]!.agents.map((agent) => agent.name)).toEqual(["dev.impl"]);
    expect(painted.health?.availability).toBe("pending");
    expect(painted.queueCoverage).toBe("pending");
    expect(painted.readErrors).toEqual([]);
    const screen = renderScreen(view(() => painted), painted, { cols: 160, rows: 40, nowMs: Date.now(), colorMode: "none", load: live.load() })
      .lines.join("\n");
    expect(screen).toMatch(/dev +· impl/);
    expect(screen).toContain("Pending · read after the rigs and seats");
    expect(screen).toContain("Connected assistants: pending");
    expect(screen).not.toContain("check-in unavailable");
    expect(screen).not.toContain("rigs read failed");

    // The held reads answer late; the page fills in and the first paint's marks go away.
    daemon.release();
    await done;
    const settled = live.snapshot();
    expect(settled.pendingReads).toBeUndefined();
    expect(settled.health?.availability).toBe("loaded");
    expect(settled.queueCoverage).toBe("complete");
    expect(settled.hosts[0]!.rigs[0]!.pods[0]!.agents.map((agent) => agent.name)).toEqual(["dev.impl"]);
    expect(live.load()).toMatchObject({ inFlight: false, settled: true, stale: false });
    const settledScreen = renderScreen(view(() => settled), settled, { cols: 160, rows: 40, nowMs: Date.now(), colorMode: "none", load: live.load() }).lines.join("\n");
    expect(settledScreen).toContain("helper@myrig");
    expect(settledScreen).not.toContain("Connected assistants: pending");
    live.close();
  });

  it.each(["http", "timeout"])("replaces pending connected assistants with a named late %s failure", async (failure) => {
    const daemon = slowDaemon((route) => route !== "/api/queue/hosted-members" ? null
      : failure === "http" ? Promise.resolve(new Response("{}", { status: 404 }))
      : Promise.reject(new DOMException("held read timed out", "TimeoutError")));
    const live = createLiveRefresh({
      hydrate: (page, signal, first) => hydrateSnapshot(daemon.client.forPage(page, signal), undefined, null, null, "myrig", RIG_TABLE, { firstPaint: first }),
      onFrame: () => {}, now: () => Date.now(),
    });
    const done = live.refresh();
    await live.answered();
    const screen = () => renderScreen(view(() => live.snapshot()), live.snapshot(), { cols: 160, rows: 40, nowMs: Date.now(), colorMode: "none", load: live.load() }).lines.join("\n");
    expect(screen()).toContain("Connected assistants: pending");
    daemon.release();
    await done;
    expect(screen()).toContain("Connected assistants: check-in unavailable");
    expect(screen()).toContain(failure === "http" ? "this daemon doesn't serve it" : "held read timed out");
    expect(screen()).not.toContain("Connected assistants: pending");
    expect(live.snapshot().hosts[0]!.rigs[0]!.pods[0]!.agents.map((a) => a.name)).toEqual(["dev.impl"]);
    live.close();
  });

  it("keeps the rigs when the slow health read then fails, and names only that read", async () => {
    const daemon = slowDaemon((route) => route.startsWith("/api/health")
      ? Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")) : null);
    const live = createLiveRefresh({
      hydrate: (page, signal, first) => hydrateSnapshot(daemon.client.forPage(page, signal), undefined, null, null, "myrig", { ...view(() => live.snapshot()), ...RIG_TABLE }, { firstPaint: first }),
      onFrame: () => {},
      now: () => Date.now(),
    });
    const done = live.refresh();
    await vi.waitFor(() => expect(live.snapshot().pendingReads).toBe(true));
    daemon.release();
    await done;
    const snap = live.snapshot();
    expect(snap.health?.availability).toBe("unavailable");
    expect(snap.readErrors.filter((error) => !error.startsWith("/api/health")))
      .toEqual(["health-findings: The operation was aborted due to timeout"]);
    expect(snap.hosts[0]!.rigs[0]!.pods[0]!.agents.map((agent) => agent.name)).toEqual(["dev.impl"]);
    const screen = renderScreen(view(() => snap), snap, { cols: 160, rows: 40, nowMs: Date.now(), colorMode: "none", load: live.load() }).lines.join("\n");
    expect(screen).toMatch(/dev +· impl/);
    expect(screen).not.toContain("rigs read failed");
  });

  it("reads everything in one pass once the page has an answer", async () => {
    const daemon = slowDaemon();
    daemon.release();
    const firstPaints: boolean[] = [];
    const live = createLiveRefresh({
      hydrate: (page, signal, first) => {
        firstPaints.push(!!first);
        return hydrateSnapshot(daemon.client.forPage(page, signal), undefined, null, null, "myrig", { ...view(() => live.snapshot()), ...RIG_TABLE }, { firstPaint: first });
      },
      onFrame: () => {},
      now: () => Date.now(),
    });
    await live.refresh();
    await live.invalidate();
    expect(firstPaints).toEqual([true, false, false]);
  });
});

describe("Topology's own reads wait for a busy daemon", () => {
  it("gives the rigs, seats, hosts and daemon identity reads the longer limit, and every other read 5 s", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const client = new DaemonClient({ baseUrl: "http://x", fetchImpl: (async () => new Response("[]", { status: 200 })) as typeof fetch });
    const limitOf = async (read: () => Promise<unknown>) => { timeout.mockClear(); await read(); return timeout.mock.calls.map(([ms]) => ms); };
    expect(TOPOLOGY_READ_WAIT_MS).toBe(20_000);
    for (const read of [() => client.health(), () => client.rigsSummary(), () => client.rigsSummary("ovh02"), () => client.hosts(),
      () => client.rigNodes("01JRIG"), () => client.rigGraph("01JRIG"), () => client.ps()]) {
      expect(await limitOf(read)).toEqual([TOPOLOGY_READ_WAIT_MS]);
    }
    for (const read of [() => client.healthFindings(), () => client.attentionAggregate(), () => client.queueAttention()]) {
      expect(await limitOf(read)).toEqual([5_000]);
    }
  });
});
