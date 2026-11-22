// #1933: a row held on an `external:` gate with no recorded wake is the owner's declared wait on an outside event. It
// reads as a healthy, event-only HELD: still listed with its blocker and last update, never a parked obligation, so no
// reminder fires for it. Every other hold reads as before, and anything that can't be read keeps today's reading.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { diagnoseSeatParked, PARKED_OBLIGATION_LIMIT, type ObligationRow, type ParkedQueryDeps } from "../src/domain/parked-query.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";

const SEAT = { seatNodeId: "node-1", sessionName: "owner@park-rig" };

function idle(): ArbitratedSeatState {
  return {
    seatNodeId: SEAT.seatNodeId, activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, needsInputEvidence: null,
    decidedBy: "window-sampling", seq: 1, changedAt: "2026-11-22T10:00:00.000Z", rungs: [], lastSwap: null,
  };
}

function deps(rows: ObligationRow[], wakes: Record<string, unknown> = {}): ParkedQueryDeps {
  return {
    getSeatState: () => idle(),
    getParkWake: (qitemId) => wakes[qitemId] ?? null,
    listOpenObligations: (_destination, limit) => ({ rows, limit }),
  };
}

const held = (blockedOn: string | null | undefined): ObligationRow =>
  ({ qitemId: "qitem-held", state: "blocked", summary: "waiting on the release window", blockedOn, updatedAt: "2026-11-22T09:00:00.000Z" });

/** The rows the parked-owner reminder would wake the owner about (parked-owner-consumer: open items plus unhealthy HELD). */
const reminded = (d: ReturnType<typeof diagnoseSeatParked>) =>
  [...d.obligations.items.map((r) => r.qitemId), ...d.obligations.held.filter((h) => h.healthy === false).map((h) => h.qitemId)];

describe("#1933: an external: hold with no wake is an event-only HELD", () => {
  it("is healthy and listed with its blocker and last update, so an idle owner isn't parked and nothing is reminded", () => {
    const d = diagnoseSeatParked(deps([held("external:release-window")]), SEAT);
    expect(d.parked).toBe(false);
    expect(d.obligations.held).toEqual([expect.objectContaining({
      qitemId: "qitem-held", healthy: true, eventOnly: true, wake: null,
      blockedOn: "external:release-window", updatedAt: "2026-11-22T09:00:00.000Z",
    })]);
    expect(d.obligations.unhealthyHeldCount).toBe(0);
    expect(d.reason).toBe("stopped with 1 HELD row(s), all healthy: 0 with a live wake, 1 waiting on an external event (shown, not reminded) — not parked");
    expect(reminded(d)).toEqual([]);
  });

  it("doesn't hide other work: an open row still parks the owner, and the event-only hold stays healthy beside it", () => {
    const d = diagnoseSeatParked(deps([{ qitemId: "qitem-open", state: "pending", summary: "owed" }, held("external:ci")]), SEAT);
    expect(d.parked).toBe(true);
    expect(reminded(d)).toEqual(["qitem-open"]);
  });

  it("an external: hold the owner gave a wake keeps that wake's reading: fired and unconsumed is still unhealthy", () => {
    const wake = { kind: "watchdog", ref: "job-1", live: false, phase: "fired", deliveryStatus: "ok", unconsumed: true };
    const d = diagnoseSeatParked(deps([held("external:ci")], { "qitem-held": wake }), SEAT);
    expect(d.obligations.held[0]).toMatchObject({ healthy: false });
    expect(d.obligations.held[0]).not.toHaveProperty("eventOnly");
    expect(d.parked).toBe(true);
  });

  it.each([
    ["fold:", "fold:review-r2"],
    ["auth:", "auth:github-token"],
    ["a custom blocker id", "release-gate-7"],
    ["a queue id", "qitem-20261122000000-deadbeef"],
    ["an external: prefix with nothing after it", "external:"],
    ["an external: prefix with only spaces after it", "external:   "],
    ["no blocker the reader could give", undefined],
    ["a null blocker", null],
  ])("a hold on %s with no wake reads as before: unhealthy, and the idle owner is parked", (_label, blockedOn) => {
    const d = diagnoseSeatParked(deps([held(blockedOn)]), SEAT);
    expect(d.obligations.held[0]).toMatchObject({ healthy: false });
    expect(d.obligations.held[0]).not.toHaveProperty("eventOnly");
    expect(d.parked).toBe(true);
    expect(reminded(d)).toEqual(["qitem-held"]);
  });
});

describe("#1933 through the real queue: rig queue block --on external:<name> with no wake", () => {
  let db: Database.Database;
  let queue: QueueRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    queue = new QueueRepository(db, new EventBus(db));
  });
  afterEach(() => db.close());

  async function heldOn(blockedOn: string): Promise<string> {
    const { qitemId } = await queue.create({ sourceSession: "lead@park-rig", destinationSession: SEAT.sessionName, body: "work",
      summary: "waiting", nudge: false } as never);
    queue.update({ qitemId, actorSession: SEAT.sessionName, state: "blocked", blockedOn, transitionNote: "continuation: resume on the event" } as never);
    return qitemId;
  }

  const realDeps = (): ParkedQueryDeps => ({
    getSeatState: () => idle(),
    listOpenObligations: (destination, limit) => ({ rows: queue.listOpenObligations(destination, limit), limit }),
    getParkWake: (qitemId) => queue.getParkWakeStatus(qitemId),
    servedByOwnReminder: (qitemId) => queue.parkWakeServedByOwnReminder(qitemId),
  });

  it("the obligation face carries each row's blocker and last update", async () => {
    const id = await heldOn("external:release-window");
    const [row] = queue.listOpenObligations(SEAT.sessionName, PARKED_OBLIGATION_LIMIT);
    expect(row).toMatchObject({ qitemId: id, state: "blocked", blockedOn: "external:release-window" });
    expect(row!.updatedAt).toEqual(queue.getById(id)!.tsUpdated);
  });

  it("an external: hold reads event-only and nothing is reminded; a custom-blocker hold with no live row still reminds", async () => {
    const external = await heldOn("external:release-window");
    let d = diagnoseSeatParked(realDeps(), SEAT);
    expect(d.obligations.held).toEqual([expect.objectContaining({ qitemId: external, healthy: true, eventOnly: true })]);
    expect(d.parked).toBe(false);
    expect(reminded(d)).toEqual([]);

    const custom = await heldOn("release-gate-7");
    d = diagnoseSeatParked(realDeps(), SEAT);
    expect(d.parked).toBe(true);
    expect(reminded(d)).toEqual([custom]);
  });
});
