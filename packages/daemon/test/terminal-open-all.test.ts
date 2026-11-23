import { beginPrivateTerminalTmux, endPrivateTerminalTmux, privateTerminalTmuxDeps } from "../../../test/terminal-tmux-isolation.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { HerdrAdapter } from "../src/domain/terminal/herdr-adapter.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import type { HerdrResult, HerdrTransport } from "../src/domain/terminal/herdr-transport.js";
import type { OpenViewResult, TerminalProvider } from "../src/domain/terminal/terminal-provider.js";
import type { LiveSeatRow } from "../src/domain/terminal/terminal-views-store.js";

const terminalTmuxRoot = beginPrivateTerminalTmux(tmpdir());
afterAll(() => { endPrivateTerminalTmux(terminalTmuxRoot); });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const leafLabels = (node: unknown): string[] => {
  if (!node || typeof node !== "object") return [];
  const obj = node as Record<string, unknown>;
  if (obj["type"] === "pane") return [String(obj["label"] ?? "")];
  return [...leafLabels(obj["first"]), ...leafLabels(obj["second"])];
};

function echoAppliedRoot(
  node: unknown,
  tabId: string,
  panes: Pane[],
  workspaceId: string,
): unknown {
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  if (obj["type"] === "pane") {
    const label = String(obj["label"] ?? "");
    const pane_id = `${tabId}-p${panes.length + 1}`;
    const cmd = Array.isArray(obj["command"]) ? (obj["command"] as string[]).join(" ") : "";
    const seatMatch = cmd.match(/'openrig-tile' '([^']+)'/);
    panes.push({ workspace_id: workspaceId, tab_id: tabId, pane_id, label, ...(seatMatch?.[1] ? { tmuxSession: seatMatch[1] } : {}) });
    return { ...obj, pane_id };
  }
  return {
    ...obj,
    first: echoAppliedRoot(obj["first"], tabId, panes, workspaceId),
    second: echoAppliedRoot(obj["second"], tabId, panes, workspaceId),
  };
}

type Ws = { workspace_id: string; label: string };
type Tab = { workspace_id: string; tab_id: string; label: string };
type Pane = { workspace_id: string; tab_id: string; pane_id: string; label: string; tmuxSession?: string };

