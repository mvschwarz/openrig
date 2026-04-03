import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { WhoamiService } from "../src/domain/whoami-service.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, agentspecRebootSchema, podNamespaceSchema]);
  return db;
}

describe("WhoamiService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let transcriptStore: TranscriptStore;
  let svc: WhoamiService;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/transcripts", enabled: true });
    svc = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore });
  });

  afterEach(() => { db.close(); });

  function seedRig() {
    const rig = rigRepo.createRig("my-rig");
    const nodeA = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code", label: "Implementer" });
    const nodeB = rigRepo.addNode(rig.id, "dev.qa", { role: "reviewer", runtime: "codex", label: "QA" });
    rigRepo.addEdge(rig.id, nodeA.id, nodeB.id, "delegates_to");

    const sessA = sessionRegistry.registerSession(nodeA.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(sessA.id, "running");
    sessionRegistry.updateBinding(nodeA.id, { tmuxSession: "dev-impl@my-rig" });

    const sessB = sessionRegistry.registerSession(nodeB.id, "dev-qa@my-rig");
    sessionRegistry.updateStatus(sessB.id, "running");
    sessionRegistry.updateBinding(nodeB.id, { tmuxSession: "dev-qa@my-rig" });

    return { rig, nodeA, nodeB, sessA, sessB };
  }

  it("resolve by nodeId returns full identity including memberLabel, peers, edges", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id });

    expect(result).not.toBeNull();
    expect(result!.resolvedBy).toBe("node_id");
    expect(result!.identity.logicalId).toBe("dev.impl");
    expect(result!.identity.memberId).toBe("impl");
    expect(result!.identity.memberLabel).toBe("Implementer");
    expect(result!.identity.sessionName).toBe("dev-impl@my-rig");
    expect(result!.identity.runtime).toBe("claude-code");
    expect(result!.identity.rigName).toBe("my-rig");
  });

  it("resolve by sessionName returns same result", () => {
    seedRig();
    const result = svc.resolve({ sessionName: "dev-impl@my-rig" });

    expect(result).not.toBeNull();
    expect(result!.resolvedBy).toBe("session_name");
    expect(result!.identity.logicalId).toBe("dev.impl");
  });

  it("edges classified correctly as outgoing/incoming relative to queried node", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id });

    // nodeA delegates_to nodeB → outgoing from A's perspective
    expect(result!.edges.outgoing).toHaveLength(1);
    expect(result!.edges.outgoing[0]!.kind).toBe("delegates_to");
    expect(result!.edges.outgoing[0]!.to.logicalId).toBe("dev.qa");
    expect(result!.edges.incoming).toHaveLength(0);
  });

  it("peers list excludes the queried node itself, uses current sessions", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id });

    expect(result!.peers).toHaveLength(1);
    expect(result!.peers[0]!.logicalId).toBe("dev.qa");
    expect(result!.peers[0]!.sessionName).toBe("dev-qa@my-rig");
    // Should NOT include self
    expect(result!.peers.find((p) => p.logicalId === "dev.impl")).toBeUndefined();
  });

  it("unknown nodeId returns null", () => {
    seedRig();
    const result = svc.resolve({ nodeId: "nonexistent" });
    expect(result).toBeNull();
  });

  it("session name matching multiple rigs returns ambiguous error", () => {
    // Create two rigs with same session name
    const rig1 = rigRepo.createRig("rig-a");
    const node1 = rigRepo.addNode(rig1.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node1.id, "dev-impl@shared");

    const rig2 = rigRepo.createRig("rig-b");
    const node2 = rigRepo.addNode(rig2.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node2.id, "dev-impl@shared");

    expect(() => svc.resolve({ sessionName: "dev-impl@shared" })).toThrow(/ambiguous/i);
  });
});
