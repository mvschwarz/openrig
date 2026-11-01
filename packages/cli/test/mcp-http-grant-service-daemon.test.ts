// rig mcp serve --http --grant-service against the daemon's real routes and a fake grant service speaking
// openrig.grant/v1: each request's key is checked with the grant service for this daemon's self id, every answer but
// active is refused with no fallback, and an external caller reaches only its own items and the team's questions to it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { setSelfHostId } from "../../daemon/src/domain/hosts/fanout-contract.js";
import { addHumanFragment, loadHumanRegistry } from "../../daemon/src/domain/gateway/human-registry.js";
import { makeQueuePorts } from "../../daemon/src/domain/gateway/slack/queue-access.js";
import { buildOutboundMessage } from "../../daemon/src/domain/gateway/slack/message.js";
import { createHash } from "node:crypto";
import { addGrant, McpHttpConfigError, readGrantServiceHeader, startMcpHttpServer } from "../src/mcp-http.js";
import { mcpCommand } from "../src/commands/mcp.js";

const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } };
const SCHEMA = "openrig.grant/v1";
const KEY = `${"8977f2dc0000aaaa1111bbbb"}.cus_VVMAexample01.${"ab".repeat(24)}`;
const CALLER = "cus-vvmaexample01-caller@team-a";
const INSTANCE = "core-test-01";

/** The grant service's active answer for KEY, as grantV1 builds it. Core reads only principal.id of the principal. */
const active = (extra: Record<string, unknown> = {}) => ({
  schema: SCHEMA, status: "active",
  principal: { id: "cus_VVMAexample01", kind: "external_caller", label: "External caller …mple01" },
  grant: { id: "8977f2dc0000aaaa1111bbbb", version: 6, updated_at: "2026-10-26T10:30:00.000Z", expires_at: null, cache_seconds: 0, revocation: "per_request" },
  environment: { id: "team-a", core_instance: INSTANCE, studio: "https://studio.example", lead: "lead@team-a" },
  seat: CALLER, rigs: ["team-a"], artifact_roots: ["proof"], access_class: "work",
  objects: { queue: ["create", "show", "list"], artifact: ["read"] }, team: { id: "software-factory", version: "1" },
  ...extra,
});

