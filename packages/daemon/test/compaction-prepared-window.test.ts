// #2682: a managed compaction whose restore map is complete must not ask the seat to prepare again. Before this fix,
// a /compact refused at the window (a draft in the input box, a guard refusal, a pane stuck in a tmux mode, or the idle
// grace running out) stopped the attempt; ten minutes later the next sample above the threshold began a fresh attempt and
// sent a fresh preparation request, over and over. In the reported case one seat got 12 attempts in 2h50, 8 of them with
// a published map that ended before their deadline.
//
// Real SessionTransport over a real TmuxAdapter whose tmux commands are recorded instead of run: the input box is a real
// composer frame, a draft in it is what the adapter reads, and a /compact counts only when it was pasted (the adapter's
// paste-buffer), never when the fake merely recorded a refused call. No tmux server, no Claude Code.
import Database from "better-sqlite3";
import stringWidth from "string-width";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import {
  ClaudeCompactionEnforcer, AUTO_PREP_WAIT_MS_DEFAULT, AUTO_RETRY_AFTER_STOP_MS_DEFAULT, COMPACTION_RECORD_FILE,
  RESTART_RECOVERY_WINDOW_MS_DEFAULT,
} from "../src/domain/claude-compaction-enforcer.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { DeliveryGuardError, SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { CAPTURE_READABLE_BUDGET_MS, SessionTransport } from "../src/domain/session-transport.js";
import { TerminalPolicyRefusal } from "../src/domain/terminal-policy.js";

const seat = "worker@test";
const PREP_TEXT = "automatic compaction preparation is now required";
/** The loop of the issue: six retry intervals, the sample rising from 52% to 73% over a 50% threshold. */
const CYCLES = 6;
const usage = (i: number) => 52 + Math.round((i * (73 - 52)) / CYCLES);
const sample = (usedPercentage: number) => ({ sessionName: seat, runtime: "claude-code", usedPercentage });

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

