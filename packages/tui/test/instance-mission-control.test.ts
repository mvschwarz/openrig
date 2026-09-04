import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { parseCommand } from "../src/grammar.js";
import { decodeInput, resolveKeyAction, sgrClick } from "../src/input.js";
import { renderScreen } from "../src/render.js";
import { computeExplorerRows, createViewState } from "../src/state.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { stylizeLines } from "../src/stylize.js";
import type { AgentRow, FleetSnapshot } from "../src/types.js";

function agent(name: string, session: string, status: string, context: number | null): AgentRow {
  return {
    name,
    session,
    runtime: "codex",
    spec: "builder",
    context,
    tokens: null,
    status,
    live: status !== "detached",
  };
}

function multiRigSnapshot(): FleetSnapshot {
  return {
    hosts: [{
      id: "local",
      name: "mm2-openrig1",
      reachable: true,
      rigs: [
        {
          id: "r-build",
          name: "build",
          lifecycleState: "running",
          pods: [{ name: "dev", agents: [
            agent("dev.driver", "dev-driver@build", "active", 41),
            agent("dev.guard", "dev-guard@build", "attention_required", 73),
          ] }],
        },
        {
          id: "r-docs",
          name: "docs",
          lifecycleState: "recoverable",
          pods: [{ name: "write", agents: [agent("write.editor", "write-editor@docs", "detached", null)] }],
        },
        { id: "r-empty", name: "empty", lifecycleState: "stopped", pods: [] },
      ],
    }],
    specs: [],
    needs: [],
    humanQueueProbed: true,
    scopes: [{
      mission: "release-0.5.9",
      slices: [{
        id: "OPR.0.5.9.12",
        dirName: "12-instance-mission-control",
        displayName: "Instance Mission Control",
        intent: "watch all rigs",
        status: "active",
        stage: "wip",
        locks: { spec: null, delivery: null },
        miniRequirements: [],
        proofContract: [],
        proof: { paired: 0, total: 0 },
        narrative: null,
        specShaShort: null,
        prdExists: false,
      }],
    }],
    recentTransitionsScope: { kind: "instance" },
    recentTransitions: [
      { transitionId: 1, qitemId: "q-build", ts: "2026-09-03T23:01:00.000Z", actorSession: "dev-driver@build", change: "claimed", rig: "build", targetKind: "slice", target: "OPR.0.5.9.12" },
      { transitionId: 2, qitemId: "q-docs", ts: "2026-09-03T23:02:00.000Z", actorSession: "write-editor@docs", change: "completed", rig: "docs", targetKind: "qitem", target: "q-docs" },
    ],
    attention: [{ qitemId: "q-build", state: "blocked", destinationSession: "dev-guard@build", blockedOn: "human@kernel", handedOffTo: null, tier: null, tags: ["slice:OPR.0.5.9.12"], summary: "needs founder", body: "", claimedAt: null, tsUpdated: "2026-09-03T23:00:00Z" }],
    blocked: [],
    inProgress: [],
    seatActivity: [],
    pending: [],
    recentlyFinished: [{ qitemId: "q-docs", state: "done", destinationSession: "write-editor@docs", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "docs complete", body: "", claimedAt: null, tsUpdated: "2026-09-03T23:02:00Z" }],
    hostsDown: [],
    stream: [],
    readErrors: [],
  };
}

function openInstance(snap: FleetSnapshot) {
  const view = createViewState({ instanceId: "tui-process-7", getSnapshot: () => snap });
  const root = computeExplorerRows(view.get(), snap).find((row) => row.key === "host:mm2-openrig1");
  expect(root).toBeDefined();
  view.dispatch(root!.action);
  return view;
}

afterEach(() => {
  delete process.env["OPENRIG_REDUCED_MOTION"];
});

