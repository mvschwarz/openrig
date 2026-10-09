import { Hono } from "hono";
import fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHerdrProviders } from "../src/domain/terminal/herdr-sessions.js";
import { TerminalService } from "../src/domain/terminal/terminal-service.js";
import type { TerminalProvider } from "../src/domain/terminal/terminal-provider.js";
import { rigTerminalRoutes, terminalRoutes } from "../src/routes/terminal.js";

const servers: net.Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

type Request = { method: string; params: Record<string, unknown> };
function leaves(root: unknown): Array<{ label: string; command: string[] }> {
  if (!root || typeof root !== "object") return [];
  const node = root as { type?: string; label?: string; command?: string[]; first?: unknown; second?: unknown };
  return node.type === "pane" ? [{ label: node.label ?? "", command: node.command ?? [] }] : [...leaves(node.first), ...leaves(node.second)];
}

async function serve(socket: string): Promise<Request[]> {
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  const requests: Request[] = [];
  const panes: Array<{ pane_id: string; tab_id: string; label: string }> = [];
  let applied = 0;
  const server = net.createServer(conn => {
    conn.setEncoding("utf8"); let buffer = "";
    conn.on("data", chunk => {
      buffer += chunk;
      const end = buffer.indexOf("\n"); if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as Request & { id: string };
      requests.push({ method: request.method, params: request.params });
      let result: Record<string, unknown> = { type: "ok" };
      if (request.method === "ping") result = { type: "pong", version: "0.9.1", protocol: 14 };
      if (request.method === "workspace.create") result = { type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t0" } };
      if (request.method === "layout.apply") {
        const tab = `w1:t${++applied}`;
        for (const leaf of leaves(request.params.root)) panes.push({ pane_id: `p${panes.length}`, tab_id: tab, label: leaf.label });
        result = { type: "layout_apply", layout: { workspace_id: "w1", tab_id: tab } };
      }
      if (request.method === "pane.list") result = { type: "pane_list", panes };
      conn.end(`${JSON.stringify({ id: request.id, result })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  return requests;
}

async function fixture() {
  // Keep socket names short and inside the runner's permitted IPC directory.
  const root = fs.mkdtempSync(path.join(tmpdir(), "hs-")); roots.push(root); vi.stubEnv("HOME", root);
  const base = path.join(root, ".config", "herdr");
  const paths = { configured: path.join(root, "configured.sock"), default: path.join(base, "herdr.sock"),
    prod: path.join(base, "sessions", "prod", "herdr.sock"), stage: path.join(base, "sessions", "stage", "herdr.sock") };
  const hits = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, socket]) => [name, await serve(socket)]))) as Record<keyof typeof paths, Request[]>;
  const env = { HERDR_SOCKET_PATH: paths.configured, HERDR_SESSION: "daemon-configured" };
  const providers = createHerdrProviders(env);
  const cmux: TerminalProvider = {
    name: "cmux", status: async () => ({ provider: "cmux", available: true, capabilities: {} }), liveness: async () => ({ alive: true }),
    openView: vi.fn(async view => ({ provider: "cmux", ok: true, opened: view.opened.map(p => p.seat), absent: [], degraded: [], pages: view.pages.length })),
  };
  const rows = (rig: string) => Array.from({ length: 17 }, (_, i) => ({ canonicalSessionName: `seat-${i}@${rig}`,
    attachmentType: "tmux" as const, tmuxSession: `seat-${i}@${rig}`, rigName: rig, logicalId: `seat.${i}` }));
  const service = new TerminalService({
    resolveProvider: name => name === "herdr" ? providers.defaultProvider : name === "cmux" ? cmux : null,
    resolveSessionProvider: (name, session) => name === "herdr" ? providers.sessionProvider(session) : null,
    viewsStore: { get: () => null, list: () => [] }, listRigNames: () => ["build", "prod", "stage"],
    listRigSeats: name => ["build", "prod", "stage"].includes(name) ? rows(name) : null,
    listPodSeats: () => null, listScopeSeats: () => rows("build"), resolveHost: () => null, hasSession: () => true,
  });
  const app = new Hono(); app.use("*", async (c, next) => { c.set("terminalService" as never, service); await next(); });
  app.route("/api/terminal", terminalRoutes()); app.route("/api/rigs/:rigId/terminal", rigTerminalRoutes);
  const open = (body: unknown, route = "/api/terminal/open") => app.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, service, paths, hits, env, cmux, open };
}

const layouts = (requests: Request[]) => requests.filter(request => request.method === "layout.apply");

// Real Hono/service/provider/socket wiring, with a synthetic Herdr protocol peer.
// These checks prove endpoint routing, not desktop rendering by the Herdr app.
describe.skipIf(process.platform === "win32")("per-request Herdr session selection", () => {
  it("concurrent requests use separate sessions while the daemon's configured endpoint remains intact", async () => {
    const f = await fixture();
    f.env.HERDR_SOCKET_PATH = "/not-the-configured-socket"; f.env.HERDR_SESSION = "changed-after-startup";
    const responses = await Promise.all([
      f.open({ view: "build" }), f.open({ view: "prod", session: "prod" }), f.open({ view: "stage", session: "stage" }),
    ]);
    const results = await Promise.all(responses.map(response => response.json()));
    expect(results[0]).toMatchObject({ ok: true, pages: 2 }); expect(results[0].session).toBeUndefined();
    expect(results[1]).toMatchObject({ ok: true, session: "prod", pages: 2 });
    expect(results[2]).toMatchObject({ ok: true, session: "stage", pages: 2 });
    for (const [endpoint, rig] of [["configured", "build"], ["prod", "prod"], ["stage", "stage"]] as const) {
      const applied = layouts(f.hits[endpoint]); expect(applied).toHaveLength(2);
      const commands = applied.flatMap(request => leaves(request.params.root)).filter(leaf => leaf.label).map(leaf => leaf.command.join(" "));
      expect(commands).toHaveLength(17);
      expect(commands.every(command => command.includes(`@${rig}'`))).toBe(true);
    }
    expect(f.hits.default).toEqual([]);
  });

  it("preview is passive and its fingerprint cannot authorize another session", async () => {
    const f = await fixture();
    const preview = await (await f.app.request("/api/terminal/preview?view=prod&provider=herdr&session=prod")).json();
    expect(preview).toMatchObject({ session: "prod", status: { launch: { session: "prod", socketPath: f.paths.prod } } });
    expect(f.hits.prod.every(request => request.method === "ping")).toBe(true);
    expect((await f.open({ view: "prod", session: "stage", expectedPlan: preview.planId })).status).toBe(409);
    expect(f.hits.stage).toEqual([]);
    expect((await f.open({ view: "prod", expectedPlan: preview.planId })).status).toBe(409);
    expect(f.hits.configured).toEqual([]);
    expect(await (await f.open({ view: "prod", session: " prod ", expectedPlan: preview.planId })).json()).toMatchObject({ ok: true, session: "prod" });
  });

  it("explicit default overrides the daemon's custom endpoint and status inspects the selected socket", async () => {
    const f = await fixture();
    expect(await (await f.open({ view: "build", session: "default" })).json()).toMatchObject({ ok: true, session: "default" });
    expect(layouts(f.hits.default)).toHaveLength(2); expect(f.hits.configured).toEqual([]);
    expect(await (await f.app.request("/api/terminal/status?session=prod")).json()).toMatchObject({ session: "prod",
      providers: [{ name: "herdr", status: { launch: { session: "prod", socketPath: f.paths.prod } }, liveness: { alive: true } }] });
    expect(f.hits.prod.every(request => request.method === "ping")).toBe(true);
  });

  it("an unavailable named session never falls back to a live default session", async () => {
    const f = await fixture();
    const response = await f.open({ view: "prod", session: "missing" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, session: "missing", code: "herdr_unavailable", opened: [] });
    expect(f.hits.configured).toEqual([]); expect(f.hits.default).toEqual([]);
  });

  it("rejects malformed names, unsupported providers and typed body errors before any socket call", async () => {
    const f = await fixture();
    for (const session of [null, 12, {}, "", "  ", ".", "..", "../prod", "prod/child", "prod\\child", "p\nq"]) {
      expect((await f.open({ view: "prod", session })).status).toBe(400);
    }
    expect((await f.open({ view: "prod", provider: "cmux", session: "prod" })).status).toBe(400);
    expect((await f.app.request("/api/terminal/status?provider=cmux&session=prod")).status).toBe(400);
    expect((await f.app.request("/api/terminal/preview?view=prod&session=..%2Fprod")).status).toBe(400);
    expect(Object.values(f.hits).flat()).toEqual([]); expect(f.cmux.openView).not.toHaveBeenCalled();
  });

  it("the rig alias carries the selection and preview binding to the same composer", async () => {
    const f = await fixture();
    const preview = await f.service.previewView({ view: "rig:prod", session: "prod" });
    if (!("planId" in preview)) throw new Error("Expected preview");
    const result = await f.open({ view: "build", provider: "herdr", session: "prod", expectedPlan: preview.planId }, "/api/rigs/prod/terminal/open");
    expect(await result.json()).toMatchObject({ ok: true, session: "prod", pages: 2 });
    expect(f.hits.configured).toEqual([]); expect(layouts(f.hits.prod)).toHaveLength(2);
    expect((await f.open({ session: 42 }, "/api/rigs/prod/terminal/open")).status).toBe(400);
  });
});
