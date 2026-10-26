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
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "../src/domain/watchdog-scheduler.js";
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";
import { makeWorkflowKeepalivePolicy } from "../src/domain/policies/workflow-keepalive.js";
import { makeIdleGateQitemPolicy } from "../src/domain/policies/idle-gate-qitem.js";

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
  return { db, outbox, deliver, transport, submissions, pastes, hooks, setInput: (text: string) => { body = text; }, enable: () => guard.set("a", { mode: "draft-aware" }, "human@test", "keep draft") };
}

const seat = "worker@test";

/** The queue, watchdog engine and scheduler on a fixture's store, wired as the daemon wires them. `withoutPreview`
 *  leaves out the park-entry lookup, so wakes go with their stored message, as a daemon before the preview sent them. */
function scheduled(f: ReturnType<typeof fixture>, { withoutPreview = false } = {}) {
  const bus = new EventBus(f.db);
  const repo = new QueueRepository(f.db, bus, { transport: f.transport as never, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(f.outbox);
  const jobs = new WatchdogJobsRepository(f.db);
  repo.attachWatchdogJobsRepository(jobs);
  const history = new WatchdogHistoryLog(f.db);
  const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: bus, deliver: f.deliver,
    resolvePreDeliveryTerminalReason: ({ jobId }) => repo.resolveWatchdogPreDeliveryTerminalReason(jobId),
    onWakeAttempt: ({ jobId, deliveryStatus }) => repo.recordWatchdogWakeAttempt(jobId, deliveryStatus),
    ...(withoutPreview ? {} : { resolveDigestEntry: ({ jobId, message }: { jobId: string; message: string }) => repo.parkReminderDigestEntry(jobId, message) }),
  });
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
