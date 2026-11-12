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
  const calls = { respawnPane: vi.fn(), sendText: vi.fn(), sendKeys: vi.fn(), killSession: vi.fn() };
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
      signalPaneProcess: vi.fn(async () => ({ ok: true })),
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

  function service(): SeatHandoverService {
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
    keys: calls.sendKeys.mock.calls.length, kill: calls.killSession.mock.calls.length });

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

    it("keeps the launch's conversation when the file names the retiring occupant's", async () => {
      await failedHandover();
      pidFile({ name: SEAT, sessionId: previousToken });
      expect(await service().recover({ seatRef: SEAT, reason: "adopt" })).toMatchObject({ ok: true });
      expect(resumeTarget()).toBe(successorToken);
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
    const result = await service().recover({ seatRef: SEAT, reason: "adopt the classic wrapper's successor" });
    expect(result).toMatchObject({ ok: false, code: "successor_identity_unproven" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("recorded no executable");
    expect(result.guidance).toContain("--recover can't prove it");
    expect(result.guidance).not.toMatch(/run the recovery again/i);
    expect(state()).toEqual(before);
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
