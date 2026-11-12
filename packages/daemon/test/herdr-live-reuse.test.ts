// #3052 — `rig terminal open <view> --provider herdr` reuses a workspace that still shows the view live,
// the same check `--window` makes. A real HerdrAdapter over an in-memory Herdr: one state answers both the
// socket transport and the Herdr CLI the check reads, and a fake tmux lists the clients. These prove what
// the adapter reads and decides; they do not prove a live Herdr server's replies.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { HerdrAdapter } from "../src/domain/terminal/herdr-adapter.js";
import { composeView } from "../src/domain/terminal/view-composer.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import { terminalRoutes } from "../src/routes/terminal.js";
import type { HerdrResult, HerdrTransport } from "../src/domain/terminal/herdr-transport.js";
import type { ComposedView, OpenViewOptions, OpenViewResult, TerminalProvider } from "../src/domain/terminal/terminal-provider.js";

const TMUX = "/fixture/bin/tmux";
const SERVER = ["-S", "/private/openrig instance.sock"];
const SEATS = ["operator", "advisor"];
const planId = "0123456789abcdef".repeat(4);

function demoView(): ComposedView {
  const composed = composeView("demo", SEATS.map(seat => ({ seat, label: seat, tmuxSession: `fixture-${seat}`, host: null, readOnly: false, alive: true })),
    { resolveHost: () => null, localTmux: TMUX, localTmuxServer: SERVER });
  return { ...composed, planId };
}

type Tab = { workspace_id: string; tab_id: string; label: string };
type Pane = { workspace_id: string; tab_id: string; pane_id: string; label: string };
const leafLabels = (node: any): string[] => !node || typeof node !== "object" ? []
  : node.type === "pane" ? [String(node.label ?? "")] : [...leafLabels(node.first), ...leafLabels(node.second)];

/** One Herdr: the socket the adapter drives, the CLI the reuse check reads, and the tmux clients attached to seats. */
function herdr() {
  const workspaces: Array<{ workspace_id: string; label: string }> = [];
  const tabs: Tab[] = [];
  const panes: Pane[] = [];
  const socket: string[] = [];
  const cli: string[][] = [];
  const state: { attached: boolean; focus: "ok" | "throws" | "other-tab" } = { attached: true, focus: "ok" };
  const transport: HerdrTransport = {
    probe: async () => ({ alive: true, version: "0.9.5", protocol: 22 }),
    request: async (method, raw): Promise<HerdrResult> => {
      const params = raw as Record<string, unknown>;
      socket.push(method);
      if (method === "workspace.list") return { type: "workspace_list", workspaces };
      if (method === "workspace.create") {
        const workspace_id = `w${workspaces.length + 1}`;
        workspaces.push({ workspace_id, label: String(params["label"] ?? "") });
        tabs.push({ workspace_id, tab_id: `${workspace_id}:t0`, label: "1" });
        return { type: "workspace_created", workspace: { workspace_id }, tab: { tab_id: `${workspace_id}:t0` } };
      }
      if (method === "layout.apply") {
        const workspace_id = String(params["workspace_id"]);
        const tab_id = `${workspace_id}:t${tabs.filter(tab => tab.workspace_id === workspace_id).length}`;
        tabs.push({ workspace_id, tab_id, label: String(params["tab_label"]) });
        for (const label of leafLabels(params["root"])) panes.push({ workspace_id, tab_id, pane_id: `${tab_id}-${label}`, label });
        return { type: "layout_apply", layout: { workspace_id, tab_id } };
      }
      if (method === "pane.list") return { type: "pane_list", panes: panes.filter(pane => pane.workspace_id === params["workspace_id"]) };
      if (method === "tab.close") tabs.splice(tabs.findIndex(tab => tab.tab_id === params["tab_id"]), 1);
      if (method === "tab.focus") {
        if (state.focus === "throws") throw new Error("tab not found");
        const tab = tabs.find(t => t.tab_id === params["tab_id"]);
        const other = state.focus === "other-tab" ? tabs.find(t => t.tab_id !== params["tab_id"]) : tab;
        return { type: "tab_focused", tab: { tab_id: other?.tab_id, workspace_id: other?.workspace_id } };
      }
      return { type: "ok" };
    },
  };
  const pid = (paneId: string) => 101 + SEATS.findIndex(seat => paneId.endsWith(`-${seat}`));
  const liveWorkspace = {
    herdr: async (args: string[]) => {
      cli.push(args);
      const [noun, verb, , id] = args;
      if (noun === "workspace" && verb === "list") return JSON.stringify({ result: { workspaces } });
      if (noun === "tab" && verb === "list") return JSON.stringify({ result: { tabs: tabs.filter(tab => tab.workspace_id === id) } });
      if (noun === "pane" && verb === "list") return JSON.stringify({ result: { panes: panes.filter(pane => pane.workspace_id === id).map(({ label: _, ...pane }) => pane) } });
      if (noun === "pane" && verb === "process-info") return JSON.stringify({ result: { process_info: { pane_id: id, foreground_processes: [{ pid: pid(id!) }] } } });
      throw new Error(`unexpected herdr ${args.join(" ")}`);
    },
    exec: async (file: string, args: string[]) => {
      if (file === "/bin/sh" && args[1] === "command -v tmux") return `${TMUX}\n`;
      if (file === TMUX && args.join(" ") === [...SERVER, "list-clients", "-F", "#{client_pid}\t#{session_name}\t#{client_readonly}"].join(" ")) {
        return state.attached ? SEATS.map((seat, i) => `${101 + i}\tfixture-${seat}\t0`).join("\n") : "";
      }
      throw new Error(`unexpected exec ${file} ${args.join(" ")}`);
    },
  };
  let token = 0;
  const adapter = new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => `l${++token}`, liveWorkspace });
  return { adapter, workspaces, socket, cli, state };
}

