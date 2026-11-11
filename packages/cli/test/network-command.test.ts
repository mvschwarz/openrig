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
const routesWith = (bearerToken: string | null) => {
  const next = new Hono();
  next.use("*", async (c, n) => { c.set("rigRepo" as never, rigs as never); await n(); });
  next.route("/api/network", networkRoutes({ home, bearerToken }));
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
    clientFactory: () => ({ get: (url: string) => call("GET", url), post: (url: string, body: unknown, options?: { headers?: Record<string, string> }) => call("POST", url, body, options?.headers) }) as never,
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
  expect(String(out.mock.calls.at(-1)?.[0])).toMatch(/^Disconnected netb-[0-9a-f]{20}  dev-impl@lab -> alex@team .*disconnected \(done\)/);
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
