import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { RunnerPermissions } from "../src/domain/runner-permissions.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { pruneEvents } from "../src/domain/queue-retention.js";
import { eraseQueue } from "../src/domain/queue-erasure.js";
import { CoreAppJob } from "../src/domain/core-app-job.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("provisions through the owner route's own no-bearer posture, and no app credential ever becomes the owner there", async () => {
    const f = fixture(null); const body = { appId: "test", actors: [PERSON], job: "human-answer", attribution: "app-attributed" };
    // With no owner bearer configured the owner gate passes everything; the permitted posture needs no peer evidence.
    const created = await f.send("/v1/credentials", body, null, null);
    expect(created.status).toBe(201); const issued = await created.json();
    const spoofed = [issued.token, `orapp_${"0".repeat(64)}`, "orapp_malformed", "ORAPP_upper"];
    for (const token of spoofed) {
      expect((await f.send("/v1/credentials", body, token, null)).status).toBe(401);
      expect((await f.send(`/v1/credentials/${issued.credentialId}`, undefined, token, null, "DELETE")).status).toBe(401);
    }
    expect(f.db.prepare("SELECT COUNT(*) AS n, COUNT(revoked_at) AS revoked FROM core_app_credentials").get()).toEqual({ n: 1, revoked: 0 });
    expect((await f.send(`/v1/credentials/${issued.credentialId}`, undefined, null, null, "DELETE")).status).toBe(200);
    // A revoked app credential is no more an owner than a live one.
    expect((await f.send("/v1/credentials", body, issued.token, null)).status).toBe(401);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM core_app_credentials").get()).toEqual({ n: 1 });
  });
});

const PERSON = "human-test@external", OTHER = "human-other@external";
const registry = { ok: true as const, entities: [PERSON, OTHER].map(address => ({ entityId: address.split("@")[0]!, class: "human" as const,
  displayName: address, address, connectorBindings: [], prefs: { deliveryClass: "A" as const } })) };
