// #2682: a managed compaction whose restore map is complete must not ask the seat to prepare again. Before this fix,
// a /compact refused at the window (a draft in the input box, a guard refusal, a pane stuck in a tmux mode, or the idle
// grace running out) stopped the attempt; ten minutes later the next sample above the threshold began a fresh attempt and
// sent a fresh preparation request, over and over. In the reported case one seat got 12 attempts in 2h50, 8 of them with
// a published map that ended before their deadline.
//
// The hold has ends. A fresh sample below the threshold ends a held attempt; a held map retires after a large jump in usage
// since it was ready, or after a long while; a held map that stops reading ready stops the attempt. After an attempt ends
// with its request delivered, a fresh automatic preparation for the same occupant and conversation waits for an idle seat,
// across a daemon restart too.
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
/** How far usage may rise past the map before it is retired, and how old a held map may get. Constants, not settings. */
const MAP_MAX_GROWTH = 15;
const MAP_MAX_AGE_MS = 2 * 60 * 60_000;
/** The held loops stay inside both: at most 12 points over the map's 52% (52 to 64), and well under two hours. */
const usage = (i: number) => 52 + Math.round((i * (64 - 52)) / CYCLES);
const sample = (usedPercentage: number | null, opts: { sessionId?: string } = {}) =>
  ({ sessionName: seat, runtime: "claude-code", usedPercentage, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) });

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
  let onPaste: ((text: string) => void) | null = null;
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("paste-buffer")) { writes.push(`paste:${staged}`); body += staged; onPaste?.(staged); }
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
  /** A held map that stops reading ready: the final file and its .tmp are gone (for example after a git clean), or the
   *  final file stays but is rewritten without its marker line, with no .tmp. */
  const unstageMap = (enforcer = e, how: "gone" | "marker" = "gone") => {
    const a = enforcer.getPreparationState(seat)!;
    rmSync(a.mapPath + ".tmp", { force: true });
    if (how === "gone") rmSync(a.mapPath, { force: true });
    else writeFileSync(a.mapPath, "# Restore map\nCurrent work and next step.\n");
  };
  /** The record's path, kept so it can be read after a restart, when no daemon holds the attempt any more. */
  const recordPath = (enforcer = e) => join(dirname(enforcer.getPreparationState(seat)!.mapPath), COMPACTION_RECORD_FILE);
  const readRecord = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  const record = (enforcer = e) => readRecord(recordPath(enforcer));
  return {
    e, daemon, transport, tmux, guard, writes, policy, stageMap, unstageMap, record, recordPath, readRecord, compactSendOpts,
    onPaste: (fn: ((text: string) => void) | null) => { onPaste = fn; },
    /** The /compact commands that reached the box. */
    compactTexts: () => writes.filter((w) => w.startsWith("paste:/compact")),
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
    expect(await f.e.maybeAutoCompact(sample(64))).toEqual({ triggered: true });
    expect(f.compactPastes()).toBe(1);
    expect(f.prepRequests()).toBe(1);
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "compact-sent", compact: "submitted_unconfirmed" });
    // No cap from the expired deadline: the send waits a full readable idle observation.
    expect(f.compactSendOpts).toHaveLength(1);
    expect(f.compactSendOpts[0].waitForIdleMs).toBeGreaterThanOrEqual(CAPTURE_READABLE_BUDGET_MS);
    expect(f.compactSendOpts[0].readinessFromPaneOnly).toBe(true);
  });

  // Case 5
  it("case 5: a fresh sample below the threshold ends a held attempt with no /compact; after the cooldown a busy seat waits and an idle seat gets a fresh request", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    f.refuse(null);
    f.advance(60_000);
    await f.e.maybeAutoCompact(sample(30));
    const ended = f.e.getPreparationState(seat)!;
    expect(ended).toMatchObject({ attemptId, status: "stopped", reason: "below_threshold_while_prepared", compact: "not_sent" });
    expect(ended.prepared).toBeUndefined();
    expect(f.record()).toMatchObject({ attemptId, phase: "ended", reason: "below_threshold_while_prepared" });
    expect(f.compactPastes()).toBe(0);
    // The monitor's drain for a stale sample has nothing to send.
    expect(await f.e.drainPendingPreparedCompact({ sessionName: seat, runtime: "claude-code" })).toEqual({ triggered: false, reason: "no_pending_stage" });
    // Back above the threshold inside the cooldown: nothing yet.
    f.advance(60_000);
    expect(await f.e.maybeAutoCompact(sample(60))).toEqual({ triggered: false, reason: "preparation_stopped" });
    expect(f.prepRequests()).toBe(1);
    // After the cooldown, at a busy seat: still nothing, the ended attempt's request was delivered.
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    f.activity("running");
    expect(await f.e.maybeAutoCompact(sample(60))).toEqual({ triggered: false, reason: "waiting_for_idle" });
    expect(f.prepRequests()).toBe(1);
    // Then at an idle seat: a fresh attempt and a fresh request (the context compacted and filled again).
    f.activity("idle");
    expect(await f.e.maybeAutoCompact(sample(60))).toEqual({ triggered: true });
    expect(f.e.getPreparationState(seat)!.attemptId).not.toBe(attemptId);
    expect(f.prepRequests()).toBe(2);
    expect(f.compactPastes()).toBe(0);
  });

  // Case 5b
  it.each(["a draft at the stale drain", "the idle grace running out"] as const)(
    "case 5b: an attempt whose context dropped before it was held is never held (%s); it stops as before", async (how) => {
      const f = await fixture();
      expect(await f.e.maybeAutoCompact(sample(52))).toEqual({ triggered: true });
      f.stageMap();
      const attemptId = f.e.getPreparationState(seat)!.attemptId;
      expect(await f.e.maybeAutoCompact(sample(30))).toEqual({ triggered: false, reason: "below_threshold" });
      expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "waiting" });
      if (how === "a draft at the stale drain") {
        f.refuse("draft");
        await f.e.drainPendingPreparedCompact({ sessionName: seat, runtime: "claude-code" });
        expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", compact: "not_sent" });
        expect(f.e.getPreparationState(seat)!.reason).toMatch(/^draft_input_/);
      } else {
        f.activity("running");
        f.advance(AUTO_PREP_WAIT_MS_DEFAULT + AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
        f.e.reconcilePreparations();
        expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", reason: "map_complete_seat_never_idle" });
      }
      expect(f.e.getPreparationState(seat)!.prepared).toBeUndefined();
      expect(f.record()).toMatchObject({ attemptId, phase: "ended" });
      expect(f.record().prepared).toBeUndefined();
      expect(f.compactPastes()).toBe(0);
      expect(f.prepRequests()).toBe(1);
    });

  // Case 5c
  it("case 5c: a stale or unknown sample, or the drain, never ends a held attempt", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    f.advance(60_000);
    expect(await f.e.maybeAutoCompact(sample(null))).toEqual({ triggered: false, reason: "no_usage_data" });
    expectPrepared(f, attemptId);
    f.advance(15 * 60_000);
    expect(await f.e.drainPendingPreparedCompact({ sessionName: seat, runtime: "claude-code" })).toMatchObject({ triggered: false });
    expectPrepared(f, attemptId);
    expect(f.prepRequests()).toBe(1);
    expect(f.compactPastes()).toBe(0);
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
  it("case 8a: a held map retired after more than 6 h stays retired across a restart: no request to a busy seat, a fresh one at an idle seat", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    const file = f.recordPath();
    f.refuse(null);
    f.activity("running");
    f.advance(RESTART_RECOVERY_WINDOW_MS_DEFAULT + 60_000);
    f.e.reconcilePreparations();
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", reason: "prepared_map_stale" });
    expect(f.readRecord(file)).toMatchObject({ attemptId, phase: "ended", reason: "prepared_map_stale", delivery: "delivered" });
    expect(Number.isFinite(f.readRecord(file).endedAt)).toBe(true);
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    const restarted = f.daemon();
    for (let i = 0; i < 2; i++) {
      expect(await restarted.maybeAutoCompact(sample(60))).toMatchObject({ triggered: false });
      f.advance(30_000);
    }
    expect(f.prepRequests()).toBe(1);
    expect(f.compactPastes()).toBe(0);
    f.activity("idle");
    expect(await restarted.maybeAutoCompact(sample(60))).toEqual({ triggered: true });
    expect(f.prepRequests()).toBe(2);
    expect(f.compactPastes()).toBe(0);
    expect(restarted.getPreparationState(seat)!.attemptId).not.toBe(attemptId);
  });

  // Case 8a'
  it("case 8a': a restarted daemon resumes a held attempt of the same occupant held 45 min ago, with no new request and the same hold", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    const { preparedAt, preparedReason } = f.e.getPreparationState(seat) as any;
    f.refuse(null);
    f.advance(45 * 60_000);
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

  // Case 8c
  it("case 8c: a held record more than 6 h old is picked up by a restarted daemon and retired at once; no request to a busy seat, one at an idle seat", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    const file = f.recordPath();
    f.refuse(null);
    f.activity("running");
    // The daemon that held it is gone before it could look again.
    f.advance(RESTART_RECOVERY_WINDOW_MS_DEFAULT + 60_000);
    const restarted = f.daemon();
    expect(await restarted.maybeAutoCompact(sample(60))).toMatchObject({ triggered: false });
    expect(f.readRecord(file)).toMatchObject({ attemptId, phase: "ended", reason: "prepared_map_stale" });
    expect(f.prepRequests()).toBe(1);
    expect(f.compactPastes()).toBe(0);
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    expect(await restarted.maybeAutoCompact(sample(60))).toMatchObject({ triggered: false });
    expect(f.prepRequests()).toBe(1);
    f.activity("idle");
    expect(await restarted.maybeAutoCompact(sample(60))).toEqual({ triggered: true });
    expect(f.prepRequests()).toBe(2);
    expect(f.compactPastes()).toBe(0);
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

describe("#2682: a held map retires when it falls behind", () => {
  it("a held map retires once usage has risen 15 points since it was ready: 14 points still hold, 15 end it with no /compact", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    expect(f.record().mapUsedPercentage).toBe(52);
    f.advance(60_000);
    await f.e.maybeAutoCompact(sample(52 + MAP_MAX_GROWTH - 1));
    expectPrepared(f, attemptId);
    f.advance(60_000);
    await f.e.maybeAutoCompact(sample(52 + MAP_MAX_GROWTH));
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", reason: "prepared_map_stale", compact: "not_sent" });
    expect(f.e.getPreparationState(seat)!.prepared).toBeUndefined();
    expect(f.compactPastes()).toBe(0);
    expect(f.prepRequests()).toBe(1);
  });

  it("a held map's growth counts from the fresh usage its request was delivered at, not from a later round with the map ready", async () => {
    const f = await fixture();
    expect(await f.e.maybeAutoCompact(sample(52))).toEqual({ triggered: true });
    f.stageMap();
    const attemptId = f.e.getPreparationState(seat)!.attemptId;
    // A first round with the map ready, at a busy seat, and then the hold by a draft, both at 58%.
    f.activity("running");
    expect(await f.e.maybeAutoCompact(sample(58))).toEqual({ triggered: false, reason: "waiting_for_idle" });
    f.activity("idle");
    f.refuse("draft");
    f.advance(30_000);
    expect(await f.e.maybeAutoCompact(sample(58))).toMatchObject({ triggered: false });
    expectPrepared(f, attemptId);
    expect(f.record().mapUsedPercentage).toBe(52);
    f.advance(60_000);
    await f.e.maybeAutoCompact(sample(52 + MAP_MAX_GROWTH - 1));
    expectPrepared(f, attemptId);
    f.advance(60_000);
    await f.e.maybeAutoCompact(sample(52 + MAP_MAX_GROWTH));
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", reason: "prepared_map_stale", compact: "not_sent" });
    expect(f.compactPastes()).toBe(0);
    expect(f.prepRequests()).toBe(1);
  });

  it("a held map retires two hours after it was ready, counted from when the map was ready rather than from the hold", async () => {
    const f = await fixture();
    expect(await f.e.maybeAutoCompact(sample(52))).toEqual({ triggered: true });
    f.stageMap();
    f.activity("running");
    expect(await f.e.maybeAutoCompact(sample(52))).toEqual({ triggered: false, reason: "waiting_for_idle" });
    const attemptId = f.e.getPreparationState(seat)!.attemptId;
    // Held only when the idle grace runs out, well after the map was ready.
    f.advance(AUTO_PREP_WAIT_MS_DEFAULT + AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    f.e.reconcilePreparations();
    expectPrepared(f, attemptId);
    const { mapReadyAt, preparedAt } = f.record();
    expect(Number.isFinite(mapReadyAt)).toBe(true);
    expect(preparedAt - mapReadyAt).toBeGreaterThan(30 * 60_000);
    f.advance(mapReadyAt + MAP_MAX_AGE_MS - 1 - f.now());
    f.e.reconcilePreparations();
    expectPrepared(f, attemptId);
    // Exactly two hours after it was ready: retired.
    f.advance(1);
    expect(f.now()).toBe(mapReadyAt + MAP_MAX_AGE_MS);
    f.e.reconcilePreparations();
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", reason: "prepared_map_stale" });
    expect(f.e.getPreparationState(seat)!.prepared).toBeUndefined();
    expect(f.compactPastes()).toBe(0);
  });

  it("after a held map retires, an idle seat gets a fresh request with a new map, and /compact never goes out with the retired one", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    f.refuse(null);
    f.advance(60_000);
    // A window is open now, but the map is behind: no /compact with it.
    await f.e.maybeAutoCompact(sample(52 + MAP_MAX_GROWTH));
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", reason: "prepared_map_stale" });
    expect(f.compactPastes()).toBe(0);
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    expect(await f.e.maybeAutoCompact(sample(52 + MAP_MAX_GROWTH))).toEqual({ triggered: true });
    const fresh = f.e.getPreparationState(seat)!;
    expect(fresh.attemptId).not.toBe(attemptId);
    expect(f.prepRequests()).toBe(2);
    f.stageMap();
    expect(await f.e.maybeAutoCompact(sample(52 + MAP_MAX_GROWTH))).toEqual({ triggered: true });
    expect(f.compactPastes()).toBe(1);
    expect(f.compactTexts().some((t) => t.includes(attemptId))).toBe(false);
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId: fresh.attemptId, status: "compact-sent" });
  });

  it("a map first seen ready by the stale-sample drain and held there, with no fresh sample at all, still retires two hours after it was ready", async () => {
    const f = await fixture();
    expect(await f.e.maybeAutoCompact(sample(52))).toEqual({ triggered: true });
    f.stageMap();
    f.activity("running");
    expect(await f.e.drainPendingPreparedCompact({ sessionName: seat, runtime: "claude-code" })).toMatchObject({ triggered: false });
    const attemptId = f.e.getPreparationState(seat)!.attemptId;
    f.advance(20 * 60_000);
    f.activity("idle");
    f.refuse("draft");
    await f.e.drainPendingPreparedCompact({ sessionName: seat, runtime: "claude-code" });
    expectPrepared(f, attemptId);
    const { mapReadyAt, preparedAt } = f.record();
    expect(Number.isFinite(mapReadyAt)).toBe(true);
    expect(preparedAt - mapReadyAt).toBeGreaterThanOrEqual(20 * 60_000);
    f.advance(mapReadyAt + MAP_MAX_AGE_MS - 1 - f.now());
    f.e.reconcilePreparations();
    expectPrepared(f, attemptId);
    // Exactly two hours after it was ready: retired.
    f.advance(1);
    expect(f.now()).toBe(mapReadyAt + MAP_MAX_AGE_MS);
    f.e.reconcilePreparations();
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", reason: "prepared_map_stale" });
    expect(f.compactPastes()).toBe(0);
  });

  it("a held map coming of age while its /compact is being written does not stop it: the /compact completes and its restore is owed", async () => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    f.refuse(null);
    // Another seat's poll reconciles while this /compact is mid-write, past the map's age.
    f.onPaste((text) => {
      if (!text.startsWith("/compact")) return;
      f.advance(MAP_MAX_AGE_MS + 60_000);
      f.e.reconcilePreparations();
    });
    expect(await f.e.maybeAutoCompact(sample(60))).toEqual({ triggered: true });
    f.onPaste(null);
    expect(f.compactPastes()).toBe(1);
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "compact-sent" });
    expect(f.e.getOwedRestore(seat)?.stage).toBe("turn_boundary");
    expect(f.prepRequests()).toBe(1);
  });
});

