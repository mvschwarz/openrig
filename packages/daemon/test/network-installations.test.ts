// Enrolling in an account and connecting seats by name, through the daemon's real network routes, against an account
// that answers the way the account's connector routes do: a one-time code for an installation key, then a participant
// list that answers a bearer for each newly listed name and revokes a name dropped from it.
import { afterEach, beforeEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { readNetworkCredential, readPrivateToken } from "../src/domain/network/network-bindings.js";
import { networkInstallationKeyFile, type AccountFetch } from "../src/domain/network/network-installations.js";
import { networkRoutes } from "../src/routes/network.js";

const KEY = `oik1_cust_inst-1_${"k".repeat(43)}`;

class FakeAccount {
  readonly codes = new Set(["ec1.good"]);
  readonly used = new Set<string>();
  instance: string | null = null;
  readonly names = new Map<string, { gen: number; state: "connected" | "revoked" }>();
  readonly elsewhere = new Set(["taken"]);
  readonly puts: string[][] = [];
  calls = 0;
  readonly inits: Array<{ redirect: string; signal: AbortSignal }> = [];
  /** Makes the next call fail the way fetch does on a redirect it won't follow. */
  redirectNext = false;
  /** The next call never answers. */
  stallNext = false;
  /** The next participant list is applied, then its answer is lost. */
  loseNext = false;
  down = false;
  mcp = "https://account.example/mcp";
  /** The next participant lists the account can't apply, because something else changed the installation. */
  dropFails = 0;

  readonly fetch: AccountFetch = async (url, init) => {
    this.calls++;
    this.inits.push({ redirect: init.redirect, signal: init.signal });
    if (this.down) throw new Error("connect ECONNREFUSED");
    if (this.redirectNext) { this.redirectNext = false; throw Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") }); }
    if (this.stallNext) { this.stallNext = false; await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })); }
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body) as { code?: string; instance?: string; participants?: string[] };
    const reply = (status: number, json: unknown) => ({ status, json: async () => json });
    if (path === "/api/connector/enroll" && init.method === "POST") {
      if (this.used.has(body.code!)) return reply(409, { error: "code_not_current" });
      if (!this.codes.has(body.code!)) return reply(400, { error: "code_not_current" });
      this.used.add(body.code!);
      this.instance = body.instance!;
      return reply(200, { installation: { id: "inst-1", name: "lab" }, key: KEY });
    }
    if (path === "/api/connector/identities" && init.method === "PUT") {
      if (init.headers.Authorization !== `Bearer ${KEY}` || body.instance !== this.instance) return reply(401, { error: "not_enrolled" });
      const list = body.participants!;
      if (list.some((n) => this.elsewhere.has(n))) return reply(409, { error: "name_taken" });
      if (this.dropFails > 0) { this.dropFails--; return reply(409, { error: "drop_failed" }); }
      this.puts.push(list);
      for (const [name, entry] of this.names) if (!list.includes(name)) entry.state = "revoked";
      const participants = list.map((name) => {
        const entry = this.names.get(name);
        if (entry?.state === "connected") return { name, state: "connected" };
        const gen = (entry?.gen ?? 0) + 1;
        this.names.set(name, { gen, state: "connected" });
        return { name, state: "connected", bearer: `bear-${name}-${gen}` };
      });
      if (this.loseNext) { this.loseNext = false; throw new Error("socket hang up"); }
      return reply(200, { participants, mcp: this.mcp, rig: "acct" });
    }
    return reply(404, { error: "not_found" });
  };
}

let db: Database.Database;
let home: string;
let rigs: RigRepository;
let account: FakeAccount;
let app: Hono;
let seq = 0;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  rigs = new RigRepository(db);
  home = mkdtempSync(join(tmpdir(), "openrig-network-account-"));
  account = new FakeAccount();
  app = new Hono();
  app.use("*", async (c, next) => { c.set("rigRepo" as never, rigs as never); await next(); });
  app.route("/api/network", networkRoutes({ home, accountFetch: account.fetch, selfHostId: () => "host-a", accountTimeoutMs: 200 }));
});
afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