function fixture(operatorToken: string | null = "operator", permissionDecider?: () => { session: string } | null) {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); closes.push(() => db.close());
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry, ...(permissionDecider ? { permissionDecider } : {}),
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
  const access = new CoreAppAccess(db, repo);
  const log = new MissionControlActionLog(db), writes = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: log });
  const job = new CoreAppJob(access, repo, bus, writes, log);
  const app = new Hono(); app.route("/api/apps", coreAppRoutes({ access, operatorToken, job }));
  const send = (path: string, body?: unknown, token = operatorToken, peer: string | null = "127.0.0.1", method = body === undefined ? "GET" : "POST") => app.request(`/api/apps${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, peer ? { incoming: { socket: { remoteAddress: peer } } } : {});
  const provision = (actors = [PERSON], appId = "test") => send("/v1/credentials", { appId, actors, job: "human-answer", attribution: "app-attributed" });
  return { db, bus, repo, access, app, send, provision, job, writes, log };
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
  it("provisions for the configured owner from any peer, and refuses a missing, wrong or app bearer, with no fallback either way", async () => {
    const f = fixture(); const body = { appId: "test", actors: [PERSON], job: "human-answer", attribution: "app-attributed" };
    for (const peer of [null, "192.0.2.1", "127.0.0.1"]) expect((await f.send("/v1/credentials", body, "operator", peer)).status).toBe(201);
    const token = (await (await f.provision()).json()).token;
    for (const wrong of [null, "wrong", token, `orapp_${"0".repeat(64)}`]) {
      for (const peer of ["127.0.0.1", "192.0.2.1"]) expect((await f.send("/v1/credentials", body, wrong, peer)).status).toBe(401);
      expect((await f.send(`/v1/credentials/${randomUUID()}`, undefined, wrong, "127.0.0.1", "DELETE")).status).toBe(401);
    }
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM core_app_credentials").get()).toEqual({ n: 4 });
    // The owner bearer is no app credential: every other app path still needs one.
    for (const path of ["/v1/capabilities", `/v1/needs-me?actor=${encodeURIComponent(PERSON)}`]) expect((await f.send(path, undefined, "operator")).status).toBe(401);
    expect((await f.send("/v1/answers/answer_owner01", {}, "operator")).status).toBe(401);
  });
  it("keeps exact owner-token semantics for an opaque owner value that resembles an app token, and for an empty configured value", async () => {
    const lookalike = `orapp_${"a".repeat(64)}`, f = fixture(lookalike);
    expect((await f.provision()).status).toBe(201);
    expect((await f.send("/v1/capabilities", undefined, lookalike)).status).toBe(401); // a configured exact match is owner proof only
    const empty = fixture("");
    for (const token of [null, "", "x"]) expect((await empty.send("/v1/credentials", { appId: "test", actors: [PERSON], job: "human-answer", attribution: "app-attributed" }, token)).status).toBe(401);
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


const questions = [
  { id: "q1", question: "Ship it?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
  { id: "q2", question: "Tell the team?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
];
async function jobFixture(two = false) {
  const f = fixture(); const token = (await (await f.provision([PERSON, OTHER])).json()).token;
  const ask = await f.repo.create({ sourceSession: "builder@test", destinationSession: PERSON, body: "Synthetic decision", humanIntent: "decision", humanQuestions: two ? questions : [questions[0]!], nudge: false });
  const binding = (actor = PERSON, questionId = "q1", optionId = "yes") => ({ job: "human-answer", actor, requestId: ask.qitemId, questionId,
    episodeKey: null, expectedRevision: f.repo.decisionRevision(f.repo.getById(ask.qitemId)!), answer: { kind: "option", optionId } });
  return { ...f, token, ask, binding };
}
describe("see and answer as self", () => {
  it("discovers only supported asks and emits actor-scoped singular result links", async () => {
    const f = await jobFixture();
    await f.repo.create({ sourceSession: "builder@test", destinationSession: PERSON, body: "FYI", humanIntent: "update", nudge: false });
    const res = await f.send(`/v1/needs-me?actor=${encodeURIComponent(PERSON)}`, undefined, f.token);
    expect(res.status).toBe(200);
    const body = await res.json(); expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ requestId: f.ask.qitemId, actor: { address: PERSON, assurance: "app-attributed", appId: "test" }, episodeKey: null });
    expect(body.requests[0].links.result).toContain(`?actor=${encodeURIComponent(PERSON)}`);
  });
  it("binds stable answer identity, replays original receipt after intervening actions, attributes another allowed person as self", async () => {
    const f = await jobFixture(); const sent = f.binding(OTHER);
    const first = await f.send("/v1/answers/answer_0001", sent, f.token);
    expect(first.status).toBe(200); const receipt = await first.json();
    expect(receipt).toMatchObject({ actor: { address: OTHER, assurance: "app-attributed" }, submission: { state: "committed", outcome: "answered" }, replayed: false });
    expect(f.repo.getHumanAnswer(f.ask.qitemId, OTHER)?.sourceSession).toBe(OTHER);
    const originalRevision = receipt.submission.decisionRevisionAfter;
    f.db.prepare("UPDATE queue_items SET body = 'later changed body', evidence_ref = 'artifact:later' WHERE qitem_id = ?").run(f.ask.qitemId);
    const replay = await f.send("/v1/answers/answer_0001", sent, f.token);
    expect(await replay.json()).toMatchObject({ replayed: true, submission: { actionId: receipt.submission.actionId, decisionRevisionAfter: originalRevision } });
    expect((await f.send("/v1/answers/answer_0001", { ...sent, actor: PERSON }, f.token)).status).toBe(409);
    expect(f.db.prepare("SELECT COUNT(*) n FROM mission_control_actions WHERE qitem_id = ?").get(f.ask.qitemId)).toEqual({ n: 1 });
  });
  it("records a partial option and its receipt atomically, while a later answer cannot replace the original receipt", async () => {
    const f = await jobFixture(true); const first = f.binding();
    const observed: Array<{ type: string; inTransaction: boolean }> = [];
    closes.push(f.bus.subscribe(event => observed.push({ type: event.type, inTransaction: f.db.inTransaction })));
    const partial = await f.send("/v1/answers/answer_part1", first, f.token);
    expect(partial.status).toBe(200); const receipt = await partial.json();
    expect(receipt.submission).toMatchObject({ state: "committed", outcome: "recorded" });
    expect(observed).toEqual([{ type: "queue.answer_recorded", inTransaction: false }, { type: "mission_control.action_executed", inTransaction: false }]);
    for (let i = 0; i < 55; i++) await f.writes.act({ verb: "annotate", qitemId: f.ask.qitemId, actorSession: PERSON, annotation: `later note ${i}` });
    expect((await f.send("/v1/answers/answer_part2", f.binding(OTHER, "q2"), f.token)).status).toBe(200);
    f.db.prepare("UPDATE core_app_submissions SET receipt_json = NULL WHERE answer_id = ?").run("answer_part1"); // immutable audit evidence still owns the original result
    const beforeReplay = { seq: f.bus.maxSeq(), actions: f.log.countAll(), replies: f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.ask.qitemId) };
    expect(await (await f.send("/v1/answers/answer_part1", first, f.token)).json()).toMatchObject({ submission: receipt.submission, replayed: true });
    expect({ seq: f.bus.maxSeq(), actions: f.log.countAll(), replies: f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.ask.qitemId) }).toEqual(beforeReplay);
    const read = await f.send(`/v1/answers/answer_part1?actor=${encodeURIComponent(OTHER)}`, undefined, f.token);
    expect(read.status).toBe(404);
  });
});


describe("submission interruption and fencing", () => {
  it("rolls a partial choice and receipt back when audit append fails; retry commits exactly once", async () => {
    const f = await jobFixture(true), binding = f.binding();
    const observed: string[] = []; closes.push(f.bus.subscribe(event => observed.push(event.type)));
    const original = f.log.record.bind(f.log); vi.spyOn(f.log, "record").mockImplementationOnce(() => { throw new Error("fixture audit failure"); }).mockImplementation(original);
    const beforeSeq = f.bus.maxSeq();
    expect((await f.send("/v1/answers/answer_atomic", binding, f.token)).status).toBe(503);
    expect(f.repo.getById(f.ask.qitemId)?.humanAnswers ?? {}).toEqual({});
    expect(f.bus.maxSeq()).toBe(beforeSeq); expect(f.log.countAll()).toBe(0); expect(observed).toEqual([]);
    expect(f.db.prepare("SELECT receipt_json FROM core_app_submissions").get()).toEqual({ receipt_json: null });
    expect((await f.send("/v1/answers/answer_atomic", binding, f.token)).status).toBe(200);
    expect(f.log.countAll()).toBe(1);
    expect(observed).toEqual(["queue.answer_recorded", "mission_control.action_executed"]);
  });
  it("publishes a complete choice only after its checkpoint commits and retries without duplicate notifications", async () => {
    const f = await jobFixture(), binding = f.binding();
    const observed: Array<{ type: string; inTransaction: boolean }> = [];
    closes.push(f.bus.subscribe(event => observed.push({ type: event.type, inTransaction: f.db.inTransaction })));
    const prepare = f.db.prepare.bind(f.db); let failCheckpoint = true;
    vi.spyOn(f.db, "prepare").mockImplementation(sql => {
      if (failCheckpoint && sql.startsWith("UPDATE core_app_submissions SET checkpoint_json")) {
        failCheckpoint = false; throw new Error("fixture checkpoint failure");
      }
      return prepare(sql);
    });
    const seq = f.bus.maxSeq();
    expect((await f.send("/v1/answers/answer_complete_atomic", binding, f.token)).status).toBe(503);
    expect(f.repo.getById(f.ask.qitemId)?.humanAnswers ?? {}).toEqual({});
    expect(f.bus.maxSeq()).toBe(seq); expect(f.log.countAll()).toBe(0); expect(observed).toEqual([]);
    const checkpoint = f.db.prepare("SELECT checkpoint_json,receipt_json FROM core_app_submissions").get() as { checkpoint_json: string; receipt_json: string | null };
    expect(JSON.parse(checkpoint.checkpoint_json).before.humanAnswers ?? {}).toEqual({}); expect(checkpoint.receipt_json).toBeNull();
    expect((await f.send("/v1/answers/answer_complete_atomic", binding, f.token)).status).toBe(200);
    expect(observed.filter(event => event.type === "queue.answer_recorded")).toEqual([{ type: "queue.answer_recorded", inTransaction: false }]);
    const committed = { seq: f.bus.maxSeq(), actions: f.log.countAll(), notifications: observed.length };
    expect(await (await f.send("/v1/answers/answer_complete_atomic", binding, f.token)).json()).toMatchObject({ replayed: true });
    expect({ seq: f.bus.maxSeq(), actions: f.log.countAll(), notifications: observed.length }).toEqual(committed);
  });
  it.each(["typed-reply", "option"].flatMap(kind => ["pending", "closed", "evidence-changed"].map(state => [kind, state])))("recovers a %s return after restart and annotations with %s evidence, including uncheckpointed own reply", async (kind, state) => {
    const f = await jobFixture(), binding = { ...f.binding(), answer: kind === "option" ? { kind, optionId: "yes" } : { kind, text: "Original words" } };
    const resolve = f.repo.resolveDirectHumanReply.bind(f.repo);
    vi.spyOn(f.repo, "resolveDirectHumanReply").mockImplementationOnce(() => { throw new Error("fixture crash before close"); }).mockImplementation(resolve);
    expect((await f.send("/v1/answers/answer_recover", binding, f.token)).status).toBe(503);
    expect(f.repo.getById(f.ask.qitemId)?.state).toBe("pending");
    expect(f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.ask.qitemId)).toEqual({ n: 1 });
    const snapshot = f.db.serialize();
    const freshDb = new Database(snapshot); closes.push(() => freshDb.close());
    const bus = new EventBus(freshDb), repo = new QueueRepository(freshDb, bus, { validateRig: () => true, loadHumanRegistry: () => registry });
    const access = new CoreAppAccess(freshDb, repo), log = new MissionControlActionLog(freshDb);
    const writes = new MissionControlWriteContract({ db: freshDb, eventBus: bus, queueRepo: repo, actionLog: log });
    const job = new CoreAppJob(access, repo, bus, writes, log), credential = access.authenticate(`Bearer ${f.token}`);
    for (let i = 0; i < 55; i++) await writes.act({ verb: "annotate", qitemId: f.ask.qitemId, actorSession: PERSON, annotation: `note ${i}` });
    if (state !== "pending") freshDb.prepare("UPDATE queue_items SET state = 'done', evidence_ref = ? WHERE qitem_id = ?").run(state === "evidence-changed" ? "artifact:changed" : null, f.ask.qitemId);
    const seq = bus.maxSeq();
    if (state === "evidence-changed") {
      const changes = freshDb.prepare("SELECT total_changes() n").get(), actions = log.countAll();
      expect(job.readAnswer(credential, "answer_recover", PERSON)).toMatchObject({ submission: { state: "conflict", conflictCode: "recovery_conflict" }, retrySameSubmission: false });
      await expect(job.submit(credential, "answer_recover", binding)).rejects.toMatchObject({ code: "recovery_conflict", status: 409 });
      expect(freshDb.prepare("SELECT total_changes() n").get()).toEqual(changes); expect(bus.maxSeq()).toBe(seq); expect(log.countAll()).toBe(actions);
      expect(freshDb.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.ask.qitemId)).toEqual({ n: 1 });
      return;
    }
    expect(job.readAnswer(credential, "answer_recover", PERSON)).toMatchObject({ submission: { state: "incomplete" }, retrySameSubmission: true });
    expect(bus.maxSeq()).toBe(seq);
    const receipt = await job.submit(credential, "answer_recover", binding);
    expect(receipt).toMatchObject({ submission: { state: "committed", outcome: "answered" } });
    expect(repo.getById(f.ask.qitemId)?.state).toBe("done");
    expect(freshDb.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.ask.qitemId)).toEqual({ n: 1 });
    const committedSeq = bus.maxSeq();
    const replay = await job.submit(credential, "answer_recover", binding);
    expect(replay).toMatchObject({ ...receipt, replayed: true }); expect(bus.maxSeq()).toBe(committedSeq);
  });
  it("read-only status terminates stale zero-effect reservations and real changed-question recovery", async () => {
    const f = await jobFixture(true), binding = f.binding();
    const original = f.log.record.bind(f.log); vi.spyOn(f.log, "record").mockImplementationOnce(() => { throw new Error("fixture audit failure"); }).mockImplementation(original);
    await f.send("/v1/answers/answer_stale", binding, f.token);
    f.db.prepare("UPDATE queue_items SET body = 'changed decision' WHERE qitem_id = ?").run(f.ask.qitemId);
    const seq = f.bus.maxSeq();
    const response = await f.send(`/v1/answers/answer_stale?actor=${encodeURIComponent(PERSON)}`, undefined, f.token);
    expect(await response.json()).toMatchObject({ submission: { state: "conflict", conflictCode: "decision_revision_changed" }, retrySameSubmission: false });
    expect((await f.send("/v1/answers/answer_stale", binding, f.token)).status).toBe(409); expect(f.bus.maxSeq()).toBe(seq);
    expect(f.repo.getById(f.ask.qitemId)?.humanAnswers ?? {}).toEqual({});
  });
  it("rejects stale revisions and typed placement; binding, cross-app and cross-actor checks precede mutation", async () => {
    const f = await jobFixture(true), sent = f.binding();
    expect((await f.send("/v1/answers/answer_badrev", { ...sent, expectedRevision: "stale" }, f.token)).status).toBe(409);
    expect((await f.send("/v1/answers/answer_badtext", { ...sent, questionId: "q2", answer: { kind: "typed-reply", text: "hello" } }, f.token)).status).toBe(409);
    expect((await f.send("/v1/answers/answer_unknown", { ...sent, authority: "primary-user" }, f.token)).status).toBe(400);
    const first = await f.send("/v1/answers/answer_bound", sent, f.token); expect(first.status).toBe(200);
    for (const change of [{ questionId: "q2" }, { requestId: "other" }, { expectedRevision: "other" }, { episodeKey: "other" }, { answer: { kind: "option", optionId: "no" } }]) {
      expect((await f.send("/v1/answers/answer_bound", { ...sent, ...change }, f.token)).status).toBe(409);
    }
    const outsider = (await (await f.provision([PERSON], "another-app")).json()).token;
    expect((await f.send(`/v1/answers/answer_bound?actor=${encodeURIComponent(PERSON)}`, undefined, outsider)).status).toBe(404);
    const scoped = (await (await f.provision([OTHER])).json()).token;
    expect((await f.send(`/v1/answers/answer_bound?actor=${encodeURIComponent(PERSON)}`, undefined, scoped)).status).toBe(403);
    expect(f.log.countAll()).toBe(1);
  });
  it("coalesces identical concurrent retries and fences another actor at the old revision", async () => {
    const f = await jobFixture(), binding = f.binding();
    const [a, b, loser] = await Promise.all([f.send("/v1/answers/answer_parallel", binding, f.token), f.send("/v1/answers/answer_parallel", binding, f.token),
      f.send("/v1/answers/answer_other", { ...binding, actor: OTHER }, f.token)]);
    expect(a.status).toBe(200); expect(b.status).toBe(200); expect(loser.status).toBe(409);
    expect(f.log.countAll()).toBe(1); expect(f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.ask.qitemId)).toEqual({ n: 1 });
  });
});

it("keeps a committed return when audit append fails at close, and rejects a later changed-question repair without writing", async () => {
  const f = await jobFixture(); const sent = { ...f.binding(), answer: { kind: "typed-reply", text: "Keep these words" } };
  const original = f.log.record.bind(f.log);
  vi.spyOn(f.log, "record").mockImplementationOnce(() => { throw new Error("fixture audit interruption at close"); }).mockImplementation(original);
  expect((await f.send("/v1/answers/answer_conflict", sent, f.token)).status).toBe(503);
  expect(f.repo.getById(f.ask.qitemId)?.state).toBe("pending"); expect(f.log.countAll()).toBe(0);
  expect(f.db.prepare("SELECT receipt_json FROM core_app_submissions").get()).toEqual({ receipt_json: null });
  f.db.prepare("UPDATE queue_items SET body = 'a different decision' WHERE qitem_id = ?").run(f.ask.qitemId);
  const seq = f.bus.maxSeq(), changes = f.db.prepare("SELECT total_changes() n").get();
  expect(await (await f.send(`/v1/answers/answer_conflict?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json())
    .toMatchObject({ submission: { state: "conflict", conflictCode: "recovery_conflict" }, retrySameSubmission: false });
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
  expect((await f.send("/v1/answers/answer_conflict", sent, f.token)).status).toBe(409);
  expect(f.repo.getById(f.ask.qitemId)?.state).toBe("pending"); expect(f.bus.maxSeq()).toBe(seq); expect(f.log.countAll()).toBe(0);
});

