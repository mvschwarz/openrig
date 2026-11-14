import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { parseCommand } from "../src/grammar.js";
import { decodeInput, resolveKeyAction, sgrClick } from "../src/input.js";
import { renderScreen } from "../src/render.js";
import { computeExplorerRows, createViewState } from "../src/state.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { explorerWidth } from "../src/visual-layout.js";
import { stylizeLines } from "../src/stylize.js";
import type { AgentRow, FleetSnapshot } from "../src/types.js";

function agent(name: string, session: string, status: string, context: number | null, model = "gpt-5.6"): AgentRow {
  return {
    name,
    session,
    runtime: "codex",
    model,
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
          pods: [
            { name: "dev", agents: [
              agent("dev.driver", "dev-driver@build", "active", 41, "claude-fable-5.1"),
              agent("dev.guard", "dev-guard@build", "attention_required", 73),
            ] },
            { name: "qa", agents: [agent("qa.checker", "qa-checker@build", "idle", 22)] },
          ],
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
      { transitionId: 1, qitemId: "q-build", ts: "2026-09-03T23:01:00.000Z", actorSession: "dev-driver@build", change: "claimed", summary: "Build the instance mission-control hierarchy", rig: "build", targetKind: "slice", target: "OPR.0.5.9.12" },
      { transitionId: 2, qitemId: "q-docs", ts: "2026-09-03T23:02:00.000Z", actorSession: "write-editor@docs", change: "completed", summary: null, rig: "docs", targetKind: "qitem", target: "q-docs" },
    ],
    attention: [{ qitemId: "q-build", state: "blocked", destinationSession: "dev-guard@build", blockedOn: "human@kernel", handedOffTo: null, tier: null, tags: ["slice:OPR.0.5.9.12"], summary: "needs founder", body: "", claimedAt: null, tsUpdated: "2026-09-03T23:00:00Z" }],
    blocked: [],
    inProgress: [],
    seatActivity: [],
    pending: [],
    recentlyFinished: [{ qitemId: "q-docs", state: "done", destinationSession: "write-editor@docs", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: null, body: "Document the operator journey\nRetain the exact human-readable work text.", claimedAt: null, tsUpdated: "2026-09-03T23:02:00Z" }],
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
    const buildRig = snap.hosts[0]!.rigs[0]!;
    buildRig.pods[0]!.agents.push(...Array.from({ length: 36 }, (_, index) =>
      agent(`dev.extra-${index}`, `dev-extra-${index}@build`, "active", 20 + index),
    ));
    const expectedAgents = new Set(
      snap.hosts[0]!.rigs.flatMap((rig) => rig.pods.flatMap((pod) => pod.agents.map((candidate) => candidate.name))),
    );
    const view = openInstance(snap);
    let screen = renderScreen(view.get(), snap, { cols, rows, nowMs: 0, colorMode: "none" });
    view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    const reached = new Set<string>();
    let scrolledSeatRows = 0;
    for (let offset = 0; offset <= screen.contentMaxOffset; offset += 1) {
      screen = renderScreen(view.get(), snap, { cols, rows, nowMs: 0, colorMode: "none" });
      const namedRigs = new Set<string>();
      for (const target of screen.contentTargets) {
        if (target.action.type !== "drill" || target.action.resource !== "agent") continue;
        reached.add(target.action.name);
        const rig = target.action.target?.rig;
        const content = stripAnsi(screen.lines[target.y - 1] ?? "").slice(screen.explorerWidth + 2);
        const firstVisible = !!rig && !namedRigs.has(rig);
        if (rig) namedRigs.add(rig);
        if (!rig || !/\b(working|needs you|idle|detached|failed|unknown|blocked)\b/.test(content)) continue;
        const headingVisible = screen.lines.some((line) => stripAnsi(line).slice(screen.explorerWidth + 2).includes(`RIG ${rig} ·`));
        if (headingVisible) continue;
        scrolledSeatRows += 1;
        if (firstVisible) expect(content.startsWith(rig), `${cols}: first visible seat row of a rig retains rig identity`).toBe(true);
        else expect(content.startsWith(" ".repeat(rig.length)), `${cols}: later seat rows of a rig leave RIG blank`).toBe(true);
      }
      view.dispatch({ type: "content-scroll", delta: 1 });
    }
    const whole = renderScreen(view.get(), snap, { cols, rows: 120, nowMs: 0, colorMode: "none" }).lines.join("\n");
    expect(whole).toContain("mm2-openrig1");
    expect(whole).toMatch(/RIG\s+POD\s+SEAT/);
    expect(whole).not.toMatch(/── RIG (?:build|docs|empty)/);
    expect(whole).toMatch(/build\s+dev\s+/);
    expect(whole).toMatch(/docs\s+write\s+/);
    expect(whole).toMatch(/empty\s+—\s+\(no seats\).*stopped/);
    expect(whole).toMatch(/dev\s+[\s\S]*┈{8,}[\s\S]*qa\s+/);
    expect((whole.match(/┈{8,}/g) ?? [])).toHaveLength(1);
    expect(whole).toMatch(/\s+qa\s+[^\n]*\n[^\n]*─{8,}[^\n]*\n[^\n]*docs\s+write/);
    expect(whole).toMatch(/docs\s+write\s+[^\n]*\n[^\n]*─{8,}[^\n]*\n[^\n]*empty\s+—/);
    expect(whole).not.toMatch(/\+\d+|more hidden/i);
    expect(reached).toEqual(expectedAgents);
    expect(scrolledSeatRows).toBeGreaterThan(0);
    screen.lines.forEach((line) => expect(stripAnsi(line).length).toBeLessThanOrEqual(cols));
  });

  it("shares one ordered event set between the instance TABLE tail and RECENT tab", () => {
    const snap = multiRigSnapshot();
    const view = openInstance(snap);
    const table = renderScreen(view.get(), snap, { cols: 160, rows: 90 }).lines.join("\n");
    expect(table).toMatch(/TABLE.*RECENT.*OVERVIEW.*GRAPH/);
    expect(table.indexOf("16:01")).toBeLessThan(table.indexOf("16:02"));
    expect((table.match(/16:01/g) ?? [])).toHaveLength(1);
    expect(table).toContain("Build the instance mission-control hierarchy");
    expect(table).toContain("Document the operator journey");
    expect(table).not.toContain("no summary served");

    view.dispatch(parseCommand("tab recent"));
    const recent = renderScreen(view.get(), snap, { cols: 160, rows: 90 }).lines.join("\n");
    expect((recent.match(/16:01/g) ?? [])).toHaveLength(1);
    expect((recent.match(/16:02/g) ?? [])).toHaveLength(1);
    expect(recent.indexOf("16:01")).toBeLessThan(recent.indexOf("16:02"));
    expect(recent).toContain("dev-driver@build");
    expect(recent).toContain("rig build");
    expect(recent).toContain("write-editor@docs");
    expect(recent).toContain("rig docs");
    expect(recent).toContain("Document the operator journey");
    expect(recent).not.toContain("no summary served");
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
    const event = screen.contentTargets.find((target) => target.action.type === "recent-open");
    expect(event).toBeDefined();
    bySurface.dispatch(event!.action);
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

  it("keeps continuous rig rows semantically colored without changing geometry", () => {
    const snap = multiRigSnapshot();
    const screen = renderScreen(openInstance(snap).get(), snap, { cols: 160, rows: 120, nowMs: 0, colorMode: "none" });
    const docs = screen.lines.findIndex((line) => line.includes("docs") && line.includes("detached"));
    expect(docs).toBeGreaterThan(0);
    const styled = stylizeLines(screen, createStyle("truecolor"));
    expect(styled[docs]).toContain("\x1b[");
    expect(stripAnsi(styled[docs]!)).toBe(screen.lines[docs]);
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
        "/api/queue/list?state=done,handed-off&sort=updated&limit=20": [],
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
        "/api/queue/list?state=pending&limit=50": [], "/api/queue/list?state=done,handed-off&sort=updated&limit=20": [],
        "/api/scopes?detail=1": { missions: [] }, "/api/views/execution": { rows: [] },
      };
      return { ok: route in empty, status: route in empty ? 200 : 404, json: async () => empty[route] ?? {} } as Response;
    }) as typeof fetch });
    const snap = await hydrateSnapshot(client, new Map(), null, null, null, { section: "topology", viewTab: "table", drill: [] });
    expect(snap.hosts[0]).toMatchObject({ id: "local", name: "local" });
  });
});