function seat(session: string): void {
  const rig = rigs.listRigs().find((r) => r.name === "lab") ?? rigs.createRig("lab");
  const node = rigs.addNode(rig.id, `n${++seq}`, { runtime: "claude-code" });
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')").run(`s${seq}`, node.id, session);
}
const post = async (path: string, body: unknown) => {
  const res = await app.request(`/api/network${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() as Record<string, any> };
};
const enroll = () => post("/installations", { code: "ec1.good", site: "https://account.example" });
const connect = (session: string, name: string) => post("/bindings", { session, participantName: name });

it("enrolling trades the code for a key kept privately; a used code is refused with its reason; a second enroll at the site sends nothing", async () => {
  const enrolled = await enroll();
  expect(enrolled).toMatchObject({ status: 201, data: { site: "https://account.example/", installationId: "inst-1", name: "lab" } });
  expect(enrolled.data.id).toMatch(/^neti-[0-9a-f]{20}$/);
  expect(account.instance).toBe("host-a");
  const keyFile = networkInstallationKeyFile(home, enrolled.data.id);
  expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  expect(readPrivateToken(keyFile, () => "missing")).toBe(KEY);
  const listed = await (await app.request("/api/network/bindings")).text();
  expect(listed).toContain(enrolled.data.id);
  expect(listed).not.toContain(KEY);

  const calls = account.calls;
  expect(await enroll()).toMatchObject({ status: 409, data: { error: "already_enrolled" } });
  expect(account.calls).toBe(calls);
  expect(await post("/installations", { code: "ec1.good", site: "http://other.example", allowHttp: false })).toMatchObject({ status: 400, data: { error: "http_not_allowed" } });
  expect(account.calls).toBe(calls);

  // The same code at another site: the account says it's spent.
  expect(await post("/installations", { code: "ec1.good", site: "https://second.example" })).toMatchObject({ status: 409, data: { error: "code_not_current" } });
});

it("connecting by name lists it with the account and binds to the account's MCP front with its bearer; a second seat keeps the first listed", async () => {
  seat("a@lab");
  seat("b@lab");
  const enrolled = await enroll();
  const alpha = await connect("a@lab", "alpha");
  expect(alpha).toMatchObject({ status: 201, data: { localSession: "a@lab", hubUrl: "https://account.example/mcp", hubSeat: "alpha@acct",
    installationId: enrolled.data.id, participantName: "alpha", state: "active" } });
  expect(readNetworkCredential(home, alpha.data.id)).toBe("bear-alpha-1");
  const beta = await connect("b@lab", "beta");
  expect(beta.status).toBe(201);
  expect(account.puts.at(-1)).toEqual(["alpha", "beta"]);
  expect(readNetworkCredential(home, beta.data.id)).toBe("bear-beta-1");
  expect(account.names.get("alpha")).toEqual({ gen: 1, state: "connected" });
});

it("a lost answer to the participant list is recovered on the next connect: the name is dropped and listed again for a fresh bearer", async () => {
  seat("a@lab");
  await enroll();
  account.loseNext = true;
  expect(await connect("a@lab", "alpha")).toMatchObject({ status: 503, data: { error: "account_unavailable" } });
  expect(account.names.get("alpha")).toEqual({ gen: 1, state: "connected" });
  const again = await connect("a@lab", "alpha");
  expect(again.status).toBe(201);
  expect(account.puts.slice(-2)).toEqual([[], ["alpha"]]);
  expect(readNetworkCredential(home, again.data.id)).toBe("bear-alpha-2");
});

it("a name another connection holds is refused, and a seat that can't be connected sends nothing to the account", async () => {
  seat("a@lab");
  await enroll();
  expect(await connect("a@lab", "taken")).toMatchObject({ status: 409, data: { error: "name_taken" } });
  const calls = account.calls;
  expect(await connect("nobody@lab", "alpha")).toMatchObject({ status: 404, data: { error: "seat_not_found" } });
  expect(await connect("a@lab", "Not A Name")).toMatchObject({ status: 400, data: { error: "invalid_name" } });
  expect(account.calls).toBe(calls);
  const listed = await (await app.request("/api/network/bindings")).json() as { bindings: unknown[] };
  expect(listed.bindings).toHaveLength(0);
});

it("disconnect drops the name at the account; when the account can't be reached the binding still ends, and the retry it names drops it", async () => {
  seat("a@lab");
  seat("b@lab");
  await enroll();
  const alpha = await connect("a@lab", "alpha");
  await connect("b@lab", "beta");
  account.down = true;
  const failed = await post("/bindings/a@lab/disconnect", {});
  expect(failed).toMatchObject({ status: 502, data: { error: "account_update_failed" } });
  expect(failed.data.message).toContain(`Run \`rig network disconnect ${alpha.data.id}\` again to retry.`);
  expect(account.names.get("alpha")!.state).toBe("connected");
  account.down = false;
  const ended = await post(`/bindings/${alpha.data.id}/disconnect`, {});
  expect(ended).toMatchObject({ status: 200, data: { state: "disconnected" } });
  expect(ended.data.accountRemovedAt).not.toBeNull();
  expect(account.puts.at(-1)).toEqual(["beta"]);
  expect(account.names.get("alpha")!.state).toBe("revoked");
  expect(account.names.get("beta")!.state).toBe("connected");
});