function frame(body: string): ComposerSnapshot {
  return { screen: ["Ready", "────────────────────", `❯ ${body}`, "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(body), y: 2, width: 100000, height: 60 }, inMode: false };
}

type Refusal = "draft" | "guard" | "pane" | "terminal-policy" | "uncertain" | null;

async function fixture() {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','claude-code');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  // One clock for the enforcer, the transport's waits and Date.now.
  let clock = 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  let body = "", staged = "", paneInMode = false;
  const writes: string[] = [];
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("paste-buffer")) { writes.push(`paste:${staged}`); body += staged; }
    if (command.includes("send-keys") && command.includes("Enter")) { writes.push("enter"); body = ""; }
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/compact-input", bufferName: () => "compact-input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async () => [{ id: "%1" } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async () => frame(body));
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async () => frame(body).screen);
  vi.spyOn(tmux, "getPaneCursorPosition").mockImplementation(async () => frame(body).cursor);
  vi.spyOn(tmux, "isPaneInMode").mockImplementation(async () => paneInMode);
  vi.spyOn(tmux, "cancelPaneMode").mockImplementation(async () => ({ ok: false, message: "fixture: the pane stays in its mode" }) as never);
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    sleep: async (ms) => { clock += ms; }, now: () => new Date(clock), waitForIdlePollMs: 5 });
  let activity = "idle";
  (transport as any).classifySendReadiness = async () => ({ state: activity, reason: "fixture", evidenceSource: "pane_heuristic" });
  (transport as any).claudeDeliveryObservation = async () => ({ state: "unknown", detail: "fixture" });
  await guard.set("a", { mode: "off" }, "human@test", "fixture input policy");
  const home = mkdtempSync(join(tmpdir(), "compaction-prepared-window-"));
  let generation = "g1";
  let terminalRefuses = false;
  const terminalPolicies = { check: () => { if (terminalRefuses) throw new TerminalPolicyRefusal("openrig" as never, "compaction" as never); } };
  const policy = { enabled: true, thresholdPercent: 50, preCompactInstruction: "Write a restore map.", compactInstruction: "", messageInline: "", messageFilePath: "", postRestoreAuditInstruction: "", preparationRoot: "" };
  const settings = { resolveClaudeCompactionPolicy: () => policy };
  // A daemon process: a restarted one shares the instance home, the seat and the clock, and nothing held in memory.
  const daemon = (instance = randomUUID()) => new ClaudeCompactionEnforcer(settings as any, transport, {
    openrigHome: home, daemonInstance: instance, now: () => clock, sleep: async (ms) => { clock += ms; }, compactSendIdleWaitMs: 20,
    resolveOccupantGeneration: () => generation, terminalPolicies: terminalPolicies as any });
  const e = daemon();
  cleanup.push(async () => { await transport.guardedDelivery?.stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  // How the window is refused at the /compact send. The refusal is momentary, as in the issue: someone types into the box
  // while the seat is between turns and submits a moment later, so the next preparation request (if one is wrongly sent)
  // reaches an empty box.
  let refusal: Refusal = null;
  const compactSendOpts: any[] = [];
  const realSend = transport.send.bind(transport);
  vi.spyOn(transport, "send").mockImplementation(async (s: string, text: string, opts?: any) => {
    if (!text.startsWith("/compact") || refusal === null) {
      if (text.startsWith("/compact")) compactSendOpts.push(opts);
      return realSend(s, text, opts);
    }
    compactSendOpts.push(opts);
    if (refusal === "guard") throw new DeliveryGuardError("draft_input_busy", "The seat has an unsubmitted input.");
    if (refusal === "uncertain") return { ok: false, sessionName: s, sent: true, inputPhase: "written", reason: "submit_failed" } as any;
    if (refusal === "terminal-policy") terminalRefuses = true;
    if (refusal === "draft") body = "a message the operator is still typing";
    if (refusal === "pane") paneInMode = true;
    try { return await realSend(s, text, opts); }
    finally { body = ""; paneInMode = false; terminalRefuses = false; }
  });
  const stageMap = (enforcer = e) => {
    const a = enforcer.getPreparationState(seat)!; mkdirSync(dirname(a.mapPath), { recursive: true });
    writeFileSync(a.mapPath + ".tmp", `# Restore map\nCurrent work and next step.\n${a.marker}\n`);
  };
  const record = (enforcer = e) => JSON.parse(readFileSync(join(dirname(enforcer.getPreparationState(seat)!.mapPath), COMPACTION_RECORD_FILE), "utf8"));
  return {
    e, daemon, transport, tmux, writes, policy, stageMap, record, compactSendOpts,
    /** Preparation requests that reached the box (pasted). */
    prepRequests: () => writes.filter((w) => w.startsWith("paste:") && w.includes(PREP_TEXT)).length,
    /** /compact commands that reached the box (pasted), never a refused call the fake recorded. */
    compactPastes: () => writes.filter((w) => w.startsWith("paste:/compact")).length,
    body: () => body,
    draft: (text: string) => { body = text; },
    refuse: (r: Refusal) => { refusal = r; },
    activity: (s: string) => { activity = s; },
    generation: (g: string) => { generation = g; },
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** The preparation request goes in, the seat publishes its map, and the first /compact is refused the given way. */
async function preparedBy(f: F, refusal: Exclude<Refusal, null>) {
  expect(await f.e.maybeAutoCompact(sample(52))).toEqual({ triggered: true });
  expect(f.prepRequests()).toBe(1);
  f.stageMap();
  f.refuse(refusal);
  expect(await f.e.maybeAutoCompact(sample(52))).toMatchObject({ triggered: false });
  return f.e.getPreparationState(seat)!.attemptId;
}

/** CYCLES retry intervals; each one writes the current attempt's map (as the seat would, if asked) and polls twice. */
async function loop(f: F, attemptId: string) {
  const ids = new Set([attemptId]);
  for (let i = 1; i <= CYCLES; i++) {
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    f.e.reconcilePreparations();
    await f.e.maybeAutoCompact(sample(usage(i)));
    ids.add(f.e.getPreparationState(seat)!.attemptId);
    f.stageMap();
    await f.e.maybeAutoCompact(sample(usage(i)));
    ids.add(f.e.getPreparationState(seat)!.attemptId);
  }
  return ids;
}

function expectPrepared(f: F, attemptId: string, enforcer = f.e) {
  const state = enforcer.getPreparationState(seat)!;
  expect(state).toMatchObject({ attemptId, status: "waiting", compact: "not_sent", prepared: true });
  expect(Number.isFinite(state.preparedAt)).toBe(true);
  // A held attempt keeps its deadline (the /compact still waits for idle) but shows no expired idle deadline.
  expect(Number.isFinite(state.deadlineAt)).toBe(true);
  expect(state.idleDeadlineAt).toBeUndefined();
  const record = f.record(enforcer);
  expect(record).toMatchObject({ attemptId, phase: "preparing", prepared: true });
  expect(Number.isFinite(record.preparedAt)).toBe(true);
}

describe("#2682: a completed map holds its attempt until the window", () => {
  // Case 1
  it("case 1: a draft in the box at each /compact keeps one attempt and one preparation request through six retry intervals", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    const ids = await loop(f, attemptId);
    expect(f.prepRequests()).toBe(1);
    expect(f.compactPastes()).toBe(0);
    expect([...ids]).toEqual([attemptId]);
    expectPrepared(f, attemptId);
    expect(f.record().preparedReason).toMatch(/^draft_input_/);
  });

  // Case 2
  it.each(["guard", "pane"] as const)("case 2: a %s refusal at the /compact holds the same way", async (refusal) => {
    const f = await fixture();
    const attemptId = await preparedBy(f, refusal);
    // Held at once, for its own refusal (not later, by the idle grace running out).
    expectPrepared(f, attemptId);
    expect(f.record().preparedReason).toBe(refusal === "guard" ? "draft_input_busy" : "pane_in_mode");
    const ids = await loop(f, attemptId);
    expect(f.prepRequests()).toBe(1);
    expect(f.compactPastes()).toBe(0);
    expect([...ids]).toEqual([attemptId]);
    expectPrepared(f, attemptId);
  });

  // Case 3
  it("case 3: a map completed while the seat never goes idle is held past the idle grace, not stopped", async () => {
    const f = await fixture();
    expect(await f.e.maybeAutoCompact(sample(52))).toEqual({ triggered: true });
    f.stageMap();
    f.activity("running");
    expect(await f.e.maybeAutoCompact(sample(52))).toEqual({ triggered: false, reason: "waiting_for_idle" });
    const attemptId = f.e.getPreparationState(seat)!.attemptId;
    f.advance(AUTO_PREP_WAIT_MS_DEFAULT + AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    f.e.reconcilePreparations();
    expectPrepared(f, attemptId);
    const ids = await loop(f, attemptId);
    expect(f.prepRequests()).toBe(1);
    expect(f.compactPastes()).toBe(0);
    expect([...ids]).toEqual([attemptId]);
    expectPrepared(f, attemptId);
  });

  // Case 4
  it("case 4: after more than an hour held, an idle seat with an empty box gets exactly one /compact with no new request, waiting a full idle read", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    await loop(f, attemptId);
    f.advance(60_000);
    expect(f.now() - 10_000).toBeGreaterThan(60 * 60_000);
    f.refuse(null);
    f.compactSendOpts.length = 0;
    expect(await f.e.maybeAutoCompact(sample(73))).toEqual({ triggered: true });
    expect(f.compactPastes()).toBe(1);
    expect(f.prepRequests()).toBe(1);
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "compact-sent", compact: "submitted_unconfirmed" });
    // No cap from the expired deadline: the send waits a full readable idle observation.
    expect(f.compactSendOpts).toHaveLength(1);
    expect(f.compactSendOpts[0].waitForIdleMs).toBeGreaterThanOrEqual(CAPTURE_READABLE_BUDGET_MS);
    expect(f.compactSendOpts[0].readinessFromPaneOnly).toBe(true);
  });

  // Case 5
  it("case 5: a fresh sample below the threshold closes the window (the stale drain included) and a sample back above reopens it with the same map", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    f.refuse(null);
    f.advance(60_000);
    await f.e.maybeAutoCompact(sample(30));
    expect(f.compactPastes()).toBe(0);
    expectPrepared(f, attemptId);
    // The monitor's drain for an idle seat whose sample went stale.
    await f.e.drainPendingPreparedCompact({ sessionName: seat, runtime: "claude-code" });
    expect(f.compactPastes()).toBe(0);
    expectPrepared(f, attemptId);
    f.advance(60_000);
    expect(await f.e.maybeAutoCompact(sample(60))).toEqual({ triggered: true });
    expect(f.compactPastes()).toBe(1);
    expect(f.prepRequests()).toBe(1);
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "compact-sent" });
  });

  // Case 6
  it("case 6: a real draft in the box at the window is never typed over, and the attempt stays prepared", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    f.refuse(null);
    f.draft("half a sentence");
    for (let i = 0; i < 3; i++) {
      f.advance(30_000);
      expect(await f.e.maybeAutoCompact(sample(60))).toMatchObject({ triggered: false });
    }
    expect(f.body()).toBe("half a sentence");
    expect(f.compactPastes()).toBe(0);
    expect(f.prepRequests()).toBe(1);
    expectPrepared(f, attemptId);
  });

  // Case 7
  it("case 7: a new occupant generation ends the held attempt as stale_generation; after the cooldown a fresh attempt begins", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    f.refuse(null);
    f.generation("g2");
    f.e.reconcilePreparations();
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", reason: "stale_generation" });
    expect(f.compactPastes()).toBe(0);
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    await f.e.maybeAutoCompact(sample(60));
    const fresh = f.e.getPreparationState(seat)!;
    expect(fresh.attemptId).not.toBe(attemptId);
    expect(fresh.status).not.toBe("stopped");
    expect(f.prepRequests()).toBe(2);
    expect(f.compactPastes()).toBe(0);
  });

  // Case 8a
  it("case 8a: a restarted daemon resumes a held attempt of the same occupant recorded more than 6 h ago, with no new request", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    const { preparedAt, preparedReason } = f.e.getPreparationState(seat) as any;
    f.refuse(null);
    f.advance(RESTART_RECOVERY_WINDOW_MS_DEFAULT + 60_000);
    const restarted = f.daemon();
    f.draft("still typing");
    await restarted.maybeAutoCompact(sample(60));
    expect(f.prepRequests()).toBe(1);
    expect(f.compactPastes()).toBe(0);
    expectPrepared(f, attemptId, restarted);
    // The same hold, picked up from the record, not a new one.
    expect(restarted.getPreparationState(seat)).toMatchObject({ preparedAt, preparedReason });
    f.draft("");
    f.advance(30_000);
    expect(await restarted.maybeAutoCompact(sample(60))).toEqual({ triggered: true });
    expect(f.compactPastes()).toBe(1);
    expect(f.prepRequests()).toBe(1);
    expect(restarted.getPreparationState(seat)).toMatchObject({ attemptId, status: "compact-sent" });
  });

  // Case 8b
  it("case 8b: a held attempt whose /compact send had begun is resumed at the turn boundary, never sending /compact again", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    f.refuse(null);
    // A crash between the paste and its receipt: the record says the send had begun.
    const file = join(dirname(f.e.getPreparationState(seat)!.mapPath), COMPACTION_RECORD_FILE);
    const record = JSON.parse(readFileSync(file, "utf8"));
    expect(record).toMatchObject({ attemptId, prepared: true });
    writeFileSync(file, `${JSON.stringify({ ...record, compactSending: true })}\n`);
    f.advance(60_000);
    const restarted = f.daemon();
    expect(restarted.hasPendingPostCompactStage(seat, { cwd: null, runtime: "claude-code" })).toBe(true);
    expect(restarted.getOwedRestore(seat)?.stage).toBe("turn_boundary");
    for (let i = 0; i < 3; i++) { f.advance(30_000); await restarted.maybeAutoCompact(sample(60)); }
    expect(f.compactPastes()).toBe(0);
    expect(f.prepRequests()).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ attemptId, uncertainCompact: true });
  });

  // Case 10
  it("case 10: the drain for a stale sample sends the held attempt's /compact at an idle seat with an empty box", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    f.refuse(null);
    f.advance(15 * 60_000);
    expect(await f.e.drainPendingPreparedCompact({ sessionName: seat, runtime: "claude-code" })).toEqual({ triggered: true });
    expect(f.compactPastes()).toBe(1);
    expect(f.prepRequests()).toBe(1);
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "compact-sent" });
  });

  // Case 11
  it("case 11: a manual compaction over a held attempt is already_in_progress, and --cancel disarms it for good", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    f.refuse(null);
    f.advance(AUTO_PREP_WAIT_MS_DEFAULT + AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    expect(await f.e.triggerManualCompact(sample(60), { operatorInitiated: true })).toMatchObject({ triggered: false, reason: "already_in_progress" });
    expect(f.compactPastes()).toBe(0);
    expect(f.e.cancelPreparation(seat)).toMatchObject({ attemptId, status: "stopped" });
    for (let i = 0; i < 2; i++) {
      f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
      await f.e.maybeAutoCompact(sample(70));
    }
    expect(f.compactPastes()).toBe(0);
    expect(f.prepRequests()).toBe(1);
  });
});

