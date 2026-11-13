// #2985 / #2861: a handover that fails after the in-place respawn can leave its successor Claude running in the pane,
// never adopted (its reserved generation is never registered, so its hooks are answered generation_uncommitted and
// the seat stays on the previous conversation). `recover` adopts that running successor and keeps its conversation:
// it proves the pane's one Claude is exactly the launch the failed handover sent (the session id the daemon generated
// for it), then commits the handover with the reserved generation, typing nothing into the pane.
// Process startup and pane bytes are modeled; no native Claude. The fixture is the #2985 one of
// claude-handover-readiness.test.ts, on a fully migrated database, with the real activity route and relay.
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { activityRoutes } from "../src/routes/activity.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { abandonOpenHandoverAttempt, openHandoverAttempt } from "../src/domain/seat-handover-attempts.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { SessionAddressConflict } from "../src/domain/session-registry.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";

const relay = createRequire(import.meta.url)(path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs")) as {
  buildSessionIdentityPayload(p: unknown, env: Record<string, string>): Record<string, unknown> | null;
};

const SEAT = "dev-impl@seat-rig";
const previousToken = "11111111-1111-4111-8111-111111111111";
const successorToken = "22222222-2222-4222-8222-222222222222";
const otherToken = "33333333-3333-4333-8333-333333333333";
const ISSUE_NATIVE_AT = 33_000; // the issue: the new Claude was seen about 3 s after the 30 s readiness window closed