describe("S12 instance mission control", () => {
  it.each([[160, 42], [120, 34], [84, 28]])("renders every rig and seat with full scroll reach at %ix%i", (cols, rows) => {
    const snap = multiRigSnapshot();
    const view = openInstance(snap);
    let screen = renderScreen(view.get(), snap, { cols, rows, nowMs: 0, colorMode: "none" });
    view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    const reached = new Set<string>();
    for (let offset = 0; offset <= screen.contentMaxOffset; offset += 1) {
      screen = renderScreen(view.get(), snap, { cols, rows, nowMs: 0, colorMode: "none" });
      for (const target of screen.contentTargets) {
        if (target.action.type === "drill" && target.action.resource === "agent") reached.add(target.action.name);
      }
      view.dispatch({ type: "content-scroll", delta: 1 });
    }
    const whole = renderScreen(view.get(), snap, { cols, rows: 120, nowMs: 0, colorMode: "none" }).lines.join("\n");
    expect(whole).toContain("mm2-openrig1");
    expect(whole).toMatch(/RIG\s+POD\s+SEAT/);
    expect(whole).toContain("recoverable");
    expect(whole).toContain("stopped");
    expect(whole).not.toMatch(/\+\d+|more hidden/i);
    expect(reached).toEqual(new Set(["dev.driver", "dev.guard", "write.editor"]));
    screen.lines.forEach((line) => expect(stripAnsi(line).length).toBeLessThanOrEqual(cols));
  });

  it("shares one ordered event set between the instance TABLE tail and RECENT tab", () => {
    const snap = multiRigSnapshot();
    const view = openInstance(snap);
    const table = renderScreen(view.get(), snap, { cols: 160, rows: 90 }).lines.join("\n");
    expect(table).toMatch(/TABLE.*RECENT.*OVERVIEW.*GRAPH/);
    expect(table.indexOf("23:01")).toBeLessThan(table.indexOf("23:02"));
    expect((table.match(/23:01/g) ?? [])).toHaveLength(1);

    view.dispatch(parseCommand("tab recent"));
    const recent = renderScreen(view.get(), snap, { cols: 160, rows: 90 }).lines.join("\n");
    expect((recent.match(/23:01/g) ?? [])).toHaveLength(1);
    expect((recent.match(/23:02/g) ?? [])).toHaveLength(1);
    expect(recent.indexOf("23:01")).toBeLessThan(recent.indexOf("23:02"));
    expect(recent).toMatch(/build\s+dev-driver@build/);
    expect(recent).toMatch(/docs\s+write-editor@docs/);
  });

  it("uses the same actions for root, tabs, rig rows, seats, and transition targets", () => {
    const snap = multiRigSnapshot();
    const byCommand = createViewState({ instanceId: "cmd", getSnapshot: () => snap });
    byCommand.dispatch(parseCommand("host mm2-openrig1"));
    expect(byCommand.get().drill).toEqual([{ kind: "host", name: "mm2-openrig1" }]);

    const bySurface = openInstance(snap);
    let screen = renderScreen(bySurface.get(), snap, { cols: 160, rows: 90 });
    const recentTab = screen.hitMap.find((target) => target.action.type === "tab" && target.action.tab === "recent");
    expect(recentTab).toBeDefined();
    bySurface.dispatch(recentTab!.action);
    expect(bySurface.get().viewTab).toBe("recent");
    screen = renderScreen(bySurface.get(), snap, { cols: 160, rows: 90 });
    const slice = screen.contentTargets.find((target) => target.action.type === "scopes-open");
    expect(slice).toBeDefined();
    bySurface.dispatch(slice!.action);
    expect(bySurface.get().section).toBe("scopes");

    const drill = openInstance(snap);
    screen = renderScreen(drill.get(), snap, { cols: 160, rows: 90 });
    const docsRig = screen.contentTargets.find((target) => target.action.type === "drill" && target.action.resource === "rig" && target.action.name === "docs");
    const guard = screen.contentTargets.find((target) => target.action.type === "drill" && target.action.resource === "agent" && target.action.name === "dev.guard");
    expect(docsRig).toBeDefined();
    expect(guard).toBeDefined();
  });

  it("reaches the RECENT tab identically by command, mouse, and keyboard", () => {
    const snap = multiRigSnapshot();
    const byCommand = openInstance(snap);
    byCommand.dispatch(parseCommand("tab recent"));

    const byMouse = openInstance(snap);
    let screen = renderScreen(byMouse.get(), snap, { cols: 120, rows: 34 });
    const recentHit = screen.hitMap.find((target) => target.action.type === "tab" && target.action.tab === "recent");
    expect(recentHit).toBeDefined();
    const click = decodeInput(sgrClick(recentHit!.x1, recentHit!.y)).find((event) => event.type === "mouse");
    expect(click?.type).toBe("mouse");
    const clicked = click?.type === "mouse"
      ? screen.hitMap.find((target) => target.y === click.y && click.x >= target.x1 && click.x <= target.x2)
      : undefined;
    expect(clicked).toBeDefined();
    byMouse.dispatch(clicked!.action);

    const byKeyboard = openInstance(snap);
    screen = renderScreen(byKeyboard.get(), snap, { cols: 120, rows: 34 });
    byKeyboard.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    for (const bytes of ["\x1b[C", "\x1b[B", "\r"]) {
      screen = renderScreen(byKeyboard.get(), snap, { cols: 120, rows: 34 });
      const event = decodeInput(bytes)[0];
      if (!event || event.type !== "key") throw new Error("expected key event");
      const action = resolveKeyAction(event, byKeyboard.get(), screen, computeExplorerRows(byKeyboard.get(), snap).length);
      if (action) byKeyboard.dispatch(action);
    }

    expect(byMouse.get().viewTab).toBe("recent");
    expect(byKeyboard.get().viewTab).toBe("recent");
    expect(byMouse.get().drill).toEqual(byCommand.get().drill);
    expect(byKeyboard.get().drill).toEqual(byCommand.get().drill);
  });

  it("keeps no-color geometry and reduced-motion frames stable", () => {
    const snap = multiRigSnapshot();
    const view = openInstance(snap);
    const plain = renderScreen(view.get(), snap, { cols: 120, rows: 34, nowMs: 0, colorMode: "none" });
    const styled = stylizeLines(plain, createStyle("truecolor"));
    styled.forEach((line, index) => expect(stripAnsi(line)).toBe(plain.lines[index]));
    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    expect(renderScreen(view.get(), snap, { cols: 120, rows: 34, nowMs: 0 }).lines).toEqual(
      renderScreen(view.get(), snap, { cols: 120, rows: 34, nowMs: 500 }).lines,
    );
  });
});

