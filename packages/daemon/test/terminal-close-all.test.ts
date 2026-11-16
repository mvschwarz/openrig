import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrAdapter } from "../src/domain/terminal/herdr-adapter.js";
import { RigViewerLedger, tmuxEndpointKey } from "../src/domain/terminal/rig-viewer-records.js";
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

function echoAppliedRoot(
  node: unknown,
  tabId: string,
  panes: Array<{ workspace_id: string; tab_id: string; pane_id: string; label: string }>,
  workspaceId: string,
): unknown {
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  if (obj["type"] === "pane") {
    const label = String(obj["label"] ?? "");
    const pane_id = `${tabId}-p${panes.length + 1}`;
    panes.push({ workspace_id: workspaceId, tab_id: tabId, pane_id, label });
    return { ...obj, pane_id };
  }
  return {
    ...obj,
    first: echoAppliedRoot(obj["first"], tabId, panes, workspaceId),
    second: echoAppliedRoot(obj["second"], tabId, panes, workspaceId),
  };
}

function makeCloseHerdr(opts?: { launchTokenPrefix?: string; onWorkspaceClose?: (wid: string) => void; socketPath?: string }) {
  const workspaces: Array<{ workspace_id: string; label: string }> = [];
  const tabs: Array<{ workspace_id: string; tab_id: string; label: string }> = [];
  const panes: Array<{ workspace_id: string; tab_id: string; pane_id: string; label: string }> = [];
  const closedWorkspaces: string[] = [];
  let keepAfterClose = false;
  let failList = false;
  let tokenCounter = 0;

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
        const defaultTabId = `${workspace_id}:t0`;
        const rootPaneId = `${defaultTabId}-p0`;
        workspaces.push({ workspace_id, label: String(params["label"] ?? "") });
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
        const workspace_id = String(params["workspace_id"]);
        const tab_id = `${workspace_id}:t${tabs.filter(t => t.workspace_id === workspace_id).length}`;
        tabs.push({ workspace_id, tab_id, label: String(params["tab_label"] ?? "") });
        const rootEcho = echoAppliedRoot(params["root"], tab_id, panes, workspace_id);
        return { type: "layout_apply", layout: { workspace_id, tab_id, root: rootEcho } };
      }
      if (method === "tab.list") {
        return { type: "tab_list", tabs: tabs.filter(t => t.workspace_id === params["workspace_id"]) };
      }
      if (method === "pane.list") {
        return { type: "pane_list", panes: panes.filter(p => p.workspace_id === params["workspace_id"]) };
      }
      if (method === "tab.close") {
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
        const id = String(params["workspace_id"]);
        closedWorkspaces.push(id);
        opts?.onWorkspaceClose?.(id);
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
    launch: { socketPath: opts?.socketPath ?? "/tmp/herdr-close.sock" },
    newLaunchToken: () => `${opts?.launchTokenPrefix ?? "c"}-${++tokenCounter}`,
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

  it("J01: refreshes fresh inventory per target during closeAll on both Herdr and tmux so person content added to B while A closes survives", async () => {
    // 1. Herdr race-at-B: closing w1 triggers person adding a tab to w2 before w2 is checked
    const herdrDir = tempDir("rig-viewers-j01-h-");
    let mutatedB = false;
    const h = makeCloseHerdr({
      onWorkspaceClose: (wid) => {
        if (!mutatedB && wid === "w1") {
          mutatedB = true;
          h.tabs.push({ workspace_id: "w2", tab_id: "w2:person", label: "notes" });
        }
      },
    });
    const herdrSvc = new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? h.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha", "beta"],
      listRigSeats: (rig) => [seat(rig, "op")],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir: herdrDir,
    });
    await herdrSvc.openAll({ provider: "herdr" });
    const herdrClose = await herdrSvc.closeAll({ provider: "herdr" });
    expect(herdrClose.viewers.find(v => v.view === "rig:alpha")).toMatchObject({ outcome: "closed" });
    expect(herdrClose.viewers.find(v => v.view === "rig:beta")).toMatchObject({ outcome: "kept" });
    expect(h.workspaces.map(w => w.workspace_id)).toEqual(["w2"]);
    expect(h.tabs.some(t => t.tab_id === "w2:person")).toBe(true);

    // 2. Tmux race-at-B: killing v1 triggers person adding a window to v2 before v2 is killed
    const tmuxDir = tempDir("rig-viewers-j01-t-");
    const socket = `close-race-${randomUUID().slice(0, 10)}`;
    sockets.push(socket);
    const v1Out = runTmux(socket, ["new-session", "-d", "-s", "openrig-view-r1", "-P", "-F", "#{session_id}|#{window_id}|#{pane_id}", "sleep 60"]).trim();
    const [s1Id, w1Id, p1Id] = v1Out.split("|");
    runTmux(socket, ["set-option", "-t", s1Id!, "@openrig_rig_viewer", "nonce-r1"]);
    const v2Out = runTmux(socket, ["new-session", "-d", "-s", "openrig-view-r2", "-P", "-F", "#{session_id}|#{window_id}|#{pane_id}", "sleep 60"]).trim();
    const [s2Id, w2Id, p2Id] = v2Out.split("|");
    runTmux(socket, ["set-option", "-t", s2Id!, "@openrig_rig_viewer", "nonce-r2"]);

    const serverArgs = ["-L", socket, "-f", "/dev/null"];
    let tmuxMutatedB = false;
    const tmuxSvc = new TerminalService({
      resolveProvider: () => null,
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => [],
      listRigSeats: () => null,
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir: tmuxDir,
      tmuxServerArgs: () => serverArgs,
      tmuxExec: async (args) => {
        const out = execFileSync("tmux", [...serverArgs, ...args], { encoding: "utf8", env: tmuxEnv, timeout: 5000 });
        if (!tmuxMutatedB && args[0] === "kill-session" && args.includes(s1Id!)) {
          tmuxMutatedB = true;
          runTmux(socket, ["new-window", "-d", "-t", s2Id!, "-n", "person-extra", "sleep 60"]);
        }
        return out;
      },
    });
    await tmuxSvc.registerRigViewer({
      kind: "tmux", view: "rig:alpha", sessionName: "openrig-view-r1", sessionId: s1Id!,
      nonce: "nonce-r1", windowIds: [w1Id!], paneIds: [p1Id!], phase: "created",
    });
    await tmuxSvc.registerRigViewer({
      kind: "tmux", view: "rig:beta", sessionName: "openrig-view-r2", sessionId: s2Id!,
      nonce: "nonce-r2", windowIds: [w2Id!], paneIds: [p2Id!], phase: "created",
    });
    const tmuxClose = await tmuxSvc.closeAll({ provider: "tmux" });
    expect(tmuxClose.viewers.find(v => v.view === "rig:alpha")).toMatchObject({ outcome: "closed" });
    expect(tmuxClose.viewers.find(v => v.view === "rig:beta")).toMatchObject({ outcome: "kept" });
    const liveWins = runTmux(socket, ["list-windows", "-t", s2Id!, "-F", "#{window_name}"]).trim().split("\n");
    expect(liveWins).toContain("person-extra");
  });

  it("J04/T2: treats tmux Permission denied on pre-close/post-kill readback as provider_unreachable/close_pending (retaining records) and handles kill-success-but-still-listed", async () => {
    const rigViewersDir = tempDir("rig-viewers-j04-");
    const serverArgs = ["-L", "perm-test", "-f", "/dev/null"];
    let mode: "perm-pre" | "perm-post" | "still-listed" = "perm-pre";
    let killed = false;
    const svc = new TerminalService({
      resolveProvider: () => null,
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => [],
      listRigSeats: () => null,
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
      tmuxServerArgs: () => serverArgs,
      tmuxExec: async (args) => {
        if (mode === "perm-pre") {
          throw new Error("error connecting to /tmp/tmux-1000/perm-test (Permission denied)");
        }
        if (mode === "perm-post" && killed && args[0] === "list-sessions") {
          throw new Error("error connecting to /tmp/tmux-1000/perm-test (Permission denied)");
        }
        if (args[0] === "kill-session") {
          killed = true;
          return "";
        }
        if (args[0] === "list-sessions") return "$1|openrig-view-1\n";
        if (args[0] === "list-windows") return "$1|@1\n";
        if (args[0] === "list-panes") return "$1|%1\n";
        if (args[0] === "show-options") return "nonce-1\n";
        return "";
      },
    });
    await svc.registerRigViewer({
      kind: "tmux", view: "rig:alpha", sessionName: "openrig-view-1", sessionId: "$1",
      nonce: "nonce-1", windowIds: ["@1"], paneIds: ["%1"], phase: "created",
    });

    // 1. Pre-close permission error -> failed / provider_unreachable + keeps record
    const pre = await svc.closeAll({ provider: "tmux" });
    expect(pre.ok).toBe(false);
    expect(pre.viewers[0]).toMatchObject({ outcome: "failed", code: "provider_unreachable" });
    expect(Object.keys(readRecords(rigViewersDir))).toHaveLength(1);

    // 2. Post-kill permission error -> failed / close_pending + keeps record
    mode = "perm-post";
    killed = false;
    const postPerm = await svc.closeAll({ provider: "tmux" });
    expect(postPerm.ok).toBe(false);
    expect(postPerm.viewers[0]).toMatchObject({ outcome: "failed", code: "close_pending" });
    expect(Object.keys(readRecords(rigViewersDir))).toHaveLength(1);

    // 3. kill-session exits cleanly, yet list-sessions still lists $1 -> failed / close_pending + phase closing
    mode = "still-listed";
    killed = false;
    const stillListed = await svc.closeAll({ provider: "tmux" });
    expect(stillListed.ok).toBe(false);
    expect(stillListed.viewers[0]).toMatchObject({ outcome: "failed", code: "close_pending" });
    const recs = Object.values(readRecords(rigViewersDir));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.["phase"]).toBe("closing");
  });

  it("J08: keeps a Herdr workspace whose w1/t1/p1 IDs were reused after restart with different tab labels (person content survives)", async () => {
    const rigViewersDir = tempDir("rig-viewers-j08-");
    const h = makeCloseHerdr({ launchTokenPrefix: "daemon1" });
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
    const opened = await svc.openAll({ provider: "herdr" });
    expect(opened.rigs[0]?.workspaceId).toBe("w1");
    expect(Object.keys(readRecords(rigViewersDir))).toHaveLength(1);

    // Simulate Herdr restart reusing identical IDs w1, w1:t1, w1:t1-p2 for a person's workspace or new non-matching tab label:
    for (const t of h.tabs) if (t.workspace_id === "w1") t.label = "person-notes";

    const res = await svc.closeAll({ provider: "herdr" });
    expect(res.viewers[0]).toMatchObject({ view: "rig:alpha", target: "w1", outcome: "kept" });
    expect(h.closedWorkspaces).toEqual([]);
    expect(h.workspaces.map(w => w.workspace_id)).toEqual(["w1"]);
  });

  it("J11: fails closed with corrupt-ledger diagnostic and preserves corrupt bytes without overwriting", async () => {
    const rigViewersDir = tempDir("rig-viewers-j11-");
    const corruptHash = createHash("sha256").update("herdr:/tmp/herdr-close.sock").digest("hex");
    const corruptPath = path.join(rigViewersDir, `${corruptHash}.json`);
    const corruptBytes = "{corrupt-not-json\n";
    writeFileSync(corruptPath, corruptBytes, { mode: 0o600 });

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
    expect(res.ok).toBe(false);
    expect(res.code).toBe("corrupt_ledger");
    expect(res.error).toContain(`${corruptHash}.json`);
    expect(readFileSync(corruptPath, "utf8")).toBe(corruptBytes);
  });

  it("J12: distinguishes records belonging to a different Herdr/tmux endpoint from provider_unreachable", async () => {
    const rigViewersDir = tempDir("rig-viewers-j12-");
    const otherHerdr = makeCloseHerdr({ socketPath: "/tmp/herdr-other.sock" });
    const otherSvc = new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? otherHerdr.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => ["alpha"],
      listRigSeats: (rig) => [seat(rig, "op")],
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
    });
    await otherSvc.openAll({ provider: "herdr" });

    const defaultHerdr = makeCloseHerdr({ socketPath: "/tmp/herdr-default.sock" });
    const defaultTmux = vi.fn(async (): Promise<string> => { throw new Error("fixture tmux endpoint unavailable"); });
    const defaultSvc = new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? defaultHerdr.adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => [],
      listRigSeats: () => null,
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
      tmuxServerArgs: () => ["-L", "j12-default-fixture"],
      tmuxExec: defaultTmux,
    });
    await defaultSvc.registerRigViewer({
      kind: "tmux", view: "rig:beta", sessionName: "openrig-view-other", sessionId: "$9",
      nonce: "nonce-9", windowIds: ["@9"], paneIds: ["%9"], phase: "created",
    });

    const closeDefault = await defaultSvc.closeAll({});
    const herdrRes = closeDefault.viewers.find(v => v.provider === "herdr");
    expect(herdrRes).toMatchObject({ outcome: "kept", code: "different_endpoint" });
    expect(herdrRes?.reason).not.toMatch(/unreachable/i);
    expect(closeDefault.viewers.find(v => v.provider === "tmux")).toMatchObject({ outcome: "failed", code: "provider_unreachable" });
    expect(defaultTmux).toHaveBeenCalled();

    const closeOtherTmux = await new TerminalService({
      resolveProvider: () => null,
      viewsStore: { get: () => null, list: () => [] },
      listRigNames: () => [],
      listRigSeats: () => null,
      listPodSeats: () => null,
      resolveHost: () => null,
      hasSession: () => true,
      rigViewersDir,
      tmuxServerArgs: () => ["-L", "other-tmux-server"],
      tmuxExec: async () => "",
    }).closeAll({ provider: "tmux" });
    expect(closeOtherTmux.viewers[0]).toMatchObject({ outcome: "kept", code: "different_endpoint" });
  });
});

