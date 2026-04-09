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
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { ClaimService } from "../src/domain/claim-service.js";
import { vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema, discoveryFkFix, agentspecRebootSchema, podNamespaceSchema, externalCliAttachmentSchema,
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
  let startPipePaneSpy: ReturnType<typeof vi.fn>;
  let ensureContextCollectorSpy: ReturnType<typeof vi.fn>;
  let transcriptStore: TranscriptStore;

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
    startPipePaneSpy = vi.fn(async () => ({ ok: true as const }));
    ensureContextCollectorSpy = vi.fn();
    mockTmux = {
      setSessionOption: setSessionOptionSpy,
      getSessionOption: vi.fn(async () => null),
      sendText: sendTextSpy,
      sendKeys: sendKeysSpy,
      startPipePane: startPipePaneSpy,
    } as unknown as TmuxAdapter;
    transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/openrig-claim-service-transcripts", enabled: true });
    claimService = new ClaimService({
      db,
      rigRepo,
      sessionRegistry,
      discoveryRepo,
      eventBus,
      tmuxAdapter: mockTmux,
      transcriptStore,
      claudeContextProvisioner: {
        ensureContextCollector: ensureContextCollectorSpy,
      },
    });
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

  // claim() method removed in bind consolidation — claim-specific tests deleted

  it("bind attaches a discovered session to an existing node", async () => {
    const rig = seedRig();
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch.lead@host" });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nodeId).toBe(node.id);
    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.tmuxSession).toBe("orch.lead@host");

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
    const discovered = seedDiscovery({ tmuxSession: "orch.lead@host" });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);

    expect(setSessionOptionSpy).toHaveBeenCalledTimes(5);
    const calls = setSessionOptionSpy.mock.calls as [string, string, string][];
    const metaMap = new Map(calls.map((c) => [c[1], c[2]]));
    expect(metaMap.get("@rigged_node_id")).toBe(node.id);
    expect(metaMap.get("@rigged_session_name")).toBe("orch.lead@host");
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

  // T17: bind delivers post-claim identity hint via sendText + sendKeys C-m
  it("bind delivers post-claim identity hint via sendText + sendKeys", async () => {
    const rig = seedRig();
    const node = rigRepo.addNode(rig.id, "adopted-sess", { runtime: "claude-code", cwd: "/tmp" });
    const discovered = seedDiscovery({ tmuxSession: "adopted-sess" });

    await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "adopted-sess" });

    expect(sendTextSpy).toHaveBeenCalled();
    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    expect(textCall[0]).toBe("adopted-sess");
    expect(textCall[1]).toContain("test-rig");
    expect(textCall[1]).toContain("adopted-sess"); // logicalId defaults to tmux session
    expect(textCall[1]).toContain("rig whoami --json");

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
    const discovered = seedDiscovery({ tmuxSession: "orch.lead@host" });

    await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(sendTextSpy).toHaveBeenCalled();
    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    expect(textCall[0]).toBe("orch.lead@host");
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
    rigRepo.addNode(rig.id, "custom.id", { runtime: "claude-code", cwd: "/tmp" });
    const discovered = seedDiscovery({ tmuxSession: "my-session" });

    await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "custom.id" });

    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    const hint = textCall[1];
    expect(hint).toContain("test-rig");
    expect(hint).toContain("custom.id");
    expect(hint).toContain("rig whoami --json");
  });

  // T21: hint delivery failure does not fail bind
  it("bind succeeds even if hint delivery fails", async () => {
    const rig = seedRig();
    rigRepo.addNode(rig.id, "organic-session", { runtime: "claude-code", cwd: "/tmp" });
    const discovered = seedDiscovery();

    sendTextSpy.mockImplementation(async () => { throw new Error("tmux not available"); });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "organic-session" });
    expect(result.ok).toBe(true);
  });

  it("bind starts transcript capture for an adopted tmux session", async () => {
    const rig = seedRig();
    rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch.lead@host" });
    vi.spyOn(transcriptStore, "ensureTranscriptDir").mockReturnValue(true);

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(true);
    expect(startPipePaneSpy).toHaveBeenCalledWith(
      "orch.lead@host",
      transcriptStore.getTranscriptPath("test-rig", "orch.lead@host"),
    );
  });

  it("bind provisions Claude context collection for adopted tmux sessions", async () => {
    const rig = seedRig();
    rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch.lead@host" });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(true);
    expect(ensureContextCollectorSpy).toHaveBeenCalledWith({
      cwd: "/projects/myapp",
      tmuxSession: "orch.lead@host",
    });
  });
});
