// Decisions made on a person's behalf: inside the decision room of the mode they have on, the agent that would have
// asked them decides and records it on the ask's own row, beside the person's answers and never as one. Through the real
// queue and gateway routes with a temp home (real person records), the real SQLite schema and the real mode records.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { queueRoutes } from "../src/routes/queue.js";
import { addHumanFragment, loadHumanRegistry } from "../src/domain/gateway/human-registry.js";
import { PROMPT_ALERT_TAG } from "../src/domain/queue-wake-ladder.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const questions = [
  { id: "design", question: "Which design?", options: [{ id: "a", label: "Layout A", recommended: true }, { id: "b", label: "Layout B" }] },
  { id: "ship", question: "Ship it this week?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
];
const room = { words: "decide the design choices you'd normally ask me about", exclusions: ["publishing", "spending"] };

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "delegated-")); homes.push(home);
  for (const id of ["alex", "sam"]) {
    expect(addHumanFragment({ entityId: id, class: "human", displayName: id, address: `${id}@external`, prefs: { deliveryClass: "B" },
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://fixture", role: "primary", handle: `U-${id.toUpperCase()}` }] }, home).ok).toBe(true);
  }
  const db = createDb();
  migrate(db, ALL_MIGRATIONS); // the real schema: a row's summary is the question of an ask without structured ones
  const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => loadHumanRegistry(home) });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("db" as never, db as never); c.set("queueRepo" as never, repo as never); await next(); });
  app.route("/api/gateway", gatewayRoutes({ home }));
  app.route("/api/queue", queueRoutes());
  const call = async (method: string, path: string, body?: unknown, session = "operator@kernel") => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json", ...(session ? { "X-OpenRig-Session": session } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const ask = (extra: Record<string, unknown> = {}) => repo.create({ sourceSession: "designer@rig", destinationSession: "alex@external",
    summary: "Two choices for the landing page", body: "Pick a layout and whether to ship.", evidenceRef: "/proof/landing.md",
    humanIntent: "decision", humanQuestions: questions, nudge: false, ...extra } as never) as Promise<QueueItem>;
  const modeOn = async (entityId: string, withRoom: boolean) => {
    await call("PUT", `/api/gateway/human/${entityId}/modes/asleep`, { availability: "away", ...(withRoom ? { decisionRoom: room.words, exclusions: room.exclusions } : {}) });
    return (await call("POST", `/api/gateway/human/${entityId}/modes/asleep/apply`, {})).body.application as Record<string, any>;
  };
  // Decide as an asking agent does: read the room first and pass its application id, unless a test sets one (null: none).
  const decide = async (qitemId: string, body: Record<string, unknown>, session = "designer@rig") => {
    const read = (await call("GET", "/api/gateway/human/alex/decision-room")).body.decisionRoom?.applicationId ?? "no-room-read";
    const { applicationId, ...rest } = body;
    return call("POST", `/api/queue/${qitemId}/delegated-decision`,
      { ...rest, ...(applicationId === null ? {} : { applicationId: applicationId || read }) }, session);
  };
  const choose = { applicationId: "", choices: [{ questionId: "design", chosen: "a" }, { questionId: "ship", chosen: "yes" }], reason: "A is the recommended layout and it's ready", reversible: true };
  return { db, repo, call, ask, modeOn, decide, choose };
}

