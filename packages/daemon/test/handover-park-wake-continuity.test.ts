// A seat swap stops the watchdog jobs the retiring occupant registered, so a stale wake doesn't reach the successor.
// A blocked row's current park timer is different: it wakes the seat that still owns the row, and the successor
// inherits that row. It survives the swap; every other job the retiring generation registered still stops.
// Real queue, watchdog and session repositories on a full test DB, wired as startup.ts wires them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { DefaultOccupantInvalidator } from "../src/domain/occupant-invalidator.js";
import { diagnoseSeatParked } from "../src/domain/parked-query.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";

const SEAT = "dev-impl@seat-rig";
const OTHER = "dev-qa@seat-rig";

describe("#handover-wake: a blocked row's park timer across an occupant swap", () => {
  let db: Database.Database;
  let queue: QueueRepository;
  let jobs: WatchdogJobsRepository;
  let invalidator: DefaultOccupantInvalidator;
  let gen: (session: string) => string | null;
  let seatNodeId: string;
  let otherNodeId: string;
  let sessionRegistry: SessionRegistry;
  let bus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    db.exec(watchdogHistorySchema.sql); // the engine audits each evaluation; the full test DB does not include this table
    const rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("seat-rig");
    for (const [logicalId, session] of [["dev.impl", SEAT], ["dev.qa", OTHER]] as const) {
      const node = rigRepo.addNode(rig.id, logicalId, { runtime: "codex" });
      sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, session).id, "running");
      if (session === SEAT) seatNodeId = node.id; else otherNodeId = node.id;
    }
    gen = (session) => sessionRegistry.currentOccupantGenerationForSession(session);
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { validateRig: () => true, resolveOccupantGeneration: gen });
    jobs = new WatchdogJobsRepository(db, undefined, gen);
    queue.attachWatchdogJobsRepository(jobs);
    invalidator = new DefaultOccupantInvalidator({
      enforcer: { invalidateOccupant() {} }, contextUsage: { invalidateOccupantSidecar() {} }, watchdog: jobs, queue,
    });
  });
  afterEach(() => db.close());

  async function park(opts: { destination?: string; actor?: string; repeating?: boolean; watchdogId?: string } = {}) {
    const row = await queue.create({ sourceSession: "orch-lead@seat-rig", destinationSession: opts.destination ?? SEAT, body: "work" } as never);
    queue.update({
      qitemId: row.qitemId, actorSession: opts.actor ?? SEAT, state: "blocked", blockedOn: "external:ci",
      transitionNote: "continuation: check CI",
      ...(opts.watchdogId ? { wakeWatchdogId: opts.watchdogId } : { wakeAfterSeconds: 1800, ...(opts.repeating ? { wakeMaxSeconds: 7200 } : {}) }),
    } as never);
    return { qitemId: row.qitemId, wakeRef: (queue.getParkWakeStatus(row.qitemId) as { ref: string }).ref };
  }
  const swap = () => invalidator.invalidateRetiringOccupant({ retiringSessionName: SEAT, successorSessionName: SEAT, retiringGeneration: gen(SEAT)! });
  const jobState = (jobId: string) => (db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(jobId) as { state: string }).state;
  const activeJobsFor = (session: string) => (db.prepare("SELECT COUNT(*) AS n FROM watchdog_jobs WHERE state = 'active' AND target_session = ?").get(session) as { n: number }).n;
  const wakeLive = (qitemId: string) => (queue.getParkWakeStatus(qitemId) as { live: boolean }).live;
  const parkedWhenIdle = (session = SEAT) => diagnoseSeatParked({
    getSeatState: () => ({ activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, decidedBy: "test" }) as never,
    listOpenObligations: (destinationSession, limit) => ({
      rows: queue.list({ destinationSession, state: ["pending", "in-progress", "blocked"], limit })
        .map((r) => ({ qitemId: r.qitemId, state: r.state as "pending" | "in-progress" | "blocked", summary: r.summary ?? null })),
      limit,
    }),
    getParkWake: (qitemId) => queue.getParkWakeStatus(qitemId),
  }, { seatNodeId: session === SEAT ? seatNodeId : otherNodeId, sessionName: session });

  it.each([false, true])("the still-owned blocked row keeps its one live timer (repeating=%s)", async (repeating) => {
    const { qitemId, wakeRef } = await park({ repeating });

    swap();

    expect(jobState(wakeRef)).toBe("active");
    expect(wakeLive(qitemId)).toBe(true);
    expect(activeJobsFor(SEAT)).toBe(1);
    expect(parkedWhenIdle().obligations.unhealthyHeldCount).toBe(0);
  });

  it("a successor re-park still supersedes the kept timer: one live timer, not two", async () => {
    const { qitemId, wakeRef } = await park();
    swap();

    queue.update({ qitemId, actorSession: SEAT, state: "blocked", blockedOn: "external:ci", transitionNote: "continuation: re-parked", wakeAfterSeconds: 600 } as never);

    expect(jobState(wakeRef)).not.toBe("active");
    expect(activeJobsFor(SEAT)).toBe(1);
  });

  it("another seat's blocked row parked by the retiring occupant keeps its live timer", async () => {
    const { qitemId, wakeRef } = await park({ destination: OTHER, actor: SEAT });

    swap();

    expect(jobState(wakeRef)).toBe("active");
    expect(wakeLive(qitemId)).toBe(true);
  });

  it("control: an occupant-only job the retiring generation registered still stops", () => {
    const own = jobs.register({
      policy: "periodic-reminder", targetSession: SEAT, intervalSeconds: 600, registeredBySession: SEAT,
      specYaml: ["policy: periodic-reminder", "target:", `  session: ${JSON.stringify(SEAT)}`, 'message: "own reminder"', ""].join("\n"),
    });

    swap();

    expect(jobState(own.jobId)).toBe("stopped");
  });

  it("control: an operator watchdog attached to the blocked row still stops (custom job, not queue-generated)", async () => {
    const attached = jobs.register({
      policy: "periodic-reminder", targetSession: SEAT, intervalSeconds: 600, registeredBySession: SEAT,
      specYaml: ["policy: periodic-reminder", "target:", `  session: ${JSON.stringify(SEAT)}`, 'message: "operator watchdog"', ""].join("\n"),
    });
    await park({ watchdogId: attached.jobId });

    swap();

    expect(jobState(attached.jobId)).toBe("stopped");
  });

  it("control: a row rerouted to another seat does not keep the old seat's timer", async () => {
    const { qitemId, wakeRef } = await park();
    queue.routeToFallback(qitemId, OTHER, "test transfer");

    swap();

    expect(jobState(wakeRef)).not.toBe("active");
  });

  // review-r2 (PR #242): a rerouted row's park timer must not keep waking the OLD owner. The scheduler evaluates
  // active jobs; this evaluates every active job, due or not, through the real engine and pre-delivery check.
  async function fireAllActive() {
    const deliveries: Array<{ targetSession: string; message: string }> = [];
    const engine = new WatchdogPolicyEngine({
      jobsRepo: jobs, historyLog: new WatchdogHistoryLog(db), eventBus: bus,
      deliver: async (request) => { deliveries.push(request); return { status: "ok" }; },
      resolvePreDeliveryTerminalReason: ({ jobId }: { jobId: string }) => queue.resolveWatchdogPreDeliveryTerminalReason(jobId),
      resolveQueueWait: (input: { jobId: string }) => queue.evaluateWaitReminder(input),
      onWakeAttempt: ({ jobId, deliveryStatus }) => queue.recordWatchdogWakeAttempt(jobId, deliveryStatus),
    });
    for (const job of jobs.listActive()) await engine.evaluate(job);
    return deliveries;
  }

  it("park, reroute, fire: nothing reaches the old owner (no handover)", async () => {
    const { qitemId, wakeRef } = await park();

    queue.routeToFallback(qitemId, OTHER, "test reroute");

    expect(jobState(wakeRef)).not.toBe("active");
    expect(wakeLive(qitemId)).toBe(false);
    expect(parkedWhenIdle(OTHER).obligations.unhealthyHeldCount).toBe(1);
    expect((await fireAllActive()).filter((d) => d.targetSession === SEAT)).toEqual([]);
  });

  it("park, swap (timer kept), reroute, swap, fire: nothing reaches the old owner", async () => {
    const { qitemId, wakeRef } = await park();
    swap();
    expect(jobState(wakeRef)).toBe("active");
    queue.routeToFallback(qitemId, OTHER, "test reroute");
    const firstGeneration = gen(SEAT);
    sessionRegistry.updateStatus(sessionRegistry.registerSession(seatNodeId, SEAT).id, "running");
    expect(gen(SEAT)).not.toBe(firstGeneration);

    swap();

    expect(jobState(wakeRef)).not.toBe("active");
    expect(wakeLive(qitemId)).toBe(false);
    expect(parkedWhenIdle(OTHER).obligations.unhealthyHeldCount).toBe(1);
    expect((await fireAllActive()).filter((d) => d.targetSession === SEAT)).toEqual([]);
  });

  it.each([false, true])("a repeating wait survives the reroute and wakes only the new owner (swaps=%s)", async (withSwaps) => {
    const { qitemId, wakeRef } = await park({ repeating: true });
    if (withSwaps) swap();
    queue.routeToFallback(qitemId, OTHER, "test reroute");
    if (withSwaps) {
      sessionRegistry.updateStatus(sessionRegistry.registerSession(seatNodeId, SEAT).id, "running");
      swap();
    }

    expect(jobState(wakeRef)).toBe("active");
    expect(wakeLive(qitemId)).toBe(true);
    const deliveries = await fireAllActive();
    expect(deliveries.map((d) => d.targetSession)).toEqual([OTHER]);
  });

  it("control: a stale timer that is no longer the row's current wake still stops", async () => {
    const { qitemId, wakeRef: first } = await park();
    queue.update({ qitemId, actorSession: SEAT, state: "blocked", blockedOn: "external:ci", transitionNote: "continuation: re-parked", wakeAfterSeconds: 600 } as never);
    // Legacy residue: a superseded timer left active by a path that did not retire it.
    db.prepare("UPDATE watchdog_jobs SET state = 'active', terminal_reason = NULL WHERE job_id = ?").run(first);

    swap();

    expect(jobState(first)).toBe("stopped");
    expect(wakeLive(qitemId)).toBe(true);
  });
});
