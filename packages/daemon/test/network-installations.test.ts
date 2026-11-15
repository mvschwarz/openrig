// Enrolling in an account and connecting seats by name, through the daemon's real network routes, against an account
// that answers the way the account's connector routes do: a one-time code for an installation key, then a participant
// list that answers a bearer for each newly listed name and revokes a name dropped from it.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { readNetworkCredential, readPrivateToken } from "../src/domain/network/network-bindings.js";
import { networkInstallationKeyFile, type AccountFetch } from "../src/domain/network/network-installations.js";
import { networkRoutes } from "../src/routes/network.js";

/** Makes removing a path with this ending fail, the way a busy file does. */
const failRemoval = vi.hoisted(() => ({ suffix: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    rmSync: (...args: Parameters<typeof real.rmSync>) => {
      if (failRemoval.suffix && String(args[0]).endsWith(failRemoval.suffix)) throw Object.assign(new Error("EBUSY: resource busy or locked, rm"), { code: "EBUSY" });
      return real.rmSync(...args);
    },
  };
});

const KEY = `oik1_cust_inst-1_${"k".repeat(43)}`;

class FakeAccount {
  readonly codes = new Set(["ec1.good", "ec1.next"]);
  /** Each enrollment is a new installation with its own key and an empty list. */
  enrollments = 0;
  key = KEY;
  readonly used = new Set<string>();
  instance: string | null = null;
  names = new Map<string, { gen: number; state: "connected" | "revoked" }>();
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
  /** How long a participant list waits before it's applied, so concurrent requests overlap. */
  delayMs = 0;
  /** After this many applied lists, the account goes down. */
  downAfterPuts: number | null = null;

