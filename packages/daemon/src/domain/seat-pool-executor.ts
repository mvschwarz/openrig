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
import type { SeatPoolSpec, StoredSeatPool } from "./seat-pool-spec.js";
import { deriveCanonicalSessionName } from "./session-name.js";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";

// #3395 (Piece 1): the seat-pool executor, which the `seat-pool` policy hands each evaluation to.
//
// One cycle reads the pool afresh (the model's stored block, its slot rows, each pool agent's latest session, activity,
// open rows and held messages, and the rows waiting for the model or for a drained agent), plans with the pure planner,
// and applies the one effect it has so far: moving a waiting row to a free pool agent. The plan is read outside any
// lease; the hold check and the moves run under the delivery guard's custody lease on the model node, and each move
// re-checks the stored block and the agent just before it.
//
// The whole pool is held, and nothing moves, while the job is not `active`, while the stored block can't be read, while
// the model node is gone (or has no canonical session), and from the rig's latest `rig.stopped` until a later
// `restore.completed`, whatever its result. The cause goes in the job's notes. Adding, draining and bringing agents back
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
  slots: Pick<SeatPoolSlotsRepository, "forModel">;
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
}

export interface SeatPoolExecutor {
  /** One cycle of the job: read, hold, plan, move. Never throws for a refused move or a custody refusal. */
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

export function makeSeatPoolExecutor(deps: SeatPoolExecutorDeps): SeatPoolExecutor {
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
      if (block.block === "none") return report(base());
      if (block.block === "unusable") return report({ ...base(), held: BLOCK_UNREADABLE, advisory: unreadableAdvisory(block.error) });

      // The plan is read outside the lease; the custody is only for the hold check and the moves.
      const spec = block.spec;
      const read = readSeatPoolState(deps, model, slots);
      const plan = planSeatPool(spec, read, deps.now().getTime());
      const dispatches = plan.intents.filter((i): i is Extract<SeatPoolIntent, { kind: "dispatch" }> => i.kind === "dispatch");
      const plannedTo = (slotNumber: number) => read.agents.find((a) => a.slotNumber === slotNumber)?.sessionName ?? `slot ${slotNumber}`;

      let held: Held | undefined;
      let advisory: string | undefined;
      let hold: SeatPoolHoldRead | undefined;
      let custody: { code: string; message: string } | undefined;
      const moved: Move[] = [];
      const skipped: Array<Move & { code: string }> = [];
      const failed: Array<Move & { code: string; message: string }> = [];
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
          for (const [index, d] of dispatches.entries()) {
            // A job stopped while an earlier move awaited: no later effect.
            if (!active()) { held = JOB_STOPPED; break; }
            const from = read.rawDestination.get(d.qitemId)!;
            // The block again: a re-apply since the plan (cleared, broken or with any other value) stops the planned moves
            // here, since the plan may no longer hold (a new dispatch_tag, a longer dispatch_after_s, drain, a lower max).
            // The next evaluation plans against the block as it is then.
            const storedNow = deps.rigRepo.getNodePool(modelNodeId);
            if (storedNow === undefined || !("spec" in storedNow) || !sameSpec(storedNow.spec, spec)) {
              block = blockView(storedNow);
              if (block.block === "unusable") { held = BLOCK_UNREADABLE; advisory = unreadableAdvisory(block.error); }
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
        });
      } catch (error) {
        // A refused custody is not a failure: the cycle had no effect.
        if (!(error instanceof DeliveryGuardError)) throw error;
        custody = { code: error.code, message: error.message };
      }

      const restore = !held && hold && hold.unfinishedRestoreSeq !== null
        ? {
          seq: hold.unfinishedRestoreSeq,
          completed: false,
          message: `restore at event ${hold.unfinishedRestoreSeq} has no restore.completed; nothing is held without a rig.stopped`,
        }
        : undefined;
      return report({
        ...base(),
        ...(held ? { held } : {}),
        ...(advisory ? { advisory } : {}),
        ...(restore ? { restore } : {}),
        ...(moved.length ? { moved } : {}),
        ...(skipped.length ? { skipped } : {}),
        ...(failed.length ? { failed } : {}),
        ...(custody ? { custody } : {}),
      });
    },
  };
}