describe("#3052 --provider herdr reuses a live workspace for the same view", () => {
  it("focuses the workspace that still shows every tile, instead of creating a numbered copy", async () => {
    const h = herdr();
    const first = await h.adapter.openView(demoView(), { reuseLive: true });
    expect(first).toMatchObject({ ok: true, opened: SEATS, pages: 1 });
    expect(first.reusedWorkspace).toBeUndefined();
    h.socket.length = 0;

    const second = await h.adapter.openView(demoView(), { reuseLive: true });
    expect(second).toMatchObject({ provider: "herdr", ok: true, opened: [], pages: 0, reusedWorkspace: { id: "w1", tabId: "w1:t1", view: "demo" } });
    expect(second.notes).toEqual(["Workspace w1 already shows this view with live attachments, so it was reused; its contents were kept and no new tiles were opened."]);
    expect(h.workspaces.map(ws => ws.label)).toEqual(["demo"]);
    expect(h.socket).toEqual(["tab.focus"]);
  });

  it.each(["throws", "other-tab"] as const)("opens a fresh workspace when herdr's focus %s, and names the one it kept", async (focus) => {
    // PR 3068 review: an unconfirmed focus is one more uncertain branch, never a failed open
    const h = herdr();
    await h.adapter.openView(demoView(), { reuseLive: true });
    h.state.focus = focus;
    const second = await h.adapter.openView(demoView(), { reuseLive: true });
    expect(second).toMatchObject({ ok: true, opened: SEATS, pages: 1 });
    expect(second.reusedWorkspace).toBeUndefined();
    expect(second.notes?.[0]).toMatch(/^Workspace w1 already shows this view, but herdr did not confirm focusing its tab w1:t1( \(.+\))?; it was kept\.$/);
    expect(h.workspaces.map(ws => ws.label)).toEqual(["demo", "demo (2)"]);
  });

  it("opens a new, numbered workspace when the existing one's tiles aren't attached, and names the one it kept", async () => {
    const h = herdr();
    await h.adapter.openView(demoView(), { reuseLive: true });
    h.state.attached = false;

    const second = await h.adapter.openView(demoView(), { reuseLive: true });
    expect(second.reusedWorkspace).toBeUndefined();
    expect(second).toMatchObject({ ok: true, opened: SEATS, pages: 1 });
    expect(h.workspaces.map(ws => ws.label)).toEqual(["demo", "demo (2)"]);
    expect(second.notes).toEqual([
      // CodeRabbit (PR 3068): the kept-workspace note claims nothing about this open; the creation says so itself
      "Workspace w1 has this view, but its tiles' live attachments could not be confirmed, so it was kept.",
      'A view named "demo" is already open, so this one is "demo (2)".',
    ]);
  });

  it("an unreadable Herdr inventory opens a new workspace and says why", async () => {
    const broken = new HerdrAdapter({ transportFactory: () => ({ probe: async () => ({ alive: true, version: "0.9.5", protocol: 22 }),
      request: async (method) => method === "workspace.create" ? { type: "c", workspace: { workspace_id: "w9" } } : { type: "ok" } }),
    liveWorkspace: { herdr: async () => "not json", exec: async () => "" } });
    const result = await broken.openView(demoView(), { reuseLive: true });
    expect(result.reusedWorkspace).toBeUndefined();
    expect(result.notes?.[0]).toMatch(/^Could not check existing Herdr workspaces \(.+\); this open adds a new workspace and keeps the existing ones\.$/);
  });

  it("without reuseLive an open never reads the inventory and still adds a workspace (the --window and UI path)", async () => {
    const h = herdr();
    await h.adapter.openView(demoView());
    const second = await h.adapter.openView(demoView());
    expect(second.reusedWorkspace).toBeUndefined();
    expect(h.workspaces.map(ws => ws.label)).toEqual(["demo", "demo (2)"]);
    expect(h.cli).toEqual([]);
  });
});