function makeInMemoryHerdr(opts?: {
  alive?: boolean;
  failCreateForLabel?: RegExp;
  omitLayoutTabId?: boolean;
  omitLayoutTabIdOnCall?: number;
  omitLayoutRoot?: boolean;
  failDefaultTabClose?: boolean;
  failPaneListCount?: number;
  reuseLive?: boolean;
  injectPersonPaneInAppliedTabOnPaneList?: boolean;
}) {
  const workspaces: Ws[] = [];
  const tabs: Tab[] = [];
  const panes: Pane[] = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let paneListCalls = 0;
  let layoutApplyCalls = 0;
  let failBareFallback = false;

  const transport: HerdrTransport = {
    probe: async () => opts?.alive === false ? { alive: false, version: null, protocol: null } : { alive: true, version: "0.9.5", protocol: 22 },
    request: async (method, raw): Promise<HerdrResult> => {
      const params = (raw ?? {}) as Record<string, unknown>;
      calls.push({ method, params });
      if (method === "workspace.list") return { type: "workspace_list", workspaces };
      if (method === "workspace.create") {
        const label = String(params["label"] ?? "");
        if (label && opts?.failCreateForLabel?.test(label)) {
          failBareFallback = true;
          throw new Error(`create failed for ${label}`);
        }
        if (!label && failBareFallback) {
          failBareFallback = false;
          throw new Error("fallback create failed");
        }
        failBareFallback = false;
        const workspace_id = `w${workspaces.length + 1}`;
        const defaultTabId = `${workspace_id}:t0`;
        const rootPaneId = `${defaultTabId}-p0`;
        workspaces.push({ workspace_id, label });
        tabs.push({ workspace_id, tab_id: defaultTabId, label: "1" });
        panes.push({ workspace_id, tab_id: defaultTabId, pane_id: rootPaneId, label: "" });
        return {
          type: "workspace_created",
          workspace: { workspace_id },
          tab: { tab_id: defaultTabId },
          root_pane: { pane_id: rootPaneId, tab_id: defaultTabId },
        };
      }
      if (method === "layout.apply") {
        layoutApplyCalls++;
        const workspace_id = String(params["workspace_id"]);
        const nextIdx = tabs.filter(t => t.workspace_id === workspace_id).length;
        const tab_id = `${workspace_id}:t${nextIdx}`;
        tabs.push({ workspace_id, tab_id, label: String(params["tab_label"] ?? "") });
        const rootEcho = echoAppliedRoot(params["root"], tab_id, panes, workspace_id);
        const omitTab = Boolean(opts?.omitLayoutTabId || (opts?.omitLayoutTabIdOnCall && layoutApplyCalls === opts.omitLayoutTabIdOnCall));
        return {
          type: "layout_apply",
          layout: {
            workspace_id,
            ...(omitTab ? {} : { tab_id }),
            ...(opts?.omitLayoutRoot ? {} : { root: rootEcho }),
          },
        };
      }
      if (method === "tab.list") {
        return { type: "tab_list", tabs: tabs.filter(t => t.workspace_id === params["workspace_id"]) };
      }
      if (method === "pane.list") {
        paneListCalls++;
        if (opts?.failPaneListCount && paneListCalls === opts.failPaneListCount) throw new Error("pane.list unavailable");
        if (opts?.injectPersonPaneInAppliedTabOnPaneList && paneListCalls === 1) {
          const wid = String(params["workspace_id"]);
          const appliedTab = tabs.find(t => t.workspace_id === wid && !t.tab_id.endsWith(":t0"));
          if (appliedTab) {
            panes.push({ workspace_id: wid, tab_id: appliedTab.tab_id, pane_id: `${appliedTab.tab_id}-person`, label: "person-shell" });
          }
        }
        return { type: "pane_list", panes: panes.filter(p => p.workspace_id === params["workspace_id"]) };
      }
      if (method === "tab.close") {
        if (opts?.failDefaultTabClose) throw new Error("tab.close denied");
        const tabId = String(params["tab_id"]);
        const idx = tabs.findIndex(t => t.tab_id === tabId);
        if (idx >= 0) tabs.splice(idx, 1);
        for (let i = panes.length - 1; i >= 0; i--) {
          if (panes[i]!.tab_id === tabId) panes.splice(i, 1);
        }
        return { type: "ok" };
      }
      if (method === "tab.focus") {
        const tab = tabs.find(t => t.tab_id === params["tab_id"]);
        return { type: "tab_focused", tab: { tab_id: tab?.tab_id, workspace_id: tab?.workspace_id } };
      }
      if (method === "workspace.close") {
        const workspaceId = String(params["workspace_id"] ?? "");
        const wsIdx = workspaces.findIndex(w => w.workspace_id === workspaceId);
        if (wsIdx === -1) throw new Error(`Unknown workspace: ${workspaceId}`);
        workspaces.splice(wsIdx, 1);
        for (let i = tabs.length - 1; i >= 0; i--) {
          if (tabs[i]!.workspace_id === workspaceId) tabs.splice(i, 1);
        }
        for (let i = panes.length - 1; i >= 0; i--) {
          if (panes[i]!.workspace_id === workspaceId) panes.splice(i, 1);
        }
        return { type: "workspace_closed", workspace_id: workspaceId };
      }
      return { type: "ok" };
    },
  };

  const liveWorkspace = opts?.reuseLive ? {
    herdr: async (args: string[]) => {
      const [noun, verb, , id] = args;
      if (noun === "workspace" && verb === "list") return JSON.stringify({ result: { workspaces } });
      if (noun === "tab" && verb === "list") return JSON.stringify({ result: { tabs: tabs.filter(t => t.workspace_id === id) } });
      if (noun === "pane" && verb === "list") return JSON.stringify({ result: { panes: panes.filter(p => p.workspace_id === id) } });
      if (noun === "pane" && verb === "process-info") return JSON.stringify({ result: { process_info: { pane_id: id, foreground_processes: [{ pid: 901 + panes.findIndex(p => p.pane_id === id) }] } } });
      throw new Error(`unexpected ${args.join(" ")}`);
    },
    exec: async (file: string, args: string[]) => {
      if (file === "/bin/sh" && args[1] === "command -v tmux") return "/usr/bin/tmux\n";
      return panes.flatMap((p, index) => p.tmuxSession ? [`${901 + index}\t${p.tmuxSession}\t0`] : []).join("\n");
    },
  } : undefined;

  const adapter = new HerdrAdapter({
    transportFactory: () => transport,
    launch: { socketPath: "/tmp/herdr-test.sock" },
    newLaunchToken: () => "tok1",
    ...(liveWorkspace ? { liveWorkspace } : {}),
  });

  return { adapter, workspaces, tabs, panes, calls };
}

