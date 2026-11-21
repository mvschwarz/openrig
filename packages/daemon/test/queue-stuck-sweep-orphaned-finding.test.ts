import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { makeQueueRecordingCheck, makeTopologyDestinationCheck } from "../src/domain/queue-destination-check.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { createStuckSweepStatus, runStuckSweep, STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";
import { lastMeaningfulTransition, pendingSince } from "../src/domain/queue-waiting.js";

describe("#3529 orphaned sweep findings", () => {
  const source = "sender@origin";
  const destination = "worker@archived";
  const loadHumanRegistry = () => ({ ok: true as const, entities: [] });
  let db: Database.Database;
  let queue: QueueRepository;
  let status: ReturnType<typeof createStuckSweepStatus>;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    addRig("origin");
    addRig("archived");
    const validateRig = makeTopologyDestinationCheck({
      findRigsByName: (name) => db.prepare("SELECT id FROM rigs WHERE name = ?").all(name),
      loadHumanRegistry,
    });
    queue = new QueueRepository(db, new EventBus(db), { validateRig, canRecordDestination: makeQueueRecordingCheck(validateRig), loadHumanRegistry });
    status = createStuckSweepStatus();
  });
  afterEach(() => db.close());

  function addRig(name: string) {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(name, name);
  }

  function removeRig(name: string) {
    db.prepare("DELETE FROM rigs WHERE name = ?").run(name);
  }

  const sweep = () => runStuckSweep({
    db, queueRepo: queue, status, log: () => {}, unclaimedAgeMinutes: 60,
    resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null, isRegisteredHost: () => false,
  });

  async function work(dest = destination) {
    const row = await queue.create({ sourceSession: source, destinationSession: dest, body: "Check the sample", nudge: false });
    const past = new Date(Date.now() - 120 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(past, row.qitemId);
    return queue.getByIdOrThrow(row.qitemId);
  }

  const openFindings = () => queue.list({ limit: 100 }).filter((row) =>
    row.state === "pending" && row.tags?.includes(STUCK_SWEEP_FINDING_TAG));

  it("hands off the existing finding when its destination rig is deleted", async () => {
    queue.attachOutbox(new OutboxHandler(db));
    const row = await work();
    await sweep();
    const [original] = openFindings();
    if (!original) throw new Error("fixture: expected the original finding");
    removeRig("archived");

    const recovered = await sweep();
    expect(recovered.outcome, recovered.error).toBe("findings");
    await sweep();

    expect(openFindings()).toEqual([expect.objectContaining({ destinationSession: source, handedOffFrom: original.qitemId })]);
    expect(openFindings()[0]?.evidenceRef).toBe(original.evidenceRef);
    expect(openFindings()[0]?.body).toContain(destination);
    expect(queue.getById(original.qitemId)?.state).toBe("handed-off");
    expect(pendingSince(db, row.qitemId)).toBe(row.tsCreated);
    expect(queue.getById(row.qitemId)?.state).toBe("pending");
  });

  it("still selects a handed-off finding whose source rig is deleted before pickup", async () => {
    queue.attachOutbox(new OutboxHandler(db));
    await work();
    await sweep();
    const [original] = openFindings();
    if (!original) throw new Error("fixture: expected the original finding");
    removeRig("archived");

    await sweep(); // hands the finding back to sender@origin under an ordinary qitem id
    const [handedOff] = openFindings();
    if (!handedOff) throw new Error("fixture: expected the handed-off finding");
    expect(handedOff.qitemId).not.toMatch(/^qitem-recovery-/);
    expect(handedOff.handedOffFrom).toBe(original.qitemId);
    removeRig("origin");

    const recovered = await sweep();
    expect(recovered.findings).toContainEqual(expect.objectContaining({
      qitemId: handedOff.qitemId, kind: "unclaimed-obligation", destination: source, action: "unreported",
    }));
    expect(recovered.outcome).toBe("partial");
    expect(status.snapshot().findingsUndelivered).toBe(1);
  });

  it("hands back orphaned dangling-closure findings and reports those without a return route", async () => {
    queue.attachOutbox(new OutboxHandler(db));
    addRig("retired");
    const missingSource = "sender@retired";
    for (const sourceSession of [source, missingSource]) {
      const row = await queue.create({ sourceSession, destinationSession: destination, body: "Check the sample", nudge: false });
      await queue.update({ qitemId: row.qitemId, actorSession: destination, state: "done", closureReason: "handed_off_to", closureTarget: "next@archived" });
    }
    await sweep();
    const originals = openFindings();
    const routable = originals.find((row) => row.sourceSession === source);
    const unroutable = originals.find((row) => row.sourceSession === missingSource);
    if (!routable || !unroutable) throw new Error("fixture: expected both dangling-closure findings");
    const routedBefore = status.snapshot().findingsRouted;
    removeRig("archived");
    removeRig("retired");

    const recovered = await sweep();

    expect(recovered.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "dangling-closure", qitemId: routable.qitemId, action: "created" }),
      { kind: "dangling-closure", qitemId: unroutable.qitemId, findingQitemId: unroutable.qitemId, action: "unreported", destination },
    ]));
    expect(recovered.outcome, recovered.error).toBe("partial");
    expect(openFindings()).toContainEqual(expect.objectContaining({ destinationSession: source, handedOffFrom: routable.qitemId }));
    expect(status.snapshot()).toMatchObject({ findingsRouted: routedBefore + 1, findingsUndelivered: 1 });
  });

  it("records a gap once and recovers when the missing rig returns without touching the work", async () => {
    const row = await work();
    removeRig("archived");
    removeRig("origin");
    const create = vi.spyOn(queue, "create");
    const meaningful = lastMeaningfulTransition(db, row.qitemId);

    expect((await sweep()).outcome).toBe("partial");
    expect((await sweep()).outcome).toBe("partial");
    expect(create).not.toHaveBeenCalled();
    expect(queue.listTransitions(row.qitemId)).toHaveLength(2);
    expect(queue.getById(row.qitemId)).toMatchObject({ tsUpdated: row.tsUpdated, state: "pending" });
    expect(pendingSince(db, row.qitemId)).toBe(row.tsCreated);
    expect(lastMeaningfulTransition(db, row.qitemId)).toEqual(meaningful);

    addRig("archived");
    expect((await sweep()).outcome).toBe("findings");
    expect(openFindings()).toEqual([expect.objectContaining({ destinationSession: destination })]);
    expect(status.snapshot().findingsUndelivered).toBe(0);
  });

  it("reports partial separately from a real create failure and clears the failure streak on partial", async () => {
    const unrouted = await work();
    removeRig("archived");
    removeRig("origin");
    const healthy = await work("worker@healthy");
    addRig("healthy");
    const create = vi.spyOn(queue, "create").mockRejectedValueOnce(new Error("storage write failed"));

    expect((await sweep()).error).toContain("storage write failed");
    expect(status.snapshot()).toMatchObject({ lastOutcome: "failed", consecutiveFailures: 1, findingsUndelivered: 1 });
    create.mockRestore();
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ qitemId: unrouted.qitemId, destination, action: "unreported" }));
    expect(status.snapshot()).toMatchObject({ lastOutcome: "partial", lastError: null, consecutiveFailures: 0, findingsUndelivered: 1, findingsRouted: 1 });
    expect(openFindings()).toEqual([expect.objectContaining({ evidenceRef: `rig queue show ${healthy.qitemId}` })]);
  });
});
