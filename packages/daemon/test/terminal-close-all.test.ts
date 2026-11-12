import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrAdapter } from "../src/domain/terminal/herdr-adapter.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import type { HerdrResult, HerdrTransport } from "../src/domain/terminal/herdr-transport.js";
import type { LiveSeatRow } from "../src/domain/terminal/terminal-views-store.js";

const dirs: string[] = [];
const sockets: string[] = [];
const tmuxEnv = { ...process.env };
delete tmuxEnv["TMUX"];

function runTmux(socket: string, args: string[]): string {
  return execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    env: tmuxEnv,
    timeout: 5000,
  });
}

afterEach(() => {
  for (const s of sockets.splice(0)) {
    try { runTmux(s, ["kill-server"]); } catch { /* Already closed. */ }
  }
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

function makeCloseHerdr() {
  const workspaces: Array<{ workspace_id: string; label: string }> = [];
  const tabs: Array<{ workspace_id: string; tab_id: string; label: string }> = [];
  const panes: Array<{ workspace_id: string; tab_id: string; pane_id: string; label: string }> = [];
  const closedWorkspaces: string[] = [];
  let keepAfterClose = false;
  let failList = false;

  const transport: HerdrTransport = {
    probe: async () => ({ alive: !failList, version: failList ? null : "0.9.5", protocol: failList ? null : 22 }),
    request: async (method, raw): Promise<HerdrResult> => {
      const params = (raw ?? {}) as Record<string, unknown>;
      if (failList && (method === "workspace.list" || method === "tab.list" || method === "pane.list")) {
        throw new Error("socket disconnected");
      }
      if (method === "workspace.list") return { type: "workspace_list", workspaces };
      if (method === "workspace.create") {
        const workspace_id = `w${workspaces.length + 1}`;
        workspaces.push({ workspace_id, label: String(params["label"] ?? "") });
        tabs.push({ workspace_id, tab_id: `${workspace_id}:t0`, label: "1" });
        return { type: "workspace_created", workspace: { workspace_id }, tab: { tab_id: `${workspace_id}:t0` } };
      }
      if (method === "layout.apply") {
        const workspace_id = String(params["workspace_id"]);
        const tab_id = `${workspace_id}:t${tabs.filter(t => t.workspace_id === workspace_id).length}`;
        tabs.push({ workspace_id, tab_id, label: String(params["tab_label"] ?? "") });
        for (const label of leafLabels(params["root"])) {
          panes.push({ workspace_id, tab_id, pane_id: `${tab_id}-p${panes.length + 1}`, label });
        }
        return { type: "layout_apply", layout: { workspace_id, tab_id } };
      }
      if (method === "tab.list") {
        return { type: "tab_list", tabs: tabs.filter(t => t.workspace_id === params["workspace_id"]) };
      }
      if (method === "pane.list") {
        return { type: "pane_list", panes: panes.filter(p => p.workspace_id === params["workspace_id"]) };
      }
      if (method === "tab.close") {
        const idx = tabs.findIndex(t => t.tab_id === params["tab_id"]);
        if (idx >= 0) tabs.splice(idx, 1);
        return { type: "ok" };
      }
      if (method === "tab.focus") {
        const tab = tabs.find(t => t.tab_id === params["tab_id"]);
        return { type: "tab_focused", tab: { tab_id: tab?.tab_id, workspace_id: tab?.workspace_id } };
      }
      if (method === "workspace.close") {
        const id = String(params["workspace_id"]);
        closedWorkspaces.push(id);
        if (!keepAfterClose) {
          const wIdx = workspaces.findIndex(w => w.workspace_id === id);
          if (wIdx >= 0) workspaces.splice(wIdx, 1);
          for (let i = tabs.length - 1; i >= 0; i--) if (tabs[i]!.workspace_id === id) tabs.splice(i, 1);
          for (let i = panes.length - 1; i >= 0; i--) if (panes[i]!.workspace_id === id) panes.splice(i, 1);
        }
        return { type: "ok" };
      }
      return { type: "ok" };
    },
  };

  const adapter = new HerdrAdapter({
    transportFactory: () => transport,
    launch: { socketPath: "/tmp/herdr-close.sock" },
    newLaunchToken: () => "c1",
  });

  return {
    adapter,
    workspaces,
    tabs,
    panes,
    closedWorkspaces,
    setKeepAfterClose: (v: boolean) => { keepAfterClose = v; },
    setFailList: (v: boolean) => { failList = v; },
  };
}

function seat(rig: string, name: string): LiveSeatRow {
  return { canonicalSessionName: `${name}@${rig}`, attachmentType: "tmux", tmuxSession: `${name}@${rig}`, rigName: rig, logicalId: `pod.${name}` };
}

function readRecords(dir: string) {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const f of readdirSync(dir).filter(name => name.endsWith(".json"))) {
    const parsed = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { entries: Record<string, Record<string, unknown>> };
    Object.assign(entries, parsed.entries);
  }
  return entries;
}

describe("#3081 TerminalService.closeAll (Herdr + isolated tmux)", () => {
  it("returns ok with no-op note when no rig viewers are recorded", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeCloseHerdr();
    const svc = new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => [],
      listRigSeats: () => null,
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    });
    const res = await svc.closeAll({});
    expect(res).toMatchObject({ ok: true, viewers: [] });
    expect(res.notes?.some(n => /no OpenRig rig viewers recorded/i.test(n))).toBe(true);
    expect(h.closedWorkspaces).toEqual([]);
  });

  it("closes only recorded intact Herdr rig viewers, leaves unrecorded/saved/kernel spaces untouched, and removes records", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeCloseHerdr();
    // Seed unrecorded workspaces of various kinds:
    h.workspaces.push(
      { workspace_id: "unrec-rig", label: "openrig:rig:ghost" },
      { workspace_id: "unrec-saved", label: "watchtower" },
      { workspace_id: "unrec-qitem", label: "qitem-abc" },
      { workspace_id: "unrec-kernel", label: "openrig kernel" },
    );
    h.tabs.push(
      { workspace_id: "unrec-rig", tab_id: "ur:t1", label: "openrig:rig:ghost#deadbeef" },
      { workspace_id: "unrec-saved", tab_id: "us:t1", label: "watchtower" },
      { workspace_id: "unrec-qitem", tab_id: "uq:t1", label: "openrig:qitem:1#abc" },
      { workspace_id: "unrec-kernel", tab_id: "uk:t1", label: "kernel" },
    );

    const svc = new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha", "beta"],
      listRigSeats: (rig) => [seat(rig, "op")],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    });

    const opened = await svc.openAll({});
    expect(opened.ok).toBe(true);
    const wAlpha = opened.rigs.find(r => r.rig === "alpha")!.workspaceId!;
    const wBeta = opened.rigs.find(r => r.rig === "beta")!.workspaceId!;

    const closed = await svc.closeAll({});
    expect(closed.ok).toBe(true);
    expect(closed.viewers.map(v => v.outcome)).toEqual(["closed", "closed"]);
    expect(h.closedWorkspaces).toEqual([wAlpha, wBeta]);
    expect(h.workspaces.map(w => w.workspace_id)).toEqual(["unrec-rig", "unrec-saved", "unrec-qitem", "unrec-kernel"]);
    expect(Object.keys(readRecords(rigViewersDir))).toHaveLength(0);
  });

  it("handles pending close: keeps record as closing, then reports already_gone if absent next time or closed if present and closed", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeCloseHerdr();
    const svc = new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha"],
      listRigSeats: (rig) => [seat(rig, "op")],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    });

    const openRes = await svc.openAll({});
    const wId = openRes.rigs[0]!.workspaceId!;

    // 1. Keep workspace alive after close -> close_pending + phase closing
    h.setKeepAfterClose(true);
    const firstClose = await svc.closeAll({});
    expect(firstClose.ok).toBe(false);
    expect(firstClose.viewers).toEqual([
      expect.objectContaining({ view: "rig:alpha", provider: "herdr", target: wId, outcome: "failed", code: "close_pending" }),
    ]);
    const midRecords = Object.values(readRecords(rigViewersDir));
    expect(midRecords[0]?.["phase"]).toBe("closing");

    // 2. Now allow removal and try closing while still present -> witnessed closed!
    h.setKeepAfterClose(false);
    const secondClose = await svc.closeAll({});
    expect(secondClose.ok).toBe(true);
    expect(secondClose.viewers[0]).toMatchObject({ view: "rig:alpha", target: wId, outcome: "closed" });
    expect(Object.keys(readRecords(rigViewersDir))).toHaveLength(0);

    // 3. Reopen, get close_pending, then workspace disappears externally -> next closeAll MUST report already_gone with zero close calls!
    await svc.openAll({});
    const wId2 = h.workspaces[0]!.workspace_id;
    h.setKeepAfterClose(true);
    const pendingAgain = await svc.closeAll({});
    expect(pendingAgain.viewers[0]?.code).toBe("close_pending");
    h.closedWorkspaces.length = 0;

    // External disappearance:
    h.workspaces.length = 0;
    h.tabs.length = 0;
    h.panes.length = 0;
    const afterDisappear = await svc.closeAll({});
    expect(afterDisappear.ok).toBe(true);
    expect(afterDisappear.viewers[0]).toMatchObject({ view: "rig:alpha", target: wId2, outcome: "already_gone" });
    expect(h.closedWorkspaces).toEqual([]);
    expect(Object.keys(readRecords(rigViewersDir))).toHaveLength(0);
  });

  it("keeps a recorded Herdr workspace whole on foreign tab/pane and marks stale reused-id records already_gone", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeCloseHerdr();
    const svc = new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha", "beta"],
      listRigSeats: (rig) => [seat(rig, "op")],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    });

    const opened = await svc.openAll({});
    const wAlpha = opened.rigs.find(r => r.rig === "alpha")!.workspaceId!;
    const wBeta = opened.rigs.find(r => r.rig === "beta")!.workspaceId!;

    // Person added a tab inside alpha's workspace:
    h.tabs.push({ workspace_id: wAlpha, tab_id: `${wAlpha}:person-tab`, label: "notes" });

    // Beta's workspace was closed externally and a brand new workspace reused wBeta id with new tab/pane ids:
    for (let i = h.tabs.length - 1; i >= 0; i--) if (h.tabs[i]!.workspace_id === wBeta) h.tabs.splice(i, 1);
    for (let i = h.panes.length - 1; i >= 0; i--) if (h.panes[i]!.workspace_id === wBeta) h.panes.splice(i, 1);
    h.tabs.push({ workspace_id: wBeta, tab_id: "new-tab-99", label: "unrelated" });
    h.panes.push({ workspace_id: wBeta, tab_id: "new-tab-99", pane_id: "new-pane-99", label: "unrelated" });

    const res = await svc.closeAll({});
    expect(res.ok).toBe(true);
    expect(res.viewers.find(v => v.view === "rig:alpha")?.outcome).toBe("kept");
    expect(res.viewers.find(v => v.view === "rig:beta")?.outcome).toBe("already_gone");
    expect(h.closedWorkspaces).toEqual([]);
    expect(h.workspaces.map(w => w.workspace_id)).toEqual([wAlpha, wBeta]);
  });

  it("keeps all records on provider_unreachable when Herdr inventory fails", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const h = makeCloseHerdr();
    const svc = new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha"],
      listRigSeats: (rig) => [seat(rig, "op")],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    });
    await svc.openAll({});
    h.setFailList(true);
    const res = await svc.closeAll({});
    expect(res.ok).toBe(false);
    expect(res.viewers[0]).toMatchObject({ view: "rig:alpha", outcome: "failed", code: "provider_unreachable" });
    expect(Object.keys(readRecords(rigViewersDir))).toHaveLength(1);
  });

  it("closes matching plain-tmux rig viewer sessions on the isolated tmux server, keeps tampered/foreign ones, and leaves source seats untouched", async () => {
    const rigViewersDir = tempDir("rig-viewers-");
    const socket = `close-all-${randomUUID().slice(0, 10)}`;
    sockets.push(socket);

    // Source seat session must never be touched:
    runTmux(socket, ["new-session", "-d", "-s", "op@alpha", "sleep 60"]);
    const sourcePaneBefore = runTmux(socket, ["list-panes", "-t", "=op@alpha", "-F", "#{pane_id}|#{pane_pid}"]).trim();

    // Unowned openrig-view-* session without record or nonce:
    runTmux(socket, ["new-session", "-d", "-s", "openrig-view-legacy", "sleep 60"]);

    // Recorded intact viewer 1:
    const v1Out = runTmux(socket, ["new-session", "-d", "-s", "openrig-view-v1", "-P", "-F", "#{session_id}|#{window_id}|#{pane_id}", "sleep 60"]).trim();
    const [s1Id, w1Id, p1Id] = v1Out.split("|");
    runTmux(socket, ["set-option", "-t", s1Id!, "@openrig_rig_viewer", "nonce-1"]);

    // Recorded viewer 2 that later gets a person-added window (must be kept):
    const v2Out = runTmux(socket, ["new-session", "-d", "-s", "openrig-view-v2", "-P", "-F", "#{session_id}|#{window_id}|#{pane_id}", "sleep 60"]).trim();
    const [s2Id, w2Id, p2Id] = v2Out.split("|");
    runTmux(socket, ["set-option", "-t", s2Id!, "@openrig_rig_viewer", "nonce-2"]);
    runTmux(socket, ["new-window", "-d", "-t", s2Id!, "-n", "person-extra", "sleep 60"]);

    // Recorded viewer 3 with tampered nonce (must be kept):
    const v3Out = runTmux(socket, ["new-session", "-d", "-s", "openrig-view-v3", "-P", "-F", "#{session_id}|#{window_id}|#{pane_id}", "sleep 60"]).trim();
    const [s3Id, w3Id, p3Id] = v3Out.split("|");
    runTmux(socket, ["set-option", "-t", s3Id!, "@openrig_rig_viewer", "wrong-nonce"]);

    const serverArgs = ["-L", socket, "-f", "/dev/null"];
    const h = makeCloseHerdr();
    const svc = new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => [],
      listRigSeats: () => null,
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
      tmuxServerArgs: () => serverArgs,
      tmuxExec: async (args) => execFileSync("tmux", [...serverArgs, ...args], { encoding: "utf8", env: tmuxEnv, timeout: 5000 }),
    });

    await svc.registerRigViewer({
      kind: "tmux", view: "rig:alpha", sessionName: "openrig-view-v1", sessionId: s1Id!,
      nonce: "nonce-1", windowIds: [w1Id!], paneIds: [p1Id!], phase: "created",
    });
    await svc.registerRigViewer({
      kind: "tmux", view: "rig:beta", sessionName: "openrig-view-v2", sessionId: s2Id!,
      nonce: "nonce-2", windowIds: [w2Id!], paneIds: [p2Id!], phase: "created",
    });
    await svc.registerRigViewer({
      kind: "tmux", view: "rig:gamma", sessionName: "openrig-view-v3", sessionId: s3Id!,
      nonce: "nonce-3", windowIds: [w3Id!], paneIds: [p3Id!], phase: "created",
    });

    const closed = await svc.closeAll({ provider: "tmux" });
    expect(closed.ok).toBe(true);
    expect(closed.viewers.find(v => v.view === "rig:alpha")).toMatchObject({ provider: "tmux", outcome: "closed" });
    expect(closed.viewers.find(v => v.view === "rig:beta")).toMatchObject({ provider: "tmux", outcome: "kept" });
    expect(closed.viewers.find(v => v.view === "rig:gamma")).toMatchObject({ provider: "tmux", outcome: "kept" });

    const remainingSessions = runTmux(socket, ["list-sessions", "-F", "#{session_name}"]).trim().split("\n");
    expect(remainingSessions).toContain("op@alpha");
    expect(remainingSessions).toContain("openrig-view-legacy");
    expect(remainingSessions).toContain("openrig-view-v2");
    expect(remainingSessions).toContain("openrig-view-v3");
    expect(remainingSessions).not.toContain("openrig-view-v1");
    expect(runTmux(socket, ["list-panes", "-t", "=op@alpha", "-F", "#{pane_id}|#{pane_pid}"]).trim()).toBe(sourcePaneBefore);
  });
});
