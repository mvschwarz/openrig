// OPR.0.4.3.20 FR-3 — auto-capture of a seat's resume token at the adoption
// boundary (reconcile / adopt / bind). Proves the capture matrix across ALL
// THREE ClaimService adoption paths with injected fakes (a fake Claude sidecar
// reader + a fake Codex thread-id capturer), deterministically — no real `ps`,
// no live tmux. Derivation/persist/validation primitives are reused; this
// suite proves the wiring, provenance, honest-skip, best-effort, terminal-skip,
// idempotency, and secret-free-event invariants.

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
import { resumeProvenanceSchema } from "../src/db/migrations/043_resume_provenance.js";
import { resumeVerificationSchema } from "../src/db/migrations/045_resume_verification.js";
import { seatIdentityVerdictsSchema } from "../src/db/migrations/046_seat_identity_verdicts.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { ClaimService } from "../src/domain/claim-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema,
  discoverySchema, discoveryFkFix, agentspecRebootSchema, podNamespaceSchema,
  externalCliAttachmentSchema, resumeProvenanceSchema, resumeVerificationSchema,
  seatIdentityVerdictsSchema,
];

type SidecarResult = { ok: true; data: { session_id?: string } } | { ok: false; reason: string };

describe("ClaimService FR-3 — adoption-boundary resume-token capture", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let discoveryRepo: DiscoveryRepository;
  let mockTmux: TmuxAdapter;
  let readSidecar: ReturnType<typeof vi.fn>;
  let captureCodexThreadId: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    discoveryRepo = new DiscoveryRepository(db);
    mockTmux = {
      setSessionOption: vi.fn(async () => ({ ok: true as const })),
      getSessionOption: vi.fn(async () => null),
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      startPipePane: vi.fn(async () => ({ ok: true as const })),
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "zsh"),
      getPanePid: vi.fn(async () => 4242),
    } as unknown as TmuxAdapter;
    readSidecar = vi.fn((): SidecarResult => ({ ok: false, reason: "missing_sidecar" }));
    captureCodexThreadId = vi.fn(async (): Promise<string | undefined> => undefined);
  });

  afterEach(() => { db.close(); });

  function buildService(): ClaimService {
    return new ClaimService({
      db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter: mockTmux,
      contextUsageStore: { readSidecar: readSidecar as unknown as (n: string) => SidecarResult },
      resumeTokenCapturer: { captureCodexThreadId: captureCodexThreadId as unknown as (n: string) => Promise<string | undefined> },
    });
  }

  function seedDiscovery(opts?: { runtimeHint?: string; tmuxSession?: string }) {
    return discoveryRepo.upsertDiscoveredSession({
      tmuxSession: opts?.tmuxSession ?? "seat@test-rig",
      tmuxPane: "%0",
      runtimeHint: (opts?.runtimeHint ?? "claude-code") as never,
      confidence: "high",
      cwd: "/projects/app",
    });
  }

  function tokenRow(nodeId: string): { resume_type: string | null; resume_token: string | null; resume_provenance: string | null } {
    return db.prepare(
      "SELECT resume_type, resume_token, resume_provenance FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(nodeId) as { resume_type: string | null; resume_token: string | null; resume_provenance: string | null };
  }

  function latestEvent(): { type: string; payload: Record<string, unknown> } | undefined {
    const row = db.prepare("SELECT type, payload FROM events ORDER BY seq DESC LIMIT 1").get() as { type: string; payload: string } | undefined;
    if (!row) return undefined;
    return { type: row.type, payload: JSON.parse(row.payload) as Record<string, unknown> };
  }

  // ---- bind() path ----

  it("bind captures a Claude resume token from the sidecar session_id (provenance=adoption)", async () => {
    readSidecar.mockReturnValue({ ok: true, data: { session_id: "claude-uuid-1234" } });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "orch-lead@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);

    const row = tokenRow(node.id);
    expect(row.resume_token).toBe("claude-uuid-1234");
    expect(row.resume_type).toBe("claude_id");
    expect(row.resume_provenance).toBe("adoption");

    const ev = latestEvent();
    expect(ev?.type).toBe("session.resume_token_captured");
    expect(ev?.payload.outcome).toBe("captured");
    expect(ev?.payload.provenance).toBe("adoption");
    // Secret-free event: the token value is never in the payload.
    expect(JSON.stringify(ev?.payload)).not.toContain("claude-uuid-1234");
  });

  it("bind captures a Codex resume token from the thread-id capturer (provenance=adoption)", async () => {
    captureCodexThreadId.mockResolvedValue("codex-thread-abcd");
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "codex", tmuxSession: "dev-qa@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "dev.qa" });
    expect(result.ok).toBe(true);

    const row = tokenRow(node.id);
    expect(row.resume_token).toBe("codex-thread-abcd");
    expect(row.resume_type).toBe("codex_id");
    expect(row.resume_provenance).toBe("adoption");
    expect(captureCodexThreadId).toHaveBeenCalledWith("dev-qa@test-rig");
  });

  it("bind honest-skips when the Claude sidecar is missing (no token persisted, skip event with reason)", async () => {
    readSidecar.mockReturnValue({ ok: false, reason: "missing_sidecar" });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "orch-lead@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);

    expect(tokenRow(node.id).resume_token).toBeNull();
    const ev = latestEvent();
    expect(ev?.type).toBe("session.resume_token_captured");
    expect(ev?.payload.outcome).toBe("skipped");
    expect(ev?.payload.reason).toBe("missing_sidecar");
  });

  it("bind honest-skips when the Codex probe times out (undefined → reason=probe_timeout)", async () => {
    captureCodexThreadId.mockResolvedValue(undefined);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "codex", tmuxSession: "dev-qa@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "dev.qa" });
    expect(result.ok).toBe(true);

    expect(tokenRow(node.id).resume_token).toBeNull();
    expect(latestEvent()?.payload.reason).toBe("probe_timeout");
  });

  it("bind honest-skips an invalid/malformed derived token (validity-before-persist → reason=invalid_token)", async () => {
    readSidecar.mockReturnValue({ ok: true, data: { session_id: "bad token with spaces!" } });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "orch-lead@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);

    expect(tokenRow(node.id).resume_token).toBeNull();
    expect(latestEvent()?.payload.reason).toBe("invalid_token");
  });

  it("bind on a terminal-runtime node is exempt: no capture, no event, not a failure", async () => {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "infra.term", { runtime: "terminal", cwd: "/tmp" });
    const discovered = seedDiscovery({ runtimeHint: "terminal", tmuxSession: "infra-term@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "infra.term" });
    expect(result.ok).toBe(true);

    expect(tokenRow(node.id).resume_token).toBeNull();
    expect(readSidecar).not.toHaveBeenCalled();
    expect(captureCodexThreadId).not.toHaveBeenCalled();
    // No capture event emitted — the last event is the node.claimed, not a capture/skip.
    expect(latestEvent()?.type).not.toBe("session.resume_token_captured");
  });

  it("bind is best-effort: a throw inside capture does NOT fail the adoption", async () => {
    readSidecar.mockImplementation(() => { throw new Error("sidecar read blew up"); });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "orch-lead@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);
    expect(tokenRow(node.id).resume_token).toBeNull();
  });

  it("bind emits outcome=preserved (NOT captured) when the provenance guard refuses the write", async () => {
    // The blocker scenario: a valid token IS derived, but a higher-rank token
    // (hook/operator) is already present at write time (e.g. a hook fired during
    // the async probe window). The writer returns false; the event must reflect
    // that the ledger was preserved, never falsely claim a captured adoption write.
    readSidecar.mockReturnValue({ ok: true, data: { session_id: "claude-uuid-preserve" } });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "orch-lead@test-rig" });
    const writeSpy = vi.spyOn(sessionRegistry, "updateResumeToken").mockReturnValue(false);

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);
    // Adoption capture DID attempt the write with the derived token + provenance.
    expect(writeSpy).toHaveBeenCalledWith(expect.any(String), "claude_id", "claude-uuid-preserve", "adoption");

    const ev = latestEvent();
    expect(ev?.type).toBe("session.resume_token_captured");
    expect(ev?.payload.outcome).toBe("preserved");
    expect(ev?.payload.reason).toBe("higher_rank_present");
    // Must NOT falsely report a captured adoption write.
    expect(ev?.payload.provenance).toBeUndefined();
    void node;
  });

  // ---- createAndBindToPod() path ----

  it("createAndBindToPod captures a Claude token from the sidecar", async () => {
    readSidecar.mockReturnValue({ ok: true, data: { session_id: "claude-uuid-cbp" } });
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-dev", rig.id, "dev", "Dev");
    const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "dev-coder@test-rig" });

    const result = await buildService().createAndBindToPod({
      discoveredId: discovered.id, rigId: rig.id, podId: "pod-dev", podNamespace: "dev", memberName: "coder",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = tokenRow(result.nodeId);
    expect(row.resume_token).toBe("claude-uuid-cbp");
    expect(row.resume_provenance).toBe("adoption");
  });

  // ---- reconcileSession() path ----

  /** Seed a previously-managed seat whose binding maps the canonical name to a
   *  node, then mark its session detached (the outage), so reconcileSession can
   *  re-adopt the live session by name. */
  function seedDetachedManagedSeat(runtime: string, sessionName: string) {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.driver", { runtime, cwd: "/projects/app" });
    sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName });
    const s = sessionRegistry.registerClaimedSession(node.id, sessionName);
    sessionRegistry.markDetached(s.id);
    return { rig, node };
  }

  it("reconcileSession captures a Codex token at the no-launch adoption boundary", async () => {
    captureCodexThreadId.mockResolvedValue("codex-thread-reconcile");
    const { node } = seedDetachedManagedSeat("codex", "dev-driver@test-rig");

    const result = await buildService().reconcileSession({ sessionName: "dev-driver@test-rig" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // FR-3 captures a token; it never asserts conversation continuity.
    expect(result.result.continuity).toBe("unverified");

    const row = tokenRow(node.id);
    expect(row.resume_token).toBe("codex-thread-reconcile");
    expect(row.resume_type).toBe("codex_id");
    expect(row.resume_provenance).toBe("adoption");
  });

  it("reconcileSession capture is idempotent: re-reconcile refreshes to a single coherent adoption entry", async () => {
    captureCodexThreadId.mockResolvedValue("codex-thread-v1");
    const { node } = seedDetachedManagedSeat("codex", "dev-driver@test-rig");
    const svc = buildService();

    await svc.reconcileSession({ sessionName: "dev-driver@test-rig" });
    // Simulate the token rolling; re-adopt again.
    captureCodexThreadId.mockResolvedValue("codex-thread-v2");
    const again = await svc.reconcileSession({ sessionName: "dev-driver@test-rig" });
    expect(again.ok).toBe(true);

    // The latest (running) session row carries the refreshed token, still adoption.
    const row = tokenRow(node.id);
    expect(row.resume_token).toBe("codex-thread-v2");
    expect(row.resume_provenance).toBe("adoption");
    // Exactly one running session row for the node (no duplicate/corruption).
    const running = db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE node_id = ? AND status = 'running'").get(node.id) as { c: number };
    expect(running.c).toBe(1);
  });
});
