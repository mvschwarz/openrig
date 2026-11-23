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
import { resolveRigRepresentativeById } from "../src/domain/queue-owner.js";

describe("queue recording admits an adopted representative's reported name", () => {
  let db: ReturnType<typeof createDb>, rigs: RigRepository, sessions: SessionRegistry, queue: QueueRepository;
  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db); sessions = new SessionRegistry(db);
    const topology = makeTopologyDestinationCheck({
      findRigsByName: name => rigs.findRigsByName(name),
      loadHumanRegistry: () => ({ ok: false, noHumans: true }) as never,
      sharedChannels: () => [],
    });
    queue = new QueueRepository(db, new EventBus(db), {
      validateRig: topology,
      canRecordDestination: makeQueueRecordingCheck(topology, db),
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
    return rig;
  };

  it("records a row for a bare adopted selector", async () => {
    const rig = adopt("bare-lead", "local-captain", "dev-worker@bare-lead");
    const representative = resolveRigRepresentativeById(db, rig.id);
    expect(representative).toBe("local-captain");
    const item = await queue.create({ sourceSession: "reporter@external", destinationSession: representative!,
      summary: "Representative check", body: "Private test item.", nudge: false });
    expect(queue.getById(item.qitemId)?.destinationSession).toBe("local-captain");
  });

  it("still refuses a bare name no active seat reports", async () => {
    const rig = adopt("bare-lead", "local-captain", "dev-worker@bare-lead");
    await expect(queue.create({ sourceSession: "reporter@external", destinationSession: "nobody-here", body: "x", nudge: false }))
      .rejects.toMatchObject({ code: "unknown_destination_rig" });
    rigs.archiveRig(rig.id);
    await expect(queue.create({ sourceSession: "reporter@external", destinationSession: "local-captain", body: "x", nudge: false }))
      .rejects.toMatchObject({ code: "unknown_destination_rig" });
  });
});
