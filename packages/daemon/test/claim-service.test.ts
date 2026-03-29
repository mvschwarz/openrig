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
import { packagesSchema } from "../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../src/db/migrations/010_journal_seq.js";
import { bootstrapSchema } from "../src/db/migrations/011_bootstrap.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { ClaimService } from "../src/domain/claim-service.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema, discoveryFkFix, agentspecRebootSchema,
];

describe("ClaimService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let discoveryRepo: DiscoveryRepository;
  let claimService: ClaimService;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    discoveryRepo = new DiscoveryRepository(db);
    claimService = new ClaimService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus });
  });

  afterEach(() => { db.close(); });

  function seedDiscovery(opts?: { runtimeHint?: string; tmuxSession?: string; tmuxPane?: string }) {
    return discoveryRepo.upsertDiscoveredSession({
      tmuxSession: opts?.tmuxSession ?? "organic-session",
      tmuxPane: opts?.tmuxPane ?? "%0",
      runtimeHint: (opts?.runtimeHint ?? "claude-code") as any,
      confidence: "high",
      cwd: "/projects/myapp",
    });
  }

  function seedRig() {
    return rigRepo.createRig("test-rig");
  }

  // T1: Claim creates node in target rig
  it("claim creates node in target rig", () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    const result = claimService.claim({ discoveredId: discovered.id, rigId: rig.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const updatedRig = rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes).toHaveLength(1);
    expect(updatedRig!.nodes[0]!.logicalId).toBe("organic-session");
  });

  // T2: Claim creates binding with correct tmux refs
  it("claim creates binding pointing to tmux session/pane", () => {
    const rig = seedRig();
    const discovered = seedDiscovery({ tmuxSession: "my-sess", tmuxPane: "%3" });

    const result = claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const binding = sessionRegistry.getBindingForNode(result.nodeId);
    expect(binding).toBeDefined();
    expect(binding!.tmuxSession).toBe("my-sess");
    expect(binding!.tmuxPane).toBe("%3");
  });

  // T3: Claim creates session with origin='claimed'
  it("claim creates session with origin=claimed and status=running", () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    const result = claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.origin).toBe("claimed");
    expect(sessions[0]!.status).toBe("running");
    expect(sessions[0]!.sessionName).toBe("organic-session");
  });

  // T4: Discovery record marked claimed
  it("discovery record marked claimed with nodeId", () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    const result = claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const updated = discoveryRepo.getDiscoveredSession(discovered.id);
    expect(updated!.status).toBe("claimed");
    expect(updated!.claimedNodeId).toBe(result.nodeId);
  });

  // T5: Created node has runtime from runtimeHint
  it("created node has runtime matching discovery runtimeHint", () => {
    const rig = seedRig();
    const discovered = seedDiscovery({ runtimeHint: "codex" });

    const result = claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    expect(result.ok).toBe(true);

    const updatedRig = rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes[0]!.runtime).toBe("codex");
  });

  // T6: Nonexistent rig -> error
  it("claim into nonexistent rig returns rig_not_found", () => {
    const discovered = seedDiscovery();

    const result = claimService.claim({ discoveredId: discovered.id, rigId: "nonexistent" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rig_not_found");
  });

  // T7: Already claimed -> error
  it("claim already-claimed session returns not_active", () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    const second = claimService.claim({ discoveredId: discovered.id, rigId: rig.id });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("not_active");
  });

  // T8: Vanished session -> error
  it("claim vanished session returns not_active", () => {
    const rig = seedRig();
    const discovered = seedDiscovery();
    discoveryRepo.markVanished([discovered.id]);

    const result = claimService.claim({ discoveredId: discovered.id, rigId: rig.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_active");
  });

  // T9: node.claimed event emitted
  it("node.claimed event emitted with correct payload", () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    claimService.claim({ discoveredId: discovered.id, rigId: rig.id });

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'node.claimed'").all() as Array<{ type: string; payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
    expect(payload.discoveredId).toBe(discovered.id);
    expect(payload.logicalId).toBe("organic-session");
  });

  // T10: User-provided logicalId used
  it("user-provided logicalId used instead of tmux session name", () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    const result = claimService.claim({ discoveredId: discovered.id, rigId: rig.id, logicalId: "my-custom-id" });
    expect(result.ok).toBe(true);

    const updatedRig = rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes[0]!.logicalId).toBe("my-custom-id");
  });

  // T11: Mid-claim failure rolls back all writes
  it("mid-claim failure rolls back all writes atomically", () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    // Corrupt the event bus to throw during persistWithinTransaction
    const origPersist = eventBus.persistWithinTransaction.bind(eventBus);
    eventBus.persistWithinTransaction = () => { throw new Error("event persist failed"); };

    const result = claimService.claim({ discoveredId: discovered.id, rigId: rig.id });

    expect(result.ok).toBe(false);

    // No node should exist (rolled back)
    const updatedRig = rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes).toHaveLength(0);

    // Discovery should still be active (not claimed)
    const updatedDiscovery = discoveryRepo.getDiscoveredSession(discovered.id);
    expect(updatedDiscovery!.status).toBe("active");

    eventBus.persistWithinTransaction = origPersist;
  });
});
