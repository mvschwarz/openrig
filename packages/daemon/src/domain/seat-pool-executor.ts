import type Database from "better-sqlite3";
import type { ArbitratedSeatState } from "./activity-taxonomy.js";
import {
  planSeatPool,
  seatPoolCanReceive,
  type SeatPoolAgentFacts,
  type SeatPoolIntent,
  type SeatPoolPendingRow,
  type SeatPoolPhase,
  type SeatPoolPlanState,
} from "./policies/seat-pool.js";
import type { PolicyEvaluation, PolicyJob } from "./policies/types.js";
import type { QueueRepository } from "./queue-repository.js";
import type { RigRepository } from "./rig-repository.js";
import { DeliveryGuardError } from "./seat-delivery-guard.js";
import { seatPoolModelOfJob, type SeatPoolModel } from "./seat-pool-registration.js";
import type { SeatPoolSlot, SeatPoolSlotsRepository } from "./seat-pool-slots.js";
import { parsePoolBlock, type SeatPoolSpec, type StoredSeatPool } from "./seat-pool-spec.js";
import { deriveCanonicalSessionName } from "./session-name.js";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";

// #3395 (Piece 1): the seat-pool executor, which the `seat-pool` policy hands each evaluation to.
//
// One cycle reads the pool afresh (the model's stored block, its slot rows, each pool agent's latest session, activity,
// open rows and held messages, and the rows waiting for the model or for a drained agent), plans with the pure planner,
// and applies two effects: moving a waiting row to a free pool agent, and draining a free agent idle past
// `idle_grace_s`. The plan is read outside any lease; the hold check, the moves and each drain's decision run under the
// delivery guard's custody lease on the model node, and each re-checks the stored block and the agent just before it.
//
// A drain keeps the agent's node, sessions and history. Under the agent's lifecycle lease it reads the agent again (a
// row or a held message that reached it, or a wake since the plan, sends the slot back to `live`; an agent relaunched
// since the plan is left alone), captures an `auto-rehydrate` snapshot while the agent still runs, and stops it with the
// checked stop (`expected` = the session the plan read). What the stop returned is reported in `stop.result`: `stopped`
// and `absent` mark the slot `drained`, `changed_owner` sends it back to `live`, and `unconfirmed` leaves it `draining`,
// to be stopped again (never captured again) by the next cycle when a kill was attempted, and only while the agent is
// free; an unconfirmed stop known to have had no effect gives the slot back to `live`. After `pool: {}` the job drains
// with the last spec stored on its row and ends once every agent is drained.
//
// The whole pool is held, and nothing moves or drains, while the job is not `active`, while the stored block can't be
// read, while the model node is gone (or has no canonical session), and from the rig's latest `rig.stopped` until a
// later `restore.completed`, whatever its result. The cause goes in the job's notes. Adding and bringing agents back
// are not done here.

/** What one move returns: moved, or refused with the queue's code. */
export type SeatPoolMoveResult = { ok: true } | { ok: false; code: string; message: string };

/** A pending row as the pool reads it: its destination as stored, its tags and since when it waits there. */
export interface SeatPoolQueueRow {
  qitemId: string;
  rawDestination: string;
  tags: string[];
  waitingSince: string;
}

/** The queue as the pool uses it. */
export interface SeatPoolQueue {
  /** Pending rows addressed to a session (any of its addresses) that are that seat's work, all of them, with their raw
   *  destination, tags and waitingSince. */
  pendingRows(sessionName: string): SeatPoolQueueRow[];
  /** How many open rows (pending, in progress, blocked) a session has. */
  openRows(sessionName: string): number;
  /** Move a pending row from `from` to `to` only while it is still pending and addressed to `from`, with a wake. */
  moveRow(input: { qitemId: string; from: string; to: string; reason: string }): Promise<SeatPoolMoveResult>;
}

export interface SeatPoolExecutorDeps {
  /** The job's model, the agents' latest sessions and the rig's events. */
  db: Database.Database;
  rigRepo: Pick<RigRepository, "getNodePool">;
  slots: Pick<SeatPoolSlotsRepository, "forModel" | "setPhase" | "stopOutcome">;
  jobsRepo: Pick<WatchdogJobsRepository, "getById">;
  queue: SeatPoolQueue;
  /** Messages held for a node in the outbox (OutboxHandler.heldCount). */
  heldCount(nodeId: string): number;
  /** Whether the node's executor confirmed it stopped (nodeExecutorConfirmedStopped). */
  confirmedStopped(nodeId: string): boolean;
  /** The node's arbitrated activity, or null when unknown. Only asked for a node the reader saw running. */
  seatState(nodeId: string): ArbitratedSeatState | null;
  /** The delivery guard's custody lease on these nodes (SeatDeliveryGuard.custody). */
  custody<T>(nodeIds: string[], fn: () => Promise<T>): Promise<T>;
  now(): Date;
  /** The drain's effects. Without them a planned drain is not made, and the cycle reports it as not composed. */
  drain?: SeatPoolDrainEffects;
}

/** What the checked stop returned, as the pool reads it (SeatLifecycleService.stopSeat). */
export type SeatPoolSeatStop =
  | { ok: true; alreadyDown?: true; message?: string }
  | { ok: false; code: string; message: string; partialEffect?: boolean };