it("rejects a fresh conflicting choice after an interrupted finalized return, preserving the original accepted answer", async () => {
  const f = await jobFixture(), first = f.binding();
  const original = f.log.record.bind(f.log);
  vi.spyOn(f.log, "record").mockImplementationOnce(() => { throw new Error("fixture audit interruption after Yes return"); }).mockImplementation(original);
  expect((await f.send("/v1/answers/answer_first", first, f.token)).status).toBe(503);
  expect(f.repo.getById(f.ask.qitemId)).toMatchObject({ state: "pending", humanAnswers: { q1: "yes" } });
  const seq = f.bus.maxSeq();
  const response = await f.send("/v1/answers/answer_second", f.binding(PERSON, "q1", "no"), f.token);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "answer_already_returned", retrySameSubmission: false, replyQitemId: f.repo.getHumanAnswer(f.ask.qitemId, PERSON)!.qitemId });
  expect(f.db.prepare("SELECT 1 FROM core_app_submissions WHERE answer_id = 'answer_second'").get()).toBeUndefined();
  expect(f.bus.maxSeq()).toBe(seq); expect(f.log.countAll()).toBe(0);
  expect(f.repo.getById(f.ask.qitemId)).toMatchObject({ state: "pending", humanAnswers: { q1: "yes" } });
  expect(await (await f.send("/v1/answers/answer_first", first, f.token)).json()).toMatchObject({ answer: { kind: "option", optionId: "yes" }, submission: { state: "committed", outcome: "answered" } });
});


it("preserves the original-return disposition when a fresh identical choice finishes an interrupted close", async () => {
  const f = await jobFixture(), first = f.binding();
  const resolve = f.repo.resolveDirectHumanReply.bind(f.repo);
  vi.spyOn(f.repo, "resolveDirectHumanReply").mockImplementationOnce(() => { throw new Error("fixture interruption"); }).mockImplementation(resolve);
  expect((await f.send("/v1/answers/answer_original", first, f.token)).status).toBe(503);
  const returned = f.repo.getHumanAnswer(f.ask.qitemId, PERSON)!;
  const response = await f.send("/v1/answers/answer_same_choice", f.binding(), f.token);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ answer: { kind: "option", optionId: "yes" }, submission: {
    state: "committed", outcome: "answered", message: expect.stringContaining("Already answered"), replyQitemId: returned.qitemId,
  } });
  expect(f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.ask.qitemId)).toEqual({ n: 1 });
});


describe("follow actual results and erase retained submissions", () => {
  it.each(["legacy", "recovered", "post-close"] as const)("uses the answer owner to classify an untagged Slack %s reply", async mode => {
    const f = await jobFixture();
    if (mode === "post-close") f.repo.update({ qitemId: f.ask.qitemId, actorSession: PERSON, state: "done", closureReason: "no-follow-on" });
    const reply = await f.repo.create({ qitemId: `qitem-slack-inbound-${mode}`, sourceSession: PERSON, destinationSession: "builder@test",
      inboundReplyTo: f.ask.qitemId, body: "Original Slack words", tags: ["inbound"], nudge: false,
      ...(mode === "recovered" ? { summary: "[Recovered after gap] earlier context" } : {}) });
    if (mode === "post-close") f.db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run("2099-01-01T00:00:00.000Z", reply.qitemId);
    const owned = f.repo.answersForAsk(f.ask.qitemId).map(answer => answer.qitemId);
    expect(owned).toEqual(mode === "legacy" ? [reply.qitemId] : []);
    const response = await f.send(`/v1/requests/${f.ask.qitemId}/result?actor=${encodeURIComponent(PERSON)}`, undefined, f.token);
    expect(response.status).toBe(200);
    expect((await response.json()).answerReturn).toMatchObject(mode === "legacy"
      ? { status: "returned", replyQitemId: reply.qitemId, body: "Original Slack words", replyTo: f.ask.qitemId }
      : { status: "not-returned", replyQitemId: null });
  });
  it.each(["handoff", "handoff-and-complete"] as const)("follows A -> W -> S when W, parked on A, is handed off (%s) with no saved answer", async (verb) => {
    const f = await jobFixture();
    const builder = ["builder", "test"].join("@"), next = ["next", "test"].join("@");
    const work = await f.repo.create({ sourceSession: builder, destinationSession: builder, body: "Prepare report", nudge: false });
    f.repo.claim({ qitemId: work.qitemId, destinationSession: builder });
    f.repo.update({ qitemId: work.qitemId, actorSession: builder, state: "blocked", blockedOn: f.ask.qitemId });
    const input = { qitemId: work.qitemId, fromSession: builder, toSession: next, nudge: false };
    const { created } = verb === "handoff" ? await f.repo.handoff(input) : await f.repo.handoffAndComplete(input);
    // The handoff leaves W naming its blocker, and no answer was submitted, so no checkpoint captures W.
    expect(f.repo.getById(work.qitemId)!.blockedOn).toBe(f.ask.qitemId);
    const body = await (await f.send(`/v1/requests/${f.ask.qitemId}/result?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json();
    expect(body.work.edges).toContainEqual(expect.objectContaining({ from: f.ask.qitemId, to: work.qitemId, relation: "blocked-on" }));
    expect(body.work.edges).toContainEqual(expect.objectContaining({ from: work.qitemId, to: created.qitemId, relation: "handed-off-from" }));
    expect((await f.send(`/v1/work/${created.qitemId}?requestId=${f.ask.qitemId}&actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).status).toBe(200);
  });
  it("follows A -> R and captured A -> W -> Z after attention disappears, without exposing unrelated work", async () => {
    const f = await jobFixture();
    const work = await f.repo.create({ sourceSession: "builder@test", destinationSession: "builder@test", body: "Prepare report", nudge: false });
    f.repo.claim({ qitemId: work.qitemId, destinationSession: "builder@test" });
    f.repo.update({ qitemId: work.qitemId, actorSession: "builder@test", state: "blocked", blockedOn: f.ask.qitemId });
    expect((await f.send("/v1/answers/answer_follow", f.binding(), f.token)).status).toBe(200);
    f.db.prepare("UPDATE queue_items SET blocked_on = NULL, state = 'in-progress' WHERE qitem_id = ?").run(work.qitemId);
    const result = await f.repo.create({ sourceSession: "builder@test", destinationSession: PERSON, body: "Actual result: report delivered", inboundReplyTo: work.qitemId, humanIntent: "update", nudge: false });
    f.repo.update({ qitemId: work.qitemId, actorSession: "builder@test", state: "done", closureReason: "no-follow-on", evidenceRef: "artifact:report" });
    const unrelated = await f.repo.create({ sourceSession: "builder@test", destinationSession: "builder@test", body: "unrelated secret", nudge: false });
    const seq = f.bus.maxSeq(), changes = f.db.prepare("SELECT total_changes() n").get();
    const response = await f.send(`/v1/requests/${f.ask.qitemId}/result?actor=${encodeURIComponent(PERSON)}`, undefined, f.token);
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.answerReturn).toMatchObject({ status: "returned", replyQitemId: f.repo.getHumanAnswer(f.ask.qitemId, PERSON)!.qitemId });
    expect(body.permissionDecision).toMatchObject({ status: "not-applicable", nativeEffect: "unknown" });
    expect(body.work.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ qitemId: work.qitemId, completion: { status: "closed-as-recorded", sourceQitemId: work.qitemId, closureReason: "no-follow-on", evidenceRef: "artifact:report" } }),
      expect.objectContaining({ qitemId: result.qitemId, body: "Actual result: report delivered" }),
    ]));
    expect(body.work.edges).toContainEqual(expect.objectContaining({ from: f.ask.qitemId, to: work.qitemId, relation: "blocked-on", captured: true }));
    expect(JSON.stringify(body)).not.toContain("unrelated secret");
    const path = `/v1/work/${result.qitemId}?requestId=${f.ask.qitemId}&actor=${encodeURIComponent(PERSON)}`;
    expect((await f.send(path, undefined, f.token)).status).toBe(200);
    expect((await f.send(`/v1/work/${unrelated.qitemId}?requestId=${f.ask.qitemId}&actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).status).toBe(404);
    expect(f.bus.maxSeq()).toBe(seq); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
  });
  it.each(["scrub", "delete"] as const)("%s of the source redacts binding, checkpoint, receipt and audit content while preserving a no-reexecute tombstone", async action => {
    const f = await jobFixture(); const binding = { ...f.binding(), answer: { kind: "typed-reply", text: "Private answer content" } };
    expect((await f.send("/v1/answers/answer_erase", binding, f.token)).status).toBe(200);
    const report = await eraseQueue(f.db, { apply: true, nowIso: new Date().toISOString(), scope: { kind: "ids", entries: [{ qitemId: f.ask.qitemId, action }] } });
    expect(report.error).toBeUndefined(); expect(report.qitems).toContainEqual(expect.objectContaining({ qitemId: f.ask.qitemId, action }));
    const row = f.db.prepare("SELECT binding_hash,binding_json,checkpoint_json,receipt_json,erased_at FROM core_app_submissions").get() as Record<string, unknown>;
    expect(row).toMatchObject({ binding_json: null, checkpoint_json: null, receipt_json: null, erased_at: expect.any(String), binding_hash: "" });
    expect(JSON.stringify(row)).not.toContain("Private answer content");
    const changes = f.db.prepare("SELECT total_changes() n").get();
    expect(await (await f.send(`/v1/answers/answer_erase?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json()).toMatchObject({ submission: { state: "source_unavailable" }, retrySameSubmission: false });
    const replay = await f.send("/v1/answers/answer_erase", binding, f.token); expect(replay.status).toBe(409);
    const replayBody = await replay.json(); expect(replayBody).toMatchObject({ error: "source_unavailable", retrySameSubmission: false });
    const guess = await f.send("/v1/answers/answer_erase", { ...binding, answer: { kind: "typed-reply", text: "replacement" } }, f.token);
    expect(guess.status).toBe(409); expect(await guess.json()).toEqual(replayBody);
    expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
  });
});