describe("#3081 bf06 child B01/BT01 — closeAll session validation & provider exclusion", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    while (createdDirs.length > 0) {
      rmSync(createdDirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeHerdrEndpoint(socketPath: string, initialWorkspaces: Array<{ wid: string; label: string; tabId: string; tabLabel: string; paneId: string }>) {
    const workspaces = initialWorkspaces.map(w => ({ workspace_id: w.wid, label: w.label }));
    const closedWorkspaces: string[] = [];
    const transport: HerdrTransport = {
      probe: async () => ({ alive: true, version: "0.9.5", protocol: 22 }),
      request: async (method, raw): Promise<HerdrResult> => {
        const params = (raw ?? {}) as Record<string, unknown>;
        if (method === "workspace.list") return { type: "workspace_list", workspaces: [...workspaces] };
        if (method === "tab.list") {
          const item = initialWorkspaces.find(w => w.wid === params["workspace_id"] && workspaces.some(ws => ws.workspace_id === w.wid));
          return { type: "tab_list", tabs: item ? [{ workspace_id: item.wid, tab_id: item.tabId, label: item.tabLabel }] : [] };
        }
        if (method === "pane.list") {
          const item = initialWorkspaces.find(w => w.wid === params["workspace_id"] && workspaces.some(ws => ws.workspace_id === w.wid));
          return { type: "pane_list", panes: item ? [{ workspace_id: item.wid, tab_id: item.tabId, pane_id: item.paneId, label: "op" }] : [] };
        }
        if (method === "workspace.close") {
          const wid = String(params["workspace_id"] ?? "");
          closedWorkspaces.push(wid);
          const idx = workspaces.findIndex(w => w.workspace_id === wid);
          if (idx >= 0) workspaces.splice(idx, 1);
          return { type: "ok" };
        }
        return { type: "ok" };
      },
    };
    const adapter = new HerdrAdapter({ transportFactory: () => transport, launch: { socketPath } });
    return { adapter, closedWorkspaces };
  }

  function makeBaseDeps(overrides: Partial<TerminalServiceDeps> & { rigViewersDir: string }): TerminalServiceDeps {
    return {
      resolveProvider: () => null,
      viewsStore: { get: () => undefined, list: () => [] },
      listRigSeats: () => [],
      listPodSeats: () => [],
      listRigNames: () => [],
      resolveHost: () => null,
      hasSession: () => false,
      tmuxServerArgs: () => ["-L", "isolated-sock"],
      ...overrides,
    };
  }

  it.each(["", "   ", ".", "..", "a/b", "a\\b", "bad\nb", "bad\x00"])(
    "rejects invalid session %j with invalid_terminal_session BEFORE reading ledger or resolving providers",
    async (badSession) => {
      const dir = mkdtempSync(path.join(tmpdir(), "o3081-b01-corrupt-"));
      createdDirs.push(dir);
      writeFileSync(path.join(dir, `${"a".repeat(64)}.json`), "{not-json", "utf8");
      const resolveProvider = vi.fn(() => null);
      const resolveSessionProvider = vi.fn(() => null);
      const tmuxExec = vi.fn(async () => "");
      const svc = new TerminalService(makeBaseDeps({
        rigViewersDir: dir,
        resolveProvider,
        resolveSessionProvider,
        tmuxExec,
      }));
      const res = await svc.closeAll({ session: badSession });
      expect(res).toMatchObject({ ok: false, viewers: [], code: "invalid_terminal_session" });
      expect(resolveProvider).not.toHaveBeenCalled();
      expect(resolveSessionProvider).not.toHaveBeenCalled();
      expect(tmuxExec).not.toHaveBeenCalled();
    },
  );

  it.each([
    { provider: "tmux", session: "work" },
    { provider: " tmux ", session: "default" },
    { provider: "tmux", session: "" },
    { provider: "tmux", session: ".." },
  ])(
    "rejects explicit tmux with session ($provider / $session) as unsupported_terminal_session BEFORE ledger or tmux calls",
    async ({ provider, session }) => {
      const dir = mkdtempSync(path.join(tmpdir(), "o3081-b01-tmux-sess-"));
      createdDirs.push(dir);
      writeFileSync(path.join(dir, `${"b".repeat(64)}.json`), "{not-json", "utf8");
      const resolveProvider = vi.fn(() => null);
      const resolveSessionProvider = vi.fn(() => null);
      const tmuxExec = vi.fn(async () => "");
      const svc = new TerminalService(makeBaseDeps({
        rigViewersDir: dir,
        resolveProvider,
        resolveSessionProvider,
        tmuxExec,
      }));
      const res = await svc.closeAll({ provider, session });
      expect(res).toMatchObject({ ok: false, viewers: [], code: "unsupported_terminal_session" });
      expect(resolveProvider).not.toHaveBeenCalled();
      expect(resolveSessionProvider).not.toHaveBeenCalled();
      expect(tmuxExec).not.toHaveBeenCalled();
    },
  );

  it("validates session \"default\" under selectProvider policy and closes default Herdr while preserving work & tmux", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "o3081-b01-default-sess-"));
    createdDirs.push(dir);
    const ledger = new RigViewerLedger(dir);
    const def = makeHerdrEndpoint("/tmp/h/herdr.sock", [{ wid: "ws-def", label: "alpha", tabId: "t-def", tabLabel: "openrig:rig:alpha#p1#k1/1", paneId: "p-def" }]);
    const work = makeHerdrEndpoint("/tmp/h/sessions/work/herdr.sock", [{ wid: "ws-work", label: "beta", tabId: "t-work", tabLabel: "openrig:rig:beta#p2#k2/1", paneId: "p-work" }]);
    await ledger.upsert({ kind: "herdr", endpoint: def.adapter.endpointKey(), view: "rig:alpha", workspaceId: "ws-def", tabIds: ["t-def"], tabLabels: ["openrig:rig:alpha#p1#k1/1"], paneIds: ["p-def"], planId: "p1", createdAt: "2026-11-13T00:00:00Z", phase: "created" });
    await ledger.upsert({ kind: "herdr", endpoint: work.adapter.endpointKey(), view: "rig:beta", workspaceId: "ws-work", tabIds: ["t-work"], tabLabels: ["openrig:rig:beta#p2#k2/1"], paneIds: ["p-work"], planId: "p2", createdAt: "2026-11-13T00:00:00Z", phase: "created" });
    await ledger.upsert({ kind: "tmux", endpoint: tmuxEndpointKey(["-L", "isolated-sock"]), view: "rig:gamma", sessionName: "openrig-view-1", sessionId: "$1", nonce: "n1", windowIds: ["@1"], paneIds: ["%1"], createdAt: "2026-11-13T00:00:00Z", phase: "created" });
    const tmuxExec = vi.fn(async () => "");
    const resolveSessionProvider = vi.fn((_name: string, sess: string) => (sess === "default" ? def.adapter : sess === "work" ? work.adapter : null));
    const svc = new TerminalService(makeBaseDeps({
      rigViewersDir: dir,
      resolveProvider: () => def.adapter,
      resolveSessionProvider,
      tmuxExec,
    }));

    const res = await svc.closeAll({ session: " default " });
    expect(res.ok).toBe(true);
    expect(resolveSessionProvider).toHaveBeenCalledWith("herdr", "default");
    expect(def.closedWorkspaces).toEqual(["ws-def"]);
    expect(work.closedWorkspaces).toEqual([]);
    expect(tmuxExec).not.toHaveBeenCalled();
    expect(res.viewers.find(v => v.provider === "tmux")).toBeUndefined();
    expect(res.viewers.find(v => v.target === "ws-def")?.outcome).toBe("closed");
    expect(res.viewers.find(v => v.target === "ws-work")).toMatchObject({ outcome: "kept", code: "different_endpoint" });
    expect((await ledger.listAll()).map(e => e.record.kind).sort()).toEqual(["herdr", "tmux"]);
  });

  it("closeAll({ session: \" work \" }) omits provider -> selects ONLY matching Herdr session, excluding tmux and keeping other Herdr endpoints", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "o3081-b01-work-sess-"));
    createdDirs.push(dir);
    const ledger = new RigViewerLedger(dir);
    const def = makeHerdrEndpoint("/tmp/h2/herdr.sock", [{ wid: "ws-def", label: "alpha", tabId: "t-def", tabLabel: "openrig:rig:alpha#p1#k1/1", paneId: "p-def" }]);
    const work = makeHerdrEndpoint("/tmp/h2/sessions/work/herdr.sock", [{ wid: "ws-work", label: "beta", tabId: "t-work", tabLabel: "openrig:rig:beta#p2#k2/1", paneId: "p-work" }]);
    await ledger.upsert({ kind: "herdr", endpoint: def.adapter.endpointKey(), view: "rig:alpha", workspaceId: "ws-def", tabIds: ["t-def"], tabLabels: ["openrig:rig:alpha#p1#k1/1"], paneIds: ["p-def"], planId: "p1", createdAt: "2026-11-13T00:00:00Z", phase: "created" });
    await ledger.upsert({ kind: "herdr", endpoint: work.adapter.endpointKey(), view: "rig:beta", workspaceId: "ws-work", tabIds: ["t-work"], tabLabels: ["openrig:rig:beta#p2#k2/1"], paneIds: ["p-work"], planId: "p2", createdAt: "2026-11-13T00:00:00Z", phase: "created" });
    await ledger.upsert({ kind: "tmux", endpoint: tmuxEndpointKey(["-L", "isolated-sock"]), view: "rig:gamma", sessionName: "openrig-view-1", sessionId: "$1", nonce: "n1", windowIds: ["@1"], paneIds: ["%1"], createdAt: "2026-11-13T00:00:00Z", phase: "created" });
    const tmuxExec = vi.fn(async () => "");
    const resolveSessionProvider = vi.fn((_name: string, sess: string) => (sess === "work" ? work.adapter : def.adapter));
    const svc = new TerminalService(makeBaseDeps({
      rigViewersDir: dir,
      resolveProvider: () => def.adapter,
      resolveSessionProvider,
      tmuxExec,
    }));

    const res = await svc.closeAll({ session: " work " });
    expect(res.ok).toBe(true);
    expect(resolveSessionProvider).toHaveBeenCalledWith("herdr", "work");
    for (const call of resolveSessionProvider.mock.calls) {
      expect(call).toEqual(["herdr", "work"]);
    }
    expect(work.closedWorkspaces).toEqual(["ws-work"]);
    expect(def.closedWorkspaces).toEqual([]);
    expect(tmuxExec).not.toHaveBeenCalled();
    expect(res.viewers.some(v => v.provider === "tmux")).toBe(false);
    expect(res.viewers.find(v => v.target === "ws-work")?.outcome).toBe("closed");
    expect(res.viewers.find(v => v.target === "ws-def")).toMatchObject({ outcome: "kept", code: "different_endpoint" });
  });

  it("closeAll({ session: \"work\" }) when only tmux viewers exist never touches tmux", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "o3081-b01-only-tmux-"));
    createdDirs.push(dir);
    const ledger = new RigViewerLedger(dir);
    await ledger.upsert({ kind: "tmux", endpoint: tmuxEndpointKey(["-L", "isolated-sock"]), view: "rig:gamma", sessionName: "openrig-view-1", sessionId: "$1", nonce: "n1", windowIds: ["@1"], paneIds: ["%1"], createdAt: "2026-11-13T00:00:00Z", phase: "created" });
    const tmuxExec = vi.fn(async () => "");
    const svc = new TerminalService(makeBaseDeps({
      rigViewersDir: dir,
      tmuxExec,
    }));

    const res = await svc.closeAll({ session: "work" });
    expect(res.ok).toBe(true);
    expect(res.viewers).toEqual([]);
    expect(tmuxExec).not.toHaveBeenCalled();
    expect(await ledger.listAll()).toHaveLength(1);
  });

  it("normalizes whitespace provider and preserves unscoped closeAll across Herdr default + tmux", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "o3081-b01-unscoped-"));
    createdDirs.push(dir);
    const ledger = new RigViewerLedger(dir);
    const def = makeHerdrEndpoint("/tmp/h3/herdr.sock", [{ wid: "ws-def", label: "alpha", tabId: "t-def", tabLabel: "openrig:rig:alpha#p1#k1/1", paneId: "p-def" }]);
    await ledger.upsert({ kind: "herdr", endpoint: def.adapter.endpointKey(), view: "rig:alpha", workspaceId: "ws-def", tabIds: ["t-def"], tabLabels: ["openrig:rig:alpha#p1#k1/1"], paneIds: ["p-def"], planId: "p1", createdAt: "2026-11-13T00:00:00Z", phase: "created" });
    await ledger.upsert({ kind: "tmux", endpoint: tmuxEndpointKey(["-L", "isolated-sock"]), view: "rig:gamma", sessionName: "openrig-view-1", sessionId: "$1", nonce: "n1", windowIds: ["@1"], paneIds: ["%1"], createdAt: "2026-11-13T00:00:00Z", phase: "created" });
    let killed = false;
    const tmuxExec = vi.fn(async (args: string[]) => {
      if (args[0] === "list-sessions") return killed ? "" : "$1|openrig-view-1\n";
      if (args[0] === "list-windows") return killed ? "" : "$1|@1\n";
      if (args[0] === "list-panes") return killed ? "" : "$1|%1\n";
      if (args[0] === "show-options") return "n1\n";
      if (args[0] === "list-clients") return "";
      if (args[0] === "kill-session") { killed = true; return ""; }
      return "";
    });
    const svc = new TerminalService(makeBaseDeps({
      rigViewersDir: dir,
      resolveProvider: () => def.adapter,
      tmuxExec,
    }));

    const res = await svc.closeAll({});
    expect(res.ok).toBe(true);
    expect(def.closedWorkspaces).toEqual(["ws-def"]);
    expect(killed).toBe(true);
    expect(await ledger.listAll()).toEqual([]);

    const bogus = await svc.closeAll({ provider: " cmux " });
    expect(bogus).toMatchObject({ ok: false, viewers: [], code: "unsupported_provider" });
  });

  it("closeView rejects session and non-herdr-app provider while retaining default herdr-app + appHome", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "o3081-b01-single-"));
    createdDirs.push(dir);
    const closed: Array<{ viewId: string; appHome: string }> = [];
    const resolveHerdrAppProvider = vi.fn((target: { appHome?: string }) => ({
      name: "herdr-app",
      appHome: target.appHome ?? "/default/app",
      status: async () => ({ provider: "herdr-app", available: true, capabilities: {} }),
      liveness: async () => ({ alive: true }),
      openView: async () => ({ provider: "herdr-app", ok: true, opened: [], absent: [], degraded: [], pages: 0 }),
      closeView: async (viewId: string) => {
        closed.push({ viewId, appHome: target.appHome ?? "/default/app" });
        return { provider: "herdr-app", ok: true, opened: [], absent: [], degraded: [], pages: 0 };
      },
    }));
    const svc = new TerminalService(makeBaseDeps({ rigViewersDir: dir, resolveHerdrAppProvider }));

    const badSession = await svc.closeView({ view: "rv-1", session: "work" } as never);
    expect(badSession).toMatchObject({ ok: false, code: "unsupported_terminal_session" });
    expect(resolveHerdrAppProvider).not.toHaveBeenCalled();

    const badProvider = await svc.closeView({ view: "rv-1", provider: "tmux" });
    expect(badProvider).toMatchObject({ ok: false, code: "close_unsupported" });
    expect(resolveHerdrAppProvider).not.toHaveBeenCalled();

    const okRes = await svc.closeView({ view: "rv-1", herdrApp: { appHome: "/custom/app" } });
    expect(okRes.ok).toBe(true);
    expect(closed).toEqual([{ viewId: "rv-1", appHome: "/custom/app" }]);
  });
});
