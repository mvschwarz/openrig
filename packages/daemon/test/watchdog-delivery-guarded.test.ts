// Real scheduler/transport with inert terminal effects: a receipt cannot suppress a current reminder.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { queueRecoveryOwnsWake } from "../src/domain/queue-wake-ladder.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor, PARKED_OWNER_POLICY_NAME } from "../src/domain/policies/parked-owner-consumer.js";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { OutboxHandler, OutboxHandlerError } from "../src/domain/outbox-handler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, defaultParkWakeMessage } from "../src/domain/queue-repository.js";
import { isDefaultParkWakeMessage, queuedAsRowNote, withContinuationPreview } from "../src/domain/park-wake-text.js";
import { updateWatchdogJob } from "../src/domain/watchdog-job-update.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "../src/domain/watchdog-scheduler.js";
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";
import { makeWorkflowKeepalivePolicy } from "../src/domain/policies/workflow-keepalive.js";
import { makeIdleGateQitemPolicy } from "../src/domain/policies/idle-gate-qitem.js";
import { runStuckSweep, createStuckSweepStatus } from "../src/domain/queue-stuck-sweep.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function frame(body: string): ComposerSnapshot {
  const rows = body.split("\n").flatMap(line => {
    const chunks: string[] = []; let row = "";
    for (const char of line) {
      if (stringWidth(row + char) > 238) { chunks.push(row); row = ""; }
      row += char;
    }
    return [...chunks, row];
  });
  return { screen: ["Ready", "────────────────────", `❯ ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(rows.at(-1)!), y: 1 + rows.length, width: 240, height: 60 }, inMode: false };
}

/** One draft-aware seat on a fake tmux whose only effect is recording what was pasted and submitted. */
function fixture(saved?: Buffer) {
  const db = new Database(saved ?? ":memory:");
  if (!saved) {
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','claude-code');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
  }
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  let body: string | null = "";
  let history = "";
  let staged = "";
  const submissions: string[] = [];
  const pastes: string[] = [];
  const hooks: { paste?: () => Promise<void>; stage?: () => Promise<void>; pendingStage?: (session: string) => boolean } = {};
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("paste-buffer")) { await hooks.paste?.(); body = staged; pastes.push(staged); }
    if (command.includes("send-keys") && command.includes("Enter")) { submissions.push(body ?? ""); history += `${body}\n`; body = ""; }
    return "";
  }, { writeFile: async (_path, text) => { await hooks.stage?.(); staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/draft-input", bufferName: () => "draft-input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => [{ id: guard.target(name).pane! } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async () => body == null ? null : frame(body));
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async () => body == null ? null : history + frame(body).screen);
  const at = Date.now();
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    now: () => new Date(at), sleep: async () => {},
    agentActivityStore: { getLatestForNode: () => ({ state: "idle", reason: "fixture idle hook", evidenceSource: "runtime_hook", sampledAt: new Date(at).toISOString(), evidence: null }) } as never });
  transport.guardedDelivery!.recover();
  const outbox = new OutboxHandler(db);
  const deliveryDeps = { sessionTransport: transport, hasPendingPostCompactStage: (session: string) => hooks.pendingStage?.(session) ?? false };
  const deliver = makeWatchdogDeliver(deliveryDeps);
  cleanup.push(async () => { await transport.guardedDelivery!.stop(); db.close(); });
  return { db, outbox, deliver, transport, submissions, pastes, hooks, hold: () => guard.set("a", { mode: "hold" }, "human@test", "hold input"),
    setQueueOnly: () => guard.set("a", { mode: "queue-only" }, "human@test", "a person types here"), setInput: (text: string) => { body = text; }, enable: () => guard.set("a", { mode: "draft-aware" }, "human@test", "keep draft") };
}

const seat = "worker@test";

/** The queue, watchdog engine and scheduler on a fixture's store, wired as the daemon wires them. `withoutPreview`
 *  leaves out the park-entry lookup, so wakes go with their stored message, as a daemon before the preview sent them. */
function scheduled(f: ReturnType<typeof fixture>, { withoutPreview = false, queueWait = false } = {}) {
  const bus = new EventBus(f.db);
  const repo = new QueueRepository(f.db, bus, { transport: f.transport as never, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(f.outbox);
  const jobs = new WatchdogJobsRepository(f.db);
  repo.attachWatchdogJobsRepository(jobs);
  const history = new WatchdogHistoryLog(f.db);
  const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: bus, deliver: f.deliver,
    resolvePreDeliveryTerminalReason: ({ jobId }) => repo.resolveWatchdogPreDeliveryTerminalReason(jobId),
    // What a queue-only seat's park record needs (#3076): the row the reminder became, and the seat it was for.
    onWakeAttempt: ({ jobId, deliveryStatus, queuedQitemId, targetSession }: { jobId: string; deliveryStatus: string; queuedQitemId?: string; targetSession?: string }) =>
      repo.recordWatchdogWakeAttempt(jobId, deliveryStatus, undefined, { queuedQitemId, targetSession }),
    ...(withoutPreview ? {} : { resolveDigestEntry: ({ jobId, message }: { jobId: string; message: string }) => repo.parkReminderDigestEntry(jobId, message) }),
    ...(queueWait ? { resolveQueueWait: (input: { jobId: string }) => repo.evaluateWaitReminder(input) } : {}),
  } as never);
  const scheduler = new WatchdogScheduler({ jobsRepo: jobs, policyEngine: engine });
  const park = async (summary: string, transitionNote = "parked") => {
    const row = await repo.create({ sourceSession: "orch@test", destinationSession: seat, body: summary, summary, nudge: false } as never) as unknown as { qitemId: string };
    repo.update({ qitemId: row.qitemId, actorSession: seat, state: "blocked", blockedOn: "external:wait", transitionNote, wakeAfterSeconds: 600 } as never);
    return { qitemId: row.qitemId, jobId: repo.getParkWakeStatus(row.qitemId)!.ref };
  };
  const due = (jobId: string) => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    f.db.prepare("UPDATE watchdog_jobs SET last_evaluation_at = ?, registered_at = ? WHERE job_id = ?").run(past, past, jobId);
  };
  return { repo, jobs, history, scheduler, park, due };
}
const lone = (jobId: string, occurrenceId: string) => ({ jobId, policy: "periodic-reminder", occurrenceId });
const digest = (...members: Array<[string, string]>) => ({
  jobId: `digest-${members.map(([, o]) => o).join("+")}`, policy: "periodic-reminder", occurrenceId: `digest-${members.map(([, o]) => o).join("+")}`,
  members: members.map(([jobId, occurrenceId]) => ({ jobId, occurrenceId })),
});

describe("watchdog reminders reach the recipient despite earlier delivery records", () => {
  it("retries an unaccounted condition and still delivers a changed condition", async () => {
    const f = fixture();
    await f.enable();
    const s = scheduled(f);
    await s.repo.create({ sourceSession: seat, destinationSession: seat, body: "review", tags: ["gate:review"], nudge: false });
    const policy = (db: Database.Database) => makeIdleGateQitemPolicy({ db, seatActivity: {
      getSeatStateBySession: () => ({ activity: "idle-at-prompt", needsInput: { count: 0 } }),
    } as never });
    const history = new WatchdogHistoryLog(f.db);
    const engine = new WatchdogPolicyEngine({ jobsRepo: s.jobs, historyLog: history, eventBus: new EventBus(f.db),
      deliver: f.deliver, additionalPolicies: [policy(f.db)] });
    const job = s.jobs.register({ policy: "idle-gate-qitem", targetSession: seat, intervalSeconds: 60, registeredBySession: seat,
      specYaml: "message: Gate ready\n" });
    vi.spyOn(s.jobs, "recordConditionReceipt").mockImplementationOnce(() => { throw new Error("receipt interrupted"); });
    await expect(engine.evaluate(job)).rejects.toThrow("receipt interrupted");
    expect(f.submissions).toHaveLength(1);

    const g = fixture(f.db.serialize());
    const jobs = new WatchdogJobsRepository(g.db);
    const reopened = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: new WatchdogHistoryLog(g.db),
      eventBus: new EventBus(g.db), deliver: g.deliver, additionalPolicies: [policy(g.db)] });
    expect((await reopened.evaluate(jobs.getByIdOrThrow(job.jobId))).delivery).toMatchObject({ status: "ok" });
    expect(g.submissions).toHaveLength(1);
    expect(g.submissions[0]).toContain("Gate ready");
    expect(g.submissions[0]).toMatch(/may (?:be repeated|repeat)/i);
    expect((await reopened.evaluate(jobs.getByIdOrThrow(job.jobId))).outcome).toMatchObject({ action: "skip", reason: "gate_condition_unchanged" });
    await scheduled(g).repo.create({ sourceSession: seat, destinationSession: seat, body: "another review", tags: ["gate:review"], nudge: false });
    await reopened.evaluate(jobs.getByIdOrThrow(job.jobId));
    expect(g.submissions).toHaveLength(2);
  });

  it.each(["sending", "indeterminate", "delivered", "failed"] as const)("delivers the current reminder despite an old %s digest record", async (state) => {
    const f = fixture();
    await f.enable();
    const id = "guard-watchdog-occ-a";
    f.outbox.record({ outboxId: id, senderSession: "watchdog@system", destinationSession: seat,
      body: "old body", tags: ["watchdog:digest"] });
    f.db.prepare("UPDATE outbox_entries SET delivery_state = ? WHERE outbox_id = ?").run(state, id);
    const result = await f.deliver({ targetSession: seat, message: "Current A and B" }, digest(["job-a", "occ-a"], ["job-b", "occ-b"]));
    expect(result).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).toContain("Current A and B");
    expect(f.submissions[0]).toMatch(/may (?:be repeated|repeat)/i);
    expect(f.submissions[0]).not.toContain("old body");
  });

  it("delivers without requiring the watchdog's outbox bookkeeping", async () => {
    const f = fixture();
    await f.enable();
    vi.spyOn(f.outbox, "record").mockImplementation(() => { throw new Error("watchdog bookkeeping unavailable"); });
    expect(await f.deliver({ targetSession: seat, message: "Both waits are due" }, digest(["a", "a1"], ["b", "b1"]))).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).toContain("Both waits are due");
  });

  it.each([false, true])("keeps recurring after accounting interruption: %s", async (interrupted) => {
    const f = fixture();
    await f.enable();
    const instance = new WorkflowInstanceStore(f.db).create({ workflowName: "ongoing", workflowVersion: "1", createdBySession: seat });
    let at = Date.now();
    const jobs = new WatchdogJobsRepository(f.db, () => new Date(at));
    const history = new WatchdogHistoryLog(f.db);
    const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: new EventBus(f.db),
      deliver: f.deliver, now: () => new Date(at), additionalPolicies: [makeWorkflowKeepalivePolicy({ db: f.db })] });
    const job = jobs.register({ policy: "workflow-keepalive", targetSession: seat, intervalSeconds: 60, registeredBySession: seat,
      specYaml: `message: Continue the current step\ncontext:\n  workflow_instance_id: ${instance.instanceId}\n` });
    if (interrupted) {
      vi.spyOn(history, "record").mockImplementationOnce(() => { throw new Error("accounting interrupted"); });
      await expect(engine.evaluate(jobs.getByIdOrThrow(job.jobId))).rejects.toThrow("accounting interrupted");
    }
    expect((await engine.evaluate(jobs.getByIdOrThrow(job.jobId))).delivery).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(interrupted ? 2 : 1);
    at += 60_000;
    await engine.evaluate(jobs.getByIdOrThrow(job.jobId));
    expect(f.submissions).toHaveLength(interrupted ? 3 : 2);
    expect(f.submissions.at(-1)).toContain("Continue the current step");
  });

  it("reopens an interrupted wake and submits all current reminders with their continuations", async () => {
    const f = fixture();
    await f.enable();
    const first = scheduled(f, { withoutPreview: true });
    const a = await first.park("A's wait", "continuation: hand the head to the planner");
    first.due(a.jobId);
    let reached!: () => void;
    const pasting = new Promise<void>((done) => { reached = done; });
    let unblock!: () => void;
    f.hooks.paste = () => { reached(); return new Promise((done) => { unblock = done; }); };
    const lost = first.scheduler.runTickNow();
    await pasting;
    const g = fixture(f.db.serialize());
    // Settle the first process before assertions, while retaining its interrupted store as the recovery input.
    unblock();
    await lost;
    const next = scheduled(g);
    const b = await next.park("B's wait");
    next.due(b.jobId);
    await next.scheduler.runTickNow();
    expect(g.submissions).toHaveLength(1);
    expect(g.submissions[0]).toContain(a.qitemId);
    expect(g.submissions[0]).toContain(b.qitemId);
    expect(g.submissions[0]).toContain("hand the head to the planner");
    expect(g.submissions[0]).toMatch(/may (?:be repeated|repeat)/i);
    for (const { jobId } of [a, b]) expect(next.history.listForJob(jobId, 1)[0]).toMatchObject({ deliveryStatus: "ok" });
  });

  it("still protects a person's draft instead of submitting the reminder", async () => {
    const f = fixture();
    await f.enable();
    f.setInput("a person's unfinished message");
    expect(await f.deliver({ targetSession: seat, message: "Reminder" }, lone("a", "a1"))).toMatchObject({ status: "retained" });
    expect(f.submissions).toEqual([]);
  });
});


/** Production queue/policy/engine/delivery/transport; only terminal input is inert and recorded. */
async function parkedReminder(f: ReturnType<typeof fixture>, noteFailure?: "false" | "throw") {
  const s = scheduled(f);
  const row = await s.repo.create({ sourceSession: seat, destinationSession: seat, body: "Current owned work", nudge: false });
  s.repo.claim({ qitemId: row.qitemId, destinationSession: seat });
  const policy = makeParkedOwnerConsumerPolicy({
    diagnoseRig: () => ({ seats: [{ sessionName: seat, parked: true,
      activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null } },
      obligations: { items: [{ qitemId: row.qitemId, state: "in-progress", summary: null }], held: [] } }] }),
    history: s.history, occupantGeneration: () => "g1",
    hasPendingPostCompactStage: session => f.hooks.pendingStage?.(session) ?? false,
    rows: {
      listTransitions: id => s.repo.listTransitions(id),
      appendNote: (id, note) => {
        if (noteFailure === "throw") throw new Error("receipt write unavailable");
        if (noteFailure === "false") return { ok: false };
        s.repo.update({ qitemId: id, actorSession: "watchdog@system", transitionNote: note });
        return { ok: true };
      },
      recordNudgeResult: (id, result) => s.repo.recordNudgeAttempt(id, result),
      listOpenIds: session => s.repo.listOpenObligations(session, 500).map(q => q.qitemId),
    },
  });
  const job = s.jobs.register({ policy: PARKED_OWNER_POLICY_NAME, targetSession: makeRigAnchor("test"), intervalSeconds: 120,
    registeredBySession: seat, specYaml: "interval_seconds: 120\n" });
  let at = Date.now();
  const engine = new WatchdogPolicyEngine({ jobsRepo: s.jobs, historyLog: s.history, eventBus: new EventBus(f.db),
    deliver: f.deliver, additionalPolicies: [policy], now: () => new Date(at) });
  const tick = () => { at += 120_000; return engine.evaluate(s.jobs.getByIdOrThrow(job.jobId)); };
  return { ...s, row, job, policy, tick };
}

function compactionFor(f: ReturnType<typeof fixture>) {
  const home = mkdtempSync(join(tmpdir(), "parked-input-stage-"));
  cleanup.push(async () => { rmSync(home, { recursive: true, force: true }); });
  const transport = { send: async (_name: string, _text: string, opts?: { beforeWrite?: () => void }) => {
    opts?.beforeWrite?.(); return { ok: true };
  }, waitUntilIdle: async () => ({ ok: true }) } as unknown as SessionTransport;
  const e = new ClaudeCompactionEnforcer({ resolveClaudeCompactionPolicy: () => ({ enabled: true, thresholdPercent: 80,
    preCompactInstruction: "Write a restore map.", compactInstruction: "", messageInline: "", messageFilePath: "", postRestoreAuditInstruction: "",
  }) } as never, transport, { openrigHome: home, resolveOccupantGeneration: () => "g1" });
  f.hooks.pendingStage = name => e.hasPendingPostCompactStage(name);
  const submit = async () => {
    expect(await e.triggerManualCompact({ sessionName: seat, runtime: "claude-code", usedPercentage: 90 },
      { operatorInitiated: true, skipMap: true })).toMatchObject({ triggered: true });
    expect(e.hasPendingPostCompactStage(seat)).toBe(true);
  };
  return { e, submit };
}

describe("current parked-owner reminders", () => {
  it.each(["reserved", "failed", "unconfirmed"])("parked current input survives an old %s episode record", async state => {
    const f = fixture();
    const s = await parkedReminder(f);
    // A previous process reserved this exact obligation; the current physical request is new.
    const prior = await s.policy.evaluate({ target: { session: makeRigAnchor("test") }, jobId: s.job.jobId } as never);
    expect(prior.action).toBe("send");
    if (state !== "reserved") s.history.record({ jobId: s.job.jobId, evaluatedAt: new Date().toISOString(), outcome: "sent",
      deliveryStatus: state === "delivered" ? "ok" : "failed", deliveryTargetSession: seat,
      evaluationNotes: { ...prior.notes, deliveryReason: state === "unconfirmed" ? "Text write result unconfirmed" : "transport failed" } });
    expect((await s.tick()).delivery).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).toContain(s.row.qitemId);
    expect(f.submissions[0]).toMatch(/may repeat/i);
  });

  it.each(["false", "throw"] as const)("parked current input does not require a pre-delivery note: %s", async failure => {
    const f = fixture();
    const s = await parkedReminder(f, failure);
    expect((await s.tick()).delivery).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).toContain(s.row.qitemId);
  });

  it("parked current input survives unavailable watchdog telemetry", async () => {
    const f = fixture(); const s = await parkedReminder(f);
    vi.spyOn(s.history, "listForJob").mockImplementation(() => { throw new Error("telemetry read unavailable"); });
    expect((await s.tick()).delivery).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(1);
  });

  describe.each([false, true])("late compaction with draft-aware=%s", draftAware => {
  it.each(["cancel", "invalidate"] as const)("parked compaction beginning during buffer setup prevents input, then retries after %s", async end => {
    const f = fixture();
    if (draftAware) await f.enable();
    const compact = compactionFor(f);
    const s = await parkedReminder(f);
    f.hooks.stage = compact.submit; // after policy admission, while the real adapter awaits its buffer
    const first = await s.tick();
    expect(f.pastes).toEqual([]);
    expect(f.submissions).toEqual([]);
    expect(first.delivery?.status).not.toBe("ok");
    expect(s.history.listForJob(s.job.jobId, 1)[0]!.evaluationNotes?.["deliveryReason"]).toContain("[managed-compaction-pending]");
    await s.tick();
    expect(s.repo.getById(s.row.qitemId)?.lastNudgeResult ?? "").not.toMatch(/^failed:/);
    expect(queueRecoveryOwnsWake(f.db, s.repo.getById(s.row.qitemId))).toBe(false);
    expect(s.repo.listTransitions(s.row.qitemId).some(t => t.transitionNote?.startsWith("parked-owner wake delivery failed:"))).toBe(false);
    f.hooks.stage = undefined;
    if (end === "cancel") compact.e.cancelPreparation(seat); else compact.e.invalidateOccupant(seat);
    expect(compact.e.hasPendingPostCompactStage(seat)).toBe(false);
    expect((await s.tick()).delivery).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(1);
  });

  it("parked compaction beginning after paste keeps its actual partial-input outcome", async () => {
    const f = fixture();
    if (draftAware) await f.enable();
    const compact = compactionFor(f); const s = await parkedReminder(f);
    f.hooks.paste = compact.submit;
    const first = await s.tick();
    expect(f.pastes).toHaveLength(1);
    expect(f.submissions).toEqual([]);
    expect(first.delivery).toMatchObject({ status: "failed", error: expect.stringContaining("Text was written") });
    expect(s.history.listForJob(s.job.jobId, 1)[0]!.evaluationNotes?.["deliveryInputPhase"]).toBe("written");
    expect(s.history.listForJob(s.job.jobId, 1)[0]!.evaluationNotes?.["deliveryReason"]).toContain("[managed-compaction-pending]");
    await s.tick();
    expect(s.repo.getById(s.row.qitemId)?.lastNudgeResult ?? "").not.toMatch(/^failed:/);
    expect(queueRecoveryOwnsWake(f.db, s.repo.getById(s.row.qitemId))).toBe(false);
    expect(s.repo.listTransitions(s.row.qitemId).some(t => t.transitionNote?.startsWith("parked-owner wake delivery failed:"))).toBe(false);
  });

  });

  it("parked compaction hold is scoped: peer sends and unrelated watchdog policies still input", async () => {
    const f = fixture();
    const compact = compactionFor(f); await compact.submit();
    expect(await f.transport.send(seat, "Peer context")).toMatchObject({ ok: true });
    expect(await f.deliver({ targetSession: seat, message: "Unrelated reminder" }, lone("other", "occ"))).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(2);
  });
});


describe("watchdog positive no-input outcomes", () => {
  it("preserves a real held-quota rejection through transport and engine history", async () => {
    const f = fixture();
    await f.hold();
    const target = resolveGuardTarget(f.db, seat)!;
    // Distinct senders fill the quota: a seat holds one message per sender (#2430).
    for (let i = 0; i < 100; i++) f.outbox.retain({ outboxId: `held-${i}`, senderSession: `filler-${i}@test`, destinationSession: seat, body: "held" }, target);
    const jobs = new WatchdogJobsRepository(f.db);
    const history = new WatchdogHistoryLog(f.db);
    const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: new EventBus(f.db), deliver: f.deliver });
    const job = jobs.register({ policy: "periodic-reminder", targetSession: seat, intervalSeconds: 60, registeredBySession: seat, specYaml: "message: Still owed\n" });
    await engine.evaluate(job);
    expect(history.listForJob(job.jobId, 1)[0]).toMatchObject({ deliveryStatus: "failed", evaluationNotes: { deliveryCode: "retained_quota_full", deliveryInputPhase: "not_reached" } });
    expect(f.outbox.retentionUsage("a").count).toBe(100);
    expect(f.pastes).toHaveLength(0);
    expect(f.submissions).toHaveLength(0);
  });

  it.each([undefined, "attempted", "written"] as const)("does not promote a quota-shaped result with phase %s", async inputPhase => {
    const deliver = makeWatchdogDeliver({ sessionTransport: { send: async () => ({ ok: false, sessionName: seat, sent: false, reason: "retained_quota_full", error: "quota-shaped error", ...(inputPhase ? { inputPhase } : {}) }) } });
    const result = await deliver({ targetSession: seat, message: "Still owed" }, { jobId: "quota-result-control", policy: PARKED_OWNER_POLICY_NAME, occurrenceId: "one" });
    expect(result).not.toHaveProperty("code");
    if (inputPhase) expect(result).toHaveProperty("inputPhase", inputPhase);
    else expect(result).not.toHaveProperty("inputPhase");
  });

  it("does not infer no input from an untyped error with the same text", async () => {
    const deliver = makeWatchdogDeliver({ sessionTransport: { send: async () => { throw new Error("Held-message quota is full; no input was written."); } } });
    const result = await deliver({ targetSession: seat, message: "Still owed" }, { jobId: "quota-control", policy: PARKED_OWNER_POLICY_NAME, occurrenceId: "one" });
    expect(result).not.toHaveProperty("code");
    expect(result).not.toHaveProperty("inputPhase");
  });

  it("excludes bound terminal-only parked reminders while preserving other deliberate deliveries", async () => {
    const sends = vi.fn().mockResolvedValue({ ok: true });
    const deliver = makeWatchdogDeliver({ sessionTransport: { send: sends }, isTerminalSeat: () => true } as Parameters<typeof makeWatchdogDeliver>[0]);
    const refused = await deliver({ targetSession: seat, message: "Parked wake" }, { jobId: "terminal-policy", policy: PARKED_OWNER_POLICY_NAME, occurrenceId: "one" });
    expect(refused).toMatchObject({ status: "failed", code: "terminal_seat", inputPhase: "not_reached" });
    expect(sends).not.toHaveBeenCalled();
    const deliberate = await deliver({ targetSession: seat, message: "Explicitly requested terminal text" }, { jobId: "terminal-explicit", policy: "periodic-reminder", occurrenceId: "two" });
    expect(deliberate.status).toBe("ok");
    expect(sends).toHaveBeenCalledTimes(1);
  });
});


describe("blocked parked-owner no-input recovery on the real repository", () => {
  it.each(["quota", "terminal"].flatMap(kind => ["before", "after"].map(noteTiming => ({ kind, noteTiming }))))("keeps $kind recovery across another seat note $noteTiming creation", async ({ kind, noteTiming }) => {
    const f = fixture();
    if (kind === "quota") {
      await f.hold();
      const target = resolveGuardTarget(f.db, seat)!;
      // Distinct senders fill the quota: a seat holds one message per sender (#2430).
      for (let i = 0; i < 100; i++) f.outbox.retain({ outboxId: `blocked-held-${i}`, senderSession: `filler-${i}@test`, destinationSession: seat, body: "held" }, target);
    } else f.db.prepare("UPDATE nodes SET runtime='terminal' WHERE id='a'").run();
    const { repo, jobs, history } = scheduled(f);
    const row = await repo.create({ sourceSession: "orch@test", destinationSession: seat, body: "Current obligation", nudge: false });
    repo.update({ qitemId: row.qitemId, actorSession: seat, state: "blocked", blockedOn: "external:fixture", transitionNote: "waiting without a backstop" });
    const { isBoundTerminalSeat } = await import("../src/domain/terminal-seat.js");
    const { runStuckSweep } = await import("../src/domain/queue-stuck-sweep.js");
    const { findQueueRecovery } = await import("../src/domain/queue-recovery.js");
    const policy = makeParkedOwnerConsumerPolicy({
      diagnoseRig: () => ({ seats: [{ sessionName: seat, parked: true, activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null } }, obligations: { items: [], held: [{ qitemId: row.qitemId, healthy: false }] } }] }),
      history: { listForJob: (id, limit) => history.listForJob(id, limit), countForJob: id => history.countForJob(id) },
      rows: {
        listTransitions: id => repo.listTransitions(id).map(t => ({ ...t, ts: t.ts, transitionNote: t.transitionNote ?? null })),
        appendNote: (qitemId, transitionNote) => { repo.update({ qitemId, actorSession: "watchdog@system", transitionNote }); return { ok: true }; },
        recordNudgeResult: (id, result) => repo.recordNudgeAttempt(id, result),
        listOpenIds: destination => repo.listOpenObligations(destination, 500).map(r => r.qitemId),
        recoveryOwnsWake: id => queueRecoveryOwnsWake(f.db, repo.getById(id)),
      },
      retentionState: () => JSON.stringify(f.outbox.retentionUsage("a")),
      isTerminalSeat: session => isBoundTerminalSeat(f.db, session), occupantGeneration: () => "g1",
    });
    const job = jobs.register({ policy: PARKED_OWNER_POLICY_NAME, targetSession: makeRigAnchor("test"), intervalSeconds: 60, registeredBySession: seat, specYaml: "{}" });
    const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: new EventBus(f.db), deliver: f.deliver, additionalPolicies: [policy] });
    await engine.evaluate(job);
    await engine.evaluate(jobs.getByIdOrThrow(job.jobId));
    let writes = repo.listTransitions(row.qitemId).length;
    const nudge = repo.getById(row.qitemId)!.lastNudgeAttempt;
    for (let i = 0; i < 10; i++) expect((await engine.evaluate(jobs.getByIdOrThrow(job.jobId))).outcome.action).toBe("skip");
    expect(repo.listTransitions(row.qitemId)).toHaveLength(writes);
    expect(repo.getById(row.qitemId)!.lastNudgeAttempt).toBe(nudge);
    const sweep = () => runStuckSweep({ db: f.db, queueRepo: repo, resolveOrchestrator: () => "orch@test", sessionConfirmedMissing: () => false, log: () => {} });
    if (noteTiming === "before") {
      repo.update({ qitemId: row.qitemId, actorSession: "observer@test", transitionNote: "Additional diagnostic context; owner has not responded" });
      writes++;
    }
    await sweep();
    const recovery = findQueueRecovery(f.db, row.qitemId);
    expect(recovery).not.toBeNull();
    const finding = repo.getById(recovery!.qitemId)!;
    expect(finding.destinationSession).toBe("orch@test");
    expect(repo.waitingView(finding.qitemId)?.nextBackstop).toMatchObject({ owner: "orch@test", mechanism: "queue-stuck-sweep:unclaimed", dueAt: expect.any(String) });
    if (noteTiming === "after") {
      repo.update({ qitemId: row.qitemId, actorSession: "observer@test", transitionNote: "More context; owner still has not responded" });
      writes++;
      await sweep();
      expect(repo.getById(finding.qitemId)?.state).toBe("pending");
    }
    const count = f.db.prepare("SELECT count(*) AS n FROM queue_items").get() as { n: number };
    for (let i = 0; i < 10; i++) { await sweep(); expect((await engine.evaluate(jobs.getByIdOrThrow(job.jobId))).outcome.action).toBe("skip"); }
    expect((f.db.prepare("SELECT count(*) AS n FROM queue_items").get() as { n: number }).n).toBe(count.n);
    expect(findQueueRecovery(f.db, row.qitemId)?.qitemId).toBe(finding.qitemId);
    expect(repo.listTransitions(row.qitemId)).toHaveLength(writes);
    repo.update({ qitemId: row.qitemId, actorSession: seat, transitionNote: "Owner response: I am handling this obligation" });
    await sweep();
    expect(repo.getById(finding.qitemId)?.state).toBe("done");
    expect(f.pastes).toHaveLength(0);
    expect(f.submissions).toHaveLength(0);
  });

  // #3076: a seat that turned queue-only holds OpenRig's reminders on purpose, so an earlier refusal is no reason to fix
  // its input: the real sweep files no finding, even before the parked-owner policy runs again. Without the switch it does.
  // A bound terminal seat stays a terminal seat at queue-only: its finding stays.
  it.each([{ kind: "quota", switched: false }, { kind: "quota", switched: true }, { kind: "terminal", switched: true }])(
    "a $kind failure followed by a switch to queue-only (switched=$switched) is a no-input finding only for a terminal seat or without the switch", async ({ kind, switched }) => {
    const f = fixture();
    if (kind === "quota") {
      await f.hold();
      const target = resolveGuardTarget(f.db, seat)!;
      for (let i = 0; i < 100; i++) f.outbox.retain({ outboxId: `quota-held-${i}`, senderSession: `filler-${i}@test`, destinationSession: seat, body: "held" }, target);
    } else f.db.prepare("UPDATE nodes SET runtime='terminal' WHERE id='a'").run();
    const { isBoundTerminalSeat } = await import("../src/domain/terminal-seat.js");
    const { repo, jobs, history } = scheduled(f);
    const row = await repo.create({ sourceSession: "orch@test", destinationSession: seat, body: "Current obligation", nudge: false });
    repo.update({ qitemId: row.qitemId, actorSession: seat, state: "blocked", blockedOn: "external:fixture", transitionNote: "waiting without a backstop" });
    const { findQueueRecovery } = await import("../src/domain/queue-recovery.js");
    const policy = makeParkedOwnerConsumerPolicy({
      diagnoseRig: () => ({ seats: [{ sessionName: seat, parked: true, activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null } }, obligations: { items: [], held: [{ qitemId: row.qitemId, healthy: false }] } }] }),
      history: { listForJob: (id, limit) => history.listForJob(id, limit), countForJob: id => history.countForJob(id) },
      rows: {
        listTransitions: id => repo.listTransitions(id).map(t => ({ ...t, ts: t.ts, transitionNote: t.transitionNote ?? null })),
        appendNote: (qitemId, transitionNote) => { repo.update({ qitemId, actorSession: "watchdog@system", transitionNote }); return { ok: true }; },
        recordNudgeResult: (id, result) => repo.recordNudgeAttempt(id, result),
        listOpenIds: destination => repo.listOpenObligations(destination, 500).map(r => r.qitemId),
        recoveryOwnsWake: id => queueRecoveryOwnsWake(f.db, repo.getById(id)),
      },
      retentionState: () => JSON.stringify(f.outbox.retentionUsage("a")),
      isTerminalSeat: session => isBoundTerminalSeat(f.db, session), occupantGeneration: () => "g1",
    });
    const job = jobs.register({ policy: PARKED_OWNER_POLICY_NAME, targetSession: makeRigAnchor("test"), intervalSeconds: 60, registeredBySession: seat, specYaml: "{}" });
    const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: new EventBus(f.db), deliver: f.deliver, additionalPolicies: [policy] });
    await engine.evaluate(job);
    await engine.evaluate(jobs.getByIdOrThrow(job.jobId));
    expect(repo.getById(row.qitemId)!.lastNudgeResult).toMatch(kind === "quota" ? /^failed:.*retained_quota_full/ : /^failed:terminal-seat:/);
    if (switched) await f.setQueueOnly();
    await runStuckSweep({ db: f.db, queueRepo: repo, resolveOrchestrator: () => "orch@test", sessionConfirmedMissing: () => false, log: () => {} });
    expect(findQueueRecovery(f.db, row.qitemId) === null).toBe(kind === "quota" && switched);
    expect(f.submissions).toHaveLength(0);
  });
});


// #3076: the queue-only level, for a seat a person types in. OpenRig's reminders never type there: a reminder about a
// parked row of the seat is noted on that row, any other becomes one cold row in the seat's queue (no nudge), and a
// later occurrence of the same job is noted on that row while it is still unclaimed.
describe("queue-only seat: a watchdog reminder is never typed (#3076)", () => {
  type Row = { qitemId: string; destinationSession: string; body: string; summary: string; tags: string[] };
  it("a reminder with no parked row is one cold row per occurrence, with an id from the occurrence; no id or no row, no input", async () => {
    const sends = vi.fn().mockResolvedValue({ ok: true });
    const rows: Row[] = [];
    const deliver = makeWatchdogDeliver({ sessionTransport: { send: sends }, isQueueOnlySeat: s => s === seat,
      createQueueRow: async (row: Row) => { rows.push(row); return { qitemId: row.qitemId, state: "pending" }; } } as never);
    const wake = { jobId: "wake-1", policy: "periodic-reminder", occurrenceId: "occ-1" };
    expect(await deliver({ targetSession: seat, message: "Check the deploy." }, wake)).toMatchObject({ status: "ok", code: "queued_as_row" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qitemId).toContain("occ-1");
    expect(rows[0]).toMatchObject({ destinationSession: seat,
      tags: expect.arrayContaining(["watchdog", "queue-only", "watchdog-job:wake-1", "policy:periodic-reminder"]) });
    expect(rows[0]!.body).toContain("[OpenRig watchdog scheduler · policy: periodic-reminder · job: wake-1]");
    expect(rows[0]!.body).toContain("Check the deploy.");
    expect(rows[0]!.summary).toContain("Check the deploy.");
    // A digest of reminders with no parked row is one row too, under the digest's own occurrence.
    const digested = { jobId: "digest-x", policy: "periodic-reminder", occurrenceId: "digest-x",
      members: [{ jobId: "a", occurrenceId: "o-a" }, { jobId: "b", occurrenceId: "o-b" }] };
    expect(await deliver({ targetSession: seat, message: "Two reminders" }, digested)).toMatchObject({ status: "ok", code: "queued_as_row" });
    expect(rows).toHaveLength(2);
    expect(sends).not.toHaveBeenCalled();
    // Another seat is unchanged: typed as before.
    expect(await deliver({ targetSession: "other@test", message: "Typed" }, { jobId: "x", policy: "periodic-reminder", occurrenceId: "o-x" })).toMatchObject({ status: "ok" });
    expect(sends).toHaveBeenCalledTimes(1);
    // With no occurrence to name the row, nothing is created and nothing is typed: the occurrence stays owed.
    expect(await deliver({ targetSession: seat, message: "m" }, { jobId: "n", policy: "periodic-reminder" }))
      .toMatchObject({ status: "failed", sent: false, inputPhase: "not_reached" });
    // A row that can't be created leaves the occurrence owed, with no input.
    const failing = makeWatchdogDeliver({ sessionTransport: { send: sends }, isQueueOnlySeat: () => true,
      createQueueRow: async () => { throw new Error("queue down"); } } as never);
    expect(await failing({ targetSession: seat, message: "m" }, { jobId: "f", policy: "periodic-reminder", occurrenceId: "o-f" }))
      .toMatchObject({ status: "failed", sent: false, inputPhase: "not_reached" });
    expect(sends).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
  });

  it("a retried occurrence is its same open row on the real queue; once that row is closed, a new row with a derived id, never the closed one", async () => {
    const f = fixture();
    const s = scheduled(f);
    const deliver = makeWatchdogDeliver({ sessionTransport: f.transport, isQueueOnlySeat: name => name === seat,
      createQueueRow: (row: Row) => s.repo.create({ ...row, sourceSession: "watchdog@system", nudge: false, wakeTrigger: "openrig" } as never)
        .then(r => ({ qitemId: r.qitemId, state: r.state })) } as never);
    const wake = { jobId: "wake-1", policy: "periodic-reminder", occurrenceId: "occ-1" };
    const first = await deliver({ targetSession: seat, message: "Check the deploy." }, wake);
    expect(first).toMatchObject({ status: "ok", code: "queued_as_row" });
    const id = first.queuedQitemId!;
    expect(await deliver({ targetSession: seat, message: "Check the deploy." }, wake)).toMatchObject({ status: "ok", code: "queued_as_row", queuedQitemId: id });
    const watchdogRows = () => (f.db.prepare("SELECT qitem_id, state FROM queue_items WHERE source_session = 'watchdog@system' ORDER BY rowid").all() as
      Array<{ qitem_id: string; state: string }>);
    expect(watchdogRows()).toEqual([{ qitem_id: id, state: "pending" }]);
    s.repo.claim({ qitemId: id, destinationSession: seat });
    s.repo.update({ qitemId: id, actorSession: seat, state: "done", closureReason: "no-follow-on", transitionNote: "read it" } as never);
    // The same occurrence firing again (a notice repeated with the same identity) is not lost on the closed row.
    const again = await deliver({ targetSession: seat, message: "Check the deploy." }, wake);
    expect(again).toMatchObject({ status: "ok", code: "queued_as_row", queuedQitemId: `${id}-2` });
    expect(await deliver({ targetSession: seat, message: "Check the deploy." }, wake)).toMatchObject({ queuedQitemId: `${id}-2` });
    expect(watchdogRows()).toEqual([{ qitem_id: id, state: "done" }, { qitem_id: `${id}-2`, state: "pending" }]);
    expect(f.submissions).toEqual([]);
  });

  it("a cold row's summary never ends inside a surrogate pair", async () => {
    const rows: Row[] = [];
    const deliver = makeWatchdogDeliver({ sessionTransport: { send: vi.fn() }, isQueueOnlySeat: () => true,
      createQueueRow: async (row: Row) => { rows.push(row); return { qitemId: row.qitemId, state: "pending" }; } } as never);
    await deliver({ targetSession: seat, message: `${"x".repeat(159)}\u{1F600}${"y".repeat(50)}` }, { jobId: "s", policy: "periodic-reminder", occurrenceId: "o-s" });
    expect(rows[0]!.summary).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(rows[0]!.summary).toContain("x".repeat(159));
  });

  /** A queue-only seat on the real queue, transport and scheduler, wired as the daemon wires it. `afterResolve` runs
   *  inside the delivery once it has found the parked rows, `beforeCreate` before it creates a cold row; `saved` starts
   *  from a store kept by an earlier process. */
  function queueOnly(opts: { afterResolve?: (rows: string[]) => void; beforeCreate?: () => void; afterCreate?: () => void; beforeNote?: () => void; saved?: Buffer } = {}) {
    const f = fixture(opts.saved);
    let repo!: QueueRepository;
    const deliver = makeWatchdogDeliver({ sessionTransport: f.transport, outbox: f.outbox, isQueueOnlySeat: name => name === seat || name === "other@test",
      createQueueRow: (row: Row) => {
        opts.beforeCreate?.();
        return repo.create({ ...row, sourceSession: "watchdog@system", nudge: false, wakeTrigger: "openrig" } as never).then(r => {
          opts.afterCreate?.();
          return { qitemId: r.qitemId, state: r.state };
        });
      },
      resolveParkedRows: ({ jobId, targetSession }: { jobId: string; targetSession: string }) => {
        const rows = repo.parkedRowsOwnedBy(jobId, targetSession);
        opts.afterResolve?.(rows);
        return rows;
      },
      noteParkedRows: (input: { owner: string; notes: Array<{ qitemId: string; jobId: string; note: string }> }) => {
        opts.beforeNote?.();
        return repo.noteParkedRows(input.owner, input.notes);
      },
      noteQueuedRow: (input: { jobId: string; destinationSession: string; note: string }) =>
        repo.noteOpenWatchdogRow(input.jobId, input.destinationSession, input.note),
    } as never);
    const s = scheduled({ ...f, deliver }, { queueWait: true });
    repo = s.repo;
    const wdRows = () => f.db.prepare("SELECT qitem_id, destination_session, state FROM queue_items WHERE source_session = 'watchdog@system'").all() as
      Array<{ qitem_id: string; destination_session: string; state: string }>;
    const parkWith = async (summary: string, wake: Record<string, unknown>) => {
      const row = await repo.create({ sourceSession: "orch@test", destinationSession: seat, body: summary, summary, nudge: false } as never) as unknown as { qitemId: string };
      repo.update({ qitemId: row.qitemId, actorSession: seat, state: "blocked", blockedOn: "external:wait", transitionNote: "parked", ...wake } as never);
      return { qitemId: row.qitemId, jobId: repo.getParkWakeStatus(row.qitemId)!.ref };
    };
    const notes = (qitemId: string, jobId: string) => s.repo.listTransitions(qitemId).map(t => t.transitionNote ?? "")
      .filter(n => n.includes(`park wake noted on this row: watchdog ${jobId}; delivery=noted_on_parked_row; nothing typed`));
    const operatorReminder = (target = seat) => s.jobs.register({ policy: "periodic-reminder", targetSession: target, intervalSeconds: 600,
      registeredBySession: "orch@test", specYaml: `policy: periodic-reminder\ntarget:\n  session: ${JSON.stringify(target)}\nmessage: "check your rows"\n` });
    const tick = async (jobId: string) => { s.due(jobId); await s.scheduler.runTickNow(); };
    return { f, s, wdRows, parkWith, notes, operatorReminder, tick };
  }

  it("a park timer is noted on its own parked row, alone or in a digest, with no second row and nothing typed", async () => {
    const { f, s, wdRows, notes, tick } = queueOnly();
    const a = await s.park("A's wait");
    await tick(a.jobId);
    const b = await s.park("B's wait");
    const c = await s.park("C's wait");
    s.due(b.jobId);
    s.due(c.jobId);
    await s.scheduler.runTickNow();
    expect(wdRows()).toEqual([]);
    for (const { qitemId, jobId } of [a, b, c]) {
      expect(s.repo.getById(qitemId)!.state).toBe("blocked");
      expect(notes(qitemId, jobId)).toHaveLength(1);
      // The delivery's note is the row's only park wake record: the engine writes no second one.
      expect(s.repo.listTransitions(qitemId).filter(t => (t.transitionNote ?? "").startsWith("park wake"))).toHaveLength(1);
      expect(s.repo.listTransitions(qitemId).some(t => (t.transitionNote ?? "").includes("delivery=ok"))).toBe(false);
      expect(s.repo.getParkWakeStatus(qitemId)).toMatchObject({ deliveryStatus: "noted_on_parked_row", unconsumed: true });
      expect(s.history.listForJob(jobId, 1)[0]).toMatchObject({ outcome: "sent", deliveryStatus: "noted_on_parked_row" });
      expect(s.jobs.getByIdOrThrow(jobId).state).toBe("terminal");
    }
    // The outbox closes custody for each occurrence (no retry, never indeterminate) and says it was noted on the row.
    const receipts = f.db.prepare("SELECT delivery_state, guard_delivery FROM outbox_entries WHERE outbox_id LIKE 'watchdog-occurrence-%'").all() as Array<{ delivery_state: string; guard_delivery: string }>;
    expect(receipts).toHaveLength(3);
    for (const r of receipts) {
      expect(r.delivery_state).toBe("delivered");
      expect(JSON.parse(r.guard_delivery).watchdog).toMatchObject({ queueOnly: { code: "noted_on_parked_row" } });
    }
    expect(f.pastes).toEqual([]);
    expect(f.submissions).toEqual([]);
  });

  it("a park timer with its own message is noted on its row with that text", async () => {
    const { f, s, wdRows, notes, tick } = queueOnly();
    const a = await s.park("A's wait");
    updateWatchdogJob(s.jobs, a.jobId, { message: "Check the release notes first." });
    await tick(a.jobId);
    expect(wdRows()).toEqual([]);
    expect(notes(a.qitemId, a.jobId).some(n => n.includes("\nreminder: Check the release notes first."))).toBe(true);
    expect(s.history.listForJob(a.jobId, 1)[0]).toMatchObject({ outcome: "sent", deliveryStatus: "noted_on_parked_row" });
    expect(f.submissions).toEqual([]);
  });

  it("a workflow's park is noted with its re-presentation, never the default wake", async () => {
    const { f, s, wdRows, parkWith, notes, tick } = queueOnly();
    const w = await parkWith("work step", { wakeAfterSeconds: 60, wakeMessage:
      "Workflow wait re-presentation (blocker progress or reminder): authored-wait@1 instance wf-x step work.\nYou still own the same frontier packet." });
    await tick(w.jobId);
    expect(wdRows()).toEqual([]);
    expect(notes(w.qitemId, w.jobId).some(n => n.includes("You still own the same frontier packet."))).toBe(true);
    expect(f.submissions).toEqual([]);
  });

  it("a repeating wait (wakeMaxSeconds) is noted on its row with its reason, and keeps its cadence", async () => {
    const { f, s, wdRows, parkWith, notes, tick } = queueOnly();
    const r = await parkWith("long wait", { wakeAfterSeconds: 600, wakeMaxSeconds: 2400 });
    await tick(r.jobId);
    expect(wdRows()).toEqual([]);
    expect(notes(r.qitemId, r.jobId).some(n => /Waiting (backstop|source changed)/.test(n))).toBe(true);
    expect(s.history.listForJob(r.jobId, 1)[0]).toMatchObject({ outcome: "sent", deliveryStatus: "noted_on_parked_row" });
    expect(s.jobs.getByIdOrThrow(r.jobId).state).toBe("active");
    expect(f.submissions).toEqual([]);
  });

  it("a repeating wait presented again, after its first presentation was noted on the row, is noted on that same row: never a cold row", async () => {
    const { f, s, wdRows, parkWith, notes, tick } = queueOnly();
    const blocker = await s.repo.create({ sourceSession: "orch@test", destinationSession: "vendor@test", body: "vendor reply", summary: "vendor reply", nudge: false } as never) as unknown as { qitemId: string };
    const r = await parkWith("wait for the vendor", { wakeAfterSeconds: 600, wakeMaxSeconds: 2400, blockedOn: blocker.qitemId });
    await tick(r.jobId);
    expect(notes(r.qitemId, r.jobId)).toHaveLength(1);
    // The blocker moves, so the wait is presented again.
    s.repo.update({ qitemId: blocker.qitemId, actorSession: "vendor@test", transitionNote: "replied in part" } as never);
    s.repo.reconcileWaitReminders(blocker.qitemId);
    await tick(r.jobId);
    expect(notes(r.qitemId, r.jobId)).toHaveLength(2);
    expect(notes(r.qitemId, r.jobId)[1]).toContain("Waiting source changed");
    expect(wdRows()).toEqual([]);
    expect(s.history.listForJob(r.jobId, 1)[0]).toMatchObject({ outcome: "sent", deliveryStatus: "noted_on_parked_row" });
    expect(s.jobs.getByIdOrThrow(r.jobId).state).toBe("active");
    expect(f.submissions).toEqual([]);
  });

  it("a timer shared by --wake-watchdog notes both parked rows, with no row of its own and the default wake on neither", async () => {
    const { f, s, wdRows, parkWith, notes, tick } = queueOnly();
    const a = await s.park("A's wait");
    const b = await parkWith("B attached", { wakeWatchdogId: a.jobId });
    await tick(a.jobId);
    expect(wdRows()).toEqual([]);
    for (const q of [a.qitemId, b.qitemId]) {
      expect(notes(q, a.jobId)).toHaveLength(1);
      expect(s.repo.listTransitions(q).filter(t => (t.transitionNote ?? "").startsWith("park wake"))).toHaveLength(1);
      expect(notes(q, a.jobId).some(n => n.includes("\nreminder:"))).toBe(false);
    }
    expect(f.submissions).toEqual([]);
  });

  it("noteParkedRows reads each job's parked rows once, however many notes it carries, and notes only that job's rows", async () => {
    const { s, parkWith, notes } = queueOnly();
    const a = await s.park("A's wait");
    const b = await parkWith("B attached", { wakeWatchdogId: a.jobId });
    const c = await s.park("C's own wait");
    const read = vi.spyOn((s.repo as unknown as { wakeRepo: { findCurrentParkRowsByWatchdog: (j: string, o: string) => string[] } }).wakeRepo,
      "findCurrentParkRowsByWatchdog");
    const note = (qitemId: string, jobId: string) =>
      ({ qitemId, jobId, note: `park wake noted on this row: watchdog ${jobId}; delivery=noted_on_parked_row; nothing typed` });
    expect(s.repo.noteParkedRows(seat, [note(a.qitemId, a.jobId), note(b.qitemId, a.jobId), note(c.qitemId, a.jobId), note(c.qitemId, c.jobId)]))
      .toEqual([a.qitemId, b.qitemId, c.qitemId]);
    expect(read.mock.calls.map(([jobId]) => jobId)).toEqual([a.jobId, c.jobId]);
    expect([notes(a.qitemId, a.jobId), notes(b.qitemId, a.jobId), notes(c.qitemId, a.jobId), notes(c.qitemId, c.jobId)].map(n => n.length))
      .toEqual([1, 1, 0, 1]);
  });

  it("a row that left its park and was parked again with no wake of its own is not that reminder's row: the fire is a cold row", async () => {
    const { f, s, wdRows, parkWith, notes, operatorReminder, tick } = queueOnly();
    const job = operatorReminder();
    const b = await parkWith("bound to the operator's reminder", { wakeWatchdogId: job.jobId });
    s.repo.update({ qitemId: b.qitemId, actorSession: seat, state: "in-progress", transitionNote: "resumed" } as never);
    s.repo.update({ qitemId: b.qitemId, actorSession: seat, state: "blocked", blockedOn: "external:gate", transitionNote: "gate, no wake" } as never);
    await tick(job.jobId);
    expect(notes(b.qitemId, job.jobId)).toEqual([]);
    // Nor does it get a park record of a park that isn't its current one.
    expect(s.repo.listTransitions(b.qitemId).filter(t => (t.transitionNote ?? "").startsWith("park wake"))).toEqual([]);
    expect(wdRows().map(r => r.destination_session)).toEqual([seat]);
    expect(s.history.listForJob(job.jobId, 1)[0]).toMatchObject({ outcome: "sent", deliveryStatus: "queued_as_row" });
    expect(f.submissions).toEqual([]);
  });

  it("an active recurring reminder attached by --wake-watchdog notes the still-parked row on every occurrence, never a row of its own", async () => {
    const { f, s, wdRows, parkWith, notes, operatorReminder, tick } = queueOnly();
    const job = operatorReminder();
    const b = await parkWith("bound to the operator's reminder", { wakeWatchdogId: job.jobId });
    await tick(job.jobId);
    await tick(job.jobId);
    expect(s.repo.getById(b.qitemId)!.state).toBe("blocked");
    expect(notes(b.qitemId, job.jobId)).toHaveLength(2);
    expect(wdRows()).toEqual([]);
    expect(s.history.listForJob(job.jobId, 10).map(h => h.deliveryStatus)).toEqual(["noted_on_parked_row", "noted_on_parked_row"]);
    expect(f.submissions).toEqual([]);
  });

  it("a reminder whose target is another seat than the parked row's owner is that seat's own row", async () => {
    const { s, wdRows, parkWith, operatorReminder, tick } = queueOnly();
    const job = operatorReminder();
    const parked = await parkWith("bound to a shared job", { wakeWatchdogId: job.jobId });
    const moved = `policy: periodic-reminder\ntarget:\n  session: "other@test"\nmessage: "check your rows"\n`;
    s.jobs.updateInPlace(job.jobId, moved, 600, s.jobs.getByIdOrThrow(job.jobId).lastEvaluationAt);
    await tick(job.jobId);
    expect(wdRows().map(r => r.destination_session)).toEqual(["other@test"]);
    // The parked row bound to the job says what the reminder became: the other seat's row, by its id.
    const coldRow = wdRows()[0]!.qitem_id;
    const records = s.repo.listTransitions(parked.qitemId).map(t => t.transitionNote ?? "").filter(n => n.startsWith("park wake"));
    expect(records).toEqual([queuedAsRowNote(job.jobId, "queued_as_row", coldRow)]);
    expect(records[0]).toMatch(new RegExp(`^park wake queued as row: watchdog ${job.jobId}; delivery=queued_as_row ${coldRow}; nothing typed`));
  });

  it("a periodic reminder's next occurrence is noted on its open cold row, claimed or not, never a second row; a closed one gets a new row", async () => {
    const { f, s, wdRows, operatorReminder, tick } = queueOnly();
    const job = operatorReminder();
    await tick(job.jobId);
    await tick(job.jobId);
    await tick(job.jobId);
    const rows = wdRows();
    expect(rows).toHaveLength(1);
    const [first, ...later] = s.history.listForJob(job.jobId, 10).reverse();
    expect(first).toMatchObject({ outcome: "sent", deliveryStatus: "queued_as_row" });
    expect(later.map(h => h.deliveryStatus)).toEqual(["noted_on_queued_row", "noted_on_queued_row"]);
    expect(later.map(h => (h.evaluationNotes as { queuedQitemId?: string }).queuedQitemId)).toEqual([rows[0]!.qitem_id, rows[0]!.qitem_id]);
    const noted = s.repo.listTransitions(rows[0]!.qitem_id).filter(t => (t.transitionNote ?? "").startsWith(`watchdog reminder again: watchdog ${job.jobId}; delivery=noted_on_queued_row; nothing typed`));
    expect(noted).toHaveLength(2);
    expect(noted[0]!.transitionNote).toContain("check your rows");
    expect(s.repo.getById(rows[0]!.qitem_id)!.state).toBe("pending");
    // The seat has taken that row and not closed it: the reminder is still that work, so the next occurrence is noted there.
    s.repo.claim({ qitemId: rows[0]!.qitem_id, destinationSession: seat });
    await tick(job.jobId);
    expect(wdRows()).toHaveLength(1);
    expect(s.history.listForJob(job.jobId, 1)[0]).toMatchObject({ deliveryStatus: "noted_on_queued_row" });
    expect(s.repo.getById(rows[0]!.qitem_id)!.state).toBe("in-progress");
    // Once it's closed, the next occurrence is a row of its own.
    s.repo.update({ qitemId: rows[0]!.qitem_id, actorSession: seat, state: "done", closureReason: "no-follow-on" } as never);
    await tick(job.jobId);
    expect(wdRows()).toHaveLength(2);
    expect(f.submissions).toEqual([]);
  });

  it("the park's default wake is recognized only exact or with its continuation's preview", () => {
    const q = "qitem-20261114000000-aaaaaaaa";
    const dflt = defaultParkWakeMessage(q);
    expect(isDefaultParkWakeMessage(dflt)).toBe(true);
    expect(isDefaultParkWakeMessage(withContinuationPreview(dflt, q, "hand the head to the planner"))).toBe(true);
    expect(isDefaultParkWakeMessage(withContinuationPreview(dflt, q, `long ${"x".repeat(400)}\n  more`))).toBe(true);
    expect(isDefaultParkWakeMessage(`${dflt}\nSTOP: inspect the failed migration before resuming.`)).toBe(false);
    expect(isDefaultParkWakeMessage(`${dflt} and check the deploy`)).toBe(false);
    expect(isDefaultParkWakeMessage(`${withContinuationPreview(dflt, q, "do X")}\nSTOP: and this too.`)).toBe(false);
    expect(isDefaultParkWakeMessage("Check the release notes first.")).toBe(false);
  });

  it("a reminder's own text after the default wake is on the note; the default with its preview adds no reminder line", async () => {
    const { s, notes, tick } = queueOnly();
    const a = await s.park("A's wait");
    updateWatchdogJob(s.jobs, a.jobId, { message: `${defaultParkWakeMessage(a.qitemId)}\nSTOP: inspect the failed migration before resuming.` });
    await tick(a.jobId);
    expect(notes(a.qitemId, a.jobId)[0]).toContain("\nreminder: ");
    expect(notes(a.qitemId, a.jobId)[0]).toContain("STOP: inspect the failed migration before resuming.");
    const b = await s.park("B's wait", "continuation: hand the head to the planner");
    await tick(b.jobId);
    expect(notes(b.qitemId, b.jobId)).toHaveLength(1);
    expect(notes(b.qitemId, b.jobId)[0]).not.toContain("\nreminder:");
  });

  it("a long reminder is cut on the note, pointing at the job's full text, never splitting a surrogate pair", async () => {
    const { s, notes, tick } = queueOnly();
    const a = await s.park("A's wait");
    updateWatchdogJob(s.jobs, a.jobId, { message: `Check the notes. ${"x".repeat(3000)}` });
    await tick(a.jobId);
    const [cut] = notes(a.qitemId, a.jobId);
    expect(cut).toContain("Check the notes.");
    expect(cut).toContain(`… (full text: rig watchdog show ${a.jobId})`);
    expect(cut!.length).toBeLessThan(2400);
    const b = await s.park("B's wait");
    updateWatchdogJob(s.jobs, b.jobId, { message: `${"x".repeat(1999)}\u{1F600}${"y".repeat(100)}` });
    await tick(b.jobId);
    const [pair] = notes(b.qitemId, b.jobId);
    expect(pair).toContain(`\nreminder: ${"x".repeat(1999)}… (full text: rig watchdog show ${b.jobId})`);
    expect(pair).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("a recovered delivery notes the text that was sent, not the job's later message", async () => {
    const queueOnlyDeliver = (ff: ReturnType<typeof fixture>, repoOf: () => QueueRepository) =>
      makeWatchdogDeliver({ sessionTransport: ff.transport, outbox: ff.outbox, isQueueOnlySeat: name => name === seat,
        createQueueRow: (row: Row) => repoOf().create({ ...row, sourceSession: "watchdog@system", nudge: false } as never).then(r => ({ qitemId: r.qitemId, state: r.state })),
        resolveParkedRows: ({ jobId, targetSession }: { jobId: string; targetSession: string }) =>
          repoOf().parkedRowsOwnedBy(jobId, targetSession),
        noteParkedRows: (input: { owner: string; notes: Array<{ qitemId: string; jobId: string; note: string }> }) =>
          repoOf().noteParkedRows(input.owner, input.notes),
      } as never);
    const f = fixture();
    let firstRepo!: QueueRepository;
    const realFirst = queueOnlyDeliver(f, () => firstRepo);
    let interrupted: Buffer | undefined;
    // The first process delivers, then its accounting is lost: the store is kept as it was right after the delivery.
    const first = scheduled({ ...f, deliver: (async (...args: Parameters<typeof realFirst>) => {
      const result = await realFirst(...args);
      interrupted ??= f.db.serialize();
      return result;
    }) as typeof realFirst });
    firstRepo = first.repo;
    const a = await first.park("A's wait");
    updateWatchdogJob(first.jobs, a.jobId, { message: "first text" });
    first.due(a.jobId);
    await first.scheduler.runTickNow();
    expect(interrupted).toBeDefined();
    const g = fixture(interrupted);
    let nextRepo!: QueueRepository;
    const next = scheduled({ ...g, deliver: queueOnlyDeliver(g, () => nextRepo) });
    nextRepo = next.repo;
    updateWatchdogJob(next.jobs, a.jobId, { message: "second text" });
    next.due(a.jobId);
    await next.scheduler.runTickNow();
    const recorded = next.repo.listTransitions(a.qitemId).map(t => t.transitionNote ?? "")
      .filter(n => n.includes(`park wake noted on this row: watchdog ${a.jobId}`));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain("reminder: first text");
    expect(recorded[0]).not.toContain("second text");
    expect(next.history.listForJob(a.jobId, 1)[0]).toMatchObject({ deliveryStatus: "noted_on_parked_row" });
  });

  it("a cold row is recorded as queued_as_row with its id in the outbox receipt, the history and the fired event, never ok", async () => {
    const { f, s, operatorReminder, tick } = queueOnly();
    const job = operatorReminder();
    await tick(job.jobId);
    expect(f.pastes).toEqual([]);
    expect(f.submissions).toEqual([]);
    const last = s.history.listForJob(job.jobId, 1)[0]!;
    expect(last).toMatchObject({ outcome: "sent", deliveryStatus: "queued_as_row",
      evaluationNotes: expect.objectContaining({ deliveryCode: "queued_as_row" }) });
    expect(last.evaluationNotes).not.toHaveProperty("deliveryFact");
    const qitemId = (last.evaluationNotes as { queuedQitemId: string }).queuedQitemId;
    expect(s.repo.getById(qitemId)).toMatchObject({ destinationSession: seat, sourceSession: "watchdog@system", state: "pending",
      tags: expect.arrayContaining(["watchdog", "queue-only", `watchdog-job:${job.jobId}`]) });
    expect(s.repo.getById(qitemId)!.body).toContain("check your rows");
    // No wake: the cold row waits for a person or the seat's next turn.
    expect(s.repo.getById(qitemId)!.lastNudgeAttempt ?? null).toBeNull();
    expect(f.db.prepare("SELECT count(*) AS n FROM outbox_entries WHERE outbox_id NOT LIKE 'watchdog-occurrence-%'").get()).toEqual({ n: 0 });
    const receipt = f.db.prepare("SELECT delivery_state, guard_delivery FROM outbox_entries WHERE outbox_id LIKE 'watchdog-occurrence-%'").get() as { delivery_state: string; guard_delivery: string };
    expect(receipt.delivery_state).toBe("delivered");
    expect(JSON.parse(receipt.guard_delivery).watchdog).toMatchObject({ queueOnly: { code: "queued_as_row", qitemId } });
    const fired = (f.db.prepare("SELECT payload FROM events WHERE type = 'watchdog.evaluation_fired'").all() as Array<{ payload: string }>)
      .map(e => JSON.parse(e.payload)).filter(e => e.jobId === job.jobId);
    expect(fired.at(-1)).toMatchObject({ deliveryStatus: "queued_as_row", queuedQitemId: qitemId });
  });

  it("the delivery writes the note on the rows it found: a job rescheduled while it delivers keeps the note, written once", async () => {
    let edit: (() => void) | undefined;
    const { f, s, wdRows, notes, tick } = queueOnly({ afterResolve: () => edit?.() });
    const a = await s.park("A's wait");
    const job = s.jobs.getByIdOrThrow(a.jobId);
    edit = () => { edit = undefined; s.jobs.updateSchedule(a.jobId, job.specYaml, job.intervalSeconds * 2, job.lastEvaluationAt); };
    await tick(a.jobId);
    expect(notes(a.qitemId, a.jobId)).toHaveLength(1);
    expect(s.history.listForJob(a.jobId, 1)[0]).toMatchObject({ outcome: "sent", deliveryStatus: "noted_on_parked_row" });
    expect(wdRows()).toEqual([]);
    expect(f.submissions).toEqual([]);
  });

  it("a parked row the delivery can no longer note leaves the occurrence owed, with nothing typed", async () => {
    let unpark: ((rows: string[]) => void) | undefined;
    let seen: string[] | undefined;
    const { f, s, wdRows, notes, tick } = queueOnly({ afterResolve: rows => unpark?.(rows) });
    const a = await s.park("A's wait");
    // Recorded here, asserted after the delivery: an assertion inside it would itself fail the delivery.
    unpark = rows => {
      unpark = undefined;
      seen = rows;
      s.repo.update({ qitemId: a.qitemId, actorSession: seat, state: "in-progress", transitionNote: "resumed" } as never);
    };
    await tick(a.jobId);
    expect(seen).toEqual([a.qitemId]);
    expect(s.repo.getById(a.qitemId)!.state).toBe("in-progress");
    expect(notes(a.qitemId, a.jobId)).toEqual([]);
    const last = s.history.listForJob(a.jobId, 1)[0]!;
    expect(last).toMatchObject({ outcome: "failed", deliveryStatus: "failed", evaluationNotes: expect.objectContaining({ deliveryInputPhase: "not_reached" }) });
    const receipt = f.db.prepare("SELECT delivery_state FROM outbox_entries WHERE outbox_id LIKE 'watchdog-occurrence-%'").get() as { delivery_state: string };
    expect(receipt.delivery_state).toBe("failed");
    expect(wdRows()).toEqual([]);
    expect(f.submissions).toEqual([]);
  });

  it("a wait noted on its row is held at the seat: the stuck sweep doesn't report it unconsumed; the same wait typed and unanswered still is", async () => {
    const { s, parkWith, tick, f } = queueOnly();
    const r = await parkWith("long wait", { wakeAfterSeconds: 600, wakeMaxSeconds: 2400 });
    await tick(r.jobId);
    // The notice and everything on the row are older than the pickup grace (fixture aging of existing facts).
    const old = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    f.db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(old(240), r.qitemId);
    const aged = JSON.parse(s.jobs.getByIdOrThrow(r.jobId).specYaml);
    expect(aged.context.queue_wait.notice.deliveryStatus).toBe("noted_on_parked_row");
    aged.context.queue_wait.notice.at = old(180);
    f.db.prepare("UPDATE watchdog_jobs SET spec_yaml = ? WHERE job_id = ?").run(JSON.stringify(aged), r.jobId);
    const sweep = () => runStuckSweep({ db: f.db, queueRepo: s.repo, status: createStuckSweepStatus(), unclaimedAgeMinutes: 60, log: () => {},
      isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null } as never);
    const findings = () => (f.db.prepare("SELECT tags FROM queue_items WHERE tags LIKE ?").all(`%stuck-sweep:unconsumed-wait:${r.qitemId}%`) as unknown[]).length;
    await sweep();
    expect(findings()).toBe(0);
    // The control: the same notice as a typed seat records it.
    const spec = JSON.parse(s.jobs.getByIdOrThrow(r.jobId).specYaml);
    spec.context.queue_wait.notice.deliveryStatus = "ok";
    f.db.prepare("UPDATE watchdog_jobs SET spec_yaml = ? WHERE job_id = ?").run(JSON.stringify(spec), r.jobId);
    await sweep();
    expect(findings()).toBe(1);
  });

  it("a wait noted on its row shows its timer as the next backstop, not an unconsumed-notice finding the sweep won't file; a typed notice still does", async () => {
    const { s, parkWith, tick, f } = queueOnly();
    const r = await parkWith("long wait", { wakeAfterSeconds: 600, wakeMaxSeconds: 2400 });
    await tick(r.jobId);
    expect(JSON.parse(s.jobs.getByIdOrThrow(r.jobId).specYaml).context.queue_wait.notice.deliveryStatus).toBe("noted_on_parked_row");
    expect(s.repo.waitingView(r.qitemId)!.nextBackstop).toMatchObject({ owner: seat, mechanism: `watchdog:${r.jobId}`, dueAt: expect.any(String) });
    // The control: the same notice as a typed seat records it is still promised to the stuck sweep.
    const spec = JSON.parse(s.jobs.getByIdOrThrow(r.jobId).specYaml);
    spec.context.queue_wait.notice.deliveryStatus = "ok";
    f.db.prepare("UPDATE watchdog_jobs SET spec_yaml = ? WHERE job_id = ?").run(JSON.stringify(spec), r.jobId);
    expect(s.repo.waitingView(r.qitemId)!.nextBackstop.mechanism).toBe("unconsumed wait notice; delivery=ok");
  });

  it("a pending cold row shows no stuck-sweep backstop it won't get; once claimed, the pickup check applies as for any row", async () => {
    const { s, wdRows, operatorReminder, tick } = queueOnly();
    const job = operatorReminder();
    await tick(job.jobId);
    const [row] = wdRows();
    expect(s.repo.getById(row!.qitem_id)!.state).toBe("pending");
    expect(s.repo.waitingView(row!.qitem_id)!.nextBackstop).toMatchObject({ owner: seat, dueAt: null, intervalSeconds: null,
      mechanism: "none (queue-only reminder row: it waits for someone to pick it up or for the agent's next ordinary turn; no timed sweep)" });
    s.repo.claim({ qitemId: row!.qitem_id, destinationSession: seat });
    expect(s.repo.waitingView(row!.qitem_id)!.nextBackstop.mechanism).toBe("queue-stuck-sweep:pickup (activity checked at detection)");
  });

  it("a parked-owner reminder reaching a seat that turned queue-only after the policy decided is held: no cold row, no note, nothing typed", async () => {
    const sends = vi.fn().mockResolvedValue({ ok: true });
    const createQueueRow = vi.fn(async (row: Row) => ({ qitemId: row.qitemId, state: "pending" }));
    const noteQueuedRow = vi.fn(() => "qitem-watchdog-earlier");
    const resolveParkedRows = vi.fn(() => ["qitem-parked"]);
    const noteParkedRows = vi.fn(() => ["qitem-parked"]);
    const deliver = makeWatchdogDeliver({ sessionTransport: { send: sends }, isQueueOnlySeat: () => true,
      createQueueRow, noteQueuedRow, resolveParkedRows, noteParkedRows } as never);
    const held = await deliver({ targetSession: seat, message: "You have parked work." },
      { jobId: "parked-owner-job", policy: PARKED_OWNER_POLICY_NAME, occurrenceId: "o-po" });
    expect(held).toMatchObject({ status: "retained" });
    expect(held).not.toHaveProperty("code");
    for (const write of [sends, createQueueRow, noteQueuedRow, resolveParkedRows, noteParkedRows]) expect(write).not.toHaveBeenCalled();
  });

  it("an occurrence whose every derived row id is a closed row creates nothing and types nothing; it stays owed", async () => {
    const sends = vi.fn();
    const tried: string[] = [];
    const deliver = makeWatchdogDeliver({ sessionTransport: { send: sends }, isQueueOnlySeat: () => true,
      createQueueRow: async (row: Row) => { tried.push(row.qitemId); return { qitemId: row.qitemId, state: "done" }; } } as never);
    const result = await deliver({ targetSession: seat, message: "Check the deploy." }, { jobId: "full", policy: "periodic-reminder", occurrenceId: "o-full" });
    expect(result).toMatchObject({ status: "failed", sent: false, inputPhase: "not_reached" });
    expect(result.error).toContain(`${tried[0]}-100`);
    expect(tried).toHaveLength(100);
    expect(new Set(tried).size).toBe(100);
    expect(tried.at(-1)).toBe(`${tried[0]}-100`);
    expect(sends).not.toHaveBeenCalled();
  });

  it("a later occurrence is noted on the cold row only while it's open, checked in the same write as the note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-only-note-"));
    const file = join(dir, "q.db");
    const db = new Database(file);
    migrate(db, ALL_MIGRATIONS);
    const other = new Database(file, { timeout: 0 });
    cleanup.push(async () => { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) } as never);
    const row = await repo.create({ qitemId: "qitem-watchdog-cold", sourceSession: "watchdog@system", destinationSession: seat, body: "reminder",
      summary: "reminder", tags: ["watchdog", "queue-only", "watchdog-job:j"], nudge: false } as never);
    // The seat closes the row from another connection right as the note is being written.
    const real = repo.getById.bind(repo);
    let race: "closed" | "kept-out" | null = null;
    vi.spyOn(repo, "getById").mockImplementation(((id: string, o?: never) => {
      if (race === null && id === row.qitemId) {
        try {
          other.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(id);
          race = "closed";
        } catch { race = "kept-out"; }
      }
      return real(id, o);
    }) as never);
    const noted = repo.noteOpenWatchdogRow("j", seat, "again");
    const hasNote = repo.listTransitions(row.qitemId).some(t => t.transitionNote === "again");
    // Never a note on a row the seat had already closed.
    expect(race === "closed" && hasNote).toBe(false);
    expect(noted === row.qitemId).toBe(hasNote);
  });

  // A restart between the occurrence's claim and its queue write (#3418 review, point 2): the occurrence isn't ended. Its
  // own row is its delivery; without one it's delivered again under the same id. Nothing is typed either way.
  it("a park's one-shot wake whose note a restart interrupted is noted on its row after the restart, not spent", async () => {
    let saved: Buffer | undefined;
    let first!: ReturnType<typeof queueOnly>;
    first = queueOnly({ beforeNote: () => { saved ??= first.f.db.serialize(); } });
    const a = await first.s.park("A's wait");
    await first.tick(a.jobId);
    expect(saved).toBeDefined();
    const next = queueOnly({ saved });
    expect(next.notes(a.qitemId, a.jobId)).toHaveLength(0);
    await next.tick(a.jobId);
    expect(next.notes(a.qitemId, a.jobId)).toHaveLength(1);
    expect(next.s.history.listForJob(a.jobId, 1)[0]).toMatchObject({ outcome: "sent", deliveryStatus: "noted_on_parked_row" });
    expect(next.s.jobs.getByIdOrThrow(a.jobId).state).toBe("terminal");
    expect(next.f.submissions).toEqual([]);
  });

  it("a cold row a restart interrupted before its write is created after the restart under the occurrence's id, never typed", async () => {
    let saved: Buffer | undefined;
    let first!: ReturnType<typeof queueOnly>;
    first = queueOnly({ beforeCreate: () => { saved ??= first.f.db.serialize(); } });
    const job = first.operatorReminder();
    await first.tick(job.jobId);
    expect(saved).toBeDefined();
    const next = queueOnly({ saved });
    expect(next.wdRows()).toEqual([]);
    await next.tick(job.jobId);
    const rows = next.wdRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qitem_id).toMatch(/^qitem-watchdog-/);
    expect(next.s.history.listForJob(job.jobId, 1)[0]).toMatchObject({ outcome: "sent", deliveryStatus: "queued_as_row" });
    expect(next.f.submissions).toEqual([]);
  });

  it("a recovery stopped between its finalize and its queue receipt keeps the row pointer when it runs again", async () => {
    let saved: Buffer | undefined;
    let first!: ReturnType<typeof queueOnly>;
    first = queueOnly({ afterCreate: () => { saved ??= first.f.db.serialize(); } });
    const job = first.operatorReminder();
    await first.tick(job.jobId);
    expect(saved).toBeDefined();
    const next = queueOnly({ saved });
    const written = next.wdRows();
    expect(written).toHaveLength(1);
    // The recovery stops right after its finalize, before the queue receipt is saved.
    const real = next.f.outbox.finalizeDelivery.bind(next.f.outbox);
    let stop = true;
    vi.spyOn(next.f.outbox, "finalizeDelivery").mockImplementation(((id: string, state: never) => {
      const result = real(id, state);
      if (stop) { stop = false; throw new Error("recovery stopped after its finalize"); }
      return result;
    }) as never);
    await next.tick(job.jobId);
    await next.tick(job.jobId);
    expect(next.wdRows()).toEqual(written);
    expect(next.s.history.listForJob(job.jobId, 1)[0]).toMatchObject({ outcome: "skipped", skipReason: "delivery_receipt_reconciled",
      deliveryStatus: "queued_as_row" });
    const receipt = next.f.db.prepare("SELECT delivery_state, guard_delivery FROM outbox_entries WHERE outbox_id LIKE 'watchdog-occurrence-%'").get() as
      { delivery_state: string; guard_delivery: string };
    expect(receipt.delivery_state).toBe("delivered");
    expect(JSON.parse(receipt.guard_delivery).watchdog).toMatchObject({ queueOnly: { code: "queued_as_row", qitemId: written[0]!.qitem_id } });
    expect(next.f.submissions).toEqual([]);
  });

  it("a cold row written just before a restart is recorded as the occurrence's row after it, with no second row", async () => {
    let saved: Buffer | undefined;
    let first!: ReturnType<typeof queueOnly>;
    first = queueOnly({ afterCreate: () => { saved ??= first.f.db.serialize(); } });
    const job = first.operatorReminder();
    await first.tick(job.jobId);
    expect(saved).toBeDefined();
    const next = queueOnly({ saved });
    const written = next.wdRows();
    expect(written).toHaveLength(1);
    await next.tick(job.jobId);
    expect(next.wdRows()).toEqual(written);
    // The delivery happened before the restart: the engine records the reconciled receipt, as for any other occurrence.
    expect(next.s.history.listForJob(job.jobId, 1)[0]).toMatchObject({ outcome: "skipped", skipReason: "delivery_receipt_reconciled",
      deliveryStatus: "queued_as_row" });
    const receipt = next.f.db.prepare("SELECT delivery_state, guard_delivery FROM outbox_entries WHERE outbox_id LIKE 'watchdog-occurrence-%'").get() as
      { delivery_state: string; guard_delivery: string };
    expect(receipt.delivery_state).toBe("delivered");
    expect(JSON.parse(receipt.guard_delivery).watchdog).toMatchObject({ queueOnly: { code: "queued_as_row", qitemId: written[0]!.qitem_id } });
    expect(next.f.submissions).toEqual([]);
  });
});