/** The drain's effects, composed by the daemon. */
export interface SeatPoolDrainEffects {
  /** The lifecycle lease on these nodes (SeatDeliveryGuard.lifecycle): the drain re-reads, captures and stops under it. */
  lifecycle<T>(nodeIds: string[], fn: () => Promise<T>): Promise<T>;
  /** Refresh the agent's resume metadata, as `rig down` does before its snapshot (ResumeMetadataRefresher.refresh).
   *  Best-effort: the drain captures and stops after a refresh that fails. */
  refresh(input: { rigId: string; nodeId: string; sessionId: string }): Promise<void>;
  /** Capture an `auto-rehydrate` snapshot of the rig (SnapshotCapture.captureSnapshot). Throws when it can't. */
  capture(rigId: string): { snapshotId: string };
  /** The checked stop: stop the seat only while its latest session is still `expected.sessionId`. `recheck` runs at the
   *  stop's final step before each effect, after its liveness probe; a refusal it returns stops nothing more. */
  stopSeat(input: {
    seatRef: string; reason: string; expected: { nodeId: string; sessionId: string };
    recheck?: () => { ok: false; code: "selection_changed"; message: string } | null;
  }): Promise<SeatPoolSeatStop>;
}

/**
 * What a pool stop is reported as, in `stop.result`, never two at once: `stopped` (a successful stop), `absent` (a
 * confirmed absence: the stop found the session absent in tmux, `session_not_live`), `changed_owner` (the seat or its
 * latest session changed before anything was stopped) and `unconfirmed` (anything else, with its real code and message).
 */
export type SeatPoolStopResult = "stopped" | "absent" | "changed_owner" | "unconfirmed";

export interface SeatPoolStopReport {
  cause: "drain";
  result: SeatPoolStopResult;
  code?: string;
  message?: string;
}

/** The report of a stop from what the checked stop returned. */
export function seatPoolStopReport(stop: SeatPoolSeatStop): SeatPoolStopReport {
  // A keep_alive seat whose session was already gone is recorded as stopped, but nothing was stopped: an absence.
  if (stop.ok && stop.alreadyDown) return { cause: "drain", result: "absent", code: "already_down", ...(stop.message ? { message: stop.message } : {}) };
  if (stop.ok) return { cause: "drain", result: "stopped" };
  if (stop.code === "session_not_live") return { cause: "drain", result: "absent", code: stop.code, message: stop.message };
  if (stop.code === "selection_changed" && stop.partialEffect !== true) {
    return { cause: "drain", result: "changed_owner", code: stop.code, message: stop.message };
  }
  return { cause: "drain", result: "unconfirmed", code: stop.code, message: stop.message };
}

export interface SeatPoolExecutor {
  /** One cycle of the job: read, hold, plan, move, drain. Never throws for a refused move or a custody refusal. */
  cycle(job: Pick<PolicyJob, "jobId" | "context">): Promise<PolicyEvaluation>;
}

/** The queue's reroute actor and note, as the queue records a reroute (the queue's own rule for "was rerouted"). */
const QUEUE_FALLBACK_ACTOR = "system:queue-fallback";
const FALLBACK_NOTE = "fallback-routed: ";
/** No cut: list() keeps the newest rows first, so any limit would drop the oldest rows, which move first. */
const ALL_ROWS = Number.MAX_SAFE_INTEGER;
/** Refusals that mean the row moved on since it was read: skipped, never a failure. */
const ROW_MOVED_ON: ReadonlySet<string> = new Set(["fallback_state_mismatch", "fallback_destination_mismatch", "qitem_not_found"]);

/** A queue-only seat's cold watchdog reminder is about that seat, never its work (the stuck sweep's rule). */
function isWatchdogReminder(row: { sourceSession: string; tags?: string[] | null }): boolean {
  return row.sourceSession === "watchdog@system" && !!row.tags?.includes("watchdog") && row.tags.includes("queue-only");
}

/** When the row was last rerouted, from its transitions, or null when it never was. */
function lastReroute(queueRepo: Pick<QueueRepository, "transitionLog">, qitemId: string): string | null {
  const transitions = queueRepo.transitionLog.listForQitem(qitemId);
  for (let i = transitions.length - 1; i >= 0; i--) {
    const t = transitions[i]!;
    if (t.actorSession === QUEUE_FALLBACK_ACTOR && t.transitionNote?.startsWith(FALLBACK_NOTE) && t.identityProvenance === null) return t.ts;
  }
  return null;
}

