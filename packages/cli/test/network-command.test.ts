// `rig network connect | status | disconnect` against the daemon's real network routes.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkCommand, type NetworkDeps } from "../src/commands/network.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { RigRepository } from "../../daemon/src/domain/rig-repository.js";
import { networkRoutes } from "../../daemon/src/routes/network.js";

let db: Database.Database;
let home: string;
let app: Hono;
let rigs: RigRepository;
/** Each write the CLI sent, with how long it would wait for the daemon. */
const posts: Array<{ url: string; timeoutMs?: number }> = [];
/** An account that answers the connector routes: a key for the one-time code, a bearer for each newly listed name. */
const listed = new Set<string>();
const accountFetch = async (url: string, init: { method: string; body: string }) => {
  const path = new URL(url).pathname;
  const body = JSON.parse(init.body) as { code?: string; participants?: string[] };
  const reply = (status: number, json: unknown) => ({ status, json: async () => json });
  if (path === "/api/connector/enroll") return body.code === "ec1.page" ? reply(200, { installation: { id: "inst-1", name: "lab" }, key: "oik1_c_inst-1_key" }) : reply(400, { error: "code_not_current" });
  const participants = (body.participants ?? []).map((name) => (listed.has(name) ? { name, state: "connected" } : (listed.add(name), { name, state: "connected", bearer: `bear-${name}` })));
  return reply(200, { participants, mcp: "https://account.example/mcp", rig: "acct" });
};
const routesWith = (bearerToken: string | null) => {
  const next = new Hono();
  next.use("*", async (c, n) => { c.set("rigRepo" as never, rigs as never); await n(); });
  next.route("/api/network", networkRoutes({ home, bearerToken, accountFetch, selfHostId: () => "host-a" }));
  return next;
};
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  rigs = new RigRepository(db);
  const node = rigs.addNode(rigs.createRig("lab").id, "impl", { runtime: "claude-code" });
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', ?, 'dev-impl@lab', 'running')").run(node.id);
  home = mkdtempSync(join(tmpdir(), "openrig-network-cli-"));
  app = routesWith(null);
  posts.length = 0;
});
afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

function cli(tokenFile: Record<string, string> = {}) {
  const lifecycleDeps: LifecycleDeps = {
    spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(),
    readFile: (p) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 19731, db: "/fixture/test.sqlite", startedAt: new Date().toISOString() }) : null,
    writeFile: vi.fn(), removeFile: vi.fn(), exists: (p) => p === STATE_FILE, mkdirp: vi.fn(), openForAppend: () => 3, isProcessAlive: () => true,
  } as LifecycleDeps;
  const call = async (method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(url, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, data: await res.json() };
  };
  const deps: NetworkDeps = {
    lifecycleDeps,
    clientFactory: () => ({ get: (url: string) => call("GET", url), post: (url: string, body: unknown, options?: { headers?: Record<string, string>; timeoutMs?: number }) => {
      posts.push({ url, timeoutMs: options?.timeoutMs });
      return call("POST", url, body, options?.headers);
    } }) as never,
    readTokenFile: (path) => { if (!(path in tokenFile)) throw new Error("no such file"); return tokenFile[path]!; },
  };
  return new Command().exitOverride().addCommand(networkCommand(deps));
}

it("connects a seat with its token file, shows it in status without the token, and disconnects it", async () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  await cli({ "/tok": "tok-abc" }).parseAsync(["node", "rig", "network", "connect", "dev-impl@lab", "--hub", "https://hub.example/mcp", "--as", "alex@team", "--token-file", "/tok"]);
  expect(String(out.mock.calls.at(-1)?.[0])).toMatch(/^Connected netb-[0-9a-f]{20}  dev-impl@lab -> alex@team at https:\/\/hub\.example\/mcp  no contact yet/);

  await cli().parseAsync(["node", "rig", "network", "status", "--json"]);
  const status = String(out.mock.calls.at(-1)?.[0]);
  expect(JSON.parse(status).bindings).toEqual([expect.objectContaining({ localSession: "dev-impl@lab", hubSeat: "alex@team", state: "active" })]);
  expect(status).not.toContain("tok-abc");

  await cli().parseAsync(["node", "rig", "network", "disconnect", "dev-impl@lab", "--reason", "done"]);
  expect(String(out.mock.calls.at(-1)?.[0])).toMatch(/^Disconnected netb-[0-9a-f]{20}  dev-impl@lab -> alex@team .*disconnected \(done\)\nRemove the participant on the hub too/);
  expect(process.exitCode).toBeUndefined();
});

