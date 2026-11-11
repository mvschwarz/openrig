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
  it("refuses provisioning without a configured operator bearer", async () => {
    const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); closes.push(() => db.close());
    const response = await createTestApp(db).app.request("/api/apps/v1/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "app_provisioning_unconfigured" });
  });
});

const PERSON = "human-test@external", OTHER = "human-other@external";
const registry = { ok: true as const, entities: [PERSON, OTHER].map(address => ({ entityId: address.split("@")[0]!, class: "human" as const,
  displayName: address, address, connectorBindings: [], prefs: { deliveryClass: "A" as const } })) };
function fixture(operatorToken: string | null = "operator") {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); closes.push(() => db.close());
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry,
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
  it("requires the configured operator and actual loopback socket to provision", async () => {
    const f = fixture(); const body = { appId: "test", actors: [PERSON], job: "human-answer", attribution: "app-attributed" };
    for (const peer of [null, "192.0.2.1"]) expect((await f.send("/v1/credentials", body, "operator", peer)).status).toBe(403);
    const token = (await (await f.provision()).json()).token;
    expect((await f.send("/v1/credentials", body, token)).status).toBe(401);
    expect((await f.send("/v1/credentials", body, null)).status).toBe(401);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM core_app_credentials").get()).toEqual({ n: 1 });
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
    f.db.prepare("UPDATE queue_items SET body = 'later changed body' WHERE qitem_id = ?").run(f.ask.qitemId);
    const replay = await f.send("/v1/answers/answer_0001", sent, f.token);
    expect(await replay.json()).toMatchObject({ replayed: true, submission: { actionId: receipt.submission.actionId, decisionRevisionAfter: originalRevision } });
    expect((await f.send("/v1/answers/answer_0001", { ...sent, actor: PERSON }, f.token)).status).toBe(409);
    expect(f.db.prepare("SELECT COUNT(*) n FROM mission_control_actions WHERE qitem_id = ?").get(f.ask.qitemId)).toEqual({ n: 1 });
  });
  it("records a partial option and its receipt atomically, while a later answer cannot replace the original receipt", async () => {
    const f = await jobFixture(true); const first = f.binding();
    const partial = await f.send("/v1/answers/answer_part1", first, f.token);
    expect(partial.status).toBe(200); const receipt = await partial.json();
    expect(receipt.submission).toMatchObject({ state: "committed", outcome: "recorded" });
    for (let i = 0; i < 55; i++) await f.writes.act({ verb: "annotate", qitemId: f.ask.qitemId, actorSession: PERSON, annotation: `later note ${i}` });
    expect((await f.send("/v1/answers/answer_part2", f.binding(OTHER, "q2"), f.token)).status).toBe(200);
    f.db.prepare("UPDATE core_app_submissions SET receipt_json = NULL WHERE answer_id = ?").run("answer_part1"); // immutable audit evidence still owns the original result
    expect(await (await f.send("/v1/answers/answer_part1", first, f.token)).json()).toMatchObject({ submission: receipt.submission, replayed: true });
    const read = await f.send(`/v1/answers/answer_part1?actor=${encodeURIComponent(OTHER)}`, undefined, f.token);
    expect(read.status).toBe(404);
  });
});


describe("submission interruption and fencing", () => {
  it("rolls a partial choice and receipt back when audit append fails; retry commits exactly once", async () => {
    const f = await jobFixture(true), binding = f.binding();
    const original = f.log.record.bind(f.log); vi.spyOn(f.log, "record").mockImplementationOnce(() => { throw new Error("fixture audit failure"); }).mockImplementation(original);
    const beforeSeq = f.bus.maxSeq();
    expect((await f.send("/v1/answers/answer_atomic", binding, f.token)).status).toBe(503);
    expect(f.repo.getById(f.ask.qitemId)?.humanAnswers ?? {}).toEqual({});
    expect(f.bus.maxSeq()).toBe(beforeSeq); expect(f.log.countAll()).toBe(0);
    expect(f.db.prepare("SELECT receipt_json FROM core_app_submissions").get()).toEqual({ receipt_json: null });
    expect((await f.send("/v1/answers/answer_atomic", binding, f.token)).status).toBe(200);
    expect(f.log.countAll()).toBe(1);
  });
  it.each(["typed-reply", "option"])("recovers an unclosed %s return after restart and nondecision annotations, including uncheckpointed own reply", async kind => {
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
    const seq = bus.maxSeq();
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
