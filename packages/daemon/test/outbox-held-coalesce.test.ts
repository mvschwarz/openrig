// #2430: a full held quota dropped every later wake to the seat, and the held messages never left (83 of 100 from one
// cross-host sender). Now, at capacity, a sender that already holds messages at the seat coalesces them into its
// newest one, which takes their room. Below capacity nothing changes: each message keeps its own readable record.
// Nothing is lost: held messages are never replayed, a coalesced one stays readable by ID, and the newest names it.
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { COALESCE_ACTOR, OutboxHandler, OutboxHandlerError } from "../src/domain/outbox-handler.js";

const binding = (nodeId: string) => ({ nodeId, session: `${nodeId}@rig`, occupant: null, pane: "%1" });

describe("a full held quota coalesces a sender's own held messages (#2430)", () => {
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
  /** Fill seat-a to its 100-message quota: `own` from the busy sender, the rest from distinct peers. */
  const fill = (own: number, busy = "busy@other-host") => {
    const ids = Array.from({ length: own }, () => hold(busy));
    for (let i = own; i < 100; i++) hold(`peer-${i}@rig`);
    expect(outbox.retentionUsage("seat-a").count).toBe(100);
    return ids;
  };

  it("below capacity, each message from the same sender keeps its own record", () => {
    const first = hold("peer@rig");
    const second = hold("peer@rig");

    expect(held().map((row) => row.id)).toEqual([first, second]);
    expect(held().every((row) => row.coalesced === undefined)).toBe(true);
  });

  it("at capacity, a sender's newest retires its own earlier held messages into itself and names them", () => {
    const earlier = fill(83);

    const newest = hold("busy@other-host");

    expect(outbox.retentionUsage("seat-a").count).toBe(18);
    const row = held().find((r) => r.id === newest)!;
    expect(row.coalesced?.count).toBe(83);
    expect([...row.coalesced!.outboxIds].sort()).toEqual([...earlier].sort());
    expect(outbox.getById(earlier[0]!)).toMatchObject({
      deliveryState: "retired", retiredBy: COALESCE_ACTOR, retirementReason: `coalesced into ${newest}`, body: `message ${earlier[0]} from busy@other-host`,
    });
    // The room it freed is real: other senders' wakes are held again.
    expect(quotaCode(() => hold("someone-new@rig"))).toBe("ok");
  });

  it("at capacity, a sender with nothing held is still refused, and no one else's message is touched", () => {
    fill(0);
    expect(quotaCode(() => hold("newcomer@rig"))).toBe("retained_quota_full");
    expect(held().every((row) => row.coalesced === undefined)).toBe(true);
    expect(outbox.retentionUsage("seat-a").count).toBe(100);
  });

  it("a later coalesce names the whole chain from the newest", () => {
    const earlier = fill(50);
    const second = hold("busy@other-host");
    for (let i = 0; i < 49; i++) hold(`late-${i}@rig`);
    expect(outbox.retentionUsage("seat-a").count).toBe(100);

    const third = hold("busy@other-host");

    expect([...outbox.coalescedInto(third)].sort()).toEqual([...earlier, second].sort());
    expect(outbox.coalescedInto(second)).toEqual([]);
  });

  it("never coalesces the other parts of the same send", () => {
    fill(0);
    for (let i = 0; i < 10; i++) outbox.retire(`held-${i + 1}`, "test@rig", "make room");
    const parts = ["part-1", "part-2"];
    for (const id of parts) hold("peer-50@rig", "seat-a", { sameSend: parts }, id);
    for (let i = 0; i < 8; i++) hold(`filler-${i}@rig`);
    expect(outbox.retentionUsage("seat-a").count).toBe(100);

    const later = ["part-3", "part-4"];
    for (const id of later) hold("peer-50@rig", "seat-a", { sameSend: later }, id);

    expect(held().filter((row) => row.sender === "peer-50@rig").map((row) => row.id)).toEqual(later);
    expect(outbox.coalescedInto("part-4")).toEqual([]);
    expect(outbox.coalescedInto("part-3").sort()).toEqual(["held-51", "part-1", "part-2"].sort());
  });

  it("never coalesces a precommitted wake: committed wakes keep each member past the quota", () => {
    const earlier = fill(5);
    outbox.record({ outboxId: "committed", senderSession: "busy@other-host", destinationSession: "seat-a@rig", body: "committed" });
    outbox.claimForDelivery("committed");
    outbox.retain({ outboxId: "committed", senderSession: "busy@other-host", destinationSession: "seat-a@rig", body: "committed" }, binding("seat-a"), true);

    expect(outbox.retentionUsage("seat-a").count).toBe(101);
    expect(outbox.coalescedInto("committed")).toEqual([]);
    for (const id of earlier) expect(outbox.getById(id)?.deliveryState).toBe("retained");
  });

  it("leaves an unattributed sender, a watchdog's reminders and a draft-aware attempt to the quota as before", () => {
    for (const sender of ["unknown", "watchdog@system"]) {
      const db2 = new Database(":memory:"); migrate(db2, ALL_MIGRATIONS); const o = new OutboxHandler(db2);
      for (let i = 0; i < 100; i++) o.retain({ outboxId: `x-${i}`, senderSession: sender, destinationSession: "s@rig", body: "x" }, binding("s"));
      expect(quotaCode(() => o.retain({ outboxId: "x-100", senderSession: sender, destinationSession: "s@rig", body: "x" }, binding("s")))).toBe("retained_quota_full");
      db2.close();
    }
    fill(10);
    expect(quotaCode(() => hold("busy@other-host", "seat-a", { coalesce: false }))).toBe("retained_quota_full");
    expect(outbox.retentionUsage("seat-a").count).toBe(100);
  });
});
