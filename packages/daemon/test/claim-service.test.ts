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
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { ClaimService } from "../src/domain/claim-service.js";
import { vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema, discoveryFkFix, agentspecRebootSchema, podNamespaceSchema,
];

describe("ClaimService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let discoveryRepo: DiscoveryRepository;
  let claimService: ClaimService;
  let mockTmux: TmuxAdapter;
  let setSessionOptionSpy: ReturnType<typeof vi.fn>;
  let sendTextSpy: ReturnType<typeof vi.fn>;
  let sendKeysSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    discoveryRepo = new DiscoveryRepository(db);
    setSessionOptionSpy = vi.fn(async () => ({ ok: true as const }));
    sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    sendKeysSpy = vi.fn(async () => ({ ok: true as const }));
    mockTmux = {
      setSessionOption: setSessionOptionSpy,
      getSessionOption: vi.fn(async () => null),
      sendText: sendTextSpy,
      sendKeys: sendKeysSpy,
    } as unknown as TmuxAdapter;
    claimService = new ClaimService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter: mockTmux });
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
  it("claim creates node in target rig", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const updatedRig = rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes).toHaveLength(1);
    expect(updatedRig!.nodes[0]!.logicalId).toBe("organic-session");
  });

  // T2: Claim creates binding with correct tmux refs
  it("claim creates binding pointing to tmux session/pane", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery({ tmuxSession: "my-sess", tmuxPane: "%3" });

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const binding = sessionRegistry.getBindingForNode(result.nodeId);
    expect(binding).toBeDefined();
    expect(binding!.tmuxSession).toBe("my-sess");
    expect(binding!.tmuxPane).toBe("%3");
  });

  // T3: Claim creates session with origin='claimed'
  it("claim creates session with origin=claimed and status=running", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.origin).toBe("claimed");
    expect(sessions[0]!.status).toBe("running");
    expect(sessions[0]!.sessionName).toBe("organic-session");
  });

  // T4: Discovery record marked claimed
  it("discovery record marked claimed with nodeId", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const updated = discoveryRepo.getDiscoveredSession(discovered.id);
    expect(updated!.status).toBe("claimed");
    expect(updated!.claimedNodeId).toBe(result.nodeId);
  });

  // T5: Created node has runtime from runtimeHint
  it("created node has runtime matching discovery runtimeHint", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery({ runtimeHint: "codex" });

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    expect(result.ok).toBe(true);

    const updatedRig = rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes[0]!.runtime).toBe("codex");
  });

  // T6: Nonexistent rig -> error
  it("claim into nonexistent rig returns rig_not_found", async () => {
    const discovered = seedDiscovery();

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: "nonexistent" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rig_not_found");
  });

  // T7: Already claimed -> error
  it("claim already-claimed session returns not_active", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    const second = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("not_active");
  });

  // T8: Vanished session -> error
  it("claim vanished session returns not_active", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery();
    discoveryRepo.markVanished([discovered.id]);

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_active");
  });

  // T9: node.claimed event emitted
  it("node.claimed event emitted with correct payload", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'node.claimed'").all() as Array<{ type: string; payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
    expect(payload.discoveredId).toBe(discovered.id);
    expect(payload.logicalId).toBe("organic-session");
  });

  // T10: User-provided logicalId used
  it("user-provided logicalId used instead of tmux session name", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id, logicalId: "my-custom-id" });
    expect(result.ok).toBe(true);

    const updatedRig = rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes[0]!.logicalId).toBe("my-custom-id");
  });

  // T11: Mid-claim failure rolls back all writes
  it("mid-claim failure rolls back all writes atomically", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    // Corrupt the event bus to throw during persistWithinTransaction
    const origPersist = eventBus.persistWithinTransaction.bind(eventBus);
    eventBus.persistWithinTransaction = () => { throw new Error("event persist failed"); };

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });

    expect(result.ok).toBe(false);

    // No node should exist (rolled back)
    const updatedRig = rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes).toHaveLength(0);

    // Discovery should still be active (not claimed)
    const updatedDiscovery = discoveryRepo.getDiscoveredSession(discovered.id);
    expect(updatedDiscovery!.status).toBe("active");

    eventBus.persistWithinTransaction = origPersist;
  });

  // T12: claim sets tmux metadata on adopted session
  it("claim sets @rigged_* tmux metadata on the adopted session", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery({ tmuxSession: "organic-sess" });

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // setSessionOption should have been called 5 times (one per metadata key)
    expect(setSessionOptionSpy).toHaveBeenCalledTimes(5);
    const calls = setSessionOptionSpy.mock.calls as [string, string, string][];
    // All calls should target the discovered tmux session name
    for (const call of calls) {
      expect(call[0]).toBe("organic-sess");
    }
    // Check specific metadata keys and values
    const metaMap = new Map(calls.map((c) => [c[1], c[2]]));
    expect(metaMap.get("@rigged_node_id")).toBe(result.nodeId);
    expect(metaMap.get("@rigged_session_name")).toBe("organic-sess");
    expect(metaMap.get("@rigged_rig_id")).toBe(rig.id);
    expect(metaMap.get("@rigged_rig_name")).toBe("test-rig");
    expect(metaMap.get("@rigged_logical_id")).toBe("organic-sess");
  });

  // T13: metadata failure does not fail claim
  it("claim succeeds even if tmux metadata write fails", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    // Make metadata writes fail
    setSessionOptionSpy.mockImplementation(async () => { throw new Error("tmux not available"); });

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    expect(result.ok).toBe(true);

    // DB writes should still have succeeded
    const updatedRig = rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes).toHaveLength(1);
  });

  // T14: claim with custom logicalId sets correct metadata
  it("claim with custom logicalId writes that logicalId to tmux metadata", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery({ tmuxSession: "my-tmux" });

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id, logicalId: "custom-id" });
    expect(result.ok).toBe(true);

    const calls = setSessionOptionSpy.mock.calls as [string, string, string][];
    const metaMap = new Map(calls.map((c) => [c[1], c[2]]));
    expect(metaMap.get("@rigged_logical_id")).toBe("custom-id");
  });

  it("bind attaches a discovered session to an existing node", async () => {
    const rig = seedRig();
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nodeId).toBe(node.id);
    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.tmuxSession).toBe("orch-lead@host");

    const sessions = sessionRegistry.getSessionsForRig(rig.id).filter((s) => s.nodeId === node.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.origin).toBe("claimed");

    const updated = discoveryRepo.getDiscoveredSession(discovered.id);
    expect(updated?.status).toBe("claimed");
    expect(updated?.claimedNodeId).toBe(node.id);
  });

  it("bind rejects runtime mismatch against the target node", async () => {
    const rig = seedRig();
    rigRepo.addNode(rig.id, "orch.lead", { runtime: "codex", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code" });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("runtime_mismatch");
  });

  // T15: bind sets tmux metadata on adopted session
  it("bind sets @rigged_* tmux metadata on the adopted session", async () => {
    const rig = seedRig();
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);

    expect(setSessionOptionSpy).toHaveBeenCalledTimes(5);
    const calls = setSessionOptionSpy.mock.calls as [string, string, string][];
    const metaMap = new Map(calls.map((c) => [c[1], c[2]]));
    expect(metaMap.get("@rigged_node_id")).toBe(node.id);
    expect(metaMap.get("@rigged_session_name")).toBe("orch-lead@host");
    expect(metaMap.get("@rigged_rig_id")).toBe(rig.id);
    expect(metaMap.get("@rigged_rig_name")).toBe("test-rig");
    expect(metaMap.get("@rigged_logical_id")).toBe("orch.lead");
  });

  // T16: createAndBindToPod sets tmux metadata
  it("createAndBindToPod sets @rigged_* tmux metadata on the adopted session", async () => {
    const rig = seedRig();
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-dev", rig.id, "dev", "Dev");
    const discovered = seedDiscovery({ tmuxSession: "dev-coder@host" });

    const result = await claimService.createAndBindToPod({
      discoveredId: discovered.id, rigId: rig.id,
      podId: "pod-dev", podNamespace: "dev", memberName: "coder",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(setSessionOptionSpy).toHaveBeenCalledTimes(5);
    const calls = setSessionOptionSpy.mock.calls as [string, string, string][];
    const metaMap = new Map(calls.map((c) => [c[1], c[2]]));
    expect(metaMap.get("@rigged_node_id")).toBe(result.nodeId);
    expect(metaMap.get("@rigged_session_name")).toBe("dev-coder@host");
    expect(metaMap.get("@rigged_rig_id")).toBe(rig.id);
    expect(metaMap.get("@rigged_rig_name")).toBe("test-rig");
    expect(metaMap.get("@rigged_logical_id")).toBe("dev.coder");
  });

  // T17: claim delivers post-claim identity hint via sendText + sendKeys C-m
  it("claim delivers post-claim identity hint via sendText + sendKeys", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery({ tmuxSession: "adopted-sess" });

    await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });

    expect(sendTextSpy).toHaveBeenCalled();
    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    expect(textCall[0]).toBe("adopted-sess");
    expect(textCall[1]).toContain("test-rig");
    expect(textCall[1]).toContain("adopted-sess"); // logicalId defaults to tmux session
    expect(textCall[1]).toContain("rigged whoami --json");

    // Must also submit with C-m
    expect(sendKeysSpy).toHaveBeenCalled();
    const keysCall = sendKeysSpy.mock.calls[0] as [string, string[]];
    expect(keysCall[0]).toBe("adopted-sess");
    expect(keysCall[1]).toContain("C-m");
  });

  // T18: bind delivers post-claim identity hint
  it("bind delivers post-claim identity hint via sendText + sendKeys", async () => {
    const rig = seedRig();
    rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });

    await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(sendTextSpy).toHaveBeenCalled();
    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    expect(textCall[0]).toBe("orch-lead@host");
    expect(textCall[1]).toContain("test-rig");
    expect(textCall[1]).toContain("orch.lead");

    expect(sendKeysSpy).toHaveBeenCalled();
    const keysCall = sendKeysSpy.mock.calls[0] as [string, string[]];
    expect(keysCall[1]).toContain("C-m");
  });

  // T19: createAndBindToPod delivers post-claim identity hint
  it("createAndBindToPod delivers post-claim identity hint via sendText + sendKeys", async () => {
    const rig = seedRig();
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-dev2", rig.id, "dev", "Dev");
    const discovered = seedDiscovery({ tmuxSession: "dev-coder2@host" });

    await claimService.createAndBindToPod({
      discoveredId: discovered.id, rigId: rig.id,
      podId: "pod-dev2", podNamespace: "dev", memberName: "coder",
    });

    expect(sendTextSpy).toHaveBeenCalled();
    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    expect(textCall[0]).toBe("dev-coder2@host");
    expect(textCall[1]).toContain("dev.coder");

    expect(sendKeysSpy).toHaveBeenCalled();
    const keysCall = sendKeysSpy.mock.calls[0] as [string, string[]];
    expect(keysCall[1]).toContain("C-m");
  });

  // T20: hint text contains required identity fields
  it("hint text contains rig name, logicalId, and whoami reference", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery({ tmuxSession: "my-session" });

    await claimService.claim({ discoveredId: discovered.id, rigId: rig.id, logicalId: "custom.id" });

    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    const hint = textCall[1];
    expect(hint).toContain("test-rig");
    expect(hint).toContain("custom.id");
    expect(hint).toContain("rigged whoami --json");
  });

  // T21: hint delivery failure does not fail claim
  it("claim succeeds even if hint delivery fails", async () => {
    const rig = seedRig();
    const discovered = seedDiscovery();

    sendTextSpy.mockImplementation(async () => { throw new Error("tmux not available"); });

    const result = await claimService.claim({ discoveredId: discovered.id, rigId: rig.id });
    expect(result.ok).toBe(true);

    // DB writes should still have succeeded
    const updatedRig = rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes).toHaveLength(1);
  });
});
