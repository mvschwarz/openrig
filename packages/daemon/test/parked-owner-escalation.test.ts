import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as queueOwner from "../src/domain/queue-owner.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { escalateUnclaimedReminder } from "../src/domain/parked-owner-escalation.js";
import { deriveCanonicalSessionName } from "../src/domain/session-name.js";

// Keep the host's receiving-agent setting out of these isolated queue fixtures.
beforeEach(() => { vi.spyOn(queueOwner, "readReceivingAgentSetting").mockReturnValue({ session: null }); });
afterEach(() => { vi.restoreAllMocks(); });

describe("who hears that a delivered reminder's row is still unclaimed", () => {
  const RIG = "unclaimed";
  const lead = deriveCanonicalSessionName("dev", "lead", RIG);
  const seat = deriveCanonicalSessionName("dev", "writer", RIG);
  const asker = deriveCanonicalSessionName("dev", "asker", RIG);
  function fixture() {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigs = new RigRepository(db), sessions = new SessionRegistry(db);
    const rig = rigs.createRig(RIG);
    const nodes = Object.fromEntries([["lead", lead], ["writer", seat], ["asker", asker]].map(([member, name]) => {
      const node = rigs.addNode(rig.id, member!, { runtime: "claude-code" });
      sessions.registerSession(node.id, name!);
      sessions.updateBinding(node.id, { tmuxSession: name! });
      return [member!, node];
    }));
    rigs.addEdge(rig.id, nodes.lead!.id, nodes.writer!.id, "delegates_to");
    const send = vi.fn(async () => ({ ok: true, verified: true }));
    const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }), transport: { send } });
    return { db, queue, send };
  }

  it("tells the row's creator when that's a local seat, once, and names the row and the seat", async () => {
    const { db, queue, send } = fixture();
    try {
      const row = await queue.create({ sourceSession: asker, destinationSession: seat, body: "Please review", summary: "Review", nudge: false });
      const input = { seat, qitemIds: [row.qitemId], deliveredAt: "2026-11-21T03:00:00.000Z", episodeKey: `${seat}|abc#1` };
      expect(await escalateUnclaimedReminder(db, queue, input)).toEqual([asker]);
      expect(await escalateUnclaimedReminder(db, queue, input)).toEqual([asker]);
      const notices = queue.list({ limit: 50 }).filter((q) => q.tags?.includes("parked-owner-escalation"));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ destinationSession: asker, sourceSession: seat });
      expect(notices[0]!.body).toContain(`${row.qitemId} was named in a parked-owner reminder delivered to ${seat} at 2026-11-21T03:00:00.000Z, and is still pending and unclaimed.`);
      expect(notices[0]!.body).toContain("This notice holds and refuses nothing");
      expect(send).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it("falls back to the seat's escalation owner when the creator isn't a local seat", async () => {
    const { db, queue } = fixture();
    try {
      const remote = `${deriveCanonicalSessionName("ops", "deputy", "ops")}@another-host`;
      const row = await queue.create({ sourceSession: remote, destinationSession: seat, body: "Please review", summary: "Review", nudge: false });
      expect(await escalateUnclaimedReminder(db, queue, { seat, qitemIds: [row.qitemId], deliveredAt: "2026-11-21T03:00:00.000Z",
        episodeKey: `${seat}|def#2` })).toEqual([lead]);
    } finally { db.close(); }
  });
});
