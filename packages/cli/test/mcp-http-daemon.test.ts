// rig mcp serve --http against the daemon's real routes: the real HTTP listener, the SDK's own HTTP client, and grants in
// a real token file. With no grants it serves loopback as the env's seat, declared; with grants, every request needs a
// credential (loopback included), each caller acts as its own seat, reaches only its scope, and a revoked grant stops at
// the next request while its records stay.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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
import { MissionControlWriteContract } from "../../daemon/src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../../daemon/src/domain/mission-control/mission-control-action-log.js";
import { loadHumanRegistry, type HumanFragment } from "../../daemon/src/domain/gateway/human-registry.js";
import { makeQueuePorts } from "../../daemon/src/domain/gateway/slack/queue-access.js";
import { buildOutboundMessage } from "../../daemon/src/domain/gateway/slack/message.js";
import { subsystemSlackDeliver } from "../../daemon/src/domain/gateway/slack/slack-delivery.js";
import { toPayload } from "../../daemon/src/domain/gateway/slack/outbound-driver.js";
import { SeenStore } from "../../daemon/src/domain/gateway/slack/state-store.js";
import type { FetchImpl } from "../../daemon/src/domain/gateway/slack/slack-api.js";
import { mcpCommand } from "../src/commands/mcp.js";
import { addGrant, McpHttpConfigError, revokeGrant, startMcpHttpServer, withGrantsLock, rotateGrant, type McpHttpOptions } from "../src/mcp-http.js";
import { setSelfHostId } from "../../daemon/src/domain/hosts/fanout-contract.js";
import { DaemonClient } from "../src/client.js";

const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } };

describe("rig mcp serve --http on the daemon's routes", () => {
  let db: Database.Database;
  let home: string;
  let shared: string;
  let otherShared: string;
  let repo: QueueRepository;
  let bus: EventBus;
  /** Registered people a test sets; null reads the instance's registry, as the daemon does. */
  let people: HumanFragment[] | null;
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
    otherShared = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-acct-b-")));
    process.env.OPENRIG_HOME = home;
    // The env seat a local caller is declared as; an authenticated caller must never act as it.
    process.env.OPENRIG_SESSION_NAME = "env-seat@elsewhere";
    tokenFile = path.join(home, "mcp-http-tokens.json");
    bus = new EventBus(db);
    people = null;
    repo = new QueueRepository(db, bus, { validateRig: () => true,
      loadHumanRegistry: () => (people ? { ok: true as const, entities: people } : loadHumanRegistry()) });
    // The wake store attached, as the daemon attaches it at startup: a handoff makes its successor's wake durable there.
    repo.attachOutbox(new OutboxHandler(db));
    const inert = async () => ({ ok: false, error: "inert fixture" });
    resolved = [];
    setup = createTestApp(db, {
      appDeps: {
        sessionTransport: { resolveSessions: async (target: unknown) => { resolved.push(target); return { ok: false, code: "not_found", error: "inert fixture" }; }, send: inert, capture: inert, broadcast: inert } as never,
        queueRepo: repo,
        // Two shared roots, as one daemon serving two accounts has: proof, and another account's acct-b.
        filesAllowlist: [{ name: "proof", canonicalPath: shared }, { name: "acct-b", canonicalPath: otherShared }],
      },
    });
    const { app } = setup;
    daemon = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setSelfHostId(null);
    for (const close of closers.splice(0).reverse()) await close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(shared, { recursive: true, force: true });
    fs.rmSync(otherShared, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = saved.home;
    if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = saved.session;
  });

  async function listen(options: Partial<McpHttpOptions> = {}) {
    const served = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile, ...options });
    closers.push(() => served.close());
    return served;
  }

  /** An MCP client over HTTP, sending this token (none: no Authorization header). */
  async function connect(url: string, token?: string) {
    const transport = new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(transport);
    closers.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, structured: result.structuredContent as Record<string, any>, text: (result.content as Array<{ text: string }>)[0]?.text ?? "" };
    };
    return Object.assign(call, { client });
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

  it("serves caller-scoped coordination resources to a local read-only token without an extension", async () => {
    seat("team", "reader");
    const token = await addGrant(tokenFile, { name: "reader", seat: "reader@team", rigs: ["team"], roots: [],
      workspace: false, owner: false, readOnly: true });
    const served = await listen();
    const call = await connect(served.url, token);
    const uri = "openrig://reference/coordination";
    expect((await call.client.listResources()).resources.map(resource => resource.uri)).toEqual([uri]);
    const reference = await call.client.readResource({ uri });
    expect(reference.contents[0]).toMatchObject({ uri, mimeType: "text/plain", text: call.client.getInstructions() });
    expect(call.client.getInstructions()).toContain("read operations only");
    expect(call.client.getInstructions()).not.toContain("rig_queue_create");
    expect((await call.client.listTools()).tools.map(tool => tool.name)).not.toContain("rig_queue_create");
  });

  it("passes endpoint-owned instructions through the resolver while the Core reference follows each caller", async () => {
    setSelfHostId("instruction-resource-fixture");
    seat("team", "reader"); seat("team", "writer");
    const guideUri = "embedding://team/guide";
    const served = await listen({
      instructions: { introduction: "Read this endpoint's guide.", resources: [
        { uri: guideUri, name: "team-guide", mimeType: "text/plain", text: "A configured team guide" },
      ] },
      resolver: async ({ bearer }) => {
        if (bearer !== "reader" && bearer !== "writer") return { ok: false, refusal: "unknown" };
        return { ok: true, seat: `${bearer}@team`, principal: { source: "embedding", id: bearer },
          access: { principal: bearer, owner: false, rigs: ["team"], roots: [], workspace: false }, readOnly: bearer === "reader" };
      },
    });
    const reader = (await connect(served.url, "reader")).client;
    const writer = (await connect(served.url, "writer")).client;
    for (const client of [reader, writer]) {
      expect(client.getInstructions()).toContain("Read this endpoint's guide.");
      expect(await client.readResource({ uri: guideUri })).toEqual({
        contents: [{ uri: guideUri, mimeType: "text/plain", text: "A configured team guide" }],
      });
    }
    const readerCore = (await reader.readResource({ uri: "openrig://reference/coordination" })).contents[0] as { text: string };
    const writerCore = (await writer.readResource({ uri: "openrig://reference/coordination" })).contents[0] as { text: string };
    expect(readerCore.text).toContain("read operations only");
    expect(readerCore.text).not.toContain("rig_queue_create");
    expect(writerCore.text).not.toContain("read operations only");
    expect(writerCore.text).not.toBe(readerCore.text);
    expect(readerCore.text).not.toContain("Read this endpoint's guide.");
    expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain("rig_queue_create");
    expect((await writer.listTools()).tools.map(tool => tool.name)).toContain("rig_queue_create");
  });

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

  it("with no grants and no seat, every request writes as the process's one unknown sender, and a same-id retry matches", async () => {
    delete process.env.OPENRIG_SESSION_NAME;
    const served = await listen();
    const local = await connect(served.url);
    // Each request gets its own server here, so a label minted per server would differ on every call below.
    const label = (await local("rig_whoami")).structured.unknownSender as string;
    expect(label).toMatch(/^unknown-mcp-[0-9a-f]{8}$/);
    for (const body of ["first", "second"]) expect((await local("rig_queue_create", { destination: "impl@team", body })).isError).toBe(false);
    const retry = { qitemId: "qitem-20261107000000-unknownretry", destination: "impl@team", body: "once" };
    expect((await local("rig_queue_create", retry)).isError).toBe(false);
    const again = await local("rig_queue_create", retry);
    expect(again.isError, again.text).toBe(false);
    expect(rows()).toBe(3);
    expect((db.prepare("SELECT DISTINCT source_session AS s FROM queue_items").all() as Array<{ s: string }>).map((row) => row.s)).toEqual([label]);
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

  it("tells the daemon which grant's caller acted: concurrent callers' rows each carry their own principal, never one a caller sends", async () => {
    // This host's own daemon, provably: the id it minted (read from its database) is the id its /healthz answers with.
    const identity = path.join(home, "identity.sqlite");
    const idDb = createDb(identity);
    idDb.exec("CREATE TABLE self_host_identity (singleton INTEGER PRIMARY KEY, host_id TEXT)");
    idDb.prepare("INSERT INTO self_host_identity VALUES (1, 'test-host')").run();
    idDb.close();
    vi.stubEnv("OPENRIG_DB", identity);
    setSelfHostId("test-host");
    closers.push(async () => { setSelfHostId(null); vi.unstubAllEnvs(); });
    const alice = await grant("alice");
    const bob = await grant("bob");
    const served = await listen();
    // A caller's own X-OpenRig-Principal goes no further than this server: the daemon hears the grant's principal.
    const forged = { "X-OpenRig-Principal": JSON.stringify({ source: "grant-service", id: "mallory", grant: "g", version: 1 }) };
    const caller = async (token: string) => {
      const client = new Client({ name: "principal-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(served.url), { requestInit: { headers: { Authorization: `Bearer ${token}`, ...forged } } }));
      closers.push(() => client.close());
      return async (body: string) => ((await client.callTool({ name: "rig_queue_create", arguments: { destination: "impl@team", body } })).structuredContent as { qitemId: string }).qitemId;
    };
    const [asAlice, asBob] = await Promise.all([caller(alice), caller(bob)]);
    const ids = await Promise.all([asAlice("one"), asBob("two"), asAlice("three"), asBob("four")]);
    const stamp = (id: string) => db.prepare("SELECT identity_provenance AS p, identity_principal AS who FROM queue_transitions WHERE qitem_id = ?").get(id);
    const as = (id: string) => ({ p: "principal:v1", who: JSON.stringify({ source: "file", id }) });
    expect(ids.map(stamp)).toEqual([as("alice"), as("bob"), as("alice"), as("bob")]);
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
    const next = ((await handoff.json()) as { created: { qitemId: string } }).created.qitemId;
    expect((await asCarol("rig_queue_show", { qitemId: own })).structured.successor).toEqual({ unknown: true, code: "out_of_scope" });
    // Nor do the daemon's own successor fields, which it fills without a caller's scope (here: 21 successors, so the list
    // is cut too).
    const more = db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body, handed_off_from)
      VALUES (?, '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z', 'impl@team', 'qa@other', 'pending', 'routine', 'x', ?)`);
    for (let n = 0; n < 20; n++) more.run(`qitem-more-${n}`, own);
    expect(await (await fetch(`${daemonUrl}/api/queue/${own}`)).json()).toMatchObject({ successorsTruncated: true, successors: expect.arrayContaining([expect.objectContaining({ qitemId: next })]) });
    const handedOn = await asCarol("rig_queue_show", { qitemId: own });
    for (const derived of ["successors", "successorsTruncated", "successorNote"]) expect(handedOn.structured.item).not.toHaveProperty(derived);
    expect(handedOn.text).not.toContain(next);
    expect(handedOn.text).not.toContain("qitem-more-");
    const handedOnList = await asCarol("rig_queue_list", { all: true, destination: "impl@team" });
    for (const row of handedOnList.structured.items) {
      for (const derived of ["successors", "successorsTruncated", "successorNote"]) expect(row).not.toHaveProperty(derived);
    }
    expect(handedOnList.text).not.toContain(next);
    expect(handedOnList.text).not.toContain("qitem-more-");

    // Artifacts: a root outside the grant is out of reach, directly or through an item.
    fs.writeFileSync(path.join(shared, "report.md"), "ARTIFACT body");
    expect((await asCarol("rig_artifact_read", { root: "proof", path: "report.md" })).structured).toMatchObject({ code: "out_of_scope" });
    const withRef = await repo.create({ sourceSession: "carol@team", destinationSession: "impl@team", body: "x", nudge: false } as never);
    db.prepare("UPDATE queue_items SET evidence_ref = ? WHERE qitem_id = ?").run(path.join(shared, "report.md"), withRef.qitemId);
    const viaItem = await asCarol("rig_artifact_read", { qitemId: withRef.qitemId });
    expect(viaItem.structured).toMatchObject({ available: false, roots: [] });
    expect(viaItem.text).not.toContain("ARTIFACT body");
  });

  it("an owner lists a handed-off origin with its successor's current state", async () => {
    const owner = await grant("owner", { owner: true });
    const served = await listen();
    const asOwner = await connect(served.url, owner);
    const source = await repo.create({ sourceSession: "lead@team", destinationSession: "impl@team", body: "request", nudge: false });
    const { created } = await repo.handoff({ qitemId: source.qitemId, fromSession: "impl@team", toSession: "qa@other", nudge: false });
    repo.claim({ qitemId: created.qitemId, destinationSession: "qa@other" });

    const listed = await asOwner("rig_queue_list", { all: true, destination: "impl@team" });

    expect(listed.isError).toBe(false);
    expect(listed.structured.items).toEqual([expect.objectContaining({ qitemId: source.qitemId, state: "handed-off",
      successors: [{ qitemId: created.qitemId, destinationSession: "qa@other", state: "in-progress", via: "handedOffFrom" }],
    })]);
  });

  it("a scoped grant's root_unknown names only the shared roots it may read, and an unscoped caller still sees them all", async () => {
    // The grant names proof and a root this daemon no longer shares; acct-b is another account's.
    const dana = await grant("dana", { roots: ["proof", "stale"] });
    const owner = await grant("owner", { owner: true });
    const served = await listen();
    const asDana = await connect(served.url, dana);
    const asOwner = await connect(served.url, owner);
    const withRef = await repo.create({ sourceSession: "dana@team", destinationSession: "impl@team", body: "x", nudge: false } as never);
    db.prepare("UPDATE queue_items SET evidence_ref = ? WHERE qitem_id = ?").run("report.md", withRef.qitemId);

    for (const args of [{ root: "stale", path: "report.md" }, { qitemId: withRef.qitemId, root: "stale" }]) {
      const scoped = await asDana("rig_artifact_read", args);
      expect(scoped.structured).toMatchObject({ ok: false, code: "root_unknown",
        message: "Shared root 'stale' is not configured on this daemon. Shared roots this connection may read: proof." });
      expect(JSON.parse(scoped.text)).toEqual({ error: "root_unknown", rootName: "stale", configuredRoots: ["proof"],
        message: "Shared root 'stale' is not configured on this daemon. Shared roots this connection may read: proof." });
    }

    const unscoped = await asOwner("rig_artifact_read", { root: "stale", path: "report.md" });
    expect(unscoped.structured).toMatchObject({ code: "root_unknown" });
    expect(JSON.parse(unscoped.text)).toMatchObject({ rootName: "stale", configuredRoots: ["proof", "acct-b"] });
    expect(unscoped.text).toContain("acct-b");
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
      // Presence is recorded only for an authenticated call, beside the token file and never in it.
      const presenceFile = path.join(path.dirname(tokenFile), "mcp-http-presence.json");
      expect((await post(served.url, {})).status).toBe(401);
      expect(fs.existsSync(presenceFile)).toBe(false);
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
        useWhen: "A question needs current web sources", caveat: "No terminal or files: answers in text only", pane: null, activity: "unknown",
        // Its last call is recorded; no ring was rung (nudge: false), so its last wake is unknown, never idle.
        presence: { lastCallAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), lastWake: null, lastWakeScope: "the latest ring among its 50 most recent rows",
          // Its own inbox reads over this server were recorded as check-ins on the daemon. Its entry states no cadence,
          // so it reads unknown with that check-in, never on request.
          checkIn: { status: "unknown", lastCheckInAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), expectedMinutes: null, onRequest: false,
            reason: "no check-in cadence declared" } } }]);
      expect(JSON.parse(fs.readFileSync(presenceFile, "utf8")).seats["grok@team"]).toMatchObject({ grant: "grok" });
      expect(fs.statSync(presenceFile).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(tokenFile, "utf8")).not.toContain("lastCallAt");

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

  it("a hosted member learns its seat, asks a person or its requester while keeping the item, and finishes the same item", async () => {
    // The member has a grant and no node. Ana is a registered person; the lead is a team seat.
    const ANA = "human-ana@external";
    people = [{ entityId: "human-ana", class: "human", displayName: "Ana", address: ANA,
      connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "unused", role: "primary", handle: "UANA" }], prefs: { deliveryClass: "A" } }];
    const token = await addGrant(tokenFile, { name: "grok", seat: "grok@team", rigs: ["team"], roots: [], workspace: false, owner: false });
    const asGrok = await connect((await listen()).url, token);
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });

    // whoami has no node or session for it, and the member still learns the seat it acts as.
    const me = await asGrok("rig_whoami");
    expect(me.isError).toBe(false);
    expect(me.structured).toMatchObject({ ok: true, seat: "grok@team", rig: "team", session: null, caller: { authenticated: true, principal: "grok" } });
    expect(me.structured.message).toContain("no session here");

    // From a person: the member parks the item on her with the question and its draft as the summary, she's asked with
    // that draft, and her answer returns it in progress.
    const fromAna = await repo.create({ sourceSession: ANA, destinationSession: "grok@team", summary: "Announce the release", body: "Post the 0.7.3 note publicly.", nudge: false } as never);
    expect((await asGrok("rig_queue_claim", { qitemId: fromAna.qitemId })).isError).toBe(false);
    const draft = "May I post this publicly? \"0.7.3 is out: connected assistants can now ask before they act.\"";
    const asked = await asGrok("rig_queue_update", { qitemId: fromAna.qitemId, state: "blocked", blockedOn: ANA, summary: draft, note: "Asked Ana before posting." });
    expect(asked.isError).toBe(false);
    expect(repo.getById(fromAna.qitemId)).toMatchObject({ state: "blocked", blockedOn: ANA });
    expect(repo.listTransitions(fromAna.qitemId).at(-1)).toMatchObject({ state: "blocked", ownerNotificationKind: "human-required" });
    // The ask she gets, through the projection and render the Slack post uses, carries the exact draft.
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => ({ ok: true as const, entities: people ?? [] }), sharedChannels: () => [] });
    const ask = (await ports.listHumanAlerts({ minimumLevel: "NOTICE" })).find((item) => item.qitemId === fromAna.qitemId);
    expect(ask).toMatchObject({ ownerNotificationKind: "human-required", summary: draft });
    const rendered = buildOutboundMessage({ qitemId: ask!.qitemId, ownerNotificationKind: ask!.ownerNotificationKind, summary: ask!.summary,
      body: ask!.body, state: ask!.state, tags: ask!.tags, evidenceRef: ask!.evidenceRef }, { sourceLabel: "team" });
    expect(rendered.text).toContain("0.7.3 is out: connected assistants can now ask before they act.");
    expect(rendered.text).not.toContain("Asked Ana before posting.");
    await contract.act({ verb: "resolve", qitemId: fromAna.qitemId, actorSession: ANA, decision: "Yes, post it.", notify: true } as never);
    expect(repo.getById(fromAna.qitemId)).toMatchObject({ state: "in-progress", blockedOn: null, destinationSession: "grok@team" });
    expect((await asGrok("rig_queue_show", { qitemId: fromAna.qitemId })).text).toContain("Yes, post it.");
    expect((await asGrok("rig_queue_update", { qitemId: fromAna.qitemId, state: "done", closureReason: "no-follow-on", resolution: "Posted the 0.7.3 note." })).isError).toBe(false);
    expect(repo.getById(fromAna.qitemId)).toMatchObject({ state: "done", resolution: "Posted the 0.7.3 note." });

    // From a seat: the member asks the lead as a new item and parks its own on it; the lead's answer returns it pending.
    const fromLead = await repo.create({ sourceSession: "lead@team", destinationSession: "grok@team", summary: "Draft the changelog", body: "Draft the 0.7.3 changelog.", nudge: false } as never);
    expect((await asGrok("rig_queue_claim", { qitemId: fromLead.qitemId })).isError).toBe(false);
    const question = await asGrok("rig_queue_create", { destination: "lead@team", summary: "Which date format?", body: "ISO or long-form dates in the changelog? Draft attached below." });
    expect(question.isError).toBe(false);
    const questionId = question.structured.qitemId as string;
    expect(repo.getById(questionId)).toMatchObject({ sourceSession: "grok@team", destinationSession: "lead@team" });
    expect((await asGrok("rig_queue_update", { qitemId: fromLead.qitemId, state: "blocked", blockedOn: questionId })).isError).toBe(false);
    expect(repo.getById(fromLead.qitemId)).toMatchObject({ state: "blocked", blockedOn: questionId });
    repo.update({ qitemId: questionId, actorSession: "lead@team", state: "done", closureReason: "no-follow-on", resolution: "ISO dates." } as never);
    expect(repo.getById(fromLead.qitemId)).toMatchObject({ state: "pending", blockedOn: null });
    expect((await asGrok("rig_queue_list", { owned: true })).structured.items.map((row: { qitemId: string }) => row.qitemId)).toContain(fromLead.qitemId);
    expect((await asGrok("rig_queue_show", { qitemId: questionId })).text).toContain("ISO dates.");
    expect((await asGrok("rig_queue_claim", { qitemId: fromLead.qitemId })).isError).toBe(false);
    expect((await asGrok("rig_queue_update", { qitemId: fromLead.qitemId, state: "done", closureReason: "no-follow-on", resolution: "Changelog drafted with ISO dates." })).isError).toBe(false);
    expect(repo.getById(fromLead.qitemId)).toMatchObject({ state: "done", resolution: "Changelog drafted with ISO dates." });
    // The same two tasks, one question: nothing was reopened as a new task.
    expect(rows()).toBe(3);
  });

  describe("a scoped grant's evidence file reaches Slack only within its own roots", () => {
    const ANA = "human-ana@external";
    const NOT_ATTACHED = "The evidence file isn't attached: it's outside the files its sender may share.";
    let outside: string;
    let deliveries = 0;
    beforeEach(() => {
      people = [{ entityId: "human-ana", class: "human", displayName: "Ana", address: ANA,
        connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "unused", role: "primary", handle: "UANA" }], prefs: { deliveryClass: "A" } }];
      outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-outside-")));
      closers.push(async () => fs.rmSync(outside, { recursive: true, force: true }));
    });
    /** A fixture file with recognizable bytes. */
    const file = (dir: string, name: string, text: string) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
    const allowlist = () => [{ name: "proof", canonicalPath: shared }, { name: "acct-b", canonicalPath: otherShared }];
    /** The grant's own item from Ana, claimed, then parked on her with this evidence through the MCP update. */
    async function parkWithEvidence(call: Awaited<ReturnType<typeof connect>>, seatName: string, evidenceRef: string) {
      const row = await repo.create({ sourceSession: ANA, destinationSession: seatName, summary: "Review the chart", body: "Is the chart right?", nudge: false } as never);
      expect((await call("rig_queue_claim", { qitemId: row.qitemId })).isError).toBe(false);
      const parked = await call("rig_queue_update", { qitemId: row.qitemId, state: "blocked", blockedOn: ANA, summary: "Is this chart right?", evidenceRef });
      expect(parked.isError).toBe(false);
      return row.qitemId as string;
    }
    /** Ana's ask through the Slack projection and payload the connector uses, delivered to a fake Slack: what was posted,
     *  and the exact bytes of every upload. */
    async function deliverAsk(qitemId: string, onPost?: () => void, recordedPayload?: ReturnType<typeof toPayload>) {
      const ports = makeQueuePorts(repo, { loadHumanRegistry: () => ({ ok: true as const, entities: people ?? [] }), sharedChannels: () => [] });
      const ask = (await ports.listHumanAlerts({ minimumLevel: "NOTICE" })).find((item) => item.qitemId === qitemId);
      expect(ask).toBeDefined();
      const posted: string[] = [];
      const uploaded: Buffer[] = [];
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
      const fetchImpl: FetchImpl = async (url, init) => {
        if (url.endsWith("chat.postMessage")) { posted.push(String(init?.body ?? "")); onPost?.(); return json({ ok: true, ts: "9000.1" }); }
        if (url.endsWith("files.getUploadURLExternal")) return json({ ok: true, upload_url: "https://files.slack.invalid/put/1", file_id: "F1" });
        if (url === "https://files.slack.invalid/put/1") { uploaded.push(Buffer.from(init?.body as Uint8Array)); return new Response("ok", { status: 200 }); }
        if (url.endsWith("files.completeUploadExternal")) return json({ ok: true });
        return json({ ok: true });
      };
      // Each delivery is its own connector run's decision, so a later read is a fresh delivery, not a repeat of the first.
      const run = ++deliveries;
      const store = (name: string) => new SeenStore(path.join(home, `${qitemId}-${run}-${name}.jsonl`));
      const deliver = subsystemSlackDeliver({
        botToken: "xoxb-EXAMPLE-fake", channel: "C-TEST", sourceLabel: "team", fetchImpl,
        delivered: store("delivered"), attempted: store("attempted"), outboundSeen: store("seen"),
        filesAllowlist: allowlist, log: () => {},
      } as never);
      const out = await deliver({ kind: "outbound_decision", decisionId: `d-${qitemId}-${run}`, op: "post_message", entityBindingRef: "human-ana#slack",
        payload: recordedPayload ?? toPayload(ask!) } as never);
      expect(out.ok).toBe(true);
      return { posted, uploaded, ask: ask! };
    }

    it("with no roots, a file outside them isn't uploaded; the ask and its evidence pointer still post", async () => {
      const secret = file(outside, "private.pdf", "OUTSIDE-BYTES");
      const call = await connect((await listen()).url, await grant("grok"));
      const qitemId = await parkWithEvidence(call, "grok@team", secret);
      const { posted, uploaded } = await deliverAsk(qitemId);
      expect(uploaded.map((b) => b.toString())).toEqual([]);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("Is this chart right?");
      // The post says plainly that the file isn't attached, and the item keeps its evidence pointer.
      expect(posted[0]).toContain(NOT_ATTACHED);
      expect(repo.getById(qitemId)!.evidenceRef).toBe(secret);
    });

    it("a file in a root the grant names uploads, byte for byte", async () => {
      const chart = file(shared, "chart.png", "PROOF-CHART-BYTES");
      const call = await connect((await listen()).url, await grant("grok", { roots: ["proof"] }));
      const { uploaded, posted } = await deliverAsk(await parkWithEvidence(call, "grok@team", chart));
      expect(uploaded.map((b) => b.toString())).toEqual(["PROOF-CHART-BYTES"]);
      expect(posted[0]).not.toContain(NOT_ATTACHED);
    });

    it("a shared root the grant doesn't name is excluded, though the daemon shares it", async () => {
      const other = file(otherShared, "statement.pdf", "ACCT-B-BYTES");
      const call = await connect((await listen()).url, await grant("grok", { roots: ["proof"] }));
      const qitemId = await parkWithEvidence(call, "grok@team", other);
      expect(repo.getById(qitemId)!.evidenceRefRoots).toEqual(["proof"]);
      const { posted, uploaded } = await deliverAsk(qitemId);
      expect(uploaded).toEqual([]);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain(NOT_ATTACHED);
    });

    it("a link in a permitted root is judged by its real target when the file is read, not when it was named", async () => {
      const inside = file(shared, "real-chart.png", "IN-ROOT-BYTES");
      const secret = file(outside, "private.png", "OUTSIDE-BYTES");
      const link = path.join(shared, "chart.png");
      fs.symlinkSync(secret, link);
      const call = await connect((await listen()).url, await grant("grok", { roots: ["proof"] }));
      const qitemId = await parkWithEvidence(call, "grok@team", link);
      // Out of the root at the read: not uploaded, and the ask still posts.
      const first = await deliverAsk(qitemId);
      expect(first.uploaded).toEqual([]);
      expect(first.posted).toHaveLength(1);
      // Retargeted inside the root before a later read: that read follows it, and only to the in-root file.
      fs.rmSync(link);
      fs.symlinkSync(inside, link);
      expect((await deliverAsk(qitemId)).uploaded.map((b) => b.toString())).toEqual(["IN-ROOT-BYTES"]);
      // And back out again: the next read refuses it.
      fs.rmSync(link);
      fs.symlinkSync(secret, link);
      expect((await deliverAsk(qitemId)).uploaded).toEqual([]);
    });

    it("an attributed owner grant has no root limit, as before", async () => {
      const identity = path.join(home, "identity.sqlite");
      const idDb = createDb(identity);
      idDb.exec("CREATE TABLE self_host_identity (singleton INTEGER PRIMARY KEY, host_id TEXT)");
      idDb.prepare("INSERT INTO self_host_identity VALUES (1, 'owner-fixture')").run();
      idDb.close();
      vi.stubEnv("OPENRIG_DB", identity);
      setSelfHostId("owner-fixture");
      closers.push(async () => { vi.unstubAllEnvs(); });
      const local = file(outside, "owner.png", "OWNER-BYTES");
      const call = await connect((await listen()).url, await grant("boss", { owner: true }));
      const qitemId = await parkWithEvidence(call, "boss@team", local);
      expect(db.prepare("SELECT identity_principal AS who FROM queue_transitions WHERE qitem_id = ? AND identity_principal IS NOT NULL").all(qitemId))
        .toContainEqual({ who: JSON.stringify({ source: "file", id: "boss" }) });
      expect(repo.getById(qitemId)!.evidenceRefRoots).toBeUndefined();
      expect((await deliverAsk(qitemId)).uploaded.map((b) => b.toString())).toEqual(["OWNER-BYTES"]);
    });

    it("a request through the adapter that names a caller but not its roots records none, never a local writer", async () => {
      const secret = file(outside, "private.pdf", "OUTSIDE-BYTES");
      seat("team", "grok");
      const row = await repo.create({ sourceSession: ANA, destinationSession: "grok@team", summary: "Review", body: "b", nudge: false } as never);
      const headers = { "Content-Type": "application/json", "X-OpenRig-Session": "grok@team", "X-OpenRig-Principal": JSON.stringify({ source: "file", id: "grok" }) };
      expect((await fetch(`${daemonUrl}/api/queue/${row.qitemId}/claim`, { method: "POST", headers, body: "{}" })).status).toBeLessThan(300);
      expect((await fetch(`${daemonUrl}/api/queue/${row.qitemId}/update`, { method: "POST", headers,
        body: JSON.stringify({ state: "blocked", blockedOn: ANA, summary: "Is this right?", evidenceRef: secret }) })).status).toBeLessThan(300);
      expect(repo.getById(row.qitemId)!.evidenceRefRoots).toEqual([]);
      expect((await deliverAsk(row.qitemId)).uploaded).toEqual([]);
    });

    it("later changes, alerts and replays keep the writer's limit: only a new reference takes its own writer's", async () => {
      const secret = file(outside, "private.pdf", "OUTSIDE-BYTES");
      const call = await connect((await listen()).url, await grant("grok"));
      const qitemId = await parkWithEvidence(call, "grok@team", secret);
      const firstAsk = (await deliverAsk(qitemId)).ask;
      // The person answers; the grant takes it up again and parks it a second time, naming no evidence: a new alert,
      // still limited to the grant's (no) roots.
      const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
      await contract.act({ verb: "resolve", qitemId, actorSession: ANA, decision: "Which axis?", notify: true } as never);
      expect((await call("rig_queue_update", { qitemId, state: "blocked", blockedOn: ANA, summary: "The y axis: is it right?" })).isError).toBe(false);
      expect(repo.getById(qitemId)).toMatchObject({ evidenceRef: secret, evidenceRefRoots: [] });
      expect((await deliverAsk(qitemId)).uploaded).toEqual([]);
      // A local seat's later note on the row, naming no evidence, changes nothing about it.
      repo.update({ qitemId, actorSession: "lead@team", transitionNote: "Looked at it." } as never);
      expect(repo.getById(qitemId)!.evidenceRefRoots).toEqual([]);
      // The first ask's recorded decision, replayed: its payload carries the same limit.
      expect(toPayload(firstAsk).evidenceRefRoots).toEqual([]);
      // A trusted local writer that names the reference itself records its own (no root limit): a deliberate selection.
      repo.update({ qitemId, actorSession: "lead@team", state: "blocked", blockedOn: ANA, summary: "The y axis: is it right?", evidenceRef: secret,
        transitionNote: "Attaching it myself." } as never);
      expect(repo.getById(qitemId)!.evidenceRefRoots).toBeUndefined();
      expect((await deliverAsk(qitemId)).uploaded.map(b => b.toString())).toEqual(["OUTSIDE-BYTES"]);
      // A durable decision saved before that rewrite still uses its original authority on an actual delivery.
      const replay = JSON.parse(JSON.stringify(toPayload(firstAsk)));
      expect((await deliverAsk(qitemId, undefined, replay)).uploaded).toEqual([]);
    });

    it.each(["route", "handoff"] as const)("mission-control %s copies the reference without promoting its writer", async (verb) => {
      const evidence = file(outside, "handoff.pdf", "OUTSIDE-BYTES");
      const call = await connect((await listen()).url, await grant("grok"));
      const qitemId = await parkWithEvidence(call, "grok@team", evidence);
      const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
      const result = await contract.act({ verb, qitemId, actorSession: ANA, destinationSession: "lead@team", notify: false });
      const successor = result.createdQitemId!;
      repo.update({ qitemId: successor, actorSession: "lead@team", state: "blocked", blockedOn: ANA, summary: "Please check the inherited chart" } as never);
      const outcome = await deliverAsk(successor);
      expect(outcome.uploaded).toEqual([]);
      expect(outcome.posted[0]).toContain(NOT_ATTACHED);
      expect(repo.getById(successor)).toMatchObject({ evidenceRef: evidence, evidenceRefRoots: [] });
    });

    it("the attachment note describes the actual read if a link changes while the post awaits Slack", async () => {
      const inside = file(shared, "original.png", "IN-ROOT-BYTES");
      const outsideFile = file(outside, "later.png", "OUTSIDE-BYTES");
      const link = path.join(shared, "moving.png");
      fs.symlinkSync(inside, link);
      const call = await connect((await listen()).url, await grant("grok", { roots: ["proof"] }));
      const qitemId = await parkWithEvidence(call, "grok@team", link);
      const outcome = await deliverAsk(qitemId, () => { fs.unlinkSync(link); fs.symlinkSync(outsideFile, link); });
      const bytes = outcome.uploaded.map(b => b.toString());
      expect(bytes).not.toContain("OUTSIDE-BYTES");
      // A checked snapshot may be sent, or a later read may skip it: the visible note must match that decision.
      expect(outcome.posted[0].includes(NOT_ATTACHED)).toBe(bytes.length === 0);
    });

    it("a trusted local seat's evidence anywhere still uploads, as before", async () => {
      const local = file(outside, "screenshot.png", "LOCAL-SEAT-BYTES");
      seat("team", "lead");
      const row = await repo.create({ sourceSession: ANA, destinationSession: "lead@team", summary: "Check the screenshot", body: "b", nudge: false } as never);
      const lead = new DaemonClient(daemonUrl, { sessionName: "lead@team" });
      expect((await lead.post(`/api/queue/${row.qitemId}/claim`, {})).status).toBeLessThan(300);
      expect((await lead.post(`/api/queue/${row.qitemId}/update`, { state: "blocked", blockedOn: ANA, summary: "Is this screenshot right?", evidenceRef: local })).status).toBeLessThan(300);
      const { uploaded, posted } = await deliverAsk(row.qitemId);
      expect(uploaded.map((b) => b.toString())).toEqual(["LOCAL-SEAT-BYTES"]);
      expect(posted[0]).not.toContain(NOT_ATTACHED);
    });
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

  async function runToken(args: string[]): Promise<string> {
    const cmd = mcpCommand();
    cmd.commands.find(command => command.name() === "token")?.commands
      .find(command => command.name() === args[0])?.exitOverride();
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...line: unknown[]) => { out.push(line.join(" ")); });
    try { await cmd.parseAsync(["token", ...args], { from: "user" }); } finally { log.mockRestore(); }
    return out.join("\n");
  }

  it("rig mcp token add, list and revoke: the token is shown once and only its hash is kept, in a file only its owner reads", async () => {
    const added = await runToken(["add", "dana", "--seat", "dana@team", "--rig", "team", "--root", "proof"]);
    const token = added.split("\n")[1]!;
    expect(token).toMatch(/^orm_/);
    const stored = fs.readFileSync(tokenFile, "utf8");
    expect(stored).not.toContain(token);
    expect(JSON.parse(stored).principals[0]).toMatchObject({ name: "dana", seat: "dana@team", rigs: ["team"], roots: ["proof"], owner: false });
    expect(JSON.parse(stored).principals[0]).not.toHaveProperty("objects");
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    const listed = await runToken(["list"]);
    expect(listed).toContain("dana: seat dana@team");
    expect(listed).not.toContain(JSON.parse(stored).principals[0].tokenSha256);
    expect(await runToken(["revoke", "dana"])).toContain("Revoked dana");
    expect(JSON.parse(fs.readFileSync(tokenFile, "utf8")).principals).toEqual([]);
  });

  it.each([false, true])("uses only the allowed tools from token add with front-door mode %s", async frontDoor => {
    for (const name of ["limited", "legacy", "lead"]) seat("team", name);
    const legacyToken = await grant("legacy");
    const added = await runToken(["add", "limited", "--seat", "limited@team", "--rig", "team",
      "--allow", "queue:list,show", "--allow", "team:list", "--allow", "queue:show"]);
    const token = added.split("\n")[1]!;
    const { grants } = JSON.parse(await runToken(["list", "--json"]));
    expect(grants).toEqual([expect.objectContaining({ name: "legacy" }),
      expect.objectContaining({ name: "limited", objects: { queue: ["list", "show"], team: ["list"] } })]);
    expect(grants[0]).not.toHaveProperty("objects");
    expect(grants[1]).not.toHaveProperty("tokenSha256");

    const { url } = await listen({ frontDoor });
    const limited = await connect(url, token);
    expect((await limited.client.listTools()).tools.map(tool => tool.name).sort())
      .toEqual(["rig_queue_list", "rig_queue_show", "rig_team"]);
    expect((await limited("rig_queue_list")).isError).toBe(false);
    await expect(limited("rig_queue_create", { destination: "lead@team", body: "outside the allowance" }))
      .rejects.toThrow(/rig_queue_create/);
    expect(rows()).toBe(0);

    const legacy = await connect(url, legacyToken);
    expect((await legacy.client.listTools()).tools.map(tool => tool.name)).toContain("rig_queue_create");
    expect((await legacy("rig_queue_create", { destination: "lead@team", body: "legacy grant" })).isError).toBe(false);
    expect(rows()).toBe(1);
  });

  it.each(["queue", "queue:", "queue:list,", "queue:list:show", "queue:missing", "constructor:list"])(
    "rejects --allow %s before rewriting the grant file", async allowance => {
      await grant("legacy");
      const before = fs.readFileSync(tokenFile);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const priorExit = process.exitCode;
      try {
        expect(await runToken(["add", "invalid", "--seat", "invalid@team", "--allow", allowance])).toBe("");
        expect(process.exitCode).toBe(1);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("--allow"));
        expect(fs.readFileSync(tokenFile)).toEqual(before);
      } finally {
        process.exitCode = priorExit;
        error.mockRestore();
      }
    },
  );

  describe("a configured caller resolver", () => {
    const credential = "opaque-local-credential";
    const profile = () => ({ ok: true as const, seat: "caller@team",
      principal: { source: "local-authority", id: "user:42", label: "Local caller" },
      access: { principal: "user:42", owner: false, workspace: false, rigs: ["team"], roots: [],
        external: { objects: { queue: ["create", "show", "list", "claim", "update"], team: ["list"] }, peerSeats: ["peer@team"] } },
    });
    const prepare = () => {
      setSelfHostId("resolver-test");
      for (const member of ["caller", "peer", "stranger"]) seat("team", member);
    };

    it("uses the resolved opaque caller per request and records its authority without reading the token file", async () => {
      prepare();
      const identity = path.join(home, "identity.sqlite");
      const idDb = createDb(identity);
      idDb.exec("CREATE TABLE self_host_identity (singleton INTEGER PRIMARY KEY, host_id TEXT)");
      idDb.prepare("INSERT INTO self_host_identity VALUES (1, 'resolver-test')").run();
      idDb.close();
      vi.stubEnv("OPENRIG_DB", identity);
      closers.push(async () => { vi.unstubAllEnvs(); });
      fs.writeFileSync(tokenFile, "unreadable file that this mode never reads");
      const resolve = vi.fn(async () => profile());
      const served = await listen({ resolver: resolve });
      expect(served.authenticated).toBe(true);
      const call = await connect(served.url, credential);
      const created = await call("rig_queue_create", { qitemId: "qitem-resolved", destination: "peer@team", body: "work" });
      expect(created.isError).toBe(false);
      expect(db.prepare("SELECT source_session FROM queue_items WHERE qitem_id = ?").get("qitem-resolved"))
        .toEqual({ source_session: "caller@team" });
      const recorded = db.prepare("SELECT identity_principal AS who FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id LIMIT 1")
        .get("qitem-resolved") as { who: string };
      expect(JSON.parse(recorded.who)).toEqual(profile().principal);
      expect(resolve.mock.calls.length).toBeGreaterThan(1);
      resolve.mockImplementation(async () => ({ ok: false, refusal: "revoked" }) as never);
      expect((await post(served.url, { Authorization: `Bearer ${credential}` })).status).toBe(401);
    });

    it.each([
      ["result", 0, 0], ["result", 1, 1], ["result", 1001, 2], ["result", 600_001, 600],
      ["access", 0, 0], ["access", 1, 1], ["access", 1001, 2], ["access", 600_001, 600],
    ] as const)("normalizes generic new-work backoff from %s (%i ms -> %i seconds)", async (location, delay, seconds) => {
      prepare();
      const answer = profile();
      const delayed = location === "result" ? { ...answer, access: { ...answer.access, newWorkRetryAfterMs: 9000 }, newWorkRetryAfterMs: delay }
        : { ...answer, access: { ...answer.access, newWorkRetryAfterMs: delay } };
      const call = await connect((await listen({ resolver: async () => delayed })).url, credential);
      const result = await call("rig_queue_create", { qitemId: "qitem-delay-boundary", destination: "peer@team", body: "work" });
      if (seconds === 0) {
        expect(result.isError).toBe(false);
        expect(rows()).toBe(1);
      } else {
        expect(result.structured).toMatchObject({ code: "fair_use_retry_later", retryable: true, retryAfterSeconds: seconds,
          qitemId: "qitem-delay-boundary", outcome: "not_written" });
        expect(result.text).toContain("this connection is waiting");
        expect(result.text).not.toContain("this account");
        expect(rows()).toBe(0);
      }
    });

    it("keeps opaque resolver callers' reads, settlement and landed retries usable during generic backoff", async () => {
      prepare();
      let delay = 0;
      const call = await connect((await listen({ resolver: async () => ({ ...profile(), newWorkRetryAfterMs: delay }) })).url, credential);
      expect((await call("rig_queue_create", { qitemId: "qitem-landed-generic", destination: "peer@team", body: "landed" })).isError).toBe(false);
      await repo.create({ qitemId: "qitem-owned-generic", sourceSession: "peer@team", destinationSession: "caller@team", body: "finish this" });
      delay = 9000;
      const held = await call("rig_queue_create", { destination: "peer@team", body: "new work" });
      expect(held.structured).toMatchObject({ code: "fair_use_retry_later", retryable: true, retryAfterSeconds: 9, outcome: "not_written", qitemId: expect.any(String) });
      expect((await call("rig_queue_create", { qitemId: "qitem-landed-generic", destination: "peer@team", body: "landed" })).isError).toBe(false);
      expect((await call("rig_queue_show", { qitemId: "qitem-owned-generic" })).isError).toBe(false);
      expect((await call("rig_queue_list")).isError).toBe(false);
      expect((await call("rig_queue_claim", { qitemId: "qitem-owned-generic" })).isError).toBe(false);
      expect((await call("rig_queue_update", { qitemId: "qitem-owned-generic", state: "done", closureReason: "no-follow-on", resolution: "finished" })).isError).toBe(false);
      expect(repo.getById("qitem-owned-generic")?.state).toBe("done");
      expect(rows()).toBe(2);
    });

    it.each(["unavailable", "disconnected", "absent"] as const)("reports %s readback honestly during generic backoff", async reading => {
      prepare();
      const served = await listen({ resolver: async () => ({ ...profile(), newWorkRetryAfterMs: 1001 }),
        clientFactory: (url, sessionName, principal) => {
          const client = new DaemonClient(url, { sessionName, principal });
          const get = client.get.bind(client);
          client.get = async (route, ...rest) => {
            if (route === "/api/queue/qitem-unread-generic") {
              if (reading === "disconnected") throw new Error("fixture read failed");
              return { status: reading === "absent" ? 404 : 503, data: {} };
            }
            return get(route, ...rest);
          };
          return client;
        } });
      const call = await connect(served.url, credential);
      const held = await call("rig_queue_create", { qitemId: "qitem-unread-generic", destination: "peer@team", body: "maybe earlier" });
      expect(held.structured).toMatchObject({ code: "fair_use_retry_later", retryAfterSeconds: 2, qitemId: "qitem-unread-generic", outcome: "not_written" });
      if (reading === "absent") expect(held.structured).not.toHaveProperty("earlierAttempt");
      else {
        expect(held.structured).toHaveProperty("earlierAttempt", "unknown");
        expect(held.text).toContain("Whether an earlier attempt with this id was saved is unknown");
      }
      expect(rows()).toBe(0);
    });

    it("passes ordered operation metadata and retains authentication before parse errors", async () => {
      prepare();
      let denied = false;
      const seen: Array<{ instance: string; methods: readonly string[]; bearer: string }> = [];
      const served = await listen({ resolver: async request => {
        seen.push(request);
        return denied ? { ok: false, refusal: "wrong_instance" } : profile();
      } });
      const send = (body: string) => fetch(served.url, { method: "POST", headers: {
        Authorization: `Bearer ${credential}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      }, body });
      await send(JSON.stringify([{ jsonrpc: "2.0", method: "ping", id: 1 }, { jsonrpc: "2.0", method: "tools/list", id: 2 }]));
      expect(seen.at(-1)).toMatchObject({ bearer: credential, instance: "resolver-test", methods: ["ping", "tools/list"] });
      expect((await send("{")).status).toBe(400);
      expect(seen.at(-1)?.methods).toEqual([]);
      denied = true;
      expect((await send("{")).status).toBe(401);
      denied = false;
      expect((await send('"' + "x".repeat(4 * 1024 * 1024) + '"')).status).toBe(413);
    });

    it.each(["unknown", "revoked", "expired", "wrong_instance", "malformed", "unavailable"] as const)("preserves the refusal mapping for %s", async refusal => {
      prepare();
      const served = await listen({ resolver: async () => ({ ok: false, refusal }) });
      const response = await post(served.url, { Authorization: `Bearer ${credential}` });
      const status = ["malformed", "unavailable"].includes(refusal) ? 503 : 401;
      expect(response.status).toBe(status);
      if (status === 401) expect(response.headers.get("www-authenticate")).toContain("Bearer");
      expect(rows()).toBe(0);
    });

    it("bounds an uncooperative resolver and signals its deadline without exposing a credential", async () => {
      prepare();
      let signal: AbortSignal | undefined;
      const served = await listen({ resolverTimeoutMs: 120, resolver: async request => {
        signal = request.signal;
        return new Promise(() => {});
      } });
      const before = performance.now();
      const response = await post(served.url, { Authorization: `Bearer ${credential}` });
      expect(response.status).toBe(503);
      expect(performance.now() - before).toBeLessThan(3000);
      expect(signal?.aborted).toBe(true);
      expect(await response.text()).not.toContain(credential);
    });

    it("includes a stalled seat check in the same resolver budget", async () => {
      prepare();
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        if (String(input).includes("/api/whoami?")) return new Promise(() => {});
        return realFetch(input, init);
      });
      const served = await listen({ resolverTimeoutMs: 120, resolver: async () => profile() });
      const before = performance.now();
      expect((await post(served.url, { Authorization: `Bearer ${credential}` })).status).toBe(503);
      expect(performance.now() - before).toBeLessThan(3000);
    });

    it("bounds body reading before the resolver and cancels an abandoned resolution", async () => {
      prepare();
      const resolve = vi.fn(async () => profile());
      const served = await listen({ resolverTimeoutMs: 150, resolver: resolve });
      const status = await new Promise<number>(done => {
        const request = http.request(served.url, { method: "POST", headers: { Authorization: `Bearer ${credential}` } }, response => {
          response.resume();
          response.once("end", () => { request.destroy(); done(response.statusCode!); });
        });
        request.on("error", () => {});
        request.write("{");
      });
      expect(status).toBe(503);
      expect(resolve).not.toHaveBeenCalled();

      let entered!: () => void;
      let aborted!: () => void;
      const active = new Promise<void>(done => { entered = done; });
      const cancelled = new Promise<void>(done => { aborted = done; });
      const second = await listen({ resolver: async request => {
        request.signal.addEventListener("abort", aborted, { once: true });
        entered();
        return new Promise(() => {});
      } });
      const request = http.request(second.url, { method: "POST", headers: { Authorization: `Bearer ${credential}` } });
      request.on("error", () => {});
      request.end(JSON.stringify(INITIALIZE));
      await active;
      request.destroy();
      await cancelled;
    });

    it("serves an exact materialized seat without creating or launching it", async () => {
      prepare();
      const rig = setup.rigRepo.listRigs().find(value => value.name === "team")!;
      setup.rigRepo.addNode(rig.id, "pod.materialized", { role: "worker" });
      const count = db.prepare("SELECT COUNT(*) AS count FROM nodes").get();
      const served = await listen({ resolver: async () => ({ ...profile(), seat: "pod-materialized@team" }) });
      expect((await post(served.url, { Authorization: `Bearer ${credential}` })).status).toBe(200);
      expect(db.prepare("SELECT COUNT(*) AS count FROM nodes").get()).toEqual(count);
    });

    it("treats thrown resolver errors as unavailable without logging their contents", async () => {
      prepare();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const served = await listen({ resolver: async () => { throw new Error(credential); } });
      const response = await post(served.url, { Authorization: `Bearer ${credential}` });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(credential);
      expect(JSON.stringify(log.mock.calls)).not.toContain(credential);
    });

    it("does not turn a missing seat or a malformed resolver result into an authenticated owner", async () => {
      prepare();
      let answer: unknown = { ...profile(), seat: "missing@team" };
      const served = await listen({ resolver: async () => answer as ReturnType<typeof profile> });
      expect((await post(served.url, { Authorization: `Bearer ${credential}` })).status).toBe(503);
      answer = { ...profile(), access: { ...profile().access, owner: true } };
      expect((await post(served.url, { Authorization: `Bearer ${credential}` })).status).toBe(503);
      expect(rows()).toBe(0);
    });

    it.each([false, true])("routes the shown logical peer through the default receiver (canonical also allowed: %s)", async (alsoCanonical) => {
      prepare();
      const answer = profile();
      answer.access.external.peerSeats = alsoCanonical ? ["peer@team", "pod-peer@team"] : ["pod-peer@team"];
      const call = await connect((await listen({ resolver: async () => answer, taskDestination: "pod-peer@team" })).url, credential);
      const team = await call("rig_team");
      const shown = team.structured.seats.find((seat: { logicalId: string }) => seat.logicalId === "pod.peer");
      expect(shown.session).toBe(alsoCanonical ? "peer@team" : "pod-peer@team");
      const created = await call("rig_queue_create", { qitemId: "qitem-logical-receiver", body: "work" });
      expect(created.isError).toBe(false);
      expect(db.prepare("SELECT destination_session FROM queue_items WHERE qitem_id = ?").get("qitem-logical-receiver"))
        .toEqual({ destination_session: shown.session });
      expect(rows()).toBe(1);
    });

    it("keeps caller modes exclusive and allows OAuth metadata with a resolver", async () => {
      prepare();
      await expect(listen({ resolver: async () => profile(), grantService: { url: "https://example.invalid" } }))
        .rejects.toThrow("Choose one");
      const served = await listen({ resolver: async () => profile(), oauth: { resource: "https://example.test/mcp", issuer: "https://issuer.test" } });
      expect((await fetch(served.url.replace("/mcp", "/.well-known/oauth-protected-resource/mcp"))).status).toBe(200);
    });
  });

  describe("the optional local caller profile", () => {
    const scopedGrant = (extra: Partial<Parameters<typeof addGrant>[1]> = {}) => addGrant(tokenFile, {
      name: "opaque-user", seat: "caller@team", rigs: [], roots: [], owner: false, workspace: false,
      objects: { queue: ["create", "show", "list", "claim", "update"], team: ["list"] }, peerSeats: ["peer@team"], ...extra,
    });
    const prepare = () => { for (const member of ["caller", "peer", "stranger"]) seat("team", member); };
    const editProfile = (fields: Record<string, unknown>) => {
      const stored = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
      Object.assign(stored.principals[0], fields);
      fs.writeFileSync(tokenFile, JSON.stringify(stored));
    };

    it("keeps reads, settlement and landed retries usable under malformed local backoff", async () => {
      prepare();
      const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
      const token = await scopedGrant();
      await repo.create({ qitemId: "qitem-landed-bad-delay", sourceSession: "caller@team", destinationSession: "peer@team", body: "landed" });
      await repo.create({ qitemId: "qitem-owned-bad-delay", sourceSession: "peer@team", destinationSession: "caller@team", body: "answer" });
      editProfile({ newWorkRetryAfterSeconds: "not a delay" });
      const call = await connect((await listen()).url, token);
      expect((await call("rig_queue_create", { qitemId: "qitem-new-bad-delay", destination: "peer@team", body: "work" })).structured)
        .toMatchObject({ code: "fair_use_retry_later", retryAfterSeconds: 600, outcome: "not_written" });
      expect((await call("rig_queue_create", { qitemId: "qitem-landed-bad-delay", destination: "peer@team", body: "landed" })).isError).toBe(false);
      expect((await call("rig_queue_show", { qitemId: "qitem-owned-bad-delay" })).isError).toBe(false);
      expect((await call("rig_queue_claim", { qitemId: "qitem-owned-bad-delay" })).isError).toBe(false);
      expect((await call("rig_queue_update", { qitemId: "qitem-owned-bad-delay", state: "done", closureReason: "no-follow-on", note: "completed" })).isError).toBe(false);
      expect(db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get("qitem-owned-bad-delay")).toEqual({ state: "done" });
      expect(rows()).toBe(2);
      expect(warnings.mock.calls.flat().join("\n")).toMatch(/newWorkRetryAfterSeconds.*finite nonnegative.*600/);
    });

    it("treats malformed readOnly as read-only while preserving valid read limits", async () => {
      prepare();
      const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
      const token = await scopedGrant();
      await repo.create({ qitemId: "qitem-read-only-repair", sourceSession: "peer@team", destinationSession: "caller@team", body: "answer" });
      editProfile({ readOnly: "false" });
      const call = await connect((await listen()).url, token);
      expect((await call("rig_queue_show", { qitemId: "qitem-read-only-repair" })).isError).toBe(false);
      expect((await call.client.listTools()).tools.map(tool => tool.name)).not.toContain("rig_queue_create");
      expect(warnings.mock.calls.flat().join("\n")).toMatch(/readOnly.*true or false.*read-only/);
      expect(rows()).toBe(1);
    });

    it("treats malformed peers as no peers without dropping valid object limits", async () => {
      prepare();
      const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
      const token = await scopedGrant();
      editProfile({ peerSeats: ["peer@team", "not a seat"] });
      const call = await connect((await listen()).url, token);
      expect((await call.client.listTools()).tools.map(tool => tool.name)).toContain("rig_queue_create");
      expect((await call("rig_queue_create", { destination: "peer@team", body: "work" })).structured.code).toBe("out_of_scope");
      expect((await call("rig_team")).structured.seats.map((seat: { session: string }) => seat.session)).toEqual(["caller@team"]);
      expect(warnings.mock.calls.flat().join("\n")).toMatch(/peerSeats.*array.*no peers/);
      expect(rows()).toBe(0);
    });

    it("disables only malformed object actions without restoring owner or workspace access", async () => {
      prepare();
      const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
      const token = await scopedGrant();
      await repo.create({ qitemId: "qitem-valid-object-read", sourceSession: "peer@team", destinationSession: "caller@team", body: "answer" });
      editProfile({ owner: true, workspace: true, objects: { queue: ["show", "claim", "update", "list"], team: "not operations" } });
      const call = await connect((await listen()).url, token);
      expect((await call("rig_queue_show", { qitemId: "qitem-valid-object-read" })).isError).toBe(false);
      const tools = (await call.client.listTools()).tools.map(tool => tool.name);
      expect(tools).not.toContain("rig_team");
      expect(tools).not.toContain("rig_queue_create");
      expect(tools).not.toContain("rig_up");
      expect(warnings.mock.calls.flat().join("\n")).toMatch(/objects.team.*array of operation names/);
    });

    it("keeps legacy grants without optional fields on their existing rig scope", async () => {
      prepare();
      const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
      const token = await grant("legacy");
      const call = await connect((await listen()).url, token);
      expect((await call("rig_queue_create", { destination: "stranger@team", body: "legacy rig scope" })).isError).toBe(false);
      expect(warnings).not.toHaveBeenCalled();
      const stored = JSON.parse(fs.readFileSync(tokenFile, "utf8")).principals[0];
      for (const field of ["objects", "peerSeats", "readOnly", "newWorkRetryAfterSeconds"]) expect(stored).not.toHaveProperty(field);
    });

    it("does not restore legacy authority when peerSeats lacks its objects map", async () => {
      prepare();
      const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
      const token = await grant("legacy");
      editProfile({ owner: true, workspace: true, peerSeats: ["peer@team"] });
      const call = await connect((await listen()).url, token);
      const tools = call.client.getServerCapabilities()?.tools ? (await call.client.listTools()).tools : [];
      expect(tools.map(tool => tool.name)).not.toContain("rig_queue_create");
      expect(warnings.mock.calls.flat().join("\n")).toMatch(/peerSeats.*objects map/);
      expect(rows()).toBe(0);
    });

    it("uses exact local peer membership for destinations, reads and the team without a name convention", async () => {
      prepare();
      const token = await scopedGrant();
      const call = await connect((await listen()).url, token);
      expect((await call("rig_queue_create", { qitemId: "qitem-exact-peer", destination: "peer@team", body: "work" })).isError).toBe(false);
      expect((await call("rig_queue_create", { destination: "stranger@team", body: "work" })).structured.code).toBe("out_of_scope");
      const shown = await call("rig_queue_show", { qitemId: "qitem-exact-peer" });
      expect(shown.isError).toBe(false);
      const rig = setup.rigRepo.listRigs().find(value => value.name === "team")!;
      const peer = db.prepare("SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?").get(rig.id, "pod.peer") as { id: string };
      const stranger = db.prepare("SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?").get(rig.id, "pod.stranger") as { id: string };
      setup.rigRepo.addEdge(rig.id, stranger.id, peer.id, "delegates_to");
      const team = await call("rig_team");
      expect(JSON.stringify(team.structured)).not.toContain("stranger");
      expect(team.structured.seats.map((value: { session: string }) => value.session).sort()).toEqual(["caller@team", "peer@team"]);
      expect(rows()).toBe(1);
    });

    it("removes writes from discovery and invocation for a read-only local profile", async () => {
      prepare();
      const token = await scopedGrant({ readOnly: true });
      const call = await connect((await listen()).url, token);
      const tools = (await call.client.listTools()).tools.map(tool => tool.name);
      expect(tools).toContain("rig_queue_show");
      expect(tools).not.toContain("rig_queue_create");
      expect(call.client.getInstructions()).not.toContain("rig_queue_create");
      const denied = await call("rig_queue_create", { destination: "peer@team", body: "work" }).catch(() => ({ isError: true }));
      expect(denied.isError).toBe(true);
      expect(rows()).toBe(0);
    });

    it.each([[0, 0], [0.001, 1], [1.001, 2], [600.001, 600]])("normalizes local new-work backoff (%s seconds -> %i seconds)", async (delay, seconds) => {
      prepare();
      const token = await scopedGrant({ newWorkRetryAfterSeconds: delay });
      const call = await connect((await listen()).url, token);
      const result = await call("rig_queue_create", { qitemId: "qitem-local-delay", destination: "peer@team", body: "work" });
      if (seconds === 0) {
        expect(result.isError).toBe(false);
        expect(rows()).toBe(1);
      } else {
        expect(result.structured).toMatchObject({ code: "fair_use_retry_later", retryAfterSeconds: seconds, outcome: "not_written", qitemId: "qitem-local-delay" });
        expect(rows()).toBe(0);
      }
    });

    it("applies local new-work backoff while same-id retries, reads and existing work continue", async () => {
      prepare();
      const token = await scopedGrant();
      const call = await connect((await listen()).url, token);
      expect((await call("rig_queue_create", { qitemId: "qitem-before-backoff", destination: "peer@team", body: "work" })).isError).toBe(false);
      await repo.create({ qitemId: "qitem-owned-backoff", sourceSession: "peer@team", destinationSession: "caller@team", body: "answer" });
      const stored = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
      stored.principals[0].newWorkRetryAfterSeconds = 9;
      fs.writeFileSync(tokenFile, JSON.stringify(stored));
      expect((await call("rig_queue_create", { qitemId: "qitem-new-backoff", destination: "peer@team", body: "work" })).structured)
        .toMatchObject({ code: "fair_use_retry_later", retryAfterSeconds: 9, outcome: "not_written" });
      expect((await call("rig_queue_create", { qitemId: "qitem-before-backoff", destination: "peer@team", body: "work" })).isError).toBe(false);
      expect((await call("rig_queue_show", { qitemId: "qitem-owned-backoff" })).isError).toBe(false);
      expect((await call("rig_queue_claim", { qitemId: "qitem-owned-backoff" })).isError).toBe(false);
      expect((await call("rig_queue_update", { qitemId: "qitem-owned-backoff", note: "on it" })).isError).toBe(false);
      expect(rows()).toBe(2);
    });

    it("preserves the local profile on rotation and isolates another grant's unusable optional profile", async () => {
      prepare();
      const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
      const old = await scopedGrant();
      const good = await grant("good");
      const rotated = await rotateGrant(tokenFile, "opaque-user");
      expect(rotated).not.toBeNull();
      const stored = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
      expect(stored.principals[0]).toMatchObject({ peerSeats: ["peer@team"], objects: { queue: ["create", "show", "list", "claim", "update"] } });
      stored.principals[0].objects = "unreadable";
      fs.writeFileSync(tokenFile, JSON.stringify(stored));
      const served = await listen();
      expect((await post(served.url, { Authorization: `Bearer ${old}` })).status).toBe(401);
      expect((await post(served.url, { Authorization: `Bearer ${rotated}` })).status).toBe(200);
      const narrowed = await connect(served.url, rotated!);
      const tools = narrowed.client.getServerCapabilities()?.tools ? (await narrowed.client.listTools()).tools : [];
      expect(tools.map(tool => tool.name)).not.toContain("rig_queue_create");
      expect(warnings.mock.calls.flat().join("\n")).toMatch(/objects.*object-to-operation-list map/);
      expect((await post(served.url, { Authorization: `Bearer ${good}` })).status).toBe(200);
    });
  });

});