// Case 9: what this fix must leave as it is. Each one stops as before.
describe("#2682: what still stops", () => {
  it("case 9a: a terminal policy refusal at the /compact stops the attempt", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "terminal-policy");
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", compact: "not_sent" });
    expect(f.e.getPreparationState(seat)!.reason).toMatch(/^terminal_policy_/);
    expect(f.compactPastes()).toBe(0);
  });

  it("case 9b: a /compact whose outcome was lost stops as uncertain and is never sent again", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "uncertain");
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", compact: "uncertain" });
    f.refuse(null);
    const sends = f.compactSendOpts.length;
    for (let i = 0; i < 3; i++) { f.advance(30_000); await f.e.maybeAutoCompact(sample(60)); }
    expect(f.compactSendOpts.length).toBe(sends);
    expect(f.compactPastes()).toBe(0);
  });

  it("case 9c: an attempt with no map stops as preparation_incomplete, and a new request follows the cooldown as before", async () => {
    const f = await fixture();
    expect(await f.e.maybeAutoCompact(sample(52))).toEqual({ triggered: true });
    const attemptId = f.e.getPreparationState(seat)!.attemptId;
    f.advance(AUTO_PREP_WAIT_MS_DEFAULT + 1);
    f.e.reconcilePreparations();
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", reason: "preparation_incomplete" });
    expect(f.e.getPreparationState(seat)).not.toMatchObject({ prepared: true });
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    expect(await f.e.maybeAutoCompact(sample(60))).toEqual({ triggered: true });
    expect(f.prepRequests()).toBe(2);
    expect(f.e.getPreparationState(seat)!.attemptId).not.toBe(attemptId);
  });

  it("case 9d: a manual compaction whose /compact meets a draft stops as before", async () => {
    const f = await fixture();
    const send = f.transport.send as unknown as { mock: unknown };
    expect(send.mock).toBeDefined();
    let staged = false;
    (f.transport.send as any).mockImplementationOnce(async (s: string, text: string, opts?: any) => {
      const r = await (f.transport as any).constructor.prototype.send.call(f.transport, s, text, opts);
      if (!staged) { staged = true; f.stageMap(); }
      return r;
    });
    f.refuse("draft");
    const outcome = await f.e.triggerManualCompact(sample(40), { operatorInitiated: true });
    expect(outcome).toMatchObject({ triggered: false, reason: "draft_input_busy" });
    expect(f.e.getPreparationState(seat)).toMatchObject({ mode: "manual", status: "stopped" });
    expect(f.compactPastes()).toBe(0);
  });

  it("case 9f: a preparation request held on every try stops as before, never held, and a fresh attempt follows the cooldown", async () => {
    const f = await fixture();
    f.draft("half a sentence");
    for (let i = 0; i < 3; i++) { await f.e.maybeAutoCompact(sample(52)); f.advance(30_000); }
    const stopped = f.e.getPreparationState(seat)!;
    expect(stopped).toMatchObject({ status: "stopped", delivery: "not_sent" });
    expect(stopped).not.toMatchObject({ prepared: true });
    expect(f.prepRequests()).toBe(0);
    f.draft("");
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    expect(await f.e.maybeAutoCompact(sample(60))).toEqual({ triggered: true });
    expect(f.e.getPreparationState(seat)!.attemptId).not.toBe(stopped.attemptId);
    expect(f.prepRequests()).toBe(1);
  });

  it("case 9e: a preparation request held by a draft is not sent and goes again on the next poll, as before", async () => {
    const f = await fixture();
    f.draft("half a sentence");
    expect(await f.e.maybeAutoCompact(sample(52))).toMatchObject({ triggered: false });
    expect(f.e.getPreparationState(seat)).toMatchObject({ status: "sending", delivery: "not_sent" });
    expect(f.prepRequests()).toBe(0);
    f.draft("");
    expect(await f.e.maybeAutoCompact(sample(52))).toEqual({ triggered: true });
    expect(f.e.getPreparationState(seat)).toMatchObject({ status: "waiting", delivery: "delivered" });
    expect(f.prepRequests()).toBe(1);
  });
});
