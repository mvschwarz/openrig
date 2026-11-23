// An adopted bare tmux selector that rig detail reports as the representative takes queue work (#3799).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueueRecordingCheck, makeTopologyDestinationCheck } from "../src/domain/queue-destination-check.js";
import { resolveRigRepresentativeById, resolveSessionNodeId } from "../src/domain/queue-owner.js";

describe("queue recording admits an adopted representative's reported name", () => {
  let db: ReturnType<typeof createDb>, rigs: RigRepository, sessions: SessionRegistry, queue: QueueRepository;
  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db); sessions = new SessionRegistry(db);
    const topology = makeTopologyDestinationCheck({
      findRigsByName: name => rigs.findRigsByName(name),
      loadHumanRegistry: () => ({ ok: false, noHumans: true }) as never,
      sharedChannels: () => [],
      db,
    });
    queue = new QueueRepository(db, new EventBus(db), {
      validateRig: topology,
      canRecordDestination: makeQueueRecordingCheck(topology),
      resolveSessionAddresses: name => sessions.sessionAddresses(name),
    });
  });
  afterEach(() => db.close());

  const adopt = (rigName: string, lead: string, worker: string) => {
    const rig = rigs.createRig(rigName);
    const leadNode = rigs.addNode(rig.id, "coord.lead", { runtime: "terminal" });
    const workerNode = rigs.addNode(rig.id, "dev.worker", { runtime: "terminal" });
    rigs.addEdge(rig.id, leadNode.id, workerNode.id, "delegates_to");
    for (const [node, name] of [[leadNode, lead], [workerNode, worker]] as const) {
      sessions.registerClaimedSession(node.id, name);
      sessions.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    }
    return { rig, leadNode };
  };
  const create = (destinationSession: string) =>
    queue.create({ sourceSession: "reporter@external", destinationSession, summary: "Representative check", body: "Private test item.", nudge: false });

  it("records and selects a bare adopted selector, resolved to its seat in its rig", async () => {
    const { rig, leadNode } = adopt("bare-lead", "local-captain", "dev-worker@bare-lead");
    const representative = resolveRigRepresentativeById(db, rig.id);
    expect(representative).toBe("local-captain");
    expect(resolveSessionNodeId(db, "local-captain")).toBe(leadNode.id);
    expect(leadNode.rigId).toBe(rig.id);
    expect(queue.acceptsDestination("local-captain")).toBe(true);
    const item = await create(representative!);
    expect(queue.getById(item.qitemId)?.destinationSession).toBe("local-captain");
  });

  it("keeps the qualified form unchanged", async () => {
    adopt("bare-lead", "local-captain", "dev-worker@bare-lead");
    for (const name of ["dev-worker@bare-lead", "coord-lead@bare-lead"]) {
      expect(queue.acceptsDestination(name)).toBe(true);
      expect(queue.getById((await create(name)).qitemId)?.destinationSession).toBe(name);
    }
  });

  it("admits a successor over a retained, stopped predecessor of the same seat", async () => {
    const before = adopt("bare-lead", "local-captain", "dev-worker@bare-lead");
    db.prepare("UPDATE sessions SET status = 'stopped' WHERE node_id = ?").run(before.leadNode.id);
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(before.leadNode.id);
    const after = adopt("bare-lead-next", "local-captain", "dev-worker@bare-lead-next");
    expect(resolveSessionNodeId(db, "local-captain")).toBe(after.leadNode.id);
    expect(queue.acceptsDestination("local-captain")).toBe(true);
    expect(queue.getById((await create("local-captain")).qitemId)?.destinationSession).toBe("local-captain");
  });

  it("still refuses a bare name no active seat reports", async () => {
    const { rig } = adopt("bare-lead", "local-captain", "dev-worker@bare-lead");
    expect(queue.acceptsDestination("nobody-here")).toBe(false);
    await expect(create("nobody-here")).rejects.toMatchObject({ code: "unknown_destination_rig" });
    rigs.archiveRig(rig.id);
    expect(queue.acceptsDestination("local-captain")).toBe(false);
    await expect(create("local-captain")).rejects.toMatchObject({ code: "unknown_destination_rig" });
  });

  it("refuses a bare name that another active seat's binding also claims", async () => {
    const { leadNode } = adopt("bare-lead", "local-captain", "dev-worker@bare-lead");
    const other = adopt("other-rig", "other-lead", "dev-worker@other-rig");
    sessions.updateBinding(other.leadNode.id, { tmuxSession: "local-captain", tmuxPane: "%2" });
    expect(resolveSessionNodeId(db, "local-captain")).toBe(leadNode.id);
    expect(queue.acceptsDestination("local-captain")).toBe(false);
    await expect(create("local-captain")).rejects.toMatchObject({ code: "unknown_destination_rig" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM queue_items").get()).toEqual({ n: 0 });
  });

  it("keeps refusing an unregistered external name even when a seat's session has that spelling", async () => {
    adopt("ext-lead", "unregistered@external", "dev-worker@ext-lead");
    expect(queue.acceptsDestination("unregistered@external")).toBe(false);
    await expect(create("unregistered@external")).rejects.toThrow(/unregistered@external/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM queue_items").get()).toEqual({ n: 0 });
  });
});
