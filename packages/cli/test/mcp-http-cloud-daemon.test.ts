// rig mcp serve --http --cloud-grants against the daemon's real routes and a fake grant authority speaking
// openrig.cloud.grant/v1: each request's customer key is checked with Cloud for this daemon's self id, every answer but
// active is refused with no fallback, and a customer reaches only its own items and the team's questions to it.
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
import { addGrant, readCloudGrantHeader, startMcpHttpServer } from "../src/mcp-http.js";

const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } };
const SCHEMA = "openrig.cloud.grant/v1";
const KEY = `${"8977f2dc0000aaaa1111bbbb"}.cus_VVMAexample01.${"ab".repeat(24)}`;
const CALLER = "cus-vvmaexample01-caller@team-a";
const INSTANCE = "core-test-01";

/** Cloud's active answer for KEY, as grantV1 builds it. */
const active = (extra: Record<string, unknown> = {}) => ({
  schema: SCHEMA, status: "active",
  principal: { id: "cus_VVMAexample01", kind: "cloud_customer", label: "OpenRig Cloud customer …mple01" },
  grant: { id: "8977f2dc0000aaaa1111bbbb", version: 6, updated_at: "2026-10-26T10:30:00.000Z", expires_at: null, cache_seconds: 0, revocation: "per_request" },
  customer: { id: "cus_VVMAexample01" },
  environment: { id: "team-a", core_instance: INSTANCE, studio: "https://studio.example", lead: "lead@team-a" },
  seat: CALLER, rigs: ["team-a"], artifact_roots: ["proof"], access_class: "work",
  objects: { queue: ["create", "show", "list"], artifact: ["read"] }, team: { id: "software-factory", version: "1" },
  ...extra,
});