it("names the daemon's refusal and exits 1, and an unreadable token file sends nothing", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  await cli({ "/tok": "tok-abc" }).parseAsync(["node", "rig", "network", "connect", "nobody@lab", "--hub", "https://hub.example/mcp", "--as", "alex@team", "--token-file", "/tok"]);
  expect(String(err.mock.calls.at(-1)?.[0])).toBe("No local seat is named 'nobody@lab'. (seat_not_found)");
  expect(process.exitCode).toBe(1);
  process.exitCode = undefined;
  await cli().parseAsync(["node", "rig", "network", "connect", "dev-impl@lab", "--hub", "https://hub.example/mcp", "--as", "alex@team", "--token-file", "/missing"]);
  expect(String(err.mock.calls.at(-1)?.[0])).toBe("Can't read the token file: no such file");
  expect(process.exitCode).toBe(1);
  expect((await app.request("/api/network/bindings").then((r) => r.json()) as { bindings: unknown[] }).bindings).toHaveLength(0);
});

it("a plain-http hub needs --allow-http: refused with the remedy, then connected and shown unencrypted in status and JSON", async () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const args = ["node", "rig", "network", "connect", "dev-impl@lab", "--hub", "http://192.0.2.7:7433/mcp", "--as", "alex@team", "--token-file", "/tok"];
  await cli({ "/tok": "tok-abc" }).parseAsync(args);
  expect(process.exitCode).toBe(1);
  expect(String(err.mock.calls.at(-1)?.[0])).toMatch(/plain http, .*unencrypted.*--allow-http to accept that for this binding\. \(http_not_allowed\)$/);
  process.exitCode = undefined;

  await cli({ "/tok": "tok-abc" }).parseAsync([...args, "--allow-http"]);
  expect(process.exitCode).toBeUndefined();
  expect(String(out.mock.calls.at(-1)?.[0])).toMatch(/^Connected netb-[0-9a-f]{20}  dev-impl@lab -> alex@team at http:\/\/192\.0\.2\.7:7433\/mcp  UNENCRYPTED \(http, allowed for this binding\)/);
  await cli().parseAsync(["node", "rig", "network", "status"]);
  expect(String(out.mock.calls.at(-1)?.[0])).toContain("UNENCRYPTED (http, allowed for this binding)");
  await cli().parseAsync(["node", "rig", "network", "status", "--json"]);
  const json = String(out.mock.calls.at(-1)?.[0]);
  expect(JSON.parse(json).bindings).toEqual([expect.objectContaining({ hubUrl: "http://192.0.2.7:7433/mcp", allowHttp: true, unencrypted: true })]);
  expect(json).not.toContain("tok-abc");
});

it("status shows a hub item closed elsewhere under its binding, in text and JSON", async () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  await cli({ "/tok": "tok-abc" }).parseAsync(["node", "rig", "network", "connect", "dev-impl@lab", "--hub", "https://hub.example/mcp", "--as", "alex@team", "--token-file", "/tok"]);
  const bindingId = String(out.mock.calls.at(-1)?.[0]).match(/netb-[0-9a-f]{20}/)![0];
  db.prepare(`INSERT INTO network_receipts (local_qitem_id, binding_id, hub_qitem_id, created_at, settled_at, outcome, last_error)
    VALUES ('qitem-net-0001', ?, 'hub-9', '2026-11-11T19:00:00Z', '2026-11-11T19:01:00Z', 'closed_on_hub', 'closed elsewhere (done, canceled)')`).run(bindingId);
  await cli().parseAsync(["node", "rig", "network", "status"]);
  expect(String(out.mock.calls.at(-1)?.[0])).toContain("\n  hub item hub-9 was closed elsewhere before its result arrived; the result stays on qitem-net-0001");
  await cli().parseAsync(["node", "rig", "network", "status", "--json"]);
  expect(JSON.parse(String(out.mock.calls.at(-1)?.[0])).bindings[0].closedElsewhere).toEqual([{ hubItem: "hub-9", localItem: "qitem-net-0001", note: "closed elsewhere (done, canceled)" }]);
});

