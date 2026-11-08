// The parked route reads its obligation face with QueueRepository.listOpenObligations (qitem id, state and summary)
// instead of a full list() that derives pickup, waiting view and delivery ledger for every row it never shows.
// The response must be the same, byte for byte, as the one the full list() produced. Real queue, rig, session and
// identity repositories on a full test DB; the only difference between the two apps is the obligation reader.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { activityRoutes } from "../src/routes/activity.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";

const RIG = "park-rig";
const IDLE = "dev-impl@park-rig";      // idle at its prompt: parked whenever it owes work
const UNKNOWN = "dev-qa@park-rig";     // no activity evidence: indeterminate
const STOPPED = "dev-ops@park-rig";    // idle evidence, but its session is confirmed missing
const ALIAS = "dev-old@park-rig";      // an earlier address of IDLE, resolved by resolveSessionAddresses

describe("GET /api/activity/parked reads the obligation face without the full list()", () => {
  let db: Database.Database;
  let queue: QueueRepository;
  let jobs: WatchdogJobsRepository;
  let history: WatchdogHistoryLog;
  let oracle: SeatActivityService;
  let clock = 0;

  beforeEach(() => {
    db = createFullTestDb();
    db.exec(watchdogHistorySchema.sql); // the full test DB doesn't include the engine's audit table
    db.exec(queueItemSummarySchema.sql); // nor the summary column, which the obligation face carries
    const rigRepo = new RigRepository(db);
    const sessions = new SessionRegistry(db);
    const rig = rigRepo.createRig(RIG);
    rigRepo.createRig("empty-rig");
    const now = Date.parse("2026-11-07T09:00:00.000Z");
    oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3, now: () => new Date(now) });
    for (const [logicalId, session] of [["dev.impl", IDLE], ["dev.qa", UNKNOWN], ["dev.ops", STOPPED]] as const) {
      const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
      const registered = sessions.registerSession(node.id, session);
      sessions.updateStatus(registered.id, "running");
      if (session === UNKNOWN) continue;
      oracle.declareRungInventory({ seatNodeId: node.id, sessionName: session }, {
        adapterId: "claude-code-adapter", runtime: "claude-code",
        rungs: [{ rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" }],
      });
      oracle.reportEvidence({ seatNodeId: node.id, sessionName: session, rung: "window-sampling",
        sourceId: "tmux:window-activity", seq: 1, observedAt: new Date(now).toISOString(), activity: "idle-at-prompt" });
      if (session === STOPPED) {
        sessions.updateBinding(node.id, { tmuxSession: session, tmuxPane: "%7", attachmentType: "tmux" } as never);
        new SeatIdentityStore(db).upsert({
          nodeId: node.id, sessionName: session, verdict: "pane_missing", reason: "session_missing", evidenceSource: "tmux_session",
          evidence: { registeredPane: "%7", observedPid: null, observedCommand: null, matchedLayer: null },
          observedAt: new Date(Date.now() + 1000).toISOString(),
        } as never);
      }
    }
    const gen = (session: string) => sessions.currentOccupantGenerationForSession(session);
    queue = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      resolveOccupantGeneration: gen,
      resolveSessionAddresses: (name: string) => (name === IDLE ? [IDLE, ALIAS] : [name]),
    } as never);
    jobs = new WatchdogJobsRepository(db, undefined, gen);
    queue.attachWatchdogJobsRepository(jobs);
    history = new WatchdogHistoryLog(db);
    clock = 0;
  });
  afterEach(() => db.close());

  function app(queueRepo: unknown): Hono {
    const a = new Hono();
    a.use("*", async (c, next) => {
      c.set("seatActivityService" as never, oracle as never);
      c.set("queueRepo" as never, queueRepo as never);
      c.set("rigRepo" as never, { db } as never);
      await next();
    });
    a.route("/api/activity", activityRoutes);
    return a;
  }

  /** The obligation reader the route used before: the full list() of the destination's open states, mapped down. */
  function fullListFace() {
    return {
      listOpenObligations: (destinationSession: string, limit: number) =>
        queue.list({ destinationSession, state: ["pending", "in-progress", "blocked"], limit })
          .map((r) => ({ qitemId: r.qitemId, state: r.state, summary: r.summary ?? null })),
      getParkWakeStatus: (qitemId: string) => queue.getParkWakeStatus(qitemId),
      parkWakeServedByOwnReminder: (qitemId: string) => queue.parkWakeServedByOwnReminder(qitemId),
    };
  }

  /** Both responses, as bytes; they must be equal. Returns the parsed body for the case's own assertions. */
  async function sameResponse(path: string): Promise<{ status: number; body: any }> {
    const lean = await app(queue).request(path);
    const full = await app(fullListFace()).request(path);
    const leanText = await lean.text();
    expect(lean.status).toBe(full.status);
    expect(leanText).toBe(await full.text());
    return { status: lean.status, body: JSON.parse(leanText) };
  }

  async function row(destinationSession = IDLE, summary = "owed"): Promise<string> {
    return (await queue.create({ sourceSession: "orch-lead@park-rig", destinationSession, body: "work", summary, nudge: false } as never)).qitemId;
  }
  function reminder(target = IDLE): string {
    return jobs.register({
      policy: "periodic-reminder",
      specYaml: ["policy: periodic-reminder", "target:", `  session: ${JSON.stringify(target)}`, "message: \"check your rows\"", ""].join("\n"),
      targetSession: target, intervalSeconds: 300, registeredBySession: target,
    } as never).jobId;
  }
  function park(qitemId: string, watchdogId: string) {
    queue.update({ qitemId, actorSession: IDLE, state: "blocked", blockedOn: "external:ci", transitionNote: "continuation: check CI",
      wakeWatchdogId: watchdogId } as never);
  }
  function fire(jobId: string) {
    const evaluatedAt = new Date(Date.UTC(2026, 10, 7, 3, 0, clock++)).toISOString();
    history.record({ jobId, evaluatedAt, outcome: "sent", deliveryStatus: "ok", deliveryTargetSession: IDLE } as never);
    queue.recordWatchdogWakeAttempt(jobId, "ok");
  }

  it("0 rows: the rig and the seat read the same, and the board is clean", async () => {
    const rig = await sameResponse(`/api/activity/parked?rig=${RIG}`);
    expect(rig.status).toBe(200);
    expect(rig.body.rig.seats.find((s: { sessionName: string }) => s.sessionName === IDLE).obligations.openCount).toBe(0);
    const seat = await sameResponse(`/api/activity/parked?seat=${encodeURIComponent(IDLE)}`);
    expect(seat.body.seat).toMatchObject({ parked: false, confidence: { obligations: "complete" } });
  });

  it("1 row: the same parked verdict, item and summary", async () => {
    const q = await row(IDLE, "the one owed row");
    const { body } = await sameResponse(`/api/activity/parked?seat=${encodeURIComponent(IDLE)}`);
    expect(body.seat.parked).toBe(true);
    expect(body.seat.obligations.items).toEqual([{ qitemId: q, state: "pending", summary: "the one owed row" }]);
  });

  it("more than the limit (500): the same 500 rows, newest first, and truncation-possible; ties on ts_created included", async () => {
    const insert = db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, summary)
      VALUES (?, ?, ?, 'orch-lead@park-rig', ?, ?, 'work', ?)`);
    const states = ["pending", "in-progress", "blocked"];
    db.transaction(() => {
      for (let i = 0; i < 510; i++) {
        // Two rows per millisecond, so the ORDER BY ts_created DESC window has ties at its edge.
        const ts = new Date(Date.UTC(2026, 10, 1, 0, 0, 0, Math.floor(i / 2))).toISOString();
        insert.run(`qitem-bulk-${String(i).padStart(4, "0")}`, ts, ts, i % 7 === 0 ? ALIAS : IDLE, states[i % 3], i % 5 === 0 ? null : `row ${i}`);
      }
    })();
    const { body } = await sameResponse(`/api/activity/parked?seat=${encodeURIComponent(IDLE)}`);
    expect(body.seat.obligations.openCount + body.seat.obligations.heldCount).toBe(500);
    expect(body.seat.confidence.obligations).toBe("truncation-possible");
    expect(body.seat.obligations.complete).toBe(false);
  });

  it("a held row with a live wake reads healthy on both", async () => {
    const q = await row();
    park(q, reminder());
    const { body } = await sameResponse(`/api/activity/parked?seat=${encodeURIComponent(IDLE)}`);
    expect(body.seat.obligations.held[0]).toMatchObject({ qitemId: q, healthy: true, wake: { live: true } });
  });

  it("a held row served by its owner's own reminder reads the same", async () => {
    const q = await row();
    const job = reminder();
    park(q, job);
    fire(job);
    const { body } = await sameResponse(`/api/activity/parked?seat=${encodeURIComponent(IDLE)}`);
    expect(body.seat.obligations.held[0]).toMatchObject({ qitemId: q, healthy: true, servedByOwnReminder: true });
  });

  it("an indeterminate seat (no activity evidence) reads the same", async () => {
    await row(UNKNOWN);
    const { body } = await sameResponse(`/api/activity/parked?rig=${RIG}`);
    expect(body.rig.seats.find((s: { sessionName: string }) => s.sessionName === UNKNOWN).parked).toBe("indeterminate");
  });

  it("a seat confirmed stopped reads the same (indeterminate despite its idle evidence)", async () => {
    await row(STOPPED);
    const { body } = await sameResponse(`/api/activity/parked?seat=${encodeURIComponent(STOPPED)}`);
    expect(body.seat.parked).toBe("indeterminate");
  });

  it("a rig without seats reads the same", async () => {
    const { status, body } = await sameResponse("/api/activity/parked?rig=empty-rig");
    expect(status).toBe(200);
    expect(body.rig).toMatchObject({ parked: false, seats: [] });
  });

  it("rows addressed to an alias of the seat are found the same way (resolveSessionAddresses)", async () => {
    const q = await row(ALIAS, "sent to the old address");
    const { body } = await sameResponse(`/api/activity/parked?seat=${encodeURIComponent(IDLE)}`);
    expect(body.seat.obligations.items).toEqual([{ qitemId: q, state: "pending", summary: "sent to the old address" }]);
  });
});
