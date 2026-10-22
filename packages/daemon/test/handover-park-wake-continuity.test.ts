// A seat swap stops the watchdog jobs the retiring occupant registered for its own seat, so a stale wake doesn't
// reach the successor. A blocked row's current park timer is different: it wakes the seat that still owns the row,
// and the successor inherits that row. It survives the swap; every other job the retiring generation registered for
// its own seat still stops. Jobs it registered for another seat wake that seat, not the successor, and keep running.
// A workflow keepalive is work-bound, like a park timer, and keeps running whoever owns the workflow's frontier.
// Real queue, watchdog and session repositories on a full test DB, wired as startup.ts wires them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry, physicalSessionName } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { DefaultOccupantInvalidator } from "../src/domain/occupant-invalidator.js";
import { diagnoseSeatParked } from "../src/domain/parked-query.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { makeWorkflowKeepalivePolicy } from "../src/domain/policies/workflow-keepalive.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";

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
      addresses: sessionRegistry,
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
  const swap = (session = SEAT) => invalidator.invalidateRetiringOccupant({ retiringSessionName: session, successorSessionName: session, retiringGeneration: gen(session)! });
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

  // #1775: a reminder the retiring occupant registered for another seat wakes that seat, never the successor, so it
  // keeps running, as reminders aimed at a handed-over seat already do.
  const reminderFor = (target: string, opts: { specTarget?: string; registeredBy?: string } = {}) => jobs.register({
    policy: "periodic-reminder", targetSession: target, intervalSeconds: 7200, registeredBySession: opts.registeredBy ?? SEAT,
    specYaml: ["policy: periodic-reminder", "target:", `  session: ${JSON.stringify(opts.specTarget ?? target)}`, 'message: "check CI"', ""].join("\n"),
  });

  it("a reminder the retiring occupant registered for another seat keeps running and still reaches that seat", async () => {
    const reminder = reminderFor(OTHER);

    swap();

    expect(jobState(reminder.jobId)).toBe("active");
    expect((await fireAllActive()).map((d) => d.targetSession)).toEqual([OTHER]);
  });

  it("a reminder the retiring occupant attached to another seat's blocked row stays that row's live wake", async () => {
    const reminder = reminderFor(OTHER);
    const { qitemId } = await park({ destination: OTHER, actor: SEAT, watchdogId: reminder.jobId });

    swap();

    expect(jobState(reminder.jobId)).toBe("active");
    expect(wakeLive(qitemId)).toBe(true);
    expect(parkedWhenIdle(OTHER).obligations.unhealthyHeldCount).toBe(0);
  });

  // The seat a reminder wakes is its delivery target, not its stored string: delivery resolves the name, and a
  // periodic reminder prefers its spec's target. The swap judges the same value.
  it("a reminder for the retiring seat's logical address, while it runs under another physical name, still stops", () => {
    const rigId = (db.prepare("SELECT id FROM rigs WHERE name = 'seat-rig'").get() as { id: string }).id;
    const node = new RigRepository(db).addNode(rigId, "dev.ops", { runtime: "codex" });
    sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, "custom-ops@seat-rig").id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "custom-ops@seat-rig", attachmentType: "tmux" });
    expect(physicalSessionName(db, "dev-ops@seat-rig")).toBe("custom-ops@seat-rig"); // delivery reaches this seat
    const own = reminderFor("dev-ops@seat-rig", { registeredBy: "custom-ops@seat-rig" });

    swap("custom-ops@seat-rig");

    expect(jobState(own.jobId)).toBe("stopped");
  });

  it("a reminder stored for another seat whose spec targets the retiring seat still stops", async () => {
    const own = reminderFor(OTHER, { specTarget: SEAT });
    expect((await fireAllActive()).map((d) => d.targetSession)).toEqual([SEAT]); // it is delivered to this seat

    swap();

    expect(jobState(own.jobId)).toBe("stopped");
  });

  // A workflow keepalive wakes the workflow's current frontier owner (else its creator, observers, then its own target) and
  // ends with the workflow. It's work-bound, like a park timer, so the swap keeps it whoever owns the frontier.
  async function keepaliveFor(frontierOwner: string, fallback: string) {
    db.exec(workflowInstancesSchema.sql); // the full test DB leaves the workflow tables to the workflow suites
    const frontier = await queue.create({ sourceSession: "orch-lead@seat-rig", destinationSession: frontierOwner, body: "step" } as never);
    db.prepare(`INSERT INTO workflow_instances (instance_id, workflow_name, workflow_version, created_by_session, created_at, status, current_frontier_json)
      VALUES ('inst-1', 'wf', '1', 'orch-lead@seat-rig', '2026-10-22T00:00:00Z', 'active', ?)`).run(JSON.stringify([frontier.qitemId]));
    return jobs.register({
      policy: "workflow-keepalive", targetSession: fallback, intervalSeconds: 1800, registeredBySession: SEAT,
      specYaml: ["policy: workflow-keepalive", "target:", `  session: ${JSON.stringify(fallback)}`, "context:", "  workflow_instance_id: inst-1", ""].join("\n"),
    });
  }

  it("a workflow keepalive the retiring occupant registered with itself as fallback keeps waking another seat's frontier", async () => {
    const keepalive = await keepaliveFor(OTHER, SEAT);
    expect((await fireAllActive()).map((d) => d.targetSession)).toEqual([OTHER]); // the frontier owner, not the fallback

    swap();

    expect(jobState(keepalive.jobId)).toBe("active");
    expect((await fireAllActive()).map((d) => d.targetSession)).toEqual([OTHER]);
  });

  it("a workflow keepalive for the retiring seat's own frontier keeps running for the successor, who inherits that step", async () => {
    const keepalive = await keepaliveFor(SEAT, OTHER);

    swap();

    expect(jobState(keepalive.jobId)).toBe("active");
    expect((await fireAllActive()).map((d) => d.targetSession)).toEqual([SEAT]);
  });

  it("a reminder stored for the retiring seat whose spec targets another seat keeps running", async () => {
    const forOther = reminderFor(SEAT, { specTarget: OTHER });

    swap();

    expect(jobState(forOther.jobId)).toBe("active");
    expect((await fireAllActive()).map((d) => d.targetSession)).toEqual([OTHER]);
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
      additionalPolicies: [makeWorkflowKeepalivePolicy({ db })],
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