it("enrolls with the account page's code, connects a seat by name through it, and shows both in status", async () => {
  listed.clear();
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  await cli().parseAsync(["node", "rig", "network", "enroll", "ec1.page", "--site", "https://account.example"]);
  expect(process.exitCode).toBeUndefined();
  expect(String(out.mock.calls.at(-1)?.[0])).toMatch(/^Enrolled at https:\/\/account\.example\/ as installation lab \(neti-[0-9a-f]{20}\)\nConnect a seat with rig network connect <seat> --as <name>\.$/);

  await cli().parseAsync(["node", "rig", "network", "connect", "dev-impl@lab", "--hub", "https://hub.example/mcp", "--as", "alex@team"]);
  expect(process.exitCode).toBe(1);
  expect(String(err.mock.calls.at(-1)?.[0])).toBe("Give both --hub and --token-file, or neither to connect through the enrolled account.");
  process.exitCode = undefined;

  await cli().parseAsync(["node", "rig", "network", "connect", "dev-impl@lab", "--as", "alpha"]);
  expect(process.exitCode).toBeUndefined();
  expect(String(out.mock.calls.at(-1)?.[0])).toMatch(/^Connected netb-[0-9a-f]{20}  dev-impl@lab -> alpha@acct at https:\/\/account\.example\/mcp  no contact yet\nWork for alpha@acct reaches dev-impl@lab/);
  await cli().parseAsync(["node", "rig", "network", "status"]);
  const status = String(out.mock.calls.at(-1)?.[0]).split("\n");
  expect(status[0]).toMatch(/^Enrolled at https:\/\/account\.example\/ as installation lab \(neti-/);
  expect(status[1]).toMatch(/^netb-[0-9a-f]{20}  dev-impl@lab -> alpha@acct at https:\/\/account\.example\/mcp/);
  await cli().parseAsync(["node", "rig", "network", "status", "--json"]);
  expect(String(out.mock.calls.at(-1)?.[0])).not.toMatch(/oik1_|bear-alpha/);

  await cli().parseAsync(["node", "rig", "network", "disconnect", "dev-impl@lab"]);
  expect(process.exitCode).toBeUndefined();
  const disconnected = String(out.mock.calls.at(-1)?.[0]);
  expect(disconnected).toMatch(/\nThe account stopped listing alpha, which revokes it there\.$/);
  expect(disconnected).not.toContain("Remove the participant on the hub");
  // Every network write waits past the daemon's 30 s account deadline, so the account's own answer is what's shown.
  expect(posts.map((p) => p.url)).toEqual(["/api/network/installations", "/api/network/bindings", expect.stringMatching(/^\/api\/network\/bindings\/.+\/disconnect$/)]);
  for (const p of posts) expect(p.timeoutMs).toBeGreaterThanOrEqual(45_000);
});

it("sends the operator bearer on its writes, so a daemon with one configured takes them", async () => {
  app = routesWith("op-secret");
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const connectArgs = ["node", "rig", "network", "connect", "dev-impl@lab", "--hub", "https://hub.example/mcp", "--as", "alex@team", "--token-file", "/tok"];
  vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "wrong");
  await cli({ "/tok": "tok-abc" }).parseAsync(connectArgs);
  expect(process.exitCode).toBe(1);
  expect(String(err.mock.calls.at(-1)?.[0])).toContain("bearer token does not match");
  process.exitCode = undefined;
  vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "op-secret");
  await cli({ "/tok": "tok-abc" }).parseAsync(connectArgs);
  expect(process.exitCode).toBeUndefined();
  expect(String(out.mock.calls.at(-1)?.[0])).toMatch(/^Connected netb-/);
  await cli().parseAsync(["node", "rig", "network", "disconnect", "dev-impl@lab"]);
  expect(process.exitCode).toBeUndefined();
  expect(String(out.mock.calls.at(-1)?.[0])).toMatch(/^Disconnected netb-/);
});
