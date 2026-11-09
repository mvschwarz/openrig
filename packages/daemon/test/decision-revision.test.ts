// #2446: an opt-in decision revision. A client reads the decision with its revision, and a settling act sent with that
// revision runs only on that decision. Real SQLite (all migrations), the real queue, the Mission Control route and write
// contract, and the queue's single-row read; the route-wiring cells stub the contract and the remote fetch. Nothing native.
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { queueRoutes } from "../src/routes/queue.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const PERSON = "human-test@external", OTHER = "human-other@external", ASKER = "requester@test-rig";
const person = (entityId: string, address: string) => ({ entityId, class: "human" as const, displayName: entityId, address,
  connectorBindings: [], prefs: { deliveryClass: "A" as const } });
const registry = { ok: true as const, entities: [person("human-test", PERSON), person("human-other", OTHER)] };
const QUESTIONS = [
  { id: "q1", question: "Ship it?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
  { id: "q2", question: "Tell the team?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
];
// The fields an existing action result has: a caller that sends no revision keeps exactly these.
const ANSWER_RESULT = ["actionId", "answer", "auditedAt", "closedQitem", "createdQitemId", "notifyAttempted", "notifyResult", "qitemId", "verb"];
const ACT_RESULT = ANSWER_RESULT.filter(key => key !== "answer");

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

function fixture() {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry,
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, repo as never); c.set("eventBus" as never, bus as never);
    c.set("missionControlWriteContract" as never, contract as never); await next();
  });
  app.route("/api/mission-control", missionControlRoutes());
  app.route("/api/queue", queueRoutes());
  closes.push(() => db.close());
  const ask = async () => (await repo.create({ sourceSession: ASKER, destinationSession: PERSON, body: "Synthetic two-question ask",
    summary: "Ship?", humanIntent: "decision", humanQuestions: QUESTIONS, nudge: false })).qitemId;
  const park = async (blockedOn = PERSON) => {
    const row = await repo.create({ sourceSession: ASKER, destinationSession: "owner@test-rig", body: "Work waiting on a person", nudge: false });
    repo.claim({ qitemId: row.qitemId, destinationSession: "owner@test-rig" });
    repo.update({ qitemId: row.qitemId, actorSession: "owner@test-rig", state: "blocked", blockedOn });
    return row.qitemId;
  };
  // A runner's permission request: the person's typed answer is recorded on the ask itself, with no reply row.
  const permissionAsk = async (opts: { question?: boolean } = {}) => {
    if (opts.question) {
      // The runner's own seat, at the generation the request names, so the ask isn't closed as stale.
      db.exec(`INSERT OR IGNORE INTO rigs(id,name) VALUES ('rig-1','test-rig'); INSERT OR IGNORE INTO nodes(id,rig_id,logical_id,runtime) VALUES ('node-1','rig-1','dev.runner','codex');
        INSERT OR IGNORE INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('t-1','node-1',1,'gen-1','fresh');`);
    }
    return (await repo.create({ sourceSession: ASKER, destinationSession: PERSON, body: "Allow the runner to write?",
      summary: "Allow?", humanIntent: "decision", tags: ["runner-permission", "permission-node:node-1", "permission-generation:gen-1"],
      ...(opts.question ? { humanQuestions: [{ id: "permission", question: "Allow?", options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }] }] } : {}),
      nudge: false })).qitemId;
  };
  const revision = async (id: string) => (await (await app.request(`/api/queue/${id}`)).json() as { decisionRevision?: unknown }).decisionRevision;
  const act = async (body: Record<string, unknown>) => {
    const actor = (body.actorSession as string | undefined) ?? PERSON;
    const response = await app.request("/api/mission-control/action", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": actor }, body: JSON.stringify({ actorSession: actor, ...body }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const count = (sql: string, id: string) => (db.prepare(sql).get(id) as { n: number }).n;
  const written = (id: string) => ({ row: repo.getById(id), transitions: repo.listTransitions(id).length,
    replies: count("SELECT count(*) n FROM queue_items WHERE reply_to = ?", id),
    actions: count("SELECT count(*) n FROM mission_control_actions WHERE qitem_id = ?", id) });
  return { db, repo, contract, ask, park, permissionAsk, revision, act, written };
}

describe("an opt-in decision revision on the settling verbs (#2446)", () => {
  it("an unchanged revision acts and returns the saved revision and state", async () => {
    const f = fixture(); const id = await f.ask();
    const read = await f.revision(id);
    expect(read).toEqual(expect.stringMatching(/\S/));
    const result = await f.act({ verb: "answer", qitemId: id, questionId: "q1", optionId: "yes", expectedRevision: read });
    expect(result).toMatchObject({ status: 200, body: { answer: { outcome: "recorded" }, closedQitem: { humanAnswers: { q1: "yes" } } } });
    expect(result.body.decisionRevision).toBe(await f.revision(id));
    expect(result.body.decisionRevision).not.toBe(read);
  });

  it.each([
    ["answer", "question text changed under the same ids"],
    ["approve", "another person recorded a partial answer"],
    ["deny", "question text changed under the same ids"],
    ["resolve", "re-parked on another person"],
  ] as const)("%s on a stale revision (%s) conflicts and writes nothing", async (verb, change) => {
    const f = fixture(); const id = verb === "resolve" ? await f.park() : await f.ask();
    const read = await f.revision(id);
    if (change === "question text changed under the same ids") {
      f.db.prepare("UPDATE queue_items SET human_questions = ? WHERE qitem_id = ?").run(JSON.stringify([{ ...QUESTIONS[0], question: "Ship it to everyone?" }, QUESTIONS[1]]), id);
    } else if (change === "another person recorded a partial answer") {
      expect(f.repo.recordHumanAnswer({ qitemId: id, actorSession: OTHER, questionId: "q1", optionId: "no" })).toMatchObject({ status: "recorded" });
    } else {
      f.db.prepare("UPDATE queue_items SET blocked_on = ? WHERE qitem_id = ?").run(OTHER, id);
    }
    const before = f.written(id);
    const result = await f.act({ verb, qitemId: id, expectedRevision: read,
      ...(verb === "answer" ? { questionId: "q2", optionId: "yes" } : verb === "resolve" ? { decision: "Go ahead" } : { reason: "reviewed" }) });
    expect(result).toMatchObject({ status: 409, body: { error: "decision_revision_changed", currentRevision: await f.revision(id) } });
    expect(f.written(id)).toEqual(before);
  });

  it("concurrent answers on one revision: one commits, the other conflicts with nothing of its own written", async () => {
    const f = fixture(); const id = await f.ask();
    const read = await f.revision(id);
    const results = await Promise.all(["q1", "q2"].map(questionId => f.act({ verb: "answer", qitemId: id, questionId, optionId: "yes", expectedRevision: read })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.find(r => r.status === 409)!.body.error).toBe("decision_revision_changed");
    expect(Object.keys(f.repo.getById(id)!.humanAnswers ?? {})).toHaveLength(1);
    expect(f.written(id)).toMatchObject({ actions: 1, replies: 0 });
  });

  it("concurrent typed answers to a runner's permission ask on one revision: one closes it, the other conflicts", async () => {
    const f = fixture(); const id = await f.permissionAsk();
    const read = await f.revision(id);
    const results = await Promise.all(["Allow it", "Deny it"].map(decision => f.act({ verb: "answer", qitemId: id, decision, expectedRevision: read })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.find(r => r.status === 409)!.body.error).toBe("decision_revision_changed");
    expect(f.written(id)).toMatchObject({ row: { state: "done" }, actions: 1 });
  });

  it("a choice on a runner's permission ask whose answers were already complete conflicts when a deny lands during its return", async () => {
    const f = fixture(); const id = await f.permissionAsk({ question: true });
    // An interrupted return: the complete set is recorded and the ask is still pending, so this choice writes nothing first.
    f.db.prepare("UPDATE queue_items SET human_answers = ? WHERE qitem_id = ?").run(JSON.stringify({ permission: "allow" }), id);
    const read = await f.revision(id);
    const original = f.repo.createHumanAnswer.bind(f.repo);
    vi.spyOn(f.repo, "createHumanAnswer").mockImplementationOnce(async input => {
      const returned = await original(input);
      expect(await f.act({ verb: "deny", qitemId: id, reason: "not now" })).toMatchObject({ status: 200 });
      return returned;
    });
    const result = await f.act({ verb: "answer", qitemId: id, questionId: "permission", optionId: "allow", expectedRevision: read });
    expect(result).toMatchObject({ status: 409, body: { error: "decision_revision_changed" } });
    expect(f.db.prepare("SELECT action_verb FROM mission_control_actions WHERE qitem_id = ?").all(id)).toEqual([{ action_verb: "deny" }]);
  });

  it("a choice on a runner's permission ask that records its answer closes it (the writing choice, compared before its write)", async () => {
    const f = fixture(); const id = await f.permissionAsk({ question: true });
    const read = await f.revision(id);
    expect(await f.act({ verb: "answer", qitemId: id, questionId: "permission", optionId: "allow", expectedRevision: read }))
      .toMatchObject({ status: 200, body: { answer: { outcome: "answered" }, closedQitem: { state: "done", humanAnswers: { permission: "allow" } } } });
  });

  it("a typed-gate park resolved and parked again on the same gate is a new decision; a note on a park isn't", async () => {
    const f = fixture(); const id = await f.park("external:qa-pass");
    const first = await f.revision(id);
    f.repo.update({ qitemId: id, actorSession: "owner@test-rig", state: "blocked", blockedOn: "external:qa-pass", transitionNote: "still waiting" });
    expect(await f.revision(id)).toBe(first);
    expect(await f.act({ verb: "resolve", qitemId: id, decision: "QA passed" })).toMatchObject({ status: 200 });
    f.repo.update({ qitemId: id, actorSession: "owner@test-rig", state: "blocked", blockedOn: "external:qa-pass" });
    expect(await f.act({ verb: "resolve", qitemId: id, decision: "QA passed", expectedRevision: first }))
      .toMatchObject({ status: 409, body: { error: "decision_revision_changed" } });
  });

  it("a caller that sends no revision acts exactly as before, with the same result fields", async () => {
    const f = fixture(); const answered = await f.ask(), approved = await f.ask();
    f.db.prepare("UPDATE queue_items SET human_questions = ? WHERE qitem_id IN (?, ?)").run(JSON.stringify([{ ...QUESTIONS[0], question: "Changed" }, QUESTIONS[1]]), answered, approved);
    const answer = await f.act({ verb: "answer", qitemId: answered, questionId: "q1", optionId: "yes" });
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual(ANSWER_RESULT);
    const approve = await f.act({ verb: "approve", qitemId: approved });
    expect(approve).toMatchObject({ status: 200, body: { closedQitem: { state: "done" } } });
    expect(Object.keys(approve.body).sort()).toEqual(ACT_RESULT);
  });

  it("a retry of the same committed operation is reconciled from the record; another verb or payload under its ID is not", async () => {
    const f = fixture(); const id = await f.ask();
    const read = await f.revision(id);
    const request = { verb: "approve", qitemId: id, reason: "reviewed", expectedRevision: read, auditNotes: { operationId: "op-1" } };
    const first = await f.act(request);
    expect(first).toMatchObject({ status: 200, body: { closedQitem: { state: "done" } } });
    const retry = await f.act(request);
    expect(retry).toMatchObject({ status: 200, body: { reconciled: true, actionId: first.body.actionId, decisionRevision: await f.revision(id) } });
    expect((await f.act({ ...request, verb: "deny" })).body.error).toBe("decision_revision_changed");
    expect((await f.act({ ...request, reason: "a different reason" })).body.error).toBe("decision_revision_changed");
    expect(f.written(id).actions).toBe(1);
  });

  it("a revision sent with a verb that doesn't settle a decision isn't checked: the act runs as today and says so", async () => {
    const f = fixture(); const id = await f.ask();
    expect(await f.act({ verb: "hold", qitemId: id, reason: "later", expectedRevision: "dr1-not-this-row" }))
      .toMatchObject({ status: 200, body: { closedQitem: { state: "blocked" }, revisionNote: expect.stringContaining("isn't checked for hold") } });
  });

  it("a summary, a wake or a claim leaves the revision alone", async () => {
    const f = fixture(); const id = await f.ask();
    const read = await f.revision(id);
    expect(read).toEqual(expect.stringMatching(/\S/));
    f.db.prepare("UPDATE queue_items SET summary = 'Ship? (relabelled)', ts_updated = '2099-01-01T00:00:00.000Z', last_nudge_attempt = '2099-01-01T00:00:00.000Z', last_nudge_result = 'delivered', state = 'in-progress', claimed_at = '2099-01-01T00:00:00.000Z' WHERE qitem_id = ?").run(id);
    expect(await f.revision(id)).toBe(read);
    expect(await f.act({ verb: "approve", qitemId: id, expectedRevision: read })).toMatchObject({ status: 200, body: { closedQitem: { state: "done" } } });
  });

  it("repairs a direct-answer partial commit on retry without duplicating the reply row, then reconciles subsequent retries", async () => {
    const f = fixture();
    const row = await f.repo.create({ sourceSession: ASKER, destinationSession: PERSON, body: "Ship the relay?", summary: "Ship?", humanIntent: "decision", nudge: false });
    const id = row.qitemId;
    const read = await f.revision(id);

    const original = f.repo.createHumanAnswer.bind(f.repo);
    vi.spyOn(f.repo, "createHumanAnswer").mockImplementationOnce(async input => {
      await original(input);
      throw new Error("simulated crash after answer row commit before audit");
    });

    await expect(
      f.contract.act({
        verb: "answer",
        qitemId: id,
        actorSession: PERSON,
        decision: "Ship it now",
        expectedRevision: read as string,
        auditNotes: { operationId: "relay-op-1" },
      }),
    ).rejects.toThrow("simulated crash after answer row commit before audit");

    expect(f.written(id)).toMatchObject({ replies: 1, actions: 0, row: { state: "pending" } });
    expect(await f.revision(id)).not.toBe(read);

    const retry = await f.act({
      verb: "answer",
      qitemId: id,
      decision: "Ship it now",
      expectedRevision: read,
      auditNotes: { operationId: "relay-op-1" },
    });
    expect(retry.status).toBe(200);
    expect(f.written(id)).toMatchObject({ replies: 1, actions: 1, row: { state: "done" } });

    const replyRow = f.db.prepare("SELECT tags FROM queue_items WHERE reply_to = ?").get(id) as { tags: string };
    const tags = JSON.parse(replyRow.tags) as string[];
    expect(tags.some(t => t.startsWith("mc-operation:"))).toBe(true);

    const third = await f.act({
      verb: "answer",
      qitemId: id,
      decision: "Ship it now",
      expectedRevision: read,
      auditNotes: { operationId: "relay-op-1" },
    });
    expect(third).toMatchObject({ status: 200, body: { reconciled: true } });
    expect(f.written(id)).toMatchObject({ replies: 1, actions: 1 });
  });

  it("recovers from a crash between ask close and audit record with one answer, one close transition, and one audit row", async () => {
    const f = fixture();
    const id = await f.ask();
    const read = await f.revision(id);

    // Fault injected at audit record time (after resolveDirectHumanReply inside the atomic close+audit transaction)
    const actionLog = (f.contract as unknown as { actionLog: MissionControlActionLog }).actionLog;
    const origRecord = actionLog.record.bind(actionLog);
    let stateAtAuditCall: string | undefined;
    vi.spyOn(actionLog, "record").mockImplementationOnce((entry) => {
      stateAtAuditCall = f.repo.getById(id)?.state;
      throw new Error("simulated crash after ask close before audit");
      return origRecord(entry);
    });

    await expect(
      f.contract.act({
        verb: "answer",
        qitemId: id,
        actorSession: PERSON,
        decision: "Ship Option A",
        expectedRevision: read as string,
        auditNotes: { operationId: "relay-close-audit-op-1" },
      }),
    ).rejects.toThrow("simulated crash after ask close before audit");

    expect(stateAtAuditCall).toBe("done");
    // Atomic rollback of close+audit leaves the ask pending with only the 1 tagged reply row
    expect(f.written(id)).toMatchObject({ replies: 1, actions: 0, row: { state: "pending" } });

    // Conflicting payload or different operationId under the original revision still rejects (409)
    expect(
      await f.act({
        verb: "answer",
        qitemId: id,
        decision: "Different words",
        expectedRevision: read,
        auditNotes: { operationId: "relay-close-audit-op-1" },
      }),
    ).toMatchObject({ status: 409, body: { error: "decision_revision_changed" } });

    const retry = await f.act({
      verb: "answer",
      qitemId: id,
      decision: "Ship Option A",
      expectedRevision: read,
      auditNotes: { operationId: "relay-close-audit-op-1" },
    });
    expect(retry.status).toBe(200);
    expect(f.written(id)).toMatchObject({ replies: 1, actions: 1, row: { state: "done" } });
    const resolvedTransitions = f.repo
      .listTransitions(id)
      .filter((t) => t.ownerNotificationKind === "human-decision-resolved");
    expect(resolvedTransitions).toHaveLength(1);
  });

  it("enforces guarded retry non-bypass invariants across different payloads, stale edits, and cross-responder attempts", async () => {
    const f = fixture();
    const row1 = await f.repo.create({ sourceSession: ASKER, destinationSession: PERSON, body: "Ship the relay?", summary: "Ship?", humanIntent: "decision", nudge: false });
    const id1 = row1.qitemId;
    const read1 = await f.revision(id1);

    const original = f.repo.createHumanAnswer.bind(f.repo);
    vi.spyOn(f.repo, "createHumanAnswer").mockImplementationOnce(async input => {
      await original(input);
      throw new Error("simulated crash after answer row commit before audit");
    });

    await expect(
      f.contract.act({
        verb: "answer",
        qitemId: id1,
        actorSession: PERSON,
        decision: "Yes",
        expectedRevision: read1 as string,
        auditNotes: { operationId: "relay-op-2" },
      }),
    ).rejects.toThrow("simulated crash after answer row commit before audit");

    expect(await f.act({ verb: "answer", qitemId: id1, decision: "Yes", expectedRevision: read1, auditNotes: { operationId: "relay-op-other" } }))
      .toMatchObject({ status: 409, body: { error: "decision_revision_changed" } });
    expect(await f.act({ verb: "answer", qitemId: id1, decision: "No", expectedRevision: read1, auditNotes: { operationId: "relay-op-2" } }))
      .toMatchObject({ status: 409, body: { error: "decision_revision_changed" } });
    expect(await f.act({ verb: "answer", qitemId: id1, decision: "Yes", expectedRevision: read1 }))
      .toMatchObject({ status: 409, body: { error: "decision_revision_changed" } });
    expect(await f.act({ verb: "answer", qitemId: id1, actorSession: OTHER, decision: "Yes", expectedRevision: read1, auditNotes: { operationId: "relay-op-2" } }))
      .toMatchObject({ status: 409, body: { error: "decision_revision_changed" } });

    // Stale edit during partial commit
    const row2 = await f.repo.create({ sourceSession: ASKER, destinationSession: PERSON, body: "Initial ask text", summary: "Ship?", humanIntent: "decision", nudge: false });
    const id2 = row2.qitemId;
    const read2 = await f.revision(id2);

    vi.spyOn(f.repo, "createHumanAnswer").mockImplementationOnce(async input => {
      await original(input);
      throw new Error("simulated crash after answer row commit before audit");
    });

    await expect(
      f.contract.act({
        verb: "answer",
        qitemId: id2,
        actorSession: PERSON,
        decision: "Proceed",
        expectedRevision: read2 as string,
        auditNotes: { operationId: "relay-op-3" },
      }),
    ).rejects.toThrow("simulated crash after answer row commit before audit");

    f.db.prepare("UPDATE queue_items SET body = 'Edited ask text' WHERE qitem_id = ?").run(id2);

    expect(await f.act({ verb: "answer", qitemId: id2, decision: "Proceed", expectedRevision: read2, auditNotes: { operationId: "relay-op-3" } }))
      .toMatchObject({ status: 409, body: { error: "decision_revision_changed" } });
  });

  it("keeps resolve operation fingerprint retry intact and rejects a new park episode under an old revision", async () => {
    const f = fixture();
    const id = await f.park();
    const read = await f.revision(id);

    const first = await f.act({ verb: "resolve", qitemId: id, decision: "Unblocked", expectedRevision: read, auditNotes: { operationId: "resolve-op-1" } });
    expect(first.status).toBe(200);

    const retry = await f.act({ verb: "resolve", qitemId: id, decision: "Unblocked", expectedRevision: read, auditNotes: { operationId: "resolve-op-1" } });
    expect(retry).toMatchObject({ status: 200, body: { reconciled: true } });

    f.repo.update({ qitemId: id, actorSession: "owner@test-rig", state: "blocked", blockedOn: PERSON });
    const staleNewEpisode = await f.act({ verb: "resolve", qitemId: id, decision: "Unblocked", expectedRevision: read, auditNotes: { operationId: "resolve-op-2" } });
    expect(staleNewEpisode).toMatchObject({ status: 409, body: { error: "decision_revision_changed" } });
  });
});

describe("the route carries a client's revision to the write that compares it (#2446)", () => {
  const REGISTRY: HostRegistry = { hosts: [{ id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "B" }] };
  function wiring() {
    const acts: Array<Record<string, unknown>> = [], forwarded: Array<Record<string, unknown>> = [];
    const app = new Hono();
    app.use("*", async (c, next) => {
      const set = c.set.bind(c) as (key: string, value: unknown) => void;
      set("missionControlWriteContract", { act: async (input: Record<string, unknown>) => { acts.push(input); return { actionId: "local-1" }; } });
      set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
      set("remoteFetchImpl", (async (_url: string, init: RequestInit) => {
        forwarded.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ actionId: "remote-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch);
      set("eventBus", { emit: () => {} });
      await next();
    });
    app.route("/api/mission-control", missionControlRoutes({ bearerToken: null }));
    const post = (body: Record<string, unknown>) => app.request("/api/mission-control/action", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": PERSON }, body: JSON.stringify({ actorSession: PERSON, ...body }) });
    return { acts, forwarded, post };
  }
  process.env["B"] = "remote-token";

  it("passes it to the local write contract", async () => {
    const w = wiring();
    expect((await w.post({ verb: "resolve", qitemId: "qitem-1", decision: "Go", expectedRevision: "rev-1" })).status).toBe(200);
    expect(w.acts[0]).toMatchObject({ expectedRevision: "rev-1" });
  });

  it("forwards it to the origin host, which compares it there", async () => {
    const w = wiring();
    expect((await w.post({ verb: "resolve", qitemId: "qitem-1", decision: "Go", expectedRevision: "rev-1", hostId: "vps-b" })).status).toBe(200);
    expect(w.acts).toEqual([]);
    expect(w.forwarded[0]).toMatchObject({ verb: "resolve", expectedRevision: "rev-1" });
  });
});
