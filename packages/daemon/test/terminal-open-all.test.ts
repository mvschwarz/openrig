import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrAdapter } from "../src/domain/terminal/herdr-adapter.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import type { HerdrResult, HerdrTransport } from "../src/domain/terminal/herdr-transport.js";
import type { OpenViewResult, TerminalProvider } from "../src/domain/terminal/terminal-provider.js";
import type { LiveSeatRow } from "../src/domain/terminal/terminal-views-store.js";

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

type Ws = { workspace_id: string; label: string };
type Tab = { workspace_id: string; tab_id: string; label: string };
type Pane = { workspace_id: string; tab_id: string; pane_id: string; label: string };

function makeInMemoryHerdr(opts?: {
  alive?: boolean;
  failCreateForLabel?: RegExp;
  omitLayoutTabId?: boolean;
  omitLayoutTabIdOnCall?: number;
  failDefaultTabClose?: boolean;
  failPaneListCount?: number;
  reuseLive?: boolean;
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
        workspaces.push({ workspace_id, label });
        tabs.push({ workspace_id, tab_id: `${workspace_id}:t0`, label: "1" });
        return { type: "workspace_created", workspace: { workspace_id }, tab: { tab_id: `${workspace_id}:t0` } };
      }
      if (method === "layout.apply") {
        layoutApplyCalls++;
        const workspace_id = String(params["workspace_id"]);
        const nextIdx = tabs.filter(t => t.workspace_id === workspace_id).length;
        const tab_id = `${workspace_id}:t${nextIdx}`;
        tabs.push({ workspace_id, tab_id, label: String(params["tab_label"] ?? "") });
        for (const label of leafLabels(params["root"])) {
          panes.push({ workspace_id, tab_id, pane_id: `${tab_id}-p${panes.length + 1}`, label });
        }
        const omitTab = Boolean(opts?.omitLayoutTabId || (opts?.omitLayoutTabIdOnCall && layoutApplyCalls === opts.omitLayoutTabIdOnCall));
        return { type: "layout_apply", layout: { workspace_id, ...(omitTab ? {} : { tab_id }) } };
      }
      if (method === "pane.list") {
        paneListCalls++;
        if (opts?.failPaneListCount && paneListCalls === opts.failPaneListCount) throw new Error("pane.list unavailable");
        return { type: "pane_list", panes: panes.filter(p => p.workspace_id === params["workspace_id"]) };
      }
      if (method === "tab.close") {
        if (opts?.failDefaultTabClose) throw new Error("tab.close denied");
        const idx = tabs.findIndex(t => t.tab_id === params["tab_id"]);
        if (idx >= 0) tabs.splice(idx, 1);
        return { type: "ok" };
      }
      if (method === "tab.focus") {
        const tab = tabs.find(t => t.tab_id === params["tab_id"]);
        return { type: "tab_focused", tab: { tab_id: tab?.tab_id, workspace_id: tab?.workspace_id } };
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
      if (noun === "pane" && verb === "process-info") return JSON.stringify({ result: { process_info: { pane_id: id, foreground_processes: [{ pid: 901 }] } } });
      throw new Error(`unexpected ${args.join(" ")}`);
    },
    exec: async (file: string, args: string[]) => {
      if (file === "/bin/sh" && args[1] === "command -v tmux") return "/usr/bin/tmux\n";
      return panes.map((p) => {
        const seatLabel = p.label.split(" ")[0] ?? p.label;
        const seat = seatLabel.replace(/^pod\./, "");
        const rig = seat.split("-")[0] ?? "alpha";
        return `901\t${seat}@${rig}\t0`;
      }).join("\n");
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
  it("opens rigs in sorted name order including rig:kernel once and never opens 'openrig kernel'", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeInMemoryHerdr();
    const svc = new TerminalService({
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
      "unbound@all-stopped",
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
    expect(mixed.absent.map(a => a.seat).sort()).toEqual(["ext@mixed", "stopped@mixed"]);

    expect(hasSession).toHaveBeenCalledTimes(1);
    expect(hasSession).toHaveBeenCalledWith("alive@mixed");
    expect(h.workspaces).toHaveLength(1);
    expect(h.panes).toHaveLength(1);
  });

  it("continues past a failing rig and returns ok: true when another rig opened", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeInMemoryHerdr({ failCreateForLabel: /^broken$/ });
    const svc = new TerminalService({
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

  it.each([
    ["missing page tab id", { omitLayoutTabIdOnCall: 2 }, 17],
    ["unclosed default tab", { failDefaultTabClose: true }, 1],
    ["pane.list readback fails", { failPaneListCount: 2 }, 17],
  ] as const)("does not write a close record and notes incomplete identity when %s", async (_label, mode, seatCount) => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeInMemoryHerdr(mode);
    const svc = new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha"],
      listRigSeats: (rig) => Array.from({ length: seatCount }, (_, idx) => makeRigSeat(rig, `op${idx + 1}`)),
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    } satisfies TerminalServiceDeps);

    const res = await svc.openAll({});
    expect(res.ok).toBe(true);
    expect(res.rigs[0]?.notes?.join("\n")).toMatch(/not recorded for close/i);
    expect(Object.keys(readRecords(rigViewersDir))).toHaveLength(0);
  });

  it("writes a record for single-rig rig:<name> / bare <name> opens, never for saved/pod/seat/saved:kernel views", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeInMemoryHerdr();
    const svc = new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: {
        get: (id) => id === "watchtower" ? { id: "watchtower", name: "Watchtower", members: [{ seat: "op@alpha", tmuxSession: "op@alpha" }] } : null,
        list: () => [],
      },
      listRigNames: () => ["alpha", "kernel"],
      listRigSeats: (rig) => rig === "alpha" ? [makeRigSeat("alpha", "op")] : rig === "kernel" ? [makeRigSeat("kernel", "operator")] : null,
      listPodSeats: (rig, pod) => rig === "alpha" && pod === "pod" ? [makeRigSeat("alpha", "op")] : null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    } satisfies TerminalServiceDeps);

    await svc.openView({ view: "watchtower", provider: "herdr" });
    await svc.openView({ view: "saved:kernel", provider: "herdr" });
    await svc.openView({ view: "pod:alpha/pod", provider: "herdr" });
    await svc.openView({ view: "seat:alpha/pod.op", provider: "herdr" });
    expect(Object.keys(readRecords(rigViewersDir))).toHaveLength(0);

    await svc.openView({ view: "alpha", provider: "herdr" });
    const afterRig = Object.values(readRecords(rigViewersDir)) as Array<{ view: string }>;
    expect(afterRig.map(r => r.view)).toEqual(["rig:alpha"]);
  });
});
