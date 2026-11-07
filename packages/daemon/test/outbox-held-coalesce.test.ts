// #2430: a full held quota dropped every later wake to the seat, and the held messages never left (83 of 100 from one
// cross-host sender). Now a seat holds one message per sender: a sender's newest held message retires its earlier ones
// there into itself and names them. Nothing is lost: held messages are never replayed, a coalesced one stays readable by
// ID, and the newest names it.
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { COALESCE_ACTOR, OutboxHandler, OutboxHandlerError } from "../src/domain/outbox-handler.js";

const binding = (nodeId: string) => ({ nodeId, session: `${nodeId}@rig`, occupant: null, pane: "%1" });

describe("one held message per sender at a seat (#2430)", () => {
  let db: Database.Database;
  let outbox: OutboxHandler;
  let n: number;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    outbox = new OutboxHandler(db);
    n = 0;
  });
  afterEach(() => db.close());

  const hold = (sender: string, node = "seat-a", opts?: Parameters<OutboxHandler["retain"]>[3], id = `held-${++n}`) => {
    outbox.retain({ outboxId: id, senderSession: sender, destinationSession: `${node}@rig`, body: `message ${id} from ${sender}` }, binding(node), false, opts);
    return id;
  };
  const held = (node = "seat-a") => outbox.heldForNode(node, 1000).items.map((item) => ({
    id: item.outboxId, sender: item.senderSession, coalesced: (item as { coalesced?: { count: number; outboxIds: string[] } }).coalesced,
  }));
  const quotaCode = (fn: () => unknown) => { try { fn(); return "ok"; } catch (error) { return (error as OutboxHandlerError).code; } };
  /** Fill seat-a to its 100-message quota with distinct senders; `busy` holds one of them. */
  const fill = (busy?: string) => {
    const own = busy ? hold(busy) : undefined;
    for (let i = busy ? 1 : 0; i < 100; i++) hold(`peer-${i}@rig`);
    expect(outbox.retentionUsage("seat-a").count).toBe(100);
    return own;
  };

  it("a sender's newest held message retires its earlier ones into itself and names them, below the quota too", () => {
    const first = hold("busy@other-host");
    const second = hold("busy@other-host");
    const third = hold("busy@other-host");

    expect(held()).toEqual([{ id: third, sender: "busy@other-host", coalesced: { count: 2, outboxIds: [first, second] } }]);
    expect(outbox.getById(first)).toMatchObject({
      deliveryState: "retired", retiredBy: COALESCE_ACTOR, retirementReason: `coalesced into ${third}`, body: `message ${first} from busy@other-host`,
    });
    expect(outbox.coalescedInto(third)).toEqual([first, second]);
    expect(outbox.coalescedInto(second)).toEqual([]);
  });

  it("one sender can't fill the quota: a hundred messages from it hold one record", () => {
    for (let i = 0; i < 100; i++) hold("busy@other-host");
    expect(outbox.retentionUsage("seat-a").count).toBe(1);
    expect(quotaCode(() => hold("someone-new@rig"))).toBe("ok");
  });

  it("at a full quota, a sender that holds a message there takes its place; one that holds nothing is refused", () => {
    const earlier = fill("busy@other-host")!;

    const newest = hold("busy@other-host");
    expect(outbox.retentionUsage("seat-a").count).toBe(100);
    expect(outbox.coalescedInto(newest)).toEqual([earlier]);

    expect(quotaCode(() => hold("newcomer@rig"))).toBe("retained_quota_full");
    expect(held().filter((row) => row.id !== newest).every((row) => row.coalesced === undefined)).toBe(true);
  });

  it("never coalesces the other parts of the same send, and their next send names them", () => {
    const parts = ["part-1", "part-2"];
    for (const id of parts) hold("peer@rig", "seat-a", { sameSend: parts }, id);
    expect(held().map((row) => row.id)).toEqual(parts);

    const later = ["part-3", "part-4"];
    for (const id of later) hold("peer@rig", "seat-a", { sameSend: later }, id);

    expect(held().map((row) => row.id)).toEqual(later);
    expect(outbox.coalescedInto("part-3")).toEqual(parts);
    expect(outbox.coalescedInto("part-4")).toEqual([]);
  });

  it("a committed wake is never refused and takes its sender's place; the sender's next message coalesces it like any other", () => {
    const earlier = fill("busy@other-host")!;
    outbox.record({ outboxId: "committed", senderSession: "busy@other-host", destinationSession: "seat-a@rig", body: "committed" });
    outbox.claimForDelivery("committed");
    outbox.retain({ outboxId: "committed", senderSession: "busy@other-host", destinationSession: "seat-a@rig", body: "committed" }, binding("seat-a"), true);
    expect(outbox.coalescedInto("committed")).toEqual([earlier]);

    const later = hold("busy@other-host");
    expect(outbox.coalescedInto(later)).toEqual([earlier, "committed"]);
    expect(outbox.getById("committed")).toMatchObject({ deliveryState: "retired", body: "committed" });
  });

  it("a message that settles as held late never hides a newer one from the same sender: it joins the newest instead", () => {
    // A committed wake staged first, held only after the sender's next message was.
    outbox.record({ outboxId: "late-wake", senderSession: "busy@other-host", destinationSession: "seat-a@rig", body: "staged first" });
    const newer = hold("busy@other-host");
    outbox.claimForDelivery("late-wake");
    outbox.retain({ outboxId: "late-wake", senderSession: "busy@other-host", destinationSession: "seat-a@rig", body: "staged first" }, binding("seat-a"), true);

    expect(held().map((row) => row.id)).toEqual([newer]);
    expect(outbox.coalescedInto(newer)).toEqual(["late-wake"]);
    expect(outbox.getById("late-wake")).toMatchObject({ deliveryState: "retired", retirementReason: `coalesced into ${newer}` });
  });

  it("an older message that settles as held late joins the newest without breaking up a newer multipart send", () => {
    // A committed wake staged first; then the sender's next send is held as two parts; then the wake settles as held.
    outbox.record({ outboxId: "late-wake", senderSession: "busy@other-host", destinationSession: "seat-a@rig", body: "staged first" });
    const parts = ["part-1", "part-2"];
    for (const id of parts) hold("busy@other-host", "seat-a", { sameSend: parts }, id);
    outbox.claimForDelivery("late-wake");
    outbox.retain({ outboxId: "late-wake", senderSession: "busy@other-host", destinationSession: "seat-a@rig", body: "staged first" }, binding("seat-a"), true);

    expect(held().map((row) => row.id)).toEqual(parts);
    expect(outbox.coalescedInto("part-2")).toEqual(["late-wake"]);
    expect(outbox.getById("part-1")).toMatchObject({ deliveryState: "retained" });
    expect(outbox.getById("late-wake")).toMatchObject({ deliveryState: "retired", retirementReason: "coalesced into part-2" });
  });

  it("a draft-aware attempt that settles as held late keeps a newer multipart send together too", () => {
    // The attempt is staged and moves on to sending; the sender's next send is held as two parts; then the attempt
    // settles as held (retained without coalescing, then coalesceSettled, as the draft-aware path does).
    outbox.record({ outboxId: "attempt", senderSession: "busy@other-host", destinationSession: "seat-a@rig", body: "attempt" });
    outbox.claimForDelivery("attempt");
    const parts = ["part-1", "part-2"];
    for (const id of parts) hold("busy@other-host", "seat-a", { sameSend: parts }, id);
    outbox.retain({ outboxId: "attempt", senderSession: "busy@other-host", destinationSession: "seat-a@rig", body: "attempt" }, binding("seat-a"), false, { coalesce: false });
    outbox.coalesceSettled("attempt", ["attempt"]);

    expect(held().map((row) => row.id)).toEqual(parts);
    expect(outbox.coalescedInto("part-2")).toEqual(["attempt"]);
    expect(outbox.getById("part-1")).toMatchObject({ deliveryState: "retained" });
  });

  it("an urgent held message coalesced under a later routine one carries its marking to the newest", () => {
    outbox.retain({ outboxId: "urgent", senderSession: "peer@rig", destinationSession: "seat-a@rig", body: "urgent", urgency: "urgent" }, binding("seat-a"));
    const routine = hold("peer@rig");
    expect(outbox.coalescedInto(routine)).toEqual(["urgent"]);
    expect(outbox.getById(routine)).toMatchObject({ urgency: "urgent" });
    expect(outbox.getById(hold("other@rig"))).toMatchObject({ urgency: "routine" });
  });

  it("a hand retirement whose reason reads the same is neither listed as coalesced nor rewritten", () => {
    // Same sender, same seat, the reason a person typed reads exactly like the link to the next message.
    const handRetired = hold("peer@rig");
    outbox.retire(handRetired, "person@rig", "coalesced into held-2");
    const target = hold("peer@rig");
    expect(target).toBe("held-2");

    expect(outbox.coalescedInto(target)).toEqual([]);
    expect(held().find((row) => row.id === target)?.coalesced).toBeUndefined();

    // Coalescing held-2 repoints its links; the hand retirement is not one of them.
    const newest = hold("peer@rig");
    expect(outbox.coalescedInto(newest)).toEqual([target]);
    expect(outbox.getById(handRetired)).toMatchObject({ retiredBy: "person@rig", retirementReason: "coalesced into held-2" });
  });

  it("leaves an unattributed sender and a watchdog's reminders to the quota as before", () => {
    for (const sender of ["unknown", "watchdog@system"]) {
      const db2 = new Database(":memory:"); migrate(db2, ALL_MIGRATIONS); const o = new OutboxHandler(db2);
      for (let i = 0; i < 100; i++) o.retain({ outboxId: `x-${i}`, senderSession: sender, destinationSession: "s@rig", body: "x" }, binding("s"));
      expect(o.retentionUsage("s").count).toBe(100);
      expect(quotaCode(() => o.retain({ outboxId: "x-100", senderSession: sender, destinationSession: "s@rig", body: "x" }, binding("s")))).toBe("retained_quota_full");
      db2.close();
    }
  });

  it("a draft-aware attempt coalesces only when it settles as held, and its sender's held message counts as its room", () => {
    const earlier = fill("busy@other-host")!;

    const attempt = hold("busy@other-host", "seat-a", { coalesce: false });
    expect(outbox.getById(earlier)?.deliveryState).toBe("retained");
    expect(outbox.coalescedInto(attempt)).toEqual([]);

    outbox.coalesceSettled(attempt, [attempt]);
    expect(outbox.coalescedInto(attempt)).toEqual([earlier]);
    expect(outbox.retentionUsage("seat-a").count).toBe(100);
    expect(quotaCode(() => hold("newcomer@rig", "seat-a", { coalesce: false }))).toBe("retained_quota_full");
  });

  it("the queue's draft-aware capacity check follows the same rule", () => {
    const earlier = fill("busy@other-host")!;
    expect(quotaCode(() => outbox.assertRetentionCapacity("seat-a", "wake", "busy@other-host", ["wake-intent-q1"]))).toBe("ok");
    expect(quotaCode(() => outbox.assertRetentionCapacity("seat-a", "wake", "newcomer@rig", ["wake-intent-q2"]))).toBe("retained_quota_full");
    expect(quotaCode(() => outbox.assertRetentionCapacity("seat-a", "wake", "busy@other-host", [earlier]))).toBe("retained_quota_full");
    expect(quotaCode(() => outbox.assertRetentionCapacity("seat-a", "wake"))).toBe("retained_quota_full");
  });
});