describe("#2682: a held map that stops reading ready", () => {
  it.each([["the map file and its .tmp are gone", "gone"], ["the map file stays but its marker is gone", "marker"]] as const)(
    "a held attempt whose map stops reading ready (%s) stops as preparation_incomplete at the next reconcile, and no longer reads as prepared", async (_label, how) => {
    const f = await fixture();
    const attemptId = await preparedBy(f, "draft");
    f.unstageMap(f.e, how);
    f.e.reconcilePreparations();
    const state = f.e.getPreparationState(seat)!;
    expect(state).toMatchObject({ attemptId, status: "stopped", reason: "preparation_incomplete" });
    expect(state.prepared).toBeUndefined();
    expect(f.record()).toMatchObject({ attemptId, phase: "ended", reason: "preparation_incomplete" });
    expect(f.compactPastes()).toBe(0);
  });
});

/** An automatic attempt whose request was delivered and which ended with no map at its deadline. */
async function endedDelivered(f: F, sessionId = "conversation-one") {
  expect(await f.e.maybeAutoCompact(sample(52, { sessionId }))).toEqual({ triggered: true });
  const attemptId = f.e.getPreparationState(seat)!.attemptId;
  const file = f.recordPath();
  f.advance(AUTO_PREP_WAIT_MS_DEFAULT + 1);
  f.e.reconcilePreparations();
  expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped", reason: "preparation_incomplete", delivery: "delivered" });
  expect(f.prepRequests()).toBe(1);
  return { attemptId, file };
}

