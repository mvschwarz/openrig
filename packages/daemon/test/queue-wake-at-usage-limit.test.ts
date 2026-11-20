import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { lastMeaningfulTransition } from "../src/domain/queue-waiting.js";
import { LADDER_ATTEMPT_PREFIX } from "../src/domain/queue-stuck-sweep.js";

// A queue wake that reached a seat at its usage limit keeps its receipt word (`verified`, `delivered-ack-pending`), which
// every reader knows, and the row gains one note saying the seat was at its limit and when it resets. The transport's
// result carries the reading (session-transport `usageLimit`); a wake whose text never reached the input has none.

const SEAT = "writer@demo";
const LIMIT = { asOf: "2026-11-19T19:40:00.000Z", resetsAt: "2026-11-19T23:00:00.000Z" };

describe("a queue wake at a seat's usage limit", () => {
  let db: Database.Database;
  let reply: Record<string, unknown>;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    reply = { ok: true, verified: true };
    repo = new QueueRepository(db, new EventBus(db), { transport: { send: async () => reply as never } });
    repo.attachOutbox(new OutboxHandler(db));
  });
  afterEach(() => db.close());

  const wake = async () => {
    const item = await repo.create({ sourceSession: "pm@demo", destinationSession: SEAT, body: "work", summary: "work" });
    await vi.waitFor(() => expect(repo.getById(item.qitemId)!.lastNudgeResult).not.toBeNull());
    const notes = repo.listTransitions(item.qitemId).map((t) => t.transitionNote ?? "").filter((note) => note.includes("usage limit"));
    return { row: repo.getById(item.qitemId)!, notes };
  };

  it.each([
    [{ ok: true, verified: true }, "verified"],
    [{ ok: true, verified: false }, "delivered-ack-pending"],
  ] as const)("a wake that reached the seat keeps its receipt word and the row says it won't be read before the reset", async (result, word) => {
    reply = { ...result, usageLimit: { ...LIMIT, notice: "context" } };
    const { row, notes } = await wake();
    expect(row.lastNudgeResult).toBe(word);
    expect(row.state).toBe("pending");
    expect(notes).toEqual([`wake reached ${SEAT}, or may have, at its usage limit (recorded ${LIMIT.asOf}; resets ${LIMIT.resetsAt}); delivery=${word}. Its agent isn't expected to read it before the reset.`]);
  });

  it("the note is bookkeeping: the row's last meaningful change and the ladder's attempts after it are kept", async () => {
    reply = { ok: true, verified: false };
    const { row } = await wake();
    // One ladder attempt, written as the ladder writes it.
    db.prepare("INSERT INTO queue_transitions (qitem_id, ts, state, transition_note, actor_session) VALUES (?, ?, ?, ?, ?)")
      .run(row.qitemId, new Date().toISOString(), row.state, `${LADDER_ATTEMPT_PREFIX} attempt=1 outcome=delivered-ack-pending`, "wake-ladder@system");
    const before = lastMeaningfulTransition(db, row.qitemId);
    // The ladder's count: attempt markers after the last meaningful transition (queue-wake-ladder readLadder).
    const attempts = () => (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? AND transition_id > ?")
      .all(row.qitemId, lastMeaningfulTransition(db, row.qitemId)?.id ?? 0) as Array<{ transition_note: string | null }>)
      .filter((t) => t.transition_note?.startsWith(LADDER_ATTEMPT_PREFIX)).length;
    expect(attempts()).toBe(1);

    reply = { ok: true, verified: false, usageLimit: { ...LIMIT, notice: "context" } };
    await repo.maybeNudge(row.qitemId, SEAT, undefined, "pm@demo");
    expect(repo.listTransitions(row.qitemId).some((t) => t.transitionNote?.startsWith(`wake reached ${SEAT}, or may have, at its usage limit`))).toBe(true);
    expect(lastMeaningfulTransition(db, row.qitemId)).toEqual(before);
    expect(attempts()).toBe(1);
  });

  it("a claimed row keeps its retained park blocker through the note", async () => {
    const { row } = await wake();
    repo.update({ qitemId: row.qitemId, actorSession: SEAT, state: "blocked", blockedOn: "external:fixture-gate", transitionNote: "parked" });
    repo.claim({ qitemId: row.qitemId, destinationSession: SEAT });
    expect(repo.retainedClaimBlocker(row.qitemId)).toBe("external:fixture-gate");

    reply = { ok: true, verified: true, usageLimit: { ...LIMIT, notice: "context" } };
    await repo.maybeNudge(row.qitemId, SEAT, undefined, "pm@demo");
    expect(repo.listTransitions(row.qitemId).at(-1)?.transitionNote).toMatch(/^wake reached .+ at its usage limit/);
    expect(repo.retainedClaimBlocker(row.qitemId)).toBe("external:fixture-gate");
  });

  it("the note names the session the wake was sent to", async () => {
    reply = { ok: true, verified: true, sessionName: "writer-replacement@demo", usageLimit: { ...LIMIT, notice: "context" } };
    const { notes } = await wake();
    expect(notes).toEqual([`wake reached writer-replacement@demo, or may have, at its usage limit (recorded ${LIMIT.asOf}; resets ${LIMIT.resetsAt}); delivery=verified. Its agent isn't expected to read it before the reset.`]);
  });

  it("control: a wake with no usage-limit reading adds no note", async () => {
    const { row, notes } = await wake();
    expect(row.lastNudgeResult).toBe("verified");
    expect(notes).toEqual([]);
  });

  it("control: a wake refused before any input adds no note, whatever the reply carries", async () => {
    reply = { ok: false, sent: false, inputPhase: "not_reached", error: "target_needs_input", usageLimit: { ...LIMIT, notice: "context" } };
    const { row, notes } = await wake();
    expect(row.lastNudgeResult).toBe("failed:target_needs_input");
    expect(notes).toEqual([]);
  });
});
