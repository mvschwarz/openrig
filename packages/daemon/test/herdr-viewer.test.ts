import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HerdrViewer, type HerdrViewerRun } from "../src/domain/terminal/herdr-viewer.js";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";
import { composeView } from "../src/domain/terminal/view-composer.js";
import { Hono } from "hono";
import { HerdrAdapter } from "../src/domain/terminal/herdr-adapter.js";
import { TerminalService } from "../src/domain/terminal/terminal-service.js";
import { terminalRoutes } from "../src/routes/terminal.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const key = { hostId: "box", nodeId: "node-a" };
const socket = "/tmp/private-herdr.sock";
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "viewer-test-")); dirs.push(root);
  const target = composeView("qitem:qitem-root", [{ seat: "a@team", label: "a", tmuxSession: "a@team", host: null, alive: true, readOnly: false }], { resolveHost: () => null, localTmux: "/usr/bin/tmux", localTmuxServer: ["-S", "/tmp/own-tmux.sock"] }).opened[0]!;
  const calls: string[][] = [];
  let ids = { workspace_id: "w1", pane_id: "w1:p1", terminal_id: "term_001", cwd: "" };
  let label = "", running = false, uncertainCreate = false, uncertainRun = false, idless = false;
  let gone = false, enumerable = true, unreadable = false;
  let workspaceInventory: unknown[] | undefined, paneInventory: Record<string, unknown> | undefined;
  const inspect = async () => ({ sessionId: "$1", nodeId: key.nodeId });
  const run: HerdrViewerRun = async args => {
    calls.push(args);
    const command = args.slice(0, 2).join(" ");
    if (command === "status server") return JSON.stringify({ running: true, version: "0.9.5", protocol: 22, socket });
    if (command === "workspace create") {
      gone = false; enumerable = true;
      ids.cwd = args[args.indexOf("--cwd") + 1]!; label = args[args.indexOf("--label") + 1]!;
      if (uncertainCreate) { uncertainCreate = false; throw new Error("lost response"); }
      return JSON.stringify({ result: { root_pane: idless ? {} : ids } });
    }
    if (command === "workspace list") {
      if (args.length !== 2) throw new Error("usage: herdr workspace list");
      return JSON.stringify({ result: unreadable ? {} : { workspaces: workspaceInventory ?? (enumerable ? [{ workspace_id: ids.workspace_id, label }] : []) } });
    }
    if (command === "pane list") return JSON.stringify({ result: paneInventory ? paneInventory[args[args.indexOf("--workspace") + 1]!] : { panes: [ids] } });
    if (command === "pane get") { if (gone) throw new Error("pane not found"); return JSON.stringify({ result: { pane: ids } }); }
    if (command === "pane run") {
      running = true;
      if (uncertainRun) { uncertainRun = false; throw new Error("lost run response"); }
      return "";
    }
    if (command === "pane process-info") return JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: running
      ? ["/usr/bin/tmux", "-S", "/tmp/own-tmux.sock", "attach", "-f", "ignore-size", "-t", "$1"] : ["/bin/bash"] }] } } });
    throw new Error(`Unexpected provider operation ${args}`);
  };
  const viewer = () => new HerdrViewer(socket, run, "linux", root, inspect);
  return { root, target, calls, viewer, ids,
    lose: (listed: boolean, malformed = false) => { gone = true; enumerable = listed; unreadable = malformed; },
    loseChanged: () => { gone = false; enumerable = false; },
    setEnumeration: (workspaces: unknown[], panes: Record<string, unknown>) => { workspaceInventory = workspaces; paneInventory = panes; },
    setCreateLost: () => { uncertainCreate = true; }, setRunLost: () => { uncertainRun = true; }, setIdless: () => { idless = true; }, exit: () => { running = false; } };
}

