import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildQueueTransfer } from "../src/domain/queue-transfer-export.js";
import { AUTHORIZATION_KIND } from "../src/domain/queue-transfer-records.js";
import { QueueTransferStaging } from "../src/domain/queue-transfer-staging.js";
import { queueTransferRoutes } from "../src/routes/queue-transfer.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

function instance(hostId: string, bearerToken: string | null, beforeTransferSchema = false) {
  const db = new Database(":memory:");
  databases.push(db);
  migrate(db, beforeTransferSchema ? ALL_MIGRATIONS.slice(0, -1) : ALL_MIGRATIONS);
  db.prepare("INSERT INTO self_host_identity VALUES (1, ?, 'minted', 'minted')").run(hostId);
  const repo = new QueueRepository(db, new EventBus(db));
  const app = new Hono().route("/api/queue-transfer", queueTransferRoutes({ db, repo, bearerToken }));
  return { db, repo, request: (path: string, init?: RequestInit) => app.request(`/api/queue-transfer/${path}`, init) };
}

function post(body: unknown, auth?: string): RequestInit {
  return { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) } };
}

it.each(["relinquish", "activate", "reconcile", "replay"])("gates %s before processing the body", async verb => {
  const { request } = instance("source", "test-token");
  expect((await request(verb, post({}))).status).toBe(401);
  const refusal = await request(verb, post({}, "test-token"));
  expect(refusal.status).toBe(400);
  expect(await refusal.json()).toMatchObject({ error: "invalid_body" });
});

it("refuses a pre-transfer schema while allowing ungated reads", async () => {
  const { request } = instance("source", "test-token", true);
  const refusal = await request("status");
  expect(refusal.status).toBe(400);
  expect(await refusal.json()).toMatchObject({ error: "schema_unsupported" });
});

it("reports a missing stage without exposing archive bytes", async () => {
  const { request } = instance("dest", null);
  const refusal = await request("staging/missing");
  expect(refusal.status).toBe(404);
  expect(await refusal.json()).toMatchObject({ error: "import_not_found" });
});

it("fences, activates, retries and reconciles across two isolated route instances", async () => {
  const source = instance("source", null);
  const dest = instance("target", "dest-token");
  source.db.exec(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
    VALUES ('qitem-a', '1', '1', 'a@origin', 'b@origin', 'blocked', 'work');`);
  const { archive: archiveText } = buildQueueTransfer(source.db, { kind: "host" });
  const staged = new QueueTransferStaging(dest.db).import(archiveText).stage;
  if (!staged) throw new Error("Expected a staged import");
  const { importId, digest, origin } = staged;
  expect(await (await dest.request(`staging/${importId}`)).json()).toEqual({ stage: staged, destinationHostId: "target" });
  const authorization = { kind: AUTHORIZATION_KIND, operationId: "op", archiveDigest: digest, origin,
    destination: { hostId: "target", authorizedAt: "then", seatMapping: [] },
    intervention: { kind: "online-handshake", actor: "operator", recordedAt: "then", limits: "" } };
  const relinquish = await source.request("relinquish", post({ archiveText, authorization, intervention: "stopped work", actor: "operator" }));
  expect(relinquish.status).toBe(200);
  const { receipt } = await relinquish.json();
  const status = await source.request(`status?archiveDigest=${digest}`);
  expect(await status.json()).toMatchObject({ transfers: [{ restriction: "scoped", fenced: ["qitem-a"] }] });
  const activation = { importId, authorization, receipt, actor: "operator" };
  const activated = await dest.request("activate", post(activation, "dest-token"));
  expect(activated.status).toBe(200);
  const result = await activated.json();
  expect(result).toMatchObject({ status: "activated", replayed: false, rows: { blocked: [{ qitemId: "qitem-a" }] } });
  expect(await (await dest.request("activate", post(activation, "dest-token"))).json()).toEqual({ ...result, replayed: true });
  const reconciled = await source.request("reconcile", post({ archiveText, result, actor: "operator" }));
  expect(reconciled.status).toBe(200);
  expect(await reconciled.json()).toMatchObject({ evacuation: "complete", rows: [{ qitemId: "qitem-a", outcome: "superseded" }] });
  expect(await (await source.request(`status?archiveDigest=${digest}`)).json()).toMatchObject({ evacuation: "complete" });
});