function makeRigSeat(rigName: string, name: string, overrides: Partial<LiveSeatRow> = {}): LiveSeatRow {
  const session = `${name}@${rigName}`;
  return {
    canonicalSessionName: session,
    attachmentType: "tmux",
    tmuxSession: session,
    rigName,
    logicalId: `pod.${name}`,
    ...overrides,
  };
}

function readRecords(dir: string) {
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  const entries: Record<string, unknown> = {};
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { version: number; entries: Record<string, unknown> };
    Object.assign(entries, parsed.entries);
  }
  return entries;
}

describe("#3081 TerminalService.openAll + rig viewer ownership recording", () => {
  it("CR: preserves pod identity for excluded seats without canonical names", async () => {
    const h = makeInMemoryHerdr();
    const hasSession = vi.fn(() => true);
    const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: n => n === "herdr" ? h.adapter : null,
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha"],
      listRigSeats: rig => [
        makeRigSeat(rig, "live"),
        ...["dev.driver", "qa.driver"].map(logicalId => makeRigSeat(rig, "driver", { logicalId, canonicalSessionName: "", attachmentType: "none" })),
        ...["dev.remote", "qa.remote"].map(logicalId => makeRigSeat(rig, "remote", { logicalId, canonicalSessionName: "", host: "edge" })),
      ],
      listPodSeats: () => null, resolveHost: () => null, hasSession,
      rigViewersDir: tempDir("rig-viewers-"),
    });
    const result = await svc.openAll({});
    expect(result.rigs[0]?.opened).toEqual(["live@alpha"]);
    expect(result.rigs[0]?.absent.map(row => row.seat)).toEqual(["dev.driver@alpha", "qa.driver@alpha"]);
    expect(result.rigs[0]?.skipped.map(row => row.seat)).toEqual(["dev.remote@alpha", "qa.remote@alpha"]);
    expect(hasSession).toHaveBeenCalledExactlyOnceWith("live@alpha");
  });

  it.each(["seat listing", "liveness"])("CR: contains a middle-rig %s failure and preserves earlier and later results", async failure => {
    const h = makeInMemoryHerdr();
    const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: n => n === "herdr" ? h.adapter : null,
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["gamma", "beta", "alpha"],
      listRigSeats: rig => {
        if (rig === "beta" && failure === "seat listing") throw new Error("fixture composition failed");
        return [makeRigSeat(rig, "op")];
      },
      listPodSeats: () => null, resolveHost: () => null,
      hasSession: session => {
        if (session === "op@beta" && failure === "liveness") throw new Error("fixture liveness failed");
        return true;
      },
      rigViewersDir: tempDir("rig-viewers-"),
    });
    const result = await svc.openAll({});
    expect(result.ok).toBe(true);
    expect(result.rigs).toMatchObject([
      { rig: "alpha", outcome: "opened", opened: ["op@alpha"] },
      { rig: "beta", outcome: "failed", opened: [], absent: [], degraded: [], skipped: [] },
      { rig: "gamma", outcome: "opened", opened: ["op@gamma"] },
    ]);
    expect(result.rigs).toHaveLength(3);
    expect(result.rigs[1]?.error).toBe(failure === "seat listing" ? "fixture composition failed" : "fixture liveness failed");
    expect(h.workspaces.map(workspace => workspace.label)).toEqual(["alpha", "gamma"]);
  });

  it("opens rigs in sorted name order including rig:kernel once and never opens 'openrig kernel'", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeInMemoryHerdr();
    const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["beta", "kernel", "alpha"],
      listRigSeats: (rig) => [makeRigSeat(rig, `${rig}-op`)],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    } satisfies TerminalServiceDeps);

    const result = await svc.openAll({});
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("herdr");
    expect(result.rigs.map(r => r.rig)).toEqual(["alpha", "beta", "kernel"]);
    expect(result.rigs.map(r => r.view)).toEqual(["rig:alpha", "rig:beta", "rig:kernel"]);
    expect(result.rigs.every(r => r.outcome === "opened")).toBe(true);
    expect(h.workspaces.map(w => w.label)).toEqual(["alpha", "beta", "kernel"]);
    expect(h.workspaces.some(w => w.label === "openrig kernel")).toBe(false);

    const records = Object.values(readRecords(rigViewersDir)) as Array<{ view: string; workspaceId: string; tabIds: string[]; paneIds: string[]; phase: string }>;
    expect(records.map(r => r.view).sort()).toEqual(["rig:alpha", "rig:beta", "rig:kernel"]);
    expect(records.every(r => r.phase === "created" && r.tabIds.length === 1 && r.paneIds.length === 1)).toBe(true);
  });

  it("partitions stopped/unbound, external_cli, and remote seats before composing without calling hasSession for excluded rows", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeInMemoryHerdr();
    const hasSession = vi.fn((s: string) => s === "alive@mixed");

    const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["all-remote", "all-stopped", "mixed"],
      listRigSeats: (rig) => {
        if (rig === "all-stopped") {
          return [
            makeRigSeat(rig, "unbound", { canonicalSessionName: "", tmuxSession: "" }),
            makeRigSeat(rig, "ext", { attachmentType: "external_cli" }),
          ];
        }
        if (rig === "all-remote") {
          return [makeRigSeat(rig, "remote", { host: "edge-1" })];
        }
        return [
          makeRigSeat(rig, "alive"),
          makeRigSeat(rig, "stopped", { attachmentType: "none", canonicalSessionName: "" }),
          makeRigSeat(rig, "ext", { attachmentType: "external_cli" }),
          makeRigSeat(rig, "remote", { host: "edge-1" }),
        ];
      },
      listPodSeats: () => null,
      resolveHost: (id) => (id === "edge-1" ? { id, transport: "ssh", target: "edge-1.internal" } : null),
      hasSession,
      rigViewersDir,
    } satisfies TerminalServiceDeps);

    const result = await svc.openAll({});
    expect(result.ok).toBe(true);

    expect(result.rigs.find(r => r.rig === "all-stopped")).toMatchObject({
      rig: "all-stopped",
      outcome: "absent",
      opened: [],
      skipped: [],
    });
    expect(result.rigs.find(r => r.rig === "all-stopped")!.absent.map(a => a.seat).sort()).toEqual([
      "ext@all-stopped",
      "pod.unbound@all-stopped",
    ]);

    expect(result.rigs.find(r => r.rig === "all-remote")).toMatchObject({
      rig: "all-remote",
      outcome: "skipped",
      opened: [],
      absent: [],
      skipped: [{ seat: "remote@all-remote", reason: expect.stringMatching(/remote/i) }],
    });

    const mixed = result.rigs.find(r => r.rig === "mixed")!;
    expect(mixed.outcome).toBe("opened");
    expect(mixed.opened).toEqual(["alive@mixed"]);
    expect(mixed.skipped).toEqual([{ seat: "remote@mixed", reason: expect.stringMatching(/remote/i) }]);
    expect(mixed.absent.map(a => a.seat).sort()).toEqual(["ext@mixed", "pod.stopped@mixed"]);

    expect(hasSession).toHaveBeenCalledTimes(1);
    expect(hasSession).toHaveBeenCalledWith("alive@mixed");
    expect(h.workspaces).toHaveLength(1);
    expect(h.panes).toHaveLength(1);
  });

  it("continues past a failing rig and returns ok: true when another rig opened", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeInMemoryHerdr({ failCreateForLabel: /^broken$/ });
    const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["broken", "healthy"],
      listRigSeats: (rig) => [makeRigSeat(rig, `${rig}-op`)],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    } satisfies TerminalServiceDeps);

    const result = await svc.openAll({});
    expect(result.ok).toBe(true);
    expect(result.rigs[0]).toMatchObject({ rig: "broken", outcome: "failed" });
    expect(result.rigs[1]).toMatchObject({ rig: "healthy", outcome: "opened", opened: ["healthy-op@healthy"] });
  });

  it("on reuseLive reuse writes no new record and preserves an existing record", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeInMemoryHerdr({ reuseLive: true });
    const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha"],
      listRigSeats: (rig) => [makeRigSeat(rig, "alpha-op")],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    } satisfies TerminalServiceDeps);

    const first = await svc.openAll({ reuseLive: true });
    expect(first.rigs[0]?.outcome).toBe("opened");
    const before = readRecords(rigViewersDir);
    expect(Object.keys(before)).toHaveLength(1);

    const second = await svc.openAll({ reuseLive: true });
    expect(second.ok).toBe(true);
    expect(second.rigs[0]).toMatchObject({ rig: "alpha", outcome: "reused", workspaceId: "w1", opened: [] });
    const after = readRecords(rigViewersDir);
    expect(after).toEqual(before);
  });

  it("refuses herdr-app, cmux, and rex with unsupported_provider and never falls back from herdr to cmux", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const cmuxOpen = vi.fn(async (): Promise<OpenViewResult> => ({ provider: "cmux", ok: true, opened: ["x"], absent: [], degraded: [], pages: 1 }));
    const cmux: TerminalProvider = {
      name: "cmux",
      status: async () => ({ provider: "cmux", available: true, capabilities: {} }),
      liveness: async () => ({ alive: true }),
      openView: cmuxOpen,
    };
    const hDown = makeInMemoryHerdr({ alive: false });
    const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => n === "herdr" ? hDown.adapter : n === "cmux" ? cmux : null,
      resolveHerdrAppProvider: () => ({ ...cmux, name: "herdr-app", appHome: "/tmp/app", closeView: async () => ({ provider: "herdr-app", ok: true, opened: [], absent: [], degraded: [], pages: 0 }) }),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha"],
      listRigSeats: (rig) => [makeRigSeat(rig, "op")],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    } satisfies TerminalServiceDeps);

    for (const provider of ["herdr-app", "cmux", "rex"]) {
      const res = await svc.openAll({ provider });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("unsupported_provider");
    }
    expect(cmuxOpen).not.toHaveBeenCalled();

    const omitted = await svc.openAll({});
    expect(omitted.ok).toBe(false);
    expect(omitted.provider).toBe("herdr");
    expect(cmuxOpen).not.toHaveBeenCalled();
  });

  it.each(([
    ["missing page tab id", { omitLayoutTabIdOnCall: 2 }, 17],
    ["missing layout root echo", { omitLayoutRoot: true }, 1],
    ["unclosed default tab", { failDefaultTabClose: true }, 1],
    ["pane.list readback fails", { failPaneListCount: 2 }, 17],
  ] as const).flatMap(([label, mode, seatCount]) => (["single", "bulk"] as const).map(open => [label, mode, seatCount, open] as const)))("does not write a close record and notes incomplete identity when %s (%s seats, %s, %s)", async (_label, mode, seatCount, open) => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeInMemoryHerdr(mode);
    const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha"],
      listRigSeats: (rig) => Array.from({ length: seatCount }, (_, idx) => makeRigSeat(rig, `op${idx + 1}`)),
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    } satisfies TerminalServiceDeps);

    const res = open === "bulk" ? await svc.openAll({}) : await svc.openView({ view: "rig:alpha", provider: "herdr" });
    expect(res.ok).toBe(true);
    const notes = "rigs" in res ? res.rigs[0]?.notes : res.notes;
    expect(notes?.join("\n")).toMatch(/not recorded for close/i);
    expect(Object.keys(readRecords(rigViewersDir))).toHaveLength(0);
  });

  it("writes a record for single-rig rig:<name> / bare <name> opens, never for saved/pod/seat/saved:rig:/default saved:kernel views (T4/J05)", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeInMemoryHerdr();
    const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: {
        get: (id) => {
          if (id === "watchtower") return { id: "watchtower", name: "Watchtower", members: [{ seat: "op@alpha", tmuxSession: "op@alpha" }] };
          if (id === "rig:example") return { id: "rig:example", name: "Saved Rig Collision", members: [{ seat: "op@alpha", tmuxSession: "op@alpha" }] };
          return null;
        },
        list: () => [],
      },
      listRigNames: () => ["alpha", "kernel"],
      listRigSeats: (rig) => rig === "alpha"
        ? [makeRigSeat("alpha", "op")]
        : rig === "kernel"
          ? [{ canonicalSessionName: "kernel-op", attachmentType: "tmux", tmuxSession: "kernel-op", rigName: "kernel", logicalId: "operator.agent" }]
          : null,
      listPodSeats: (rig, pod) => rig === "alpha" && pod === "pod" ? [makeRigSeat("alpha", "op")] : null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    } satisfies TerminalServiceDeps);

    const watchtower = await svc.openView({ view: "watchtower", provider: "herdr" });
    expect(watchtower.ok).toBe(true);
    const savedRig = await svc.openView({ view: "saved:rig:example", provider: "herdr" });
    expect(savedRig.ok).toBe(true);
    const savedKernel = await svc.openView({ view: "saved:kernel", provider: "herdr" });
    expect(savedKernel.ok).toBe(true);
    expect(savedKernel.opened).toEqual(["kernel-op"]);
    await svc.openView({ view: "pod:alpha/pod", provider: "herdr" });
    await svc.openView({ view: "seat:alpha/pod.op", provider: "herdr" });
    expect(Object.keys(readRecords(rigViewersDir))).toHaveLength(0);

    await svc.openView({ view: "alpha", provider: "herdr" });
    const afterRig = Object.values(readRecords(rigViewersDir)) as Array<{ view: string }>;
    expect(afterRig.map(r => r.view)).toEqual(["rig:alpha"]);

    // Closing must only close rig:alpha, never saved:rig:example or saved:kernel:
    const closed = await svc.closeAll({ provider: "herdr" });
    expect(closed.viewers.map(v => ({ view: v.view, outcome: v.outcome }))).toEqual([{ view: "rig:alpha", outcome: "kept" }]);
    expect(h.calls.some(c => c.method === "workspace.close")).toBe(false);
    expect(h.workspaces).toHaveLength(6);
  });

  it("J02: rejects creation ownership when an unexplained person pane appears in the applied tab between layout.apply and pane.list", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeInMemoryHerdr({ injectPersonPaneInAppliedTabOnPaneList: true });
    const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha"],
      listRigSeats: (rig) => [makeRigSeat(rig, "op")],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    } satisfies TerminalServiceDeps);

    const res = await svc.openAll({ provider: "herdr" });
    expect(res.ok).toBe(true);
    expect(res.rigs[0]?.notes?.join("\n")).toMatch(/not recorded for close/i);
    expect(Object.keys(readRecords(rigViewersDir))).toHaveLength(0);
    expect(h.panes.some(p => p.pane_id.endsWith("-person"))).toBe(true);

    const closed = await svc.closeAll({ provider: "herdr" });
    expect(closed.viewers).toEqual([]);
    expect(h.workspaces).toHaveLength(1);
    expect(h.panes.some(p => p.pane_id.endsWith("-person"))).toBe(true);
  });

  it("J09: reuses a live workspace across single open and open --all in both directions even with stopped/unbound/external seats", async () => {
    const seats = [
      makeRigSeat("alpha", "alpha-op"),
      makeRigSeat("alpha", "stopped", { attachmentType: "none", canonicalSessionName: "" }),
      makeRigSeat("alpha", "ext", { attachmentType: "external_cli" }),
    ];

    // Direction 1: single open -> bulk open --all reuses existing workspace
    const dir1 = tempDir("rig-viewers-");
    const h1 = makeInMemoryHerdr({ reuseLive: true });
    const svc1 = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => (n === "herdr" ? h1.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha"],
      listRigSeats: () => seats,
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir: dir1,
    } satisfies TerminalServiceDeps);

    const singleFirst = await svc1.openView({ view: "rig:alpha", provider: "herdr", reuseLive: true });
    expect(singleFirst.ok).toBe(true);
    expect(h1.workspaces).toHaveLength(1);
    const bulkSecond = await svc1.openAll({ provider: "herdr", reuseLive: true });
    expect(bulkSecond.ok).toBe(true);
    expect(bulkSecond.rigs[0]).toMatchObject({ rig: "alpha", outcome: "reused", workspaceId: "w1" });
    expect(h1.workspaces).toHaveLength(1);

    // Direction 2: bulk open --all -> single open reuses existing workspace
    const dir2 = tempDir("rig-viewers-");
    const h2 = makeInMemoryHerdr({ reuseLive: true });
    const svc2 = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => (n === "herdr" ? h2.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha"],
      listRigSeats: () => seats,
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir: dir2,
    } satisfies TerminalServiceDeps);

    const bulkFirst = await svc2.openAll({ provider: "herdr", reuseLive: true });
    expect(bulkFirst.rigs[0]?.outcome).toBe("opened");
    expect(h2.workspaces).toHaveLength(1);
    const singleSecond = await svc2.openView({ view: "rig:alpha", provider: "herdr", reuseLive: true });
    expect(singleSecond.ok).toBe(true);
    expect(singleSecond.reusedWorkspace?.id).toBe("w1");
    expect(h2.workspaces).toHaveLength(1);
  });

  it("J10: keeps successful open result and attaches not-recorded warning when journal upsert fails in both single and bulk opens", async () => {
    const parent = tempDir("rig-viewers-parent-");
    const blockedDir = path.join(parent, "not-a-dir");
    writeFileSync(blockedDir, "file-blocks-mkdir\n");

    const h = makeInMemoryHerdr();
    const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha", "beta"],
      listRigSeats: (rig) => [makeRigSeat(rig, "op")],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir: blockedDir,
    } satisfies TerminalServiceDeps);

    const single = await svc.openView({ view: "rig:alpha", provider: "herdr" });
    expect(single.ok).toBe(true);
    expect(single.opened).toEqual(["op@alpha"]);
    expect(single.notes?.join("\n")).toMatch(/not recorded for close/i);
    expect(h.workspaces).toHaveLength(1);
    expect(h.calls.some(c => c.method === "workspace.close")).toBe(false);

    const bulk = await svc.openAll({ provider: "herdr" });
    expect(bulk.ok).toBe(true);
    expect(bulk.rigs.map(r => r.outcome)).toEqual(["opened", "opened"]);
    expect(bulk.rigs.every(r => r.notes?.some(n => /not recorded for close/i.test(n)))).toBe(true);
    expect(h.workspaces).toHaveLength(3);
    expect(h.calls.some(c => c.method === "workspace.close")).toBe(false);
  });

  it("T5: openAll returns ok: false when every rig fails", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeInMemoryHerdr({ failCreateForLabel: /.*/ });
    const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha", "beta"],
      listRigSeats: (rig) => [makeRigSeat(rig, "op")],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    } satisfies TerminalServiceDeps);

    const res = await svc.openAll({ provider: "herdr" });
    expect(res.ok).toBe(false);
    expect(res.rigs.map(r => r.outcome)).toEqual(["failed", "failed"]);
  });
});

