// rig mcp serve --http against the daemon's real routes: the real HTTP listener, the SDK's own HTTP client, and grants in
// a real token file. With no grants it serves loopback as the env's seat, declared; with grants, every request needs a
// credential (loopback included), each caller acts as its own seat, reaches only its scope, and a revoked grant stops at
// the next request while its records stay.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
import { mcpCommand } from "../src/commands/mcp.js";
import { addGrant, McpHttpConfigError, revokeGrant, startMcpHttpServer, withGrantsLock } from "../src/mcp-http.js";
import { setSelfHostId } from "../../daemon/src/domain/hosts/fanout-contract.js";

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
  /** The targets the capture route resolved, in order. */
  let resolved: unknown[];
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
    // The wake store attached, as the daemon attaches it at startup: a handoff makes its successor's wake durable there.
    repo.attachOutbox(new OutboxHandler(db));
    const inert = async () => ({ ok: false, error: "inert fixture" });
    resolved = [];
    setup = createTestApp(db, {
      appDeps: {
        sessionTransport: { resolveSessions: async (target: unknown) => { resolved.push(target); return { ok: false, code: "not_found", error: "inert fixture" }; }, send: inert, capture: inert, broadcast: inert } as never,
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
    await grant("alice");
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
    const alice = await grant("alice");
    const bob = await grant("bob");
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
    const carol = await grant("carol");
    const served = await listen();
    const asCarol = await connect(served.url, carol);

    // Offered: the work loop and communication; not owner administration, and no workspace reads without that grant.
    const names = await (async () => {
      const client = new Client({ name: "lister", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(served.url), { requestInit: { headers: { Authorization: `Bearer ${carol}` } } }));
      closers.push(() => client.close());
      return (await client.listTools()).tools.map((tool) => tool.name);
    })();
    expect(names).toEqual(expect.arrayContaining(["rig_queue_create", "rig_queue_show", "rig_queue_handoff", "rig_queue_unclaim", "rig_send", "rig_capture", "rig_team", "rig_artifact_read"]));
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

  it("a hosted member works its own rows as its grant's seat, shows on the team with activity unknown, and keeps its record after revoke", async () => {
    // The team has a lead with a node. The hosted member (a tool outside any terminal) has a roster entry and a grant, no node.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-workspace-"));
    const savedWorkspace = process.env.OPENRIG_WORKSPACE_ROOT;
    process.env.OPENRIG_WORKSPACE_ROOT = workspace;
    setSelfHostId("host-a");
    try {
      seat("team", "lead");
      fs.mkdirSync(path.join(workspace, "rosters"));
      fs.writeFileSync(path.join(workspace, "rosters", "team.json"), JSON.stringify({
        version: 1, id: "team", name: "Team", purpose: "Ship the release", curator: { seat: "lead@team", host: "host-a" }, updated_at: "2026-10-26",
        members: [{ seat: "grok@team", host: "host-a", capabilities: ["web research"], engagement: ["delegate"],
          use_when: "A question needs current web sources", why: "Searches the web and cites it", caveat: "No terminal or files: answers in text only", hosted: true }],
      }));
      const token = await addGrant(tokenFile, { name: "grok", seat: "grok@team", rigs: ["team"], roots: [], workspace: false, owner: false });
      const served = await listen();
      const asGrok = await connect(served.url, token);

      const task = await repo.create({ sourceSession: "lead@team", destinationSession: "grok@team", summary: "When did 0.7.2 ship?", body: "Find the publish date, with a source.", nudge: false } as never);
      const listed = await asGrok("rig_queue_list", { owned: true });
      expect(listed.isError).toBe(false);
      expect(listed.structured.items.map((row: { qitemId: string }) => row.qitemId)).toEqual([task.qitemId]);
      expect(repo.getById(task.qitemId)?.state, "listing it doesn't take it").toBe("pending");

      expect((await asGrok("rig_queue_claim", { qitemId: task.qitemId })).isError).toBe(false);
      const claim = repo.listTransitions(task.qitemId).find((t) => t.state === "in-progress");
      expect(claim?.actorSession).toMatch(/^grok@team/);
      const answered = await asGrok("rig_queue_update", { qitemId: task.qitemId, state: "done", closureReason: "no-follow-on", resolution: "It published on 2026-10-25 (npm)." });
      expect(answered.isError).toBe(false);
      expect(repo.getById(task.qitemId)).toMatchObject({ state: "done", resolution: "It published on 2026-10-25 (npm)." });

      // Re-entry: a new connection with the same grant reaches the same work.
      const again = await connect(served.url, token);
      expect((await again("rig_queue_show", { qitemId: task.qitemId })).text).toContain("It published on 2026-10-25");

      // The team shows it: a hosted member with its authored capabilities and limits, no pane, and activity unknown, never idle.
      const team = await again("rig_team", { rigId: "team" });
      expect(team.structured.seats.map((s: { session: string }) => s.session)).toEqual(["lead@team"]);
      expect(team.structured.hostedMembers).toEqual([{ session: "grok@team", roster: "team", capabilities: ["web research"],
        useWhen: "A question needs current web sources", caveat: "No terminal or files: answers in text only", pane: null, activity: "unknown" }]);

      // Revoked: its next request is refused, and the work and its answer stay.
      expect(await revokeGrant(tokenFile, "grok")).toBe(true);
      expect((await post(served.url, { Authorization: `Bearer ${token}` })).status).toBe(401);
      expect(repo.getById(task.qitemId)).toMatchObject({ state: "done", resolution: "It published on 2026-10-25 (npm)." });
    } finally {
      setSelfHostId(null);
      if (savedWorkspace === undefined) delete process.env.OPENRIG_WORKSPACE_ROOT; else process.env.OPENRIG_WORKSPACE_ROOT = savedWorkspace;
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("stops a revoked grant at its next request and keeps its records", async () => {
    const alice = await grant("alice");
    const served = await listen();
    const asAlice = await connect(served.url, alice);
    expect((await asAlice("rig_queue_create", { destination: "impl@team", body: "before revoke" })).isError).toBe(false);
    expect(await revokeGrant(tokenFile, "alice")).toBe(true);
    const res = await post(served.url, { Authorization: `Bearer ${alice}` });
    expect(res.status).toBe(401);
    expect(rows()).toBe(1);
    // With every grant gone, auth stays configured: nothing falls back to the env seat.
    expect((await post(served.url)).status).toBe(401);
  });

  it("changes only rows its scope owns: a row its team handed elsewhere, or a person's ask, reads but doesn't update", async () => {
    const carol = await grant("carol");
    const served = await listen();
    const asCarol = await connect(served.url, carol);
    const handed = await repo.create({ sourceSession: "lead@team", destinationSession: "impl@other", body: "for the other team", nudge: false } as never);
    const ask = await repo.create({ sourceSession: "lead@team", destinationSession: "alex@external", body: "a person's pending ask", nudge: false } as never);
    for (const row of [handed, ask]) {
      expect((await asCarol("rig_queue_show", { qitemId: row.qitemId })).isError).toBe(false);
      const update = await asCarol("rig_queue_update", { qitemId: row.qitemId, state: "done", closureReason: "no-follow-on" });
      expect(update.structured).toMatchObject({ ok: false, code: "out_of_scope" });
      expect((await asCarol("rig_queue_handoff", { qitemId: row.qitemId, to: "qa@team" })).structured).toMatchObject({ ok: false, code: "out_of_scope" });
      expect((await asCarol("rig_queue_unclaim", { qitemId: row.qitemId })).structured).toMatchObject({ ok: false, code: "out_of_scope" });
      expect(repo.getById(row.qitemId)?.state).toBe("pending");
    }
    const owned = await repo.create({ sourceSession: "lead@other", destinationSession: "impl@team", body: "ours", nudge: false } as never);
    expect((await asCarol("rig_queue_update", { qitemId: owned.qitemId, note: "on it" })).isError).toBe(false);

    // Passing its own row on: never to a seat outside its scope, or to a person; within it, as its own seat.
    const before = rows();
    for (const to of ["qa@other", "alex@external"]) {
      expect((await asCarol("rig_queue_handoff", { qitemId: owned.qitemId, to })).structured).toMatchObject({ ok: false, code: "out_of_scope" });
    }
    expect(rows()).toBe(before);
    expect(repo.getById(owned.qitemId)?.state).toBe("pending");
    const handedOn = await asCarol("rig_queue_handoff", { qitemId: owned.qitemId, to: "qa@team" });
    expect(handedOn.isError).toBe(false);
    expect(repo.getById(handedOn.structured.created.qitemId)?.sourceSession).toMatch(/^carol@team/);
  });

  it("captures the rig its scope check authorized: a handle that is one rig's id and another rig's name reaches the first", async () => {
    const carol = await grant("carol");
    const team = setup.rigRepo.createRig("team");
    setup.rigRepo.createRig(team.id);
    const served = await listen();
    const asCarol = await connect(served.url, carol);
    await asCarol("rig_capture", { rig: team.id });
    expect(resolved).toEqual([{ rig: "team" }]);
  });

  it("refuses every request once its token file is gone after an authenticated start, until a restart with no file", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const alice = await grant("alice");
      const served = await listen();
      expect((await post(served.url, { Authorization: `Bearer ${alice}` })).status).toBe(200);
      fs.rmSync(tokenFile);
      for (const headers of [{}, { Authorization: `Bearer ${alice}` }]) {
        const res = await post(served.url, headers);
        expect(res.status).toBe(500);
        expect(((await res.json()) as { error: string }).error).toBe("auth_config_unreadable");
      }
      expect(rows()).toBe(0);
      expect((await listen()).authenticated).toBe(false);
    } finally {
      quiet.mockRestore();
    }
  });

  it("treats a malformed grant as an unreadable file, never acting as the env's seat, and keeps the file's text out of the reply", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(addGrant(tokenFile, { name: "erin", seat: "  ", rigs: ["team"], roots: [], workspace: false, owner: false })).rejects.toThrow(/seat/);
      expect(fs.existsSync(tokenFile)).toBe(false);
      await grant("alice");
      const served = await listen();
      const token = "orm_hand-written";
      const entry = { name: "erin", tokenSha256: createHash("sha256").update(token).digest("hex"), seat: "erin@team", rigs: ["team"], roots: [], workspace: false, owner: false, createdAt: "2026-10-23T00:00:00.000Z" };
      const { seat: _seat, ...seatless } = entry;
      for (const bad of [{ ...entry, seat: "" }, { ...entry, seat: "  " }, seatless, { ...entry, rigs: "team" }]) {
        fs.writeFileSync(tokenFile, JSON.stringify({ principals: [bad] }));
        const attempt = await connect(served.url, token).then((call) => call("rig_queue_create", { destination: "impl@team", body: "as whom?" }), (err: unknown) => err);
        expect(attempt).toBeInstanceOf(Error);
      }
      expect(rows()).toBe(0);
      fs.writeFileSync(tokenFile, "orm_leaked-secret");
      const res = await post(served.url, { Authorization: `Bearer ${token}` });
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("orm_leaked");
      expect(logged.mock.calls.flat().join("\n")).toContain("orm_leaked");
    } finally {
      logged.mockRestore();
    }
  });

  it("serializes token add and revoke: a revoke that reported success isn't undone by an add publishing its older copy", async () => {
    await grant("alice");
    let revoked!: Promise<boolean>;
    // Another token command is mid-update under the lock: it has read the file and is publishing it with a new grant.
    await withGrantsLock(tokenFile, () => {
      const read = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
      revoked = revokeGrant(tokenFile, "alice");
      read.principals.push({ ...read.principals[0], name: "bob" });
      fs.writeFileSync(tokenFile, JSON.stringify(read));
    });
    expect(await revoked).toBe(true);
    expect(JSON.parse(fs.readFileSync(tokenFile, "utf8")).principals.map((grant: { name: string }) => grant.name)).toEqual(["bob"]);
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
