import { describe, expect, it, vi } from "vitest";
import { noticeRosterReady } from "../src/domain/roster-ready-notice.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";

describe("roster-ready notice", () => {
  it("records one notice per started session with stable IDs for the same rig", async () => {
    const create = vi.fn().mockResolvedValue({});
    await noticeRosterReady({ create }, "rig-one", ["a@team", "b@team"]);
    await noticeRosterReady({ create }, "rig-one", ["a@team", "b@team"]);
    const calls = create.mock.calls.map(([input]) => input);
    expect(calls.map(input => input.destinationSession)).toEqual(["a@team", "b@team", "a@team", "b@team"]);
    expect(calls[0]!.qitemId).toBe(calls[2]!.qitemId);
    expect(calls[0]!.qitemId).not.toBe(calls[1]!.qitemId);
    expect(calls[0]!.body).toContain("rig whoami");
  });

  it("reports a failed record while still attempting other seats", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("disk error")).mockResolvedValue({});
    const warnings = await noticeRosterReady({ create }, "rig-one", ["a@team", "b@team"]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual(["Roster-ready notice to a@team is unconfirmed: disk error"]);
  });

  it("persists a single queue item on retry", async () => {
    const db = createFullTestDb();
    try {
      const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
      expect(await noticeRosterReady(queue, "rig-one", ["a@team"])).toEqual([]);
      expect(await noticeRosterReady(queue, "rig-one", ["a@team"])).toEqual([]);
      const rows = db.prepare("SELECT destination_session, body FROM queue_items WHERE destination_session = ?").all("a@team") as Array<{ body: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toContain("rig whoami");
    } finally { db.close(); }
  });
});