async function appStream(f: ReturnType<typeof fixture>, token: string, cursor?: string) {
  const response = await f.app.request("/api/apps/v1/events", { headers: { Authorization: `Bearer ${token}`, ...(cursor ? { "Last-Event-ID": cursor } : {}) } });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(); let buffer = "";
  const next = async () => {
    while (!buffer.includes("\n\n")) { const chunk = await reader.read(); if (chunk.done) return null; buffer += new TextDecoder().decode(chunk.value); }
    const at = buffer.indexOf("\n\n"), event = buffer.slice(0, at); buffer = buffer.slice(at + 2);
    return JSON.parse(event.split("\n").find(line => line.startsWith("data: "))!.slice(6));
  };
  return { next, reader };
}
describe("authenticated invalidation refresh", () => {
  it("requires app auth without an actor query, replays filtered invalidations and exposes no raw queue payload", async () => {
    const f = await jobFixture(); const cursor = f.job.cursor();
    f.bus.emit({ type: "test.internal", private: "secret internal payload" } as any);
    await f.repo.create({ sourceSession: "builder@test", destinationSession: PERSON, body: "Private raw update", humanIntent: "update", nudge: false });
    const stream = await appStream(f, f.token, cursor);
    const invalidation = await stream.next();
    expect(invalidation).toEqual({ kind: "invalidate", cursor: expect.any(String), requestId: null });
    expect(Object.keys(invalidation).sort()).toEqual(["cursor", "kind", "requestId"]);
    expect((await stream.next()).kind).toBe("heartbeat");
    await stream.reader.cancel(); expect(f.bus.subscriberCount).toBe(0);
    expect((await f.send("/v1/events", undefined, "operator")).status).toBe(401);
  });
  it.each([500, 501])("counts only matching invalidations across replay pages: %s matches", async matches => {
    const f = await jobFixture(), cursor = f.job.cursor();
    const sequences: number[] = [];
    for (let i = 0; i < 1002; i++) f.bus.emit({ type: "test.internal" } as any);
    for (let i = 0; i < matches; i++) {
      sequences.push(f.bus.emit({ type: "queue.updated", qitemId: `fictional-${i}` }).seq);
      f.bus.emit({ type: "test.internal" } as any);
    }
    expect(f.job.eventReplay(cursor)).toEqual(matches > 500 ? null : { head: f.bus.maxSeq(), sequences });
  });
  it("invalidates live and replayed streams for a partial answer recorded outside the app", async () => {
    const f = await jobFixture(true), cursor = f.job.cursor();
    const live = await appStream(f, f.token); expect((await live.next()).kind).toBe("heartbeat");
    const recorded = f.repo.recordHumanAnswer({ qitemId: f.ask.qitemId, actorSession: PERSON, questionId: "q1", optionId: "yes" });
    expect(recorded.status).toBe("recorded");
    expect((await live.next()).kind).toBe("invalidate");
    expect(f.job.eventReplay(cursor)).toMatchObject({ sequences: [expect.any(Number)] });
    const replayed = await appStream(f, f.token, cursor);
    expect((await replayed.next()).kind).toBe("invalidate");
  });
  it("resets replay after real pruning while queue-backed request reads and later replay remain available", async () => {
    const f = await jobFixture(), cursor = f.job.cursor();
    const old = f.bus.emit({ type: "queue.updated", qitemId: f.ask.qitemId }).seq;
    f.bus.emit({ type: "test.internal" } as any);
    const retainedCursor = f.job.cursor();
    const retained = f.bus.emit({ type: "queue.updated", qitemId: f.ask.qitemId }).seq;
    f.db.prepare("UPDATE events SET created_at=CASE WHEN seq=? THEN '2026-06-01 00:00:00' ELSE '2026-07-15 18:00:00' END").run(old);
    const credential = f.access.authenticate(`Bearer ${f.token}`);
    const before = f.job.request(credential, f.ask.qitemId, PERSON);

    const result = await pruneEvents(f.db, { nowIso: "2026-07-15T18:00:00.000Z", eventsRetentionDays: 14, eventsYield: async () => {} });

    expect(result.deletedRows).toBe(1);
    expect(f.db.prepare("SELECT seq FROM events WHERE seq=?").get(old)).toBeUndefined();
    expect(f.job.eventReplay(cursor)).toBeNull();
    expect(f.job.eventReplay(retainedCursor)).toEqual({ head: retained, sequences: [retained] });
    expect(f.job.request(credential, f.ask.qitemId, PERSON)).toEqual(before);
    const stream = await appStream(f, f.token, cursor);
    expect(await stream.next()).toEqual({ kind: "reset", reason: "continuity-unproven" });
    expect(await stream.next()).toBeNull();
  });
  it.each(["invalid", "old-boot", "ahead", "retained-floor", "deleted-row", "overflow"])("resets and closes when continuity is unproven: %s", async reason => {
    const f = await jobFixture(); let cursor = f.job.cursor();
    if (reason === "invalid") cursor = "invalid-cursor";
    if (reason === "old-boot") cursor = new CoreAppJob(f.access, f.repo, f.bus, f.writes, f.log).cursor();
    if (reason === "ahead") cursor = f.job.cursor(f.bus.maxSeq() + 1);
    if (reason === "retained-floor") f.db.prepare("INSERT INTO events_retention_marks (id,low_water_seq,prunable_types,updated_at) VALUES (1,?,'[]',?)").run(f.bus.maxSeq() + 1, new Date().toISOString());
    if (reason === "deleted-row") { f.bus.emit({ type: "test.internal" } as any); f.bus.emit({ type: "test.internal" } as any); f.db.prepare("DELETE FROM events WHERE seq = ?").run(f.bus.maxSeq() - 1); }
    if (reason === "overflow") for (let i = 0; i < 501; i++) f.bus.emit({ type: "queue.created", qitemId: `fictional-${i}` } as any);
    const stream = await appStream(f, f.token, cursor);
    expect(await stream.next()).toEqual({ kind: "reset", reason: "continuity-unproven" }); expect(await stream.next()).toBeNull();
    expect(f.bus.subscriberCount).toBe(0);
  });
  it("subscribes before replay, deduplicates the boundary, and resets live overflow", async () => {
    const f = await jobFixture(); const cursor = f.job.cursor();
    const original = f.job.eventReplay.bind(f.job);
    vi.spyOn(f.job, "eventReplay").mockImplementationOnce(value => {
      f.bus.emit({ type: "queue.created", qitemId: "fictional-race" } as any); return original(value);
    });
    const stream = await appStream(f, f.token, cursor);
    expect((await stream.next()).kind).toBe("invalidate"); expect((await stream.next()).kind).toBe("heartbeat");
    for (let i = 0; i < 501; i++) f.bus.emit({ type: "queue.updated", qitemId: `fictional-${i}` } as any);
    expect(await stream.next()).toMatchObject({ kind: "reset", reason: "continuity-unproven" }); expect(await stream.next()).toBeNull();
    expect(f.bus.subscriberCount).toBe(0);
  });
  it("terminates a revoked stream at the next event, and snapshot polling observes eventless source changes", async () => {
    const f = await jobFixture(); const stream = await appStream(f, f.token); expect((await stream.next()).kind).toBe("heartbeat");
    const credential = f.access.authenticate(`Bearer ${f.token}`);
    f.access.revoke(credential.credentialId);
    f.bus.emit({ type: "queue.updated", qitemId: f.ask.qitemId } as any);
    expect(await stream.next()).toBeNull(); expect(f.bus.subscriberCount).toBe(0);
    const token = (await (await f.provision()).json()).token;
    const seq = f.bus.maxSeq();
    f.db.prepare("UPDATE queue_items SET body = 'Changed without an event' WHERE qitem_id = ?").run(f.ask.qitemId);
    const snapshot = await (await f.send(`/v1/needs-me?actor=${encodeURIComponent(PERSON)}`, undefined, token)).json();
    expect(snapshot.requests[0].body).toBe("Changed without an event"); expect(f.bus.maxSeq()).toBe(seq);
  });
});

