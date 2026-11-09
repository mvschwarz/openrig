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
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { MissionControlWriteContract } from "../../daemon/src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../../daemon/src/domain/mission-control/mission-control-action-log.js";
import { setSelfHostId } from "../../daemon/src/domain/hosts/fanout-contract.js";
import { addHumanFragment, loadHumanRegistry } from "../../daemon/src/domain/gateway/human-registry.js";
import { setDefaultPerson } from "../../daemon/src/domain/gateway/participants.js";
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
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    // Steering's own write path, so a person's answer through an assistant goes where Steering's does.
    const missionControlWriteContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    setup = createTestApp(db, { appDeps: { queueRepo: repo, missionControlWriteContract, filesAllowlist: [{ name: "proof", canonicalPath: shared }] } });
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
    return node;
  }

  async function listen(header?: { name: string; value: string }, taskDestination?: string) {
    const served = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile: path.join(home, "mcp-http-tokens.json"),
      taskDestination, grantService: { url: serviceUrl, ...(header ? { header } : {}), timeoutMs: 1_000 } });
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
    return Object.assign(call, { tools: async () => (await client.listTools()).tools.map((tool) => tool.name),
      catalog: () => client.listTools(), instructions: () => client.getInstructions() });
  }

  const post = (url: string, headers: Record<string, string> = {}) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(INITIALIZE),
  });
  const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
  const create = (sourceSession: string, destinationSession: string, body: string) =>
    repo.create({ sourceSession, destinationSession, body, nudge: false } as never);

  it("routes an address-free first task to the operator's receiver with caller attribution, retry identity and revision lineage", async () => {
    seat("team-a", "lead"); // pod.lead exists without any delegates_to edge.
    const { url } = await listen(undefined, "pod-lead@team-a");
    const ask = await connect(url);
    expect(rows()).toBe(0);
    const catalog = (await ask.catalog()).tools;
    expect(catalog.map((tool) => tool.name).sort()).toEqual(["rig_artifact_read", "rig_queue_create", "rig_queue_list", "rig_queue_show"]);
    expect(catalog.find((tool) => tool.name === "rig_queue_create")?.inputSchema.required).not.toContain("destination");
    expect(ask.instructions()).toContain("You may omit destination");
    expect(ask.instructions()).not.toMatch(/rig_whoami|rig_team|rig_queue_claim|rig_queue_handoff|rig_queue_decide/);
    const args = { qitemId: "qitem-first-task", body: "Create a useful file and return it" };
    const first = await ask("rig_queue_create", args);
    expect(first.isError).toBe(false);
    expect(repo.getById(args.qitemId)).toMatchObject({ sourceSession: CALLER, destinationSession: "pod-lead@team-a", body: args.body });
    const retry = await ask("rig_queue_create", args);
    expect(retry.isError).toBe(false);
    expect(retry.structured.qitemId).toBe(args.qitemId);
    expect(rows()).toBe(1);
    const revision = await ask("rig_queue_create", { body: "Improve the file", revises: args.qitemId });
    expect(revision.isError).toBe(false);
    expect(repo.getById(revision.structured.qitemId)).toMatchObject({ sourceSession: CALLER, destinationSession: "pod-lead@team-a",
      chainOfRecord: [args.qitemId], body: `Revision of ${args.qitemId}.\n\nImprove the file` });
    // A supplied destination still takes the original route, even with a different configured receiver.
    expect((await ask("rig_queue_create", { destination: "other@team-a", body: "Explicit task" })).isError).toBe(false);
    expect((await ask("rig_queue_show", { qitemId: args.qitemId })).isError).toBe(false);
    fs.writeFileSync(path.join(shared, "first-result.md"), "Team's returned file");
    db.prepare("UPDATE queue_items SET evidence_ref = ? WHERE qitem_id = ?").run(path.join(shared, "first-result.md"), args.qitemId);
    expect((await ask("rig_artifact_read", { qitemId: args.qitemId })).text).toContain("Team's returned file");
    expect((await ask("rig_artifact_read", { root: "proof", path: "first-result.md" })).structured.code).toBe("out_of_scope");
  });

  it("also serves an address-free first task to a client pinned to protocol 2026-07-28", async () => {
    seat("team-a", "lead");
    const { url } = await listen(undefined, "pod-lead@team-a");
    const client = new ModernClient({ name: "first-task", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new ModernTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
    closers.push(() => client.close());
    expect(client.getProtocolEra()).toBe("modern");
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "rig_queue_create")?.inputSchema.required).not.toContain("destination");
    const result = await client.callTool({ name: "rig_queue_create", arguments: { qitemId: "qitem-modern-first", body: "Create the file" } });
    expect(result.isError).not.toBe(true);
    expect(repo.getById("qitem-modern-first")).toMatchObject({ sourceSession: CALLER, destinationSession: "pod-lead@team-a" });
  });

  it("does not infer a receiver from grant metadata, caller identity or an empty queue", async () => {
    const { url } = await listen(); // The fixture's environment.lead is deliberately not a routing contract.
    const ask = await connect(url);
    expect((await ask("rig_queue_create", { body: "First task" })).structured.code).toBe("task_destination_unavailable");
    expect(rows()).toBe(0);
    expect((await ask("rig_queue_create", { destination: "lead@team-a", body: "Explicit still works" })).isError).toBe(false);
  });

  it.each([CALLER, "cus-another-caller@team-a", "pod-lead@team-b"])("never uses configured receiver %s outside the caller's team scope", async (target) => {
    const { url } = await listen(undefined, target);
    const ask = await connect(url);
    expect((await ask("rig_queue_create", { body: "First task" })).structured.code).toBe("out_of_scope");
    expect(rows()).toBe(0);
  });

  it("requires one existing receiver and rejects ambiguous rig names without writing", async () => {
    const { url } = await listen(undefined, "pod-lead@team-a");
    const ask = await connect(url);
    expect((await ask("rig_queue_create", { body: "Receiver absent" })).structured.code).toBe("task_destination_unavailable");
    seat("team-a", "lead");
    setup.rigRepo.createRig("team-a");
    expect((await ask("rig_queue_create", { body: "Rig ambiguous" })).structured.code).toBe("task_destination_unavailable");
    expect(rows()).toBe(0);
  });

  it("a person who names their lead by its name alone reaches that seat of the connection's one rig", async () => {
    seat("team-a", "lead");
    const { url } = await listen();
    const ask = await connect(url);
    const sent = await ask("rig_queue_create", { qitemId: "qitem-bare-name", destination: "pod-lead", body: "Do this directly" });
    expect(sent.isError).toBe(false);
    expect(repo.getById("qitem-bare-name")).toMatchObject({ sourceSession: CALLER, destinationSession: "pod-lead@team-a" });
    // A name that is no seat there, or the caller's own, writes nothing.
    for (const name of ["my-lead", "cus-vvmaexample01-caller", ""]) {
      expect((await ask("rig_queue_create", { destination: name, body: "Nobody" })).structured.code).toBe("out_of_scope");
    }
    expect(rows()).toBe(1);
    const described = (await ask.catalog()).tools.find((tool) => tool.name === "rig_queue_create")?.inputSchema.properties?.destination as { description?: string };
    expect(described.description).toContain("name alone");
  });

  it("with several rigs, a name alone reaches only the configured receiver of that name; a refusal says to omit destination, without naming it", async () => {
    seat("team-a", "lead");
    seat("team-a", "other"); // A seat of one of the rigs: with several, its name alone still doesn't pick that rig.
    answer = () => [200, active({ rigs: ["team-a", "team-b"] })];
    const { url } = await listen(undefined, "pod-lead@team-a");
    const ask = await connect(url);
    expect((await ask("rig_queue_create", { qitemId: "qitem-bare-receiver", destination: "pod-lead", body: "Do this directly" })).isError).toBe(false);
    expect(repo.getById("qitem-bare-receiver")).toMatchObject({ destinationSession: "pod-lead@team-a" });
    for (const destination of ["pod-other", "my-lead", "pod-lead@team-c"]) {
      const refused = await ask("rig_queue_create", { destination, body: "Ambiguous or unknown" });
      expect(refused.structured).toMatchObject({ code: "out_of_scope", message: expect.stringContaining("Omit destination to reach the team's configured receiver.") });
      expect(refused.structured.message).not.toContain("pod-lead@team-a");
    }
    expect(rows()).toBe(1);
  });

  it("a receiver outside this connection's grant neither captures a name alone nor gives the hint", async () => {
    seat("team-a", "lead");
    seat("team-b", "lead");
    const { url } = await listen(undefined, "pod-lead@team-b");
    const ask = await connect(url);
    expect((await ask("rig_queue_create", { qitemId: "qitem-own-lead", destination: "pod-lead", body: "Do this directly" })).isError).toBe(false);
    expect(repo.getById("qitem-own-lead")).toMatchObject({ destinationSession: "pod-lead@team-a" });
    const refused = await ask("rig_queue_create", { destination: "my-lead", body: "Nobody" });
    expect(refused.structured.code).toBe("out_of_scope");
    expect(refused.structured.message).not.toContain("Omit destination");
    expect(rows()).toBe(1);
  });

  it("rechecks the grant and receiver after connection, with no write after removal or revocation", async () => {
    const receiver = seat("team-a", "lead");
    const { url } = await listen(undefined, "pod-lead@team-a");
    const ask = await connect(url);
    expect((await ask("rig_queue_create", { body: "Granted" })).isError).toBe(false);
    setup.rigRepo.deleteNode(receiver.id);
    expect((await ask("rig_queue_create", { body: "Receiver removed" })).structured.code).toBe("task_destination_unavailable");
    seat("team-a", "lead");
    answer = () => [200, active({ objects: { queue: ["show", "list"], artifact: ["read"] } })];
    await expect(ask("rig_queue_create", { body: "Create permission removed" })).rejects.toThrow();
    answer = () => [401, { schema: SCHEMA, status: "revoked" }];
    await expect(ask("rig_queue_create", { body: "Revoked" })).rejects.toThrow();
    expect(rows()).toBe(1);
  });

  it("rejects task destination configuration without grant service or with non-local seat syntax", async () => {
    const base = { daemonUrl, host: "127.0.0.1", port: 0, tokenFile: path.join(home, "unused") };
    await expect(startMcpHttpServer({ ...base, taskDestination: "pod-lead@team-a" })).rejects.toThrow("needs --grant-service");
    for (const target of ["", "lead", "a@b@host", "person@external", "lead @team-a"]) {
      await expect(startMcpHttpServer({ ...base, grantService: { url: serviceUrl }, taskDestination: target })).rejects.toThrow(McpHttpConfigError);
    }
  });

  it("requires HTTP and a grant service for the task-destination CLI option", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      for (const args of [[], ["--http"]]) {
        process.exitCode = undefined;
        await mcpCommand().parseAsync(["serve", "--port", "1", "--task-destination", "pod-lead@team-a", ...args], { from: "user" });
        expect(process.exitCode).toBe(1);
      }
      expect(quiet).toHaveBeenCalledWith("--task-destination needs --http --grant-service");
    } finally {
      process.exitCode = exitCode;
      quiet.mockRestore();
    }
  });

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

  describe("a person answering the team's questions from their assistant", () => {
    /** The connection's owner, registered as the grant service provisions them: no connector, the default person. */
    const PERSON = "cus-vvmaexample01";
    const register = (entityId: string, asDefault: boolean) => {
      expect(addHumanFragment({ entityId, class: "human", displayName: entityId, address: `${entityId}@external`, connectorBindings: [], prefs: { deliveryClass: "B" } } as never, home)).toMatchObject({ ok: true });
      if (asDefault) expect(setDefaultPerson(entityId, home)).toMatchObject({ ok: true });
    };
    // A synthetic principal, so the route recorded beside an answer is plainly a fixture's.
    const grantFor = (entityId: string | null, actions = ["read", "answer"]) => active({
      principal: { id: "principal-example-01", kind: "external_caller", label: "Example caller" },
      objects: { queue: ["create", "show", "list"], artifact: ["read"], question: actions }, ...(entityId ? { person: { entity_id: entityId } } : {}),
    });
    const LAYOUT = { id: "layout", question: "Which layout?", options: [{ id: "a", label: "Cards" }, { id: "b", label: "List" }] };
    const SHIP = { id: "ship", question: "Ship it this week?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] };
    const COLOR = { id: "color", question: "Which accent color?", options: [{ id: "red", label: "Red" }, { id: "teal", label: "Teal" }] };
    const ask = (destinationSession: string, questions: unknown[] | null = [LAYOUT]) => repo.create({ sourceSession: "lead@team-a", destinationSession,
      summary: "Pick a layout", body: "Which layout should the landing page use?", evidenceRef: "/proof/layout.md", humanIntent: "decision", ...(questions ? { humanQuestions: questions } : {}), nudge: false } as never) as unknown as Promise<{ qitemId: string }>;
    const replies = (qitemId: string) => (db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE destination_session = 'lead@team-a' AND tags LIKE '%human-answer%' AND body LIKE ?")
      .get(`%${qitemId}%`) as { n: number }).n;
    const audit = (qitemId: string) => db.prepare("SELECT actor_session AS actor, audit_notes_json AS notes FROM mission_control_actions WHERE qitem_id = ? ORDER BY rowid")
      .all(qitemId).map((row: any) => ({ actor: row.actor, notes: JSON.parse(row.notes ?? "{}") }));
    const steering = async (view: string) => ((await (await fetch(`${daemonUrl}/api/attention?view=${view}`)).json()) as { items: Array<{ id: string }> }).items.map((item) => item.id);

    it("is offered only on a grant that names a person, and its instructions say so in their first 512 characters", async () => {
      register(PERSON, true);
      answer = () => [200, grantFor(PERSON)];
      const asPerson = await connect((await listen()).url);
      expect(await asPerson.tools()).toEqual(expect.arrayContaining(["rig_question_list", "rig_question_answer"]));
      const first = (asPerson.instructions() ?? "").split("\n")[0]!;
      expect(first.length).toBeLessThanOrEqual(512);
      for (const tool of ["rig_queue_create", "rig_queue_show", "rig_question_list", "rig_question_answer"]) expect(first).toContain(tool);
      // The question pair without a person offers nothing: the caller's seat is never taken for a person.
      answer = () => [200, grantFor(null)];
      const noPerson = await connect((await listen()).url);
      expect(await noPerson.tools()).not.toEqual(expect.arrayContaining(["rig_question_list"]));
      expect((await noPerson.tools()).filter((tool) => tool.startsWith("rig_question_"))).toEqual([]);
      const plain = (noPerson.instructions() ?? "").split("\n")[0]!;
      expect(plain.length).toBeLessThanOrEqual(512);
      expect(plain).toContain("reserved for a person");
      // An unusable person withholds only the person tools; the grant's other tools keep working, and the log says why.
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        answer = () => [200, grantFor("Not An Id")];
        const malformed = await connect((await listen()).url);
        const tools = await malformed.tools();
        expect(tools).toEqual(expect.arrayContaining(["rig_queue_create", "rig_queue_show", "rig_artifact_read"]));
        expect(tools.filter((tool) => tool.startsWith("rig_question_"))).toEqual([]);
        expect(logged.mock.calls.flat().join("\n")).toContain("unusable person.entity_id");
      } finally {
        logged.mockRestore();
      }
    });

    it("records the person's choice as theirs, through this connection: the same in Steering, the asker woken once, and a repeat answered from the record", async () => {
      register(PERSON, true);
      answer = () => [200, grantFor(PERSON)];
      const asPerson = await connect((await listen()).url);
      const row = await ask(`${PERSON}@external`);
      expect(await steering(PERSON)).toContain(`queue:${row.qitemId}`);
      const listed = await asPerson("rig_question_list");
      expect(listed.isError).toBe(false);
      const item = listed.structured.items.find((entry: any) => entry.qitemId === row.qitemId);
      expect(item).toMatchObject({ kind: "ask", from: "lead@team-a", summary: "Pick a layout", questions: [LAYOUT], answerWith: "choices or words" });
      expect(item.revision).toMatch(/^dr1-/);

      const answered = await asPerson("rig_question_answer", { qitemId: row.qitemId, revision: item.revision, choices: [{ questionId: "layout", optionId: "b" }] });
      expect(answered.structured).toMatchObject({ ok: true, outcome: "answered", submitted: [{ questionId: "layout", optionId: "b" }] });
      expect(repo.getById(row.qitemId)).toMatchObject({ state: "done", humanAnswers: { layout: "b" } });
      expect(replies(row.qitemId)).toBe(1);
      // Recorded as the person, with the assistant as the route it came by.
      expect(audit(row.qitemId)).toEqual([expect.objectContaining({ actor: `${PERSON}@external`, notes: expect.objectContaining({
        route: "external-assistant", assistantSeat: CALLER, principal: "principal-example-01", grant: "8977f2dc0000aaaa1111bbbb", grantVersion: 6, person: `${PERSON}@external` }) })]);
      expect(await steering(PERSON)).not.toContain(`queue:${row.qitemId}`);

      // The same answer again (a retry after an uncertain result) is already recorded; a different one isn't taken.
      const again = await asPerson("rig_question_answer", { qitemId: row.qitemId, revision: item.revision, choices: [{ questionId: "layout", optionId: "b" }] });
      expect(again.structured).toMatchObject({ ok: true, outcome: "already-recorded" });
      const changed = await asPerson("rig_question_answer", { qitemId: row.qitemId, revision: item.revision, choices: [{ questionId: "layout", optionId: "a" }] });
      expect(changed.structured).toMatchObject({ ok: false, code: "not_waiting_on_person", state: "done", answered: { layout: "b" } });
      expect(replies(row.qitemId)).toBe(1);
      expect(audit(row.qitemId)).toHaveLength(1);
    });

    it("answers several questions in one call, and records the person's own words exactly", async () => {
      register(PERSON, true);
      answer = () => [200, grantFor(PERSON)];
      const asPerson = await connect((await listen()).url);
      const both = await ask(`${PERSON}@external`, [LAYOUT, SHIP]);
      const revision = (await asPerson("rig_question_list")).structured.items[0].revision;
      const answered = await asPerson("rig_question_answer", { qitemId: both.qitemId, revision, choices: [{ questionId: "layout", optionId: "a" }, { questionId: "ship", optionId: "no" }] });
      expect(answered.structured).toMatchObject({ ok: true, outcome: "answered" });
      expect(repo.getById(both.qitemId)!.humanAnswers).toEqual({ layout: "a", ship: "no" });
      expect(replies(both.qitemId)).toBe(1);

      const typed = await ask(`${PERSON}@external`);
      const typedRevision = (await asPerson("rig_question_list")).structured.items[0].revision;
      const words = "Cards, but keep the list view for admins";
      expect((await asPerson("rig_question_answer", { qitemId: typed.qitemId, revision: typedRevision, words })).structured).toMatchObject({ ok: true, outcome: "answered" });
      expect(JSON.stringify(repo.getById(typed.qitemId)!.humanAnswers)).toContain(JSON.stringify(words));

      // An ask with no options (Steering's Approve) takes the person's words, never a choice.
      const plain = await ask(`${PERSON}@external`, null);
      const listed = (await asPerson("rig_question_list")).structured.items.find((entry: any) => entry.qitemId === plain.qitemId);
      expect(listed).toMatchObject({ kind: "ask", answerWith: "words" });
      expect(listed.questions).toBeUndefined();
      expect((await asPerson("rig_question_answer", { qitemId: plain.qitemId, revision: listed.revision, choices: [{ questionId: "layout", optionId: "a" }] })).structured).toMatchObject({ code: "answer_shape" });
      expect((await asPerson("rig_question_answer", { qitemId: plain.qitemId, revision: listed.revision, words: "Yes, go ahead" })).structured).toMatchObject({ ok: true, outcome: "answered", submitted: { words: "Yes, go ahead" } });
      expect(repo.getById(plain.qitemId)).toMatchObject({ state: "done" });
      expect(replies(plain.qitemId)).toBe(1);
    });

    it("records nothing on a changed question, and hands back the current one", async () => {
      register(PERSON, true);
      answer = () => [200, grantFor(PERSON)];
      const asPerson = await connect((await listen()).url);
      const row = await ask(`${PERSON}@external`);
      const current = (await asPerson("rig_question_list")).structured.items[0];
      const stale = await asPerson("rig_question_answer", { qitemId: row.qitemId, revision: "dr1-000000000000000000000000", choices: [{ questionId: "layout", optionId: "a" }] });
      expect(stale.structured).toMatchObject({ ok: false, code: "question_changed", current: { qitemId: row.qitemId, revision: current.revision } });
      expect(repo.getById(row.qitemId)).toMatchObject({ state: "pending" });
      expect(audit(row.qitemId)).toEqual([]);
      // On the question the person saw, a choice that isn't one of its options, or both shapes at once, is refused before
      // anything is sent. On a changed question, the truth is that it changed.
      expect((await asPerson("rig_question_answer", { qitemId: row.qitemId, revision: current.revision, choices: [{ questionId: "layout", optionId: "z" }] })).structured).toMatchObject({ code: "unknown_option" });
      expect((await asPerson("rig_question_answer", { qitemId: row.qitemId, revision: "dr1-000000000000000000000000", choices: [{ questionId: "layout", optionId: "z" }] })).structured).toMatchObject({ code: "question_changed" });
      expect((await asPerson("rig_question_answer", { qitemId: row.qitemId, revision: current.revision, words: "a", choices: [{ questionId: "layout", optionId: "a" }] })).structured).toMatchObject({ code: "answer_shape" });
      expect(audit(row.qitemId)).toEqual([]);
    });

    it("never answers another person's question, a team-internal row, or anything for a person not registered here", async () => {
      // Before anyone is registered, Steering's view shows every request; nothing is this connection's to answer.
      answer = () => [200, grantFor(PERSON)];
      const asPerson = await connect((await listen()).url);
      const early = await ask("human@host");
      expect((await asPerson("rig_question_list")).structured).toMatchObject({ ok: false, code: "person_not_registered" });
      expect((await asPerson("rig_question_answer", { qitemId: early.qitemId, revision: "dr1-x", words: "yes" })).structured).toMatchObject({ code: "person_not_registered" });

      register(PERSON, true);
      register("ana", false);
      const anas = await ask("ana@external");
      const internal = await create("lead@team-a", "impl@team-a", "SECRET team-internal work");
      expect((await asPerson("rig_question_list")).structured.items.map((entry: any) => entry.qitemId)).not.toContain(anas.qitemId);
      for (const qitemId of [anas.qitemId, internal.qitemId]) {
        const refused = await asPerson("rig_question_answer", { qitemId, revision: "dr1-x", words: "yes" });
        expect(refused.structured).toMatchObject({ ok: false, code: "not_waiting_on_person" });
        expect(refused.structured.state).toBeUndefined();
        expect(refused.text).not.toContain("SECRET");
      }
      expect(repo.getById(anas.qitemId)).toMatchObject({ state: "pending" });
      // A grant naming someone who isn't registered here reads and answers nothing.
      answer = () => [200, grantFor("cus-nobody")];
      const stranger = await connect((await listen()).url);
      expect((await stranger("rig_question_list")).structured).toMatchObject({ code: "person_not_registered" });
    });

    it("unparks a row waiting on the person with their words, and shows them today's human@host asks as the default person", async () => {
      register(PERSON, true);
      answer = () => [200, grantFor(PERSON)];
      const asPerson = await connect((await listen()).url);
      const work = await create("lead@team-a", "impl@team-a", "Ship the release notes");
      repo.update({ qitemId: work.qitemId, actorSession: "impl@team-a", state: "blocked", blockedOn: `${PERSON}@external`, summary: "Ship the notes as drafted?", evidenceRef: "/proof/notes.md", transitionNote: "asking the person" } as never);
      const legacy = await ask("human@host");
      const items = (await asPerson("rig_question_list")).structured.items;
      const parked = items.find((entry: any) => entry.qitemId === work.qitemId);
      expect(parked).toMatchObject({ kind: "parked", from: "impl@team-a", answerWith: "words" });
      expect(items.map((entry: any) => entry.qitemId)).toContain(legacy.qitemId);

      expect((await asPerson("rig_question_answer", { qitemId: work.qitemId, revision: parked.revision, choices: [{ questionId: "layout", optionId: "a" }] })).structured).toMatchObject({ code: "answer_shape" });
      const resolved = await asPerson("rig_question_answer", { qitemId: work.qitemId, revision: parked.revision, words: "Yes, ship them" });
      expect(resolved.structured).toMatchObject({ ok: true, outcome: "answered" });
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "in-progress" });
      expect(JSON.stringify(repo.listTransitions(work.qitemId))).toContain("Yes, ship them");
      // The park is back at work, its blocker cleared: an identical retry is confirmed from the record, nothing resent.
      expect((await asPerson("rig_question_answer", { qitemId: work.qitemId, revision: parked.revision, words: "Yes, ship them" })).structured).toMatchObject({ ok: true, outcome: "already-recorded" });
      expect(audit(work.qitemId)).toHaveLength(1);

      const legacyRevision = items.find((entry: any) => entry.qitemId === legacy.qitemId).revision;
      expect((await asPerson("rig_question_answer", { qitemId: legacy.qitemId, revision: legacyRevision, choices: [{ questionId: "layout", optionId: "a" }] })).structured)
        .toMatchObject({ ok: true, outcome: "answered" });
      expect(repo.getById(legacy.qitemId)!.humanAnswers).toEqual({ layout: "a" });
      expect(audit(legacy.qitemId)[0]).toMatchObject({ actor: `${PERSON}@external` });
      // The legacy ask keeps human@host: an identical retry is still confirmed by its operation, and nothing is resent.
      expect((await asPerson("rig_question_answer", { qitemId: legacy.qitemId, revision: legacyRevision, choices: [{ questionId: "layout", optionId: "a" }] })).structured)
        .toMatchObject({ ok: true, outcome: "already-recorded" });
      expect(audit(legacy.qitemId)).toHaveLength(1);
      expect(replies(legacy.qitemId)).toBe(1);
    });

    it("finishes a submission that stopped partway, recognising its own recorded steps by operation id, and says what was recorded", async () => {
      register(PERSON, true);
      answer = () => [200, grantFor(PERSON)];
      const asPerson = await connect((await listen()).url);
      const both = await ask(`${PERSON}@external`, [LAYOUT, SHIP]);
      const revision = (await asPerson("rig_question_list")).structured.items[0].revision;
      const choices = [{ questionId: "layout", optionId: "a" }, { questionId: "ship", optionId: "no" }];
      // The second step's post fails after the first landed.
      let posts = 0;
      broken = (req) => req.method === "POST" && new URL(req.url).pathname === "/api/mission-control/action" && ++posts === 2
        ? new Response(JSON.stringify({ error: "unavailable", message: "the daemon couldn't take it" }), { status: 503, headers: { "Content-Type": "application/json" } }) : undefined;
      const stopped = await asPerson("rig_question_answer", { qitemId: both.qitemId, revision, choices });
      // A server error on a send may have landed: that step is unknown, not "not recorded".
      expect(stopped.structured).toMatchObject({ ok: false, recorded: ["layout"], indeterminate: "ship", notRecorded: [] });
      expect(stopped.structured.message).toContain("Recorded: layout. Unknown whether ship was recorded.");
      expect(repo.getById(both.qitemId)).toMatchObject({ state: "pending", humanAnswers: { layout: "a" } });
      broken = undefined;
      // The identical retry confirms its own first step and stops there: the rest goes in a new answer to the question as
      // it is now, which the asker hears once.
      const retried = await asPerson("rig_question_answer", { qitemId: both.qitemId, revision, choices });
      expect(retried.structured).toMatchObject({ ok: false, code: "question_changed", recorded: ["layout"], notRecorded: ["ship"] });
      expect(audit(both.qitemId)).toHaveLength(1);
      const now = (await asPerson("rig_question_list")).structured.items.find((entry: any) => entry.qitemId === both.qitemId);
      expect(now.answered).toEqual({ layout: "a" });
      expect((await asPerson("rig_question_answer", { qitemId: both.qitemId, revision: now.revision, choices: [{ questionId: "ship", optionId: "no" }] })).structured).toMatchObject({ ok: true, outcome: "answered" });
      expect(repo.getById(both.qitemId)!.humanAnswers).toEqual({ layout: "a", ship: "no" });
      expect(audit(both.qitemId)).toHaveLength(2);
      expect(replies(both.qitemId)).toBe(1);

      // A one-of-two answer whose result was lost: its identical retry is already recorded, not a changed question.
      const half = await ask(`${PERSON}@external`, [LAYOUT, SHIP]);
      const halfRevision = (await asPerson("rig_question_list")).structured.items.find((entry: any) => entry.qitemId === half.qitemId).revision;
      const halfAnswer = await asPerson("rig_question_answer", { qitemId: half.qitemId, revision: halfRevision, choices: [{ questionId: "layout", optionId: "b" }] });
      // The receipt carries only what this call submitted, never a fresh read of the row's answers.
      expect(halfAnswer.structured).toEqual(expect.objectContaining({ ok: true, outcome: "recorded", submitted: [{ questionId: "layout", optionId: "b" }] }));
      expect(halfAnswer.structured).not.toHaveProperty("answered");
      expect(halfAnswer.structured).not.toHaveProperty("state");
      expect((await asPerson("rig_question_answer", { qitemId: half.qitemId, revision: halfRevision, choices: [{ questionId: "layout", optionId: "b" }] })).structured).toMatchObject({ ok: true, outcome: "already-recorded" });
      expect(audit(half.qitemId)).toHaveLength(1);
      // Another registered person answers the rest on Steering's path: the same retry is refused, and their answer isn't
      // taken for this submission's.
      register("ana", false);
      const other = await fetch(`${daemonUrl}/api/mission-control/action`, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "ana@external" },
        body: JSON.stringify({ verb: "answer", qitemId: half.qitemId, questionId: "ship", optionId: "yes" }) });
      expect(other.status).toBe(200);
      const after = await asPerson("rig_question_answer", { qitemId: half.qitemId, revision: halfRevision, choices: [{ questionId: "layout", optionId: "b" }] });
      expect(after.structured).toMatchObject({ ok: false, code: "not_waiting_on_person" });
      expect(audit(half.qitemId)).toHaveLength(2);
      expect(audit(half.qitemId)[1]).toMatchObject({ actor: "ana@external" });
    });

    it("stops a resumed answer when the question was rerouted after its recorded step: nothing lands on the new recipient's ask", async () => {
      register(PERSON, true);
      register("ana", false);
      answer = () => [200, grantFor(PERSON)];
      const asPerson = await connect((await listen()).url);
      const both = await ask(`${PERSON}@external`, [LAYOUT, SHIP]);
      const revision = (await asPerson("rig_question_list")).structured.items[0].revision;
      const choices = [{ questionId: "layout", optionId: "a" }, { questionId: "ship", optionId: "no" }];
      let posts = 0;
      broken = (req) => req.method === "POST" && new URL(req.url).pathname === "/api/mission-control/action" && ++posts === 2
        ? new Response(JSON.stringify({ error: "unavailable", message: "the daemon couldn't take it" }), { status: 503, headers: { "Content-Type": "application/json" } }) : undefined;
      await asPerson("rig_question_answer", { qitemId: both.qitemId, revision, choices });
      // The retry passes the eligibility read; then, just before its first send, the ask is rerouted to Ana.
      let rerouted = false;
      broken = (req) => {
        if (!rerouted && req.method === "POST" && new URL(req.url).pathname === "/api/mission-control/action") {
          rerouted = true;
          repo.routeToFallback(both.qitemId, "ana@external", "rerouted to Ana");
        }
        return undefined;
      };
      const stopped = await asPerson("rig_question_answer", { qitemId: both.qitemId, revision, choices });
      expect(stopped.structured).toMatchObject({ ok: false, code: "question_changed", recorded: ["layout"], notRecorded: ["ship"] });
      expect(stopped.structured).not.toHaveProperty("current");
      expect(repo.getById(both.qitemId)).toMatchObject({ state: "pending", destinationSession: "ana@external", humanAnswers: { layout: "a" } });
      expect(audit(both.qitemId)).toHaveLength(1);
    });

    it("reports a send that got no answer as unknown, with what was recorded before it, and finishes on the same call", async () => {
      register(PERSON, true);
      answer = () => [200, grantFor(PERSON)];
      const asPerson = await connect((await listen()).url);
      const both = await ask(`${PERSON}@external`, [LAYOUT, SHIP]);
      const revision = (await asPerson("rig_question_list")).structured.items[0].revision;
      const choices = [{ questionId: "layout", optionId: "b" }, { questionId: "ship", optionId: "yes" }];
      // The second send gets a body that isn't JSON, so the client throws.
      let posts = 0;
      broken = (req) => req.method === "POST" && new URL(req.url).pathname === "/api/mission-control/action" && ++posts === 2
        ? new Response("upstream down", { status: 503, headers: { "Content-Type": "text/plain" } }) : undefined;
      const unknown = await asPerson("rig_question_answer", { qitemId: both.qitemId, revision, choices });
      expect(unknown.structured).toMatchObject({ ok: false, recorded: ["layout"], indeterminate: "ship", notRecorded: [] });
      expect(unknown.structured.message).toContain("Recorded: layout.");
      expect(unknown.structured.message).toContain("Unknown whether ship was recorded.");
      expect(unknown.structured.message).toContain("Send the same call again");
      expect(unknown.structured.message).not.toContain("Nothing was recorded");
      broken = undefined;
      // The same call confirms what was recorded (the unanswered send never reached the daemon), and the rest is a new answer.
      expect((await asPerson("rig_question_answer", { qitemId: both.qitemId, revision, choices })).structured).toMatchObject({ code: "question_changed", recorded: ["layout"], notRecorded: ["ship"] });
      const rest = (await asPerson("rig_question_list")).structured.items.find((entry: any) => entry.qitemId === both.qitemId);
      expect((await asPerson("rig_question_answer", { qitemId: both.qitemId, revision: rest.revision, choices: [{ questionId: "ship", optionId: "yes" }] })).structured).toMatchObject({ ok: true, outcome: "answered" });
      expect(repo.getById(both.qitemId)!.humanAnswers).toEqual({ layout: "b", ship: "yes" });
      expect(audit(both.qitemId)).toHaveLength(2);
      expect(replies(both.qitemId)).toBe(1);

      // A first send with no answer says it's unknown, not that nothing was recorded.
      const one = await ask(`${PERSON}@external`);
      const oneRevision = (await asPerson("rig_question_list")).structured.items.find((entry: any) => entry.qitemId === one.qitemId).revision;
      broken = (req) => req.method === "POST" && new URL(req.url).pathname === "/api/mission-control/action"
        ? new Response("upstream down", { status: 503, headers: { "Content-Type": "text/plain" } }) : undefined;
      const first = await asPerson("rig_question_answer", { qitemId: one.qitemId, revision: oneRevision, choices: [{ questionId: "layout", optionId: "a" }] });
      expect(first.structured).toMatchObject({ ok: false, recorded: [], indeterminate: "layout" });
      expect(first.structured.message).not.toContain("Nothing was recorded");
      broken = undefined;
    });

    it("never lets a stale retry overwrite a newer answer: given through Steering's path or recorded with no action", async () => {
      register(PERSON, true);
      register("ana", false);
      answer = () => [200, grantFor(PERSON)];
      const asPerson = await connect((await listen()).url);
      const choices = [{ questionId: "layout", optionId: "a" }, { questionId: "ship", optionId: "no" }, { questionId: "color", optionId: "red" }];
      const failSecondSend = () => {
        let posts = 0;
        broken = (req) => req.method === "POST" && new URL(req.url).pathname === "/api/mission-control/action" && ++posts === 2
          ? new Response(JSON.stringify({ error: "invalid_request", message: "refused this once" }), { status: 400, headers: { "Content-Type": "application/json" } }) : undefined;
      };
      const firstTry = async (qitemId: string) => {
        const revision = (await asPerson("rig_question_list")).structured.items.find((entry: any) => entry.qitemId === qitemId).revision;
        failSecondSend();
        expect((await asPerson("rig_question_answer", { qitemId, revision, choices })).structured).toMatchObject({ recorded: ["layout"], notRecorded: ["ship", "color"] });
        broken = undefined;
        return revision;
      };

      // Ana answers ship through Steering's own path (an audited action) before the retry.
      const audited = await ask(`${PERSON}@external`, [LAYOUT, SHIP, COLOR]);
      const auditedRevision = await firstTry(audited.qitemId);
      const ana = await fetch(`${daemonUrl}/api/mission-control/action`, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "ana@external" },
        body: JSON.stringify({ verb: "answer", qitemId: audited.qitemId, questionId: "ship", optionId: "yes" }) });
      expect(ana.status).toBe(200);
      expect((await asPerson("rig_question_answer", { qitemId: audited.qitemId, revision: auditedRevision, choices })).structured).toMatchObject({ ok: false, code: "question_changed" });
      expect(repo.getById(audited.qitemId)).toMatchObject({ state: "pending", humanAnswers: { layout: "a", ship: "yes" } });

      // Ana's ship is recorded with no action at all (Slack's writer) before the retry: the retry confirms its own layout
      // and stops, so yes stays.
      const silent = await ask(`${PERSON}@external`, [LAYOUT, SHIP, COLOR]);
      const silentRevision = await firstTry(silent.qitemId);
      expect(repo.recordHumanAnswer({ qitemId: silent.qitemId, actorSession: "ana@external", questionId: "ship", optionId: "yes" } as never)).toMatchObject({ status: "recorded" });
      const retried = await asPerson("rig_question_answer", { qitemId: silent.qitemId, revision: silentRevision, choices });
      expect(retried.structured).toMatchObject({ ok: false, code: "question_changed", recorded: ["layout"], notRecorded: ["ship", "color"] });
      expect(repo.getById(silent.qitemId)).toMatchObject({ state: "pending", humanAnswers: { layout: "a", ship: "yes" } });
      expect(audit(silent.qitemId)).toHaveLength(1);
    });

    it("leaves out a park that moved to someone else between Steering's view and the read of its row, and never answers it", async () => {
      register(PERSON, true);
      register("ana", false);
      answer = () => [200, grantFor(PERSON)];
      const asPerson = await connect((await listen()).url);
      const work = await create("lead@team-a", "impl@team-a", "Ship the release notes");
      repo.update({ qitemId: work.qitemId, actorSession: "impl@team-a", state: "blocked", blockedOn: `${PERSON}@external`, summary: "Ship the notes as drafted?", evidenceRef: "/proof/notes.md", transitionNote: "asking the person" } as never);
      const seen = (await asPerson("rig_question_list")).structured.items.find((entry: any) => entry.qitemId === work.qitemId);
      expect(seen).toMatchObject({ kind: "parked" });
      // Between the two reads, the owner unparks it and asks Ana instead, with evidence only she should see.
      const movePark = () => {
        repo.update({ qitemId: work.qitemId, actorSession: "impl@team-a", state: "in-progress", transitionNote: "rethinking" } as never);
        repo.update({ qitemId: work.qitemId, actorSession: "impl@team-a", state: "blocked", blockedOn: "ana@external", summary: "Ana: ship them?", evidenceRef: "/proof/ana-only.md", transitionNote: "asking Ana" } as never);
      };
      let moved = false;
      broken = (req) => {
        if (!moved && req.method === "GET" && new URL(req.url).pathname === `/api/queue/${work.qitemId}`) { moved = true; movePark(); }
        return undefined;
      };
      const listed = await asPerson("rig_question_list");
      expect(listed.structured.items.map((entry: any) => entry.qitemId)).not.toContain(work.qitemId);
      expect(listed.text).not.toContain("ana-only");
      broken = undefined;
      const refused = await asPerson("rig_question_answer", { qitemId: work.qitemId, revision: seen.revision, words: "Yes" });
      expect(refused.structured).toMatchObject({ ok: false, code: "not_waiting_on_person" });
      expect(refused.text).not.toContain("ana-only");
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "blocked", blockedOn: "ana@external" });
      expect(audit(work.qitemId)).toEqual([]);
    });
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