describe("a decision made on the person's behalf", () => {
  it("inside the room: every field recorded on the row, humanAnswers untouched, the ask closed but not answered by the person, and findable for the application", async () => {
    const f = fixture();
    const app = await f.modeOn("alex", true);
    const row = await f.ask();
    const res = await f.decide(row.qitemId, f.choose);
    expect(res.status).toBe(200);
    const item = f.repo.getById(row.qitemId)!;
    expect(item.delegatedDecision).toEqual({
      applicationId: app.applicationId, modeName: "asleep", decisionRoom: room, decidedBy: "designer@rig", decidedAt: expect.any(String),
      choices: [
        { questionId: "design", question: "Which design?", options: [{ id: "a", label: "Layout A" }, { id: "b", label: "Layout B" }], chosen: "a" },
        { questionId: "ship", question: "Ship it this week?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], chosen: "yes" },
      ],
      reason: "A is the recommended layout and it's ready", reversible: true,
    });
    expect(item.humanAnswers).toBeNull();
    expect(item).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    const transitions = f.repo.listTransitions(row.qitemId);
    expect(transitions.some((t) => t.ownerNotificationKind === "human-decision-resolved"), "never recorded as the person's own resolution").toBe(false);
    expect(transitions.at(-1)!.transitionNote).toMatch(/^delegated-decision application=.* decided on alex's behalf by designer@rig, not answered by them$/);
    const listed = await f.call("GET", `/api/gateway/human/alex/mode/applications/${app.applicationId}/decisions`);
    expect(listed.body.decisions).toEqual([expect.objectContaining({ qitemId: row.qitemId, sourceSession: "designer@rig", decision: item.delegatedDecision })]);
  });

  it("an agent can read the decision room before it decides: the person's own words, or none", async () => {
    const f = fixture();
    expect((await f.call("GET", "/api/gateway/human/alex/decision-room")).body).toMatchObject({ decisionRoom: null, why: expect.stringMatching(/^at desk/) });
    const app = await f.modeOn("alex", true);
    expect((await f.call("GET", "/api/gateway/human/alex/decision-room")).body.decisionRoom).toEqual({ applicationId: app.applicationId, modeName: "asleep", ...room });
    await f.modeOn("sam", false);
    expect((await f.call("GET", "/api/gateway/human/sam/decision-room")).body).toMatchObject({ decisionRoom: null, why: "asleep has no decision room, so nothing is decided for them" });
  });

  it("an ask without structured questions records its subject as the question and the choice in words", async () => {
    const f = fixture();
    await f.modeOn("alex", true);
    const row = await f.ask({ humanQuestions: undefined });
    const res = await f.decide(row.qitemId, { choices: [{ chosen: "go with the smaller change" }], reason: "it's inside the stated room", reversible: false });
    expect(res.status).toBe(200);
    expect(f.repo.getById(row.qitemId)!.delegatedDecision).toMatchObject({ choices: [{ questionId: null, question: "Two choices for the landing page", options: [], chosen: "go with the smaller change" }], reversible: false });
  });
});

describe("refused: nothing is decided for the person", () => {
  it("with no mode on (at desk)", async () => {
    const f = fixture();
    const row = await f.ask();
    expect(await f.decide(row.qitemId, f.choose)).toMatchObject({ status: 409, body: { error: "no-active-mode" } });
    expect(f.repo.getById(row.qitemId)).toMatchObject({ state: "pending", delegatedDecision: null });
  });

  it("with a mode on whose decision room is empty (M4: no room, nothing decided)", async () => {
    const f = fixture();
    await f.modeOn("alex", false);
    const row = await f.ask();
    expect(await f.decide(row.qitemId, f.choose)).toMatchObject({ status: 409, body: { error: "no-decision-room" } });
    expect(f.repo.getById(row.qitemId)).toMatchObject({ state: "pending", delegatedDecision: null });
  });

  it("with another person's mode: sam's room doesn't cover an ask to alex", async () => {
    const f = fixture();
    await f.modeOn("sam", true);
    const row = await f.ask();
    expect(await f.decide(row.qitemId, f.choose)).toMatchObject({ status: 409, body: { error: "no-active-mode" } });
    // At the recorder itself, an application that isn't the asked person's is refused by name.
    const direct = f.repo.recordDelegatedDecision({ qitemId: row.qitemId, actorSession: "designer@rig", choices: f.choose.choices, reason: "x", reversible: true,
      expectedApplicationId: "app-sam", currentApplication: () => ({ applicationId: "app-sam", entityId: "sam", modeName: "asleep", decisionRoom: room }) });
    expect(direct).toMatchObject({ status: "refused", reason: "not-the-persons-mode" });
  });

  it.each([["a permission prompt", { tags: [PROMPT_ALERT_TAG] }], ["an approval gate", { tier: "human-gate" }],
    ["an approval gate by tag", { tags: ["gate:human"] }]])("on %s, even inside the room", async (_kind, extra) => {
    const f = fixture();
    await f.modeOn("alex", true);
    const row = await f.ask(extra);
    expect(await f.decide(row.qitemId, f.choose)).toMatchObject({ status: 409, body: { error: "permission-prompt" } });
    expect(f.repo.getById(row.qitemId)).toMatchObject({ state: "pending", delegatedDecision: null });
  });

  it("once the person has started answering, the ask is theirs: refused, and their answer stands", async () => {
    const f = fixture();
    await f.modeOn("alex", true);
    const row = await f.ask();
    expect(f.repo.recordHumanAnswer({ qitemId: row.qitemId, actorSession: "alex@external", questionId: "design", optionId: "b" }))
      .toMatchObject({ status: "recorded" });
    expect(await f.decide(row.qitemId, f.choose)).toMatchObject({ status: 409, body: { error: "person-answering" } });
    expect(f.repo.getById(row.qitemId)).toMatchObject({ state: "pending", delegatedDecision: null, humanAnswers: { design: "b" } });
  });

  it("the mode is read when the decision is recorded: one that ended in the meantime refuses it", async () => {
    const f = fixture();
    await f.modeOn("alex", true);
    const row = await f.ask();
    let reads = 0;
    const result = f.repo.recordDelegatedDecision({ qitemId: row.qitemId, actorSession: "designer@rig", choices: f.choose.choices, reason: "x", reversible: true,
      expectedApplicationId: "app-gone", currentApplication: (entityId) => { reads++; expect(entityId).toBe("alex"); return null; } }); // ended just before
    expect(result).toMatchObject({ status: "refused", reason: "no-active-mode" });
    expect(reads).toBe(1);
  });

  it("when their mode changed since the room was read: the decision isn't recorded under a room it wasn't judged against", async () => {
    const f = fixture();
    await f.modeOn("alex", true);
    const read = (await f.call("GET", "/api/gateway/human/alex/decision-room")).body.decisionRoom.applicationId as string;
    await f.call("PUT", "/api/gateway/human/alex/modes/out-of-office", { availability: "off", decisionRoom: "anything at all" });
    await f.call("POST", "/api/gateway/human/alex/modes/out-of-office/apply", {}); // a switch, to another mode with a room
    const row = await f.ask();
    expect(await f.decide(row.qitemId, { ...f.choose, applicationId: read })).toMatchObject({ status: 409,
      body: { error: "mode-changed", message: "their mode changed since you read the room; read it again" } });
    expect(f.repo.getById(row.qitemId)).toMatchObject({ state: "pending", delegatedDecision: null });
  });

  it("without the application id from reading the room: 400", async () => {
    const f = fixture();
    await f.modeOn("alex", true);
    const row = await f.ask();
    expect(await f.decide(row.qitemId, { ...f.choose, applicationId: null })).toMatchObject({ status: 400, body: { error: "application_required" } });
    expect(f.repo.getById(row.qitemId)).toMatchObject({ state: "pending", delegatedDecision: null });
  });

  it("by an agent other than the one that asked, or with an option that isn't offered", async () => {
    const f = fixture();
    await f.modeOn("alex", true);
    const row = await f.ask();
    expect(await f.decide(row.qitemId, f.choose, "someone-else@rig")).toMatchObject({ status: 409, body: { error: "not-the-asking-agent" } });
    expect(await f.decide(row.qitemId, { ...f.choose, choices: [{ questionId: "design", chosen: "c" }, { questionId: "ship", chosen: "yes" }] }))
      .toMatchObject({ status: 409, body: { error: "invalid-choice" } });
    expect(await f.decide(row.qitemId, { ...f.choose, choices: [{ questionId: "design", chosen: "a" }] })).toMatchObject({ status: 409, body: { error: "invalid-choice" } });
    expect((await f.decide(row.qitemId, { choices: f.choose.choices, reason: "x" })).status).toBe(400); // reversible must be said
    expect(f.repo.getById(row.qitemId)).toMatchObject({ state: "pending", delegatedDecision: null });
  });
});

describe("the person's own answers stay theirs", () => {
  it("recordHumanAnswer still refuses anyone but the asked person", async () => {
    const f = fixture();
    const row = await f.ask();
    expect(f.repo.recordHumanAnswer({ qitemId: row.qitemId, actorSession: "designer@rig", questionId: "design", optionId: "a" }))
      .toMatchObject({ status: "not-applicable", reason: "not-the-asked-human" });
    expect(f.repo.recordHumanAnswer({ qitemId: row.qitemId, actorSession: "alex@external", questionId: "design", optionId: "a" }))
      .toMatchObject({ status: "recorded" });
  });

  it("decisions are listed only under their own application", async () => {
    const f = fixture();
    const first = await f.modeOn("alex", true);
    const one = await f.ask();
    await f.decide(one.qitemId, f.choose);
    await f.call("POST", "/api/gateway/human/alex/mode/end", {});
    const second = await f.modeOn("alex", true);
    const two = await f.ask();
    await f.decide(two.qitemId, f.choose);
    const list = async (id: string) => ((await f.call("GET", `/api/gateway/human/alex/mode/applications/${id}/decisions`)).body.decisions as Array<Record<string, any>>).map((d) => d.qitemId);
    expect(await list(first.applicationId)).toEqual([one.qitemId]);
    expect(await list(second.applicationId)).toEqual([two.qitemId]);
    expect((await f.call("GET", `/api/gateway/human/sam/mode/applications/${first.applicationId}/decisions`)).status).toBe(404);
  });
});