/** `true`: a receiving agent decides; `"keep"`: a decider is wired but none can read it (the answer is kept); `false`: none is wired. */
async function permissionFixture(receiving: boolean | "keep" = true) {
  const f = fixture("operator", receiving === true ? () => ({ session: "lead@test" }) : receiving === "keep" ? () => null : undefined);
  f.repo.attachOutbox(new OutboxHandler(f.db));
  const token = (await (await f.provision()).json()).token;
  const rigs = new RigRepository(f.db), rig = rigs.createRig("test"), node = rigs.addNode(rig.id, "runner", { runtime: "synth" });
  const sessions = new SessionRegistry(f.db); sessions.registerSession(node.id, "runner@test");
  const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
  const permissions = new RunnerPermissions({ db: f.db, queueRepo: f.repo, eventBus: f.bus, humanRegistry: () => registry,
    ownerOf: () => PERSON, currentGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null });
  const submitted = await permissions.submit({ nodeId: node.id, sessionName: "runner@test", generation }, {
    nativeRef: "fixture-session", turnId: "fixture-turn", requestId: "fixture-permission", toolCall: { title: "Write report", kind: "edit" },
    options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject once", kind: "reject_once" }],
  });
  if (!submitted.ok || !("askId" in submitted)) throw new Error("fixture permission ask unavailable");
  return { ...f, token, permissions, sessions, node, askId: submitted.askId, generation };
}
describe("permission and refresh truth", () => {
  it("distinguishes the person's answer from the receiving agent's decision and unknown native effect", async () => {
    const f = await permissionFixture();
    const ask = f.repo.getById(f.askId)!;
    const response = await f.send("/v1/answers/answer_permission", { job: "human-answer", actor: PERSON, requestId: f.askId, questionId: "permission", episodeKey: null,
      expectedRevision: f.repo.decisionRevision(ask), answer: { kind: "option", optionId: "allow" } }, f.token);
    expect(response.status).toBe(200);
    expect((await response.json()).submission.message).toBe(`Your answer on ${f.askId} went to lead@test, the receiving agent, which decides. The runner waits until then; nothing has run. A note to you says the agent's recorded state.`);
    const resultPath = `/v1/requests/${f.askId}/result?actor=${encodeURIComponent(PERSON)}`;
    const current = await (await f.send(resultPath, undefined, f.token)).json();
    expect(current.answerReturn).toMatchObject({ status: "kept-for-agent", replyQitemId: null });
    expect(current.permissionDecision).toMatchObject({ status: "awaiting-agent", nativeEffect: "unknown" });
    expect(f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.askId)).toEqual({ n: 0 });
    const live = f.repo.relatedTo(f.askId).find(edge => edge.relation === "handed-off-from")!.item;
    expect(f.permissions.decide(f.askId, "allow", "lead@test", "The person's choice is clear")).toMatchObject({ state: "answered", optionId: "allow" });
    const seq = f.bus.maxSeq(), changes = f.db.prepare("SELECT total_changes() n").get();
    expect(await (await f.send(resultPath, undefined, f.token)).json()).toMatchObject({ permissionDecision: { status: "decided", nativeEffect: "unknown", sourceQitemId: live.qitemId, decider: "lead@test", option: "allow" } });
    expect(f.bus.maxSeq()).toBe(seq); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
    await new Promise(resolve => setImmediate(resolve));
  });
  it("shows stale/withdrawn requests without closing them during reads and filters stale asks from needs-me", async () => {
    const f = await permissionFixture();
    f.sessions.registerSession(f.node.id, "runner@test", "handover");
    const seq = f.bus.maxSeq(), changes = f.db.prepare("SELECT total_changes() n").get();
    expect(await (await f.send(`/v1/requests/${f.askId}/result?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json())
      .toMatchObject({ permissionDecision: { status: "stale", nativeEffect: "unknown" } });
    const needs = await (await f.send(`/v1/needs-me?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json();
    expect(needs.requests).toEqual([]); expect(f.repo.getById(f.askId)?.state).toBe("pending");
    expect(f.bus.maxSeq()).toBe(seq); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
    const g = await permissionFixture();
    expect(g.permissions.withdraw(null, g.askId, "turn_ended")).toMatchObject({ state: "withdrawn" });
    expect(await (await g.send(`/v1/requests/${g.askId}/result?actor=${encodeURIComponent(PERSON)}`, undefined, g.token)).json())
      .toMatchObject({ permissionDecision: { status: "withdrawn", nativeEffect: "unknown", sourceTransitionId: expect.any(Number) } });
  });
  it("advertises the complete versioned job, preserves app-scoped receipts through scoped credential rotation and exposes source failure", async () => {
    const f = await jobFixture(); const binding = f.binding();
    expect((await f.send("/v1/answers/answer_rotation", binding, f.token)).status).toBe(200);
    const replacement = (await (await f.provision()).json()).token;
    f.access.revoke(f.access.authenticate(`Bearer ${f.token}`).credentialId);
    expect((await f.send("/v1/answers/answer_rotation", binding, replacement)).status).toBe(200);
    const capabilities = await (await f.send("/v1/capabilities", undefined, replacement)).json();
    expect(capabilities).toMatchObject({ contract: "openrig.core-app", version: 1, jobs: [expect.objectContaining({ id: "human-answer", stableSubmissionIds: true, resultRead: true, independentHumanAuthentication: false })],
      app: { id: "test", actors: [PERSON] }, refresh: { events: "invalidation-only", pollAfterMs: 5000 } });
    vi.spyOn(f.repo, "listAttention").mockImplementationOnce(() => { throw new Error("fixture source unavailable"); });
    expect(await (await f.send(`/v1/needs-me?actor=${encodeURIComponent(PERSON)}`, undefined, replacement)).json()).toMatchObject({ sources: [{ source: "queue", state: "unavailable" }], requests: [] });
  });
});

it("two independent app services reconcile the same in-flight submission from durable evidence", async () => {
  const f = await jobFixture(), binding = f.binding();
  // Independent composition has no shared inFlight map, as after a reconnect to another request handler.
  const independent = new CoreAppJob(f.access, f.repo, f.bus, new MissionControlWriteContract({ db: f.db, queueRepo: f.repo, eventBus: f.bus, actionLog: f.log }), f.log);
  const credential = f.access.authenticate(`Bearer ${f.token}`);
  const [first, second] = await Promise.all([f.job.submit(credential, "answer_twoservices", binding), independent.submit(credential, "answer_twoservices", binding)]);
  expect(first.submission).toEqual(second.submission); expect(f.log.countAll()).toBe(1);
  expect(f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.ask.qitemId)).toEqual({ n: 1 });
});


it("two SQLite connections preserve one bound receipt, audit and return on identical concurrent submissions", async () => {
  const f = await jobFixture(), binding = f.binding();
  const directory = mkdtempSync(join(tmpdir(), "core-app-connections-")), file = join(directory, "fixture.sqlite");
  writeFileSync(file, f.db.serialize());
  const firstDb = new Database(file), secondDb = new Database(file);
  firstDb.pragma("journal_mode = WAL"); secondDb.pragma("busy_timeout = 5000");
  closes.push(() => { firstDb.close(); secondDb.close(); rmSync(directory, { recursive: true, force: true }); });
  const compose = (db: Database.Database) => {
    const bus = new EventBus(db), repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry,
      transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
    const access = new CoreAppAccess(db, repo), log = new MissionControlActionLog(db);
    return { access, log, job: new CoreAppJob(access, repo, bus, new MissionControlWriteContract({ db, queueRepo: repo, eventBus: bus, actionLog: log }), log) };
  };
  const a = compose(firstDb), b = compose(secondDb), actorA = a.access.authenticate(`Bearer ${f.token}`), actorB = b.access.authenticate(`Bearer ${f.token}`);
  const [first, second] = await Promise.all([a.job.submit(actorA, "answer_connections", binding), b.job.submit(actorB, "answer_connections", binding)]);
  expect(first.submission).toEqual(second.submission); expect(a.log.countAll()).toBe(1);
  expect(firstDb.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.ask.qitemId)).toEqual({ n: 1 });
});

it("marks bounded, missing and cyclic relation graphs partial and explains unsupported direct reads without general queue browsing", async () => {
  const f = await jobFixture();
  const unrelated = await f.repo.create({ sourceSession: "builder@test", destinationSession: "builder@test", body: "Unrelated task private body", nudge: false });
  const direct = await (await f.send(`/v1/requests/${unrelated.qitemId}?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json();
  expect(direct).toMatchObject({ answer: null, unsupportedReason: "unsupported_request_kind" });
  expect(JSON.stringify(direct)).not.toContain("Unrelated task private body");
  expect((await f.send(`/v1/work/${unrelated.qitemId}?requestId=${unrelated.qitemId}&actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).status).toBe(404);
  f.db.prepare("UPDATE queue_items SET handed_off_to = 'remote@rig@elsewhere' WHERE qitem_id = ?").run(f.ask.qitemId);
  const path = `/v1/requests/${f.ask.qitemId}/result?actor=${encodeURIComponent(PERSON)}`;
  expect(await (await f.send(path, undefined, f.token)).json()).toMatchObject({ sources: [{ source: "queue", state: "partial" }], answerReturn: { status: "unknown" } });
  f.db.prepare("UPDATE queue_items SET handed_off_to = NULL WHERE qitem_id = ?").run(f.ask.qitemId);
  const work = await f.repo.create({ sourceSession: "builder@test", destinationSession: "builder@test", body: "Cycle fixture", inboundReplyTo: f.ask.qitemId, nudge: false });
  f.db.prepare("UPDATE queue_items SET reply_to = ? WHERE qitem_id = ?").run(work.qitemId, f.ask.qitemId);
  expect(await (await f.send(path, undefined, f.token)).json()).toMatchObject({ work: { status: "partial" } });
  f.db.prepare("UPDATE queue_items SET reply_to = NULL WHERE qitem_id = ?").run(f.ask.qitemId);
  for (let i = 0; i < 103; i++) await f.repo.create({ sourceSession: "builder@test", destinationSession: PERSON, body: `Result fixture ${i}`, humanIntent: "update", inboundReplyTo: f.ask.qitemId, nudge: false });
  const bounded = await (await f.send(path, undefined, f.token)).json();
  expect(bounded.work.status).toBe("partial"); expect(bounded.work.records.length).toBeLessThanOrEqual(99);
});

