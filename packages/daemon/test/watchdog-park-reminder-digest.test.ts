// Due parked-row reminders for one seat, through the daemon's own composition: `createDaemon`'s scheduler, policy
// engine and watchdog delivery, down to the session transport's `send`, which is the only stub. Timers are made due by
// moving their recorded start back in the store; nothing fires at a live seat.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDaemon } from "../src/startup.js";
import type { AppDeps } from "../src/server.js";
import type { CmuxTransportFactory } from "../src/terminal/cmux-transport.js";
import type { ExecFn } from "../src/domain/tmux-adapter.js";

let db: Database.Database;
let deps: AppDeps;
let scratch: string;
const savedEnv: Record<string, string | undefined> = {};
const sends: Array<{ session: string; text: string }> = [];
/** What the stubbed transport answers next. */
let reply: () => Record<string, unknown> = () => ({ ok: true, verified: true });

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "park-digest-"));
  for (const k of ["OPENRIG_HOME", "OPENRIG_DB", "OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_NO_KERNEL"]) savedEnv[k] = process.env[k];
  process.env.OPENRIG_HOME = path.join(scratch, "home");
  process.env.OPENRIG_DB = path.join(scratch, "daemon.sqlite");
  delete process.env.OPENRIG_URL;
  delete process.env.OPENRIG_PORT;
  process.env.OPENRIG_NO_KERNEL = "1";
  const cmuxFactory: CmuxTransportFactory = async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); };
  const tmuxExec: ExecFn = async () => "";
  const result = await createDaemon({ cmuxFactory, tmuxExec, dbPath: process.env.OPENRIG_DB! });
  db = result.db;
  deps = result.deps;
  vi.spyOn(deps.sessionTransport, "send").mockImplementation(async (session: string, text: string) => {
    sends.push({ session, text });
    return { sessionName: session, ...reply() } as never;
  });
}, 60000);

