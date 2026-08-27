import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { SEAT_HANDOVER_SOURCE_CAPABILITIES } from "../src/domain/seat-handover-planner.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { observeCodexSandbox } from "../src/domain/permission-drift.js";

// OPR.0.5.5.5 (05-handover-sources-real) — fork/rebuild handover sources EXECUTE
// the plan they print. The v0 B3 refusal (`source_not_supported`) is replaced by
// real execution: fork carries incumbent context through the native-fork launch
// seam (launchHarness forkSource), rebuild primes a fresh successor from the
// seat's durable artifact chain and records exactly what it found. Every pin
// here runs the REAL service path over a real DB — fakes only at tmux/adapter.
describe("SeatHandoverService source execution (OPR.0.5.5.5)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let discoveryRepo: DiscoveryRepository;
  let eventBus: EventBus;
  let hasSession: ReturnType<typeof vi.fn>;
  let createSession: ReturnType<typeof vi.fn>;
  let listPanes: ReturnType<typeof vi.fn>;
  let killSession: ReturnType<typeof vi.fn>;
  let respawnPane: ReturnType<typeof vi.fn>;
  let setRemainOnExit: ReturnType<typeof vi.fn>;
  let signalPaneProcess: ReturnType<typeof vi.fn>;
  let isPaneDead: ReturnType<typeof vi.fn>;
  let sendText: ReturnType<typeof vi.fn>;
  let sendKeys: ReturnType<typeof vi.fn>;
  let capturePaneScreen: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;
  let readSidecar: ReturnType<typeof vi.fn>;
  let captureCodexThreadId: ReturnType<typeof vi.fn>;
  let getDefaultShell: ReturnType<typeof vi.fn>;
  let getPaneCommand: ReturnType<typeof vi.fn>;
  let rebuildChain: ReturnType<typeof vi.fn>;
  let artifactExists: ReturnType<typeof vi.fn>;
  let service: SeatHandoverService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    discoveryRepo = new DiscoveryRepository(db);
    eventBus = new EventBus(db);
    hasSession = vi.fn(async () => true);
    createSession = vi.fn(async () => ({ ok: true }));
    listPanes = vi.fn(async () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }]);
    killSession = vi.fn(async () => ({ ok: true }));
    respawnPane = vi.fn(async () => ({ ok: true }));
    setRemainOnExit = vi.fn(async () => ({ ok: true }));
    signalPaneProcess = vi.fn(async () => ({ ok: true }));
    isPaneDead = vi.fn(async () => true);
    sendText = vi.fn(async () => ({ ok: true }));
    sendKeys = vi.fn(async () => ({ ok: true }));
    capturePaneScreen = vi.fn(async () => "predecessor screen tail");
    launchHarness = vi.fn(async () => ({
      ok: true,
      resumeToken: "post-launch-tok",
      resumeType: "codex_id",
      appliedLaunch: observeCodexSandbox(" -s workspace-write"),
    }));
    checkReady = vi.fn(async () => ({ ready: true }));
    readSidecar = vi.fn(() => ({ ok: true, data: { session_id: "claude-sid-123" } }));
    captureCodexThreadId = vi.fn(async () => "codex-discovered-tok");
    getDefaultShell = vi.fn(async () => "/bin/zsh");
    getPaneCommand = vi.fn(async () => "zsh");
    rebuildChain = vi.fn(() => ({
      artifacts: [
        { address: "/seats/dev-impl/RECAP.md", label: "authored recap (chain depth 2)" },
        { address: "/seats/dev-impl/LEARNED.md", label: "seat lineage lessons" },
      ],
    }));
    artifactExists = vi.fn(() => true);
    service = newService();
  });

  afterEach(() => {
    db.close();
  });

  function tmux(): TmuxAdapter {
    return { hasSession, createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, sendText, sendKeys, capturePaneScreen, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
  }

  function codexAdapter(): RuntimeAdapter {
    return { runtime: "codex", launchHarness, checkReady } as unknown as RuntimeAdapter;
  }

  function newService(): SeatHandoverService {
    return new SeatHandoverService({
      db,
      rigRepo,
      sessionRegistry,
      discoveryRepo,
      eventBus,
      tmuxAdapter: tmux(),
      now: () => new Date("2026-04-24T18:30:00.000Z"),
      newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { codex: codexAdapter() },
      contextUsageStore: { readSidecar } as never,
      resumeTokenCapturer: { captureCodexThreadId } as never,
      rebuildPrimingResolver: rebuildChain as never,
      rebuildArtifactExists: artifactExists as never,
      readinessTimeoutMs: 50,
      sleep: async () => {},
    });
  }

  function seedSeat(opts?: { resumeToken?: string | null }) {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%0" });
    if (opts?.resumeToken) {
      sessionRegistry.updateResumeToken(session.id, "codex_id", opts.resumeToken, "scrape");
    }
    return { rig, node, sessionId: session.id };
  }

  function nodeRow(nodeId: string) {
    return db.prepare("SELECT continuity_outcome, handover_result FROM nodes WHERE id = ?").get(nodeId) as Record<string, string | null>;
  }

  // ── Mini-req 1: FORK EXECUTES ────────────────────────────────────────────

  it("fork: executes the cutover with the incumbent's native id carried through the fork launch seam, records continuity_outcome=forked", async () => {
    const { node } = seedSeat({ resumeToken: "native-abc" });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fork:dev-impl@seat-rig",
      operator: "orch-lead@seat-rig",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    // Seat identity preserved: the successor occupies the SAME seat session name
    // (cutover-in-place), the binding moved, the seat/occupant split stays honest.
    expect(result.result).toMatchObject({
      ok: true,
      mutated: true,
      source: { mode: "fork", ref: "dev-impl@seat-rig" },
      currentStatus: { continuityOutcome: "forked", handoverResult: "complete" },
    });
    expect(nodeRow(node.id)).toEqual({ continuity_outcome: "forked", handover_result: "complete" });
    // The launch was a FORK launch: the adapter received the resolved native id,
    // never a blank fresh launch silently reported as a fork.
    const launchOpts = launchHarness.mock.calls.at(-1)?.[1];
    expect(launchOpts).toMatchObject({ forkSource: { kind: "native_id", value: "native-abc" } });
    // The NEW post-fork token (adapter result) is what commit persists — never
    // the parent's token.
    const successor = sessionRegistry.getBindingForNode(node.id);
    expect(successor?.tmuxSession).toBe("dev-impl@seat-rig");
  });

  it("fork: refuses honestly BEFORE any respawn when no native resume id is discoverable — no successor is created, the seat is untouched", async () => {
    seedSeat({ resumeToken: null });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fork:dev-impl@seat-rig",
    });

    expect(result).toMatchObject({ ok: false, code: "resume_token_unavailable" });
    if (result.ok) throw new Error("expected refusal");
    expect(result.message).toContain("dev-impl@seat-rig");
    // Honest refusal is PRE-mutation: the departing pane was never respawned and
    // no harness launch was attempted.
    expect(respawnPane).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
  });

  // ── Mini-req 2: REBUILD EXECUTES ─────────────────────────────────────────

  it("rebuild: executes a fresh launch primed from the durable chain, records the exact priming artifacts and continuity_outcome=rebuilt", async () => {
    const { node } = seedSeat();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "degraded-incumbent",
      source: "rebuild",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(result.result).toMatchObject({
      ok: true,
      mutated: true,
      source: { mode: "rebuild" },
      currentStatus: { continuityOutcome: "rebuilt", handoverResult: "complete" },
    });
    expect(nodeRow(node.id)).toEqual({ continuity_outcome: "rebuilt", handover_result: "complete" });
    // The recorded priming set is EXACTLY what resolved on disk.
    expect(result.result.sourceOutcome).toMatchObject({
      primedArtifacts: [
        expect.objectContaining({ address: "/seats/dev-impl/RECAP.md" }),
        expect.objectContaining({ address: "/seats/dev-impl/LEARNED.md" }),
      ],
      gaps: [],
    });
    // The delivered priming packet names the artifacts (delivered via the same
    // shipped tmux delivery seam as the fresh restore packet).
    const delivered = sendText.mock.calls.map((call) => String(call[1] ?? call[0])).join("\n");
    expect(delivered).toContain("/seats/dev-impl/RECAP.md");
    expect(delivered).toContain("/seats/dev-impl/LEARNED.md");
    // Rebuild is a fresh runtime conversation — never a fork/resume launch.
    const launchOpts = launchHarness.mock.calls.at(-1)?.[1];
    expect(launchOpts?.forkSource).toBeUndefined();
    expect(launchOpts?.resumeToken).toBeUndefined();
  });

  it("rebuild: a declared artifact missing on disk is recorded as a GAP, not silently dropped and not fatal", async () => {
    seedSeat();
    artifactExists.mockImplementation((path: string) => !String(path).includes("LEARNED"));

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "degraded-incumbent",
      source: "rebuild",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(result.result.sourceOutcome).toMatchObject({
      primedArtifacts: [expect.objectContaining({ address: "/seats/dev-impl/RECAP.md" })],
      gaps: ["/seats/dev-impl/LEARNED.md"],
    });
  });

  it("rebuild: an EMPTY durable chain still executes and says so by name — in the result AND in the delivered packet", async () => {
    const { node } = seedSeat();
    rebuildChain.mockImplementation(() => ({ emptyReason: "no recap chain, no LEARNED, no restore packet for this seat" }));

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "degraded-incumbent",
      source: "rebuild",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(nodeRow(node.id)).toEqual({ continuity_outcome: "rebuilt", handover_result: "complete" });
    expect(result.result.sourceOutcome).toMatchObject({
      primedArtifacts: [],
      gaps: [],
      emptyChainReason: "no recap chain, no LEARNED, no restore packet for this seat",
    });
    const delivered = sendText.mock.calls.map((call) => String(call[1] ?? call[0])).join("\n");
    expect(delivered).toContain("no recap chain, no LEARNED, no restore packet for this seat");
  });

  // ── Mini-req 3: PLAN AND EXECUTION AGREE ─────────────────────────────────

  it("plan/executor equality: no source the dry-run plan renders a mutation plan for is refused by execution as source_not_supported", async () => {
    const sources = ["fresh", "fork:dev-impl@seat-rig", "rebuild"];
    for (const source of sources) {
      seedSeat({ resumeToken: "native-abc" });
      const plan = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source, dryRun: true });
      expect(plan, `dry-run plan for --source ${source}`).toMatchObject({ ok: true });
      const executed = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source });
      if (!executed.ok) {
        expect(executed.code, `execution of --source ${source} refused a source its own plan promised`).not.toBe("source_not_supported");
      }
      db.close();
      db = createFullTestDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      discoveryRepo = new DiscoveryRepository(db);
      eventBus = new EventBus(db);
      service = newService();
    }
  });

  it("the ONE shared source-capability table: every source mode has a row, and the dry-run plan renders its create-successor step FROM the table", async () => {
    // Exhaustive Record over SeatHandoverSourceMode — a new mode cannot compile
    // without declaring a row; this pin makes the row's truth reach the plan.
    expect(Object.keys(SEAT_HANDOVER_SOURCE_CAPABILITIES).sort()).toEqual(["discovered", "fork", "fresh", "rebuild"]);
    for (const row of Object.values(SEAT_HANDOVER_SOURCE_CAPABILITIES)) {
      expect(row.executes).toBe(true);
    }
    for (const source of ["fresh", "rebuild", "fork:dev-impl@seat-rig"]) {
      seedSeat();
      const planned = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source, dryRun: true });
      expect(planned.ok).toBe(true);
      if (!planned.ok || !("plan" in planned)) throw new Error("expected plan");
      const step = planned.plan.phases.flatMap((phase) => phase.steps).find((candidate) => candidate.id === "create-successor");
      const mode = source.startsWith("fork") ? "fork" : source;
      expect(step?.description).toContain(SEAT_HANDOVER_SOURCE_CAPABILITIES[mode as keyof typeof SEAT_HANDOVER_SOURCE_CAPABILITIES].contextCarrier);
      db.close();
      db = createFullTestDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      discoveryRepo = new DiscoveryRepository(db);
      eventBus = new EventBus(db);
      service = newService();
    }
  });

  // ── Mini-req 4: MID-SWAP FAILURE IS HONEST ───────────────────────────────

  it("fork: an induced launch failure mid-swap reports the failing step, leaves the binding unchanged and the seat recoverable — never a false complete", async () => {
    const { node } = seedSeat({ resumeToken: "native-abc" });
    launchHarness.mockImplementation(async () => ({ ok: false, error: "induced: harness died mid-launch" }));

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fork:dev-impl@seat-rig",
    });

    expect(result).toMatchObject({ ok: false, code: "successor_create_failed" });
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toContain("induced: harness died mid-launch");
    // Recorded partial state: the registry binding never moved and the node row
    // records no false completion.
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(nodeRow(node.id).handover_result).not.toBe("complete");
    expect(result.guidance).toMatch(/re-wakeable|binding is unchanged/);
  });

  it("rebuild: an induced priming-delivery failure unwinds the successor candidate and reports the step — binding unchanged", async () => {
    const { node } = seedSeat();
    sendText.mockImplementation(async () => ({ ok: false, error: "induced: tmux delivery down" }));

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "degraded-incumbent",
      source: "rebuild",
    });

    expect(result).toMatchObject({ ok: false, code: "context_delivery_failed" });
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(nodeRow(node.id).handover_result).not.toBe("complete");
  });
});