it("production route mounting retains Host/Origin checks and rejects app tokens on configured operator writes", async () => {
  const f = await jobFixture();
  const { app } = createTestApp(f.db, { appDeps: { queueRepo: f.repo, eventBus: f.bus, missionControlWriteContract: f.writes,
    missionControlBearerToken: "operator", terminalBearerToken: "terminal" } });
  const response = await app.request("/api/apps/v1/capabilities", { headers: { Authorization: `Bearer ${f.token}`, Host: "localhost" } });
  expect(response.status).toBe(200); expect((await response.json()).jobs[0].id).toBe("human-answer");
  for (const headers of [{ Host: "evil.example" }, { Host: "localhost", Origin: "https://evil.example" }]) {
    expect((await app.request("/api/apps/v1/capabilities", { headers: { Authorization: `Bearer ${f.token}`, ...headers } })).status).toBe(403);
  }
  const body = JSON.stringify({ verb: "annotate", qitemId: f.ask.qitemId, annotation: "Authorized operator note" });
  expect((await app.request("/api/mission-control/action", { method: "POST", headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json", "X-OpenRig-Session": PERSON }, body })).status).toBe(401);
  expect((await app.request("/api/mission-control/action", { method: "POST", headers: { Authorization: "Bearer operator", "Content-Type": "application/json", "X-OpenRig-Session": PERSON }, body })).status).toBe(200);
});

it.each([["a configured owner bearer", "operator"], ["no owner bearer", null]] as const)("production mount gives credential provisioning the owner write route's Host/Origin behavior with %s", async (_label, owner) => {
  const f = await jobFixture();
  const { app } = createTestApp(f.db, { appDeps: { queueRepo: f.repo, eventBus: f.bus, missionControlWriteContract: f.writes,
    missionControlBearerToken: owner, terminalBearerToken: "terminal" } });
  const credentials = JSON.stringify({ appId: "mounted", actors: [PERSON], job: "human-answer", attribution: "app-attributed" });
  const note = JSON.stringify({ verb: "annotate", qitemId: f.ask.qitemId, annotation: "Owner parity note" });
  const matrix: Array<[string, Record<string, string>]> = [
    ["plain local", { Host: "localhost" }],
    ["owner bearer on a custom Host", { Host: "evil.example", ...(owner ? { Authorization: `Bearer ${owner}` } : {}) }],
    ["no bearer on a custom Host", { Host: "evil.example" }],
    ["bad Origin with the owner bearer", { Host: "localhost", Origin: "https://evil.example", ...(owner ? { Authorization: `Bearer ${owner}` } : {}) }],
    ["an app credential on a local Host", { Host: "localhost", Authorization: `Bearer ${f.token}` }],
  ];
  for (const [label, headers] of matrix) {
    const provision = await app.request("/api/apps/v1/credentials", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: credentials });
    const action = await app.request("/api/mission-control/action", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": PERSON, ...headers }, body: note });
    // The Host/Origin decision (403) is the shared boundary's, so it must match the owner write route's for the same request.
    expect([label, provision.status === 403]).toEqual([label, action.status === 403]);
  }
  const statuses = async (headers: Record<string, string>) => (await app.request("/api/apps/v1/credentials", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: credentials })).status;
  expect(await statuses({ Host: "localhost", ...(owner ? { Authorization: `Bearer ${owner}` } : {}) })).toBe(201);
  expect(await statuses({ Host: "evil.example" })).toBe(403);
  expect(await statuses({ Host: "localhost", Origin: "https://evil.example" })).toBe(403);
  expect(await statuses({ Host: "localhost", Authorization: `Bearer ${f.token}` })).toBe(401);
  if (owner) expect(await statuses({ Host: "evil.example", Authorization: `Bearer ${owner}` })).toBe(201); // the existing current-owner Host waiver
  else expect(await statuses({ Host: "evil.example", Authorization: `Bearer ${f.token}` })).toBe(403);
});

it("a revoked stream closes at its 15 second heartbeat without waiting for a queue event", async () => {
  vi.useFakeTimers();
  try {
    const f = await jobFixture(); const stream = await appStream(f, f.token);
    expect((await stream.next()).kind).toBe("heartbeat");
    f.access.revoke(f.access.authenticate(`Bearer ${f.token}`).credentialId);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await stream.next()).toBeNull(); expect(f.bus.subscriberCount).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("rechecks a typed decision at the first transactional reply write, so an intervening edit creates no return", async () => {
  const f = await jobFixture();
  const create = f.repo.createHumanAnswer.bind(f.repo);
  vi.spyOn(f.repo, "createHumanAnswer").mockImplementationOnce(input => {
    f.db.prepare("UPDATE queue_items SET body = 'Intervening decision edit' WHERE qitem_id = ?").run(f.ask.qitemId);
    return create(input);
  });
  const sent = { ...f.binding(), answer: { kind: "typed-reply", text: "Do not send on another decision" } };
  expect((await f.send("/v1/answers/answer_first_write", sent, f.token)).status).toBe(409);
  expect(f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.ask.qitemId)).toEqual({ n: 0 });
  expect(f.log.countAll()).toBe(0);
});

it("does not advertise a functional job when the current registry or schema is unavailable", async () => {
  const f = await jobFixture();
  const registryRead = vi.spyOn(f.repo, "humanRegistry").mockReturnValueOnce({ ok: false, error: "fixture registry unavailable" });
  const response = await f.send("/v1/capabilities", undefined, f.token);
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "app_job_unavailable" }); registryRead.mockRestore();
  f.db.exec("DROP TABLE core_app_submissions");
  const schema = await f.send("/v1/capabilities", undefined, f.token);
  expect(schema.status).toBe(503); expect(await schema.json()).toEqual({ error: "app_job_unavailable" });
});

it.each(["handover", "withdrawal"] as const)("fences a typed permission answer when %s makes the live request unavailable during its return await", async change => {
  const f = await permissionFixture();
  const original = f.repo.createHumanAnswer.bind(f.repo), before = f.repo.getById(f.askId)!;
  const binding = { job: "human-answer", actor: PERSON, requestId: f.askId, questionId: "permission", episodeKey: null,
    expectedRevision: f.repo.decisionRevision(before), answer: { kind: "typed-reply", text: "Please allow this" } };
  let afterInterventionSeq = -1;
  vi.spyOn(f.repo, "createHumanAnswer").mockImplementationOnce(async input => {
    const returned = await original(input);
    if (change === "handover") {
      f.sessions.registerSession(f.node.id, "runner@test", "handover");
      expect(f.repo.decisionRevision(f.repo.getById(f.askId)!)).toBe(binding.expectedRevision);
    } else {
      expect(f.permissions.withdraw(null, f.askId, "turn_ended")).toMatchObject({ state: "withdrawn" });
    }
    afterInterventionSeq = f.bus.maxSeq();
    return returned;
  });
  const answerId = `answer_live_${change}`;
  const response = await f.send(`/v1/answers/${answerId}`, binding, f.token);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ retrySameSubmission: false });
  expect(f.repo.getById(f.askId)?.humanAnswers ?? {}).toEqual({});
  expect(f.repo.relatedTo(f.askId).filter(edge => edge.relation === "handed-off-from")).toEqual([]);
  expect(f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.askId)).toEqual({ n: 0 });
  expect(f.log.countAll()).toBe(0); expect(f.bus.maxSeq()).toBe(afterInterventionSeq);
  const changes = f.db.prepare("SELECT total_changes() n").get();
  const status = await f.send(`/v1/answers/${answerId}?actor=${encodeURIComponent(PERSON)}`, undefined, f.token);
  expect(await status.json()).toMatchObject({ submission: { state: "conflict" }, retrySameSubmission: false });
  expect((await f.send(`/v1/answers/${answerId}`, binding, f.token)).status).toBe(409);
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
});

it("keeps an original committed permission receipt immutable after a later generation handover", async () => {
  const f = await permissionFixture(), ask = f.repo.getById(f.askId)!;
  const binding = { job: "human-answer", actor: PERSON, requestId: f.askId, questionId: "permission", episodeKey: null,
    expectedRevision: f.repo.decisionRevision(ask), answer: { kind: "option", optionId: "allow" } };
  const first = await f.send("/v1/answers/answer_committed_generation", binding, f.token);
  expect(first.status).toBe(200); const receipt = await first.json();
  await new Promise(resolve => setImmediate(resolve));
  f.sessions.registerSession(f.node.id, "runner@test", "handover");
  const changes = f.db.prepare("SELECT total_changes() n").get(), seq = f.bus.maxSeq();
  const replay = await f.send("/v1/answers/answer_committed_generation", binding, f.token);
  expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ submission: receipt.submission, replayed: true });
  expect(await (await f.send(`/v1/answers/answer_committed_generation?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json())
    .toMatchObject({ submission: receipt.submission, replayed: true });
  expect(await (await f.send(`/v1/requests/${f.askId}/result?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json())
    .toMatchObject({ permissionDecision: { status: "stale", nativeEffect: "unknown" } });
  expect(f.log.countAll()).toBe(1); expect(f.bus.maxSeq()).toBe(seq);
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
});

it("retains an unfinished permission submission's own choice/checkpoint while ending retry authority after handover", async () => {
  const f = await permissionFixture(), ask = f.repo.getById(f.askId)!;
  const binding = { job: "human-answer", actor: PERSON, requestId: f.askId, questionId: "permission", episodeKey: null,
    expectedRevision: f.repo.decisionRevision(ask), answer: { kind: "option", optionId: "allow" } };
  vi.spyOn(f.repo, "createHumanAnswer").mockRejectedValueOnce(new Error("fixture interruption after choice, before return"));
  expect((await f.send("/v1/answers/answer_choice_generation", binding, f.token)).status).toBe(503);
  expect(f.repo.getById(f.askId)?.humanAnswers).toEqual({ permission: "allow" });
  const path = `/v1/answers/answer_choice_generation?actor=${encodeURIComponent(PERSON)}`;
  expect(await (await f.send(path, undefined, f.token)).json()).toMatchObject({ submission: { state: "incomplete" }, retrySameSubmission: true });
  const evidence = f.db.prepare("SELECT binding_json, checkpoint_json, receipt_json FROM core_app_submissions WHERE answer_id = ?").get("answer_choice_generation");
  f.sessions.registerSession(f.node.id, "runner@test", "handover");
  const changes = f.db.prepare("SELECT total_changes() n").get(), seq = f.bus.maxSeq();
  expect(await (await f.send(path, undefined, f.token)).json()).toMatchObject({ submission: { state: "conflict", conflictCode: "request_stale" }, retrySameSubmission: false });
  expect((await f.send("/v1/answers/answer_choice_generation", binding, f.token)).status).toBe(409);
  expect(f.db.prepare("SELECT binding_json, checkpoint_json, receipt_json FROM core_app_submissions WHERE answer_id = ?").get("answer_choice_generation")).toEqual(evidence);
  expect(f.repo.getById(f.askId)?.humanAnswers).toEqual({ permission: "allow" });
  expect(f.repo.relatedTo(f.askId)).toEqual([]); expect(f.log.countAll()).toBe(0);
  expect(f.bus.maxSeq()).toBe(seq); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
});


