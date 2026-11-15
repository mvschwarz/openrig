// `POST /api/queue/:id/tags`: a person's app or an agent adds a tag to a row it already has, in any state. The row keeps
// its tags, state, claim and closure; its history names who added which tags; a replay writes nothing.
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
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { i3IdentityProvenanceSchema } from "../src/db/migrations/067_i3_identity_provenance.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { belongsToProject } from "../src/domain/workspace/project-catalog.js";
import { queueRoutes } from "../src/routes/queue.js";
import { trackJsonBodyParseErrors } from "../src/middleware/json-body-error.js";

describe("adding a tag to an existing queue row", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema,
      outboxEntriesSchema, queueTargetRepoSchema, i3IdentityProvenanceSchema]);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus);
    app = new Hono();
    app.use("*", trackJsonBodyParseErrors); // as the daemon installs it (server.ts)
    app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("queueRepo" as never, repo); await next(); });
    app.route("/api/queue", queueRoutes());
  });
  afterEach(() => db.close());

  const row = (tags = ["mission:release-0.7.17"]) => repo.create({ sourceSession: "desk@rig", destinationSession: "builder@rig", body: "Work", tags, nudge: false });
  const addTags = (qitemId: string, add: unknown, session: string | null = "studio@rig") => app.request(`/api/queue/${qitemId}/tags`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(session ? { "X-OpenRig-Session": session } : {}) }, body: JSON.stringify({ add }),
  });
  const history = (qitemId: string) => repo.transitionLog.listForQitem(qitemId);

  it("adds a tag to a pending row and to a closed row, names who added it, and leaves each row's state as it was", async () => {
    const pending = await row();
    const closed = await row();
    repo.claim({ qitemId: closed.qitemId, destinationSession: "builder@rig" });
    repo.update({ qitemId: closed.qitemId, actorSession: "builder@rig", state: "done", closureReason: "no-follow-on", transitionNote: "done" });
    for (const [item, state] of [[pending, "pending"], [closed, "done"]] as const) {
      const before = history(item.qitemId).length;
      const res = await addTags(item.qitemId, ["ref:LPX-0142"]);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ qitemId: item.qitemId, state, added: ["ref:LPX-0142"], tags: ["mission:release-0.7.17", "ref:LPX-0142"] });
      const after = history(item.qitemId);
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)).toMatchObject({ state, actorSession: "studio@rig", transitionNote: 'tags added: ["ref:LPX-0142"]', closureReason: null });
    }
    expect(repo.getById(closed.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("writes nothing on a replay, and adds only the new tags of a partly new set, in order", async () => {
    const item = await row();
    await addTags(item.qitemId, ["ref:LPX-0142"]);
    const count = history(item.qitemId).length;
    const replay = await (await addTags(item.qitemId, ["ref:LPX-0142"])).json();
    expect(replay.added).toEqual([]);
    expect(history(item.qitemId)).toHaveLength(count);
    expect(repo.getById(item.qitemId)?.tags).toEqual(["mission:release-0.7.17", "ref:LPX-0142"]);
    const more = await (await addTags(item.qitemId, ["pr-3279", "ref:LPX-0142", "pr-3279", "project:openrig"])).json();
    expect(more.added).toEqual(["pr-3279", "project:openrig"]);
    expect(repo.getById(item.qitemId)?.tags).toEqual(["mission:release-0.7.17", "ref:LPX-0142", "pr-3279", "project:openrig"]);
    expect(history(item.qitemId).at(-1)?.transitionNote).toBe('tags added: ["pr-3279","project:openrig"]');
  });

  it("records one tag holding a comma apart from two tags", async () => {
    const one = await row();
    const two = await row();
    await addTags(one.qitemId, ["ref:a, pr-9"]);
    await addTags(two.qitemId, ["ref:a", "pr-9"]);
    expect(history(one.qitemId).at(-1)?.transitionNote).toBe('tags added: ["ref:a, pr-9"]');
    expect(history(two.qitemId).at(-1)?.transitionNote).toBe('tags added: ["ref:a","pr-9"]');
    expect(repo.getById(one.qitemId)?.tags).toEqual(["mission:release-0.7.17", "ref:a, pr-9"]);
  });

  it("keeps a claimed row's claim as it is", async () => {
    const item = await row();
    const claimed = repo.claim({ qitemId: item.qitemId, destinationSession: "builder@rig" });
    const res = await addTags(item.qitemId, ["pr-3279"]);
    expect(res.status).toBe(200);
    expect((await res.json()).added).toEqual(["pr-3279"]);
    expect(repo.getById(item.qitemId)).toMatchObject({ state: "in-progress", destinationSession: "builder@rig", claimedAt: claimed.claimedAt });
  });

  it("gives a row an added project tag the same membership a create-time tag gives it", async () => {
    const late = await row([]);
    const early = await row(["project:demo"]);
    const other = await row([]);
    expect(belongsToProject(db.prepare("SELECT tags FROM queue_items WHERE qitem_id = ?").pluck().get(late.qitemId) as string, "demo")).toBe(false);
    await addTags(late.qitemId, ["project:demo"]);
    for (const item of [late, early]) {
      expect(belongsToProject(db.prepare("SELECT tags FROM queue_items WHERE qitem_id = ?").pluck().get(item.qitemId) as string, "demo")).toBe(true);
    }
    expect(repo.list({ tag: "project:demo" }).map((r) => r.qitemId).sort()).toEqual([late.qitemId, early.qitemId].sort());
    expect(repo.list({ tag: "project:demo" }).map((r) => r.qitemId)).not.toContain(other.qitemId);
  });

  it("asks for at least one non-blank tag (a null body included), names a row it can't find, and writes nothing either way", async () => {
    const item = await row();
    const count = history(item.qitemId).length;
    for (const add of [[], [" "], "pr-1", undefined]) {
      const res = await addTags(item.qitemId, add);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("tags_required");
    }
    const nullBody = await app.request(`/api/queue/${item.qitemId}/tags`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "studio@rig" }, body: "null" });
    expect(nullBody.status).toBe(400);
    expect((await nullBody.json()).error).toBe("tags_required");
    const missing = await addTags("qitem-nowhere", ["pr-1"]);
    expect(missing.status).toBe(404);
    expect(history(item.qitemId)).toHaveLength(count);
    expect(repo.getById(item.qitemId)?.tags).toEqual(["mission:release-0.7.17"]);
  });
});