it("opens the live rig by stable ID when a stopped rig has the same display name", async () => {
  const h = makeInMemoryHerdr();
  const listRigSeats = vi.fn((id: string) => id === "live-id" ? [makeRigSeat("alpha", "op")] : []);
  const svc = new TerminalService({
      ...privateTerminalTmuxDeps(),
    resolveProvider: () => h.adapter, viewsStore: { get: () => null, list: () => [] },
    listRigNames: () => ["alpha", "alpha"],
    listRigs: () => [{ id: "stopped-id", name: "alpha" }, { id: "live-id", name: "alpha" }],
    listRigSeats, listPodSeats: () => null, hasSession: () => true, resolveHost: () => null,
  });
  const result = await svc.openAll({ provider: "herdr" });
  expect(result.rigs).toHaveLength(2);
  expect(result.rigs.find(r => r.rigId === "live-id")).toMatchObject({ rig: "alpha", view: "rig:live-id", outcome: "opened" });
  expect(result.rigs.find(r => r.rigId === "stopped-id")).toMatchObject({ rig: "alpha", view: "rig:stopped-id", outcome: "absent" });
  expect(listRigSeats.mock.calls.map(([id]) => id).sort()).toEqual(["live-id", "stopped-id"]);
  expect(h.workspaces.map(workspace => workspace.label)).toEqual(["alpha"]);
  const views = await svc.listViews(true);
  expect(views.rigs).toEqual(["alpha", "alpha"]);
  expect(views.rigIdentities).toHaveLength(2);
  expect(views.catalog?.filter(entry => entry.kind === "derived").map(entry => entry.view).sort()).toEqual(["rig:live-id", "rig:stopped-id"]);
});