describe("rig mcp serve --http --cloud-grants on the daemon's routes", () => {
  let db: Database.Database;
  let home: string;
  let shared: string;
  let repo: QueueRepository;
  let daemon: ServerType;
  let daemonUrl: string;
  let setup: ReturnType<typeof createTestApp>;
  let cloud: http.Server;
  let cloudUrl: string;
  /** What the fake authority answers next: [HTTP status, body or raw text]. */
  let answer: () => [number, unknown];
  let asked: Array<{ headers: http.IncomingHttpHeaders; body: string }>;
  const closers: Array<() => Promise<void>> = [];
  const saved = { home: process.env.OPENRIG_HOME, session: process.env.OPENRIG_SESSION_NAME };

  beforeEach(async () => {
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cloud-"));
    shared = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cloud-shared-")));
    process.env.OPENRIG_HOME = home;
    process.env.OPENRIG_SESSION_NAME = "env-seat@elsewhere";
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    setup = createTestApp(db, { appDeps: { queueRepo: repo, filesAllowlist: [{ name: "proof", canonicalPath: shared }] } });
    daemon = await new Promise<ServerType>((resolve) => { const s = serve({ fetch: setup.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
    daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
    setSelfHostId(INSTANCE);
    asked = [];
    answer = () => [200, active()];
    cloud = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        asked.push({ headers: req.headers, body });
        const [status, reply] = answer();
        res.writeHead(status, { "Content-Type": "application/json" }).end(typeof reply === "string" ? reply : JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
    cloudUrl = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}/api/connector/v1/grant`;
    seat("team-a", "cus-vvmaexample01-caller");
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await new Promise<void>((resolve) => cloud.close(() => resolve()));
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
      cloudGrants: { url: cloudUrl, ...(header ? { header } : {}), timeoutMs: 1_000 } });
    closers.push(() => served.close());
    return served;
  }

  async function connect(url: string, token = KEY) {
    const client = new Client({ name: "cloud-test", version: "1.0.0" });
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

  it("asks Cloud on every request with the raw key and this daemon's self id, acts as the grant's seat, and never reads the token file", async () => {
    const fileToken = await addGrant(path.join(home, "mcp-http-tokens.json"), { name: "local", seat: "local@team-a", rigs: ["team-a"], roots: [], workspace: false, owner: true });
    const served = await listen({ name: "x-vercel-protection-bypass", value: "preview-secret" });
    expect(served.authenticated).toBe(true);
    const asCustomer = await connect(served.url);
    expect((await asCustomer.tools()).sort()).toEqual(["rig_artifact_read", "rig_queue_create", "rig_queue_list", "rig_queue_show"]);
    const created = await asCustomer("rig_queue_create", { destination: "lead@team-a", body: "please build it" });
    expect(created.isError).toBe(false);
    expect(repo.getById(created.structured.qitemId)?.sourceSession).toBe(CALLER);

    expect(asked.length).toBeGreaterThanOrEqual(3);
    for (const request of asked) {
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.headers["x-vercel-protection-bypass"]).toBe("preview-secret");
      expect(JSON.parse(request.body)).toEqual({ instance: INSTANCE });
    }
    // A token-file credential, even an owner's, is just an unknown key here, refused before any call to Cloud.
    const before = asked.length;
    expect((await post(served.url, { Authorization: `Bearer ${fileToken}` })).status).toBe(401);
    expect(asked.length).toBe(before);
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
        [() => [200, active({ schema: "openrig.cloud.grant/v2" })], 503, "grant_authority_unavailable"],
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
      // No key, or one that isn't a customer key: refused before Cloud is asked.
      const before = asked.length;
      for (const headers of [{}, { Authorization: "Bearer orm_local-token" }, { Authorization: `Bearer ${KEY}x` }]) {
        expect((await post(served.url, headers)).status).toBe(401);
      }
      expect(asked.length).toBe(before);
      // A daemon with no self id can't bind a key to an instance: refused, and Cloud isn't asked.
      setSelfHostId(null);
      const unbound = await listen();
      answer = () => [200, active()];
      expect((await post(unbound.url, { Authorization: `Bearer ${KEY}` })).status).toBe(503);
      expect(asked.length).toBe(before);
      // Cloud gone: unavailable, never served as anyone.
      setSelfHostId(INSTANCE);
      await new Promise<void>((resolve) => cloud.close(() => resolve()));
      cloud = http.createServer();
      expect((await post(served.url, { Authorization: `Bearer ${KEY}` })).status).toBe(503);
      expect(rows()).toBe(0);
    } finally {
      quiet.mockRestore();
    }
  });

  it("reaches only the customer's own items and the team's questions to it: never team-internal, another caller's, another rig's or a person's", async () => {
    const served = await listen();
    const asCustomer = await connect(served.url);
    const before = rows();
    for (const destination of ["lead@team-b", "alex@external", "lead@team-a@elsewhere"]) {
      expect((await asCustomer("rig_queue_create", { destination, body: "not allowed" })).structured).toMatchObject({ ok: false, code: "out_of_scope" });
    }
    expect(rows()).toBe(before);

    const own = (await asCustomer("rig_queue_create", { destination: "lead@team-a", body: "my task" })).structured.qitemId as string;
    const question = await create("lead@team-a", CALLER, "a question for the customer");
    const internal = await create("lead@team-a", "impl@team-a", "SECRET team-internal work");
    const otherCaller = await create("cus-otherone01-caller@team-a", CALLER, "SECRET from another customer");
    const otherRig = await create("lead@team-b", "impl@team-b", "SECRET other rig");
    expect((await asCustomer("rig_queue_show", { qitemId: own })).isError).toBe(false);
    expect((await asCustomer("rig_queue_show", { qitemId: question.qitemId })).isError).toBe(false);
    for (const hidden of [internal, otherCaller, otherRig]) {
      const shown = await asCustomer("rig_queue_show", { qitemId: hidden.qitemId });
      expect(shown.structured).toMatchObject({ code: "out_of_scope" });
      expect(shown.text).not.toContain("SECRET");
    }
    for (const args of [{ all: true }, { all: true, destination: "impl@team-a" }, { all: true, source: "lead@team-a" }]) {
      const listed = await asCustomer("rig_queue_list", args);
      expect(JSON.stringify(listed.structured)).not.toContain("SECRET");
    }
    const listed = JSON.stringify((await asCustomer("rig_queue_list", { all: true })).structured);
    expect(listed).toContain(own);
    expect(listed).toContain(question.qitemId);

    // Its task handed on inside the team: the successor stays hidden. Handed back to it: named.
    const handOn = (id: string, to: string) => fetch(`${daemonUrl}/api/queue/${id}/handoff`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "lead@team-a" }, body: JSON.stringify({ toSession: to, nudge: false }) });
    expect((await handOn(own, "impl@team-a")).status).toBe(201);
    expect((await asCustomer("rig_queue_show", { qitemId: own })).structured.successor).toEqual({ unknown: true, code: "out_of_scope" });
    const second = (await asCustomer("rig_queue_create", { destination: "lead@team-a", body: "another task" })).structured.qitemId as string;
    expect((await handOn(second, CALLER)).status).toBe(201);
    expect((await asCustomer("rig_queue_show", { qitemId: second })).structured.successor).toMatchObject({ destinationSession: CALLER });

    // Artifacts: its own item's, under its named root; never by root and path alone, never a question's.
    fs.writeFileSync(path.join(shared, "result.md"), "RESULT body");
    for (const id of [own, question.qitemId]) db.prepare("UPDATE queue_items SET evidence_ref = ? WHERE qitem_id = ?").run(path.join(shared, "result.md"), id);
    expect((await asCustomer("rig_artifact_read", { qitemId: own })).text).toContain("RESULT body");
    expect((await asCustomer("rig_artifact_read", { qitemId: question.qitemId })).structured).toMatchObject({ code: "out_of_scope" });
    expect((await asCustomer("rig_artifact_read", { root: "proof", path: "result.md" })).structured).toMatchObject({ code: "out_of_scope" });
  });

  it("reads the grant request's header from a one-line secret file, and refuses one that would replace the request's own", () => {
    const file = path.join(home, "header");
    fs.writeFileSync(file, "x-vercel-protection-bypass: preview-secret\n");
    expect(readCloudGrantHeader(file)).toEqual({ name: "x-vercel-protection-bypass", value: "preview-secret" });
    for (const bad of ["Authorization: Bearer other", "no colon here", "a: b\nc: d"]) {
      fs.writeFileSync(file, bad);
      expect(() => readCloudGrantHeader(file)).toThrow();
    }
  });
});