describe("#2985 recover: adopt the running successor of a failed handover", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let discoveryRepo: DiscoveryRepository;
  let eventBus: EventBus;
  let nodeId: string;
  let sessionId: string;
  let elapsed: number;
  let requested: boolean;
  let nativeAt: number;
  let paneProcesses: () => NativeProcessRow[];
  let panes: () => Array<{ id: string; index: number; cwd: string; width: number; height: number; active: boolean }>;
  const calls = { respawnPane: vi.fn(), sendText: vi.fn(), sendKeys: vi.fn(), killSession: vi.fn(), signalPaneProcess: vi.fn() };
  const startedAtMs = Date.parse("2026-11-10T16:21:00Z");
  const startedAt = "Tue Nov 10 16:21:00 2026";

  const running = () => requested && elapsed >= nativeAt;
  const oldFrame = "Claude Code v2.1.322\n❯ predecessor finished turn\n  ⏵⏵ accept edits on (shift+tab to cycle)";
  const freshFrame = "───────── dev-impl@seat-rig ─\n❯ \n─────────\n  ⏵⏵ accept edits on (shift+tab to cycle)";

  function claudeIn(token: string, pid = 102, pgid = pid): NativeProcessRow {
    return { pid, ppid: 100, pgid, tpgid: 102, command: `claude --session-id ${token} --name ${SEAT}`, executableName: "claude", startedAt } as NativeProcessRow;
  }

  function tmux(): TmuxAdapter {
    return {
      hasSession: vi.fn(async () => true),
      createSession: vi.fn(async () => ({ ok: true })),
      listPanes: vi.fn(async () => panes()),
      killSession: vi.fn(async (...a: unknown[]) => { calls.killSession(...a); return { ok: true }; }),
      respawnPane: vi.fn(async (...a: unknown[]) => { calls.respawnPane(...a); return { ok: true }; }),
      setRemainOnExit: vi.fn(async () => ({ ok: true })),
      signalPaneProcess: vi.fn(async (...a: unknown[]) => { calls.signalPaneProcess(...a); return { ok: true }; }),
      isPaneDead: vi.fn(async () => true),
      sendText: vi.fn(async (session: string, text: string) => {
        calls.sendText(session, text);
        if (text.includes("claude ") && text.includes(`--session-id ${successorToken}`)) requested = true;
        return { ok: true };
      }),
      sendKeys: vi.fn(async (...a: unknown[]) => { calls.sendKeys(...a); return { ok: true }; }),
      capturePaneScreen: vi.fn(async () => requested ? freshFrame : `${oldFrame}\n❯ `),
      capturePaneContent: vi.fn(async () => requested ? freshFrame : `${oldFrame}\n❯ `),
      getDefaultShell: vi.fn(async () => "/bin/zsh"),
      getPaneCommand: vi.fn(async () => running() ? "claude" : "zsh"),
      getPanePid: vi.fn(async () => 100),
      sendShellCommand: async (session: string, text: string) => (tmuxRef as unknown as { sendText(s: string, t: string): Promise<unknown> }).sendText(session, text),
    } as unknown as TmuxAdapter;
  }
  let tmuxRef: TmuxAdapter;

  /** A managed launch through a `#!` wrapper (#2341): the launch's frozen executable is the script. */
  const WRAPPER = "/home/user/.local/bin/claude-wrap";
  let managedLaunch: { executable: string; executableIsScript: boolean } | null;

  function service(extra: Partial<ConstructorParameters<typeof SeatHandoverService>[0]> = {}): SeatHandoverService {
    const listProcesses = () => paneProcesses();
    const fsError = () => { throw new Error("unexpected filesystem access"); };
    const managed = managedLaunch ? { claudeManagedLaunch: { prepare: async () => ({ command: (args: readonly string[]) => `claude ${args.join(" ")}`,
      assertCurrent: () => {}, configDir: "/fixture", ...managedLaunch }) } as never } : {};
    const claude = new ClaudeCodeAdapter({ tmux: tmuxRef, fsOps: managedLaunch
      ? { exists: () => false, readFile: () => "", writeFile: () => {}, mkdirp: () => {}, copyFile: () => {} }
      : { exists: () => false, readFile: fsError, writeFile: fsError, mkdirp: fsError, copyFile: fsError },
      listProcesses, sleep: async () => {}, sessionIdFactory: () => successorToken, ...managed });
    return new SeatHandoverService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: tmuxRef, now: () => new Date("2026-11-10T16:21:00Z"), newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { "claude-code": claude as unknown as RuntimeAdapter },
      contextUsageStore: { readSidecar: () => ({ ok: false }) } as never, resumeTokenCapturer: { captureCodexThreadId: async () => null } as never,
      occupantInvalidator: { invalidateRetiringOccupant: vi.fn() }, activityOracle: { declareOccupantSwap: vi.fn() },
      predecessorRecapResolver: (() => ({ unavailableReason: "test: no record" })) as never, readinessTimeoutMs: 30_000,
      listProcesses,
      sleep: async ms => { elapsed += ms; vi.setSystemTime(startedAtMs + elapsed); },
      ...extra,
    });
  }

  /** The successor's Claude SessionStart, through the shipped relay and the real activity route. */
  async function sessionStart(generation: string, token = successorToken, source = "startup") {
    const app = new Hono();
    app.use("*", async (c, go) => {
      c.set("agentActivityStore" as never, new AgentActivityStore({ db, eventBus }) as never);
      c.set("activityHookToken" as never, "fixture" as never);
      c.set("sessionRegistry" as never, sessionRegistry as never);
      c.set("eventBus" as never, eventBus as never);
      await go();
    });
    app.route("/api/activity", activityRoutes);
    const env = { OPENRIG_SESSION_NAME: SEAT, OPENRIG_NODE_ID: nodeId, OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: generation };
    const payload = relay.buildSessionIdentityPayload({ hook_event_name: "SessionStart", session_id: token, source }, env);
    const res = await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify(payload) });
    return await res.json() as Record<string, unknown>;
  }

  const state = () => ({
    sessions: db.prepare("SELECT id, session_name, status, origin, resume_token FROM sessions ORDER BY id").all(),
    tenures: db.prepare("SELECT generation_uuid, kind FROM occupant_tenures ORDER BY generation_ordinal").all(),
    node: db.prepare("SELECT handover_result, continuity_outcome, previous_occupant FROM nodes WHERE id = ?").get(nodeId),
    handovers: db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'seat.handover_completed'").get(),
  });
  const inputs = () => ({ respawn: calls.respawnPane.mock.calls.length, text: calls.sendText.mock.calls.length,
    keys: calls.sendKeys.mock.calls.length, kill: calls.killSession.mock.calls.length, signal: calls.signalPaneProcess.mock.calls.length });

  /** The #2985 failure: a rebuild handover whose readiness times out at 30 s; then the successor comes up. */
  async function failedHandover(): Promise<string> {
    const result = await service().handover({ seatRef: SEAT, source: "rebuild", reason: "context-wall" });
    expect(result).toMatchObject({ ok: false, code: "successor_create_failed", replacementStarted: true, successorPane: "%9" });
    const generation = (calls.respawnPane.mock.calls[0]?.[2] as { env?: Record<string, string> } | undefined)?.env?.OPENRIG_OCCUPANT_GENERATION;
    expect(generation).toBeTruthy();
    expect(sessionRegistry.isOccupantGenerationRegistered(nodeId, generation!)).toBe(false);
    elapsed = nativeAt + 1000; // a few seconds after the window closed, the successor runs in the pane
    vi.setSystemTime(startedAtMs + elapsed);
    return generation!;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(startedAtMs);
    for (const fn of Object.values(calls)) fn.mockReset();
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    discoveryRepo = new DiscoveryRepository(db);
    eventBus = new EventBus(db);
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/project" });
    nodeId = node.id;
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", "2026-11-09T12:00:00Z");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: "%9" });
    sessionRegistry.updateResumeToken(session.id, "claude_id", previousToken, "hook");
    sessionId = session.id;
    elapsed = 0;
    requested = false;
    nativeAt = ISSUE_NATIVE_AT;
    managedLaunch = null;
    panes = () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }];
    paneProcesses = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: running() ? 102 : 100, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
      ...(running() ? [claudeIn(successorToken)] : []),
    ];
    tmuxRef = tmux();
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("adopts the running successor with its reserved generation and keeps its conversation, typing nothing into the pane", async () => {
    const generation = await failedHandover();
    // The issue's state: the successor's SessionStart is held back and the seat stays on the previous conversation.
    expect(await sessionStart(generation)).toMatchObject({ ok: true, tokenPersisted: false, code: "generation_uncommitted" });
    // A held message: a committed handover types its notice into the successor; a recovery types nothing.
    new OutboxHandler(db).retain({ outboxId: "held-1", senderSession: "orch-lead@seat-rig", destinationSession: SEAT, body: "Real work for you" },
      { nodeId, session: SEAT, occupant: null, pane: null });
    const before = inputs();

    // A fresh service (a daemon restarted since the failure keeps nothing in memory) adopts the successor.
    const result = await service().recover({ seatRef: SEAT, reason: "adopt the running successor" });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
    expect(result.result.recoveredFrom).toMatchObject({ failedStep: "start_agent", failureCode: "successor_not_ready" });
    expect(result.result.sideEffects).toMatchObject({ startupContextDelivered: false, provenanceRecordWritten: true });
    // The successor's reserved generation is now the seat's occupant generation, and its conversation the resume target.
    expect(sessionRegistry.isOccupantGenerationRegistered(nodeId, generation)).toBe(true);
    expect(sessionRegistry.currentOccupantTenure(nodeId)).toMatchObject({ generationUuid: generation, kind: "handover" });
    const sessions = db.prepare("SELECT id, status, origin, resume_token FROM sessions WHERE node_id = ? ORDER BY id").all(nodeId) as Array<Record<string, unknown>>;
    expect(sessions.find((s) => s["id"] === sessionId)).toMatchObject({ status: "superseded", resume_token: previousToken });
    expect(sessions.at(-1)).toMatchObject({ status: "running", origin: "launched", resume_token: successorToken });
    // A rebuild whose priming packet never reached the successor is not recorded as rebuilt.
    expect(db.prepare("SELECT handover_result, continuity_outcome FROM nodes WHERE id = ?").get(nodeId))
      .toEqual({ handover_result: "complete", continuity_outcome: "fresh" });
    const events = db.prepare("SELECT payload FROM events WHERE type = 'seat.handover_completed'").all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ recoveredFrom: { failedStep: "start_agent", failureCode: "successor_not_ready" } });
    // Nothing was typed into, respawned in or killed in the pane: the successor's work is untouched. The held message
    // is named on the result only.
    expect(inputs()).toEqual(before);
    expect(result.result.warnings).toEqual([`1 held message was kept for this seat and not delivered: read it with rig seat held-messages ${SEAT}.`]);
    // The closed attempt keeps no resume token.
    expect(db.prepare("SELECT phase, resume_token FROM seat_handover_attempts").all()).toEqual([{ phase: "adopted", resume_token: null }]);

    // The same SessionStart now moves the seat's resume target, as for any committed handover.
    expect(await sessionStart(generation)).toMatchObject({ ok: true, tokenPersisted: true });
    // And there is nothing left to recover.
    expect(await service().recover({ seatRef: SEAT, reason: "again" })).toMatchObject({ ok: false, code: "no_handover_to_recover" });
  });

  // CodeRabbit on #3044 (the activity grant): only a Claude successor is adopted, and the Claude launch issues no
  // run-bound activity grant, so the failure revoked none and the recovered seat has none to restore. The recovery
  // refuses any other runtime, which keeps it that way.
  it("adopts a Claude successor with no activity grant to restore, and refuses a seat whose runtime is no longer Claude", async () => {
    await failedHandover();
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_grants WHERE node_id = ?").get(nodeId)).toEqual({ n: 0 });
    db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(nodeId);
    const before = state();
    expect(await service().recover({ seatRef: SEAT, reason: "adopt" })).toMatchObject({ ok: false, code: "recover_runtime_unsupported" });
    expect(state()).toEqual(before);
    db.prepare("UPDATE nodes SET runtime = 'claude-code' WHERE id = ?").run(nodeId);
    expect(await service().recover({ seatRef: SEAT, reason: "adopt" })).toMatchObject({ ok: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_grants WHERE node_id = ?").get(nodeId)).toEqual({ n: 0 });
  });

  it("#3044: the recovered successor keeps the applied-launch observation its launch returned", async () => {
    const generation = await failedHandover();
    // The failed attempt records what the launch applied, though only readiness failed.
    const attempt = db.prepare("SELECT applied_launch_json FROM seat_handover_attempts").get() as { applied_launch_json: string | null };
    expect(attempt.applied_launch_json).not.toBeNull();
    const result = await service().recover({ seatRef: SEAT, reason: "adopt the running successor" });
    expect(result).toMatchObject({ ok: true });
    expect(sessionRegistry.currentOccupantTenure(nodeId)).toMatchObject({ generationUuid: generation });
    // The adopted generation carries the observation, as a committed handover's would.
    expect(new AppliedLaunchObservationStore(db).readCurrent(nodeId)).toMatchObject({ axis: "permission" });
  });

  it("refuses, writing nothing, when the pane's Claude is another conversation", async () => {
    await failedHandover();
    paneProcesses = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 102, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
      claudeIn(otherToken),
    ];
    const before = state();
    const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
    expect(result).toMatchObject({ ok: false, code: "successor_identity_unproven" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("another conversation");
    expect(state()).toEqual(before);
  });

  it("refuses when the pane holds two Claudes, or is no longer the seat's only pane", async () => {
    await failedHandover();
    const before = state();
    paneProcesses = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 102, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
      claudeIn(successorToken, 102), claudeIn(successorToken, 103, 102), // two in the pane's foreground group
    ];
    const two = await service().recover({ seatRef: SEAT, reason: "adopt" });
    expect(two).toMatchObject({ ok: false, code: "successor_identity_unproven" });
    // SR1 (Sol nit): two recognized Claudes on a classic launch are not "unprovable": one may exit, so the recovery
    // still says to run it again, not that --recover can't prove it.
    if (two.ok) throw new Error("expected a refusal");
    expect(two.message).not.toContain("recorded no executable");
    expect(two.guidance).toMatch(/run the recovery again in a moment/);
    paneProcesses = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 102, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
      claudeIn(successorToken),
    ];
    panes = () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true },
      { id: "%10", index: 1, cwd: "/project", width: 80, height: 24, active: false }];
    expect(await service().recover({ seatRef: SEAT, reason: "adopt" })).toMatchObject({ ok: false, code: "successor_identity_unproven" });
    expect(state()).toEqual(before);
  });

  it("refuses a failed attempt that a later launch or handover has superseded, and closes it", async () => {
    await failedHandover();
    // Another occupant took the seat after the failure (here a handover-kind registration, as a launch makes).
    sessionRegistry.registerClaimedSession(nodeId, SEAT, "handover");
    const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
    expect(result).toMatchObject({ ok: false, code: "handover_attempt_superseded" });
    expect(db.prepare("SELECT phase, resume_token FROM seat_handover_attempts").all()).toEqual([{ phase: "abandoned", resume_token: null }]);
    expect(await service().recover({ seatRef: SEAT, reason: "adopt" })).toMatchObject({ ok: false, code: "no_handover_to_recover" });
  });

  it("still adopts after a no-launch adoption of the same pane (a reconcile), which continues the occupant", async () => {
    const generation = await failedHandover();
    sessionRegistry.registerClaimedSession(nodeId, SEAT, "adopt");
    const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
    expect(result).toMatchObject({ ok: true });
    expect(sessionRegistry.currentOccupantTenure(nodeId)).toMatchObject({ generationUuid: generation, kind: "handover" });
  });

  it("refuses when the pane changes while the successor is being proven", async () => {
    await failedHandover();
    let listed = 0;
    panes = () => ++listed === 1 ? [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }]
      : [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }, { id: "%10", index: 1, cwd: "/project", width: 80, height: 24, active: false }];
    const before = state();
    const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
    expect(result).toMatchObject({ ok: false, code: "successor_identity_unproven" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("changed while its successor was being proven");
    expect(state()).toEqual(before);
  });

  it("adopts nothing when the reserved generation can't be registered (rolled back)", async () => {
    const generation = await failedHandover();
    // The generation is taken elsewhere (it is unique across the ledger), so minting it for this seat fails.
    const rig = rigRepo.createRig("other-rig");
    const other = rigRepo.addNode(rig.id, "dev.other", { runtime: "claude-code", cwd: "/other" });
    sessionRegistry.mintOccupantTenure(other.id, "adopt", null, generation);
    const before = state();
    const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
    expect(result).toMatchObject({ ok: false, code: "handover_commit_failed" });
    expect(state()).toEqual(before);
    expect(openHandoverAttempt(db, nodeId)).not.toBeNull();
  });

  it("#2861 item 2: a finalization refusal after the successor is ready records it; once the claim is gone, it is adopted", async () => {
    nativeAt = 0; // the successor is ready within the window; finalization refuses on a live owner's pane claim
    const otherRig = rigRepo.createRig("other-rig");
    const owner = rigRepo.addNode(otherRig.id, "dev.owner", { runtime: "claude-code", cwd: "/other" });
    const ownerSession = sessionRegistry.registerSession(owner.id, "dev-owner@other-rig");
    sessionRegistry.updateStatus(ownerSession.id, "running");
    const row = discoveryRepo.upsertDiscoveredSession({ tmuxSession: SEAT, tmuxPane: "%9", runtimeHint: "claude-code", confidence: "high" });
    discoveryRepo.markClaimed(row.id, owner.id);
    const failed = await service().handover({ seatRef: SEAT, source: "rebuild", reason: "context-wall" });
    expect(failed).toMatchObject({ ok: false, code: "discovered_not_active" });
    if (failed.ok) throw new Error("expected a refusal");
    expect(failed.guidance).toMatch(/^If the successor is running there, adopt it/);
    expect(openHandoverAttempt(db, nodeId)).toMatchObject({ failedStep: "finalize", failureCode: "discovered_not_active", contextDelivery: "unconfirmed" });
    // While the live owner holds the claim, the recovery refuses the same way (#987) and the attempt stays open.
    expect(await service().recover({ seatRef: SEAT, reason: "adopt" })).toMatchObject({ ok: false, code: "discovered_not_active" });
    expect(openHandoverAttempt(db, nodeId)).not.toBeNull();
    // The owner goes: its rig archived and its session exited, so its claim is stale (#2869).
    sessionRegistry.updateStatus(ownerSession.id, "exited");
    rigRepo.archiveRig(otherRig.id);
    // A race: the owner resumes during the presence probe, after the claim was read as stale. The commit's own check
    // refuses, and the attempt stays open (nothing it wrote is kept).
    const probe = tmuxRef.hasSession;
    (tmuxRef as unknown as { hasSession: unknown }).hasSession = vi.fn(async () => { sessionRegistry.updateStatus(ownerSession.id, "running"); return true; });
    expect(await service().recover({ seatRef: SEAT, reason: "adopt" })).toMatchObject({ ok: false, code: "discovered_not_active" });
    expect(openHandoverAttempt(db, nodeId)).not.toBeNull();
    (tmuxRef as unknown as { hasSession: unknown }).hasSession = probe;
    sessionRegistry.updateStatus(ownerSession.id, "exited");
    const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected a committed recovery");
    // The fixture's priming packet was sent but its submission never confirmed: the recovery says so, as the handover would
    // have, and the seat is recorded as rebuilt (the packet may have landed), not as fresh.
    expect(result.result.sideEffects.startupContextDelivered).toBe(false);
    expect(result.result.restorePacket).toMatchObject({ status: "unconfirmed" });
    expect(db.prepare("SELECT continuity_outcome FROM nodes WHERE id = ?").get(nodeId)).toEqual({ continuity_outcome: "rebuilt" });
  });

  it("has nothing to recover for a seat without a failed handover, and needs a reason", async () => {
    expect(await service().recover({ seatRef: SEAT, reason: "adopt" })).toMatchObject({ ok: false, code: "no_handover_to_recover" });
    expect(await service().recover({ seatRef: SEAT, reason: " " })).toMatchObject({ ok: false, code: "missing_reason" });
  });

  it("the failure's guidance leads with the recovery once the attempt is recorded, and does not say to retry", async () => {
    const result = await service().handover({ seatRef: SEAT, source: "rebuild", reason: "context-wall" });
    if (result.ok) throw new Error("expected failure");
    expect(result.guidance).toMatch(new RegExp(`^If the successor is running there, adopt it .*rig seat handover '${SEAT}' --recover --reason`));
    // The rest is #3003's readiness text, unchanged (claude-handover-readiness.test.ts): it warns that another handover
    // or a fresh launch with --stop ends the successor, and never says "retry".
    expect(result.guidance).toContain(`Another handover, or rig seat launch '${SEAT}' --fresh --stop --reason "<why>", ends that successor if it goes ahead`);
    expect(result.guidance).not.toMatch(/\bretry\b/i);
  });
  // Should S3 of the review of #3044: the commit transaction checks again that the attempt still replaces the seat's
  // occupant, after the proof. Something that takes the seat between the proof and the transaction (the presence probe
  // is the last await) must leave nothing adopted, the attempt abandoned and the recovery's own code.
  it.each([
    ["another occupant registers", () => { sessionRegistry.registerClaimedSession(nodeId, SEAT, "handover"); },
      "another occupant took the seat during the recovery"],
    ["the attempt is closed concurrently", () => { abandonOpenHandoverAttempt(db, nodeId, "concurrent"); }, "concurrent"],
  ])("refuses when, between the proof and the commit, %s (the CAS inside the transaction)", async (_name, race, outcome) => {
    const generation = await failedHandover();
    let snapshot: ReturnType<typeof state> | null = null;
    (tmuxRef as unknown as { hasSession: unknown }).hasSession = vi.fn(async () => { race(); snapshot = state(); return true; });
    const before = inputs();
    const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
    expect(result).toMatchObject({ ok: false, code: "handover_attempt_superseded" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("while the recovery was proving");
    expect(tmuxRef.hasSession).toHaveBeenCalled(); // the proof passed: the refusal is the transaction's
    expect(snapshot).not.toBeNull();
    expect(state()).toEqual(snapshot); // rolled back: nothing adopted
    expect(sessionRegistry.isOccupantGenerationRegistered(nodeId, generation)).toBe(false);
    expect(inputs()).toEqual(before);
    expect(db.prepare("SELECT phase, resume_token, outcome FROM seat_handover_attempts").all())
      .toEqual([{ phase: "abandoned", resume_token: null, outcome }]);
    expect(await service().recover({ seatRef: SEAT, reason: "adopt" })).toMatchObject({ ok: false, code: "no_handover_to_recover" });
  });

  // Should S4, S5 and S6: each finalize refusal that can change records the attempt and offers --recover first, without
  // telling to retry the handover (that ends the running successor, #2985); a refusal outside the set records nothing.
  // successor_tmux_absent is outside it: the seat's session is gone, so there is no successor to adopt (S5).
  /** Arms `setup` right after the launcher's discovery upsert, the launch's last step before finalize. */
  function beforeFinalize(setup: (row: { id: string }) => void) {
    const real = discoveryRepo.upsertDiscoveredSession.bind(discoveryRepo);
    let arm: typeof setup | null = setup;
    vi.spyOn(discoveryRepo, "upsertDiscoveredSession").mockImplementation((d) => {
      const row = real(d); const go = arm; arm = null; go?.(row); return row;
    });
  }
  const recoverable: Array<[string, () => void]> = [
    ["discovered_not_active", () => beforeFinalize(row => discoveryRepo.markVanished([row.id]))],
    ["successor_already_managed", () => beforeFinalize(() => {
      const other = rigRepo.addNode(rigRepo.createRig("other-rig").id, "dev.other", { runtime: "claude-code", cwd: "/other" });
      sessionRegistry.updateBinding(other.id, { tmuxSession: SEAT, tmuxPane: "%1" });
    })],
    ["address_conflict", () => beforeFinalize(() => {
      vi.spyOn(sessionRegistry, "assertAddressAvailable").mockImplementationOnce(() => { throw new SessionAddressConflict(SEAT); });
    })],
    ["tmux_probe_failed", () => beforeFinalize(() => { (tmuxRef.hasSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("tmux busy")); })],
    ["handover_commit_failed", () => beforeFinalize(() => {
      vi.spyOn(sessionRegistry, "registerClaimedSession").mockImplementationOnce(() => { throw new Error("boom"); });
    })],
  ];
  it.each(recoverable)("a %s refusal after the successor is ready records the attempt and leads with --recover", async (code, arm) => {
    nativeAt = 0;
    arm();
    const failed = await service().handover({ seatRef: SEAT, source: "rebuild", reason: "context-wall" });
    expect(failed).toMatchObject({ ok: false, code });
    if (failed.ok) throw new Error("expected a refusal");
    expect(openHandoverAttempt(db, nodeId)).toMatchObject({ failedStep: "finalize", failureCode: code });
    expect(failed.guidance).toMatch(/^If the successor is running there, adopt it .* --recover --reason/);
    expect(failed.guidance).toContain("do not retry the handover; it ends the running successor");
    expect(failed.guidance!.replace("do not retry the handover", "")).not.toMatch(/retr/i);
  });

  // #3044 CodeRabbit: a rebuild that fails at finalize already executed its priming; the recovery reports that outcome,
  // as recorded with the attempt, on the result and on seat.handover_completed.
  it("a recovered rebuild keeps the rebuild outcome its failed handover recorded", async () => {
    nativeAt = 0;
    beforeFinalize(() => {
      vi.spyOn(sessionRegistry, "registerClaimedSession").mockImplementationOnce(() => { throw new Error("boom"); });
    });
    const failed = await service().handover({ seatRef: SEAT, source: "rebuild", reason: "context-wall" });
    expect(failed).toMatchObject({ ok: false, code: "handover_commit_failed" });
    const expected = { mode: "rebuild", primedArtifacts: [], gaps: [], emptyChainReason: "no rebuild priming resolver wired on this daemon" };
    const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
    if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
    expect(result.result.sourceOutcome).toEqual(expected);
    const events = db.prepare("SELECT payload FROM events WHERE type = 'seat.handover_completed'").all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload).sourceOutcome).toEqual(expected);
  });

  // The outcome is the one the failed handover executed, not recomputed at recovery: the artifact it primed with is
  // gone by then, and the recovered result still names it.
  it("a recovered rebuild reports the artifacts it primed with even when they are gone at recovery", async () => {
    nativeAt = 0;
    let exists = true;
    const deps = { rebuildPrimingResolver: () => ({ artifacts: [{ address: "/project/a.md", label: "a" }] }),
      rebuildArtifactExists: () => exists };
    beforeFinalize(() => {
      vi.spyOn(sessionRegistry, "registerClaimedSession").mockImplementationOnce(() => { throw new Error("boom"); });
    });
    const failed = await service(deps).handover({ seatRef: SEAT, source: "rebuild", reason: "context-wall" });
    expect(failed).toMatchObject({ ok: false, code: "handover_commit_failed" });
    exists = false;
    const result = await service(deps).recover({ seatRef: SEAT, reason: "adopt" });
    if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
    expect(result.result.sourceOutcome).toMatchObject({ mode: "rebuild",
      primedArtifacts: [expect.objectContaining({ address: "/project/a.md" })] });
  });

  it.each([
    ["successor_tmux_absent", () => beforeFinalize(() => { (tmuxRef.hasSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false); })],
    ["runtime_mismatch", () => {
      const real = discoveryRepo.upsertDiscoveredSession.bind(discoveryRepo);
      beforeFinalize(() => { real({ tmuxSession: SEAT, tmuxPane: "%9", runtimeHint: "codex", confidence: "high" }); });
    }],
  ] as Array<[string, () => void]>)("a %s refusal records nothing and offers no --recover", async (code, arm) => {
    nativeAt = 0;
    arm();
    const failed = await service().handover({ seatRef: SEAT, source: "rebuild", reason: "context-wall" });
    expect(failed).toMatchObject({ ok: false, code });
    if (failed.ok) throw new Error("expected a refusal");
    expect(openHandoverAttempt(db, nodeId)).toBeNull();
    expect(failed.guidance ?? "").not.toContain("--recover");
  });

  // Should S2: a /clear in the successor before the recovery rotates its conversation, and its SessionStart is held back
  // (generation_uncommitted). The argv still names the launch's id, so the proof passes; the recovery then takes the
  // process's current conversation from Claude's sessions/<pid>.json (read only, as the resume refresher reads it).
  describe("a /clear before the recovery", () => {
    let configDir: string;
    const T2 = otherToken;
    beforeEach(() => {
      configDir = mkdtempSync(path.join(os.tmpdir(), "recover-clear-"));
      mkdirSync(path.join(configDir, "sessions"));
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(configDir, { recursive: true, force: true });
    });
    // Relative to the process start as ps prints it (local time), so the case holds in any time zone.
    const pidFile = (record: Record<string, unknown>, mtime = new Date(Date.parse(startedAt) + 60_000)) => {
      const file = path.join(configDir, "sessions", "102.json");
      writeFileSync(file, JSON.stringify(record));
      utimesSync(file, mtime, mtime);
    };
    const resumeTarget = () => (db.prepare("SELECT resume_token FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(nodeId) as { resume_token: string }).resume_token;

    it("adopts the successor with the conversation it holds now (T2), not the launch's", async () => {
      const generation = await failedHandover();
      expect(await sessionStart(generation, successorToken, "startup")).toMatchObject({ code: "generation_uncommitted" });
      expect(await sessionStart(generation, T2, "clear")).toMatchObject({ code: "generation_uncommitted" });
      pidFile({ name: SEAT, sessionId: T2 });
      const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
      expect(result).toMatchObject({ ok: true });
      expect(resumeTarget()).toBe(T2);
    });

    it("refuses, adopting nothing, when the process changes while its current conversation is read", async () => {
      await failedHandover();
      pidFile({ name: SEAT, sessionId: T2 });
      let listed = 0;
      const before = state();
      paneProcesses = () => [
        { pid: 100, ppid: 1, pgid: 100, tpgid: 102, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
        // the proof's two samples see one process; the observation that brackets the file read sees another
        ++listed <= 2 ? claudeIn(successorToken) : { ...claudeIn(successorToken), startedAt: "Tue Nov 10 16:22:00 2026" },
      ];
      const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
      expect(result).toMatchObject({ ok: false, code: "successor_identity_unproven" });
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("current conversation was being read");
      expect(state()).toEqual(before);
    });

    it("records the retiring occupant's conversation when the successor holds it, and says so", async () => {
      await failedHandover();
      pidFile({ name: SEAT, sessionId: previousToken });
      const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
      // The resume target is the conversation the proven process is on, not the launch's id it no longer holds.
      expect(resumeTarget()).toBe(previousToken);
      expect(db.prepare("SELECT status, resume_token FROM sessions WHERE id = ?").get(sessionId))
        .toEqual({ status: "superseded", resume_token: previousToken });
      expect(result.result.warnings).toEqual([expect.stringContaining("the retiring occupant's conversation")]);
      // It resumed an existing conversation: not recorded as a fresh or rebuilt one.
      expect(db.prepare("SELECT continuity_outcome FROM nodes WHERE id = ?").get(nodeId)).toEqual({ continuity_outcome: "resumed" });
    });

    describe("a fork whose parent is a live seat", () => {
      const PARENT = "dev-parent@seat-rig";
      const parentToken = "44444444-4444-4444-8444-444444444444";
      let parentNodeId: string;
      let parentSessionId: string;
      beforeEach(() => {
        const rigId = (db.prepare("SELECT rig_id FROM nodes WHERE id = ?").get(nodeId) as { rig_id: string }).rig_id;
        parentNodeId = rigRepo.addNode(rigId, "dev.parent", { runtime: "claude-code", cwd: "/project" }).id;
        const parent = sessionRegistry.registerSession(parentNodeId, PARENT);
        sessionRegistry.updateStatus(parent.id, "running");
        sessionRegistry.updateStartupStatus(parent.id, "ready", "2026-11-09T12:00:00Z");
        sessionRegistry.updateBinding(parentNodeId, { tmuxSession: PARENT, tmuxPane: "%5" });
        sessionRegistry.updateResumeToken(parent.id, "claude_id", parentToken, "hook");
        parentSessionId = parent.id;
      });
      const parentState = () => ({
        session: db.prepare("SELECT status, resume_token, resume_type, resume_provenance, resume_last_verified, resume_last_probe_status FROM sessions WHERE id = ?").get(parentSessionId),
        node: db.prepare("SELECT tmux_session, tmux_pane FROM bindings WHERE node_id = ?").get(parentNodeId),
        tenure: sessionRegistry.currentOccupantTenure(parentNodeId),
      });
      /** A fork handover that fails after its successor is ready (a live owner's claim on the pane, as in #2861 item
       *  2), whose owner then goes, so the attempt is left to recover. The pane's Claude then carries a fork's argv, as the
       *  adapter launches it: `--resume <forkedFrom> --fork-session` (default: the parent's conversation at launch; null:
       *  a wrapper that left no parent in the argv; `equals`: the `--resume=<id>` form). */
      async function failedFork(source = `fork:${PARENT}`, forkedFrom?: string | null, equals = false): Promise<void> {
        const parentAtLaunch = forkedFrom !== undefined ? forkedFrom
          : (db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(source === `fork:${PARENT}` ? parentSessionId : sessionId) as
            { resume_token: string | null }).resume_token;
        nativeAt = 0;
        const otherRig = rigRepo.createRig("other-rig");
        const owner = rigRepo.addNode(otherRig.id, "dev.owner", { runtime: "claude-code", cwd: "/other" });
        const ownerSession = sessionRegistry.registerSession(owner.id, "dev-owner@other-rig");
        sessionRegistry.updateStatus(ownerSession.id, "running");
        const row = discoveryRepo.upsertDiscoveredSession({ tmuxSession: SEAT, tmuxPane: "%9", runtimeHint: "claude-code", confidence: "high" });
        discoveryRepo.markClaimed(row.id, owner.id);
        const result = await service().handover({ seatRef: SEAT, source, reason: "context-wall" });
        expect(result).toMatchObject({ ok: false, code: "discovered_not_active" });
        expect(openHandoverAttempt(db, nodeId)).toMatchObject({ failedStep: "finalize", sourceOutcome: { mode: "fork", forkId: "captured" } });
        sessionRegistry.updateStatus(ownerSession.id, "exited");
        rigRepo.archiveRig(otherRig.id);
        if (parentAtLaunch) {
          const resume = equals ? `--resume=${parentAtLaunch}` : `--resume ${parentAtLaunch}`;
          paneProcesses = () => [
            { pid: 100, ppid: 1, pgid: 100, tpgid: 102, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
            { ...claudeIn(successorToken), command: `claude ${resume} --fork-session --session-id ${successorToken} --name ${SEAT}` },
          ];
        }
      }

      it("records the parent's conversation the successor holds, reports it is not a distinct fork, and leaves the parent as it was", async () => {
        await failedFork();
        pidFile({ name: SEAT, sessionId: parentToken });
        const parentBefore = parentState();
        const before = inputs();
        const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
        expect(result).toMatchObject({ ok: true });
        if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
        expect(resumeTarget()).toBe(parentToken);
        // Not a distinct fork: the outcome says the successor is on its parent's conversation, on the result and in the
        // durable handover record.
        expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: PARENT, forkId: "none",
          limit: expect.stringContaining(`its fork parent ${PARENT}`) });
        expect((result.result.sourceOutcome as { limit: string }).limit).toContain("restoring both opens it twice");
        expect(result.result.warnings).toBeUndefined();   // said once, in the outcome
        const events = db.prepare("SELECT payload FROM events WHERE type = 'seat.handover_completed'").all() as Array<{ payload: string }>;
        expect(JSON.parse(events.at(-1)!.payload)).toMatchObject({ sourceOutcome: { mode: "fork", forkId: "none" } });
        expect(db.prepare("SELECT continuity_outcome FROM nodes WHERE id = ?").get(nodeId)).toEqual({ continuity_outcome: "resumed" });
        // The parent's binding, session and occupant are unchanged, and nothing was killed or respawned in either pane.
        expect(parentState()).toEqual(parentBefore);
        expect(inputs()).toEqual(before);
      });

      it("records a distinct fork conversation as a captured fork, as before", async () => {
        await failedFork();
        pidFile({ name: SEAT, sessionId: otherToken });
        const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
        if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
        expect(resumeTarget()).toBe(otherToken);
        expect(result.result.sourceOutcome).toEqual({ mode: "fork", forkedFrom: PARENT, forkId: "captured" });
        expect(result.result.warnings).toBeUndefined();
        expect(db.prepare("SELECT continuity_outcome FROM nodes WHERE id = ?").get(nodeId)).toEqual({ continuity_outcome: "forked" });
      });

      it("records the conversation of a fork whose parent can't be resolved again, saying it was not compared", async () => {
        await failedFork();
        db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(parentNodeId);   // the parent no longer resolves
        pidFile({ name: SEAT, sessionId: otherToken });
        const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
        if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
        expect(resumeTarget()).toBe(otherToken);
        expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkId: "captured", limit: expect.stringContaining("could not be resolved again") });
        expect(result.result.warnings).toBeUndefined();   // said once, in the outcome
      });

      // A fork of the seat itself: its parent is the retiring occupant. The seat's live context row may already name the
      // successor's own conversation, so the parent is the retiree's recorded one, never that row (lenses on #3044).
      it("a fork of the seat itself on a distinct conversation stays a captured fork, even when the seat's context row names it", async () => {
        await failedFork(`fork:${SEAT}`);
        db.prepare("INSERT INTO context_usage (node_id, session_id, session_name) VALUES (?, ?, ?)").run(nodeId, otherToken, SEAT);
        pidFile({ name: SEAT, sessionId: otherToken });
        const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
        if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
        expect(resumeTarget()).toBe(otherToken);
        expect(result.result.sourceOutcome).toEqual({ mode: "fork", forkedFrom: SEAT, forkId: "captured" });
        expect(result.result.warnings).toBeUndefined();
      });

      it("a fork of the seat itself on the retiring occupant's conversation reports no distinct fork", async () => {
        await failedFork(`fork:${SEAT}`);
        pidFile({ name: SEAT, sessionId: previousToken });
        const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
        if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
        expect(resumeTarget()).toBe(previousToken);
        expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: SEAT, forkId: "none",
          limit: expect.stringContaining(`the retiring occupant's conversation, the one its fork of ${SEAT} started from`) });
        expect(result.result.warnings).toBeUndefined();
        expect(db.prepare("SELECT continuity_outcome FROM nodes WHERE id = ?").get(nodeId)).toEqual({ continuity_outcome: "resumed" });
      });

      // B1 of the delta review (CodeRabbit on the head): the retiring occupant and the live parent are on one conversation.
      it("a fork of another seat whose live parent is on the retiring occupant's conversation reports the parent, both seats on it", async () => {
        sessionRegistry.updateResumeToken(parentSessionId, "claude_id", previousToken, "hook");
        await failedFork();
        pidFile({ name: SEAT, sessionId: previousToken });
        const parentBefore = parentState();
        const before = inputs();
        const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
        if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
        expect(resumeTarget()).toBe(previousToken);
        expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: PARENT, forkId: "none" });
        const limit = (result.result.sourceOutcome as { limit: string }).limit;
        expect(limit).toContain(`its fork parent ${PARENT}, which is also the retiring occupant's`);
        expect(limit).toContain("both seats now name the same conversation");
        expect(limit).not.toContain("not its fork parent");
        expect(parentState()).toEqual(parentBefore);
        expect(inputs()).toEqual(before);
      });

      // B2 of the delta review: a fork of the seat itself whose retiring occupant has no recorded conversation (the launch
      // forked from the seat's context row). The parent is the one the launch forked from, as the process's argv names it.
      describe("a fork of the seat itself whose retiring occupant has no recorded conversation", () => {
        const P = "55555555-5555-4555-8555-555555555555";
        async function failedSelfFork(argvParent: boolean): Promise<void> {
          db.prepare("INSERT INTO context_usage (node_id, session_id, session_name) VALUES (?, ?, ?)").run(nodeId, P, SEAT);
          db.prepare("UPDATE sessions SET resume_token = NULL WHERE id = ?").run(sessionId);
          await failedFork(`fork:${SEAT}`, argvParent ? P : null);
        }
        it("reports no distinct fork when the successor is on the conversation its launch forked from", async () => {
          await failedSelfFork(true);
          pidFile({ name: SEAT, sessionId: P });
          const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
          if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
          expect(resumeTarget()).toBe(P);
          expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: SEAT, forkId: "none" });
          expect(db.prepare("SELECT continuity_outcome FROM nodes WHERE id = ?").get(nodeId)).toEqual({ continuity_outcome: "resumed" });
        });
        it("says the distinctness was not checked when neither the argv nor the retiree names the parent", async () => {
          await failedSelfFork(false);
          pidFile({ name: SEAT, sessionId: P });
          const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
          if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
          expect(resumeTarget()).toBe(P);
          expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkId: "captured", limit: expect.stringContaining("was not checked") });
        });
      });

      // B2 of the 2nd delta review: the launch forked from the seat's context row (P) while the retiring occupant's
      // recorded conversation is another one (R). The parent is read from the process's argv with the identity proof's own
      // parser (the --resume=P form included); with no parent in the argv, it is "not checked", never the retiree's R.
      describe("a fork of the seat itself whose launch forked from a conversation other than the retiree's record", () => {
        const P = "66666666-6666-4666-8666-666666666666";
        beforeEach(() => {
          db.prepare("INSERT INTO context_usage (node_id, session_id, session_name) VALUES (?, ?, ?)").run(nodeId, P, SEAT);
        });
        it("the successor on P, the argv naming it as --resume=P: no distinct fork", async () => {
          await failedFork(`fork:${SEAT}`, P, true);
          pidFile({ name: SEAT, sessionId: P });
          const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
          if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
          expect(resumeTarget()).toBe(P);
          expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: SEAT, forkId: "none" });
        });
        it("the successor on P, no parent in the argv: not checked, not compared with the retiree's R", async () => {
          await failedFork(`fork:${SEAT}`, null);
          pidFile({ name: SEAT, sessionId: P });
          const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
          if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
          expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkId: "captured", limit: expect.stringContaining("could not be read from its process") });
          expect(db.prepare("SELECT continuity_outcome FROM nodes WHERE id = ?").get(nodeId)).toEqual({ continuity_outcome: "forked" });
        });
        // The retiree's recorded R is the parent's too: a successor on it is no distinct fork, whatever the argv names.
        it.each([
          ["the argv naming P", P],
          ["no parent in the argv", null],
        ])("the successor on the retiree's recorded R, %s: no distinct fork", async (_name, argvParent) => {
          await failedFork(`fork:${SEAT}`, argvParent);
          pidFile({ name: SEAT, sessionId: previousToken });
          const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
          if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
          expect(resumeTarget()).toBe(previousToken);
          expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: SEAT, forkId: "none",
            limit: expect.stringContaining("the retiring occupant's conversation, the one recorded for it") });
          expect(db.prepare("SELECT continuity_outcome FROM nodes WHERE id = ?").get(nodeId)).toEqual({ continuity_outcome: "resumed" });
        });
      });

      // SH5: the parent moved to another conversation after the launch (a /clear): the successor still on the one the
      // launch forked from is no distinct fork either.
      it("a fork of another seat on the conversation the parent had at launch, the parent moved on since: no distinct fork", async () => {
        await failedFork();
        sessionRegistry.updateResumeToken(parentSessionId, "claude_id", "77777777-7777-4777-8777-777777777777", "hook");
        pidFile({ name: SEAT, sessionId: parentToken });
        const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
        if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
        expect(resumeTarget()).toBe(parentToken);
        expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: PARENT, forkId: "none",
          limit: expect.stringContaining(`was on when the fork was launched (${PARENT} has moved on since)`) });
      });

      it("the same with a parent that can't be resolved again: no distinct fork, and whether the parent moved was not checked", async () => {
        await failedFork();
        db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(parentNodeId);   // the parent no longer resolves
        pidFile({ name: SEAT, sessionId: parentToken });
        const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
        if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
        expect(resumeTarget()).toBe(parentToken);
        expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: PARENT, forkId: "none" });
        const limit = (result.result.sourceOutcome as { limit: string }).limit;
        expect(limit).toContain(`could not be resolved again, so whether it is still on it was not checked`);
        expect(limit).not.toContain("has moved on since");
        expect(db.prepare("SELECT continuity_outcome FROM nodes WHERE id = ?").get(nodeId)).toEqual({ continuity_outcome: "resumed" });
      });

      // SH6: the retiring occupant's conversation in a fork of another seat whose parent is elsewhere (X2), or can't be
      // resolved again (X3).
      it("a fork of another seat on the retiring occupant's conversation, the parent on its own: no distinct fork, not the parent's", async () => {
        await failedFork();
        pidFile({ name: SEAT, sessionId: previousToken });
        const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
        if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
        expect(resumeTarget()).toBe(previousToken);
        expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkId: "none",
          limit: expect.stringContaining(`the retiring occupant's conversation, not its fork parent ${PARENT}'s`) });
      });

      it("the same with a parent that can't be resolved again says the parent was not checked", async () => {
        await failedFork();
        db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(parentNodeId);
        pidFile({ name: SEAT, sessionId: previousToken });
        const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
        if (!result.ok || !("result" in result)) throw new Error(`expected a committed recovery: ${JSON.stringify(result)}`);
        expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkId: "none",
          limit: expect.stringContaining(`could not be resolved again, so whether ${PARENT} is on it too was not checked`) });
      });
    });

    it.each([
      ["a file older than the process (a reused pid)", () => pidFile({ name: SEAT, sessionId: T2 }, new Date(Date.parse(startedAt) - 86_400_000))],
      ["a file of another session", () => pidFile({ name: "someone@else", sessionId: T2 })],
      ["no file", () => {}],
    ])("keeps the launch's conversation with %s", async (_name, write) => {
      await failedHandover();
      write();
      expect(await service().recover({ seatRef: SEAT, reason: "adopt" })).toMatchObject({ ok: true });
      expect(resumeTarget()).toBe(successorToken);
    });
  });

  // Should S1: a successor launched through a `#!` wrapper that starts Claude without exec (#2341) is proven the way
  // readiness proves it: the attempt keeps the launch's frozen executable and whether it is a script.
  it("adopts a successor launched through a #! wrapper without exec, proven like readiness proves it", async () => {
    managedLaunch = { executable: WRAPPER, executableIsScript: true };
    new NativePermissionStore(db).write(nodeId, { runtime: "claude-code", mode: "auto" }, "fixture", "wrapper launch");
    const launched = `--permission-mode auto --session-id ${successorToken} --name ${SEAT}`;
    paneProcesses = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: running() ? 101 : 100, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
      ...(running() ? [
        { pid: 101, ppid: 100, pgid: 101, tpgid: 101, command: `/bin/sh ${WRAPPER} ${launched}`, executableName: "claude", startedAt },
        { pid: 102, ppid: 101, pgid: 101, tpgid: 101, command: `/opt/claude-runtime/2.1.316 ${launched}`, executableName: "2.1.316", startedAt },
      ] as NativeProcessRow[] : []),
    ];
    const generation = await failedHandover();
    expect(openHandoverAttempt(db, nodeId)).toMatchObject({ executable: WRAPPER, executableIsScript: true });
    const result = await service().recover({ seatRef: SEAT, reason: "adopt the wrapper's successor" });
    expect(result).toMatchObject({ ok: true });
    expect(sessionRegistry.currentOccupantTenure(nodeId)).toMatchObject({ generationUuid: generation, kind: "handover" });
  });

  // SR1 of the review of the #3044 delta: a CLASSIC launch (no permission mode, the floor posture) records no
  // executable, so a Claude that a #! wrapper starts without exec, or a renamed binary, is never proven. The refusal
  // says so, instead of "run the recovery again in a moment", which never changes the result.
  it.each([
    ["a #! wrapper named claude that runs node cli.js", (launched: string) => [
      { pid: 101, ppid: 100, pgid: 101, tpgid: 101, command: `/bin/sh /home/user/.local/bin/claude ${launched}`, executableName: "claude", startedAt },
      { pid: 102, ppid: 101, pgid: 101, tpgid: 101, command: `node /home/user/.npm/lib/node_modules/@anthropic-ai/claude-code/cli.js ${launched}`, executableName: "node", startedAt },
    ]],
    ["a wrapper that runs a renamed binary", (launched: string) => [
      { pid: 101, ppid: 100, pgid: 101, tpgid: 101, command: `bash /home/user/bin/claude ${launched}`, executableName: "claude", startedAt },
      { pid: 102, ppid: 101, pgid: 101, tpgid: 101, command: `/opt/claude-real ${launched}`, executableName: "claude-real", startedAt },
    ]],
  ] as Array<[string, (launched: string) => NativeProcessRow[]]>)("a classic launch through %s is refused as not provable, without 'run it again'", async (_name, fg) => {
    const launched = `--session-id ${successorToken} --name ${SEAT}`;
    paneProcesses = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: running() ? 101 : 100, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
      ...(running() ? fg(launched) : []),
    ];
    await failedHandover();
    expect(openHandoverAttempt(db, nodeId)).toMatchObject({ executable: null, executableIsScript: false });
    const before = state();
    const from = elapsed;
    const result = await service().recover({ seatRef: SEAT, reason: "adopt the classic wrapper's successor" });
    // SD1: said only after a second sample, a few seconds later, finds the same foreground.
    expect(elapsed - from).toBeGreaterThanOrEqual(3_000);
    expect(result).toMatchObject({ ok: false, code: "successor_identity_unproven" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("recorded no executable");
    expect(result.guidance).toContain("--recover can't prove it");
    expect(result.guidance).not.toMatch(/run the recovery again/i);
    expect(result.guidance).toContain(`--fresh --stop --reason "<why>"`);
    expect(state()).toEqual(before);
  });

  // SD1 of the review of the #3044 delta: a classic launch caught in a #! wrapper's start window (only the wrapper with
  // the token, before its exec or its Claude child) is not refused as never provable: a second sample, a few seconds
  // later, sees the Claude and proves it. On 282ea4c08 this was the "running it again will not change that" refusal.
  const WRAPPER_ONLY = (launched: string) => [
    { pid: 101, ppid: 100, pgid: 101, tpgid: 101, command: `/bin/sh /home/user/.local/bin/claude ${launched}`, executableName: "claude", startedAt },
  ] as NativeProcessRow[];
  it.each([
    ["execs Claude", (launched: string) => [
      { pid: 101, ppid: 100, pgid: 101, tpgid: 101, command: `/opt/claude/bin/claude ${launched}`, executableName: "claude", startedAt },
    ]],
    ["starts a Claude child", (launched: string) => [
      ...WRAPPER_ONLY(launched),
      { pid: 102, ppid: 101, pgid: 101, tpgid: 101, command: `/opt/claude/bin/claude ${launched}`, executableName: "claude", startedAt },
    ]],
  ] as Array<[string, (launched: string) => NativeProcessRow[]]>)("a classic launch caught in its #! wrapper's start window is proven when the wrapper %s", async (_name, later) => {
    const launched = `--session-id ${successorToken} --name ${SEAT}`;
    let from = Number.POSITIVE_INFINITY;
    const fg = () => elapsed - from >= 3_000 ? later(launched) : WRAPPER_ONLY(launched);
    paneProcesses = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: running() ? 101 : 100, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
      ...(running() ? fg() : []),
    ];
    const generation = await failedHandover();
    expect(openHandoverAttempt(db, nodeId)).toMatchObject({ executable: null, executableIsScript: false });
    from = elapsed;
    const result = await service().recover({ seatRef: SEAT, reason: "adopt the slow wrapper's successor" });
    expect(result).toMatchObject({ ok: true });
    expect(elapsed - from).toBeGreaterThanOrEqual(3_000);
    expect(sessionRegistry.currentOccupantTenure(nodeId)).toMatchObject({ generationUuid: generation, kind: "handover" });
  });

  // CodeRabbit on #3044: a classic #! wrapper still waiting (here a `sleep`) when --recover runs, after the handover's
  // readiness window, shows the same foreground in both samples. The refusal keeps "can't prove it", but its guidance
  // says to run --recover again once the pane shows Claude has started, and that retry proves the successor.
  it("a classic wrapper still waiting across both samples is refused with a retry once Claude starts, which then proves it", async () => {
    const launched = `--session-id ${successorToken} --name ${SEAT}`;
    let from = Number.POSITIVE_INFINITY;
    const fg = () => elapsed - from >= 6_000 ? [
      { pid: 101, ppid: 100, pgid: 101, tpgid: 101, command: `/opt/claude/bin/claude ${launched}`, executableName: "claude", startedAt },
    ] as NativeProcessRow[] : [
      ...WRAPPER_ONLY(launched),
      { pid: 103, ppid: 101, pgid: 101, tpgid: 101, command: "sleep 600", executableName: "sleep", startedAt },
    ] as NativeProcessRow[];
    paneProcesses = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: running() ? 101 : 100, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
      ...(running() ? fg() : []),
    ];
    const generation = await failedHandover();
    from = elapsed;
    const before = state();
    const first = await service().recover({ seatRef: SEAT, reason: "adopt the waiting wrapper's successor" });
    expect(first).toMatchObject({ ok: false, code: "successor_identity_unproven" });
    if (first.ok) throw new Error("expected a refusal");
    expect(first.guidance).toContain("--recover can't prove it");
    expect(first.guidance).toContain("run --recover again once it has");
    expect(first.guidance).not.toMatch(/can't prove it, and running it again will not change that/);
    expect(state()).toEqual(before);
    elapsed += 4_000; // the wrapper ends its wait and execs Claude
    vi.setSystemTime(startedAtMs + elapsed);
    const second = await service().recover({ seatRef: SEAT, reason: "adopt the waiting wrapper's successor" });
    expect(second).toMatchObject({ ok: true });
    expect(sessionRegistry.currentOccupantTenure(nodeId)).toMatchObject({ generationUuid: generation, kind: "handover" });
  });

  // A foreground that changed between the two samples and still holds no Claude the proof knows (the wrapper started a
  // node child) is a launch still starting: the refusal says to run the recovery again, not "can't prove it".
  it("a classic launch whose foreground changes between the two samples says to run the recovery again", async () => {
    const launched = `--session-id ${successorToken} --name ${SEAT}`;
    let from = Number.POSITIVE_INFINITY;
    const fg = () => elapsed - from >= 3_000 ? [
      ...WRAPPER_ONLY(launched),
      { pid: 102, ppid: 101, pgid: 101, tpgid: 101, command: `node /home/user/.npm/lib/node_modules/@anthropic-ai/claude-code/cli.js ${launched}`, executableName: "node", startedAt },
    ] as NativeProcessRow[] : WRAPPER_ONLY(launched);
    paneProcesses = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: running() ? 101 : 100, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
      ...(running() ? fg() : []),
    ];
    await failedHandover();
    from = elapsed;
    const before = state();
    const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
    expect(result).toMatchObject({ ok: false, code: "successor_identity_unproven" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("changed between two samples");
    expect(result.guidance).toMatch(/run the recovery again in a moment/);
    expect(result.guidance).not.toContain("--recover can't prove it");
    expect(state()).toEqual(before);
  });

  // A native Claude whose executable witness this sample missed (the macOS path read timed out) is not the never-provable
  // shape: a later sample may read the path and prove it, so the refusal still says to run the recovery again.
  it("a classic launch whose native Claude has no executable witness in this sample still says to run the recovery again", async () => {
    const launched = `--session-id ${successorToken} --name ${SEAT}`;
    paneProcesses = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: running() ? 101 : 100, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
      ...(running() ? [
        { pid: 101, ppid: 100, pgid: 101, tpgid: 101, command: `claude ${launched}`, executableName: "2.1.316", startedAt },
      ] as NativeProcessRow[] : []),
    ];
    await failedHandover();
    expect(openHandoverAttempt(db, nodeId)).toMatchObject({ executable: null });
    const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
    expect(result).toMatchObject({ ok: false, code: "successor_identity_unproven" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.guidance).toMatch(/run the recovery again in a moment/);
    expect(result.guidance).not.toContain("--recover can't prove it");
  });

  // The not-provable refusal is for a classic launch only: a managed launch records its executable, so a foreground that
  // is not yet the Claude it proves (a wrapper's node child) may still become it.
  it("a managed launch whose foreground holds no provable Claude still says to run the recovery again", async () => {
    managedLaunch = { executable: WRAPPER, executableIsScript: true };
    new NativePermissionStore(db).write(nodeId, { runtime: "claude-code", mode: "auto" }, "fixture", "wrapper launch");
    const launched = `--permission-mode auto --session-id ${successorToken} --name ${SEAT}`;
    paneProcesses = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: running() ? 101 : 100, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
      ...(running() ? [
        { pid: 101, ppid: 100, pgid: 101, tpgid: 101, command: `/bin/sh ${WRAPPER} ${launched}`, executableName: "sh", startedAt },
        { pid: 102, ppid: 101, pgid: 101, tpgid: 101, command: `node /home/user/.npm/lib/node_modules/@anthropic-ai/claude-code/cli.js ${launched}`, executableName: "node", startedAt },
      ] as NativeProcessRow[] : []),
    ];
    await failedHandover();
    expect(openHandoverAttempt(db, nodeId)).toMatchObject({ executable: WRAPPER, executableIsScript: true });
    const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
    expect(result).toMatchObject({ ok: false, code: "successor_identity_unproven" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.guidance).toMatch(/run the recovery again in a moment/);
    expect(result.guidance).not.toContain("--recover can't prove it");
  });

  it("a classic launch whose pane runs nothing yet still says to run the recovery again in a moment", async () => {
    paneProcesses = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 100, command: "-zsh", executableName: "zsh", startedAt } as NativeProcessRow,
    ];
    await failedHandover();
    const result = await service().recover({ seatRef: SEAT, reason: "adopt" });
    expect(result).toMatchObject({ ok: false, code: "successor_identity_unproven" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.guidance).toMatch(/run the recovery again in a moment/);
  });
});