it.each(["unanswered", "answered"] as const)("treats a permission ask whose node was positively deleted as stale, not an outage (%s)", async kind => {
  const f = await permissionFixture(), ask = f.repo.getById(f.askId)!;
  const binding = { job: "human-answer", actor: PERSON, requestId: f.askId, questionId: "permission", episodeKey: null,
    expectedRevision: f.repo.decisionRevision(ask), answer: { kind: "option", optionId: "allow" } };
  let receipt: { submission: unknown } | undefined;
  if (kind === "answered") {
    const first = await f.send("/v1/answers/answer_before_delete", binding, f.token);
    expect(first.status).toBe(200); receipt = await first.json();
    await new Promise(resolve => setImmediate(resolve));
  }
  f.db.prepare("DELETE FROM nodes WHERE id = ?").run(f.node.id);
  expect(f.db.prepare("SELECT COUNT(*) n FROM occupant_tenures WHERE node_id = ?").get(f.node.id)).toEqual({ n: 0 });
  const seq = f.bus.maxSeq(), changes = f.db.prepare("SELECT total_changes() n").get();
  // Positive absence is stale in result metadata too (not unknown); an answered ask keeps its original saved receipt.
  const result = await f.send(`/v1/requests/${f.askId}/result?actor=${encodeURIComponent(PERSON)}`, undefined, f.token);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ permissionDecision: { status: "stale", nativeEffect: "unknown" },
    ...(receipt ? { submissions: expect.arrayContaining([expect.objectContaining({ answerId: "answer_before_delete", submission: receipt.submission })]) } : {}) });
  const response = await f.send(`/v1/requests/${f.askId}?actor=${encodeURIComponent(PERSON)}`, undefined, f.token);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ requestId: f.askId, answer: null, unsupportedReason: kind === "answered" ? "request_not_pending" : "request_stale" });
  const needs = await (await f.send(`/v1/needs-me?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json();
  expect(needs.sources).toEqual([{ source: "queue", state: "available" }]); expect(needs.requests).toEqual([]);
  expect(f.bus.maxSeq()).toBe(seq); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
});

// Unknown agent authority (no tenure for an existing node, or an unreadable read) is neither current nor replaced. The person's
// question, the facts and an attributed answer stay; only positive replacement or absence ends an ask.
const unreadableTenure = (cause: "missing" | "failed") => vi.spyOn(SessionRegistry.prototype, "currentOccupantTenure").mockImplementation(() => {
  if (cause === "failed") throw new Error("fixture tenure read unavailable");
  return null;
});
const permissionBinding = (f: Awaited<ReturnType<typeof permissionFixture>>, answer: unknown) => ({ job: "human-answer", actor: PERSON, requestId: f.askId,
  questionId: "permission", episodeKey: null, expectedRevision: f.repo.decisionRevision(f.repo.getById(f.askId)!), answer });

it.each(["missing", "failed"] as const)("keeps showing a permission question, its facts and its answer forms with an unknown qualifier through a %s tenure read, one probe per item", async cause => {
  const f = await permissionFixture();
  const ordinary = await f.repo.create({ sourceSession: "builder@test", destinationSession: PERSON, body: "Ordinary ask", humanIntent: "decision",
    humanQuestions: [questions[0]!], nudge: false });
  const real = SessionRegistry.prototype.currentOccupantTenure; let reads = 0;
  const fault = unreadableTenure(cause);
  fault.mockImplementation(function (this: SessionRegistry, nodeId: string) { reads++; if (cause === "failed") throw new Error("tenure read lost"); return null; });
  try {
    const needs = await (await f.send(`/v1/needs-me?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json();
    expect(reads).toBe(1);
    expect(needs.sources).toEqual([{ source: "queue", state: "available" }]);
    expect(needs.requests.map((r: any) => r.requestId).sort()).toEqual([f.askId, ordinary.qitemId].sort());
    const unknown = needs.requests.find((r: any) => r.requestId === f.askId);
    expect(unknown).toMatchObject({ occupantAuthority: "unknown", state: "pending", body: expect.stringContaining("Write report"),
      questions: [expect.objectContaining({ id: "permission" })], answer: { job: "human-answer", forms: ["option", "typed-reply"] } });
    expect(unknown.unsupportedReason).toBeUndefined();
    expect(needs.requests.find((r: any) => r.requestId === ordinary.qitemId).occupantAuthority).toBeUndefined();
    const status = await f.send(`/v1/requests/${f.askId}?actor=${encodeURIComponent(PERSON)}`, undefined, f.token);
    expect(status.status).toBe(200); expect(await status.json()).toMatchObject({ occupantAuthority: "unknown", answer: { job: "human-answer" } });
    const seq = f.bus.maxSeq(), changes = f.db.prepare("SELECT total_changes() n").get();
    const result = await f.send(`/v1/requests/${f.askId}/result?actor=${encodeURIComponent(PERSON)}`, undefined, f.token);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ request: { occupantAuthority: "unknown" }, permissionDecision: { status: "unknown", reason: "occupant_unavailable", nativeEffect: "unknown" } });
    expect(f.bus.maxSeq()).toBe(seq); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes); expect(f.repo.getById(f.askId)?.state).toBe("pending");
  } finally { fault.mockRestore(); }
  void real;
  const healthy = await (await f.send(`/v1/needs-me?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json();
  expect(healthy.requests.find((r: any) => r.requestId === f.askId).occupantAuthority).toBeUndefined();
});

it.each(["option", "typed"] as const)("saves a person's %s answer through the owner while the agent's authority is unknown, with no native effect, successor or stale cancel", async form => {
  for (const cause of ["missing", "failed"] as const) {
    for (const mode of ["decider", "keep", "none"] as const) {
      const f = await permissionFixture(mode === "decider" ? true : mode === "keep" ? "keep" : false);
      const binding = permissionBinding(f, form === "option" ? { kind: "option", optionId: "allow" } : { kind: "typed-reply", text: "Please allow this once" });
      const answerId = `answer_${form}_${cause}_${mode}`, path = `/v1/answers/${answerId}`, label = [form, cause, mode];
      const fault = unreadableTenure(cause);
      let receipt: any;
      try {
        const response = await f.send(path, binding, f.token);
        expect([...label, response.status]).toEqual([...label, 200]);
        receipt = await response.json();
        expect(receipt).toMatchObject({ actor: { address: PERSON }, requestId: f.askId, replayed: false, submission: { state: "committed", outcome: "answered" } });
        // The owner's own words: handed to the receiving agent, or kept; an ask with no decider wired closes as it always did.
        expect(receipt.submission.message).toEqual(mode === "decider" ? expect.stringContaining("went to lead@test, the receiving agent")
          : mode === "keep" ? expect.stringContaining("is kept on") : undefined);
        // Saved through the owner: the person's attributed answer is on the exact ask; never stale-closed, and no native read grants it.
        const ask = f.repo.getById(f.askId)!;
        expect([...label, ask.state]).toEqual([...label, mode === "decider" ? "handed-off" : mode === "keep" ? "pending" : "done"]);
        expect(ask.humanAnswers?.permission).toEqual(form === "option" ? "allow" : expect.objectContaining({ kind: "typed-reply", text: "Please allow this once" }));
        expect(f.repo.listTransitions(f.askId).some(t => t.transitionNote?.startsWith("runner-permission-stale"))).toBe(false);
        expect(f.db.prepare("SELECT actor_session FROM mission_control_actions WHERE qitem_id = ?").all(f.askId)).toEqual([{ actor_session: PERSON }]); // attributed to the person
        expect(f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE handed_off_from = ?").get(f.askId)).toEqual({ n: mode === "decider" ? 1 : 0 });
        if (cause === "missing") expect(f.permissions.read(null, f.askId)).toMatchObject({ ok: true, state: "pending" });
        expect(f.log.countAll()).toBe(1);
      } finally { fault.mockRestore(); }
      // Authority for the same generation returns: the saved receipt replays; no second write, handoff or native effect.
      await new Promise(resolve => setImmediate(resolve));
      const seq = f.bus.maxSeq(), changes = f.db.prepare("SELECT total_changes() n").get();
      const replay = await f.send(path, binding, f.token);
      expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ ...receipt, replayed: true });
      expect(f.bus.maxSeq()).toBe(seq); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
      expect(f.permissions.read(null, f.askId)).not.toMatchObject({ state: "stale" });
      expect(f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE handed_off_from = ?").get(f.askId)).toEqual({ n: mode === "decider" ? 1 : 0 });
      // A positive successor then makes it stale, and the original receipt is unchanged.
      f.sessions.registerSession(f.node.id, "runner@test", "handover");
      expect(f.permissions.read(null, f.askId)).toMatchObject({ ok: true, state: "stale" });
      expect(await (await f.send(path, binding, f.token)).json()).toEqual({ ...receipt, replayed: true });
      expect(await (await f.send(`${path}?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json()).toMatchObject({ submission: receipt.submission, replayed: true });
      expect(f.log.countAll()).toBe(1);
    }
  }
});

it("still fences a new answer when the seat is positively replaced or gone, before storing anything", async () => {
  for (const change of ["replaced", "absent"] as const) {
    const f = await permissionFixture(), binding = permissionBinding(f, { kind: "option", optionId: "allow" });
    if (change === "replaced") f.sessions.registerSession(f.node.id, "runner@test", "handover"); else f.db.prepare("DELETE FROM nodes WHERE id = ?").run(f.node.id);
    const response = await f.send(`/v1/answers/answer_${change}_fence`, binding, f.token);
    expect([change, response.status, (await response.json()).error]).toEqual([change, 422, "request_stale"]);
    expect(f.db.prepare("SELECT COUNT(*) n FROM core_app_submissions").get()).toEqual({ n: 0 });
    expect(f.repo.getById(f.askId)?.humanAnswers ?? {}).toEqual({}); expect(f.log.countAll()).toBe(0);
  }
});