describe("rig mcp serve --http --grant-service on the daemon's routes", () => {
  let db: Database.Database;
  let home: string;
  let shared: string;
  let repo: QueueRepository;
  let daemon: ServerType;
  let daemonUrl: string;
  let setup: ReturnType<typeof createTestApp>;
  let service: http.Server;
  let serviceUrl: string;
  /** What the fake authority answers next: [HTTP status, body or raw text]. */
  let answer: () => [number, unknown];
  /** A daemon route made to fail: its answer, or undefined to serve the request as usual. */
  let broken: ((req: Request) => Response | undefined) | undefined;
  let asked: Array<{ headers: http.IncomingHttpHeaders; body: string }>;
  const closers: Array<() => Promise<void>> = [];
  const saved = { home: process.env.OPENRIG_HOME, session: process.env.OPENRIG_SESSION_NAME };

  beforeEach(async () => {
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-grant-"));
    shared = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-grant-shared-")));
    process.env.OPENRIG_HOME = home;
    process.env.OPENRIG_SESSION_NAME = "env-seat@elsewhere";
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    setup = createTestApp(db, { appDeps: { queueRepo: repo, filesAllowlist: [{ name: "proof", canonicalPath: shared }] } });
    broken = undefined;
    const fetchRoute = (...args: Parameters<typeof setup.app.fetch>) => broken?.(args[0]) ?? setup.app.fetch(...args);
    daemon = await new Promise<ServerType>((resolve) => { const s = serve({ fetch: fetchRoute, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
    daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
    setSelfHostId(INSTANCE);
    asked = [];
    answer = () => [200, active()];
    service = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        asked.push({ headers: req.headers, body });
        const [status, reply] = answer();
        res.writeHead(status, { "Content-Type": "application/json" }).end(typeof reply === "string" ? reply : JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}/api/connector/v1/grant`;
    seat("team-a", "cus-vvmaexample01-caller");
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await new Promise<void>((resolve) => service.close(() => resolve()));
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    setSelfHostId(null);
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(shared, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = saved.home;
    if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = saved.session;
  });

  /** A managed seat the daemon's whoami can answer for. */
  function seat(rigName: string, member: string) {
    const rig = setup.rigRepo.listRigs?.().find((r: { name: string }) => r.name === rigName) ?? setup.rigRepo.createRig(rigName);
    const node = setup.rigRepo.addNode(rig.id, `pod.${member}`, { role: "worker" });
    setup.sessionRegistry.registerSession(node.id, `${member}@${rigName}`);
  }

  async function listen(header?: { name: string; value: string }) {
    const served = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile: path.join(home, "mcp-http-tokens.json"),
      grantService: { url: serviceUrl, ...(header ? { header } : {}), timeoutMs: 1_000 } });
    closers.push(() => served.close());
    return served;
  }

  async function connect(url: string, token = KEY) {
    const client = new Client({ name: "grant-service-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    closers.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, structured: result.structuredContent as Record<string, any>, text: (result.content as Array<{ text: string }>)[0]?.text ?? "" };
    };
    return Object.assign(call, { tools: async () => (await client.listTools()).tools.map((tool) => tool.name) });
  }

  const post = (url: string, headers: Record<string, string> = {}) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(INITIALIZE),
  });
  const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
  const create = (sourceSession: string, destinationSession: string, body: string) =>
    repo.create({ sourceSession, destinationSession, body, nudge: false } as never);

  it("asks the grant service on every request with the raw key and this daemon's self id, acts as the grant's seat, and never reads the token file", async () => {
    const fileToken = await addGrant(path.join(home, "mcp-http-tokens.json"), { name: "local", seat: "local@team-a", rigs: ["team-a"], roots: [], workspace: false, owner: true });
    const served = await listen({ name: "x-example-bypass", value: "preview-secret" });
    expect(served.authenticated).toBe(true);
    const asExternal = await connect(served.url);
    expect((await asExternal.tools()).sort()).toEqual(["rig_artifact_read", "rig_queue_create", "rig_queue_list", "rig_queue_show"]);
    const created = await asExternal("rig_queue_create", { destination: "lead@team-a", body: "please build it" });
    expect(created.isError).toBe(false);
    expect(repo.getById(created.structured.qitemId)?.sourceSession).toBe(CALLER);

    expect(asked.length).toBeGreaterThanOrEqual(3);
    for (const request of asked) {
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.headers["x-example-bypass"]).toBe("preview-secret");
      expect(JSON.parse(request.body)).toEqual({ instance: INSTANCE });
    }
    // A token-file credential, even an owner's, is just an unknown key here, refused before any call to the grant service.
    const before = asked.length;
    expect((await post(served.url, { Authorization: `Bearer ${fileToken}` })).status).toBe(401);
    expect(asked.length).toBe(before);
  });

  /** This host's own daemon, provably: the id it minted (read from its database) is the id its /healthz answers with. */
  function thisHostsDaemon() {
    const identity = path.join(home, "identity.sqlite");
    const idDb = createDb(identity);
    idDb.exec("CREATE TABLE self_host_identity (singleton INTEGER PRIMARY KEY, host_id TEXT)");
    idDb.prepare("INSERT INTO self_host_identity VALUES (1, ?)").run(INSTANCE);
    idDb.close();
    vi.stubEnv("OPENRIG_DB", identity);
    closers.push(async () => { vi.unstubAllEnvs(); });
  }

  it("records the grant service's principal, with its grant id and version, on the rows its caller writes", async () => {
    thisHostsDaemon();
    const asExternal = await connect((await listen()).url);
    const created = await asExternal("rig_queue_create", { destination: "lead@team-a", body: "attributed to the external caller" });
    expect(created.isError).toBe(false);
    expect(db.prepare("SELECT identity_provenance AS p, identity_principal AS who FROM queue_transitions WHERE qitem_id = ?").get(created.structured.qitemId))
      .toEqual({ p: "principal:v1", who: JSON.stringify({ source: "grant-service", id: "cus_VVMAexample01", grant: "8977f2dc0000aaaa1111bbbb", version: 6 }) });
  });

  it("refuses every answer but active, a timeout, an unbound instance and a missing seat, with no fallback and nothing written", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const served = await listen();
      const cases: Array<[() => [number, unknown], number, string]> = [
        [() => [401, { schema: SCHEMA, status: "unknown" }], 401, "unauthenticated"],
        [() => [401, { schema: SCHEMA, status: "revoked" }], 401, "unauthenticated"],
        [() => [401, { schema: SCHEMA, status: "expired" }], 401, "unauthenticated"],
        [() => [403, { schema: SCHEMA, status: "wrong_instance" }], 401, "unauthenticated"],
        [() => [400, { schema: SCHEMA, status: "malformed" }], 503, "grant_authority_unavailable"],
        [() => [503, { schema: SCHEMA, status: "unavailable" }], 503, "grant_authority_unavailable"],
        [() => [200, active({ schema: "openrig.grant/v2" })], 503, "grant_authority_unavailable"],
        // No other name stands in for the schema, a retired one included.
        [() => [200, active({ schema: "openrig.legacy.grant/v1" })], 503, "grant_authority_unavailable"],
        [() => [200, "<html>preview login</html>"], 503, "grant_authority_unavailable"],
        [() => [200, active({ environment: { id: "team-a", core_instance: "another-core" } })], 503, "grant_authority_unavailable"],
        [() => [200, active({ rigs: ["team-b"] })], 503, "grant_authority_unavailable"],
        [() => [200, active({ grant: { ...active().grant, expires_at: "2026-01-01T00:00:00.000Z" } })], 401, "unauthenticated"],
        [() => [200, active({ seat: "cus-nobody01-caller@team-a" })], 503, "seat_unavailable"],
      ];
      for (const [next, status, error] of cases) {
        answer = next;
        const res = await post(served.url, { Authorization: `Bearer ${KEY}` });
        expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([status, error]);
      }
      // No key, or one that isn't a grant key: refused before the grant service is asked.
      const before = asked.length;
      for (const headers of [{}, { Authorization: "Bearer orm_local-token" }, { Authorization: `Bearer ${KEY}x` }]) {
        expect((await post(served.url, headers)).status).toBe(401);
      }
      expect(asked.length).toBe(before);
      // A daemon with no self id can't bind a key to an instance: refused, and the grant service isn't asked.
      setSelfHostId(null);
      const unbound = await listen();
      answer = () => [200, active()];
      expect((await post(unbound.url, { Authorization: `Bearer ${KEY}` })).status).toBe(503);
      expect(asked.length).toBe(before);
      // The grant service gone: unavailable, never served as anyone.
      setSelfHostId(INSTANCE);
      await new Promise<void>((resolve) => service.close(() => resolve()));
      service = http.createServer();
      expect((await post(served.url, { Authorization: `Bearer ${KEY}` })).status).toBe(503);
      expect(rows()).toBe(0);
    } finally {
      quiet.mockRestore();
    }
  });

  /** Seats created as `rig import --materialize-only` creates them, through the daemon's own route: nodes with no session
   *  and no occupant. */
  async function unlaunched(rigName: string, logicalIds: string[]) {
    const pods = new Map<string, string[]>();
    for (const id of logicalIds) {
      const [pod, member] = id.split(".") as [string, string];
      pods.set(pod, [...(pods.get(pod) ?? []), member]);
    }
    const spec = [`version: "0.2"`, `name: ${rigName}`, "pods:", ...[...pods].flatMap(([pod, members]) => [`  - id: ${pod}`, `    label: ${pod}`, "    members:",
      ...members.flatMap((member) => [`      - id: ${member}`, '        agent_ref: "builtin:terminal"', "        profile: none", "        runtime: terminal", "        cwd: /tmp"]),
      "    edges: []"]), "edges: []", ""].join("\n");
    const res = await fetch(`${daemonUrl}/api/rigs/import/materialize`, { method: "POST", headers: { "Content-Type": "text/plain", "X-Rig-Root": "/tmp" }, body: spec });
    expect(res.status).toBe(201);
  }
  /** A new rig of that name whose seats have no session, as a materialized rig's seats don't. */
  function sessionless(rigName: string, ...logicalIds: string[]) {
    const rig = setup.rigRepo.createRig(rigName);
    for (const id of logicalIds) setup.rigRepo.addNode(rig.id, id, { role: "worker" });
    return rig.id;
  }
  /** The grant service's active answer naming a seat in its own rig. */
  const grantForSeat = (seat: string) => active({ seat, rigs: [seat.split("@")[1]] });
  const count = (table: "sessions" | "nodes") => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("serves a seat that was created but never launched as the grant's seat, through a create and show, and creates or launches nothing", async () => {
    thisHostsDaemon();
    await unlaunched("cust-team", ["cus-vvmaexample02.caller", "workshop.lead"]);
    const seat = "cus-vvmaexample02-caller@cust-team";
    answer = () => [200, grantForSeat(seat)];
    const before = { sessions: count("sessions"), nodes: count("nodes") };
    const served = await listen();
    expect((await post(served.url, { Authorization: `Bearer ${KEY}` })).status).toBe(200);
    const asExternal = await connect(served.url);
    expect((await asExternal.tools()).sort()).toEqual(["rig_artifact_read", "rig_queue_create", "rig_queue_list", "rig_queue_show"]);
    const created = await asExternal("rig_queue_create", { destination: "workshop-lead@cust-team", body: "please build it" });
    expect(created.isError).toBe(false);
    const shown = await asExternal("rig_queue_show", { qitemId: created.structured.qitemId });
    expect(shown.structured.item).toMatchObject({ qitemId: created.structured.qitemId, sourceSession: seat, destinationSession: "workshop-lead@cust-team" });
    expect(db.prepare("SELECT identity_provenance AS p, identity_principal AS who FROM queue_transitions WHERE qitem_id = ?").get(created.structured.qitemId))
      .toEqual({ p: "principal:v1", who: JSON.stringify({ source: "grant-service", id: "cus_VVMAexample01", grant: "8977f2dc0000aaaa1111bbbb", version: 6 }) });
    expect({ sessions: count("sessions"), nodes: count("nodes") }).toEqual(before);
  });

  it("a seat whoami doesn't know is here only as exactly one node of the one active rig of that name, and an unreadable registry is never the seat", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const served = await listen();
      const outcome = async (seat: string) => {
        answer = () => [200, grantForSeat(seat)];
        const res = await post(served.url, { Authorization: `Bearer ${KEY}` });
        return [res.status, res.status === 200 ? "served" : ((await res.json()) as { error: string }).error];
      };
      const before = { sessions: count("sessions"), rows: rows() };
      // No such node in the rig, no rig of that name, or only an archived rig's node: not here.
      const rigOne = sessionless("rig-one", "cus-one.caller");
      expect(await outcome("cus-one-other@rig-one")).toEqual([503, "seat_unavailable"]);
      expect(await outcome("cus-one-caller@rig-none")).toEqual([503, "seat_unavailable"]);
      setup.rigRepo.archiveRig(sessionless("rig-old", "cus-old.caller"));
      expect(await outcome("cus-old-caller@rig-old")).toEqual([503, "seat_unavailable"]);
      // An archived rig of the same name doesn't make the active one ambiguous.
      sessionless("rig-old", "cus-old.caller");
      expect(await outcome("cus-old-caller@rig-old")).toEqual([200, "served"]);
      // Two active rigs of that name, or two nodes whose names derive alike: ambiguous, and neither is chosen.
      sessionless("rig-two", "cus-two.caller");
      sessionless("rig-two", "cus-two.caller");
      expect(await outcome("cus-two-caller@rig-two")).toEqual([503, "grant_authority_unavailable"]);
      sessionless("rig-dup", "cus-dup.caller", "cus.dup-caller");
      expect(await outcome("cus-dup-caller@rig-dup")).toEqual([503, "grant_authority_unavailable"]);
      // A rig list or node list that fails or reads malformed, or whoami failing, is refused: never the seat.
      const failures: Array<[RegExp, () => Response]> = [
        [/^\/api\/rigs\/summary$/, () => Response.json({ error: "down" }, { status: 500 })],
        [/^\/api\/rigs\/summary$/, () => Response.json({ rigs: [] })],
        // The real rig beside a malformed one, or the matching rig with no id or an archive mark of another kind: the list
        // isn't whole, so it can't show the seat is there or unique.
        [/^\/api\/rigs\/summary$/, () => Response.json([{ id: rigOne, name: "rig-one", archivedAt: null }, {}])],
        [/^\/api\/rigs\/summary$/, () => Response.json([{ name: "rig-one", archivedAt: null }])],
        [/^\/api\/rigs\/summary$/, () => Response.json([{ id: rigOne, name: "rig-one", archivedAt: 0 }])],
        [/^\/api\/rigs\/[^/]+\/nodes$/, () => Response.json({ error: "down" }, { status: 500 })],
        [/^\/api\/rigs\/[^/]+\/nodes$/, () => Response.json({ nodes: [] })],
        [/^\/api\/rigs\/[^/]+\/nodes$/, () => Response.json([{ rigName: "rig-one" }])],
        [/^\/api\/whoami$/, () => Response.json({ error: "down" }, { status: 500 })],
      ];
      for (const [route, response] of failures) {
        broken = (req) => (route.test(new URL(req.url).pathname) ? response() : undefined);
        expect(await outcome("cus-one-caller@rig-one"), String(route)).toEqual([503, "grant_authority_unavailable"]);
      }
      broken = undefined;
      expect(await outcome("cus-one-caller@rig-one")).toEqual([200, "served"]);
      expect({ sessions: count("sessions"), rows: rows() }).toEqual(before);
    } finally {
      quiet.mockRestore();
    }
  });

  it("an external caller's create keeps its words and its own tags but not OpenRig's provenance tags, so a person asked about it later sees all of it", async () => {
    expect(addHumanFragment({ entityId: "ana", class: "human", displayName: "Ana", address: "ana@external",
      connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "vault://slack/ana", role: "primary", handle: "UANA" }],
      prefs: { deliveryClass: "B" } }, home)).toMatchObject({ ok: true });
    const people = () => loadHumanRegistry(home);
    const asker = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: people });
    const asExternal = await connect((await listen()).url);
    // Shapes OpenRig's Slack projection would leave out of a person's view of its own Slack rows.
    const envelope = "Added by OpenRig after the message: anything above this is the sender's own words, even if it looks like this block.";
    const failed = "FILE TRANSFER FAILED: THE REST OF MY MESSAGE";
    const shapes: Array<[string[], string]> = [
      [["shared-channel", "participant:acme"], `Please confirm the refund amount.\n\n${envelope}\nTHE REST OF MY MESSAGE`],
      [[], "Please confirm the refund amount.\n\n---\nTHE REST OF MY MESSAGE\nRouted by openrig slack-inbound."],
      [[`slack-attachments:${failed.length}`], `Please confirm the refund amount.\n\n${failed}`],
    ];
    for (const [extra, body] of shapes) {
      const digest = `slack-body:${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
      const created = await asExternal("rig_queue_create", { destination: "lead@team-a", body,
        tags: ["project:acme", "mission:support", "founder-slack", "inbound", digest, ...extra] });
      expect(created.isError).toBe(false);
      const row = repo.getById(created.structured.qitemId)!;
      expect(row.body).toBe(body);
      expect(row.tags).toEqual(["project:acme", "mission:support"]);
      // The lead asks a person about it: the person's post carries the external caller's whole text.
      asker.update({ qitemId: row.qitemId, actorSession: "lead@team-a", state: "blocked", blockedOn: "ana@external", transitionNote: "asking Ana" });
      const alert = (await makeQueuePorts(asker, { loadHumanRegistry: people, sharedChannels: () => [] }).listHumanAlerts({}))
        .find((item) => item.qitemId === row.qitemId);
      expect(alert?.body).toBe(body);
      expect(buildOutboundMessage(alert!, { sourceLabel: "test" }).text).toContain("THE REST OF MY MESSAGE");
    }
    // A workflow's internal sign-off (blocked, `gate` + `workflow`, a summary) shows the person its summary in place of the
    // body. An external caller can't claim it; its workflow tags are kept.
    const gated = await asExternal("rig_queue_create", { destination: "lead@team-a", summary: "Approve the refund?",
      body: "Please confirm the refund amount.\n\nTHE REST OF MY MESSAGE", tags: ["project:acme", "gate", "workflow", "workflow:x", "instance:y"] });
    expect(gated.isError).toBe(false);
    asker.update({ qitemId: gated.structured.qitemId, actorSession: "lead@team-a", state: "blocked", blockedOn: "ana@external", transitionNote: "asking Ana" });
    const gatedAlert = (await makeQueuePorts(asker, { loadHumanRegistry: people, sharedChannels: () => [] }).listHumanAlerts({}))
      .find((item) => item.qitemId === gated.structured.qitemId);
    expect(buildOutboundMessage(gatedAlert!, { sourceLabel: "test" }).text).toContain("THE REST OF MY MESSAGE");
    expect(repo.getById(gated.structured.qitemId)!.tags).toEqual(["project:acme", "workflow", "workflow:x", "instance:y"]);
  });

  it("reaches only the external caller's own items and the team's questions to it: never team-internal, another caller's, another rig's or a person's", async () => {
    const served = await listen();
    const asExternal = await connect(served.url);
    const before = rows();
    for (const destination of ["cus-otherone01-caller@team-a", CALLER, "lead@team-b", "alex@external", "lead@team-a@elsewhere"]) {
      expect((await asExternal("rig_queue_create", { destination, body: "not allowed" })).structured).toMatchObject({ ok: false, code: "out_of_scope" });
    }
    expect(rows()).toBe(before);

    const own = (await asExternal("rig_queue_create", { destination: "lead@team-a", body: "my task" })).structured.qitemId as string;
    const question = await create("lead@team-a", CALLER, "a question for the external caller");
    const internal = await create("lead@team-a", "impl@team-a", "SECRET team-internal work");
    const otherCaller = await create("cus-otherone01-caller@team-a", CALLER, "SECRET from another external caller");
    const otherRig = await create("lead@team-b", "impl@team-b", "SECRET other rig");
    expect((await asExternal("rig_queue_show", { qitemId: own })).isError).toBe(false);
    expect((await asExternal("rig_queue_show", { qitemId: question.qitemId })).isError).toBe(false);
    for (const hidden of [internal, otherCaller, otherRig]) {
      const shown = await asExternal("rig_queue_show", { qitemId: hidden.qitemId });
      expect(shown.structured).toMatchObject({ code: "out_of_scope" });
      expect(shown.text).not.toContain("SECRET");
    }
    for (const args of [{ all: true }, { all: true, destination: "impl@team-a" }, { all: true, source: "lead@team-a" }]) {
      const listed = await asExternal("rig_queue_list", args);
      expect(JSON.stringify(listed.structured)).not.toContain("SECRET");
    }
    const listed = JSON.stringify((await asExternal("rig_queue_list", { all: true })).structured);
    expect(listed).toContain(own);
    expect(listed).toContain(question.qitemId);

    // Its task handed on inside the team: the successor stays hidden. Handed back to it: named.
    const handOn = (id: string, to: string) => fetch(`${daemonUrl}/api/queue/${id}/handoff`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "lead@team-a" }, body: JSON.stringify({ toSession: to, nudge: false }) });
    expect((await handOn(own, "impl@team-a")).status).toBe(201);
    expect((await asExternal("rig_queue_show", { qitemId: own })).structured.successor).toEqual({ unknown: true, code: "out_of_scope" });
    const second = (await asExternal("rig_queue_create", { destination: "lead@team-a", body: "another task" })).structured.qitemId as string;
    expect((await handOn(second, CALLER)).status).toBe(201);
    expect((await asExternal("rig_queue_show", { qitemId: second })).structured.successor).toMatchObject({ destinationSession: CALLER });

    // Artifacts: its own item's, under its named root; never by root and path alone, never a question's.
    fs.writeFileSync(path.join(shared, "result.md"), "RESULT body");
    for (const id of [own, question.qitemId]) db.prepare("UPDATE queue_items SET evidence_ref = ? WHERE qitem_id = ?").run(path.join(shared, "result.md"), id);
    expect((await asExternal("rig_artifact_read", { qitemId: own })).text).toContain("RESULT body");
    expect((await asExternal("rig_artifact_read", { qitemId: question.qitemId })).structured).toMatchObject({ code: "out_of_scope" });
    expect((await asExternal("rig_artifact_read", { root: "proof", path: "result.md" })).structured).toMatchObject({ code: "out_of_scope" });
  });

  it("never names a handed-on item's out-of-scope owner: not in show, list, a cross-host successor or a sibling successor", async () => {
    const served = await listen();
    const asExternal = await connect(served.url);
    const row = (id: string, source: string, destination: string, extra: Record<string, string | null> = {}) => {
      const fields = { qitem_id: id, ts_created: "2026-10-26T00:00:00.000Z", ts_updated: "2026-10-26T00:00:00.000Z", source_session: source,
        destination_session: destination, state: "pending", priority: "routine", body: "x", handed_off_from: null, ...extra };
      db.prepare(`INSERT INTO queue_items (${Object.keys(fields).join(", ")}) VALUES (${Object.keys(fields).map(() => "?").join(", ")})`).run(...Object.values(fields));
    };
    const handOn = (id: string, to: string) => fetch(`${daemonUrl}/api/queue/${id}/handoff`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "lead@team-a" }, body: JSON.stringify({ toSession: to, nudge: false }) });

    // Handed on inside the team: the fact stays, the new owner appears nowhere in show or list.
    const own = (await asExternal("rig_queue_create", { destination: "lead@team-a", body: "my task" })).structured.qitemId as string;
    expect((await handOn(own, "impl@team-a")).status).toBe(201);
    const shown = await asExternal("rig_queue_show", { qitemId: own });
    expect(shown.text).not.toContain("impl@team-a");
    expect(shown.structured.item).toMatchObject({ state: "handed-off", closureReason: "handed_off_to", handedOffTo: null, closureTarget: null,
      closingTransition: { closureReason: "handed_off_to", closureTarget: null, transitionNote: "handed on (out of scope)" } });
    expect(shown.structured.successor).toEqual({ unknown: true, code: "out_of_scope" });
    expect(JSON.stringify((await asExternal("rig_queue_list", { all: true })).structured)).not.toContain("impl@team-a");

    // A cross-host successor's parties can't be checked here: its id and host stay hidden.
    const remote = (await asExternal("rig_queue_create", { destination: "lead@team-a", body: "goes far" })).structured.qitemId as string;
    db.prepare("UPDATE queue_items SET state = 'handed-off', closure_reason = 'handed_off_to', closure_target = 'qitem-far01@other-host', handed_off_to = 'impl@team-a@other-host' WHERE qitem_id = ?").run(remote);
    const far = await asExternal("rig_queue_show", { qitemId: remote });
    expect(far.structured.successor).toEqual({ unknown: true, code: "out_of_scope" });
    expect(far.text).not.toContain("other-host");

    // A successor addressed to the caller but sent by another caller-shaped seat isn't the team's; nor is a sibling the
    // caller can't see named among otherSuccessors.
    const forged = (await asExternal("rig_queue_create", { destination: "lead@team-a", body: "x" })).structured.qitemId as string;
    db.prepare("UPDATE queue_items SET state = 'handed-off', closure_reason = 'handed_off_to', closure_target = ?, handed_off_to = ? WHERE qitem_id = ?").run(CALLER, CALLER, forged);
    row("qitem-forged-next", "cus-otherone01-caller@team-a", CALLER, { handed_off_from: forged });
    expect((await asExternal("rig_queue_show", { qitemId: forged })).structured.successor).toEqual({ unknown: true, code: "out_of_scope" });
    const split = (await asExternal("rig_queue_create", { destination: "lead@team-a", body: "x" })).structured.qitemId as string;
    db.prepare("UPDATE queue_items SET state = 'handed-off', closure_reason = 'handed_off_to', closure_target = ?, handed_off_to = ? WHERE qitem_id = ?").run(CALLER, CALLER, split);
    row("qitem-split-hidden", "lead@team-a", "impl@team-a", { handed_off_from: split, ts_created: "2026-10-26T00:00:01.000Z" });
    row("qitem-split-back", "lead@team-a", CALLER, { handed_off_from: split, ts_created: "2026-10-26T00:00:02.000Z" });
    const back = await asExternal("rig_queue_show", { qitemId: split });
    expect(back.structured.successor).toMatchObject({ qitemId: "qitem-split-back", destinationSession: CALLER });
    expect(back.text).not.toContain("qitem-split-hidden");
  });

  it("an id-reuse conflict never names another item's parties, and still names the external caller's own", async () => {
    const served = await listen();
    const asExternal = await connect(served.url);
    const own = (await asExternal("rig_queue_create", { destination: "lead@team-a", body: "my task" })).structured.qitemId as string;
    // Reusing the id of an item it can't see: taken, nothing more. Its own item's conflict still names its own parties.
    const internal = await create("lead@team-a", "impl@team-a", "SECRET team work");
    const reused = await asExternal("rig_queue_create", { destination: "lead@team-a", body: "x", qitemId: internal.qitemId });
    expect(reused.structured).toMatchObject({ ok: false, code: "qitem_id_reuse" });
    expect(reused.text).not.toContain("impl@team-a");
    const mine = await asExternal("rig_queue_create", { destination: "qa@team-a", body: "x", qitemId: own });
    expect(mine.structured).toMatchObject({ code: "qitem_id_reuse" });
    expect(mine.text).toContain(CALLER);
  });

  /** An external caller's connection, the team lead's daemon writes, and its own task creator. */
  async function externalAndLead() {
    const served = await listen();
    const asExternal = await connect(served.url);
    const asLead = (path: string, body: unknown) => fetch(`${daemonUrl}/api/queue/${path}`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "lead@team-a" }, body: JSON.stringify(body) });
    const mine = async (body: string) => (await asExternal("rig_queue_create", { destination: "lead@team-a", body })).structured.qitemId as string;
    return { asExternal, asLead, mine };
  }

  it("a create retry after a handoff returns the stored row through the same projection, creating nothing again", async () => {
    const { asExternal, asLead, mine } = await externalAndLead();
    const count = (sql: string, id: string) => (db.prepare(sql).get(id) as { n: number }).n;
    const retried = await mine("retry me");
    expect((await asLead(`${retried}/handoff`, { toSession: "impl@team-a", nudge: false })).status).toBe(201);
    for (const body of ["retry me", "retry me, changed"]) {
      const again = await asExternal("rig_queue_create", { destination: "lead@team-a", body, qitemId: retried });
      expect(again.isError).toBe(false);
      expect(again.text).not.toContain("impl@team-a");
    }
    expect(count("SELECT COUNT(*) AS n FROM queue_items WHERE qitem_id = ?", retried)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM queue_items WHERE handed_off_from = ?", retried)).toBe(1);
    const far = await mine("far");
    db.prepare("UPDATE queue_items SET state = 'handed-off', closure_reason = 'handed_off_to', closure_target = 'qitem-far02@other-host', handed_off_to = 'impl@team-a@other-host' WHERE qitem_id = ?").run(far);
    expect((await asExternal("rig_queue_create", { destination: "lead@team-a", body: "far", qitemId: far })).text).not.toContain("other-host");
  });

  it("a task parked on an internal child reads blocked, with no child id, owner or state anywhere", async () => {
    const { asExternal, asLead, mine } = await externalAndLead();
    const child = await create("lead@team-a", "qa@team-b", "SECRET child");
    const parked = await mine("park me");
    expect((await asLead(`${parked}/update`, { state: "blocked", blockedOn: child.qitemId, transitionNote: `waiting on ${child.qitemId} (qa@team-b)` })).status).toBe(200);
    const shown = await asExternal("rig_queue_show", { qitemId: parked });
    expect(shown.structured.item).toMatchObject({ state: "blocked", blockedOn: null });
    for (const text of [shown.text, (await asExternal("rig_queue_list", { all: true })).text]) {
      expect(text).not.toContain(child.qitemId);
      expect(text).not.toContain("qa@team-b");
    }
  });

  it("an escalated task keeps its closure, without the escalation target or the note naming it", async () => {
    const { asExternal, asLead, mine } = await externalAndLead();
    const escalated = await mine("escalate me");
    expect((await asLead(`${escalated}/update`, { state: "done", closureReason: "escalation", closureTarget: "alex@external", transitionNote: "escalated to alex@external" })).status).toBe(200);
    const shown = await asExternal("rig_queue_show", { qitemId: escalated });
    expect(shown.structured.item).toMatchObject({ closureReason: "escalation", closureTarget: null,
      closingTransition: { closureTarget: null, transitionNote: "escalated (out of scope)" } });
    expect(shown.text).not.toContain("alex@external");
  });

  it("a superseded task keeps its closure without the replacement's id, while a denial's reason stays readable", async () => {
    const { asExternal, asLead, mine } = await externalAndLead();
    const replacement = await create("lead@team-a", "impl@team-a", "the replacement");
    const superseded = await mine("supersede me");
    expect((await asLead(`${superseded}/update`, { state: "done", closureReason: "superseded", closureTarget: replacement.qitemId })).status).toBe(200);
    const shown = await asExternal("rig_queue_show", { qitemId: superseded });
    expect(shown.structured.item).toMatchObject({ closureReason: "superseded", closureTarget: null });
    expect(shown.text).not.toContain(replacement.qitemId);
    // A denial's reason is the team's own text, not a party.
    const denied = await mine("deny me");
    expect((await asLead(`${denied}/update`, { state: "done", closureReason: "denied", closureTarget: "outside what this team does" })).status).toBe(200);
    expect((await asExternal("rig_queue_show", { qitemId: denied })).structured.item).toMatchObject({ closureReason: "denied", closureTarget: "outside what this team does" });
  });

  /** One request with exactly these headers (a proxy's own Host included), read whole. */
  function raw(url: string, method: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const body = method === "POST" ? JSON.stringify(INITIALIZE) : undefined;
      const req = http.request({ host: target.hostname, port: target.port, path: target.pathname, method,
        headers: { ...(body ? { "Content-Type": "application/json", Accept: "application/json, text/event-stream" } : {}), ...headers } }, (res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  it("with OAuth discovery set, serves only the configured resource's metadata, without a credential or a grant-service call, and challenges a missing credential apart from a refused one", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const resource = "https://mcp.example/team/mcp";
      const issuer = "https://account.example";
      const metadataUrl = "https://mcp.example/.well-known/oauth-protected-resource/team/mcp";
      const metadataPath = "/.well-known/oauth-protected-resource/team/mcp";
      // Without it: no metadata, and the challenge is the realm alone.
      const plain = await listen();
      const plainRoot = plain.url.replace(/\/mcp$/, "");
      expect((await raw(`${plainRoot}${metadataPath}`, "GET")).status).toBe(404);
      expect((await raw(plain.url, "POST")).headers["www-authenticate"]).toBe('Bearer realm="openrig"');

      const served = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile: path.join(home, "mcp-http-tokens.json"),
        grantService: { url: serviceUrl, timeoutMs: 1_000 }, oauth: { resource, issuer } });
      closers.push(() => served.close());
      const root = served.url.replace(/\/mcp$/, "");
      const before = asked.length;
      // The configured values exactly, whatever Host the proxy sends, and the grant service isn't asked.
      for (const headers of [{}, { Host: "evil.example" }]) {
        const metadata = await raw(`${root}${metadataPath}`, "GET", headers);
        expect(metadata.status).toBe(200);
        expect(JSON.parse(metadata.body)).toEqual({ resource, authorization_servers: [issuer], scopes_supported: ["openrig.work"], bearer_methods_supported: ["header"] });
      }
      // Only that path: no root document, no local /mcp alias, and GET only.
      for (const [pathname, method] of [["/.well-known/oauth-protected-resource", "GET"], ["/.well-known/oauth-protected-resource/mcp", "GET"], [metadataPath, "POST"]] as const) {
        expect((await raw(`${root}${pathname}`, method)).status, `${method} ${pathname}`).toBe(404);
      }
      expect(asked.length).toBe(before);

      // No credential: pointed at the metadata, with no error. A refused one: also invalid_token. Whatever the Host.
      const missing = await raw(served.url, "POST", { Host: "evil.example" });
      expect([missing.status, missing.headers["www-authenticate"]]).toEqual([401, `Bearer realm="openrig", resource_metadata="${metadataUrl}"`]);
      const refused = `Bearer realm="openrig", resource_metadata="${metadataUrl}", error="invalid_token"`;
      expect((await raw(served.url, "POST", { Authorization: "Bearer orm_not-a-grant-key" })).headers["www-authenticate"]).toBe(refused);
      for (const status of ["unknown", "revoked", "expired", "wrong_instance"]) {
        answer = () => [401, { schema: SCHEMA, status }];
        const res = await raw(served.url, "POST", { Authorization: `Bearer ${KEY}` });
        expect([res.status, res.headers["www-authenticate"]], status).toEqual([401, refused]);
      }
      // The grant service or the seat unavailable stays a 503 with no challenge.
      answer = () => [503, { schema: SCHEMA, status: "unavailable" }];
      const outage = await raw(served.url, "POST", { Authorization: `Bearer ${KEY}` });
      expect([outage.status, outage.headers["www-authenticate"]]).toEqual([503, undefined]);
      answer = () => [200, active({ seat: "cus-nobody01-caller@team-a" })];
      const noSeat = await raw(served.url, "POST", { Authorization: `Bearer ${KEY}` });
      expect([noSeat.status, noSeat.headers["www-authenticate"]]).toEqual([503, undefined]);
      // A valid key is served as before.
      answer = () => [200, active()];
      expect((await raw(served.url, "POST", { Authorization: `Bearer ${KEY}` })).status).toBe(200);
    } finally {
      quiet.mockRestore();
    }
  });

  it("refuses OAuth discovery at startup without a grant service, or for a resource or issuer of any other shape", async () => {
    const start = (oauth: { resource: string; issuer: string }, withService = true) => startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0,
      tokenFile: path.join(home, "mcp-http-tokens.json"), ...(withService ? { grantService: { url: serviceUrl } } : {}), oauth });
    const issuer = "https://account.example";
    await expect(start({ resource: "https://mcp.example/team/mcp", issuer }, false)).rejects.toThrow(McpHttpConfigError);
    for (const resource of ["http://mcp.example/team/mcp", "https://mcp.example/team/mcp?x", "https://mcp.example/team/mcp#y",
      "https://u@mcp.example/team/mcp", "https://mcp.example/team", "https://mcp.example/team/mcp/", "https://MCP.example/team/mcp",
      "https://mcp.example:443/team/mcp", "not a url"]) {
      await expect(start({ resource, issuer }), resource).rejects.toThrow(McpHttpConfigError);
    }
    for (const bad of ["http://account.example", "https://account.example?x", "https://account.example#y", "https://u@account.example", "not a url"]) {
      await expect(start({ resource: "https://mcp.example/team/mcp", issuer: bad }), bad).rejects.toThrow(McpHttpConfigError);
    }
  });

  it("rig mcp serve takes --oauth-resource and --oauth-issuer together, and only with --http --grant-service", async () => {
    const lines: string[] = [];
    const quiet = vi.spyOn(console, "error").mockImplementation((line) => { lines.push(String(line)); });
    const exitCode = process.exitCode;
    try {
      for (const args of [
        ["--http", "--grant-service", serviceUrl, "--oauth-resource", "https://mcp.example/team/mcp"],
        ["--http", "--grant-service", serviceUrl, "--oauth-issuer", "https://account.example"],
        ["--http", "--oauth-resource", "https://mcp.example/team/mcp", "--oauth-issuer", "https://account.example"],
      ]) {
        process.exitCode = undefined;
        await mcpCommand().parseAsync(["serve", "--port", "1", ...args], { from: "user" });
        expect(process.exitCode, args.join(" ")).toBe(1);
      }
      expect(lines.filter((line) => line.includes("--oauth-resource and --oauth-issuer"))).toHaveLength(3);
    } finally {
      process.exitCode = exitCode;
      quiet.mockRestore();
    }
  });

  it("reads the grant request's header from a one-line secret file, and refuses one that would replace the request's own", () => {
    const file = path.join(home, "header");
    fs.writeFileSync(file, "x-example-bypass: preview-secret\n");
    expect(readGrantServiceHeader(file)).toEqual({ name: "x-example-bypass", value: "preview-secret" });
    for (const bad of ["Authorization: Bearer other", "no colon here", "a: b\nc: d"]) {
      fs.writeFileSync(file, bad);
      expect(() => readGrantServiceHeader(file)).toThrow();
    }
  });
});
