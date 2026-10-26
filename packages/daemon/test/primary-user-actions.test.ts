// Primary-user actions: the person at the terminal acts on anyone's ask, and the record says both who acted and who was
// asked. A registered person without that authority can't settle another person's ask. Real SQLite (all migrations),
// people registered in a temporary home, and the real Mission Control route and write contract, called with no seat
// header, as the TUI calls it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { addHumanFragment } from "../src/domain/gateway/human-registry.js";
import { setDefaultPerson, setSharedChannel } from "../src/domain/gateway/participants.js";

const ASKER = "writer@rig";

describe("the primary user acts on anyone's ask, recorded as themselves on that person's ask", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;
  let app: Hono;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "primary-user-actions-"));
    vi.stubEnv("OPENRIG_HOME", home);
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); c.set("eventBus" as never, bus as never); c.set("missionControlWriteContract" as never, contract as never); await next(); });
    app.route("/api/mission-control", missionControlRoutes());
  });
  afterEach(() => { vi.unstubAllEnvs(); db.close(); rmSync(home, { recursive: true, force: true }); });

  const register = (...ids: string[]) => {
    for (const entityId of ids) expect(addHumanFragment({
      entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
      connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: `vault://slack/${entityId}`, role: "primary", handle: `U${entityId.toUpperCase()}` }],
      prefs: { deliveryClass: "B" },
    }, home)).toMatchObject({ ok: true });
  };
  const ask = (to: string, extra: Record<string, unknown> = {}) => repo.create({ sourceSession: ASKER, destinationSession: to, body: "Ship the draft?",
    summary: "Ship the draft?", humanIntent: "decision", evidenceRef: "/fixture/ask", nudge: false, ...extra } as never);
  async function act(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    const response = await app.request("/api/mission-control/action", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  const lastTransition = (qitemId: string) => db.prepare("SELECT state, actor_session, transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC LIMIT 1")
    .get(qitemId) as { state: string; actor_session: string; transition_note: string };
  const audit = (qitemId: string) => {
    const row = db.prepare("SELECT action_verb, actor_session, audit_notes_json FROM mission_control_actions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { action_verb: string; actor_session: string; audit_notes_json: string | null };
    return { verb: row.action_verb, actor: row.actor_session, notes: row.audit_notes_json ? JSON.parse(row.audit_notes_json) : null };
  };

  it("answers Sarah's ask in the primary user's words: Mike answered, on Sarah's ask, and the asker reads exactly that", async () => {
    register("mike", "sarah"); expect(setDefaultPerson("mike", home).ok).toBe(true);
    const sarahs = await ask("sarah@external");
    // The TUI claims the actor it shows; the daemon records the primary user whatever the claim.
    const result = await act({ verb: "answer", qitemId: sarahs.qitemId, actorSession: "sarah@external", authority: "primary-user", decision: "Ship it" });
    expect(result.status).toBe(200);
    expect(repo.getById(sarahs.qitemId)?.state).toBe("done");
    expect(lastTransition(sarahs.qitemId)).toMatchObject({ state: "done", actor_session: "mike@external" });
    expect(lastTransition(sarahs.qitemId).transition_note).toContain("mike@external, the primary user at the terminal, on sarah@external's ask; not answered by sarah@external");
    expect(audit(sarahs.qitemId)).toEqual({ verb: "answer", actor: "mike@external", notes: { authority: "primary-user", asked: "sarah@external" } });
    const reply = repo.list({ limit: 50 }).find((item) => item.replyTo === sarahs.qitemId)!;
    expect(reply).toMatchObject({ sourceSession: "mike@external", destinationSession: ASKER, summary: "mike@external answered sarah@external's ask: Ship the draft?" });
    expect(reply.body).toContain("Answered by mike@external, the primary user at the terminal, on sarah@external's ask in OpenRig.");
  });

  it("records a choice on a question ask the same way", async () => {
    register("mike", "sarah"); expect(setDefaultPerson("mike", home).ok).toBe(true);
    const sarahs = await ask("sarah@external", { humanQuestions: [{ id: "go", question: "Ship?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }] });
    const result = await act({ verb: "answer", qitemId: sarahs.qitemId, actorSession: "mike@external", authority: "primary-user", questionId: "go", optionId: "yes" });
    expect(result.status).toBe(200);
    expect(repo.getById(sarahs.qitemId)).toMatchObject({ state: "done", humanAnswers: { go: "yes" } });
    expect(audit(sarahs.qitemId).notes).toEqual({ authority: "primary-user", asked: "sarah@external" });
    expect(repo.list({ limit: 50 }).find((item) => item.replyTo === sarahs.qitemId)?.sourceSession).toBe("mike@external");
  });

  it("approves Sarah's pending ask and resolves a row parked on her, recorded as Mike on her ask", async () => {
    register("mike", "sarah"); expect(setDefaultPerson("mike", home).ok).toBe(true);
    const pending = await ask("sarah@external");
    expect((await act({ verb: "approve", qitemId: pending.qitemId, actorSession: "mike@external", authority: "primary-user" })).status).toBe(200);
    expect(lastTransition(pending.qitemId)).toMatchObject({ state: "done", actor_session: "mike@external" });
    expect(lastTransition(pending.qitemId).transition_note).toBe("mission-control:approve; by mike@external, the primary user at the terminal, on sarah@external's ask");
    expect(audit(pending.qitemId)).toEqual({ verb: "approve", actor: "mike@external", notes: { authority: "primary-user", asked: "sarah@external" } });

    const work = await repo.create({ sourceSession: ASKER, destinationSession: "designer@rig", body: "Layout", summary: "Layout", evidenceRef: "/fixture/layout", nudge: false });
    await repo.update({ qitemId: work.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: "sarah@external" } as never);
    expect((await act({ verb: "resolve", qitemId: work.qitemId, actorSession: "mike@external", authority: "primary-user", decision: "Use the wide layout" })).status).toBe(200);
    expect(lastTransition(work.qitemId)).toMatchObject({ state: "in-progress", actor_session: "mike@external",
      transition_note: "Use the wide layout; by mike@external, the primary user at the terminal, on sarah@external's ask" });
    expect(audit(work.qitemId).notes).toEqual({ authority: "primary-user", asked: "sarah@external" });
  });

  it("resolves a row parked on a registered person's address, which the Feed lists, and only with the authority", async () => {
    register("mike", "sarah"); expect(setDefaultPerson("mike", home).ok).toBe(true);
    const work = await repo.create({ sourceSession: ASKER, destinationSession: "designer@rig", body: "Layout", summary: "Layout", evidenceRef: "/fixture/layout", nudge: false });
    await repo.update({ qitemId: work.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: "sarah@external" } as never);
    expect(await act({ verb: "resolve", qitemId: work.qitemId, actorSession: "mike@external", decision: "Wide" })).toMatchObject({ status: 400, body: { error: "answer_not_recorded" } });
    expect((await act({ verb: "resolve", qitemId: work.qitemId, actorSession: "mike@external", authority: "primary-user", decision: "Wide" })).status).toBe(200);
    expect(lastTransition(work.qitemId)).toMatchObject({ state: "in-progress", actor_session: "mike@external",
      transition_note: "Wide; by mike@external, the primary user at the terminal, on sarah@external's ask" });
  });

  it("resolves a typed gate as the primary user with the gate's own note: no person was asked", async () => {
    register("mike", "sarah"); expect(setDefaultPerson("mike", home).ok).toBe(true);
    const work = await repo.create({ sourceSession: ASKER, destinationSession: "designer@rig", body: "QA", summary: "QA", evidenceRef: "/fixture/qa", nudge: false });
    await repo.update({ qitemId: work.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: "external:qa-pass" } as never);
    expect((await act({ verb: "resolve", qitemId: work.qitemId, actorSession: "sarah@external", authority: "primary-user", decision: "QA passed" })).status).toBe(200);
    const transition = repo.transitionLog.listForQitem(work.qitemId).find((t) => t.transitionNote?.includes("QA passed"));
    expect(transition).toMatchObject({ state: "in-progress", actorSession: "mike@external", transitionNote: "Blocker external:qa-pass resolved: QA passed" });
    expect(transition!.ownerNotificationKind).not.toBe("human-decision-resolved");
    expect(audit(work.qitemId)).toEqual({ verb: "resolve", actor: "mike@external", notes: { authority: "primary-user", asked: null } });
  });

  it("approves a row parked on Sarah as the primary user, recorded on her ask", async () => {
    register("mike", "sarah"); expect(setDefaultPerson("mike", home).ok).toBe(true);
    const work = await repo.create({ sourceSession: ASKER, destinationSession: "designer@rig", body: "Layout", summary: "Layout", evidenceRef: "/fixture/layout", nudge: false });
    await repo.update({ qitemId: work.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: "sarah@external" } as never);
    expect((await act({ verb: "approve", qitemId: work.qitemId, actorSession: "mike@external", authority: "primary-user" })).status).toBe(200);
    expect(audit(work.qitemId)).toEqual({ verb: "approve", actor: "mike@external", notes: { authority: "primary-user", asked: "sarah@external" } });
    expect(lastTransition(work.qitemId).transition_note).toBe("mission-control:approve; by mike@external, the primary user at the terminal, on sarah@external's ask");
  });

  it("with several people and no default, the primary user is unnamed and recorded as the generic human seat", async () => {
    register("mike", "sarah");
    const sarahs = await ask("sarah@external");
    expect((await act({ verb: "approve", qitemId: sarahs.qitemId, actorSession: "sarah@external", authority: "primary-user" })).status).toBe(200);
    expect(audit(sarahs.qitemId)).toEqual({ verb: "approve", actor: "human@host", notes: { authority: "primary-user", asked: "sarah@external" } });
  });

  it("a registered person without that authority can't settle another person's ask, pending or parked", async () => {
    // A legacy seat address is a registered person's when its whole local part is their id.
    register("mike", "sarah", "human-ana");
    const pending = await ask("sarah@external");
    for (const body of [{ verb: "approve" }, { verb: "deny", reason: "no" }, { verb: "answer", decision: "Ship it" }]) {
      const refused = await act({ qitemId: pending.qitemId, actorSession: "mike@external", ...body });
      expect(refused).toMatchObject({ status: 400, body: { error: "answer_not_recorded" } });
    }
    expect(repo.getById(pending.qitemId)?.state).toBe("pending");

    // A row parked on a person, whoever owns it: resolve, approve and deny are all refused.
    // The refusal names the person by their registered address, however the park spells it.
    for (const [parkedOn, person] of [["human-ana@host", "human-ana@external"], ["sarah@external", "sarah@external"]]) {
      const work = await repo.create({ sourceSession: ASKER, destinationSession: "designer@rig", body: "Layout", summary: "Layout", evidenceRef: "/fixture/layout", nudge: false });
      await repo.update({ qitemId: work.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: parkedOn } as never);
      for (const body of [{ verb: "resolve", decision: "Wide" }, { verb: "approve" }, { verb: "deny", reason: "no" }]) {
        expect(await act({ qitemId: work.qitemId, actorSession: "mike@external", ...body }), `${body.verb} on a park on ${parkedOn}`)
          .toMatchObject({ status: 400, body: { error: "answer_not_recorded", asked: person } });
      }
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "blocked", blockedOn: parkedOn });
    }
    // Sarah settles her own.
    expect((await act({ verb: "approve", qitemId: pending.qitemId, actorSession: "sarah@external" })).status).toBe(200);
    expect(audit(pending.qitemId)).toEqual({ verb: "approve", actor: "sarah@external", notes: null });
  });

  it("a seat's own transport identity is never replaced by the authority", async () => {
    register("mike", "sarah"); expect(setDefaultPerson("mike", home).ok).toBe(true);
    const sarahs = await ask("sarah@external");
    expect((await act({ verb: "approve", qitemId: sarahs.qitemId, actorSession: "mike@external", authority: "primary-user" }, { "X-OpenRig-Session": "orch@rig" })).status).toBe(200);
    expect(audit(sarahs.qitemId)).toEqual({ verb: "approve", actor: "orch@rig", notes: null });
  });

  it("with no one registered, acts are recorded as the claimed actor, as before", async () => {
    const legacy = await ask("human@host");
    expect((await act({ verb: "answer", qitemId: legacy.qitemId, actorSession: "human@host", authority: "primary-user", decision: "Yes" })).status).toBe(200);
    expect(audit(legacy.qitemId)).toEqual({ verb: "answer", actor: "human@host", notes: { authority: "primary-user", asked: "human@host" } });
    expect(repo.list({ limit: 50 }).find((item) => item.replyTo === legacy.qitemId)?.summary).toBe("human@host answered: Ship the draft?");
  });

  describe("a shared channel, with no one registered, never acts and never answers", () => {
    const CHANNEL = "acme-customers@external";
    const addChannel = () => expect(setSharedChannel("acme-customers", { displayName: "Acme customers", policy: "Customers of Acme.",
      channel: { connector: "slack", connectorRef: "primary", secretsRef: "vault://slack/bot", channelId: "CACME" } }, {}, home).ok).toBe(true);
    const parkedOnChannel = async () => {
      const work = await repo.create({ sourceSession: ASKER, destinationSession: "designer@rig", body: "Plan", summary: "Plan", evidenceRef: "/fixture/plan", nudge: false });
      await repo.update({ qitemId: work.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: CHANNEL } as never);
      return work;
    };

    it("the terminal's answer is the decision, as the person at the terminal, and a customer's earlier message isn't an answer", async () => {
      addChannel();
      const channels = await ask(CHANNEL, { summary: "Which plan?", body: "Which plan?" });
      // A customer already wrote "Pro" in the ask's thread: correspondence from the channel, as the inbound path records it.
      const customer = await repo.create({ qitemId: "qitem-slack-inbound-customer-pro", sourceSession: CHANNEL, destinationSession: ASKER,
        body: "Pro", summary: "Pro", inboundReplyTo: channels.qitemId, nudge: false } as never);
      expect(repo.getHumanAnswer(channels.qitemId, CHANNEL, { primaryUser: true })).toBeNull();
      // The TUI claims the actor the Feed serves, the channel; the person at the terminal answers "Basic".
      const result = await act({ verb: "answer", qitemId: channels.qitemId, actorSession: CHANNEL, authority: "primary-user", decision: "Basic" });
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).not.toContain("Already answered");
      expect(repo.getById(channels.qitemId)?.state).toBe("done");
      expect(lastTransition(channels.qitemId)).toMatchObject({ state: "done", actor_session: "human@host" });
      expect(audit(channels.qitemId)).toEqual({ verb: "answer", actor: "human@host", notes: { authority: "primary-user", asked: CHANNEL } });
      const reply = repo.list({ limit: 50 }).find((item) => item.replyTo === channels.qitemId && item.qitemId !== customer.qitemId)!;
      expect(reply).toMatchObject({ sourceSession: "human@host", destinationSession: ASKER });
      expect(reply.body.startsWith("Basic")).toBe(true);
      expect(repo.getById(customer.qitemId)).toMatchObject({ state: "pending", body: "Pro", sourceSession: CHANNEL });
    });

    it("approves the channel's ask and resolves a row parked on it from the terminal, recorded as the person at the terminal", async () => {
      addChannel();
      const channels = await ask(CHANNEL);
      expect((await act({ verb: "approve", qitemId: channels.qitemId, actorSession: CHANNEL, authority: "primary-user" })).status).toBe(200);
      expect(lastTransition(channels.qitemId)).toMatchObject({ state: "done", actor_session: "human@host",
        transition_note: `mission-control:approve; by human@host, the primary user at the terminal, on ${CHANNEL}'s ask` });
      expect(audit(channels.qitemId)).toEqual({ verb: "approve", actor: "human@host", notes: { authority: "primary-user", asked: CHANNEL } });

      const work = await parkedOnChannel();
      expect((await act({ verb: "resolve", qitemId: work.qitemId, actorSession: CHANNEL, authority: "primary-user", decision: "Use the plan" })).status).toBe(200);
      expect(lastTransition(work.qitemId)).toMatchObject({ state: "in-progress", actor_session: "human@host",
        transition_note: `Use the plan; by human@host, the primary user at the terminal, on ${CHANNEL}'s ask` });
    });

    it("without the authority, acting as the channel is refused and nothing changes", async () => {
      addChannel();
      const channels = await ask(CHANNEL);
      for (const body of [{ verb: "answer", decision: "Basic" }, { verb: "approve" }, { verb: "deny", reason: "no" }]) {
        expect(await act({ qitemId: channels.qitemId, actorSession: CHANNEL, ...body }), body.verb)
          .toMatchObject({ status: 400, body: { error: "answer_not_recorded", channel: CHANNEL } });
      }
      expect(repo.getById(channels.qitemId)?.state).toBe("pending");
      expect(repo.list({ limit: 50 }).some((item) => item.replyTo === channels.qitemId)).toBe(false);
      const work = await parkedOnChannel();
      expect(await act({ verb: "resolve", qitemId: work.qitemId, actorSession: CHANNEL, decision: "Use the plan" }))
        .toMatchObject({ status: 400, body: { error: "answer_not_recorded", channel: CHANNEL } });
      expect(repo.getById(work.qitemId)).toMatchObject({ state: "blocked", blockedOn: CHANNEL });
    });

    it("without the authority, a channel can't drop, hold, route or hand off a row either; with it, the person at the terminal acts", async () => {
      addChannel();
      for (const body of [{ verb: "drop", reason: "spam" }, { verb: "hold", reason: "later" }, { verb: "route", destinationSession: "support@rig" },
        { verb: "handoff", destinationSession: "support@rig" }]) {
        const row = await ask(CHANNEL);
        expect(await act({ qitemId: row.qitemId, actorSession: CHANNEL, ...body }), body.verb)
          .toMatchObject({ status: 400, body: { error: "answer_not_recorded", channel: CHANNEL } });
        expect(repo.getById(row.qitemId)?.state, body.verb).toBe("pending");
      }
      const dropped = await ask(CHANNEL);
      expect((await act({ verb: "drop", qitemId: dropped.qitemId, actorSession: CHANNEL, authority: "primary-user", reason: "spam" })).status).toBe(200);
      expect(audit(dropped.qitemId)).toMatchObject({ verb: "drop", actor: "human@host" });
    });

    it("annotate follows the same rule: refused as the channel without the authority, the person at the terminal with it", async () => {
      addChannel();
      const row = await ask(CHANNEL);
      expect(await act({ verb: "annotate", qitemId: row.qitemId, actorSession: CHANNEL, annotation: "The customer called" }))
        .toMatchObject({ status: 400, body: { error: "answer_not_recorded", channel: CHANNEL } });
      expect(db.prepare("SELECT count(*) AS n FROM mission_control_actions WHERE qitem_id = ?").get(row.qitemId)).toEqual({ n: 0 });
      expect((await act({ verb: "annotate", qitemId: row.qitemId, actorSession: CHANNEL, authority: "primary-user", annotation: "The customer called" })).status).toBe(200);
      expect(audit(row.qitemId)).toEqual({ verb: "annotate", actor: "human@host", notes: { authority: "primary-user", asked: null } });
    });

    it("leaves the legacy human seat as it was when a channel is registered", async () => {
      addChannel();
      const legacy = await ask("human@host");
      expect((await act({ verb: "answer", qitemId: legacy.qitemId, actorSession: "human@host", authority: "primary-user", decision: "Yes" })).status).toBe(200);
      expect(audit(legacy.qitemId)).toEqual({ verb: "answer", actor: "human@host", notes: { authority: "primary-user", asked: "human@host" } });
    });
  });
});
