import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";

describe("RECENT queue transition projection", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let app: Hono;
  let nextTransitionId: number;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, rigArchiveSchema]);
    repo = new QueueRepository(db, new EventBus(db));
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("queueRepo" as never, repo);
      await next();
    });
    app.route("/api/queue", queueRoutes());
    nextTransitionId = 1;
  });

  afterEach(() => db.close());

  function item(id: string, rig: string, state: string, tags: string[] = [], extra: { handedOffFrom?: string } = {}): void {
    db.prepare(`INSERT INTO queue_items (
      qitem_id, ts_created, ts_updated, source_session, destination_session,
      state, priority, tags, handed_off_from, body
    ) VALUES (?, ?, ?, ?, ?, ?, 'routine', ?, ?, 'body text must never classify an event')`).run(
      id,
      "2026-09-03T20:00:00.000Z",
      "2026-09-03T20:00:00.000Z",
      `sender@${rig}`,
      `owner@${rig}`,
      state,
      JSON.stringify(tags),
      extra.handedOffFrom ?? null,
    );
  }

  function transition(
    qitemId: string,
    state: string,
    opts: { note?: string; reason?: string; target?: string; actor?: string } = {},
  ): void {
    const id = nextTransitionId++;
    db.prepare(`INSERT INTO queue_transitions (
      transition_id, qitem_id, ts, state, transition_note, actor_session, closure_reason, closure_target
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      qitemId,
      `2026-09-03T20:${String(id).padStart(2, "0")}:00.000Z`,
      state,
      opts.note ?? null,
      opts.actor ?? "dev-qa@rig-a",
      opts.reason ?? null,
      opts.target ?? null,
    );
  }

  it("normalizes only the typed allowlist, stays current-rig scoped, de-duplicates handoff, and orders newest last", async () => {
    item("q-claim", "rig-a", "in-progress", ["mission:release-0.5.9", "slice:OPR.0.5.9.11"]);
    transition("q-claim", "pending", { note: "created" });
    transition("q-claim", "in-progress", { note: "words are irrelevant" });
    transition("q-claim", "in-progress", { note: "claimed founder ruling CLEAR" });

    item("q-block", "rig-a", "in-progress");
    transition("q-block", "pending");
    transition("q-block", "blocked", { reason: "blocked_on", target: "q-upstream" });
    transition("q-block", "blocked", { note: "watchdog chatter says completed" });
    transition("q-block", "in-progress", { note: "free-form note says denied" });

    item("q-handoff", "rig-a", "handed-off");
    transition("q-handoff", "pending");
    transition("q-handoff", "in-progress");
    transition("q-handoff", "handed-off", { reason: "handed_off_to", target: "review-r2@rig-a" });
    item("q-successor", "rig-a", "pending", [], { handedOffFrom: "q-handoff" });
    transition("q-successor", "pending", { note: "handoff from q-handoff" });

    item("q-done", "rig-a", "done");
    transition("q-done", "pending");
    transition("q-done", "in-progress");
    transition("q-done", "done", { reason: "no-follow-on" });

    item("q-denied", "rig-a", "denied");
    transition("q-denied", "pending");
    transition("q-denied", "denied", { reason: "denied" });

    item("q-failed", "rig-a", "failed");
    transition("q-failed", "pending");
    transition("q-failed", "failed");

    item("q-canceled", "rig-a", "canceled");
    transition("q-canceled", "pending");
    transition("q-canceled", "canceled", { reason: "canceled" });

    item("q-escalation", "rig-a", "handed-off");
    transition("q-escalation", "pending");
    transition("q-escalation", "handed-off", { reason: "escalation", target: "human@kernel" });

    item("q-other", "rig-b", "in-progress");
    transition("q-other", "pending", { actor: "elsewhere@rig-b" });
    transition("q-other", "in-progress", { actor: "elsewhere@rig-b" });

    const rows = repo.listRecentTransitions("rig-a", 20);
    expect(rows.map((row) => row.change)).toEqual([
      "claimed",
      "blocked on q-upstream",
      "resumed",
      "claimed",
      "handed off to review-r2@rig-a",
      "claimed",
      "completed",
      "denied",
      "failed",
      "canceled",
      "escalation",
    ]);
    expect(rows.filter((row) => row.change.startsWith("handed off"))).toHaveLength(1);
    expect(rows.every((row) => row.rig === "rig-a")).toBe(true);
    expect(rows.every((row) => row.actorSession !== "elsewhere@rig-b")).toBe(true);
    expect(rows[0]).toMatchObject({ qitemId: "q-claim", targetKind: "slice", target: "OPR.0.5.9.11" });
    expect(rows.map((row) => row.transitionId)).toEqual([...rows.map((row) => row.transitionId)].sort((a, b) => a - b));

    const response = await app.request("/api/queue/recent-transitions?rig=rig-a&limit=20");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(rows);
  });

  it("returns only the newest 20 qualifying transitions and refuses an unscoped read", async () => {
    for (let index = 0; index < 24; index += 1) {
      const id = `q-${String(index).padStart(2, "0")}`;
      item(id, "rig-a", "in-progress");
      transition(id, "pending");
      transition(id, "in-progress");
    }

    const rows = repo.listRecentTransitions("rig-a", 999);
    expect(rows).toHaveLength(20);
    expect(rows[0]?.qitemId).toBe("q-04");
    expect(rows.at(-1)?.qitemId).toBe("q-23");

    const response = await app.request("/api/queue/recent-transitions");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "rig_required" });
  });

  it("serves one bounded instance chronology across active local rigs", async () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?), (?, ?)")
      .run("r-a", "rig-a", "r-b", "rig-b");
    db.prepare("INSERT INTO rigs (id, name, archived_at) VALUES (?, ?, ?)")
      .run("r-archived", "rig-archived", "2026-09-03T23:59:00.000Z");
    item("q-a", "rig-a", "in-progress", ["mission:m-a"]);
    transition("q-a", "pending", { actor: "sender@rig-a" });
    transition("q-a", "in-progress", { actor: "owner@rig-a" });
    item("q-b", "rig-b", "done", ["slice:OPR.0.5.9.12"]);
    transition("q-b", "pending", { actor: "sender@rig-b" });
    transition("q-b", "in-progress", { actor: "owner@rig-b" });
    transition("q-b", "done", { actor: "owner@rig-b", reason: "no-follow-on" });
    item("q-foreign", "rig-c", "in-progress");
    transition("q-foreign", "pending", { actor: "sender@rig-c" });
    transition("q-foreign", "in-progress", { actor: "owner@rig-c" });
    item("q-archived", "rig-archived", "in-progress");
    transition("q-archived", "pending", { actor: "sender@rig-archived" });
    transition("q-archived", "in-progress", { actor: "owner@rig-archived" });

    const response = await app.request("/api/queue/recent-transitions?scope=instance&limit=20");
    expect(response.status).toBe(200);
    const rows = await response.json() as Array<{ qitemId: string; rig: string; change: string }>;
    expect(rows).toEqual([
      expect.objectContaining({ qitemId: "q-a", rig: "rig-a", change: "claimed" }),
      expect.objectContaining({ qitemId: "q-b", rig: "rig-b", change: "claimed" }),
      expect.objectContaining({ qitemId: "q-b", rig: "rig-b", change: "completed" }),
    ]);
  });
});