afterAll(() => {
  deps?.watchdogScheduler?.stop?.();
  db?.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => { sends.length = 0; reply = () => ({ ok: true, verified: true }); });

let seq = 0;
/** A seat in a real rig, so the queue accepts it as a destination. */
function seat(): string {
  const rigName = `digest${++seq}`;
  const rig = deps.rigRepo.createRig(rigName);
  const node = deps.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
  const session = `dev-impl@${rigName}`;
  deps.sessionRegistry.registerSession(node.id, session);
  return session;
}

/** A row parked by its owner with an ordinary `--wake-after` timer; returns the row and its timer's job id. */
async function park(owner: string, summary: string, wakeAfterSeconds = 600) {
  const row = await deps.queueRepo.create({ sourceSession: "orch@rig", destinationSession: owner, body: `work ${++seq}`, summary, nudge: false } as never) as unknown as { qitemId: string };
  deps.queueRepo.update({ qitemId: row.qitemId, actorSession: owner, state: "blocked", blockedOn: "external:wait",
    transitionNote: "parked", wakeAfterSeconds } as never);
  const jobId = deps.queueRepo.getParkWakeStatus(row.qitemId)!.ref;
  return { qitemId: row.qitemId, jobId };
}

/** Make a timer due now, as though its interval had passed. */
function due(jobId: string) {
  const past = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare("UPDATE watchdog_jobs SET last_evaluation_at = ?, registered_at = ? WHERE job_id = ?").run(past, past, jobId);
}

/** What each job's own record shows after a pass: its state, its latest history, and its row's wake receipt. */
function disposition(jobId: string, qitemId: string) {
  const job = deps.watchdogJobsRepo!.getByIdOrThrow(jobId);
  const [history] = deps.watchdogHistoryLog!.listForJob(jobId, 1);
  const wake = deps.queueRepo.getParkWakeStatus(qitemId);
  return {
    state: job.state, terminalReason: job.terminalReason ?? null,
    outcome: history?.outcome ?? null, deliveryStatus: history?.deliveryStatus ?? null, skipReason: history?.skipReason ?? null,
    wakePhase: wake?.phase ?? null, wakeDelivery: (wake as { deliveryStatus?: string } | null)?.deliveryStatus ?? null,
    rowState: deps.queueRepo.getById(qitemId)?.state,
  };
}

describe("due parked-row reminders for one seat", () => {
  it("arrive as one message per scheduler pass, naming every row", async () => {
    const owner = seat();
    const rows = [await park(owner, "first wait"), await park(owner, "second wait"), await park(owner, "third wait")];
    for (const r of rows) due(r.jobId);
    await deps.watchdogScheduler!.runTickNow();
    const toOwner = sends.filter((s) => s.session === owner);
    expect(toOwner).toHaveLength(1);
    for (const r of rows) expect(toOwner[0]!.text).toContain(r.qitemId);
    for (const summary of ["first wait", "second wait", "third wait"]) expect(toOwner[0]!.text).toContain(summary);
    // Every member keeps its own record of the one attempt, and its one-shot timer retires as before.
    for (const r of rows) {
      expect(disposition(r.jobId, r.qitemId)).toMatchObject({
        state: "terminal", terminalReason: "park_timer_fired_once", outcome: "sent", deliveryStatus: "ok",
        wakePhase: "fired", rowState: "blocked",
      });
      const [history] = deps.watchdogHistoryLog!.listForJob(r.jobId, 1);
      expect(history!.evaluationNotes).toMatchObject({ digestMemberJobIds: rows.map((x) => x.jobId) });
    }
    // Nothing is sent again on the next pass.
    await deps.watchdogScheduler!.runTickNow();
    expect(sends.filter((s) => s.session === owner)).toHaveLength(1);
  });

  it("keeps another seat's reminders apart", async () => {
    const a = seat();
    const b = seat();
    const rows = [await park(a, "a1"), await park(b, "b1"), await park(a, "a2"), await park(b, "b2")];
    for (const r of rows) due(r.jobId);
    await deps.watchdogScheduler!.runTickNow();
    expect(sends.map((s) => s.session).sort()).toEqual([a, b].sort());
    expect(sends.find((s) => s.session === a)!.text).toContain(rows[0]!.qitemId);
    expect(sends.find((s) => s.session === a)!.text).not.toContain(rows[1]!.qitemId);
  });

  it("leaves a reminder that isn't due pending, and sends it when it falls due in a later pass", async () => {
    const owner = seat();
    const [first, second, later] = [await park(owner, "one"), await park(owner, "two"), await park(owner, "later")];
    due(first!.jobId);
    due(second!.jobId);
    await deps.watchdogScheduler!.runTickNow();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).not.toContain(later!.qitemId);
    expect(deps.watchdogJobsRepo!.getByIdOrThrow(later!.jobId).state).toBe("active");
    due(later!.jobId);
    await deps.watchdogScheduler!.runTickNow();
    expect(sends).toHaveLength(2);
    expect(sends[1]!.text).toBe(`[OpenRig watchdog scheduler · policy: periodic-reminder · job: ${later!.jobId}]\n`
      + `Wake timer fired for parked qitem ${later!.qitemId}. Resume the recorded continuation and update the row.`);
  });

  it("sends a lone reminder exactly as before", async () => {
    const owner = seat();
    const only = await park(owner, "alone");
    due(only.jobId);
    await deps.watchdogScheduler!.runTickNow();
    expect(sends).toEqual([{ session: owner, text: `[OpenRig watchdog scheduler · policy: periodic-reminder · job: ${only.jobId}]\n`
      + `Wake timer fired for parked qitem ${only.qitemId}. Resume the recorded continuation and update the row.` }]);
    expect(disposition(only.jobId, only.qitemId)).toMatchObject({ state: "terminal", terminalReason: "park_timer_fired_once", deliveryStatus: "ok" });
  });

  it("keeps a custom-message timer's own send, and leaves stale and generation-bound jobs to their existing dispositions", async () => {
    const owner = seat();
    const [a, b] = [await park(owner, "a"), await park(owner, "b")];
    // A custom instruction is never merged into a digest.
    const custom = await deps.queueRepo.create({ sourceSession: "orch@rig", destinationSession: owner, body: "custom", nudge: false } as never) as unknown as { qitemId: string };
    deps.queueRepo.update({ qitemId: custom.qitemId, actorSession: owner, state: "blocked", blockedOn: "external:wait",
      transitionNote: "parked", wakeAfterSeconds: 600, wakeMessage: "Check the release notes first." } as never);
    const customJob = deps.queueRepo.getParkWakeStatus(custom.qitemId)!.ref;
    // Legacy residue: a timer whose row has already left its park, with nothing left to retire it.
    const stale = await park(owner, "stale");
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(stale.qitemId);
    // A reminder armed for an earlier occupant of the seat.
    const bound = deps.watchdogJobsRepo!.register({
      policy: "periodic-reminder", targetSession: owner, intervalSeconds: 600, registeredBySession: owner,
      specYaml: `policy: periodic-reminder\ntarget:\n  session: ${JSON.stringify(owner)}\nmessage: "for the previous occupant"\n`,
      targetGenerationUuid: "an-earlier-occupant",
    } as never);
    expect(deps.sessionRegistry.currentOccupantGenerationForSession(owner)).not.toBeNull();
    for (const jobId of [a.jobId, b.jobId, customJob, stale.jobId, bound.jobId]) due(jobId);
    await deps.watchdogScheduler!.runTickNow();
    const texts = sends.filter((s) => s.session === owner).map((s) => s.text);
    expect(texts).toHaveLength(2);
    expect(texts.filter((t) => t.includes(a.qitemId) && t.includes(b.qitemId))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("Check the release notes first.") && !t.includes(a.qitemId))).toHaveLength(1);
    expect(texts.join("\n")).not.toContain(stale.qitemId);
    expect(texts.join("\n")).not.toContain("for the previous occupant");
    expect(deps.watchdogJobsRepo!.getByIdOrThrow(stale.jobId)).toMatchObject({ state: "terminal", terminalReason: "park_timer_target_terminal" });
    expect(deps.watchdogHistoryLog!.listForJob(bound.jobId, 1)[0]).toMatchObject({ outcome: "skipped", skipReason: "target_generation_mismatch" });
  });

  it.each([
    ["delivered", () => ({ ok: true, verified: true })],
    ["failed", () => ({ ok: false, error: "pane gone" })],
    ["uncertain (it timed out)", () => ({ ok: false, error: "timeout: send-keys did not return" })],
    ["retained by the typing guard", () => ({ ok: true, outcome: "retained", outboxIds: ["guard-1"] })],
  ])("accounts a digest that was %s to every member exactly as a lone reminder's own attempt", async (_label, answer) => {
    reply = answer as never;
    const alone = seat();
    const lone = await park(alone, "alone");
    due(lone.jobId);
    await deps.watchdogScheduler!.runTickNow();
    const expected = disposition(lone.jobId, lone.qitemId);
    const owner = seat();
    const rows = [await park(owner, "x"), await park(owner, "y")];
    for (const r of rows) due(r.jobId);
    await deps.watchdogScheduler!.runTickNow();
    expect(sends.filter((s) => s.session === owner)).toHaveLength(1);
    for (const r of rows) expect(disposition(r.jobId, r.qitemId)).toEqual(expected);
    // The one attempt is never replayed whole by the next pass.
    await deps.watchdogScheduler!.runTickNow();
    expect(sends.filter((s) => s.session === owner)).toHaveLength(1);
  });
});
