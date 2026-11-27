// #3944: a person dismisses an open informational update from the Feed. Real SQLite (all migrations), the real attention
// and Mission Control routes and write contract, called with no seat header, as the TUI calls them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { attentionRoutes } from "../src/routes/attention.js";
import type { AttentionRead } from "../src/attention-surface.js";

const PERSON = "parkingmeter@external";

describe("dismissing an informational update from the Feed", () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    const repo = new QueueRepository(db, bus, { validateRig: () => true });
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); c.set("eventBus" as never, bus as never); c.set("missionControlWriteContract" as never, contract as never); await next(); });
    app.route("/api/attention", attentionRoutes());
    app.route("/api/mission-control", missionControlRoutes());
  });
  afterEach(() => { db.close(); });

  const row = (id: string, intent: "update" | "decision" = "update") => db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body,summary,human_intent) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, "2026-11-20T12:00:00Z", "2026-11-20T12:00:00Z", "writer@rig", PERSON, "pending", "routine", "Body for " + id, "Summary " + id, intent);
  const read = async (id?: string) => await (await app.request("/api/attention" + (id ? "?item=" + encodeURIComponent(id) : ""))).json() as AttentionRead;
  const act = async (body: Record<string, unknown>) => {
    const response = await app.request("/api/mission-control/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const state = (id: string) => db.prepare("SELECT state, closure_reason FROM queue_items WHERE qitem_id = ?").get(id) as { state: string; closure_reason: string | null };
  const audits = (id: string) => db.prepare("SELECT action_verb, actor_session, audit_notes_json FROM mission_control_actions WHERE qitem_id = ?").all(id) as Array<{ action_verb: string; actor_session: string; audit_notes_json: string | null }>;

  it("offers Dismiss on an open update, closes it as the terminal's act, and keeps it inspectable", async () => {
    row("fyi");
    const before = db.serialize();
    const opened = await read("queue-update:fyi");
    // Opening stays passive.
    expect(db.serialize()).toEqual(before);
    expect(opened.detail?.item).toMatchObject({ id: "queue-update:fyi", dismiss: { actorSession: PERSON } });

    const result = await act({ verb: "dismiss", qitemId: "fyi", actorSession: PERSON, authority: "primary-user" });
    expect(result.status).toBe(200);
    expect(state("fyi")).toEqual({ state: "done", closure_reason: "no-follow-on" });
    expect(audits("fyi").map(a => ({ verb: a.action_verb, actor: a.actor_session, notes: JSON.parse(a.audit_notes_json ?? "null") })))
      .toEqual([{ verb: "dismiss", actor: "human@host", notes: { authority: "primary-user", asked: PERSON } }]);
    expect(db.prepare("SELECT actor_session, transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC LIMIT 1").get("fyi"))
      .toEqual({ actor_session: "human@host", transition_note: `mission-control:dismiss; by someone at the terminal OpenRig can't name (human@host), unattributed, on ${PERSON}'s update` });

    // Out of the open list, still readable by id with its body and history, and no second Dismiss.
    expect((await read()).items.some(i => i.id === "queue-update:fyi")).toBe(false);
    const closed = await read("queue-update:fyi");
    expect(closed.detail?.item.dismiss).toBeUndefined();
    expect(closed.detail?.lines).toEqual(expect.arrayContaining(["Body for fyi", "State: done"]));
    expect(closed.detail?.lines.some(l => l.includes("mission-control:dismiss"))).toBe(true);
  });

  it("a repeat dismiss reports the actual state and writes nothing", async () => {
    row("fyi");
    expect((await act({ verb: "dismiss", qitemId: "fyi", actorSession: PERSON, authority: "primary-user" })).status).toBe(200);
    const after = db.serialize();
    const again = await act({ verb: "dismiss", qitemId: "fyi", actorSession: PERSON, authority: "primary-user" });
    expect(again).toMatchObject({ status: 409, body: { error: "qitem_already_terminal", state: "done" } });
    expect(db.serialize()).toEqual(after);
  });

  it.each(["failed", "denied", "canceled"])("never dismisses a %s update: it's already closed, and nothing is written", async (closed) => {
    row("fyi");
    db.prepare("UPDATE queue_items SET state = ? WHERE qitem_id = ?").run(closed, "fyi");
    const before = db.serialize();
    expect(await act({ verb: "dismiss", qitemId: "fyi", actorSession: PERSON, authority: "primary-user" }))
      .toMatchObject({ status: 409, body: { error: "qitem_already_terminal", state: closed } });
    expect(db.serialize()).toEqual(before);
  });

  it("records a dismissed update as its recipient's, even while it's parked on another person", async () => {
    row("parked");
    db.prepare("UPDATE queue_items SET state = 'blocked', blocked_on = ? WHERE qitem_id = ?").run("reviewer@external", "parked");
    expect((await act({ verb: "dismiss", qitemId: "parked", actorSession: PERSON, authority: "primary-user" })).status).toBe(200);
    expect(audits("parked").map(a => JSON.parse(a.audit_notes_json ?? "null"))).toEqual([{ authority: "primary-user", asked: PERSON }]);
    expect(db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC LIMIT 1").get("parked"))
      .toEqual({ transition_note: `mission-control:dismiss; by someone at the terminal OpenRig can't name (human@host), unattributed, on ${PERSON}'s update` });
  });

  it("never dismisses a request: it's answered, not dismissed", async () => {
    row("ask", "decision");
    const before = db.serialize();
    expect((await read("queue:ask")).detail?.item.dismiss).toBeUndefined();
    expect(await act({ verb: "dismiss", qitemId: "ask", actorSession: PERSON, authority: "primary-user" }))
      .toMatchObject({ status: 409, body: { error: "not_an_update", state: "pending" } });
    expect(db.serialize()).toEqual(before);
  });
});
