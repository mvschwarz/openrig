import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { coreAppRoutes } from "../src/routes/core-app.js";
import { CoreAppAccess } from "../src/domain/core-app-access.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
describe("Core app boundary", () => {
  it("requires app authentication even on tokenless loopback and rejects sender attribution as authentication", async () => {
    const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); closes.push(() => db.close());
    const { app } = createTestApp(db);
    for (const headers of [{}, { "X-OpenRig-Session": "human-test@external" }, { Authorization: "Bearer operator" }]) {
      const response = await app.request("/api/apps/v1/capabilities", { headers });
      expect(response.status).toBe(401);
    }
  });
  it("refuses provisioning without a configured operator bearer", async () => {
    const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); closes.push(() => db.close());
    const response = await createTestApp(db).app.request("/api/apps/v1/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "app_provisioning_unconfigured" });
  });
});

const PERSON = "human-test@external", OTHER = "human-other@external";
const registry = { ok: true as const, entities: [PERSON, OTHER].map(address => ({ entityId: address.split("@")[0]!, class: "human" as const,
  displayName: address, address, connectorBindings: [], prefs: { deliveryClass: "A" as const } })) };
function fixture(operatorToken: string | null = "operator") {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); closes.push(() => db.close());
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry,
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
  const access = new CoreAppAccess(db, repo);
  const app = new Hono(); app.route("/api/apps", coreAppRoutes({ access, operatorToken }));
  const send = (path: string, body?: unknown, token = operatorToken, peer: string | null = "127.0.0.1", method = body === undefined ? "GET" : "POST") => app.request(`/api/apps${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, peer ? { incoming: { socket: { remoteAddress: peer } } } : {});
  const provision = (actors = [PERSON], appId = "test") => send("/v1/credentials", { appId, actors, job: "human-answer", attribution: "app-attributed" });
  return { db, bus, repo, access, app, send, provision };
}

describe("app credential lifecycle", () => {
  it("stores only a secret hash, permits overlapping rotation, revokes each credential independently", async () => {
    const f = fixture(); const first = await (await f.provision()).json(); const second = await (await f.provision([OTHER])).json();
    expect(first.token).toMatch(/^orapp_[a-f0-9]{64}$/);
    expect(JSON.stringify(f.db.prepare("SELECT * FROM core_app_credentials").all())).not.toContain(first.token);
    expect((await f.send("/v1/capabilities", undefined, first.token)).status).toBe(200);
    expect((await f.send("/v1/capabilities", undefined, second.token)).status).toBe(200);
    expect((await f.send(`/v1/credentials/${first.credentialId}`, undefined, "operator", "::1", "DELETE")).status).toBe(200);
    expect((await f.send("/v1/capabilities", undefined, first.token)).status).toBe(401);
    expect((await f.send("/v1/capabilities", undefined, second.token)).status).toBe(200);
    expect(new CoreAppAccess(f.db, f.repo).authenticate(`Bearer ${second.token}`).appId).toBe("test");
  });
  it("requires the configured operator and actual loopback socket to provision", async () => {
    const f = fixture(); const body = { appId: "test", actors: [PERSON], job: "human-answer", attribution: "app-attributed" };
    for (const peer of [null, "192.0.2.1"]) expect((await f.send("/v1/credentials", body, "operator", peer)).status).toBe(403);
    const token = (await (await f.provision()).json()).token;
    expect((await f.send("/v1/credentials", body, token)).status).toBe(401);
    expect((await f.send("/v1/credentials", body, null)).status).toBe(401);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM core_app_credentials").get()).toEqual({ n: 1 });
  });
  it("rejects unknown people, generic human, agents, malformed scopes and independent assurance", async () => {
    const f = fixture();
    for (const actor of ["human@host", "builder@test", "missing@external"]) expect((await f.provision([actor])).status).toBe(422);
    expect((await f.provision([PERSON, PERSON])).status).toBe(422);
    expect((await f.send("/v1/credentials", { appId: "test", actors: [PERSON], job: "human-answer", attribution: "independently-authenticated" })).status).toBe(422);
    expect((await f.send("/v1/credentials", { appId: "test", actors: [PERSON], job: "send", attribution: "app-attributed" })).status).toBe(422);
    expect((await f.send("/v2/capabilities")).status).toBe(404);
    expect(await (await f.send("/v2/capabilities")).json()).toMatchObject({ error: "unsupported_contract_version", supportedVersions: [1] });
  });
});

