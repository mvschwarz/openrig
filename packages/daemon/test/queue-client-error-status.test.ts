// Refusals the caller can fix (wake options on a non-park update, closure
// fields on a transition that cannot store them) were answered 500 because the route's
// error map did not know their codes. They are client errors: 400 with the named code.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { i3IdentityProvenanceSchema } from "../src/db/migrations/067_i3_identity_provenance.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { queueRoutes } from "../src/routes/queue.js";

describe("queue update refusals that are client errors answer 400", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let app: Hono;
  let qitemId: string;

  beforeEach(async () => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema, queueTransitionsSchema,
      watchdogJobsSchema, inboxEntriesSchema, outboxEntriesSchema, queueTargetRepoSchema, i3IdentityProvenanceSchema,
    ]);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus);
    const outbox = new OutboxHandler(db);
    repo.attachOutbox(outbox);
    const inbox = new InboxHandler(db, bus, repo);
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, bus);
      c.set("queueRepo" as never, repo);
      c.set("inboxHandler" as never, inbox);
      c.set("outboxHandler" as never, outbox);
      await next();
    });
    app.route("/api/queue", queueRoutes());
    const item = await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "work", nudge: false });
    qitemId = item.qitemId;
    repo.claim({ qitemId, destinationSession: "b@r" });
  });

  afterEach(() => db.close());

  const update = (body: Record<string, unknown>) => app.request(`/api/queue/${qitemId}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
    body: JSON.stringify(body),
  });

  const cases: Array<[string, Record<string, unknown>]> = [
    ["wake_not_admitted", { state: "done", closureReason: "no-follow-on", wakeAfterSeconds: 60 }],
    ["wake_ambiguous", { state: "blocked", blockedOn: "gate-x", wakeWatchdogId: "wd-1", wakeAfterSeconds: 60 }],
    ["wake_after_invalid", { state: "blocked", blockedOn: "gate-x", wakeAfterSeconds: 0 }],
    ["blocked_on_not_admitted", { state: "done", closureReason: "no-follow-on", blockedOn: "gate-x" }],
    ["closure_fields_not_admitted", { state: "in-progress", closureReason: "no-follow-on" }],
  ];

  it.each(cases)("%s", async (code, body) => {
    const res = await update(body);
    const payload = await res.json();
    expect(payload.error).toBe(code);
    expect(res.status, JSON.stringify(payload)).toBe(400);
  });
});