it.each(["alpha", "rig:alpha", "rig:live-id"])("combined canonical identity reuses %s and bulk opens in both directions", async alias => {
  for (const singleFirst of [true, false]) {
    const h = makeInMemoryHerdr({ reuseLive: true });
    const dir = tempDir("canonical-reuse-");
    const svc = new TerminalService({ ...privateTerminalTmuxDeps(),
      resolveProvider: () => h.adapter, viewsStore: { get: () => null, list: () => [] },
      listRigs: () => [{ id: "live-id", name: "alpha" }], listRigNames: () => ["alpha"],
      listRigSeats: key => key === "live-id" || key === "alpha" ? [makeRigSeat("alpha", "op")] : null,
      listPodSeats: () => null, hasSession: () => true, resolveHost: () => null, rigViewersDir: dir,
    });
    const single = () => svc.openView({ view: alias, provider: "herdr", reuseLive: true });
    const bulk = () => svc.openAll({ provider: "herdr", reuseLive: true });
    const first = await (singleFirst ? single() : bulk());
    expect(first.ok).toBe(true);
    const records = readRecords(dir);
    const effects = h.calls.filter(call => call.method === "layout.apply").length;
    const next = await (singleFirst ? bulk() : single());
    expect(next.ok).toBe(true);
    if ("rigs" in next) expect(next.rigs[0]).toMatchObject({ rigId: "live-id", rig: "alpha", outcome: "reused" });
    else expect(next.reusedWorkspace?.id).toBe("w1");
    expect(h.workspaces.map(workspace => workspace.label)).toEqual(["alpha"]);
    expect(h.tabs.some(tab => tab.label.startsWith("openrig:rig:live-id#"))).toBe(true);
    expect(h.calls.filter(call => call.method === "layout.apply")).toHaveLength(effects);
    expect(h.calls.some(call => call.method === "workspace.close")).toBe(false);
    expect(readRecords(dir)).toEqual(records);
    const byName = await svc.previewView({ view: alias, provider: "herdr", bulk: true });
    const byId = await svc.previewView({ view: "rig:live-id", provider: "herdr", bulk: true });
    expect((byName as any).planId).toBe((byId as any).planId);
  }
});

