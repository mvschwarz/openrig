import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { PodRepository } from "../src/domain/pod-repository.js";
import { SelfAttachService } from "../src/domain/self-attach-service.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const ALL_MIGRATIONS = [
  coreSchema,
  bindingsSessionsSchema,
  eventsSchema,
  snapshotsSchema,
  checkpointsSchema,
  resumeMetadataSchema,
  nodeSpecFieldsSchema,
  packagesSchema,
  installJournalSchema,
  journalSeqSchema,
  bootstrapSchema,
  discoverySchema,
  discoveryFkFix,
  agentspecRebootSchema,
  podNamespaceSchema,
  externalCliAttachmentSchema,
];

describe("SelfAttachService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let podRepo: PodRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let selfAttachService: SelfAttachService;
  let tmuxAdapter: TmuxAdapter;
  let startPipePaneSpy: ReturnType<typeof vi.fn>;
  let ensureContextCollectorSpy: ReturnType<typeof vi.fn>;
  let transcriptStore: TranscriptStore;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    podRepo = new PodRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    startPipePaneSpy = vi.fn(async () => ({ ok: true as const }));
    ensureContextCollectorSpy = vi.fn();
    tmuxAdapter = {
      startPipePane: startPipePaneSpy,
    } as unknown as TmuxAdapter;
    transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/openrig-self-attach-transcripts", enabled: true });
    selfAttachService = new SelfAttachService({
      db,
      rigRepo,
      podRepo,
      sessionRegistry,
      eventBus,
      tmuxAdapter,
      transcriptStore,
      claudeContextProvisioner: {
        ensureContextCollector: ensureContextCollectorSpy,
      },
    });
  });

  afterEach(() => {
    db.close();
  });

  it("attachToNode binds the current raw agent as external_cli", async () => {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "orch1.lead", {
      runtime: "claude-code",
      cwd: "/Users/mschwarz/code/rigged",
    });

    const result = await selfAttachService.attachToNode({
      rigId: rig.id,
      logicalId: "orch1.lead",
      displayName: "orch1-lead@rigged-buildout",
      cwd: "/Users/mschwarz/code/rigged",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nodeId).toBe(node.id);
    expect(result.logicalId).toBe("orch1.lead");
    expect(result.sessionName).toBe("orch1-lead@rigged-buildout");
    expect(result.attachmentType).toBe("external_cli");
    expect(result.env.OPENRIG_NODE_ID).toBe(node.id);
    expect(result.env.OPENRIG_SESSION_NAME).toBe("orch1-lead@rigged-buildout");

    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.attachmentType).toBe("external_cli");
    expect(binding?.externalSessionName).toBe("orch1-lead@rigged-buildout");
    expect(binding?.tmuxSession).toBeNull();

    const sessions = sessionRegistry.getSessionsForRig(rig.id).filter((session) => session.nodeId === node.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.origin).toBe("claimed");
    expect(sessions[0]?.sessionName).toBe("orch1-lead@rigged-buildout");
  });

  it("attachToNode rejects runtime mismatch for an existing node", async () => {
    const rig = rigRepo.createRig("rigged-buildout");
    rigRepo.addNode(rig.id, "orch1.lead", { runtime: "claude-code" });

    const result = await selfAttachService.attachToNode({
      rigId: rig.id,
      logicalId: "orch1.lead",
      runtime: "codex",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("runtime_mismatch");
  });

  it("attachToPod creates a new pod member with an external_cli binding", async () => {
    const rig = rigRepo.createRig("rigged-buildout");
    const pod = podRepo.createPod(rig.id, "orch1", "Orchestrator");

    const result = await selfAttachService.attachToPod({
      rigId: rig.id,
      podNamespace: pod.namespace,
      memberName: "lead",
      runtime: "claude-code",
      displayName: "orch1-lead@rigged-buildout",
      cwd: "/Users/mschwarz/code/rigged",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rigAfter = rigRepo.getRig(rig.id);
    const node = rigAfter?.nodes.find((candidate) => candidate.logicalId === "orch1.lead");
    expect(node).toBeDefined();
    expect(node?.podId).toBe(pod.id);
    expect(node?.runtime).toBe("claude-code");

    const binding = sessionRegistry.getBindingForNode(result.nodeId);
    expect(binding?.attachmentType).toBe("external_cli");
    expect(binding?.externalSessionName).toBe("orch1-lead@rigged-buildout");
  });

  it("attachToNode can self-attach from tmux without discovery", async () => {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "dev1.impl2", {
      runtime: "claude-code",
    });

    const result = await selfAttachService.attachToNode({
      rigId: rig.id,
      logicalId: "dev1.impl2",
      context: {
        attachmentType: "tmux",
        tmuxSession: "dev1-impl2@rigged-buildout",
        tmuxWindow: "@12",
        tmuxPane: "%34",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.attachmentType).toBe("tmux");
    expect(result.sessionName).toBe("dev1-impl2@rigged-buildout");

    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.attachmentType).toBe("tmux");
    expect(binding?.tmuxSession).toBe("dev1-impl2@rigged-buildout");
    expect(binding?.tmuxWindow).toBe("@12");
    expect(binding?.tmuxPane).toBe("%34");
    expect(binding?.externalSessionName).toBeNull();
  });

  it("attachToNode starts transcript capture when self-attaching from tmux", async () => {
    const rig = rigRepo.createRig("rigged-buildout");
    rigRepo.addNode(rig.id, "dev1.impl2", {
      runtime: "claude-code",
    });
    vi.spyOn(transcriptStore, "ensureTranscriptDir").mockReturnValue(true);

    const result = await selfAttachService.attachToNode({
      rigId: rig.id,
      logicalId: "dev1.impl2",
      context: {
        attachmentType: "tmux",
        tmuxSession: "dev1-impl2@rigged-buildout",
        tmuxWindow: "@12",
        tmuxPane: "%34",
      },
    });

    expect(result.ok).toBe(true);
    // V1 pre-release Item 1: transcript capture path now starts a
    // rotation timer (capture-pane overwrite) instead of pipe-pane.
    // The rotation module's first tick calls capturePaneContent on the
    // adapter; with capturePaneContent unstubbed in the smoke harness,
    // the call is best-effort silent. Test the integration boundary
    // via getActiveRotationCount.
    const { getActiveRotationCount, clearAllTranscriptRotationsForTest } =
      await import("../src/domain/transcript-rotation.js");
    expect(getActiveRotationCount()).toBeGreaterThan(0);
    clearAllTranscriptRotationsForTest();
  });

  it("attachToNode provisions Claude context collection when self-attaching from tmux", async () => {
    const rig = rigRepo.createRig("rigged-buildout");
    rigRepo.addNode(rig.id, "dev1.impl2", {
      runtime: "claude-code",
      cwd: "/Users/mschwarz/code/rigged",
    });

    const result = await selfAttachService.attachToNode({
      rigId: rig.id,
      logicalId: "dev1.impl2",
      context: {
        attachmentType: "tmux",
        tmuxSession: "dev1-impl2@rigged-buildout",
      },
    });

    expect(result.ok).toBe(true);
    expect(ensureContextCollectorSpy).toHaveBeenCalledWith({
      cwd: "/Users/mschwarz/code/rigged",
      tmuxSession: "dev1-impl2@rigged-buildout",
    });
  });
});
