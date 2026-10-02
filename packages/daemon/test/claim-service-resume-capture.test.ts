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
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { ClaimService } from "../src/domain/claim-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


type SidecarResult = { ok: true; data: { session_id?: string; sampled_at?: string } } | { ok: false; reason: string };

// `ps -o lstart` text (C locale, local time) for a Date, as the process observer reports it.
function lstart(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

describe("ClaimService FR-3 — adoption-boundary resume-token capture", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let discoveryRepo: DiscoveryRepository;
  let mockTmux: TmuxAdapter;
  let readSidecar: ReturnType<typeof vi.fn>;
  let captureCodexThreadId: ReturnType<typeof vi.fn>;
  let claudeProcessStartedAt: ((sessionName: string) => Promise<string | null>) | undefined;

  beforeEach(() => {
    claudeProcessStartedAt = undefined;
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
      ...(claudeProcessStartedAt ? { claudeProcessStartedAt } : {}),
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

  it("bind captures only an OMP seat's own runner session file", async () => {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.omp", { runtime: "omp", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "omp", tmuxSession: "dev-omp@test-rig" });
    const sessionFile = "/openrig/state/omp/dev-omp@test-rig/sessions/live.jsonl";
    const ompRead = vi.fn((name: string) => {
      expect(name).toBe("dev-omp@test-rig");
      return { ok: true as const, sessionFile };
    });
    const piRead = vi.fn(() => { throw new Error("Pi state must not be read for OMP"); });
    const service = new ClaimService({
      db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter: mockTmux,
      ompRunnerStateStore: { readSessionFile: ompRead },
      piRunnerStateStore: { readSessionFile: piRead },
    });

    expect((await service.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "dev.omp" })).ok).toBe(true);
    expect(tokenRow(node.id)).toMatchObject({ resume_type: "omp_session_file", resume_token: sessionFile, resume_provenance: "adoption" });
    expect(ompRead).toHaveBeenCalledOnce();
    expect(piRead).not.toHaveBeenCalled();
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

  // #421: a sidecar can outlive the Claude process that wrote it (a seat that keeps a user's own
  // status line never refreshes it). A sample taken before the pane's current Claude process
  // started can only come from an earlier process.
  describe("sidecar older than the pane's Claude process", () => {
    const processStart = new Date(2026, 9, 2, 11, 0, 0);

    async function bindClaude(sidecar: SidecarResult) {
      readSidecar.mockReturnValue(sidecar);
      const rig = rigRepo.createRig("test-rig");
      const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/app" });
      const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "orch-lead@test-rig" });
      expect((await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" })).ok).toBe(true);
      return { row: tokenRow(node.id), event: latestEvent() };
    }

    it("skips a sidecar sampled before the process started (reason=stale_sidecar)", async () => {
      const startedAt = vi.fn(async () => lstart(processStart));
      claudeProcessStartedAt = startedAt;
      const { row, event } = await bindClaude({ ok: true, data: { session_id: "claude-earlier-process", sampled_at: new Date(2026, 9, 2, 10, 0, 0).toISOString() } });
      expect(row.resume_token).toBeNull();
      expect(event?.payload).toMatchObject({ outcome: "skipped", reason: "stale_sidecar" });
      expect(startedAt).toHaveBeenCalledWith("orch-lead@test-rig");
    });

    it("captures a long-running session's own sample taken after its process started (re-adoption)", async () => {
      claudeProcessStartedAt = async () => lstart(new Date(2026, 8, 28, 9, 0, 0));
      const { row } = await bindClaude({ ok: true, data: { session_id: "claude-current-process", sampled_at: new Date(2026, 9, 2, 10, 0, 0).toISOString() } });
      expect(row.resume_token).toBe("claude-current-process");
    });

    it.each([
      ["no sampled_at", { session_id: "claude-unknown" }, async () => lstart(processStart)],
      ["no locatable process", { session_id: "claude-unknown", sampled_at: new Date(2026, 9, 2, 10, 0, 0).toISOString() }, async () => null],
      ["an unreadable start time", { session_id: "claude-unknown", sampled_at: new Date(2026, 9, 2, 10, 0, 0).toISOString() }, async () => "not a date"],
      ["a failed process read", { session_id: "claude-unknown", sampled_at: new Date(2026, 9, 2, 10, 0, 0).toISOString() }, async () => { throw new Error("ps failed"); }],
    ])("captures as before when staleness is unknown: %s", async (_label, data, startedAt) => {
      claudeProcessStartedAt = startedAt as (sessionName: string) => Promise<string | null>;
      const { row } = await bindClaude({ ok: true, data });
      expect(row.resume_token).toBe("claude-unknown");
    });
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
    return { rig, node, session: s };
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

  it("reconcileSession replaces a stale Claude token only on the newly bound occupant row", async () => {
    const stale = "9e1ac0df-505a-4050-857b-a494b46dabc6";
    const current = "f16594c5-179a-4be7-bf5e-fd759b2b87a3";
    const { node, session } = seedDetachedManagedSeat("claude-code", "dev-driver@test-rig");
    sessionRegistry.updateResumeToken(session.id, "claude_id", stale, "scrape");
    readSidecar.mockReturnValue({ ok: true, data: { session_id: current } });

    const result = await buildService().reconcileSession({ sessionName: "dev-driver@test-rig" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(tokenRow(node.id)).toMatchObject({
      resume_type: "claude_id",
      resume_token: current,
      resume_provenance: "adoption",
    });
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-driver@test-rig");
    expect(sessionRegistry.getSessionsForRig(result.result.rigId).find((row) => row.id === session.id)).toMatchObject({
      status: "detached",
      resumeToken: stale,
    });
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
