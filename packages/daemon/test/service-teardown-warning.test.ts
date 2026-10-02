import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";

describe("service teardown receipts", () => {
  let db: Database.Database;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); });
  afterEach(() => db.close());

  async function teardown(status: "running" | "exited", failure: boolean) {
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const rig = rigRepo.createRig("service-fixture");
    const node = rigRepo.addNode(rig.id, "worker");
    const session = sessionRegistry.registerSession(node.id, "worker@service-fixture");
    sessionRegistry.updateStatus(session.id, status);
    rigRepo.setServicesRecord(rig.id, { kind: "compose", rigRoot: "/fixture", composeFile: "compose.yml", specJson: JSON.stringify({ kind: "compose", downPolicy: "down" }), latestReceiptJson: "old-service-receipt" });
    const commands: string[] = [];
    const composeAdapter = new ComposeServicesAdapter(async (command) => {
      commands.push(command);
      if (failure) throw new Error("fixture Docker engine unavailable");
      return "";
    });
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus,
      snapshotRepo: new SnapshotRepository(db), checkpointStore: new CheckpointStore(db) });
    const orchestrator = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotCapture,
      tmuxAdapter: new TmuxAdapter(async () => ""),
      serviceOrchestrator: new ServiceOrchestrator({ rigRepo, composeAdapter }) });
    const result = await orchestrator.teardown(rig.id);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(" down 2>&1");
    expect(result.alreadyStopped).toBe(status === "exited");
    expect(result.sessionsKilled).toBe(status === "running" ? 1 : 0);
    expect(sessionRegistry.getSessionsForRig(rig.id).find((entry) => entry.id === session.id)?.status).toBe("exited");
    expect(rigRepo.getRig(rig.id)).not.toBeNull();
    return { result, record: rigRepo.getServicesRecord(rig.id) };
  }

  it.each(["running", "exited"] as const)("reports a returned Compose failure for a %s rig", async (status) => {
    const { result, record } = await teardown(status, true);
    expect(result.errors).toEqual(["Service teardown warning: fixture Docker engine unavailable"]);
    expect(record?.latestReceiptJson).toBe("old-service-receipt");
  });

  it.each(["running", "exited"] as const)("keeps successful Compose teardown quiet for a %s rig", async (status) => {
    const { result, record } = await teardown(status, false);
    expect(result.errors).toEqual([]);
    expect(record?.latestReceiptJson).toBeNull();
  });
});
