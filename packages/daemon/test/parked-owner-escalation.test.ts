import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as queueOwner from "../src/domain/queue-owner.js";
import * as humanSelection from "../src/domain/workflow-human-destination.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry, resolveCurrentSessionAddress } from "../src/domain/session-registry.js";
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
  function fixture(opts: { parent?: boolean } = {}) {
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
    if (opts.parent !== false) rigs.addEdge(rig.id, nodes.lead!.id, nodes.writer!.id, "delegates_to");
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

  it("for a seat held by its minimum reminder interval, says when the next reminder comes instead of that it won't", async () => {
    const { db, queue } = fixture();
    try {
      const row = await queue.create({ sourceSession: asker, destinationSession: seat, body: "Please review", summary: "Review", nudge: false });
      await escalateUnclaimedReminder(db, queue, { seat, qitemIds: [row.qitemId], deliveredAt: "2026-11-21T03:00:00.000Z",
        episodeKey: `${seat}|abc#2`, nextReminderAt: "2026-11-21T04:00:00.000Z" });
      const notice = queue.list({ limit: 50 }).find((q) => q.tags?.includes("parked-owner-escalation"));
      expect(notice!.body).toContain("its minimum reminder interval holds its next reminder until 2026-11-21T04:00:00.000Z");
      expect(notice!.body).not.toContain("won't repeat");
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

  // The seat's physical session and its derived sender address (pod-less here) are two spellings of one seat.
  it("never picks the parked seat under its other address, as the creator or as the default receiver", async () => {
    const { db, queue } = fixture();
    try {
      const alias = resolveCurrentSessionAddress(db, seat)!.senderAddress;
      expect(alias).not.toBe(seat);
      const own = await queue.create({ sourceSession: alias, destinationSession: seat, body: "Note to self", summary: "Self", nudge: false });
      expect(await escalateUnclaimedReminder(db, queue, { seat, qitemIds: [own.qitemId], deliveredAt: "2026-11-21T03:00:00.000Z",
        episodeKey: `${seat}|own#3` })).toEqual([lead]);
    } finally { db.close(); }
    const unparented = fixture({ parent: false });
    try {
      const alias = resolveCurrentSessionAddress(unparented.db, seat)!.senderAddress;
      const person = deriveCanonicalSessionName("human", "owner", "external");
      vi.spyOn(queueOwner, "readReceivingAgentSetting").mockReturnValue({ session: alias });
      vi.spyOn(humanSelection, "workflowHumanDestination").mockReturnValue(person);
      const remote = `${deriveCanonicalSessionName("ops", "deputy", "ops")}@another-host`;
      const row = await unparented.queue.create({ sourceSession: remote, destinationSession: seat, body: "Please review", summary: "Review", nudge: false });
      expect(await escalateUnclaimedReminder(unparented.db, unparented.queue, { seat, qitemIds: [row.qitemId], deliveredAt: "2026-11-21T03:00:00.000Z",
        episodeKey: `${seat}|rcv#4` })).toEqual([person]);
    } finally { unparented.db.close(); }
  });

  it("doesn't escalate a notice of its own kind back, so two idle seats can't pass notices to each other", async () => {
    const { db, queue } = fixture();
    try {
      const row = await queue.create({ sourceSession: asker, destinationSession: seat, body: "Please review", summary: "Review", nudge: false });
      expect(await escalateUnclaimedReminder(db, queue, { seat, qitemIds: [row.qitemId], deliveredAt: "2026-11-21T03:00:00.000Z",
        episodeKey: `${seat}|abc#5` })).toEqual([asker]);
      const notice = queue.list({ limit: 50 }).find((q) => q.tags?.includes("parked-owner-escalation"))!;
      // The asker then sits idle with that notice unclaimed, and its own reminder's 15 minutes pass.
      expect(await escalateUnclaimedReminder(db, queue, { seat: asker, qitemIds: [notice.qitemId], deliveredAt: "2026-11-21T03:20:00.000Z",
        episodeKey: `${asker}|ntc#6` })).toEqual([]);
      expect(queue.list({ limit: 50 }).filter((q) => q.tags?.includes("parked-owner-escalation"))).toHaveLength(1);
    } finally { db.close(); }
  });
});
