import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HerdrViewer, type HerdrViewerRun } from "../src/domain/terminal/herdr-viewer.js";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";
import { tileAttachArgv078, tileAttachArgv079, tileAttachArgv0710 } from "../src/domain/terminal/earlier-tile-attach.js";
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
  let gone = false, enumerable = true, unreadable = false, attachFlags = ["-f", "ignore-size"];
  let foreground: string[] | undefined;
  let workspaceInventory: unknown[] | undefined, paneInventory: Record<string, unknown> | undefined;
  let canonicalCreateCwd = false, changedCreateCwd = false, canonicalLimit = 0;
  const inspect = async () => ({ sessionId: "$1", nodeId: key.nodeId });
  const run: HerdrViewerRun = async args => {
    calls.push(args);
    const command = args.slice(0, 2).join(" ");
    if (command === "status server") return JSON.stringify({ running: true, version: "0.9.5", protocol: 22, socket });
    if (command === "workspace create") {
      gone = false; enumerable = true;
      ids.cwd = args[args.indexOf("--cwd") + 1]!; label = args[args.indexOf("--label") + 1]!;
      if (canonicalCreateCwd) ids.cwd = realpathSync(ids.cwd);
      if (changedCreateCwd) ids.cwd = tmpdir();
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
      if (canonicalLimit && Buffer.byteLength(args[3]!) >= canonicalLimit) throw new Error("pane_send_failed: canonical mode line limit");
      running = true;
      if (uncertainRun) { uncertainRun = false; throw new Error("lost run response"); }
      return "";
    }
    if (command === "pane process-info") return JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: running
      ? foreground ?? ["/usr/bin/tmux", "-S", "/tmp/own-tmux.sock", "attach", ...attachFlags, "-t", "$1"] : ["/bin/bash"] }] } } });
    throw new Error(`Unexpected provider operation ${args}`);
  };
  const viewer = (viewerRoot = root, platform: NodeJS.Platform = "linux", status = {}) => new HerdrViewer(socket, async args => args[0] === "status" ? JSON.stringify({ running: true, version: "0.9.5", protocol: 22, socket, ...status }) : run(args), platform, viewerRoot, inspect);
  return { root, target, calls, viewer, ids,
    canonicalizeCreateCwd: () => { canonicalCreateCwd = true; },
    changeCreateCwd: () => { changedCreateCwd = true; },
    limitCanonicalInput: (bytes: number) => { canonicalLimit = bytes; },
    lose: (listed: boolean, malformed = false) => { gone = true; enumerable = listed; unreadable = malformed; },
    loseChanged: () => { gone = false; enumerable = false; },
    setEnumeration: (workspaces: unknown[], panes: Record<string, unknown>) => { workspaceInventory = workspaces; paneInventory = panes; },
    setCreateLost: () => { uncertainCreate = true; }, setRunLost: () => { uncertainRun = true; }, setIdless: () => { idless = true; }, exit: () => { running = false; },
    setAttachFlags: (flags: string[]) => { attachFlags = flags; },
    setForeground: (argv: string[]) => { foreground = argv; } };
}

