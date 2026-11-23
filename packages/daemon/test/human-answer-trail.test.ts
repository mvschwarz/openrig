import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { resolveRecordedProvenance, IDENTITY_PROVENANCE_HEADER, RELAY_HEADER } from "../src/routes/require-sender-identity.js";
import type { Context } from "hono";

const person = "reader@external";
const registry = { ok: true as const, entities: [{ entityId: "reader", class: "human" as const, displayName: "Reader", address: person,
  connectorBindings: [], prefs: { deliveryClass: "A" as const } }] };
const questions = ["first", "second", "third"].map(id => ({ id, question: id,
  options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }));

describe("the human answer trail", () => {
  let db: ReturnType<typeof createFullTestDb>;
  let repo: QueueRepository;
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    db = createFullTestDb(); repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry }); });
  afterEach(() => { db.close(); vi.useRealTimers(); });
  const ask = () => repo.create({ sourceSession: "author@rig", destinationSession: person, summary: "Three questions", body: "Pick each.",
    evidenceRef: "/fixture/evidence", humanIntent: "decision", humanQuestions: questions, nudge: false });

  it("records each changed partial answer, its actor and time; duplicate and final clicks add nothing", async () => {
    const row = await ask();
    const answer = (questionId: string, optionId = "yes") => repo.recordHumanAnswer({ qitemId: row.qitemId, actorSession: person, questionId, optionId });
    const trail = () => repo.transitionLog.listForQitem(row.qitemId).filter(t => t.transitionNote?.startsWith("human-answer-recorded:"));
    for (const [index, questionId] of ["first", "second", "first", "third"].entries()) {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, index + 1)));
      expect(answer(questionId, index === 2 ? "no" : "yes")).toMatchObject({ status: "recorded", complete: index === 3 });
      expect(trail()).toHaveLength(index + 1);
      const transition = trail().at(-1)!;
      expect(transition).toMatchObject({ actorSession: person, state: "pending" });
      expect(JSON.parse(transition.transitionNote!.slice("human-answer-recorded: ".length)))
        .toEqual({ questionId, optionId: index === 2 ? "no" : "yes" });
      expect(repo.getById(row.qitemId)?.tsUpdated).toBe(new Date().toISOString());
      const ts = repo.getById(row.qitemId)!.tsUpdated;
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, index + 1, 30)));
      answer(questionId, index === 2 ? "no" : "yes");
      expect(trail()).toHaveLength(index + 1);
      expect(repo.getById(row.qitemId)?.tsUpdated).toBe(ts);
    }
    const before = repo.getById(row.qitemId)!;
    answer("third", "no");
    expect(repo.getById(row.qitemId)?.humanAnswers).toEqual(before.humanAnswers);
    expect(repo.getById(row.qitemId)?.tsUpdated).toBe(before.tsUpdated);
    expect(trail()).toHaveLength(4);
  });

  it("commits the answer, timestamp and transition together", async () => {
    const row = await ask();
    db.exec(`CREATE TRIGGER reject_answer_trail BEFORE INSERT ON queue_transitions
      WHEN NEW.transition_note LIKE 'human-answer-recorded:%'
      BEGIN SELECT RAISE(ABORT, 'injected answer trail failure'); END`);
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    expect(() => repo.recordHumanAnswer({ qitemId: row.qitemId, actorSession: person, questionId: "first", optionId: "yes" }))
      .toThrow("injected answer trail failure");
    expect(repo.getById(row.qitemId)).toMatchObject({ humanAnswers: null, tsUpdated: row.tsUpdated });
    expect(repo.transitionLog.listForQitem(row.qitemId)).toHaveLength(1);
  });

  it("does not promote gateway or unknown provenance into transport identity on a relay", () => {
    for (const carried of ["gateway:slack:v1", "future:v1"]) {
      const headers: Record<string, string> = { [RELAY_HEADER]: "true", [IDENTITY_PROVENANCE_HEADER]: carried };
      const context = { req: { header: (name: string) => headers[name] } } as unknown as Context;
      expect(resolveRecordedProvenance(context, { provenance: "transport:v1" })).toBe("claimed:v1");
    }
  });
});