describe("#2682: no new request to a busy seat after an ended attempt", () => {
  it("an ended attempt on a busy seat past the cooldown gets no fresh request, and stays visible", async () => {
    const f = await fixture();
    const { attemptId } = await endedDelivered(f);
    f.activity("running");
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    for (let i = 0; i < 3; i++) {
      expect(await f.e.maybeAutoCompact(sample(60, { sessionId: "conversation-one" }))).toEqual({ triggered: false, reason: "waiting_for_idle" });
      f.advance(30_000);
    }
    expect(f.prepRequests()).toBe(1);
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped" });
  });

  it("an ended attempt, then a restart, then a busy seat: no fresh request; the record keeps when it ended, its delivery and its conversation", async () => {
    const f = await fixture();
    const { attemptId, file } = await endedDelivered(f);
    const ended = f.readRecord(file);
    expect(ended).toMatchObject({ attemptId, phase: "ended", delivery: "delivered", sessionId: "conversation-one" });
    expect(Number.isFinite(ended.endedAt)).toBe(true);
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    const restarted = f.daemon();
    f.activity("running");
    for (let i = 0; i < 2; i++) {
      expect(await restarted.maybeAutoCompact(sample(60, { sessionId: "conversation-one" }))).toMatchObject({ triggered: false });
      f.advance(30_000);
    }
    expect(f.prepRequests()).toBe(1);
  });

  it.each(["in the same daemon", "after a restart"] as const)("a later idle window %s gets one fresh request with a new attempt", async (where) => {
    const f = await fixture();
    const { attemptId } = await endedDelivered(f);
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    const e = where === "after a restart" ? f.daemon() : f.e;
    f.activity("running");
    expect(await e.maybeAutoCompact(sample(60, { sessionId: "conversation-one" }))).toMatchObject({ triggered: false });
    expect(f.prepRequests()).toBe(1);
    f.activity("idle");
    f.advance(30_000);
    expect(await e.maybeAutoCompact(sample(60, { sessionId: "conversation-one" }))).toEqual({ triggered: true });
    expect(f.prepRequests()).toBe(2);
    expect(e.getPreparationState(seat)!.attemptId).not.toBe(attemptId);
    expect(f.compactPastes()).toBe(0);
  });

  it("another conversation on the same busy seat (after a /clear) gets its request as before", async () => {
    const f = await fixture();
    await endedDelivered(f, "conversation-one");
    f.activity("running");
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    expect(await f.e.maybeAutoCompact(sample(60, { sessionId: "conversation-two" }))).toEqual({ triggered: true });
    expect(f.prepRequests()).toBe(2);
  });

  it("an attempt whose request never reached the seat (not sent) does not hold a busy seat off: the request goes as before", async () => {
    const f = await fixture();
    f.draft("half a sentence");
    for (let i = 0; i < 3; i++) { await f.e.maybeAutoCompact(sample(52)); f.advance(30_000); }
    expect(f.e.getPreparationState(seat)).toMatchObject({ status: "stopped", delivery: "not_sent" });
    f.draft("");
    f.activity("running");
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    expect(await f.e.maybeAutoCompact(sample(60))).toEqual({ triggered: true });
    expect(f.prepRequests()).toBe(1);
  });

  it("an ended attempt held off on a busy seat can still be cancelled, and a cancel keeps automatic compaction off once the seat is idle", async () => {
    const f = await fixture();
    const { attemptId } = await endedDelivered(f);
    f.activity("running");
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    expect(await f.e.maybeAutoCompact(sample(60))).toMatchObject({ triggered: false });
    expect(f.e.cancelPreparation(seat)).toMatchObject({ attemptId, status: "stopped" });
    f.activity("idle");
    for (let i = 0; i < 2; i++) {
      f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
      await f.e.maybeAutoCompact(sample(60));
    }
    expect(f.prepRequests()).toBe(1);
  });

  it.each(["in the same daemon", "after a restart"] as const)(
    "an ended attempt past the restart recovery window no longer holds a busy seat off (%s): it gets its request", async (where) => {
      const f = await fixture();
      const { attemptId } = await endedDelivered(f);
      f.activity("running");
      f.advance(RESTART_RECOVERY_WINDOW_MS_DEFAULT + 60_000);
      const e = where === "after a restart" ? f.daemon() : f.e;
      expect(await e.maybeAutoCompact(sample(60, { sessionId: "conversation-one" }))).toEqual({ triggered: true });
      expect(f.prepRequests()).toBe(2);
      expect(e.getPreparationState(seat)!.attemptId).not.toBe(attemptId);
      expect(f.compactPastes()).toBe(0);
    });

  it("a restart inside the cooldown does not ask an idle seat at once; after the cooldown it does", async () => {
    const f = await fixture();
    await endedDelivered(f);
    f.advance(60_000);
    const restarted = f.daemon();
    expect(await restarted.maybeAutoCompact(sample(60, { sessionId: "conversation-one" }))).toMatchObject({ triggered: false });
    expect(f.prepRequests()).toBe(1);
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT);
    expect(await restarted.maybeAutoCompact(sample(60, { sessionId: "conversation-one" }))).toEqual({ triggered: true });
    expect(f.prepRequests()).toBe(2);
  });

  it.each(["throws", "reads the seat as needing input"] as const)("an idle check that %s counts as busy: waiting_for_idle, with no new attempt", async (how) => {
    const f = await fixture();
    const { attemptId } = await endedDelivered(f);
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    const wait = vi.spyOn(f.transport, "waitUntilIdle");
    if (how === "throws") wait.mockRejectedValueOnce(new Error("pane read failed"));
    else wait.mockResolvedValueOnce({ ok: false, reason: "target_needs_input", error: "fixture", activity: {} as any, waitedMs: 0, attempts: 1 } as any);
    expect(await f.e.maybeAutoCompact(sample(60))).toEqual({ triggered: false, reason: "waiting_for_idle" });
    expect(f.prepRequests()).toBe(1);
    expect(f.e.getPreparationState(seat)).toMatchObject({ attemptId, status: "stopped" });
  });

  it("the idle check for an ended attempt runs outside the seat's delivery lease, so a peer's send is never held behind it", async () => {
    const f = await fixture();
    await endedDelivered(f);
    f.activity("running");
    f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT + 1);
    const guard = f.transport.deliveryGuard!;
    let leases = 0;
    const real = guard.lifecycle.bind(guard);
    vi.spyOn(guard, "lifecycle").mockImplementation(async (ids: any, fn: any) => {
      leases++;
      try { return await real(ids, fn); } finally { leases--; }
    });
    const heldDuringWait: number[] = [];
    const realWait = f.transport.waitUntilIdle.bind(f.transport);
    vi.spyOn(f.transport, "waitUntilIdle").mockImplementation(async (...args: Parameters<typeof realWait>) => {
      heldDuringWait.push(leases);
      return realWait(...args);
    });
    expect(await f.e.maybeAutoCompact(sample(60))).toEqual({ triggered: false, reason: "waiting_for_idle" });
    expect(heldDuringWait.length).toBeGreaterThan(0);
    expect(heldDuringWait.every((n) => n === 0)).toBe(true);
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