  /** The owner removed this installation on the account page. */
  forget(): void { this.instance = null; }

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
      this.enrollments++;
      this.key = `${KEY}${this.enrollments}`;
      this.names = new Map();
      return reply(200, { installation: { id: `inst-${this.enrollments}`, name: "lab" }, key: this.key });
    }
    if (path === "/api/connector/identities" && init.method === "PUT") {
      if (init.headers.Authorization !== `Bearer ${this.key}` || body.instance !== this.instance) return reply(401, { error: "not_enrolled" });
      if (this.delayMs) await sleep(this.delayMs);
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
      if (this.downAfterPuts !== null && this.puts.length >= this.downAfterPuts) this.down = true;
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
let hostId: string | null = "host-a";
beforeEach(() => {
  hostId = "host-a";
  db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  rigs = new RigRepository(db);
  home = mkdtempSync(join(tmpdir(), "openrig-network-account-"));
  account = new FakeAccount();
  app = new Hono();
  app.use("*", async (c, next) => { c.set("rigRepo" as never, rigs as never); await next(); });
  app.route("/api/network", networkRoutes({ home, accountFetch: account.fetch, selfHostId: () => hostId, accountTimeoutMs: 1000 }));
});
afterEach(() => { failRemoval.suffix = null; db.close(); rmSync(home, { recursive: true, force: true }); });

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
const replace = () => post("/installations", { code: "ec1.next", site: "https://account.example", replace: true });
const status = async () => (await (await app.request("/api/network/bindings")).json()) as {
  bindings: Array<{ id: string; state: string; accountRemoval: string | null; accountRemovedAt: string | null }>; installations: Array<{ installationId: string }> };

it("enrolling trades the code for a key kept privately; a used code is refused with its reason; a second enroll at the site sends nothing", async () => {
  const enrolled = await enroll();
  expect(enrolled).toMatchObject({ status: 201, data: { site: "https://account.example/", installationId: "inst-1", name: "lab" } });
  expect(enrolled.data.id).toMatch(/^neti-[0-9a-f]{20}$/);
  expect(account.instance).toBe("host-a");
  const keyFile = networkInstallationKeyFile(home, enrolled.data.id);
  expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  expect(readPrivateToken(keyFile, () => "missing")).toBe(account.key);
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

it("one deadline covers all of a command's account calls: a connect that needs three lists runs out of time instead of waiting for each", async () => {
  seat("a@lab");
  await enroll();
  account.loseNext = true;
  await connect("a@lab", "alpha");
  // Each list now takes 600 ms against this daemon's 1 s deadline, and recovering the lost answer needs three.
  account.delayMs = 600;
  const late = await connect("a@lab", "alpha");
  expect(late).toMatchObject({ status: 503, data: { error: "account_unavailable" } });
  expect(late.data.message).toContain("this command's time with the account ran out");
  expect(account.puts.at(-1)).toEqual([]);
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
  expect(failed).toMatchObject({ status: 502, data: { error: "account_update_unconfirmed" } });
  expect(failed.data.message).toContain("couldn't confirm that the account dropped alpha");
  expect(failed.data.message).toContain(`Run \`rig network disconnect ${alpha.data.id}\` again.`);
  expect(account.names.get("alpha")!.state).toBe("connected");
  // Status keeps saying it's unconfirmed until an answered list shows otherwise.
  const status = await (await app.request("/api/network/bindings")).json() as { bindings: Array<{ id: string; accountRemoval: string | null }> };
  expect(status.bindings.find((b) => b.id === alpha.data.id)!.accountRemoval).toBe("unconfirmed");
  account.down = false;
  const ended = await post(`/bindings/${alpha.data.id}/disconnect`, {});
  expect(ended).toMatchObject({ status: 200, data: { state: "disconnected", accountRemoval: "confirmed" } });
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

it("concurrent account writes keep every active name: two connects started together, and a disconnect racing a connect", async () => {
  seat("a@lab"); seat("b@lab"); seat("c@lab");
  await enroll();
  account.delayMs = 20;
  const [alpha, beta] = await Promise.all([connect("a@lab", "alpha"), connect("b@lab", "beta")]);
  expect([alpha.status, beta.status]).toEqual([201, 201]);
  expect(account.names.get("alpha")!.state).toBe("connected");
  expect(account.names.get("beta")!.state).toBe("connected");
  const [dropped, gamma] = await Promise.all([post(`/bindings/${alpha.data.id}/disconnect`, {}), connect("c@lab", "gamma")]);
  expect(dropped).toMatchObject({ status: 200, data: { accountRemoval: "confirmed" } });
  expect(gamma.status).toBe(201);
  expect(account.names.get("alpha")!.state).toBe("revoked");
  expect(account.names.get("beta")!.state).toBe("connected");
  expect(account.names.get("gamma")!.state).toBe("connected");
  expect(readNetworkCredential(home, gamma.data.id)).toBe(`bear-gamma-1`);
});

it("enroll --replace repairs an installation the account forgot: the old key works until the new code is accepted, and old bindings are ended and named", async () => {
  seat("a@lab"); seat("b@lab");
  const first = await enroll();
  const alpha = await connect("a@lab", "alpha");
  account.forget();
  const refused = await connect("b@lab", "beta");
  expect(refused).toMatchObject({ status: 401, data: { error: "not_enrolled" } });
  expect(refused.data.message).toContain("rig network enroll <code> --site https://account.example/ --replace");
  expect(await enroll()).toMatchObject({ status: 409, data: { error: "already_enrolled" } });

  // A refused new code changes nothing.
  const keyFile = networkInstallationKeyFile(home, first.data.id);
  const oldKey = readPrivateToken(keyFile, () => "missing");
  expect(await post("/installations", { code: "ec1.spent", site: "https://account.example", replace: true })).toMatchObject({ status: 400 });
  expect(readPrivateToken(keyFile, () => "missing")).toBe(oldKey);

  const replaced = await post("/installations", { code: "ec1.next", site: "https://account.example", replace: true });
  expect(replaced).toMatchObject({ status: 201, data: { id: first.data.id, installationId: "inst-2",
    replaced: { endedBindings: [{ id: alpha.data.id, localSession: "a@lab", participantName: "alpha" }] } } });
  expect(readPrivateToken(keyFile, () => "missing")).toBe(account.key);
  const status = await (await app.request("/api/network/bindings")).json() as { bindings: Array<{ id: string; state: string; accountRemoval: string | null }> };
  expect(status.bindings.find((b) => b.id === alpha.data.id)).toMatchObject({ state: "disconnected", accountRemoval: "old-installation" });
  expect((await connect("b@lab", "beta")).status).toBe(201);
});

it("a lost installation key is repaired the same way, and a failed replace keeps the old enrollment working", async () => {
  seat("a@lab"); seat("b@lab");
  const first = await enroll();
  await connect("a@lab", "alpha");
  // A refused replace leaves the old key in use.
  expect(await post("/installations", { code: "ec1.spent", site: "https://account.example", replace: true })).toMatchObject({ status: 400 });
  expect((await connect("b@lab", "beta")).status).toBe(201);

  rmSync(join(networkInstallationKeyFile(home, first.data.id), ".."), { recursive: true });
  seat("c@lab");
  const missing = await connect("c@lab", "gamma");
  expect(missing).toMatchObject({ status: 404, data: { error: "credential_missing" } });
  expect(missing.data.message).toContain("--replace");
  expect((await post("/installations", { code: "ec1.next", site: "https://account.example", replace: true })).status).toBe(201);
  expect((await connect("c@lab", "gamma")).status).toBe(201);
});

it("a replace that fails here after the account accepted the new code puts the old key back", async () => {
  const first = await enroll();
  const keyFile = networkInstallationKeyFile(home, first.data.id);
  const oldKey = readPrivateToken(keyFile, () => "missing");
  db.exec("CREATE TRIGGER fail_replace BEFORE UPDATE ON network_installations BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  const res = await app.request("/api/network/installations", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "ec1.next", site: "https://account.example", replace: true }) });
  expect(res.status).toBe(500);
  expect(account.used.has("ec1.next")).toBe(true);
  expect(readPrivateToken(keyFile, () => "missing")).toBe(oldKey);
  expect(readdirSync(dirname(keyFile))).toEqual(["key.json"]);
  const status = await (await app.request("/api/network/bindings")).json() as { installations: Array<{ installationId: string }> };
  expect(status.installations.map((i) => i.installationId)).toEqual(["inst-1"]);
});

it("an unresolved host id reads as try again, not enroll again, and sends nothing", async () => {
  seat("a@lab");
  await enroll();
  hostId = null;
  const calls = account.calls;
  expect(await connect("a@lab", "alpha")).toMatchObject({ status: 503, data: { error: "instance_unknown" } });
  expect(account.calls).toBe(calls);
});

it("a failed bind whose drop at the account also fails says the account may still list the name", async () => {
  seat("a@lab");
  await enroll();
  account.mcp = "http://account.example/mcp";
  account.downAfterPuts = 1;
  const refused = await connect("a@lab", "alpha");
  expect(refused).toMatchObject({ status: 400, data: { error: "http_not_allowed" } });
  expect(refused.data.message).toContain("OpenRig couldn't confirm the account dropped alpha again");
  expect(account.names.get("alpha")!.state).toBe("connected");
});

it("an unconfirmed removal is confirmed by a later answered list that no longer has the name", async () => {
  seat("a@lab"); seat("b@lab");
  await enroll();
  const alpha = await connect("a@lab", "alpha");
  account.down = true;
  expect((await post(`/bindings/${alpha.data.id}/disconnect`, {})).data.error).toBe("account_update_unconfirmed");
  account.down = false;
  expect((await connect("b@lab", "beta")).status).toBe(201);
  const status = await (await app.request("/api/network/bindings")).json() as { bindings: Array<{ id: string; accountRemoval: string | null }> };
  expect(status.bindings.find((b) => b.id === alpha.data.id)!.accountRemoval).toBe("confirmed");
});

it("a name-only connect without an enrollment says how to enroll", async () => {
  seat("a@lab");
  const refused = await connect("a@lab", "alpha");
  expect(refused).toMatchObject({ status: 404, data: { error: "not_enrolled" } });
  expect(refused.data.message).toContain("rig network enroll <code> --site <site>");
  expect(account.calls).toBe(0);
});

it("an unconfirmed drop from before a replace stays with the old installation: the new installation's lists never confirm it", async () => {
  seat("a@lab"); seat("b@lab");
  await enroll();
  const alpha = await connect("a@lab", "alpha");
  account.down = true;
  expect(await post(`/bindings/${alpha.data.id}/disconnect`, {})).toMatchObject({ status: 502, data: { error: "account_update_unconfirmed" } });
  account.down = false;
  expect(await replace()).toMatchObject({ status: 201, data: { installationId: "inst-2", replaced: { endedBindings: [] } } });
  const alphaNow = async () => (await status()).bindings.find((b) => b.id === alpha.data.id);
  expect(await alphaNow()).toMatchObject({ accountRemoval: "old-installation", accountRemovedAt: null });

  // The new installation's list doesn't have alpha, which was never listed there.
  expect((await connect("b@lab", "beta")).status).toBe(201);
  expect(account.puts.at(-1)).toEqual(["beta"]);
  expect(await alphaNow()).toMatchObject({ accountRemoval: "old-installation", accountRemovedAt: null });
  // Disconnecting it again sends nothing this key could use and claims no drop.
  const puts = account.puts.length;
  expect(await post(`/bindings/${alpha.data.id}/disconnect`, {})).toMatchObject({ status: 200, data: { accountRemoval: "old-installation", accountRemovedAt: null } });
  expect(account.puts.length).toBe(puts);
});

it("a plain local failure to save the binding, with the account's drop failing too, still says the account may list the name", async () => {
  seat("a@lab");
  await enroll();
  db.exec("CREATE TRIGGER fail_bind BEFORE INSERT ON network_bindings BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  account.downAfterPuts = 1;
  const failed = await connect("a@lab", "alpha");
  expect(failed).toMatchObject({ status: 500, data: { error: "binding_write_failed" } });
  expect(failed.data.message).toContain("disk I/O error");
  expect(failed.data.message).toContain("couldn't confirm the account dropped alpha again");
  expect(JSON.stringify(failed.data)).not.toContain("bear-alpha");
  expect(account.names.get("alpha")!.state).toBe("connected");
});

it("a replace whose wait for the installation's turn uses up its deadline sends no code and changes nothing", async () => {
  seat("a@lab");
  const first = await enroll();
  const keyFile = networkInstallationKeyFile(home, first.data.id);
  const oldKey = readPrivateToken(keyFile, () => "missing");
  // A list that overruns holds the installation's turn past the replace's 1 s deadline.
  account.delayMs = 1800;
  const slow = connect("a@lab", "alpha");
  await sleep(50);
  const late = await replace();
  expect(late).toMatchObject({ status: 503, data: { error: "account_unavailable" } });
  expect(late.data.message).toContain("The code wasn't sent");
  expect(account.used.has("ec1.next")).toBe(false);
  expect(readPrivateToken(keyFile, () => "missing")).toBe(oldKey);
  await slow;
});

it("a replace that fails here with only the key file missing leaves no key behind, as before it, and says what the account now has", async () => {
  seat("a@lab");
  const first = await enroll();
  const keyFile = networkInstallationKeyFile(home, first.data.id);
  rmSync(keyFile);
  db.exec("CREATE TRIGGER fail_replace BEFORE UPDATE ON network_installations BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  const failed = await replace();
  expect(failed).toMatchObject({ status: 500, data: { error: "replace_failed" } });
  expect(failed.data.message).toContain("nothing here changed");
  expect(failed.data.message).toContain("a new installation whose key nothing here holds");
  expect(readdirSync(dirname(keyFile))).toEqual([]);
  expect((await status()).installations.map((i) => i.installationId)).toEqual(["inst-1"]);
  db.exec("DROP TRIGGER fail_replace");
  expect(await connect("a@lab", "alpha")).toMatchObject({ status: 404, data: { error: "credential_missing" } });
});

it("a replace whose old binding can't be ended changes nothing here: the switch and the bindings' end commit together", async () => {
  seat("a@lab");
  const first = await enroll();
  const alpha = await connect("a@lab", "alpha");
  const keyFile = networkInstallationKeyFile(home, first.data.id);
  const oldKey = readPrivateToken(keyFile, () => "missing");
  db.exec("CREATE TRIGGER fail_end BEFORE UPDATE OF state ON network_bindings BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  expect(await replace()).toMatchObject({ status: 500, data: { error: "replace_failed" } });
  expect(readPrivateToken(keyFile, () => "missing")).toBe(oldKey);
  expect(readdirSync(dirname(keyFile))).toEqual(["key.json"]);
  const now = await status();
  expect(now.installations.map((i) => i.installationId)).toEqual(["inst-1"]);
  expect(now.bindings.find((b) => b.id === alpha.data.id)).toMatchObject({ state: "active" });
});

it("a replace whose old key's backup can't be removed after the switch still ends the old bindings, and reports the cleanup", async () => {
  seat("a@lab");
  const first = await enroll();
  const alpha = await connect("a@lab", "alpha");
  failRemoval.suffix = "key.json.prev";
  const replaced = await replace();
  failRemoval.suffix = null;
  expect(replaced).toMatchObject({ status: 201, data: { installationId: "inst-2", replaced: { endedBindings: [{ id: alpha.data.id, participantName: "alpha" }] } } });
  expect(replaced.data.replaced.problems).toEqual([expect.stringMatching(/backup at .*key\.json\.prev couldn't be removed \(EBUSY/)]);
  expect(readPrivateToken(networkInstallationKeyFile(home, first.data.id), () => "missing")).toBe(account.key);
  expect((await status()).bindings.find((b) => b.id === alpha.data.id)).toMatchObject({ state: "disconnected", accountRemoval: "old-installation" });
});