class RecordingHerdr implements TerminalProvider {
  readonly name = "herdr";
  calls: Array<OpenViewOptions | undefined> = [];
  async status() { return { provider: this.name, available: true, capabilities: {} }; }
  async liveness() { return { alive: true }; }
  async openView(view: ComposedView, options?: OpenViewOptions): Promise<OpenViewResult> {
    this.calls.push(options);
    return { provider: this.name, ok: true, opened: [], absent: view.absent, degraded: view.degraded, pages: 0,
      reusedWorkspace: { id: "w1", tabId: "w1:t1", view: view.id } };
  }
}

describe("#3052 the open request carries reuseLive to the provider", () => {
  const rows = SEATS.map(seat => ({ canonicalSessionName: `${seat}@demo`, attachmentType: "tmux" as const, tmuxSession: `${seat}@demo`, rigName: "demo", logicalId: `pod.${seat}` }));
  const setup = () => {
    const provider = new RecordingHerdr();
    const svc = new TerminalService({
      resolveProvider: (n: string) => (n === "herdr" ? provider : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigSeats: (r: string) => (r === "demo" ? rows : null),
      listPodSeats: () => null,
      listRigNames: () => ["demo"],
      resolveHost: () => null,
      hasSession: () => true,
    } as unknown as TerminalServiceDeps);
    const app = new Hono();
    app.use("*", async (c, next) => { (c.set.bind(c) as (k: string, v: unknown) => void)("terminalService", svc); await next(); });
    app.route("/api/terminal", terminalRoutes());
    const open = (body: unknown) => app.request("/api/terminal/open", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { provider, open };
  };

  it("passes reuseLive through, and a reused view gets no attach-by-hand commands", async () => {
    const { provider, open } = setup();
    const res = await open({ view: "rig:demo", provider: "herdr", reuseLive: true });
    const body = await res.json() as OpenViewResult;
    expect(res.status).toBe(200);
    expect(provider.calls).toEqual([{ reuseLive: true }]);
    expect(body.reusedWorkspace).toEqual({ id: "w1", tabId: "w1:t1", view: "rig:demo" });
    expect(body.notes?.some(note => note.includes("attach directly"))).toBe(false);
  });

  it("a request without reuseLive (or with a non-true value) asks for nothing", async () => {
    const { provider, open } = setup();
    await open({ view: "rig:demo", provider: "herdr" });
    await open({ view: "rig:demo", provider: "herdr", reuseLive: "yes" });
    expect(provider.calls).toEqual([undefined, undefined]);
  });
});
