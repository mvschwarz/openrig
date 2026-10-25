// The MCP server's operation table against the daemon itself: every registered tool named once, each tool's hints matching
// its effect, every route the table names mounted in the daemon's app, and the newest reads answering through their real
// routes with the shared error shape. The health, slice, mission and context reads also run through their real routes, so
// a daemon change to what those routes answer fails here instead of reaching an MCP client as a wrong or empty summary.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { SliceIndexer } from "../../daemon/src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../../daemon/src/domain/slices/slice-detail-projector.js";
import { ContextPackLibraryService } from "../../daemon/src/domain/context-packs/context-pack-library-service.js";
import { DaemonClient } from "../src/client.js";
import { createMcpServer, MCP_OPERATIONS } from "../src/mcp-server.js";

const HINTS = {
  read: { readOnlyHint: true },
  additive: { readOnlyHint: false, destructiveHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true },
} as const;
/** Route parameters compared by position: `:qitemId` and `:id` are the same slot. */
const shape = (route: string) => route.replace(/:[^/]+/g, ":");

describe("MCP operation table against the daemon", () => {
  let db: Database.Database;
  let home: string;
  let server: ServerType;
  let url: string;
  let routes: Array<{ method: string; path: string }>;
  let setup: ReturnType<typeof createTestApp>;
  let library: ContextPackLibraryService;
  const closers: Array<() => Promise<void>> = [];
  const saved = { home: process.env.OPENRIG_HOME, session: process.env.OPENRIG_SESSION_NAME };

  beforeEach(async () => {
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ops-"));
    process.env.OPENRIG_HOME = home;
    fs.mkdirSync(path.join(home, "missions"));
    fs.mkdirSync(path.join(home, "packs"));
    // The work tree and the context library, wired as the daemon's startup wires them.
    const sliceIndexer = new SliceIndexer({ slicesRoot: path.join(home, "missions"), dogfoodEvidenceRoot: null, db });
    library = new ContextPackLibraryService({ roots: [{ path: path.join(home, "packs"), sourceType: "user_file" }] });
    setup = createTestApp(db, { appDeps: {
      sliceIndexer, sliceDetailProjector: new SliceDetailProjector({ db, indexer: sliceIndexer }), contextPackLibrary: library,
    } });
    const { app } = setup;
    routes = app.routes;
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = saved.home;
    if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = saved.session;
  });

  async function connect() {
    const mcp = createMcpServer(new DaemonClient(url));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "operations", version: "1.0.0" });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await mcp.close(); });
    return client;
  }

  /** The test home in either spelling (macOS's /var is /private/var), wherever it appears in a tool's answer. */
  function localPathsIn(value: unknown): string[] {
    const text = JSON.stringify(value);
    return [home, fs.realpathSync(home)].filter((root) => text.includes(root));
  }

  it("names every registered tool once, with hints that match each tool's effect", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(MCP_OPERATIONS.map((op) => op.tool).sort()).toEqual(tools.map((tool) => tool.name).sort());
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    for (const op of MCP_OPERATIONS) {
      expect(hints[op.tool], op.tool).toEqual(HINTS[op.effect]);
      // Every tool says who an authenticated HTTP caller must be to be offered it.
      expect(["work", "workspace", "owner"], op.tool).toContain(op.access);
    }
  });

  it("mounts every route the table names in the daemon", () => {
    const mounted = new Set(routes.map((route) => `${route.method} ${shape(route.path)}`));
    for (const route of [...MCP_OPERATIONS.flatMap((op) => op.routes), "GET /api/rigs/summary"]) {
      const [method, routePath] = route.split(" ");
      expect(mounted.has(`${method} ${shape(routePath!)}`), route).toBe(true);
    }
  });

  it("answers rig_whoami and rig_restore_status through their real routes, with the shared error shape", async () => {
    process.env.OPENRIG_SESSION_NAME = "nobody@no-rig";
    const client = await connect();

    // The route reads the seat from ?sessionName=: a seat it doesn't manage answers 404 (a missing query would be 400).
    const who = await client.callTool({ name: "rig_whoami", arguments: {} });
    expect(who.isError).toBe(true);
    expect(who.structuredContent).toMatchObject({ ok: false, code: "http_404", status: 404 });
    expect((who.structuredContent as { message: string }).message).toContain("nobody@no-rig");

    const attempt = await client.callTool({ name: "rig_restore_status", arguments: { rigId: "01RIGNOTHERE", attemptId: 1 } });
    expect(attempt.isError).toBe(true);
    expect(attempt.structuredContent).toMatchObject({ ok: false, code: "attempt_not_found", status: 404 });
  });

  it("reads a rig's team through its real routes: the lead from the authored delegation, activity as the daemon reports it", async () => {
    const rig = setup.rigRepo.createRig("led-team");
    const lead = setup.rigRepo.addNode(rig.id, "orch.lead", { role: "orchestrator" });
    const impl = setup.rigRepo.addNode(rig.id, "dev.impl", { role: "worker" });
    setup.rigRepo.addEdge(rig.id, lead.id, impl.id, "delegates_to");
    setup.sessionRegistry.registerSession(lead.id, "orch-lead@led-team");
    const client = await connect();

    const team = await client.callTool({ name: "rig_team", arguments: { rigId: "led-team" } });
    expect(team.isError).toBeFalsy();
    const view = team.structuredContent as { lead: unknown; seats: Array<Record<string, unknown>> };
    expect(view.lead).toEqual({ session: "orch-lead@led-team", logicalId: "orch.lead" });
    const seats = Object.fromEntries(view.seats.map((seat) => [seat.logicalId as string, seat]));
    expect(seats["orch.lead"]).toMatchObject({ role: "orchestrator", session: "orch-lead@led-team", delegatesTo: ["dev.impl"], reportsTo: [] });
    expect(seats["dev.impl"]).toMatchObject({ role: "worker", reportsTo: ["orch.lead"], delegatesTo: [] });
    // Nothing has observed these seats, so their activity is unknown, never idle.
    expect(seats["dev.impl"]!.activity).toBe("unknown");
    expect(seats["orch.lead"]!.activity).toBe("unknown");
  });

  it("passes the daemon's health through rig_status, so a healthy daemon never reads as an error", async () => {
    const client = await connect();
    const health = await client.callTool({ name: "rig_status", arguments: {} });
    expect(health.isError).toBeFalsy();
    expect(JSON.parse((health.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ status: "ok" });
  });

  it("summarizes slices and a mission from the real work tree: every field it shows is filled, the page is cut and says so, and no local path leaves", async () => {
    const write = (dir: string, fm: string) => {
      fs.mkdirSync(path.join(home, "missions", dir), { recursive: true });
      fs.writeFileSync(path.join(home, "missions", dir, "README.md"), `---\n${fm}\n---\n# ${path.basename(dir)}\n`);
    };
    write("release-x", "status: active");
    write("release-x/slices/01-first", "status: active\ndescription: The first slice.");
    write("release-x/slices/02-second", "status: done");
    write("other/slices/03-other", "status: active");
    const client = await connect();

    const page = await client.callTool({ name: "rig_slices", arguments: { missionId: "release-x", limit: 1 } });
    expect(page.isError).toBeFalsy();
    expect(page.structuredContent).toMatchObject({ totalCount: 2, truncated: true });
    const shown = (page.structuredContent as { slices: Array<Record<string, unknown>> }).slices;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ missionId: "release-x", status: expect.any(String), displayName: expect.any(String), qitemCount: 0 });

    const mission = await client.callTool({ name: "rig_mission", arguments: { missionId: "release-x" } });
    expect(mission.isError).toBeFalsy();
    const view = mission.structuredContent as { missionId: string; status: unknown; slices: Array<Record<string, unknown>> };
    expect(view).toMatchObject({ missionId: "release-x", status: "active" });
    expect(Object.fromEntries(view.slices.map((slice) => [slice.name, [slice.status, slice.description]]))).toEqual({
      "01-first": ["active", "The first slice."], "02-second": ["done", null],
    });
    // A remote caller can't use this machine's paths, and the summary never sends them.
    expect(localPathsIn([page.structuredContent, mission.structuredContent])).toEqual([]);
  });

  it("reads a context pack and one of its files from the real library: names, sizes and text, without the pack's local paths", async () => {
    fs.mkdirSync(path.join(home, "packs", "team-notes"));
    fs.writeFileSync(path.join(home, "packs", "team-notes", "manifest.yaml"),
      "name: team-notes\nversion: 1\ntaxonomy: mission\npurpose: What the team decided.\nfiles:\n  - path: notes.md\n    role: source\n    summary: Decisions so far.\n");
    fs.writeFileSync(path.join(home, "packs", "team-notes", "notes.md"), "We ship the smaller inventory.\n".repeat(4));
    library.scan(); // as the daemon does at startup and after a sync
    const client = await connect();

    const pack = await client.callTool({ name: "rig_context_pack", arguments: { ref: "team-notes" } });
    expect(pack.isError).toBeFalsy();
    expect(pack.structuredContent).toEqual({
      ref: "team-notes", name: "team-notes", version: "1", purpose: "What the team decided.",
      files: [{ path: "notes.md", role: "source", summary: "Decisions so far.", estimatedTokens: 31 }],
    });

    const file = await client.callTool({ name: "rig_context_get", arguments: { address: "team-notes/notes.md" } });
    expect(file.isError).toBeFalsy();
    expect(file.structuredContent).toMatchObject({ packRef: "team-notes", filePath: "notes.md", text: "We ship the smaller inventory.\n".repeat(4) });
    expect(localPathsIn([pack.structuredContent, file.structuredContent])).toEqual([]);
  });
});
