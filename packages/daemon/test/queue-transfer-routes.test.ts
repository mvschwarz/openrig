import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { queueTransferActivationSchema } from "../src/db/migrations/191_queue_transfer_activation.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildQueueTransfer } from "../src/domain/queue-transfer-export.js";
import { AUTHORIZATION_KIND } from "../src/domain/queue-transfer-records.js";
import { QueueTransferStaging } from "../src/domain/queue-transfer-staging.js";
import { queueTransferRoutes } from "../src/routes/queue-transfer.js";

const databases: Database.Database[] = [];
afterEach(() => {
  databases.splice(0).forEach(db => db.close());
  vi.useRealTimers();
});

function instance(hostId: string, bearerToken: string | null, beforeTransferSchema = false) {
  const db = new Database(":memory:");
  databases.push(db);
  migrate(db, beforeTransferSchema ? ALL_MIGRATIONS.filter(migration => migration !== queueTransferActivationSchema) : ALL_MIGRATIONS);
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

it("shows late history on a retained fence without changing the exact reconciliation retry", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-02-03T04:05:06Z"));
  const source = instance("source", "source-token");
  const dest = instance("target", "dest-token");
  source.db.exec(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
    VALUES ('qitem-a', '1', '1', 'a@origin', 'person@external', 'blocked', 'work');`);
  const { archive: archiveText } = buildQueueTransfer(source.db, { kind: "host" });
  const staged = new QueueTransferStaging(dest.db).import(archiveText).stage;
  if (!staged) throw new Error("Expected a staged import");
  const { importId, digest, origin } = staged;
  expect(await (await dest.request(`staging/${importId}`)).json()).toEqual({ stage: staged, destinationHostId: "target" });
  const authorization = { kind: AUTHORIZATION_KIND, operationId: "op", archiveDigest: digest, origin,
    destination: { hostId: "target", authorizedAt: "then", seatMapping: [] },
    intervention: { kind: "online-handshake", actor: "operator", recordedAt: "then", limits: "" } };
  const relinquish = await source.request("relinquish", post({ archiveText, authorization, intervention: "stopped work", actor: "operator" }, "source-token"));
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
  const reconcileRequest = () => source.request("reconcile", post({ archiveText, result, actor: "operator" }, "source-token"));
  const reconciled = await reconcileRequest();
  expect(reconciled.status).toBe(200);
  const report = await reconciled.json();
  expect(report).toMatchObject({ evacuation: "complete", lateReports: [], rows: [{ qitemId: "qitem-a", outcome: "superseded" }] });
  const statusPath = `status?archiveDigest=${digest}`;
  const readStatus = () => source.request(statusPath, { headers: { authorization: "Bearer source-token" } });
  const cleanStatus = await (await readStatus()).json();
  expect(cleanStatus).toMatchObject({ evacuation: "complete" });
  expect(cleanStatus.transfers[0]).not.toHaveProperty("postReconciliationLateReports");

  const outbox = source.db.prepare("SELECT * FROM outbox_entries");
  const beforeOutbox = outbox.all();
  const fence = source.repo.transferFence("qitem-a");
  const answer = source.repo.writeRelayedAnswer({ qitemId: "qitem-a", actorSession: "a@origin", nudge: true,
    relay: { attributedTo: "person@external", channel: "phone", text: "Late answer for the new owner" } });
  expect(answer).toMatchObject({ historyOnly: true, replyQitemId: null });
  const late = source.repo.transitionLog.listForQitem("qitem-a").at(-1);
  expect(late?.transitionNote).toContain("Late answer for the new owner");

  expect(await (await source.request(statusPath)).json()).toEqual(cleanStatus);
  const fresh = await readStatus();
  expect(await fresh.json()).toMatchObject({ transfers: [{ fenced: ["qitem-a"], postReconciliationLateReports: [
    { qitemId: "qitem-a", currentState: "canceled", ownerItem: "qitem-a@target", transitions: [late] },
  ] }] });
  expect(await (await reconcileRequest()).json()).toEqual({ ...report, replayed: true });
  expect(source.repo.getById("qitem-a")).toMatchObject({ state: "canceled", closureReason: "superseded", closureTarget: "qitem-a@target" });
  expect(source.repo.transferFence("qitem-a")).toEqual(fence);
  expect(source.db.prepare("SELECT qitem_id FROM queue_items").pluck().all()).toEqual(["qitem-a"]);
  expect(outbox.all()).toEqual(beforeOutbox);
});
