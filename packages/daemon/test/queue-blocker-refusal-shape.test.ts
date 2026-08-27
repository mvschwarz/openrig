// F1 (error-honesty, desk-approved light path): an ERROR payload must never carry a
// SUCCESS-SHAPED field. The three blocker refusals carried `blockedOn` in their meta — the
// same key the success shape uses — which invited the field-filtered misread behind the
// phantom queue-block defect (three independent specimens, one class). The refusals now name
// the rejected value as `rejectedBlocker`; `blockedOn` appears in an error payload never.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";

describe("F1 — blocker refusal payloads carry rejectedBlocker, never the success-shaped blockedOn", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => db.close());

  async function refusalMeta(blockedOn: string, prep?: () => Promise<void>): Promise<{ code: string; meta: Record<string, unknown> }> {
    const row = await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "target" });
    await prep?.();
    try {
      repo.update({ qitemId: row.qitemId, actorSession: "a@r", state: "blocked", blockedOn, transitionNote: "park attempt" });
    } catch (err) {
      const e = err as QueueRepositoryError;
      return { code: e.code, meta: (e.meta ?? {}) as Record<string, unknown> };
    }
    throw new Error("expected a refusal");
  }

  it("blocker_not_found: rejectedBlocker named; blockedOn ABSENT from the payload", async () => {
    const r = await refusalMeta("qitem-19990101000000-deadbeef");
    expect(r.code).toBe("blocker_not_found");
    expect(r.meta.rejectedBlocker).toBe("qitem-19990101000000-deadbeef");
    expect("blockedOn" in r.meta, "an error payload must never carry the success-shaped field").toBe(false);
  });

  it("blocker_not_live: rejectedBlocker + blockerState named; blockedOn ABSENT", async () => {
    const dead = await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "dead blocker" });
    repo.update({ qitemId: dead.qitemId, actorSession: "a@r", state: "done", closureReason: "no-follow-on", transitionNote: "closed" });
    const r = await refusalMeta(dead.qitemId);
    expect(r.code).toBe("blocker_not_live");
    expect(r.meta.rejectedBlocker).toBe(dead.qitemId);
    expect(r.meta.blockerState).toBe("done");
    expect("blockedOn" in r.meta).toBe(false);
  });

  it("blocker_malformed: rejectedBlocker named; blockedOn ABSENT", async () => {
    const r = await refusalMeta("fold:");
    expect(r.code).toBe("blocker_malformed");
    expect(r.meta.rejectedBlocker).toBe("fold:");
    expect("blockedOn" in r.meta).toBe(false);
  });

  it("the SUCCESS shape is untouched: a valid park still returns blockedOn on the item", async () => {
    const blocker = await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "live blocker" });
    const row = await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "target" });
    const updated = repo.update({ qitemId: row.qitemId, actorSession: "a@r", state: "blocked", blockedOn: blocker.qitemId, transitionNote: "parked" });
    expect(updated.state).toBe("blocked");
    expect(updated.blockedOn).toBe(blocker.qitemId);
  });
});