/** The queue repository as the pool uses it: two reads and the move. */
export function seatPoolQueueEffects(
  queueRepo: Pick<QueueRepository, "list" | "listOpenObligations" | "routeToFallback" | "transitionLog">,
): SeatPoolQueue {
  return {
    pendingRows: (sessionName) => {
      // The seat's own work, by the same rule as its open obligations: a wake escalation about its own prompt is left out.
      const work = new Set(queueRepo.listOpenObligations(sessionName, ALL_ROWS).map((row) => row.qitemId));
      return queueRepo.list({ destinationSession: sessionName, state: "pending", limit: ALL_ROWS, compact: true })
        .filter((row) => work.has(row.qitemId) && !isWatchdogReminder(row))
        .map((row) => ({
          qitemId: row.qitemId,
          rawDestination: row.destinationSession,
          tags: row.tags ?? [],
          waitingSince: lastReroute(queueRepo, row.qitemId) ?? row.tsCreated,
        }));
    },
    openRows: (sessionName) => queueRepo.listOpenObligations(sessionName, ALL_ROWS).length,
    moveRow: async ({ qitemId, from, to, reason }) => {
      // No await before routeToFallback: the re-check just before this call and the move run with nothing in between.
      try {
        queueRepo.routeToFallback(qitemId, to, reason, { expectState: "pending", expectDestination: from, wake: true });
        return { ok: true };
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "move_failed";
        return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** One pool agent as the reader saw it: the planner's facts, its node and its latest session's status. */
export interface SeatPoolAgentRead extends SeatPoolAgentFacts {
  nodeId: string | null;
  /** The latest session's status as recorded. Null: no session. */
  latestSessionStatus: string | null;
}

/** The planner's whole input, with the agents as read and each row's destination as stored. */
export interface SeatPoolReadState extends SeatPoolPlanState {
  agents: SeatPoolAgentRead[];
  /** qitemId → the row's destination as stored, for the move's expected destination. */
  rawDestination: Map<string, string>;
}

/** The hold the rig's events give. */
export interface SeatPoolHoldRead {
  /** The latest rig.stopped with no restore.completed after it: the hold. Null: not held. */
  stoppedSeq: number | null;
  /** While held: the latest restore.subset_completed after the stop. */
  seatsLaunchedSeq: number | null;
  /** Not held: the latest restore.started with no restore.completed after it. */
  unfinishedRestoreSeq: number | null;
}

/** An agent's node as recorded, with its canonical session name (null without a pod-aware name), or null when the node
 *  is gone. */
function agentNode(db: Database.Database, nodeId: string): { sessionName: string | null } | null {
  const row = db.prepare(
    "SELECT n.logical_id AS logical_id, r.name AS rig_name FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?",
  ).get(nodeId) as { logical_id: string; rig_name: string } | undefined;
  if (!row) return null;
  const dot = row.logical_id.indexOf(".");
  if (dot <= 0 || dot === row.logical_id.length - 1) return { sessionName: null };
  return { sessionName: deriveCanonicalSessionName(row.logical_id.slice(0, dot), row.logical_id.slice(dot + 1), row.rig_name) };
}

function validIso(value: string | null | undefined): value is string {
  return typeof value === "string" && value !== "" && Number.isFinite(Date.parse(value));
}

/** The agents only: what the re-check just before a move needs. */
export function readSeatPoolAgents(deps: SeatPoolExecutorDeps, slots: readonly SeatPoolSlot[]): SeatPoolAgentRead[] {
  const latestStatus = deps.db.prepare("SELECT status FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1");
  const nowIso = deps.now().toISOString();
  return slots.map((slot) => {
    const node = slot.nodeId === null ? null : agentNode(deps.db, slot.nodeId);
    const nodeId = node === null ? null : slot.nodeId;
    const sessionName = node?.sessionName ?? null;
    const latestSessionStatus = nodeId === null
      ? null
      : (latestStatus.get(nodeId) as { status: string } | undefined)?.status ?? null;
    const running = nodeId !== null && (latestSessionStatus === "running" || latestSessionStatus === "idle")
      && !deps.confirmedStopped(nodeId);
    const state = running ? deps.seatState(nodeId!) : null;
    const idleAtPrompt = state?.activity === "idle-at-prompt" && state.needsInput.count === 0 && !state.backgroundWork;
    return {
      slotNumber: slot.slotNumber,
      sessionName,
      phase: slot.phase,
      attemptState: null,
      running,
      idleAtPrompt,
      // Every agent idle at its prompt has a time: an unreadable one starts the grace now rather than never.
      idleSince: idleAtPrompt ? (validIso(state!.changedAt) ? state!.changedAt : nowIso) : null,
      openRows: sessionName ? deps.queue.openRows(sessionName) : 0,
      heldCount: nodeId ? deps.heldCount(nodeId) : 0,
      nodeId,
      latestSessionStatus,
    };
  });
}

/** The agents and the rows waiting for the model or for a drained agent: the planner's whole input. */
export function readSeatPoolState(deps: SeatPoolExecutorDeps, model: SeatPoolModel, slots: readonly SeatPoolSlot[]): SeatPoolReadState {
  const agents = readSeatPoolAgents(deps, slots);
  const pending: SeatPoolPendingRow[] = [];
  const rawDestination = new Map<string, string>();
  const add = (destination: string) => {
    for (const row of deps.queue.pendingRows(destination)) {
      if (rawDestination.has(row.qitemId)) continue;
      rawDestination.set(row.qitemId, row.rawDestination);
      pending.push({ qitemId: row.qitemId, destination, waitingSince: row.waitingSince, tags: row.tags });
    }
  };
  add(model.sessionName);
  for (const agent of agents) {
    if (agent.phase === "drained" && agent.sessionName !== null) add(agent.sessionName);
  }
  return { modelSession: model.sessionName, agents, pending, lastStepAt: null, rawDestination };
}

/** The hold the rig's events give: the latest `rig.stopped` with no `restore.completed` after it. */
export function readSeatPoolHold(db: Database.Database, rigId: string): SeatPoolHoldRead {
  const seqOf = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { seq: number } | undefined)?.seq ?? null;
  const stopped = seqOf("SELECT seq FROM events WHERE rig_id = ? AND type = 'rig.stopped' ORDER BY seq DESC LIMIT 1", rigId);
  if (stopped !== null) {
    const released = seqOf("SELECT seq FROM events WHERE rig_id = ? AND type = 'restore.completed' AND seq > ? ORDER BY seq LIMIT 1", rigId, stopped);
    if (released === null) {
      const seatsLaunched = seqOf(
        "SELECT seq FROM events WHERE rig_id = ? AND type = 'restore.subset_completed' AND seq > ? ORDER BY seq DESC LIMIT 1", rigId, stopped,
      );
      return { stoppedSeq: stopped, seatsLaunchedSeq: seatsLaunched, unfinishedRestoreSeq: null };
    }
  }
  const started = seqOf("SELECT seq FROM events WHERE rig_id = ? AND type = 'restore.started' ORDER BY seq DESC LIMIT 1", rigId);
  const completed = started === null
    ? null
    : seqOf("SELECT seq FROM events WHERE rig_id = ? AND type = 'restore.completed' AND seq > ? LIMIT 1", rigId, started);
  return { stoppedSeq: null, seatsLaunchedSeq: null, unfinishedRestoreSeq: started !== null && completed === null ? started : null };
}

type HeldCause = "job stopped" | "rig stopped" | "pool block unreadable" | "model node gone" | "model has no canonical session";
interface Held { cause: HeldCause; seq?: number; message: string; exit?: string }
interface Move { qitemId: string; from: string; to: string }

const JOB_STOPPED: Held = { cause: "job stopped", message: "held: job stopped" };
const BLOCK_UNREADABLE: Held = { cause: "pool block unreadable", message: "held: pool block unreadable" };

type BlockView =
  | { block: "none" }
  | { block: "stored"; spec: SeatPoolSpec }
  | { block: "unusable"; error: string };

function blockView(stored: StoredSeatPool | undefined): BlockView {
  if (stored === undefined) return { block: "none" };
  return "spec" in stored ? { block: "stored", spec: stored.spec } : { block: "unusable", error: stored.error };
}

/** Whether two stored specs are the same, field by field. */
function sameSpec(a: SeatPoolSpec, b: SeatPoolSpec): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof SeatPoolSpec>;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function unreadableAdvisory(error: string): string {
  return `the stored pool block can't be read (${error}); the pool is held until the block is fixed, and nothing is removed`;
}

function slotsView(slots: readonly SeatPoolSlot[]): Array<{ slotNumber: number; nodeId: string | null; phase: SeatPoolPhase }> {
  return slots.map((slot) => ({ slotNumber: slot.slotNumber, nodeId: slot.nodeId, phase: slot.phase }));
}


/** One drain step as the cycle reports it. */
interface DrainReport {
  slotNumber: number;
  session: string | null;
  /** The slot's phase after this step. */
  phase: SeatPoolPhase;
  /**
   * `drained`: stopped (or found absent) after the capture. `returned`: work or a wake reached the agent, or the drain
   * was not finished, so the slot is `live` again and nothing was stopped. `left`: the agent was relaunched (or stopped
   * running) since the plan read it, or its seat changed before the stop: left alone, `live`. `draining`: not finished
   * (the capture failed, the stop is unconfirmed, or the job stopped first); the next cycle carries on. `skipped`: not
   * started, with the reason in `code`.
   */
  outcome: "drained" | "returned" | "left" | "draining" | "skipped";
  code?: string;
  message?: string;
  snapshotId?: string;
  stop?: SeatPoolStopReport;
}

/** A drain decided under the custody lease, made after it. */
interface DrainStep { slot: SeatPoolSlot; nodeId: string; session: string; sessionId: string; idleSince: string }

/** A drain whose stop came back unconfirmed after a kill was attempted: stopped again, never captured again. */
interface Restop { slot: SeatPoolSlot; nodeId: string; session: string; sessionId: string }

/** A node's latest session, in the order the reader uses. Null: none. */
function latestSession(db: Database.Database, nodeId: string): { id: string; status: string } | null {
  return (db.prepare("SELECT id, status FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(nodeId) as
    { id: string; status: string } | undefined) ?? null;
}

/** The spec the job was last ensured with (`context.pool`); null when it has none that reads. */
function lastEnsuredSpec(context: Record<string, unknown>): SeatPoolSpec | null {
  const read = parsePoolBlock(context["pool"]);
  return read.ok ? read.spec : null;
}

/** The time of the latest drain step on record: the newest phase change of a `draining` or `drained` slot. */
function lastDrainStep(slots: readonly SeatPoolSlot[]): string | null {
  let latest: string | null = null;
  for (const slot of slots) {
    if ((slot.phase !== "draining" && slot.phase !== "drained") || !validIso(slot.phaseChangedAt)) continue;
    if (latest === null || Date.parse(slot.phaseChangedAt) > Date.parse(latest)) latest = slot.phaseChangedAt;
  }
  return latest;
}

/** Free to drain: its latest session runs, idle at its prompt, with no open row and no held message. */
function freeToDrain(agent: SeatPoolAgentRead): boolean {
  return agent.running && agent.idleAtPrompt && agent.openRows === 0 && agent.heldCount === 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function makeSeatPoolExecutor(deps: SeatPoolExecutorDeps): SeatPoolExecutor {
  /** Woken since the plan: the agent's recorded idle time can be read and is not the one the plan read. */
  const woken = (nodeId: string, idleSince: string) => {
    const changedAt = deps.seatState(nodeId)?.changedAt;
    return validIso(changedAt) && changedAt !== idleSince;
  };
  const at = () => deps.now().toISOString();

  return {
    async cycle(job) {
      const active = () => deps.jobsRepo.getById(job.jobId)?.state === "active";
      const found = seatPoolModelOfJob(deps.db, job);
      if (!found.found && found.cause === "no_model_node_id") {
        return { action: "skip", reason: "seat_pool_model_unknown", notes: { modelNodeId: found.modelNodeId } };
      }
      const report = (notes: Record<string, unknown>): PolicyEvaluation => ({ action: "skip", reason: "seat_pool_report", notes });
      if (!found.found) {
        // No custody: the guard can't resolve a node that is gone.
        const held: Held = found.cause === "node_gone"
          ? { cause: "model node gone", message: "held: model node gone" }
          : { cause: "model has no canonical session", message: "held: model has no canonical session" };
        return report({ modelNodeId: found.modelNodeId, slots: slotsView(deps.slots.forModel(found.modelNodeId)), held });
      }
      const { model, modelNodeId, rigId } = found;
      const slots = deps.slots.forModel(modelNodeId);
      let block = blockView(deps.rigRepo.getNodePool(modelNodeId));
      const base = () => ({ modelNodeId, ...block, slots: slotsView(slots) });
      if (!active()) return report({ ...base(), held: JOB_STOPPED });
      if (block.block === "unusable") return report({ ...base(), held: BLOCK_UNREADABLE, advisory: unreadableAdvisory(block.error) });
      // After `pool: {}` the model has no block: the job drains with the spec last stored on its row (`drain` set), and
      // ends once every agent is drained. A job with no readable spec of its own does nothing.
      const removed = block.block === "none";
      const lastSpec = removed ? lastEnsuredSpec(job.context) : null;
      if (block.block === "none" && lastSpec === null) return report(base());
      const spec: SeatPoolSpec = block.block === "stored" ? block.spec : { ...lastSpec!, drain: true };
      const removal = removed ? { removal: "the pool block was removed; draining with the spec last stored on the job" } : {};

      // The plan is read outside the lease; the custody is only for the hold check, the moves and the drain decisions.
      const read: SeatPoolReadState = { ...readSeatPoolState(deps, model, slots), lastStepAt: lastDrainStep(slots) };
      const plan = planSeatPool(spec, read, deps.now().getTime());
      const dispatches = plan.intents.filter((i): i is Extract<SeatPoolIntent, { kind: "dispatch" }> => i.kind === "dispatch");
      const drainIntents = plan.intents.filter((i): i is Extract<SeatPoolIntent, { kind: "drain" }> => i.kind === "drain");
      const plannedTo = (slotNumber: number) => read.agents.find((a) => a.slotNumber === slotNumber)?.sessionName ?? `slot ${slotNumber}`;
      // The session each agent ran when the plan read it: a drain stops only that session.
      const planSession = new Map(read.agents.map((a) => [a.slotNumber, a.nodeId === null ? null : latestSession(deps.db, a.nodeId)?.id ?? null]));

      let held: Held | undefined;
      let advisory: string | undefined;
      let hold: SeatPoolHoldRead | undefined;
      let custody: { code: string; message: string } | undefined;
      let blockChanged = false;
      const moved: Move[] = [];
      const skipped: Array<Move & { code: string }> = [];
      const failed: Array<Move & { code: string; message: string }> = [];
      const drains: DrainReport[] = [];
      const toDrain: DrainStep[] = [];
      const restops: Restop[] = [];

      /** The block again: a re-apply since the plan (cleared, broken, or with any other value; after `pool: {}`, a block
       *  stored again) ends this cycle's effects, since the plan may no longer hold. The next evaluation plans against the
       *  block as it is then. */
      const blockChangedNow = (): boolean => {
        const storedNow = deps.rigRepo.getNodePool(modelNodeId);
        const same = removed
          ? storedNow === undefined
          : storedNow !== undefined && "spec" in storedNow && sameSpec(storedNow.spec, spec);
        if (same) return false;
        blockChanged = true;
        block = blockView(storedNow);
        if (block.block === "unusable") { held = BLOCK_UNREADABLE; advisory = unreadableAdvisory(block.error); }
        return true;
      };
      const drainSkipped = (step: { slotNumber: number; session: string | null; phase: SeatPoolPhase }, code: string): void => {
        drains.push({ ...step, outcome: "skipped", code });
      };

      try {
        await deps.custody([modelNodeId], async () => {
          if (!active()) { held = JOB_STOPPED; return; }
          hold = readSeatPoolHold(deps.db, rigId);
          if (hold.stoppedSeq !== null) {
            held = {
              cause: "rig stopped",
              seq: hold.stoppedSeq,
              message: `held: rig stopped (event ${hold.stoppedSeq})`,
              ...(hold.seatsLaunchedSeq !== null
                ? { exit: `seats launched with \`rig launch --seats\` (event ${hold.seatsLaunchedSeq}) do not end the hold; run \`rig down\`, then \`rig up\`` }
                : {}),
            };
            return;
          }
          // A drain an earlier cycle left unfinished. One whose unconfirmed stop may have had an effect (a kill was
          // attempted) is stopped again below, never captured again. Any other (its capture failed, it ended before the
          // capture, or its stop is known to have had no effect) goes back to `live`: nothing was stopped, and a later plan
          // decides again, with a new capture.
          for (const slot of slots.filter((s) => s.phase === "draining")) {
            const agent = read.agents.find((a) => a.slotNumber === slot.slotNumber);
            const session = agent?.sessionName ?? null;
            const stop = deps.slots.stopOutcome(slot.slotId);
            if (stop?.result === "unconfirmed" && stop.partialEffect === true && typeof stop.sessionId === "string"
              && slot.nodeId !== null && agent?.nodeId && session) {
              restops.push({ slot, nodeId: slot.nodeId, session, sessionId: stop.sessionId });
            } else if (deps.slots.setPhase({ slotId: slot.slotId, from: "draining", to: "live", at: at() })) {
              drains.push({ slotNumber: slot.slotNumber, session, phase: "live", outcome: "returned", code: "drain_not_finished" });
            }
          }
          for (const [index, d] of dispatches.entries()) {
            // A job stopped while an earlier move awaited: no later effect.
            if (!active()) { held = JOB_STOPPED; break; }
            const from = read.rawDestination.get(d.qitemId)!;
            if (blockChangedNow()) {
              for (const rest of dispatches.slice(index)) {
                skipped.push({ qitemId: rest.qitemId, from: read.rawDestination.get(rest.qitemId)!, to: plannedTo(rest.slotNumber), code: "pool_block_changed" });
              }
              break;
            }
            // The agent again, just before the move: still free, no held message, no open row, not above max.
            const agents = readSeatPoolAgents(deps, deps.slots.forModel(modelNodeId));
            const agent = agents.find((a) => a.slotNumber === d.slotNumber);
            if (!agent || agent.sessionName === null || !seatPoolCanReceive(spec, agents, agent)) {
              skipped.push({ qitemId: d.qitemId, from, to: agent?.sessionName ?? plannedTo(d.slotNumber), code: "agent_not_free" });
              continue;
            }
            const to = agent.sessionName;
            const reason = `seat pool ${job.jobId}: ${d.from} had not taken it; ${to} was free`;
            const result = await deps.queue.moveRow({ qitemId: d.qitemId, from, to, reason });
            if (result.ok) moved.push({ qitemId: d.qitemId, from, to });
            else if (ROW_MOVED_ON.has(result.code)) skipped.push({ qitemId: d.qitemId, from, to, code: result.code });
            else failed.push({ qitemId: d.qitemId, from, to, code: result.code, message: result.message });
          }
          // The drains: each agent again, just before its slot goes to `draining`. The capture and the stop come after
          // the custody lease, under the agent's own lifecycle lease.
          for (const [index, d] of drainIntents.entries()) {
            if (held || blockChanged) break;
            if (!active()) { held = JOB_STOPPED; break; }
            if (blockChangedNow()) {
              for (const rest of drainIntents.slice(index)) drainSkipped({ slotNumber: rest.slotNumber, session: plannedTo(rest.slotNumber), phase: "live" }, "pool_block_changed");
              break;
            }
            const current = deps.slots.forModel(modelNodeId);
            const slot = current.find((s) => s.slotNumber === d.slotNumber);
            const agent = readSeatPoolAgents(deps, current).find((a) => a.slotNumber === d.slotNumber);
            const step = { slotNumber: d.slotNumber, session: agent?.sessionName ?? plannedTo(d.slotNumber), phase: slot?.phase ?? "live" };
            if (!slot || !agent || slot.nodeId === null || agent.nodeId === null || agent.sessionName === null) { drainSkipped(step, "agent_gone"); continue; }
            const sessionId = planSession.get(d.slotNumber) ?? null;
            // An agent relaunched since the plan read it is left alone.
            if (sessionId === null || latestSession(deps.db, slot.nodeId)?.id !== sessionId) { drainSkipped(step, "relaunched"); continue; }
            if (slot.phase !== "live" || !freeToDrain(agent) || woken(slot.nodeId, d.idleSince)) { drainSkipped(step, "agent_not_free"); continue; }
            if (!deps.drain) { drainSkipped(step, "drain_not_composed"); continue; }
            if (!deps.slots.setPhase({ slotId: slot.slotId, from: "live", to: "draining", at: at(), stop: null })) { drainSkipped(step, "slot_moved_on"); continue; }
            toDrain.push({ slot, nodeId: slot.nodeId, session: agent.sessionName, sessionId, idleSince: d.idleSince });
          }
        });
      } catch (error) {
        // A refused custody is not a failure: the cycle had no effect.
        if (!(error instanceof DeliveryGuardError)) throw error;
        custody = { code: error.code, message: error.message };
      }

      if (!held && !custody && deps.drain) {
        const effects = deps.drain;
        /** The slot's phase after a write, read back when the write found it moved on. */
        const moveTo = (slot: SeatPoolSlot, to: SeatPoolPhase, stop?: Record<string, unknown> | null): SeatPoolPhase =>
          deps.slots.setPhase({ slotId: slot.slotId, from: "draining", to, at: at(), ...(stop !== undefined ? { stop } : {}) })
            ? to
            : deps.slots.forModel(modelNodeId).find((s) => s.slotId === slot.slotId)?.phase ?? "draining";
        /** The slot after the checked stop: `stopped` and `absent` drain it, `changed_owner` leaves it `live`, and
         *  `unconfirmed` keeps it `draining`, recorded with the session it stopped so the next cycle stops it again. */
        const settle = (
          s: { slot: SeatPoolSlot; session: string; sessionId: string }, stop: SeatPoolSeatStop, snapshotId?: string, attemptedBefore = false,
        ): DrainReport => {
          const reported = seatPoolStopReport(stop);
          const to: SeatPoolPhase = reported.result === "stopped" || reported.result === "absent" ? "drained"
            : reported.result === "changed_owner" ? "live" : "draining";
          // A kill attempted by an earlier stop of the same session stays on record until a stop is confirmed.
          const partial = !stop.ok && (stop.partialEffect === true || attemptedBefore) ? { partialEffect: true } : {};
          const phase = moveTo(s.slot, to, { ...reported, ...partial, sessionId: s.sessionId, at: at() });
          return {
            slotNumber: s.slot.slotNumber, session: s.session, phase,
            outcome: to === "drained" ? "drained" : to === "live" ? "left" : "draining",
            ...(snapshotId !== undefined ? { snapshotId } : {}),
            stop: reported,
          };
        };
        const stopReason = (what: string) => `seat pool ${job.jobId}: ${what}`;
        const phaseNow = (slot: SeatPoolSlot): SeatPoolPhase =>
          deps.slots.forModel(modelNodeId).find((s) => s.slotId === slot.slotId)?.phase ?? "draining";
        /** What keeps an agent from being stopped now, read again at the checked stop's final step before each effect
         *  (after its liveness probe): the job, the rig and model holds, the current block, the agent's work and activity,
         *  and, for a retry (`idleSince` null), whether the pool still has surplus. Null when the stop may go on. */
        const keeps = (slotNumber: number, nodeId: string, idleSince: string | null): string | null => {
          if (!active()) { held = JOB_STOPPED; return "job_stopped"; }
          const modelNow = seatPoolModelOfJob(deps.db, job);
          if (!modelNow.found) {
            held = modelNow.cause === "node_gone"
              ? { cause: "model node gone", message: "held: model node gone" }
              : { cause: "model has no canonical session", message: "held: model has no canonical session" };
            return "model_held";
          }
          const holdNow = readSeatPoolHold(deps.db, rigId);
          if (holdNow.stoppedSeq !== null) {
            held = { cause: "rig stopped", seq: holdNow.stoppedSeq, message: `held: rig stopped (event ${holdNow.stoppedSeq})` };
            return "rig_stopped";
          }
          if (blockChangedNow()) return "pool_block_changed";
          const now = readSeatPoolState(deps, model, deps.slots.forModel(modelNodeId));
          const agent = now.agents.find((a) => a.slotNumber === slotNumber);
          if (!agent || agent.phase !== "draining") return "slot_moved_on";
          // An agent that no longer runs keeps nothing: the stop only confirms it is gone.
          if (!agent.running) return null;
          if (agent.openRows > 0 || agent.heldCount > 0) return "work_arrived";
          if (!agent.idleAtPrompt || (idleSince !== null && woken(nodeId, idleSince))) return "woken";
          if (idleSince === null) {
            // A stop already attempted is finished only while the pool still has surplus, the draining agents counted as
            // serving.
            const serving = now.agents.map((a) => (a.phase === "draining" ? { ...a, phase: "live" as const } : a));
            if (planSeatPool(spec, { ...now, agents: serving }, deps.now().getTime()).surplus === 0) return "no_surplus";
          }
          return null;
        };
        /** The recheck the checked stop runs, and the code it refused with (the stop itself reports `selection_changed`). */
        const recheckOf = (slotNumber: number, nodeId: string, idleSince: string | null) => {
          const refused: { code: string | null } = { code: null };
          const recheck = () => {
            const code = keeps(slotNumber, nodeId, idleSince);
            if (code === null) return null;
            refused.code = code;
            return { ok: false as const, code: "selection_changed" as const, message: `The seat pool drain stops nothing: ${code} right before the stop.` };
          };
          return { refused, recheck };
        };

        for (const r of restops) {
          if (!active()) { held = JOB_STOPPED; break; }
          const step = { slotNumber: r.slot.slotNumber, session: r.session };
          try {
            drains.push(await effects.lifecycle([r.nodeId], async (): Promise<DrainReport> => {
              if (!active()) { held = JOB_STOPPED; return { ...step, phase: "draining", outcome: "draining", code: "job_stopped" }; }
              // The block again, under the lease: one changed or unreadable while the lease was awaited ends this cycle's
              // effects. A kill was attempted, so the slot stays `draining` and a later cycle stops it again.
              if (blockChangedNow()) return { ...step, phase: "draining", outcome: "draining", code: "pool_block_changed" };
              // The agent again, under its lifecycle lease: one that still runs and got work or is not idle is never
              // stopped. A kill was attempted, so it is not given back to `live` either: the slot stays `draining`, and a
              // later cycle stops it once it is free.
              const agent = readSeatPoolAgents(deps, deps.slots.forModel(modelNodeId)).find((a) => a.slotNumber === r.slot.slotNumber);
              if (!agent || agent.phase !== "draining") return { ...step, phase: agent?.phase ?? "draining", outcome: "skipped", code: "slot_moved_on" };
              if (agent.running && (agent.openRows > 0 || agent.heldCount > 0 || !agent.idleAtPrompt)) {
                return { ...step, phase: "draining", outcome: "draining", code: agent.openRows > 0 || agent.heldCount > 0 ? "work_arrived" : "woken" };
              }
              const { refused, recheck } = recheckOf(r.slot.slotNumber, r.nodeId, null);
              const stop = await effects.stopSeat({
                seatRef: r.session, reason: stopReason("the drain's stop was unconfirmed; stopping again"),
                expected: { nodeId: r.nodeId, sessionId: r.sessionId }, recheck,
              });
              // Refused at the stop's final step before any effect: the earlier attempt stays on record, and the slot stays
              // `draining` until a later cycle finishes it.
              if (refused.code !== null && !stop.ok && stop.partialEffect !== true) {
                return { ...step, phase: phaseNow(r.slot), outcome: "draining", code: refused.code };
              }
              return settle(r, stop, undefined, true);
            }));
          } catch (error) {
            // The guard refused the lease. A stop was already tried, so the slot stays `draining` until one is confirmed.
            if (!(error instanceof DeliveryGuardError)) throw error;
            drains.push({ ...step, phase: "draining", outcome: "draining", code: error.code, message: error.message });
          }
        }

        for (const [index, t] of toDrain.entries()) {
          // A job stopped, or a block changed, while an earlier drain awaited: no later effect. The slots left
          // `draining` go back to `live` in the next cycle, with nothing stopped.
          if (held) break;
          if (!active()) { held = JOB_STOPPED; break; }
          if (blockChangedNow()) {
            for (const rest of toDrain.slice(index)) drainSkipped({ slotNumber: rest.slot.slotNumber, session: rest.session, phase: "draining" }, "pool_block_changed");
            break;
          }
          const step = { slotNumber: t.slot.slotNumber, session: t.session };
          const back = (outcome: "returned" | "left", code: string, message?: string): DrainReport =>
            ({ ...step, phase: moveTo(t.slot, "live"), outcome, code, ...(message !== undefined ? { message } : {}) });
          try {
            drains.push(await effects.lifecycle([t.nodeId], async (): Promise<DrainReport> => {
              // The agent again, under its lifecycle lease.
              const agent = readSeatPoolAgents(deps, deps.slots.forModel(modelNodeId)).find((a) => a.slotNumber === t.slot.slotNumber);
              if (!agent || agent.phase !== "draining") return { ...step, phase: agent?.phase ?? "draining", outcome: "skipped", code: "slot_moved_on" };
              // Relaunched since the plan read it (or no longer running): someone's seat now, left alone.
              if (latestSession(deps.db, t.nodeId)?.id !== t.sessionId) return back("left", "relaunched");
              if (!agent.running) return back("left", "not_running");
              // A row or a held message reached it, or something woke it: it serves, and nothing is stopped.
              if (agent.openRows > 0 || agent.heldCount > 0) return back("returned", "work_arrived");
              if (!agent.idleAtPrompt || woken(t.nodeId, t.idleSince)) return back("returned", "woken");
              if (!active()) { held = JOB_STOPPED; return { ...step, phase: "draining", outcome: "draining", code: "job_stopped" }; }
              // The block again, under the lease: one changed or unreadable while the lease was awaited ends this cycle's
              // effects before any capture. Nothing was stopped, so the slot goes back to `live` in a later cycle.
              if (blockChangedNow()) return { ...step, phase: "draining", outcome: "draining", code: "pool_block_changed" };
              // The agent's resume metadata, refreshed as `rig down` does before its snapshot. Best-effort: a refresh that
              // fails still captures and stops.
              try {
                await effects.refresh({ rigId, nodeId: t.nodeId, sessionId: t.sessionId });
              } catch {
                // best-effort, as in teardown
              }
              // The capture, while the agent still runs, right before the stop. A capture that fails stops nothing.
              let snapshotId: string;
              try {
                snapshotId = effects.capture(rigId).snapshotId;
              } catch (error) {
                return { ...step, phase: "draining", outcome: "draining", code: "capture_failed", message: errorMessage(error) };
              }
              // The attempt goes on record before the stop: a daemon exit after the stop took effect and before its result
              // is written leaves the slot `draining` with it, and the next cycle stops the recorded session again instead
              // of giving back to `live` an agent that no longer runs. The result below replaces it.
              const inFlight = { cause: "drain", result: "unconfirmed", code: "stop_in_flight", partialEffect: true, sessionId: t.sessionId, at: at() };
              if (!deps.slots.setPhase({ slotId: t.slot.slotId, from: "draining", to: "draining", at: at(), stop: inFlight })) {
                const phase = deps.slots.forModel(modelNodeId).find((s) => s.slotId === t.slot.slotId)?.phase ?? "draining";
                return { ...step, phase, outcome: "skipped", code: "slot_moved_on" };
              }
              const { refused, recheck } = recheckOf(t.slot.slotNumber, t.nodeId, t.idleSince);
              const stop = await effects.stopSeat({
                seatRef: t.session, reason: stopReason(`idle since ${t.idleSince}; drained`),
                expected: { nodeId: t.nodeId, sessionId: t.sessionId }, recheck,
              });
              // Refused at the stop's final step before any effect: nothing was stopped, and the attempt record goes. An
              // agent that got work or woke serves again; otherwise the slot goes back to `live` in a later cycle.
              if (refused.code !== null && !stop.ok && stop.partialEffect !== true) {
                if (refused.code === "work_arrived" || refused.code === "woken") {
                  return { ...step, phase: moveTo(t.slot, "live", null), outcome: "returned", code: refused.code, snapshotId };
                }
                return { ...step, phase: moveTo(t.slot, "draining", null), outcome: "draining", code: refused.code, snapshotId };
              }
              return settle(t, stop, snapshotId);
            }));
          } catch (error) {
            // The guard refused the lease: nothing was captured or stopped, and the agent serves again.
            if (!(error instanceof DeliveryGuardError)) throw error;
            drains.push(back("returned", error.code, error.message));
          }
        }
      }

      const restore = !held && hold && hold.unfinishedRestoreSeq !== null
        ? {
          seq: hold.unfinishedRestoreSeq,
          completed: false,
          message: `restore at event ${hold.unfinishedRestoreSeq} has no restore.completed; nothing is held without a rig.stopped`,
        }
        : undefined;
      const notes = {
        ...base(),
        ...removal,
        ...(held ? { held } : {}),
        ...(advisory ? { advisory } : {}),
        ...(restore ? { restore } : {}),
        ...(moved.length ? { moved } : {}),
        ...(skipped.length ? { skipped } : {}),
        ...(failed.length ? { failed } : {}),
        ...(drains.length ? { drains } : {}),
        ...(custody ? { custody } : {}),
      };
      // After `pool: {}`: the job ends once every agent is drained (busy agents stay `live` until they are free).
      if (removed && !held && !custody && !blockChanged && deps.slots.forModel(modelNodeId).every((s) => s.phase === "drained")) {
        return { action: "terminal", reason: "seat_pool_removed_drained", notes };
      }
      return report(notes);
    },
  };
}