describe("owned Herdr viewer", () => {
  it("creates once, verifies empty pane-run response, and reuses under concurrent requests", async () => {
    const f = fixture(), v = f.viewer();
    const result = await Promise.all([v.ensure(key, f.target), v.ensure(key, f.target), v.ensure(key, f.target)]);
    expect(result.map(r => r.ok && r.created)).toEqual([true, false, false]);
    expect(f.calls.filter(a => a[0] === "workspace" && a[1] === "create")).toHaveLength(1);
    expect(f.calls.filter(a => a[0] === "pane" && a[1] === "run")).toHaveLength(1);
    expect(f.calls.some(a => a.includes("focus") || a.includes("close") || a.includes("takeover"))).toBe(false);
    expect(f.calls.find(a => a[1] === "create")).toContain("--no-focus");
    expect(result.every(r => r.ok && r.viewer.terminalId === "term_001")).toBe(true);
  });
  it("passive lookup never creates or starts a viewer", async () => {
    const f = fixture(); expect(await f.viewer().lookup(key, f.target)).toMatchObject({ ok: false, code: "viewer_not_provisioned" });
    expect(f.calls.filter(a => ["create", "run", "split"].includes(a[1]!))).toEqual([]);
  });
  it("reconciles a lost create reply by its private cwd before starting, without another create", async () => {
    const f = fixture(), v = f.viewer(); f.setCreateLost();
    expect(await v.ensure(key, f.target)).toMatchObject({ ok: false });
    expect(await v.ensure(key, f.target)).toMatchObject({ ok: true, created: false });
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
    expect(f.calls.filter(a => a[1] === "list").length).toBeGreaterThan(0);
  });
  it("does not repeat an uncertain run and confirms its actual foreground process on retry", async () => {
    const f = fixture(), v = f.viewer(); f.setRunLost();
    expect(await v.ensure(key, f.target)).toMatchObject({ ok: false });
    expect(await v.ensure(key, f.target)).toMatchObject({ ok: true });
    expect(f.calls.filter(a => a[1] === "run")).toHaveLength(1);
  });
  it("persists provenance across daemon objects but never trusts restored pane IDs with new terminal IDs", async () => {
    const f = fixture(); expect((await f.viewer().ensure(key, f.target)).ok).toBe(true);
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: true, created: false });
    f.ids.terminal_id = "term_new_generation";
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
  });
  it.each(["gone", "changed"])("retires an absent %s viewer before exactly one fresh verified create", async mode => {
    const f = fixture(); expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: true });
    const oldCwd = f.ids.cwd;
    if (mode === "changed") f.ids.terminal_id = "new-generation";
    f.lose(false);
    if (mode === "changed") f.loseChanged();
    // Passive preview must not retire presentation provenance or its directory.
    expect(await f.viewer().lookup(key, f.target)).toMatchObject({ ok: false });
    expect(existsSync(oldCwd)).toBe(true);
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: false, code: "viewer_not_provisioned" });
    expect(existsSync(oldCwd)).toBe(false);
    const file = readdirSync(f.root).find(name => name.endsWith(".json"))!;
    expect(Object.keys(JSON.parse(readFileSync(path.join(f.root, file), "utf8")).entries)).toEqual([]);
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
    const next = f.viewer();
    expect(await next.ensure(key, f.target)).toMatchObject({ ok: true, created: true });
    expect(await next.ensure(key, f.target)).toMatchObject({ ok: true, created: false });
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(2);
    expect(f.ids.cwd).not.toBe(oldCwd);
  });
  it.each(["enumerable", "unreadable"])("keeps a %s lost viewer unconfirmed without retiring or creating", async mode => {
    const f = fixture(); expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: true });
    const oldCwd = f.ids.cwd;
    f.lose(mode === "enumerable", mode === "unreadable");
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    expect(existsSync(oldCwd)).toBe(true);
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
  });
  it.each(["renamed", "moved", "partial"])("never retires a %s workspace viewer or creates a duplicate", async mode => {
    const f = fixture(), v = f.viewer();
    expect(await v.ensure(key, f.target)).toMatchObject({ ok: true });
    const oldCwd = f.ids.cwd;
    const journalPath = path.join(f.root, readdirSync(f.root).find(name => name.endsWith(".json"))!);
    const entryId = JSON.stringify([key.hostId, key.nodeId]);
    const saved = JSON.parse(readFileSync(journalPath, "utf8")).entries[entryId];
    f.lose(true); // The old pane ID is gone, but endpoint absence is not proven.
    if (mode === "renamed") {
      f.setEnumeration([{ workspace_id: "w1", label: "renamed by the person" }], { w1: { panes: [f.ids] } });
    } else {
      f.ids.workspace_id = "w2"; f.ids.pane_id = "w2:p1";
      f.setEnumeration([{ workspace_id: "w1", label: saved.label }, { workspace_id: "w2", label: "other workspace" }],
        { w1: { panes: [] }, w2: mode === "partial" ? {} : { panes: [f.ids] } });
    }
    const first = await v.ensure(key, f.target), next = await f.viewer().ensure(key, f.target);
    expect(first).toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    expect(next).toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
    expect(existsSync(oldCwd)).toBe(true);
    expect(JSON.parse(readFileSync(journalPath, "utf8")).entries[entryId]).toEqual(saved);
    expect(f.calls.filter(a => a[0] === "pane" && a[1] === "list").some(a => a.includes(mode === "renamed" ? "w1" : "w2"))).toBe(true);
  });
  it("does not count a persistent shell after viewer exit as a working attachment", async () => {
    const f = fixture(), v = f.viewer(); await v.ensure(key, f.target); f.exit();
    expect(await v.ensure(key, f.target)).toMatchObject({ ok: false });
    expect(f.calls.filter(a => a[1] === "run")).toHaveLength(1);
  });
  it("id-less create remains uncertain and is reconciled before any retry", async () => {
    const f = fixture(), v = f.viewer(); f.setIdless();
    expect(await v.ensure(key, f.target)).toMatchObject({ ok: false });
    expect(await v.ensure(key, f.target)).toMatchObject({ ok: true });
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
  });
  it("malformed provenance and an unknown node binding never authorize provider mutation", async () => {
    const f = fixture(), v = f.viewer(); await v.ensure(key, f.target);
    const file = readdirSync(f.root).find(name => name.endsWith(".json"))!;
    writeFileSync(path.join(f.root, file), "broken");
    expect(await v.ensure(key, f.target)).toMatchObject({ ok: false });
    const wrong = new HerdrViewer(socket, async args => JSON.stringify({ running: true, version: "0.9.5", protocol: 22, socket }), "linux", f.root,
      async () => ({ sessionId: "$1", nodeId: "other-seat" }));
    expect(await wrong.ensure(key, f.target)).toMatchObject({ ok: false });
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
  });
  it("supports only the qualified endpoint/version/platform", async () => {
    const f = fixture();
    expect(await new HerdrViewer(socket, async () => { throw new Error("should not run"); }, "darwin", f.root).ensure(key, f.target)).toMatchObject({ ok: false, code: "viewer_unsupported" });
    expect(await new HerdrViewer(socket, async () => JSON.stringify({ running: true, version: "0.9.5", protocol: 22, socket: "/other.sock" }), "linux", f.root).ensure(key, f.target)).toMatchObject({ ok: false });
  });
  it("keeps ignore-size in writable initial/fallback/replacement and recovery attaches, and preserves read-only", () => {
    const rw = tileAttachArgv("tmux", [], "a@team", false)[2]!;
    expect(rw.match(/attach -f ignore-size -t/g)).toHaveLength(4);
    const ro = tileAttachArgv("tmux", [], "a@team", true)[2]!;
    expect(ro.match(/attach -r -t/g)).toHaveLength(4);
    const f = fixture(); expect(f.target.recoveryCommand).toContain("attach -f ignore-size -t");
  });
  it("rechecks membership after a queued request and performs no create for a departed member", async () => {
    const f = fixture(), v = f.viewer();
    expect(await v.ensure(key, f.target, async () => false)).toMatchObject({ ok: false });
    expect(f.calls.filter(a => ["create", "run"].includes(a[1]!))).toEqual([]);
  });
  it("service enforces membership/preview and makes the owner viewer independently interactive", async () => {
    const f = fixture(); let calls = 0, joined = true;
    const provider = { name: "herdr", status: async () => ({ provider: "herdr", available: true, capabilities: {} }), liveness: async () => ({ alive: true }),
      openView: async () => { throw new Error("Whole-plan open must not run"); },
      ensureViewer: async (_key: unknown, pane: typeof f.target, stillCurrent?: () => Promise<boolean>) => {
        calls++; expect(pane.readOnly).toBe(false); expect(pane.attachArgv![2]).toContain("attach -f ignore-size");
        expect(await stillCurrent!()).toBe(true); return { ok: true as const, viewer: { workspaceId: "w", paneId: "p", terminalId: "t", readOnly: false }, created: true };
      } };
    const svc = new TerminalService({ viewsStore: { get: () => null, list: () => [] }, listRigSeats: () => null, listPodSeats: () => null,
      listScopeSeats: () => null, listRigNames: () => [], resolveHost: () => null, hasSession: () => true, resolveLocalTmux: () => "/usr/bin/tmux", resolveProvider: () => provider,
      resolveTaskView: () => ({ task: { kind: "qitem", id: "qitem-root", qitemId: "qitem-root", name: "Task root", complete: true, issues: [], members: joined ? [{ key, seat: "a@team", availability: "available", viewerStatus: "not-provisioned", obligations: [{ qitemId: "qitem-root", state: "pending" }] }] : [] },
        members: joined ? [{ seat: "a@team", label: "a", tmuxSession: "a@team", host: null, alive: true, readOnly: true }] : [] }) });
    const preview = await svc.previewView({ view: "qitem:qitem-root", provider: "herdr" });
    expect("planId" in preview).toBe(true); if (!("planId" in preview)) throw new Error("missing preview");
    const req = { view: "qitem:qitem-root", provider: "herdr", member: key, expectedPlan: preview.planId };
    expect(await svc.ensureViewer({ ...req, expectedPlan: "stale" })).toMatchObject({ ok: false, code: "preview_changed" });
    expect(await svc.ensureViewer(req)).toMatchObject({ ok: true }); expect(calls).toBe(1);
    joined = false;
    expect(await svc.ensureViewer(req)).toMatchObject({ ok: false, code: "preview_changed" }); expect(calls).toBe(1);
  });
  it("reports an id-less layout as unconfirmed without claiming a verified viewer mapping", async () => {
    const f = fixture();
    const adapter = new HerdrAdapter({ viewer: f.viewer(), transportFactory: () => ({ probe: async () => ({ alive: true, version: "0.7.1", protocol: 14 }),
      request: async method => method === "workspace.create" ? { type: "workspace_created", workspace_id: "w" }
        : method === "layout.apply" ? { type: "layout_apply" } : { type: "workspace_list", workspaces: [] } }) });
    const result = await adapter.openView({ id: "fixture", opened: [f.target], absent: [], degraded: [], pages: [[f.target]] });
    expect(result.ok).toBe(false); expect(result.opened).toEqual([]);
    expect(result.degraded).toEqual([expect.objectContaining({ seat: f.target.seat, code: "pane_unconfirmed" })]);
    expect(await adapter.lookupViewer(key, f.target)).toMatchObject({ ok: false, code: "viewer_not_provisioned" });
  });
  it("protects the ensure HTTP operation with the existing owner bearer", async () => {
    let calls = 0;
    const app = new Hono(); app.use("*", async (c, next) => { c.set("terminalService" as never, { ensureViewer: async () => { calls++; return { ok: true }; } } as never); await next(); });
    app.route("/api/terminal", terminalRoutes({ bearerToken: "fixture-owner-token" }));
    const body = { view: "qitem:qitem-root", expectedPlan: "plan", member: key };
    const send = (auth?: string) => app.request("/api/terminal/viewer/ensure", { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) });
    expect((await send()).status).toBe(401); expect(calls).toBe(0);
    expect((await send("Bearer fixture-owner-token")).status).toBe(200); expect(calls).toBe(1);
  });
});