describe("S12 view-aware hydration", () => {
  it("uses one instance RECENT read and no eager graph/spec read for instance TABLE", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const route = String(url).replace("http://x", "");
      seen.push(route);
      const responses: Record<string, unknown> = {
        "/healthz": { selfHostId: "mm2-openrig1" },
        "/api/queue/attention-aggregate": { hosts: [{ hostId: "local", status: "ok" }] },
        "/api/rigs/summary": [
          { id: "r-a", name: "build", lifecycleState: "running" },
          { id: "r-b", name: "docs", lifecycleState: "running" },
        ],
        "/api/rigs/r-a/nodes": [],
        "/api/rigs/r-b/nodes": [],
        "/api/review/fleet": { needsYou: { items: [] }, hosts: [{ hostId: "local", status: { status: "ok" } }] },
        "/api/stream/list?limit=5&direction=latest": [],
        "/api/queue/list?attention=1": [],
        "/api/queue/list?state=blocked": [],
        "/api/queue/list?state=in-progress": [],
        "/api/queue/list?state=pending&limit=50": [],
        "/api/queue/list?state=done,handed-off&limit=20": [],
        "/api/scopes?detail=1": { missions: [] },
        "/api/views/execution": { rows: [] },
        "/api/queue/recent-transitions?scope=instance&limit=20": [],
      };
      const body = responses[route];
      return body === undefined
        ? { ok: false, status: 404, json: async () => ({}) } as Response
        : { ok: true, json: async () => body } as Response;
    }) as typeof fetch;
    const client = new DaemonClient({ baseUrl: "http://x", fetchImpl });
    const snap = await hydrateSnapshot(client, new Map(), null, null, null, {
      section: "topology",
      viewTab: "table",
      drill: [{ kind: "host", name: "mm2-openrig1" }],
    });
    expect(snap.hosts[0]).toMatchObject({ id: "local", name: "mm2-openrig1" });
    expect(seen.filter((route) => route.includes("recent-transitions"))).toEqual([
      "/api/queue/recent-transitions?scope=instance&limit=20",
    ]);
    expect(seen.some((route) => route.includes("/graph") || route.includes("/spec.json") || route.includes("/specs/library"))).toBe(false);
  });

  it("falls back to local only when health serves no instance identity", async () => {
    const client = new DaemonClient({ baseUrl: "http://x", fetchImpl: (async (url: unknown) => {
      const route = String(url).replace("http://x", "");
      const empty: Record<string, unknown> = {
        "/healthz": {}, "/api/queue/attention-aggregate": { hosts: [] }, "/api/rigs/summary": [],
        "/api/review/fleet": { needsYou: { items: [] }, hosts: [] }, "/api/stream/list?limit=5&direction=latest": [],
        "/api/queue/list?attention=1": [], "/api/queue/list?state=blocked": [], "/api/queue/list?state=in-progress": [],
        "/api/queue/list?state=pending&limit=50": [], "/api/queue/list?state=done,handed-off&limit=20": [],
        "/api/scopes?detail=1": { missions: [] }, "/api/views/execution": { rows: [] },
      };
      return { ok: route in empty, status: route in empty ? 200 : 404, json: async () => empty[route] ?? {} } as Response;
    }) as typeof fetch });
    const snap = await hydrateSnapshot(client, new Map(), null, null, null, { section: "topology", viewTab: "table", drill: [] });
    expect(snap.hosts[0]).toMatchObject({ id: "local", name: "local" });
  });
});
