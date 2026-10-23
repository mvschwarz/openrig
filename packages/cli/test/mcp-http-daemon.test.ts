// rig mcp serve --http against the daemon's real routes: the real HTTP listener, the SDK's own HTTP client, and grants in
// a real token file. With no grants it serves loopback as the env's seat, declared; with grants, every request needs a
// credential (loopback included), each caller acts as its own seat, reaches only its scope, and a revoked grant stops at
// the next request while its records stay.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type Database from "better-sqlite3";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { mcpCommand } from "../src/commands/mcp.js";
import { addGrant, McpHttpConfigError, revokeGrant, startMcpHttpServer } from "../src/mcp-http.js";

const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } };

describe("rig mcp serve --http on the daemon's routes", () => {
  let db: Database.Database;
  let home: string;
  let shared: string;
  let repo: QueueRepository;
  let daemon: ServerType;
  let daemonUrl: string;
  let tokenFile: string;
  let setup: ReturnType<typeof createTestApp>;
  const closers: Array<() => Promise<void>> = [];
  const saved = { home: process.env.OPENRIG_HOME, session: process.env.OPENRIG_SESSION_NAME };

  beforeEach(async () => {
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-"));
    shared = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-shared-")));
    process.env.OPENRIG_HOME = home;
    // The env seat a local caller is declared as; an authenticated caller must never act as it.
    process.env.OPENRIG_SESSION_NAME = "env-seat@elsewhere";
    tokenFile = path.join(home, "mcp-http-tokens.json");
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const inert = async () => ({ ok: false, error: "inert fixture" });
    setup = createTestApp(db, {
      appDeps: {
        sessionTransport: { resolveSessions: async () => ({ ok: false, code: "not_found", error: "inert fixture" }), send: inert, capture: inert, broadcast: inert } as never,
        queueRepo: repo,
        filesAllowlist: [{ name: "proof", canonicalPath: shared }],
      },
    });
    const { app } = setup;
    daemon = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(shared, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = saved.home;
    if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = saved.session;
  });

  async function listen() {
    const served = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile });
    closers.push(() => served.close());
    return served;
  }

  /** An MCP client over HTTP, sending this token (none: no Authorization header). */
  async function connect(url: string, token?: string) {
    const transport = new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(transport);
    closers.push(() => client.close());
    return async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, structured: result.structuredContent as Record<string, any>, text: (result.content as Array<{ text: string }>)[0]?.text ?? "" };
    };
  }

  const post = (url: string, headers: Record<string, string> = {}) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(INITIALIZE),
  });
  /** A managed seat the daemon's whoami can answer for. */
  const seat = (rigName: string, member: string) => {
    const rig = setup.rigRepo.listRigs?.().find((r: { name: string }) => r.name === rigName) ?? setup.rigRepo.createRig(rigName);
    const node = setup.rigRepo.addNode(rig.id, `pod.${member}`, { role: "worker" });
    setup.sessionRegistry.registerSession(node.id, `${member}@${rigName}`);
  };
  const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
  const grant = (name: string, extra: Partial<{ rigs: string[]; roots: string[]; workspace: boolean; owner: boolean }> = {}) =>
    addGrant(tokenFile, { name, seat: `${name}@team`, rigs: ["team"], roots: [], workspace: false, owner: false, ...extra });

  it("with no grants serves loopback as the env's seat, declared and not authenticated, and refuses to bind beyond loopback", async () => {
    seat("elsewhere", "env-seat");
    const served = await listen();
    expect(served.authenticated).toBe(false);
    const local = await connect(served.url);
    expect((await local("rig_whoami")).text).toContain("\"identity\":\"declared\"");
    const created = await local("rig_queue_create", { destination: "impl@team", body: "local work" });
    expect(created.isError).toBe(false);
    expect((db.prepare("SELECT source_session FROM queue_items").get() as { source_session: string }).source_session).toMatch(/^env-seat@elsewhere/);

    await expect(startMcpHttpServer({ daemonUrl, host: "0.0.0.0", port: 0, tokenFile })).rejects.toBeInstanceOf(McpHttpConfigError);
  });

  it("with grants, refuses a missing or invalid credential on loopback, never as the env's seat", async () => {
    grant("alice");
    const served = await listen();
    expect(served.authenticated).toBe(true);
    for (const headers of [{}, { Authorization: "Bearer orm_not-a-token" }, { Authorization: "Basic abc" }]) {
      const res = await post(served.url, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
    }
    expect(rows()).toBe(0);
  });

  it("keeps two concurrent callers apart: each acts as its own grant's seat, never the env's", async () => {
    const alice = grant("alice");
    const bob = grant("bob");
    seat("team", "bob");
    const served = await listen();
    const [asAlice, asBob] = await Promise.all([connect(served.url, alice), connect(served.url, bob)]);
    const [a, b] = await Promise.all([
      asAlice("rig_queue_create", { destination: "impl@team", body: "from alice" }),
      asBob("rig_queue_create", { destination: "impl@team", body: "from bob" }),
    ]);
    const source = (id: string) => (db.prepare("SELECT source_session FROM queue_items WHERE qitem_id = ?").get(id) as { source_session: string }).source_session;
    expect(source(a.structured.qitemId)).toMatch(/^alice@team/);
    expect(source(b.structured.qitemId)).toMatch(/^bob@team/);
    const who = await asBob("rig_whoami");
    expect(who.text).toContain("\"principal\":\"bob\"");
  });

  it("reaches only its scope: an out-of-scope write creates nothing, and items, successors, artifacts and owner tools stay out of reach", async () => {
    const carol = grant("carol");
    const served = await listen();
    const asCarol = await connect(served.url, carol);

    // Offered: the work loop and communication; not owner administration, and no workspace reads without that grant.
    const names = await (async () => {
      const client = new Client({ name: "lister", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(served.url), { requestInit: { headers: { Authorization: `Bearer ${carol}` } } }));
      closers.push(() => client.close());
      return (await client.listTools()).tools.map((tool) => tool.name);
    })();
    expect(names).toEqual(expect.arrayContaining(["rig_queue_create", "rig_queue_show", "rig_send", "rig_capture", "rig_team", "rig_artifact_read"]));
    for (const ownerTool of ["rig_up", "rig_down", "rig_restore", "rig_discover", "rig_add", "rig_bundle_inspect", "rig_telemetry_events", "rig_context_get"]) {
      expect(names).not.toContain(ownerTool);
    }

    const before = rows();
    const denied = await asCarol("rig_queue_create", { destination: "impl@other", body: "not mine to send" });
    expect(denied.structured).toMatchObject({ ok: false, code: "out_of_scope" });
    expect(rows()).toBe(before);
    expect((await asCarol("rig_queue_create", { destination: "alex@external", body: "a person" })).structured).toMatchObject({ code: "out_of_scope" });
    expect((await asCarol("rig_send", { session: "impl@other", text: "hi" })).structured).toMatchObject({ code: "out_of_scope" });

    const foreign = await repo.create({ sourceSession: "lead@other", destinationSession: "impl@other", body: "SECRET other-team work", nudge: false } as never);
    const shown = await asCarol("rig_queue_show", { qitemId: foreign.qitemId });
    expect(shown.structured).toMatchObject({ code: "out_of_scope" });
    expect(shown.text).not.toContain("SECRET");
    expect((await asCarol("rig_queue_update", { qitemId: foreign.qitemId, state: "done", closureReason: "no-follow-on" })).structured).toMatchObject({ code: "out_of_scope" });
    const listed = await asCarol("rig_queue_list", { all: true, destination: "impl@team" });
    expect(JSON.stringify(listed.structured)).not.toContain("SECRET");

    // Its own task, handed on to another team's seat: the successor isn't revealed.
    const own = (await asCarol("rig_queue_create", { destination: "impl@team", body: "hand this on" })).structured.qitemId as string;
    const handoff = await fetch(`${daemonUrl}/api/queue/${own}/handoff`, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "impl@team" }, body: JSON.stringify({ toSession: "qa@other", nudge: false }) });
    expect(handoff.status).toBe(201);
    expect((await asCarol("rig_queue_show", { qitemId: own })).structured.successor).toEqual({ unknown: true, code: "out_of_scope" });

    // Artifacts: a root outside the grant is out of reach, directly or through an item.
    fs.writeFileSync(path.join(shared, "report.md"), "ARTIFACT body");
    expect((await asCarol("rig_artifact_read", { root: "proof", path: "report.md" })).structured).toMatchObject({ code: "out_of_scope" });
    const withRef = await repo.create({ sourceSession: "carol@team", destinationSession: "impl@team", body: "x", nudge: false } as never);
    db.prepare("UPDATE queue_items SET evidence_ref = ? WHERE qitem_id = ?").run(path.join(shared, "report.md"), withRef.qitemId);
    const viaItem = await asCarol("rig_artifact_read", { qitemId: withRef.qitemId });
    expect(viaItem.structured).toMatchObject({ available: false, roots: [] });
    expect(viaItem.text).not.toContain("ARTIFACT body");
  });

  it("stops a revoked grant at its next request and keeps its records", async () => {
    const alice = grant("alice");
    const served = await listen();
    const asAlice = await connect(served.url, alice);
    expect((await asAlice("rig_queue_create", { destination: "impl@team", body: "before revoke" })).isError).toBe(false);
    expect(revokeGrant(tokenFile, "alice")).toBe(true);
    const res = await post(served.url, { Authorization: `Bearer ${alice}` });
    expect(res.status).toBe(401);
    expect(rows()).toBe(1);
    // With every grant gone, auth stays configured: nothing falls back to the env seat.
    expect((await post(served.url)).status).toBe(401);
  });

  it("rig mcp token add, list and revoke: the token is shown once and only its hash is kept, in a file only its owner reads", async () => {
    const run = async (args: string[]) => {
      const out: string[] = [];
      const log = console.log;
      console.log = (...line: unknown[]) => { out.push(line.join(" ")); };
      try { await mcpCommand().parseAsync(["token", ...args], { from: "user" }); } finally { console.log = log; }
      return out.join("\n");
    };
    const added = await run(["add", "dana", "--seat", "dana@team", "--rig", "team", "--root", "proof"]);
    const token = added.split("\n")[1]!;
    expect(token).toMatch(/^orm_/);
    const stored = fs.readFileSync(tokenFile, "utf8");
    expect(stored).not.toContain(token);
    expect(JSON.parse(stored).principals[0]).toMatchObject({ name: "dana", seat: "dana@team", rigs: ["team"], roots: ["proof"], owner: false });
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    const listed = await run(["list"]);
    expect(listed).toContain("dana: seat dana@team");
    expect(listed).not.toContain(JSON.parse(stored).principals[0].tokenSha256);
    expect(await run(["revoke", "dana"])).toContain("Revoked dana");
    expect(JSON.parse(fs.readFileSync(tokenFile, "utf8")).principals).toEqual([]);
  });
});