it.each([true, false])("combined same-name live rigs retain separate reuse identities, shared attachments=%s", async shared => {
  const h = makeInMemoryHerdr({ reuseLive: true });
  const svc = new TerminalService({ ...privateTerminalTmuxDeps(), resolveProvider: () => h.adapter,
    viewsStore: { get: () => null, list: () => [] }, listRigNames: () => ["alpha", "alpha"],
    listRigs: () => [{ id: "first-id", name: "alpha" }, { id: "second-id", name: "alpha" }],
    listRigSeats: id => [makeRigSeat("alpha", shared ? "same" : id)], listPodSeats: () => null,
    hasSession: () => true, resolveHost: () => null,
  });
  const first = await svc.openAll({ provider: "herdr", reuseLive: true });
  expect(first.rigs.map(row => row.outcome)).toEqual(["opened", "opened"]);
  expect(h.workspaces.map(workspace => workspace.label)).toEqual(["alpha", "alpha (2)"]);
  const second = await svc.openAll({ provider: "herdr", reuseLive: true });
  expect(second.rigs.map(row => row.outcome)).toEqual(["reused", "reused"]);
  expect(h.workspaces).toHaveLength(2);
  expect(h.calls.filter(call => call.method === "workspace.close")).toEqual([]);
});

// Open all opens what's absent and focuses what's there, whoever calls it: a repeat without reuseLive adds no view and no
// tile (each tile is one more tmux client of its seat). An explicit reuseLive: false still opens a copy.
it.each([
  [undefined, ["reused"], 1],
  [false, ["opened"], 2],
] as const)("open all with reuseLive=%s reuses a live workspace by default", async (reuseLive, outcomes, workspaces) => {
  const h = makeInMemoryHerdr({ reuseLive: true });
  const svc = new TerminalService({ ...privateTerminalTmuxDeps(), resolveProvider: () => h.adapter,
    viewsStore: { get: () => null, list: () => [] }, listRigNames: () => ["alpha"],
    listRigs: () => [{ id: "alpha-id", name: "alpha" }],
    listRigSeats: () => [makeRigSeat("alpha", "lead"), makeRigSeat("alpha", "impl")], listPodSeats: () => null,
    hasSession: () => true, resolveHost: () => null,
  });
  const first = await svc.openAll({ provider: "herdr" });
  expect(first.rigs.map(row => row.outcome)).toEqual(["opened"]);
  const tiles = h.panes.length;
  const second = await svc.openAll({ provider: "herdr", ...(reuseLive === undefined ? {} : { reuseLive }) });
  expect(second.rigs.map(row => row.outcome)).toEqual(outcomes);
  expect(h.workspaces).toHaveLength(workspaces);
  expect(h.panes).toHaveLength(tiles * workspaces);
});

it("combined exact ID wins over another rig name and complete ownership has no incomplete warning", async () => {
  const h = makeInMemoryHerdr();
  const seats = vi.fn((id: string) => [makeRigSeat(id === "collision" ? "wanted" : "collision", "op")]);
  const svc = new TerminalService({ ...privateTerminalTmuxDeps(), resolveProvider: () => h.adapter,
    viewsStore: { get: () => null, list: () => [] }, listRigNames: () => ["collision", "wanted"],
    listRigs: () => [{ id: "other", name: "collision" }, { id: "collision", name: "wanted" }],
    listRigSeats: seats, listPodSeats: () => null, hasSession: () => true, resolveHost: () => null,
  });
  const result = await svc.openView({ view: "rig:collision", provider: "herdr" });
  expect(result.ok).toBe(true);
  expect(seats).toHaveBeenCalledWith("collision");
  expect(h.workspaces.map(workspace => workspace.label)).toEqual(["wanted"]);
  expect(result.notes?.some(note => note.includes("could not be confirmed completely"))).toBe(false);
});
