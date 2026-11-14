// 51-06 D2, narrowed — summary/evidence_ref given with a state change are STORED and the transition applies:
// optional metadata never holds finished work at pending. A blank summary is the one value not stored (it would
// erase the row's subject); the route reports it, so a caller never believes it was saved.
// Migration-faithful: the canonical queue set PLUS 044 (summary) + 048 (evidence_ref).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";

function buildApp(bus: EventBus, queueRepo: QueueRepository): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("queueRepo" as never, queueRepo); await next(); });
  app.route("/api/queue", queueRoutes());
  return app;
}

describe("51-06 D2 narrowed — queue update metadata on a state change", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema, outboxEntriesSchema, queueTargetRepoSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    app = buildApp(bus, repo);
  });
  afterEach(() => db.close());

  const mkItem = async () => (await repo.create({ sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "d2 item" })).qitemId;
  const txnCount = (id: string) => (db.prepare("SELECT count(*) c FROM queue_transitions WHERE qitem_id = ?").get(id) as { c: number }).c;
  const setSummary = (id: string, summary: string) => db.prepare("UPDATE queue_items SET summary = ? WHERE qitem_id = ?").run(summary, id);
  const setEvidence = (id: string, ref: string) => db.prepare("UPDATE queue_items SET evidence_ref = ? WHERE qitem_id = ?").run(ref, id);
  const post = (path: string, body: Record<string, unknown>, session: string) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": session }, body: JSON.stringify(body),
  });

  it.each([
    ["summary", { summary: "KEEP" }, { summary: "KEEP", evidenceRef: null }],
    ["evidence_ref", { evidenceRef: "/proof/x.md" }, { summary: null, evidenceRef: "/proof/x.md" }],
    ["both", { summary: "S", evidenceRef: "/e" }, { summary: "S", evidenceRef: "/e" }],
  ])("a state change carrying %s applies and stores it, with one transition", async (_label, input, stored) => {
    const id = await mkItem();
    const res = repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress", ...input });
    expect(res).toMatchObject({ state: "in-progress", ...stored });
    expect(repo.getByIdOrThrow(id)).toMatchObject({ state: "in-progress", ...stored });
    expect(txnCount(id)).toBe(2);
  });

  it("a finished seat's park on another row stores its summary and evidence, and the event carries the summary", async () => {
    const id = await mkItem();
    const blocker = await mkItem();
    repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress" });
    const events: Array<Record<string, unknown>> = [];
    bus.subscribe((e) => events.push(e as unknown as Record<string, unknown>));
    const res = repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "blocked", blockedOn: blocker, summary: "Relayed; waiting on the reply", evidenceRef: "/proof/relay.md" });
    expect(res).toMatchObject({ state: "blocked", blockedOn: blocker, summary: "Relayed; waiting on the reply", evidenceRef: "/proof/relay.md" });
    expect(events.find((e) => e.type === "queue.updated")).toMatchObject({ toState: "blocked", summary: "Relayed; waiting on the reply" });
  });

  it.each(["done", "canceled"] as const)("a %s close stores summary and evidence_ref on the closed row", async (state) => {
    const id = await mkItem();
    repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress" });
    const close = state === "done" ? { closureReason: "no-follow-on" } : {};
    const res = repo.update({ qitemId: id, actorSession: "dev-x@rig", state, ...close, summary: "Finished", evidenceRef: "/proof/result.md" });
    expect(res).toMatchObject({ state, summary: "Finished", evidenceRef: "/proof/result.md" });
    const shown = await app.request(`/api/queue/${id}`);
    expect(shown.status).toBe(200);
    expect(await shown.json()).toMatchObject({ state, summary: "Finished", evidenceRef: "/proof/result.md" });
  });

  it.each(["", "   "])("a blank summary (%j) isn't stored: the state still changes and the row keeps its subject", async (blank) => {
    const id = await mkItem();
    setSummary(id, "Original subject");
    const res = repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress", summary: blank, evidenceRef: "/e" });
    expect(res).toMatchObject({ state: "in-progress", summary: "Original subject", evidenceRef: "/e" });
  });

  it("metadata-free update is UNCHANGED (null = absent)", async () => {
    const id = await mkItem();
    const res = repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress", summary: null, evidenceRef: null });
    expect(res).toMatchObject({ state: "in-progress", summary: null, evidenceRef: null });
  });

  it("CONTROL: human-seat park still PERSISTS summary + evidence byte-for-byte", async () => {
    const id = await mkItem();
    const res = repo.update({ qitemId: id, actorSession: "orch@rig", state: "blocked", blockedOn: "human@kernel", summary: "PARK-KEEP", evidenceRef: "/proof/park.md" });
    expect(res.summary).toBe("PARK-KEEP");
    expect(res.evidenceRef).toBe("/proof/park.md");
  });

  it.each(["sarah@external", "sarah@host"])("a park on registered person %s persists summary + evidence like a human-seat park", async (blockedOn) => {
    const person = { entityId: "sarah", class: "human" as const, displayName: "Sarah", address: "sarah@external",
      connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "USARAH" }],
      prefs: { deliveryClass: "A" as const } };
    const people = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [person] }) });
    const id = await mkItem();
    const res = people.update({ qitemId: id, actorSession: "orch@rig", state: "blocked", blockedOn, summary: "Which layout?", evidenceRef: "/proof/layout.md" });
    expect(res).toMatchObject({ state: "blocked", blockedOn, summary: "Which layout?", evidenceRef: "/proof/layout.md" });
    // The legacy human-seat requirement isn't extended: a park on the person without them still parks.
    const bare = await mkItem();
    expect(people.update({ qitemId: bare, actorSession: "orch@rig", state: "blocked", blockedOn })).toMatchObject({ state: "blocked", summary: null });
  });

  it.each(["", "   "])("a blank summary and evidence ref (%j) on a park on a registered person aren't stored: the row keeps its own", async (blank) => {
    const person = { entityId: "sarah", class: "human" as const, displayName: "Sarah", address: "sarah@external", connectorBindings: [],
      prefs: { deliveryClass: "A" as const } };
    const people = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [person] }) });
    const id = await mkItem();
    setSummary(id, "Which layout?"); setEvidence(id, "/proof/layout.md");
    expect(people.update({ qitemId: id, actorSession: "orch@rig", state: "blocked", blockedOn: "sarah@external", summary: blank, evidenceRef: blank }))
      .toMatchObject({ state: "blocked", blockedOn: "sarah@external", summary: "Which layout?", evidenceRef: "/proof/layout.md" });
  });

  it("a legacy human-seat park given a blank summary and evidence ref parks on the row's own, instead of refusing", async () => {
    const id = await mkItem();
    setSummary(id, "PARK-KEEP"); setEvidence(id, "/proof/park.md");
    expect(repo.update({ qitemId: id, actorSession: "orch@rig", state: "blocked", blockedOn: "human@kernel", summary: "  ", evidenceRef: "  " }))
      .toMatchObject({ state: "blocked", summary: "PARK-KEEP", evidenceRef: "/proof/park.md" });
  });

  it("ROUTE: a blank summary on a park on a person -> 200, parked, and the advisory names the summary as not stored", async () => {
    const id = await mkItem();
    setSummary(id, "Original subject"); setEvidence(id, "/proof/kept.md");
    const res = await post(`/api/queue/${id}/update`, { actorSession: "orch@rig", state: "blocked", blockedOn: "human@kernel", summary: "  " }, "orch@rig");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; summary: string | null; advisories?: unknown };
    expect(body).toMatchObject({ state: "blocked", summary: "Original subject" });
    expect(body.advisories).toEqual([expect.objectContaining({ code: "summary_not_stored", field: "summary" })]);
  });

  it("a park on an unregistered name on another daemon's domain stores its summary too", async () => {
    const nobody = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    const id = await mkItem();
    expect(nobody.update({ qitemId: id, actorSession: "orch@rig", state: "blocked", blockedOn: "sarah@host", summary: "S" }))
      .toMatchObject({ state: "blocked", blockedOn: "sarah@host", summary: "S" });
  });

  it("ROUTE: POST /:id/update with a state change + summary -> 200, stored, no advisory", async () => {
    const created = await post("/api/queue/create", { sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "r" }, "orch@rig");
    const id = ((await created.json()) as { qitemId: string }).qitemId;
    const res = await post(`/api/queue/${id}/update`, { actorSession: "dev-x@rig", state: "in-progress", summary: "KEEP" }, "dev-x@rig");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; summary: string | null; advisories?: unknown };
    expect(body).toMatchObject({ state: "in-progress", summary: "KEEP" });
    expect(body.advisories).toBeUndefined();
  });

  it("ROUTE: a blank summary with a state change -> 200, state applied, and an advisory names the summary as not stored", async () => {
    const created = await post("/api/queue/create", { sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "r", summary: "Original subject" }, "orch@rig");
    const id = ((await created.json()) as { qitemId: string }).qitemId;
    const res = await post(`/api/queue/${id}/update`, { actorSession: "dev-x@rig", state: "in-progress", summary: "" }, "dev-x@rig");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; summary: string | null; advisories?: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ state: "in-progress", summary: "Original subject" });
    expect(body.advisories).toEqual([{
      code: "summary_not_stored", qitemId: id, field: "summary",
      message: `The summary was blank, so it wasn't stored: ${id} keeps its summary "Original subject". The rest of the update was applied.`,
    }]);
  });

  it("a stored evidence pointer survives a blank one on a state change, and a done close keeps it too", async () => {
    const id = (await repo.create({ sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "d2 item", evidenceRef: "/proof/kept.md" })).qitemId;
    expect(repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress", evidenceRef: "" })).toMatchObject({ state: "in-progress", evidenceRef: "/proof/kept.md" });
    expect(repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "done", closureReason: "no-follow-on", evidenceRef: "   " }))
      .toMatchObject({ state: "done", evidenceRef: "/proof/kept.md" });
  });

  it("ROUTE: a blank evidence ref with a state change -> 200, the pointer kept, and an advisory names it as not stored", async () => {
    const created = await post("/api/queue/create", { sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "r", evidenceRef: "/proof/kept.md" }, "orch@rig");
    const id = ((await created.json()) as { qitemId: string }).qitemId;
    const res = await post(`/api/queue/${id}/update`, { actorSession: "dev-x@rig", state: "in-progress", evidenceRef: "  " }, "dev-x@rig");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; evidenceRef: string | null; advisories?: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ state: "in-progress", evidenceRef: "/proof/kept.md" });
    expect(body.advisories).toEqual([{
      code: "evidence_ref_not_stored", qitemId: id, field: "evidenceRef",
      message: `The evidence ref was blank, so it wasn't stored: ${id} keeps its evidence ref "/proof/kept.md". The rest of the update was applied.`,
    }]);
  });

  it("ROUTE: when the repository can't write either field, the state still changes, the caller is told, and the event agrees with the stored row", async () => {
    const created = await post("/api/queue/create", { sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "r", summary: "Original subject" }, "orch@rig");
    const id = ((await created.json()) as { qitemId: string }).qitemId;
    // A column probe that read false at construction (its PRAGMA read failed), while the columns exist.
    Object.assign(repo as unknown as Record<string, boolean>, { hasSummaryColumn: false, hasEvidenceRefColumn: false });
    const events: Array<Record<string, unknown>> = [];
    bus.subscribe((e) => events.push(e as unknown as Record<string, unknown>));
    const res = await post(`/api/queue/${id}/update`, { actorSession: "dev-x@rig", state: "in-progress", summary: "New subject", evidenceRef: "/proof/new.md" }, "dev-x@rig");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; summary: string | null; evidenceRef: string | null; advisories?: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ state: "in-progress", summary: "Original subject", evidenceRef: null });
    expect(body.advisories).toEqual([
      { code: "summary_not_stored", qitemId: id, field: "summary",
        message: `The summary wasn't stored: ${id} keeps its summary "Original subject". The rest of the update was applied.` },
      { code: "evidence_ref_not_stored", qitemId: id, field: "evidenceRef",
        message: `The evidence ref wasn't stored: ${id} keeps no evidence ref. The rest of the update was applied.` },
    ]);
    expect(events.find((e) => e.type === "queue.updated")).toMatchObject({ toState: "in-progress", summary: "Original subject" });
    expect(repo.getByIdOrThrow(id)).toMatchObject({ state: "in-progress", summary: "Original subject", evidenceRef: null });
  });
});