it.each(["missing", "failed"] as const)("recovers an unfinished permission answer through a %s tenure read as incomplete, then commits once and replays", async cause => {
  const f = await permissionFixture(), binding = permissionBinding(f, { kind: "option", optionId: "allow" });
  const answerId = `answer_unfinished_${cause}`, path = `/v1/answers/${answerId}`;
  vi.spyOn(f.repo, "createHumanAnswer").mockRejectedValueOnce(new Error("fixture interruption after choice"));
  const interrupted = await f.send(path, binding, f.token);
  expect(interrupted.status).toBe(503);
  expect(await interrupted.json()).toMatchObject({ error: "submission_incomplete", retrySameSubmission: true, submission: { state: "incomplete" } });
  const fault = unreadableTenure(cause);
  let receipt: any;
  try {
    expect(await (await f.send(`${path}?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json()).toMatchObject({ submission: { state: "incomplete" }, retrySameSubmission: true });
    const recovered = await f.send(path, binding, f.token);
    expect(recovered.status).toBe(200); receipt = await recovered.json();
    expect(receipt.submission).toMatchObject({ state: "committed", outcome: "answered" });
  } finally { fault.mockRestore(); }
  await new Promise(resolve => setImmediate(resolve));
  const seq = f.bus.maxSeq(), changes = f.db.prepare("SELECT total_changes() n").get();
  expect(await (await f.send(path, binding, f.token)).json()).toEqual({ ...receipt, replayed: true });
  expect(f.log.countAll()).toBe(1); expect(f.bus.maxSeq()).toBe(seq); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
});

describe("honest 503 persistence status", () => {
  const body = (f: Awaited<ReturnType<typeof jobFixture>>) => f.binding();
  it("an initial reservation failure says unsaved only after the authoritative row proves absence, and the same ID then commits once", async () => {
    const f = await jobFixture(), sent = body(f), path = "/v1/answers/answer_unsaved01";
    f.db.exec("CREATE TRIGGER fixture_full BEFORE INSERT ON core_app_submissions BEGIN SELECT RAISE(ABORT, 'fixture database full'); END");
    const failed = await f.send(path, sent, f.token);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: "app_job_unavailable", answerId: "answer_unsaved01", submission: { state: "unsaved" }, retrySameSubmission: true });
    expect(f.db.prepare("SELECT COUNT(*) n FROM core_app_submissions").get()).toEqual({ n: 0 });
    expect(f.log.countAll()).toBe(0); expect(f.repo.getById(f.ask.qitemId)?.humanAnswers ?? {}).toEqual({});
    f.db.exec("DROP TRIGGER fixture_full");
    const retried = await f.send(path, sent, f.token);
    expect(retried.status).toBe(200); expect(await retried.json()).toMatchObject({ submission: { state: "committed" }, replayed: false });
    expect(f.log.countAll()).toBe(1);
  });
  it("a failed reservation does not deny a row the same ID already stored: a saved receipt wins, an incomplete row stays incomplete, and an unreadable recheck is unknown", async () => {
    const f = await jobFixture(), sent = body(f), path = "/v1/answers/answer_saved01";
    // A concurrent attempt stored the binding, then its owner write failed: incomplete, with the ask still answerable.
    vi.spyOn(f.repo, "recordHumanAnswer").mockImplementationOnce(() => { throw new Error("fixture queue write failure"); });
    expect((await f.send(path, sent, f.token)).status).toBe(503);
    const row = vi.spyOn(f.job as any, "row");
    // This attempt believes the ID is free, so its INSERT hits the existing key; the row recheck then decides what it may claim.
    const saved = { answerId: "answer_saved01", fixture: "receipt another attempt saved" };
    f.db.prepare("UPDATE core_app_submissions SET receipt_json = ? WHERE answer_id = ?").run(JSON.stringify(saved), "answer_saved01");
    row.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);
    const raced = await f.send(path, sent, f.token);
    expect(raced.status).toBe(200); expect(await raced.json()).toEqual({ ...saved, replayed: true });
    expect(f.log.countAll()).toBe(0); expect(f.repo.getById(f.ask.qitemId)?.humanAnswers ?? {}).toEqual({});
    // An unreadable recheck proves nothing about persistence: unknown, never unsaved.
    row.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined).mockImplementationOnce(() => { throw new Error("fixture row read lost"); });
    const unknown = await f.send(path, sent, f.token);
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toMatchObject({ error: "app_job_unavailable", submission: { state: "unknown" }, retrySameSubmission: true });
    // An existing incomplete row is never reported unsaved: the same ID finishes it, once.
    f.db.prepare("UPDATE core_app_submissions SET receipt_json = NULL WHERE answer_id = ?").run("answer_saved01");
    row.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);
    const finished = await f.send(path, sent, f.token);
    expect(finished.status).toBe(200); expect(await finished.json()).toMatchObject({ submission: { state: "committed" } });
    row.mockRestore();
    expect(f.log.countAll()).toBe(1); expect(f.db.prepare("SELECT COUNT(*) n FROM core_app_submissions").get()).toEqual({ n: 1 });
  });
  it("an unreadable registry at binding is unknown and never exposes a saved receipt without a verified actor", async () => {
    const f = await jobFixture(), sent = body(f), path = "/v1/answers/answer_unknown01";
    const first = await (await f.send(path, sent, f.token)).json();
    const credential = f.access.authenticate(`Bearer ${f.token}`);
    vi.spyOn(f.repo, "humanRegistry").mockReturnValueOnce({ ok: false, error: "fixture registry unavailable" });
    await expect(f.job.submit(credential, "answer_unknown01", sent)).rejects.toMatchObject({ code: "app_job_unavailable", status: 503,
      details: { answerId: "answer_unknown01", submission: { state: "unknown" }, retrySameSubmission: true } });
    // Through the route the same outage fails credential authentication first: nothing is claimed, saved or unsaved.
    vi.spyOn(f.repo, "humanRegistry").mockReturnValue({ ok: false, error: "fixture registry unavailable" });
    const down = await f.send(path, sent, f.token);
    expect(down.status).toBe(503); expect(await down.json()).toEqual({ error: "app_job_unavailable" });
    vi.restoreAllMocks();
    expect(await (await f.send(path, sent, f.token)).json()).toEqual({ ...first, replayed: true });
  });
  it.each(["none", "row", "recovery"] as const)("a Queue write failure with %s classification read failure retains the same recoverable ID", async fault => {
    const f = await jobFixture(), sent = body(f), path = "/v1/answers/answer_incomplete01";
    let readFault: { mockRestore(): void } | undefined;
    vi.spyOn(f.repo, "recordHumanAnswer").mockImplementationOnce(() => {
      if (fault !== "none") readFault = vi.spyOn(f.job as any, fault).mockImplementationOnce(() => { throw new Error("fixture classification read failure"); });
      throw new Error("fixture queue write failure");
    });
    const failed = await f.send(path, sent, f.token);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: fault === "none" ? "submission_incomplete" : "app_job_unavailable", answerId: "answer_incomplete01", submission: { state: fault === "none" ? "incomplete" : "unknown" }, retrySameSubmission: true });
    readFault?.mockRestore();
    expect(f.db.prepare("SELECT COUNT(*) n FROM core_app_submissions WHERE binding_json IS NOT NULL").get()).toEqual({ n: 1 });
    expect(f.repo.getById(f.ask.qitemId)?.humanAnswers ?? {}).toEqual({}); expect(f.log.countAll()).toBe(0);
    const status = await (await f.send(`${path}?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json();
    expect(status).toMatchObject({ submission: { state: "incomplete" }, retrySameSubmission: true }); expect(JSON.stringify(status)).not.toContain("recordedAt");
    const retried = await f.send(path, sent, f.token);
    expect(retried.status).toBe(200); const receipt = await retried.json(); expect(receipt).toMatchObject({ submission: { state: "committed" } });
    await new Promise(resolve => setImmediate(resolve));
    const seq = f.bus.maxSeq(), changes = f.db.prepare("SELECT total_changes() n").get();
    expect(await (await f.send(path, sent, f.token)).json()).toEqual({ ...receipt, replayed: true });
    expect(f.log.countAll()).toBe(1); expect(f.bus.maxSeq()).toBe(seq); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
    expect(f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(f.ask.qitemId)).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT COUNT(*) n FROM core_app_submissions").get()).toEqual({ n: 1 });
  });
});

describe("the owner's final answer message", () => {
  it("keeps the owner's kept-answer message in the immutable receipt and in an identical replay", async () => {
    const f = await permissionFixture("keep"), binding = permissionBinding(f, { kind: "option", optionId: "allow" });
    const first = await f.send("/v1/answers/answer_kept_message", binding, f.token);
    expect(first.status).toBe(200); const receipt = await first.json();
    expect(receipt.submission).toMatchObject({ state: "committed", outcome: "answered",
      message: expect.stringContaining(`Your answer is kept on ${f.askId}, and the request is still waiting: the tool hasn't run, and nothing was permitted or refused.`) });
    await new Promise(resolve => setImmediate(resolve));
    const seq = f.bus.maxSeq(), changes = f.db.prepare("SELECT total_changes() n").get();
    const replay = await (await f.send("/v1/answers/answer_kept_message", binding, f.token)).json();
    expect(replay).toEqual({ ...receipt, replayed: true });
    expect(await (await f.send(`/v1/answers/answer_kept_message?actor=${encodeURIComponent(PERSON)}`, undefined, f.token)).json()).toMatchObject({ ...receipt, replayed: true });
    expect(f.log.countAll()).toBe(1); expect(f.db.prepare("SELECT COUNT(*) n FROM mission_control_actions WHERE qitem_id = ?").get(f.askId)).toEqual({ n: 1 });
    expect(f.bus.maxSeq()).toBe(seq); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
    expect(f.db.prepare("SELECT audit_notes_json FROM mission_control_actions WHERE qitem_id = ?").get(f.askId)).toMatchObject({ audit_notes_json: expect.stringContaining("nothing was permitted or refused") });
  });
  it.each([true, "keep"] as const)("computes the final answer once: the receipt's message is the ordinary return's (decider %s)", async receiving => {
    const f = await permissionFixture(receiving); let finalized: unknown;
    const result = await f.writes.act({ verb: "answer", qitemId: f.askId, actorSession: PERSON, identityProvenance: "claimed:v1", questionId: "permission", optionId: "allow",
      appSubmission: { verify: () => {}, checkpoint: () => {}, finalize: done => { finalized = done.answer; return { fixture: true }; } } });
    expect(finalized).toEqual(result.answer);
    expect(result.answer?.message).toEqual(receiving === true ? expect.stringContaining("went to lead@test, the receiving agent") : expect.stringContaining("is kept on"));
    await new Promise(resolve => setImmediate(resolve));
  });
});