describe("instance table RIG column (#2848)", () => {
  const LONG = "RIG-session-review";
  const OVER_CAP = "rig-name-thirty-characters-xx";

  function colsFor(contentWidth: number): number {
    for (let cols = contentWidth; cols < contentWidth + 80; cols += 1) {
      if (cols - explorerWidth(cols) - 2 === contentWidth) return cols;
    }
    throw new Error(`no terminal width gives content width ${contentWidth}`);
  }

  function snapshotWithRigs(names: string[]): FleetSnapshot {
    const snap = multiRigSnapshot();
    snap.hosts[0]!.rigs.push(...names.map((name) => ({
      id: `r-${name}`,
      name,
      lifecycleState: "running",
      pods: [{ name: "ops", agents: [agent("ops.worker", `ops-worker@${name}`, "idle", 10)] }],
    })));
    return snap;
  }

  function table(snap: FleetSnapshot, contentWidth: number, filter = "") {
    const view = openInstance(snap);
    if (filter) view.dispatch({ type: "filter", text: filter });
    const cols = colsFor(contentWidth);
    const screen = renderScreen(view.get(), snap, { cols, rows: 160, nowMs: 0, colorMode: "none" });
    const content = screen.lines.map((line) => stripAnsi(line).slice(screen.explorerWidth + 2));
    const header = content.find((line) => /^RIG\s+POD\s+SEAT/.test(line));
    expect(header, `${contentWidth}: table header`).toBeDefined();
    const heavyRule = content.find((line) => /^━{20,}/.test(line))!.match(/^━+/)![0].length;
    const rigWidth = header!.indexOf("POD") - 1;
    return { screen, content, header: header!, rigWidth, rowWidth: heavyRule };
  }

  it.each([
    // [content width, expected RIG width, flexible column, expected flexible width]
    [77, 8, "WORK", 77 - (8 + 5 + 11 + 2 + 5 + 8 + 2 + 7)],
    [78, 16, "WORK", 78 - 54 - (16 - 10)],
    [109, 16, "WORK", 109 - 54 - (16 - 10)],
    [110, LONG.length, "NOW", 110 - 78 - (LONG.length - 13)],
    [190, LONG.length, "NOW", 190 - 78 - (LONG.length - 13)],
  ] as const)("fits RIG to the longest shown name at content width %i", (contentWidth, rigWidth, flexible, flexibleWidth) => {
    const { header, rigWidth: actual, rowWidth } = table(snapshotWithRigs([LONG]), contentWidth);
    expect(actual).toBe(rigWidth);
    expect(rowWidth).toBeLessThanOrEqual(contentWidth);
    expect(header.trimEnd().endsWith(flexible)).toBe(true);
    expect(rowWidth - header.lastIndexOf(flexible)).toBe(flexibleWidth);
  });

  it("keeps the old RIG width as the minimum when every name is short", () => {
    expect(table(multiRigSnapshot(), 160).rigWidth).toBe(13);
    expect(table(multiRigSnapshot(), 90).rigWidth).toBe(10);
  });

  it.each([[110, 24], [160, 24], [78, 16], [100, 16]])("caps RIG and truncates a longer name at content width %i", (contentWidth, cap) => {
    const { content, rigWidth, rowWidth } = table(snapshotWithRigs([OVER_CAP]), contentWidth);
    expect(rigWidth).toBe(cap);
    expect(rowWidth).toBeLessThanOrEqual(contentWidth);
    expect(content.some((line) => line.startsWith(`${OVER_CAP.slice(0, cap - 1)}…`))).toBe(true);
    for (const line of content) expect(line.trimEnd().length).toBeLessThanOrEqual(contentWidth);
  });

  function seatRows(screen: ReturnType<typeof renderScreen>) {
    return screen.contentTargets
      .filter((target) => target.action.type === "drill" && target.action.resource === "agent")
      .map((target) => ({
        y: target.y,
        rig: target.action.type === "drill" ? target.action.target?.rig ?? "" : "",
        name: target.action.type === "drill" ? target.action.name : "",
        text: stripAnsi(screen.lines[target.y - 1] ?? "").slice(screen.explorerWidth + 2),
      }));
  }

  it("names every rig on its single row when each rig has one seat", () => {
    const names = Array.from({ length: 8 }, (_, index) => `solo-${index}`);
    const { screen } = table(snapshotWithRigs(names), 160);
    const rows = seatRows(screen).filter((row) => names.includes(row.rig));
    expect(rows.map((row) => row.rig)).toEqual(names);
    for (const row of rows) expect(row.text.startsWith(`${row.rig} `)).toBe(true);
  });

  it("names a rig on its first row only, across pod dividers, while POD still leads each pod", () => {
    const { screen, content, rigWidth } = table(multiRigSnapshot(), 160);
    const build = seatRows(screen).filter((row) => row.rig === "build");
    expect(build.map((row) => row.name)).toEqual(["dev.driver", "dev.guard", "qa.checker"]);
    expect(build[0]!.text).toMatch(/^build\s+dev\s/);
    expect(build[1]!.text.slice(0, rigWidth + 4).trim()).toBe("");
    expect(build[2]!.text).toMatch(new RegExp(`^ {${rigWidth}} qa\\s`));
    expect(content[build[2]!.y - 2]).toMatch(/^┈{8,}/);
    expect(content.filter((line) => line.startsWith("build "))).toHaveLength(1);
  });

  it("drills into the row's rig from a blank RIG cell", () => {
    const { screen, rigWidth } = table(multiRigSnapshot(), 160);
    const guard = seatRows(screen).find((row) => row.name === "dev.guard")!;
    expect(guard.text.slice(0, rigWidth).trim()).toBe("");
    for (const x of [screen.explorerWidth + 3, screen.explorerWidth + 2 + rigWidth]) {
      const hit = screen.hitMap.find((target) => target.y === guard.y && x >= target.x1 && x <= target.x2);
      expect(hit?.action).toEqual({ type: "drill", resource: "rig", name: "build", target: { host: "mm2-openrig1" } });
    }
    const pastRig = screen.explorerWidth + 3 + rigWidth;
    const seatHit = screen.hitMap.find((target) => target.y === guard.y && pastRig >= target.x1 && pastRig <= target.x2);
    expect(seatHit?.action).toMatchObject({ type: "drill", resource: "agent", name: "dev.guard" });
  });

  it("names a scrolled rig on its top visible row and leaves the rows under it blank", () => {
    const snap = multiRigSnapshot();
    snap.hosts[0]!.rigs[0]!.pods[0]!.agents.push(...Array.from({ length: 36 }, (_, index) =>
      agent(`dev.extra-${index}`, `dev-extra-${index}@build`, "active", 20 + index),
    ));
    const view = openInstance(snap);
    let screen = renderScreen(view.get(), snap, { cols: 160, rows: 30, nowMs: 0, colorMode: "none" });
    view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    let checked = false;
    for (let offset = 0; offset <= screen.contentMaxOffset && !checked; offset += 1) {
      screen = renderScreen(view.get(), snap, { cols: 160, rows: 30, nowMs: 0, colorMode: "none" });
      const build = seatRows(screen).filter((row) => row.rig === "build");
      if (build.length >= 3 && build[0]!.name !== "dev.driver") {
        expect(build[0]!.text.startsWith("build ")).toBe(true);
        for (const row of build.slice(1)) expect(row.text.startsWith("      ")).toBe(true);
        checked = true;
      }
      view.dispatch({ type: "content-scroll", delta: 1 });
    }
    expect(checked).toBe(true);
  });

  it("sizes RIG from the rigs the filter leaves on screen", () => {
    const snap = snapshotWithRigs([LONG, "short-rig"]);
    expect(table(snap, 160).rigWidth).toBe(LONG.length);
    expect(table(snap, 160, "short").rigWidth).toBe(13);
  });
});