it("a bind that fails here after the account listed the name has the account drop it again", async () => {
  seat("a@lab");
  await enroll();
  // The account answers a plain-http front, which this binding has no --allow-http choice for.
  account.mcp = "http://account.example/mcp";
  expect(await connect("a@lab", "alpha")).toMatchObject({ status: 400, data: { error: "http_not_allowed" } });
  expect(account.puts).toEqual([["alpha"], []]);
  expect(account.names.get("alpha")!.state).toBe("revoked");
});

it("a participant list the account couldn't apply is retried once, and a second failure says to try again, not that the name is taken", async () => {
  seat("a@lab");
  seat("b@lab");
  await enroll();
  account.dropFails = 1;
  expect((await connect("a@lab", "alpha")).status).toBe(201);
  expect(account.names.get("alpha")).toEqual({ gen: 1, state: "connected" });
  account.dropFails = 2;
  expect(await connect("b@lab", "beta")).toMatchObject({ status: 503, data: { error: "account_busy" } });
  const listed = await (await app.request("/api/network/bindings")).json() as { bindings: Array<{ localSession: string }> };
  expect(listed.bindings.map((b) => b.localSession)).toEqual(["a@lab"]);
});

it("the installation key goes only to the enrolled site: a redirect isn't followed with it, and a stalled call ends", async () => {
  seat("a@lab");
  account.redirectNext = true;
  expect(await enroll()).toMatchObject({ status: 502, data: { error: "account_redirected" } });
  expect(account.inits.every((i) => i.redirect === "error" && i.signal instanceof AbortSignal)).toBe(true);
  expect(account.used.size).toBe(0);
  await enroll();
  account.stallNext = true;
  const stalled = await connect("a@lab", "alpha");
  expect(stalled).toMatchObject({ status: 503, data: { error: "account_unavailable" } });
  expect(account.inits.every((i) => i.redirect === "error")).toBe(true);
});

it("a name-only connect without an enrollment says how to enroll", async () => {
  seat("a@lab");
  const refused = await connect("a@lab", "alpha");
  expect(refused).toMatchObject({ status: 404, data: { error: "not_enrolled" } });
  expect(refused.data.message).toContain("rig network enroll <code> --site <site>");
  expect(account.calls).toBe(0);
});