describe("owned Herdr viewer", () => {
  it("uses received creation IDs when the shell changed cwd before the reply", async () => {
    const f = fixture(); f.changeCreateCwd();
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: true, created: true });
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: true, created: false });
    expect(f.calls.filter(args => args[1] === "create")).toHaveLength(1);
  });
  it("keeps a lost creation reply plus changed cwd uncertain without repeating create or run", async () => {
    const f = fixture(); f.changeCreateCwd(); f.setCreateLost();
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: false });
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: false });
    expect(f.calls.filter(args => args[1] === "create")).toHaveLength(1);
    expect(f.calls.filter(args => args[1] === "run")).toHaveLength(0);
  });
  it("starts the exact attach through a short owned script under a canonical-mode line limit", async () => {
    const f = fixture(); f.limitCanonicalInput(1024);
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: true });
    const command = f.calls.find(args => args[1] === "run")![3]!;
    expect(Buffer.byteLength(command)).toBeLessThan(1024);
    expect(command).toContain("/bin/sh ");
    expect(readFileSync(path.join(f.ids.cwd, "attach.sh"), "utf8")).toBe(`exec ${f.target.paneCommand}\n`);
  });

  it.each(["linux", "darwin"] as const)("admits protocol 22 on %s independently of the release label", async platform => {
    const f = fixture();
    expect(await f.viewer(f.root, platform, { version: "0.9.6" }).ensure(key, f.target)).toMatchObject({ ok: true });
    expect(await f.viewer(f.root, platform, { protocol: 23 }).lookup(key, f.target)).toMatchObject({ ok: false });
  });
  it("accepts an existing canonical endpoint alias", async () => {
    const f = fixture(), endpoint = path.join(f.root, "endpoint.sock"), alias = path.join(f.root, "alias.sock");
    writeFileSync(endpoint, ""); symlinkSync(endpoint, alias);
    const run: HerdrViewerRun = async args => args[0] === "status"
      ? JSON.stringify({ running: true, protocol: 22, version: "0.9.5", socket: endpoint })
      : JSON.stringify({ result: { workspaces: [] } });
    const v = new HerdrViewer(alias, run, "darwin", f.root, async () => ({ sessionId: "$1", nodeId: key.nodeId }));
    expect(await v.lookup(key, f.target)).toMatchObject({ code: "viewer_not_provisioned" });
  });
  it("preserves a changed script when its viewer is confirmed absent", async () => {
    const f = fixture(); expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: true });
    const file = path.join(f.ids.cwd, "attach.sh"); writeFileSync(file, "user change\n"); f.lose(false);
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    expect(readFileSync(file, "utf8")).toBe("user change\n");
    expect(f.calls.filter(args => args[1] === "create")).toHaveLength(1);
  });
  it("keeps a known viewer after its cwd changes and still checks its process", async () => {
    const f = fixture(), v = f.viewer();
    expect(await v.ensure(key, f.target)).toMatchObject({ ok: true, created: true });
    const attributionDirectory = f.ids.cwd;
    f.ids.cwd = tmpdir();
    expect(await v.ensure(key, f.target)).toMatchObject({ ok: true, created: false });
    expect(existsSync(attributionDirectory)).toBe(true);
    f.exit();
    expect(await v.ensure(key, f.target)).toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
    expect(f.calls.filter(a => a[1] === "run")).toHaveLength(1);
  });
  it("recognizes a private creation directory returned through its realpath alias", async () => {
    const f = fixture(), alias = path.join(f.root, "alias");
    symlinkSync(f.root, alias, "dir");
    f.canonicalizeCreateCwd();
    expect(await f.viewer(alias).ensure(key, f.target)).toMatchObject({ ok: true, created: true });
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
  });
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
  it("refuses unsupported platforms and different endpoints", async () => {
    const f = fixture();
    expect(await new HerdrViewer(socket, async () => { throw new Error("should not run"); }, "win32", f.root).ensure(key, f.target)).toMatchObject({ ok: false, code: "viewer_unsupported" });
    expect(await new HerdrViewer(socket, async () => JSON.stringify({ running: true, version: "0.9.5", protocol: 22, socket: "/other.sock" }), "linux", f.root).ensure(key, f.target)).toMatchObject({ ok: false });
  });
  it("a writable tile attaches, sizing, only from its one typing path; a read-only tile never attaches; recovery still attaches", () => {
    const rw = tileAttachArgv("tmux", [], "a@team", false)[2]!;
    // Both attaches are the typing path's: a plain one (also after a paste), and one that carries the first keys.
    expect(rw.match(/attach -t/g)).toEqual(['attach -t', 'attach -t']);
    expect(rw).toContain('then pz=1; put "$@"; fi;');
    expect(rw).toContain('then go "$@"; else "$@" attach -t "$t"; fi;');
    expect(rw).toContain('go() { set -- "$@" attach -t "$t";');
    // The first input's files are readable by this user alone.
    expect(rw.startsWith("umask 077;")).toBe(true);
    expect(rw.match(/open "/g)).toHaveLength(4);
    expect(rw).not.toContain("ignore-size");
    const ro = tileAttachArgv("tmux", [], "a@team", true)[2]!;
    expect(ro).toContain('open() { t=$1; shift; stty -echo -isig -ixon 2>/dev/null; view "$t" "" "$@"; };');
    expect(ro).not.toMatch(/attach -r|while use/);
    expect(ro).not.toContain("pick");
    const f = fixture(); expect(f.target.recoveryCommand).toContain("attach -t");
  });
  it("verifies a tile by its own script in the foreground, as when it views the seat, but not another seat's script", async () => {
    const f = fixture(); f.setForeground(f.target.attachArgv!);
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: true });
    const g = fixture(); g.setForeground(tileAttachArgv("/usr/bin/tmux", ["-S", "/tmp/own-tmux.sock"], "other@team", false));
    expect(await g.viewer().ensure(key, g.target)).toMatchObject({ ok: false });
    const h = fixture(); h.setForeground([...h.target.attachArgv!, "extra"]);
    expect(await h.viewer().ensure(key, h.target)).toMatchObject({ ok: false });
  });
  it("verifies a writable viewer that sized its session (no ignore-size), but not a read-only spelling", async () => {
    const f = fixture(); f.setAttachFlags([]);
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: true });
    const g = fixture(); g.setAttachFlags(["-r"]);
    expect(await g.viewer().ensure(key, g.target)).toMatchObject({ ok: false });
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
        calls++; expect(pane.readOnly).toBe(false); expect(pane.attachArgv![2]).toContain("attach -t");
        expect(await stillCurrent!()).toBe(true); return { ok: true as const, viewer: { workspaceId: "w", paneId: "p", terminalId: "t", readOnly: false }, created: true };
      } };
    const svc = new TerminalService({ viewsStore: { get: () => null, list: () => [] }, listRigSeats: () => null, listPodSeats: () => null,
      listRigNames: () => [], resolveHost: () => null, hasSession: () => true, resolveLocalTmux: () => "/usr/bin/tmux", resolveProvider: () => provider,
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

describe("viewers kept from an earlier release", () => {
  const quote = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";
  const id = JSON.stringify([key.hostId, key.nodeId]);
  const readOnlyTarget = () => composeView("qitem:qitem-root", [{ seat: "a@team", label: "a", tmuxSession: "a@team", host: null, alive: true, readOnly: true }],
    { resolveHost: () => null, localTmux: "/usr/bin/tmux", localTmuxServer: ["-S", "/tmp/own-tmux.sock"] }).opened[0]!;
  /** Rewrite the journal as an earlier release left it: that release's script for a seat, with the same tmux and server. */
  function keepFrom(f: ReturnType<typeof fixture>, make: typeof tileAttachArgv079, readOnly: boolean, session = "a@team") {
    const file = path.join(f.root, readdirSync(f.root).find(n => n.endsWith(".json"))!);
    const journal = JSON.parse(readFileSync(file, "utf8"));
    const entry = journal.entries[id];
    entry.argv = make("/usr/bin/tmux", ["-S", "/tmp/own-tmux.sock"], session, readOnly);
    entry.command = entry.argv.map(quote).join(" "); entry.readOnly = readOnly;
    writeFileSync(file, JSON.stringify(journal));
    return () => JSON.parse(readFileSync(file, "utf8")).entries[id] as { command: string; argv: string[] };
  }

  it.each([["0.7.10", tileAttachArgv0710], ["0.7.9", tileAttachArgv079], ["0.7.8", tileAttachArgv078]] as const)(
    "keeps a writable viewer recorded by %s and moves it to the current script", async (_, make) => {
      const f = fixture(); expect((await f.viewer().ensure(key, f.target)).ok).toBe(true);
      const stored = keepFrom(f, make, false);
      expect(stored().command).not.toBe(f.target.paneCommand);
      expect(await f.viewer().lookup(key, f.target)).toMatchObject({ ok: true });
      expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: true, created: false });
      expect(stored()).toMatchObject({ command: f.target.paneCommand, argv: f.target.attachArgv });
      expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
    });

  it.each([["0.7.10", tileAttachArgv0710], ["0.7.9", tileAttachArgv079], ["0.7.8", tileAttachArgv078]] as const)(
    "keeps a read-only viewer recorded by %s", async (_, make) => {
      const f = fixture(); f.setAttachFlags(["-r"]); const target = readOnlyTarget();
      expect((await f.viewer().ensure(key, target)).ok).toBe(true);
      keepFrom(f, make, true);
      expect(await f.viewer().ensure(key, target)).toMatchObject({ ok: true, created: false });
      expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
    });

  it("still holds a kept viewer for another seat, for the other mode, or under a command that isn't a tile script", async () => {
    const f = fixture(); expect((await f.viewer().ensure(key, f.target)).ok).toBe(true);
    keepFrom(f, tileAttachArgv079, false, "other@team");
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    keepFrom(f, tileAttachArgv079, true);
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    const stored = keepFrom(f, tileAttachArgv079, false);
    const file = path.join(f.root, readdirSync(f.root).find(n => n.endsWith(".json"))!);
    const journal = JSON.parse(readFileSync(file, "utf8"));
    journal.entries[id].argv[2] = "exec /usr/bin/tmux attach"; journal.entries[id].command = journal.entries[id].argv.map(quote).join(" ");
    writeFileSync(file, JSON.stringify(journal));
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    expect(stored().argv[2]).toBe("exec /usr/bin/tmux attach");
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
  });

  it("holds a kept viewer whose script only shares a tile script's opening, and leaves its saved command", async () => {
    const f = fixture(); expect((await f.viewer().ensure(key, f.target)).ok).toBe(true);
    const stored = keepFrom(f, tileAttachArgv079, false);
    const file = path.join(f.root, readdirSync(f.root).find(n => n.endsWith(".json"))!);
    const journal = JSON.parse(readFileSync(file, "utf8"));
    journal.entries[id].argv[2] = 'target=$1; shift; printf "%s\\n" "custom viewer";';
    journal.entries[id].command = journal.entries[id].argv.map(quote).join(" ");
    writeFileSync(file, JSON.stringify(journal));
    const before = stored();
    expect(await f.viewer().lookup(key, f.target)).toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    expect(await f.viewer().ensure(key, f.target)).toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    expect(stored()).toEqual(before);
  });
});
