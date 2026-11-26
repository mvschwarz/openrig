import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ArbitratedSeatState } from "./activity-taxonomy.js";
import { readClaudeAutoModeForLaunch } from "./claude-auto-mode.js";
import { reserveOperation, type RecordCreated } from "./operation-correlation.js";
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
import type { NodeWithBinding } from "./types.js";
import { DeliveryGuardError } from "./seat-delivery-guard.js";
import { seatPoolModelOfJob, type SeatPoolModel } from "./seat-pool-registration.js";
import { readAttemptOutcome, type SeatPoolSlot, type SeatPoolSlotsRepository } from "./seat-pool-slots.js";
import { parsePoolBlock, type SeatPoolSpec, type StoredSeatPool } from "./seat-pool-spec.js";
import { deriveCanonicalSessionName } from "./session-name.js";
import { seatLaunchAdditionPathsForNode } from "./seat-launch-additions.js";
import type { SeatSkillPaths } from "./seat-skill-storage.js";
import type { AddMemberOutcome } from "./rigspec-instantiator.js";
import { launchStatusIsRunning } from "./restore-orchestrator.js";
import type { ComebackSnapshotSelection } from "./snapshot-repository.js";
import type { ConvergeResult, TopologyOp } from "./topology-converge.js";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";

// #3395 (Piece 1): the seat-pool executor, which the `seat-pool` policy hands each evaluation to.
//
// One cycle reads the pool afresh (the model's stored block, its slot rows, each pool agent's latest session, activity,
// open rows and held messages, and the rows waiting for the model or for a drained agent), plans with the pure planner,
// and applies three effects: moving a waiting row to a free pool agent, draining a free agent idle past
// `idle_grace_s`, and adding agents. The plan is read outside any lease; the hold check, the moves, each drain's
// decision and the add's reservation and issue run under the delivery guard's custody lease on the model node, and each
// move and drain re-checks the stored block and the agent just before it.
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
// Each unit of an add first brings back the lowest eligible `drained` slot (one with no reuse hold): the comeback. It
// picks the newest snapshot that is restore-usable, holds the slot's node with its logical id, and recorded exactly one
// active occupant for it, whatever its kind; with none, the slot stays `drained` with the pool's own reuse hold
// `no_qualifying_snapshot`, and the unit tries the next eligible slot. A newer usable capture holding the node that
// recorded two or more live occupants for it stops the search for that slot: it stays `drained` with the reuse hold
// `conflicting_occupants`, naming the snapshot and the candidates, and the unit tries the next eligible slot; an
// occupancy the capture can't tell is named (`unknown`) and skipped. A chosen snapshot reserves the comeback on the
// slot's own row and issues it under the lease; after the lease is released, the executor's `comeback` launches the
// slot's own node through `launchSingleNode` with that explicit `snapshotId`, never without one, so the agent comes back
// with its own sessions and stored settings. It settles running (`live`), or, refused before any launch, `drained` with
// the refusal's code as its reuse hold, so the same snapshot is never sent again. Right before its launch the job and the
// rig are read again: with the job stopped or the rig down, it is never launched and the slot is `drained` again. Only
// when no eligible slot is left does the unit take a new number.
//
// A new number reserves a new `<member>-s<n>` slot, issues it with an operation id, and, after the lease is released, adds
// the member through the same converge path as `rig add`, from the model member as the export writes it (without
// `pool`, `id`, `label`, `cwd` and `session_source`, and with `keep_alive: false`). Just before the issue, under the same
// lease, the cycle reads the stored block, the job and the holds again and plans again with the reservation counted: a
// lower `max`, `drain: true`, any other change to the block, a hold or surplus that reaches the reservation cancels it
// (`cancelled: not issued`), with no operation row and no call. The cycle does not wait for the launch: it reports the add
// in flight, and the settlement writes the outcome to the slot row, by the node's latest session: running and ready, the
// slot is `live`; exited, or the node's executor confirmed stopped, the slot is `drained` with a reuse hold and never tried
// again (`not_running`, with what was observed); no node was created, the row goes and frees the number (`no_node`);
// anything else stays issued and `unknown`, and is read again every cycle. A later cycle reports what settled.
//
// The attempts in flight in this process are kept in memory. A cycle settles under the custody lease what no process is
// running any more: a `reserved` row is cancelled; an `issued` one that is not in flight here (an add cut off by a daemon
// restart, or one left `unknown`) is read again through its operation id, by replaying `reserveOperation` with what the
// add was issued on. No node recorded: the row goes (`not launched (interrupted before create)`); a node: settled by the
// same rule as above. The add is never issued again.
//
// The whole pool is held, and nothing moves, drains, comes back or is added, while the job is not `active`, while the
// stored block can't be read, while the model node is gone (or has no canonical session), and from the rig's latest
// `rig.stopped` until a later `restore.completed`, whatever its result. The cause goes in the job's notes.
//
// While an add that settled `not_running` keeps its slot `drained` with its reuse hold, a unit with no eligible drained
// slot left to bring back takes no new number, and the add's notes name that attempt and what was observed. An ordinary
// drained slot, a comeback's reuse hold and an `unknown` add (still `adding`) hold no new number.

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

/** The member add the pool issues: a pod member fragment, as `rig add` sends it. */
export type SeatPoolAddOp = Extract<TopologyOp, { kind: "add_member" }>;

/** The add's effects, as the daemon composes them. */
export interface SeatPoolAddDeps {
  /** The model member as the pod-aware export writes it, in the spec's own keys (RigSpecExporter.exportedRawMemberFromNode).
   *  Throws when the member can't be exported. */
  exportMember(rigId: string, modelNodeId: string): Record<string, unknown>;
  /** One member added to a pod and launched, as `POST /rigs/:rigId/pods/:pod/members` does it: convergeOp over the
   *  daemon's instantiator. */
  converge(rigId: string, op: SeatPoolAddOp, rigRoot: string,
    opts: { recordCreated: RecordCreated; launchAdditionsFrom?: SeatSkillPaths }): Promise<ConvergeResult>;
  /** Creates a folder and its parents (mkdir -p): all the daemon does for a `cwd_template` folder. */
  makeFolder(path: string): void;
}

/** What a comeback's launch returned, as the pool reads it (RestoreOrchestrator.launchSingleNode's result). */
export interface SeatPoolComebackLaunch {
  ok: boolean;
  code?: string;
  message?: string;
  launched?: Array<{ nodeId: string; logicalId: string; status: string; error?: string }>;
  alreadyRunning?: Array<{ nodeId: string; logicalId: string }>;
  snapshotSelection?: { snapshotId: string; mode: "explicit" | "automatic" };
}

/** The comeback's effects, as the daemon composes them. */
export interface SeatPoolComebackDeps {
  /** The newest snapshot that qualifies for the slot's node, with how many were read and the condition each other one
   *  failed (SnapshotRepository.selectComebackSnapshot). Read only. */
  select(rigId: string, nodeId: string, logicalId: string): ComebackSnapshotSelection;
  /** Launch the slot's own node from exactly this snapshot (RestoreOrchestrator.launchSingleNode with the explicit
   *  `snapshotId`, the daemon's runtime adapters and the filesystem). There is no call without a snapshot id. */
  launch(rigId: string, logicalId: string, opts: { snapshotId: string }): Promise<SeatPoolComebackLaunch>;
}

/** One comeback issued under the model's custody lease, for the executor's `comeback` to launch after it. */
export interface SeatPoolComebackRequest {
  /** The job that issued it: read again right before the launch. */
  jobId: string;
  modelNodeId: string;
  rigId: string;
  slotId: string;
  slotNumber: number;
  /** The slot's node and its logical id: the agent that comes back, on the same node. */
  nodeId: string;
  logicalId: string;
  attemptId: string;
  /** The snapshot the attempt was issued on. */
  snapshotId: string;
  /** True when the pool block has no `cwd_template`: the slot took the model's folder, so `cwd` is compared too. */
  cwdFromModel: boolean;
}

export interface SeatPoolExecutorDeps {
  /** The job's model, the agents' latest sessions and the rig's events. */
  db: Database.Database;
  rigRepo: Pick<RigRepository, "getNodePool" | "getNodeLaunchRecipe" | "getRig">;
  slots: Pick<SeatPoolSlotsRepository, "forModel" | "setPhase" | "stopOutcome" | "get" | "reserveAdd" | "issueAttempt"
    | "recordAttemptNode" | "settleAdd" | "settleAddNotRunning" | "recordAttemptOutcome" | "removeAddWithoutNode" | "cancelReservedAdd"
    | "reserveComeback" | "holdComeback" | "settleComebackRefused" | "returnComebackToDrained">;
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
  /** The add's effects. Without them a cycle takes no new number. */
  add?: SeatPoolAddDeps;
  /** The comeback's effects. Without them (or without the executor's `comeback`) no drained slot is brought back, and a
   *  unit that finds an eligible drained slot takes no new number either. Without these and `add`, a cycle skips the
   *  whole add stage. */
  comeback?: SeatPoolComebackDeps;
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
  /** One cycle of the job: read, hold, plan, move, drain, add. Never throws for a refused move or a custody refusal. */
  cycle(job: Pick<PolicyJob, "jobId" | "context">): Promise<PolicyEvaluation>;
  /** Resolves once every add and comeback started so far has settled. */
  idle(): Promise<void>;
  /** Brings one issued comeback back: launches the slot's own node through `launchSingleNode` with the snapshot the
   *  attempt was issued on, and settles the attempt on the slot row. The cycle calls it for each comeback it issued,
   *  after the custody lease is released; the model's next report says what settled. Never rejects. */
  comeback(request: SeatPoolComebackRequest): Promise<void>;
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

/** The model's pod namespace: its logical id before the first dot (a resolved model always has one). */
function modelPod(db: Database.Database, modelNodeId: string): string | null {
  const row = db.prepare("SELECT logical_id FROM nodes WHERE id = ?").get(modelNodeId) as { logical_id: string } | undefined;
  const dot = row ? row.logical_id.indexOf(".") : -1;
  return dot > 0 ? row!.logical_id.slice(0, dot) : null;
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
      attemptState: slot.attemptState,
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

/**
 * How an attempt is reported, in `attempt.status`, never as a stop. An add: `in_flight` (reserved or issued, its call not
 * settled), `cancelled` (not issued), `running`, `no_node` (no node was created), `not_running` (a node that does not run,
 * with what was `observed`: its latest session `exited`, or its executor confirmed stopped, `probe_absent`) and `unknown`
 * (issued, with a node whose result can't be told yet; read again every cycle). A comeback: `in_flight` until it settles,
 * then `running` (with the snapshot it was launched from) or `refused` before any launch, with its code.
 */
interface AttemptView {
  id: string;
  status: "in_flight" | "cancelled" | "running" | "no_node" | "not_running" | "unknown" | "refused";
  observed?: "exited" | "probe_absent";
  message?: string;
  code?: string;
  snapshotSelection?: { snapshotId: string; mode: string };
}

function inFlight(attemptId: string): AttemptView {
  return { id: attemptId, status: "in_flight", message: `in flight (attempt ${attemptId})` };
}

const CANCELLED_NOT_ISSUED = "cancelled: not issued";
const INTERRUPTED_BEFORE_CREATE = "not launched (interrupted before create)";

/** A JSON object kept on a slot row; null when there is none or it isn't one. */
function slotRecord(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A slot's attempt as its row records it. A comeback first: in flight until it settles, then `refused` with its code or
 *  `running` with its snapshot. An add: an issued one with an `unknown` outcome is reported so, and a settled one by the
 *  status its outcome kept (a settled add with no such status settled running). */
function attemptView(slot: SeatPoolSlot): AttemptView | undefined {
  if (slot.attemptId === null || slot.attemptState === null) return undefined;
  const outcome = readAttemptOutcome(slot.attemptOutcome);
  if (slot.attemptKind === "comeback") {
    if (slot.attemptState !== "settled") return inFlight(slot.attemptId);
    if (outcome["ok"] === false) {
      return { id: slot.attemptId, status: "refused", ...(typeof outcome["code"] === "string" ? { code: outcome["code"] } : {}) };
    }
    const selection = outcome["snapshotSelection"] as AttemptView["snapshotSelection"] | undefined;
    return { id: slot.attemptId, status: "running", ...(selection ? { snapshotSelection: selection } : {}) };
  }
  const text = (key: string) => (typeof outcome[key] === "string" ? { [key]: outcome[key] as string } : {});
  if (slot.attemptState === "settled") {
    if (outcome["status"] !== "not_running") return { id: slot.attemptId, status: "running" };
    return {
      id: slot.attemptId, status: "not_running",
      ...(outcome["observed"] === "exited" || outcome["observed"] === "probe_absent" ? { observed: outcome["observed"] } : {}),
      ...text("code"), ...text("message"),
    };
  }
  if (slot.attemptState === "issued" && outcome["status"] === "unknown") {
    return { id: slot.attemptId, status: "unknown", ...text("code"), ...text("message") };
  }
  return inFlight(slot.attemptId);
}

/** The slots as reported: each one's attempt and, on a slot the pool does not bring back, its reuse hold, every cycle. */
function slotsView(slots: readonly SeatPoolSlot[]): Array<{
  slotNumber: number; nodeId: string | null; phase: SeatPoolPhase; attempt?: AttemptView; reuseHold?: Record<string, unknown>;
}> {
  return slots.map((slot) => {
    const attempt = attemptView(slot);
    return {
      slotNumber: slot.slotNumber,
      nodeId: slot.nodeId,
      phase: slot.phase,
      ...(attempt ? { attempt } : {}),
      ...(slot.reuseHold !== null ? { reuseHold: slotRecord(slot.reuseHold) ?? { unreadable: slot.reuseHold } } : {}),
    };
  });
}

/** An add that settled `not_running` (its latest session exited, or its executor confirmed stopped) and keeps its slot
 *  `drained` with its reuse hold. While one is on record, no new number is taken: persistent demand and a launch that
 *  keeps failing would otherwise take another number after each cooldown. Not an ordinary drained slot, a comeback's
 *  reuse hold (a refusal is a `comeback` attempt; `holdComeback` keeps the slot's add attempt, which settled running) or
 *  an `unknown` add (still `adding`). */
function confirmedFailedAdd(slot: SeatPoolSlot): boolean {
  return slot.phase === "drained" && slot.attemptKind === "add" && slot.attemptState === "settled" && slot.attemptId !== null
    && slot.reuseHold !== null && readAttemptOutcome(slot.attemptOutcome)["status"] === "not_running";
}

/** The add's notes while a confirmed failed add holds the new number: that attempt, its slot and its evidence. */
function failedAddHeld(slot: SeatPoolSlot): Record<string, unknown> {
  const attempt = attemptView(slot)!;
  return {
    held: `held: failed add ${slot.attemptId} (slot ${slot.slotNumber}) settled not_running${attempt.observed ? ` (${attempt.observed})` : ""}`,
    failedAdd: {
      slotNumber: slot.slotNumber, nodeId: slot.nodeId, attempt,
      reuseHold: slotRecord(slot.reuseHold) ?? { unreadable: slot.reuseHold },
    },
  };
}

/** The refusals a comeback's launch returns before any launch: the slot goes back to `drained` with the code as its
 *  reuse hold, and the same snapshot is never sent again. */
const COMEBACK_REFUSALS: ReadonlySet<string> = new Set([
  "snapshot_not_found", "snapshot_wrong_rig", "snapshot_unusable", "no_matching_nodes", "selection_changed",
]);
/** The model member's keys an agent does not take: it gets its own id and folder, no pool, no conversation of the
 *  model's, and its own `keep_alive: false` (below). */
const NOT_INHERITED = ["pool", "id", "label", "cwd", "session_source", "keep_alive"];

/** One add issued in a cycle, waiting for its call after the lease is released. */
interface IssuedAdd {
  slotId: string;
  slotNumber: number;
  logicalId: string;
  attemptId: string;
  rigId: string;
  op: SeatPoolAddOp;
  rigRoot: string;
  /** The `cwd_template` folder to create before the add; null without a template. */
  folder: string | null;
  launchAdditionsFrom: SeatSkillPaths | undefined;
  operation: Extract<ReturnType<typeof reserveOperation>, { state: "fresh" }>;
}

/** What one add or comeback settled as, reported by the model's next cycle. A comeback whose stored settings differ
 *  from the model's carries a warning naming the fields. */
interface SettledAdd { slotNumber: number; logicalId: string; nodeId?: string; attempt: AttemptView; warning?: string }

/** What a cycle reports for a drained slot it looked at: the comeback issued (with its snapshot and attempt, and the
 *  newer captures skipped because they can't tell the occupant), the reuse hold it got (no snapshot qualifies, or the
 *  newest usable one recorded conflicting occupants), or why nothing was issued (`code`). */
interface ComebackNote {
  slotNumber: number;
  logicalId: string;
  nodeId: string;
  snapshotId?: string;
  attempt?: AttemptView;
  unknownOccupants?: Array<{ snapshotId: string; candidateIds: string[]; detail: string }>;
  hold?: Record<string, unknown>;
  code?: string;
}

/** A new number's inputs, read from the model once per cycle, when a unit first needs one. */
interface NewNumberInputs {
  raw: Record<string, unknown>;
  inherited: Record<string, unknown>;
  pod: string;
  rigRoot: string;
  launchAdditionsFrom: SeatSkillPaths | undefined;
}

/** The outcome of the add call, as kept on the slot row. */
type AddCallOutcome =
  | { ok: true; status: string; nodeId: string; error?: string; sessionName?: string }
  | { ok: false; code: string; message: string };

function addCallOutcome(outcome: AddMemberOutcome): AddCallOutcome {
  if (!outcome.ok) return { ok: false, code: outcome.code, message: "message" in outcome ? outcome.message : outcome.errors.join("; ") };
  const node = outcome.result.node;
  return {
    ok: true, status: node.status, nodeId: node.nodeId,
    ...(node.error ? { error: node.error } : {}), ...(node.sessionName ? { sessionName: node.sessionName } : {}),
  };
}

/** What an add with a node settles as, from the add call's outcome (null when it is not known: the add was cut off) and
 *  the node's latest session. */
type AddSettlement =
  | { status: "running"; sessionId: string }
  | { status: "not_running"; observed: "exited" | "probe_absent"; code?: string; message?: string }
  | { status: "unknown"; code: string; message: string };

/**
 * The one rule an add with a node settles by, in the cycle that ran it and in a later cycle (or process) that reads it
 * again. Exited, or the node's executor confirmed stopped: not running, never retried. Running or idle with startup
 * `ready`: running, unless the call is known to have returned anything but a launch (a failed launch whose session
 * still runs is not settled here). Anything else (startup not ready, no session, another status): unknown.
 */
function classifyAdd(
  call: AddCallOutcome | null,
  latest: { id: string; status: string; startupStatus: string | null } | null,
  confirmedStopped: boolean,
): AddSettlement {
  const failure = call === null ? {}
    : call.ok ? (call.error ? { message: call.error } : {})
    : { code: call.code, message: call.message };
  if (latest?.status === "exited") return { status: "not_running", observed: "exited", ...failure };
  if (confirmedStopped) return { status: "not_running", observed: "probe_absent", ...failure };
  if (latest === null) return { status: "unknown", code: "no_session", message: "unknown: the node has no session yet" };
  const evidence = `latest session ${latest.status}, startup ${latest.startupStatus ?? "unknown"}`;
  if (latest.status === "running" || latest.status === "idle") {
    if (call !== null && !(call.ok && call.status === "launched")) {
      return { status: "unknown", code: call.ok ? `node_${call.status}` : call.code, message: `unknown: the add returned ${call.ok ? call.status : call.code}; ${evidence}` };
    }
    if (latest.startupStatus === "ready") return { status: "running", sessionId: latest.id };
  }
  return { status: "unknown", code: "not_settled", message: `unknown: ${evidence}` };
}

/** The add call's outcome an `unknown` attempt kept on its row, or null when the call never returned. */
function keptCall(slot: SeatPoolSlot): AddCallOutcome | null {
  const call = readAttemptOutcome(slot.attemptOutcome)["call"];
  if (call === null || typeof call !== "object" || Array.isArray(call)) return null;
  const c = call as Record<string, unknown>;
  if (c["ok"] === true && typeof c["status"] === "string" && typeof c["nodeId"] === "string") return c as unknown as AddCallOutcome;
  if (c["ok"] === false && typeof c["code"] === "string" && typeof c["message"] === "string") return c as unknown as AddCallOutcome;
  return null;
}

/** What an add was issued on (`attempt_basis`), or null when the row's basis can't be read. */
function issuedBasis(text: string | null): { targets: string[]; body: string } | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { targets?: unknown; body?: unknown };
    return Array.isArray(parsed.targets) && parsed.targets.every((t) => typeof t === "string") && typeof parsed.body === "string"
      ? { targets: parsed.targets as string[], body: parsed.body }
      : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A refusal to issue an add, raised inside the issue transaction so it rolls back. */
class AddNotIssued extends Error {
  constructor(readonly code: string) { super(code); }
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

/** A node's logical id; null when the node is gone. */
function nodeLogicalId(db: Database.Database, nodeId: string): string | null {
  return (db.prepare("SELECT logical_id FROM nodes WHERE id = ?").get(nodeId) as { logical_id: string } | undefined)?.logical_id ?? null;
}

/** A value as canonical JSON (object keys sorted), so two settings compare by content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

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

export function makeSeatPoolExecutor(deps: SeatPoolExecutorDeps): SeatPoolExecutor {
  /** Woken since the plan: the agent's recorded idle time can be read and is not the one the plan read. */
  const woken = (nodeId: string, idleSince: string) => {
    const changedAt = deps.seatState(nodeId)?.changedAt;
    return validIso(changedAt) && changedAt !== idleSince;
  };
  const at = () => deps.now().toISOString();

  /** The adds and comebacks started and not settled yet. */
  const pending = new Set<Promise<void>>();
  /** The attempt ids this process issued and whose call has not settled yet. An `issued` row that is not here is no
   *  process's any more: an add cut off by a daemon restart, or one whose result was unknown when its call returned. */
  const inFlightAttempts = new Set<string>();
  /** model node id → what settled since that model's last report. */
  const settled = new Map<string, SettledAdd[]>();
  const reportSettled = (modelNodeId: string, entry: SettledAdd) => settled.set(modelNodeId, [...(settled.get(modelNodeId) ?? []), entry]);

  /** An add with a node, settled by its latest session (classifyAdd). Running: `live`. Not running: `drained`, with a
   *  reuse hold. Unknown: it stays issued, with what was read kept on its row. What settled is returned for the report;
   *  nothing while unknown, or when the row no longer holds the attempt. */
  const settleWithNode = (
    add: { slotId: string; slotNumber: number; logicalId: string; attemptId: string; nodeId: string },
    call: AddCallOutcome | null,
    latest: { id: string; status: string; startupStatus: string | null } | null,
  ): SettledAdd | null => {
    const settlement = classifyAdd(call, latest, deps.confirmedStopped(add.nodeId));
    const entry = (attempt: AttemptView): SettledAdd => ({ slotNumber: add.slotNumber, logicalId: add.logicalId, nodeId: add.nodeId, attempt });
    if (settlement.status === "running") {
      return deps.slots.settleAdd(add.slotId, add.attemptId, {
        outcome: JSON.stringify(call ?? { replayed: true }),
        result: JSON.stringify({ nodeId: add.nodeId, sessionId: settlement.sessionId }), at: at(),
      }) ? entry({ id: add.attemptId, status: "running" }) : null;
    }
    if (settlement.status === "not_running") {
      const seen = {
        observed: settlement.observed,
        ...(settlement.code !== undefined ? { code: settlement.code } : {}),
        ...(settlement.message !== undefined ? { message: settlement.message } : {}),
      };
      // The reuse hold: the launch's status or code (`not_running` when the call never returned), what was observed, and
      // the launch's error when there is one.
      const error = call === null ? undefined : call.ok ? call.error : call.message;
      const hold = {
        code: call === null ? "not_running" : call.ok ? call.status : call.code,
        observed: settlement.observed,
        ...(error !== undefined ? { error } : {}),
      };
      return deps.slots.settleAddNotRunning(add.slotId, add.attemptId, {
        outcome: JSON.stringify({ status: "not_running", ...seen, call }), hold: JSON.stringify(hold), at: at(),
      }) ? entry({ id: add.attemptId, status: "not_running", ...seen }) : null;
    }
    deps.slots.recordAttemptOutcome(add.slotId, add.attemptId,
      JSON.stringify({ status: "unknown", code: settlement.code, message: settlement.message, call }));
    return null;
  };

  /** The model's logical id, for the `<model>-s<n>` of a slot read back from its row. */
  const logicalIdOf = (modelNodeId: string, slotNumber: number): string => {
    const row = deps.db.prepare("SELECT logical_id FROM nodes WHERE id = ?").get(modelNodeId) as { logical_id: string } | undefined;
    return `${row?.logical_id ?? modelNodeId}-s${slotNumber}`;
  };

  /**
   * An add attempt no process is running any more, settled from its row, under the custody lease. Reserved: cancelled.
   * Issued: read again by replaying `reserveOperation` with what it was issued on, which never runs the add again; with
   * no node recorded the row goes, otherwise the node settles it by the same rule as the call that ran it. An operation
   * id with no row is not replayed (that would reserve it anew): unknown, as is any replay that is not one.
   */
  const settleLeftover = (modelNodeId: string, slot: SeatPoolSlot): SettledAdd | null => {
    const attemptId = slot.attemptId!;
    const logicalId = logicalIdOf(modelNodeId, slot.slotNumber);
    if (slot.attemptState === "reserved") {
      return deps.slots.cancelReservedAdd(slot.slotId, attemptId)
        ? { slotNumber: slot.slotNumber, logicalId, attempt: { id: attemptId, status: "cancelled", message: CANCELLED_NOT_ISSUED, code: "interrupted_before_issue" } }
        : null;
    }
    const unknown = (code: string, message: string): null => {
      deps.slots.recordAttemptOutcome(slot.slotId, attemptId, JSON.stringify({ status: "unknown", code, message, call: keptCall(slot) }));
      return null;
    };
    const basis = issuedBasis(slot.attemptBasis);
    if (basis === null) return unknown("basis_unreadable", "unknown: what the add was issued on can't be read");
    if (!deps.db.prepare("SELECT 1 FROM operation_correlations WHERE operation_id = ?").get(attemptId)) {
      return unknown("operation_missing", "unknown: the add's operation id has no record");
    }
    const replayed = reserveOperation(deps.db, attemptId, "member.add", basis.targets, basis.body);
    if (replayed.state !== "replay") return unknown(`operation_${replayed.state}`, `unknown: replaying the add's operation id gave ${replayed.state}`);
    const operation = replayed.operation;
    if (slot.nodeId === null) {
      if (operation.nodeIds.length > 0) return unknown("node_not_recorded", "unknown: the operation recorded a node the slot does not have");
      return deps.slots.removeAddWithoutNode(slot.slotId, attemptId)
        ? { slotNumber: slot.slotNumber, logicalId, attempt: { id: attemptId, status: "no_node", code: "interrupted_before_create", message: INTERRUPTED_BEFORE_CREATE } }
        : null;
    }
    const latest = operation.current.nodes.find((node) => node.id === slot.nodeId)?.latestSession ?? null;
    return settleWithNode({ slotId: slot.slotId, slotNumber: slot.slotNumber, logicalId, attemptId, nodeId: slot.nodeId }, keptCall(slot), latest);
  };

  /** Why the model member gives no agent, read from the model node itself (the export leaves these out silently), or null. */
  const addRefusal = (rigId: string, modelNodeId: string): string | null => {
    let node: NodeWithBinding | undefined;
    try {
      node = deps.rigRepo.getRig(rigId)?.nodes.find((candidate) => candidate.id === modelNodeId);
    } catch (error) {
      return `add refused: the model member can't be read (${errorMessage(error)})`;
    }
    if (!node) return "add refused: the model member can't be read (no such node)";
    if (node.processLimitsError !== undefined) return `add refused: the model's stored process_limits can't be read (${node.processLimitsError})`;
    if (node.runtime === "claude-code") {
      const autoMode = readClaudeAutoModeForLaunch(deps.db, modelNodeId);
      if (autoMode !== undefined && "unreadable" in autoMode) return "add refused: the model's stored claude_auto_mode can't be read";
    }
    if (node.accountHome) return "add refused: the model has an accountHome, which a pool agent does not carry";
    if (node.claudeTokenRef?.kind === "api-key") return "add refused: the model has an api-key token ref, which a pool agent does not carry";
    return null;
  };

  /** The add's call, after the lease, and its settlement on the slot row. Never rejects. */
  const runAdd = async (modelNodeId: string, add: IssuedAdd): Promise<void> => {
    const report = (entry: SettledAdd) => reportSettled(modelNodeId, entry);
    let outcome: AddCallOutcome | undefined;
    try {
      if (add.folder !== null) {
        try { deps.add!.makeFolder(add.folder); } catch (error) { outcome = { ok: false, code: "cwd_unavailable", message: errorMessage(error) }; }
      }
      if (outcome === undefined) {
        // The node id goes to the slot row in the same transaction that creates the node: a rolled-back create leaves both
        // unwritten. The first call names only the rig.
        const recordCreated: RecordCreated = (createdRigId, nodeId) => {
          add.operation.recordCreated(createdRigId, nodeId);
          if (nodeId !== undefined) deps.slots.recordAttemptNode(add.slotId, add.attemptId, nodeId);
        };
        try {
          const converged = await deps.add!.converge(add.rigId, add.op, add.rigRoot, {
            recordCreated, ...(add.launchAdditionsFrom ? { launchAdditionsFrom: add.launchAdditionsFrom } : {}),
          });
          outcome = converged.kind === "add_member" && converged.supported
            ? addCallOutcome(converged.outcome)
            : { ok: false, code: "add_unsupported", message: "the converge path did not run the member add" };
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          outcome = { ok: false, code: typeof code === "string" ? code : "add_failed", message: errorMessage(error) };
        }
      }
      // The node decides, never the code alone: an add can fail after it created its node.
      const slot = deps.slots.get(add.slotId);
      if (!slot || slot.attemptId !== add.attemptId) return; // its row went with a node deleted by hand
      if (slot.nodeId === null) {
        deps.slots.removeAddWithoutNode(add.slotId, add.attemptId);
        const code = outcome.ok ? "node_not_recorded" : outcome.code;
        report({
          slotNumber: add.slotNumber, logicalId: add.logicalId,
          attempt: { id: add.attemptId, status: "no_node", code, ...(outcome.ok ? {} : { message: outcome.message }) },
        });
        return;
      }
      const latest = add.operation.read().current.nodes.find((node) => node.id === slot.nodeId)?.latestSession ?? null;
      // An unknown result stays issued; once this call is over, a later cycle reads it again.
      const entry = settleWithNode({ ...add, nodeId: slot.nodeId }, outcome, latest);
      if (entry) report(entry);
    } catch (error) {
      // The call's outcome stays on the row, so the cycle that reads this attempt again settles it with the call.
      try {
        deps.slots.recordAttemptOutcome(add.slotId, add.attemptId,
          JSON.stringify({ status: "unknown", code: "settle_failed", message: errorMessage(error), call: outcome ?? null }));
      } catch { /* the settle's own error is the one reported */ }
      report({ slotNumber: add.slotNumber, logicalId: add.logicalId, attempt: { ...inFlight(add.attemptId), code: "settle_failed", message: errorMessage(error) } });
    } finally {
      inFlightAttempts.delete(add.attemptId);
    }
  };

  /** The fields of the slot's stored settings that differ from the model's, both read as the export writes them, apart
   *  from the keys an agent never takes from the model. `cwd` is one of those keys only when a `cwd_template` gives the
   *  slot its own folder; without one the slot took the model's folder, so it is compared. Null when they can't both be
   *  read (no warning then). */
  const settingsDiffer = (rigId: string, modelNodeId: string, nodeId: string, cwdFromModel: boolean): string[] | null => {
    if (!deps.add) return null;
    let modelMember: Record<string, unknown>;
    let own: Record<string, unknown>;
    try {
      modelMember = deps.add.exportMember(rigId, modelNodeId);
      own = deps.add.exportMember(rigId, nodeId);
    } catch {
      return null;
    }
    return [...new Set([...Object.keys(modelMember), ...Object.keys(own)])]
      .filter((key) => (!NOT_INHERITED.includes(key) || (cwdFromModel && key === "cwd"))
        && canonical(modelMember[key]) !== canonical(own[key]))
      .sort();
  };

  /** A comeback's call, after the lease, and its settlement on the slot row. Never rejects. */
  const comeback = async (request: SeatPoolComebackRequest): Promise<void> => {
    const report = (entry: SettledAdd) => settled.set(request.modelNodeId, [...(settled.get(request.modelNodeId) ?? []), entry]);
    const base = { slotNumber: request.slotNumber, logicalId: request.logicalId, nodeId: request.nodeId };
    try {
      if (!deps.comeback) {
        report({ ...base, attempt: { ...inFlight(request.attemptId), code: "comeback_not_composed" } });
        return;
      }
      const slot = deps.slots.get(request.slotId);
      if (!slot || slot.attemptId !== request.attemptId || slot.attemptKind !== "comeback" || slot.attemptState !== "issued") return;
      // The job and the rig again, right before the launch: an earlier call of the same cycle may have run while the job
      // was stopped or the rig went down. Held, the comeback is never launched and the slot is `drained` again.
      const rigHold = readSeatPoolHold(deps.db, request.rigId);
      const heldBy = deps.jobsRepo.getById(request.jobId)?.state !== "active" ? JOB_STOPPED.message
        : rigHold.stoppedSeq !== null ? `held: rig stopped (event ${rigHold.stoppedSeq})` : null;
      if (heldBy !== null) {
        const outcome = JSON.stringify({ ok: false, code: "held", message: heldBy, launched: false });
        if (deps.slots.returnComebackToDrained(request.slotId, request.attemptId, outcome)) {
          report({ ...base, attempt: { id: request.attemptId, status: "refused", code: "held", message: heldBy } });
        }
        return;
      }
      // The slot comes back with its own stored settings, never the model's: a difference is only named.
      const differ = settingsDiffer(request.rigId, request.modelNodeId, request.nodeId, request.cwdFromModel);
      const warning = differ && differ.length > 0
        ? { warning: `the slot's stored settings differ from the model's (${differ.join(", ")}); it comes back with its own` }
        : {};
      let launch: SeatPoolComebackLaunch;
      let threw = false;
      try {
        launch = await deps.comeback.launch(request.rigId, request.logicalId, { snapshotId: request.snapshotId });
      } catch (error) {
        threw = true;
        const code = (error as { code?: unknown } | null | undefined)?.code;
        launch = { ok: false, code: typeof code === "string" ? code : "launch_failed", message: errorMessage(error) };
      }
      const node = launch.launched?.find((n) => n.nodeId === request.nodeId) ?? launch.launched?.[0];
      const selection = launch.snapshotSelection
        ? { snapshotId: launch.snapshotSelection.snapshotId, mode: launch.snapshotSelection.mode }
        : undefined;
      const stored = JSON.stringify({
        ok: launch.ok && !threw,
        ...(launch.code !== undefined ? { code: launch.code } : {}),
        ...(launch.message !== undefined ? { message: launch.message } : {}),
        ...(threw ? { threw: true } : {}),
        ...(node ? { nodeId: node.nodeId, status: node.status, ...(node.error ? { error: node.error } : {}) } : {}),
        ...(launch.alreadyRunning?.length ? { alreadyRunning: launch.alreadyRunning.map((n) => n.nodeId) } : {}),
        ...(selection ? { snapshotSelection: selection } : {}),
      });
      // Running, on the same node: settled, and the slot `live`.
      if (!threw && launch.ok && node && node.nodeId === request.nodeId && launchStatusIsRunning(node.status)) {
        const sessionId = latestSession(deps.db, request.nodeId)?.id ?? null;
        if (deps.slots.settleAdd(request.slotId, request.attemptId, {
          outcome: stored, result: JSON.stringify({ nodeId: request.nodeId, sessionId }), at: at(),
        })) {
          report({ ...base, attempt: { id: request.attemptId, status: "running", ...(selection ? { snapshotSelection: selection } : {}) }, ...warning });
          return;
        }
      }
      // Refused before any launch: settled, `drained` again with the code as the reuse hold.
      if (!threw && !launch.ok && launch.code !== undefined && COMEBACK_REFUSALS.has(launch.code)) {
        const hold = JSON.stringify({ code: launch.code, snapshotId: request.snapshotId });
        if (deps.slots.settleComebackRefused(request.slotId, request.attemptId, { outcome: stored, hold })) {
          report({
            ...base,
            attempt: { id: request.attemptId, status: "refused", code: launch.code, ...(launch.message ? { message: launch.message } : {}) },
            ...warning,
          });
          return;
        }
      }
      // Anything else (a launch that does not run, a live session, another refusal, a call that threw) is not settled
      // here: the attempt stays issued, with its outcome kept. Nothing is reported when its row went with a node deleted
      // by hand, or the attempt moved on.
      if (!deps.slots.recordAttemptOutcome(request.slotId, request.attemptId, stored)) return;
      const code = launch.code ?? (launch.alreadyRunning?.length ? "already_running" : node?.status ?? "no_launch_result");
      report({
        ...base,
        attempt: { ...inFlight(request.attemptId), code, ...(launch.message ? { message: launch.message } : node?.error ? { message: node.error } : {}) },
        ...warning,
      });
    } catch (error) {
      report({ ...base, attempt: { ...inFlight(request.attemptId), code: "settle_failed", message: errorMessage(error) } });
    }
  };

  /** One call after another, each after the lease is released; the cycle does not wait for them. */
  const startCalls = (calls: ReadonlyArray<() => Promise<void>>) => {
    if (calls.length === 0) return;
    const run = calls.reduce<Promise<void>>((previous, call) => previous.then(call), Promise.resolve());
    pending.add(run);
    void run.finally(() => pending.delete(run));
  };

  const executor: SeatPoolExecutor = {
    comeback,
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    async cycle(job) {
      const active = () => deps.jobsRepo.getById(job.jobId)?.state === "active";
      // The comeback goes only through the executor's own `comeback`, read once: what is issued is what is called.
      const comebackCall = deps.comeback !== undefined && typeof executor.comeback === "function" ? executor.comeback : undefined;
      const found = seatPoolModelOfJob(deps.db, job);
      if (!found.found && found.cause === "no_model_node_id") {
        return { action: "skip", reason: "seat_pool_model_unknown", notes: { modelNodeId: found.modelNodeId } };
      }
      // What settled since this model's last report goes in this one.
      // Not while the job is no longer active: the engine records no evaluation of a stopped job, so what settled waits
      // for a report it does record.
      const report = (notes: Record<string, unknown>): PolicyEvaluation => {
        const id = typeof notes["modelNodeId"] === "string" && active() ? notes["modelNodeId"] : null;
        const done = id === null ? undefined : settled.get(id);
        if (id !== null) settled.delete(id);
        return { action: "skip", reason: "seat_pool_report", notes: done?.length ? { ...notes, settled: done } : notes };
      };
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
      // The report reads the slot rows when it is built, not the snapshot the plan used: an add that settles while the cycle
      // waits for custody is then reported the same way in `slots` and in `settled`.
      const base = () => ({ modelNodeId, ...block, slots: slotsView(deps.slots.forModel(modelNodeId)) });
      if (!active()) return report({ ...base(), held: JOB_STOPPED });
      if (block.block === "unusable") return report({ ...base(), held: BLOCK_UNREADABLE, advisory: unreadableAdvisory(block.error) });
      // After `pool: {}` the model has no block: the job drains with the spec last stored on its row (`drain` set), and
      // ends once every agent is drained. A job with no readable spec of its own does nothing.
      const removed = block.block === "none";
      const lastSpec = removed ? lastEnsuredSpec(job.context) : null;
      if (block.block === "none" && lastSpec === null) return report(base());
      const spec: SeatPoolSpec = block.block === "stored" ? block.spec : { ...lastSpec!, drain: true };
      const removal = removed ? { removal: "the pool block was removed; draining with the spec last stored on the job" } : {};

      // The plan is read outside the lease; the custody is for the hold check, the moves, the drain decisions and the
      // add's reservation and issue. The add's call goes out after it.
      const read: SeatPoolReadState = { ...readSeatPoolState(deps, model, slots), lastStepAt: lastDrainStep(slots) };
      const plan = planSeatPool(spec, read, deps.now().getTime());
      const dispatches = plan.intents.filter((i): i is Extract<SeatPoolIntent, { kind: "dispatch" }> => i.kind === "dispatch");
      const drainIntents = plan.intents.filter((i): i is Extract<SeatPoolIntent, { kind: "drain" }> => i.kind === "drain");
      const addIntent = plan.intents.find((i): i is Extract<SeatPoolIntent, { kind: "add" }> => i.kind === "add");
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
      const gone: Restop[] = [];

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

      let addNotes: Record<string, unknown> | undefined;
      const issued: IssuedAdd[] = [];
      const comebacks: SeatPoolComebackRequest[] = [];
      let thrown: unknown;
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
          // The block again first: one that became unreadable while the cycle waited for custody holds the leftovers too,
          // and they stay as they are. A block stored again with another value, or removed, still lets them settle.
          if (blockView(deps.rigRepo.getNodePool(modelNodeId)).block === "unusable") { blockChangedNow(); return; }
          // An add attempt no process runs any more (a reservation never issued, or an issued add not in flight in this
          // process: cut off by a daemon restart, or left unknown), settled from its row. One in flight here is left alone.
          for (const slot of deps.slots.forModel(modelNodeId)) {
            if (slot.phase !== "adding" || slot.attemptKind !== "add" || slot.attemptId === null || inFlightAttempts.has(slot.attemptId)) continue;
            const entry = settleLeftover(modelNodeId, slot);
            if (entry) reportSettled(modelNodeId, entry);
          }
          // A leftover settled `not_running` here drains its slot, which starts the cooldown the plan could not see: under
          // it, this cycle's drains wait (`drain: true` keeps its exemption), and so does its add, comebacks included.
          const stepNow = lastDrainStep(deps.slots.forModel(modelNodeId));
          const coolingNow = !spec.drain && stepNow !== null && stepNow !== read.lastStepAt
            && deps.now().getTime() - Date.parse(stepNow) < spec.cooldownSeconds * 1000;
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
          // Under `drain` (after `pool: {}`, or a block with `drain: true`), a `live` agent positively gone (its latest
          // session `exited`, or its node confirmed stopped) with no work: the planner never picks it, since only running
          // agents drain, so it would keep the job from ending. Its slot goes to `draining`, and the checked stop below
          // confirms the session is absent before the slot is `drained`. An unknown or stale status is not gone.
          if (spec.drain && deps.drain && !held && !blockChangedNow()) {
            const current = deps.slots.forModel(modelNodeId);
            const agentsNow = readSeatPoolAgents(deps, current);
            for (const slot of current.filter((s) => s.phase === "live" && s.nodeId !== null)) {
              const agent = agentsNow.find((a) => a.slotNumber === slot.slotNumber);
              if (!agent || agent.nodeId === null || agent.sessionName === null || agent.running) continue;
              if (agent.openRows > 0 || agent.heldCount > 0) continue;
              if (agent.latestSessionStatus !== "exited" && !deps.confirmedStopped(agent.nodeId)) continue;
              const sessionId = planSession.get(slot.slotNumber) ?? null;
              if (sessionId === null || latestSession(deps.db, agent.nodeId)?.id !== sessionId) continue;
              if (!deps.slots.setPhase({ slotId: slot.slotId, from: "live", to: "draining", at: at(), stop: null })) continue;
              gone.push({ slot, nodeId: agent.nodeId, session: agent.sessionName, sessionId });
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
            if (coolingNow) {
              for (const rest of drainIntents.slice(index)) drainSkipped({ slotNumber: rest.slotNumber, session: plannedTo(rest.slotNumber), phase: "live" }, "cooldown");
              break;
            }
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

          // The add, after the moves of the same cycle, under the same lease. Nothing in it awaits. Each unit first brings
          // back the lowest eligible `drained` slot (no reuse hold) a snapshot qualifies for, and takes a new number only
          // when no eligible slot is left.
          if (!addIntent || (!deps.add && !deps.comeback) || held || blockChanged) return;
          if (!active()) { held = JOB_STOPPED; return; }
          const storedNow = deps.rigRepo.getNodePool(modelNodeId);
          if (storedNow === undefined || !("spec" in storedNow) || !sameSpec(storedNow.spec, spec)) {
            addNotes = { skipped: "pool_block_changed" };
            return;
          }
          if (coolingNow) { addNotes = { skipped: "cooldown" }; return; }
          const comebackReady = comebackCall !== undefined;
          const comebackNotes: ComebackNote[] = [];
          /** The drained slots this cycle already looked at. */
          const looked = new Set<string>();
          /** Read once, when a unit first needs a new number; a string: why the model gives no new agent. */
          let inputs: NewNumberInputs | string | undefined;
          const newNumberInputs = (): NewNumberInputs | string => {
            const refusal = addRefusal(rigId, modelNodeId);
            if (refusal) return refusal;
            let raw: Record<string, unknown>;
            try {
              raw = deps.add!.exportMember(rigId, modelNodeId);
            } catch (error) {
              return `add refused: the model member can't be exported (${errorMessage(error)})`;
            }
            const inherited = Object.fromEntries(Object.entries(raw).filter(([key]) => !NOT_INHERITED.includes(key)));
            const pod = modelPod(deps.db, modelNodeId);
            if (pod === null) return "add refused: the model member has no pod";
            return {
              raw, inherited, pod,
              rigRoot: deps.rigRepo.getNodeLaunchRecipe(modelNodeId)?.rigRoot ?? ".",
              launchAdditionsFrom: seatLaunchAdditionPathsForNode(deps.db, modelNodeId),
            };
          };
          let refused: string | undefined;
          const issuedView: Array<{ slotNumber: number; logicalId: string; attempt: AttemptView }> = [];
          const notIssued: Array<{ slotNumber: number; logicalId: string; code: string }> = [];
          const cancelled: Array<{ slotNumber: number; logicalId: string; attempt: AttemptView }> = [];
          /** A confirmed failed add met where a unit would take a new number: the add's notes name it. */
          let failedAddNote: Record<string, unknown> | undefined;
          /** The rig hold read just before an issue, when it stopped the issue. */
          const heldAtIssue = (stopped: SeatPoolHoldRead) => {
            if (!active()) held = JOB_STOPPED;
            else { hold = stopped; held = { cause: "rig stopped", seq: stopped.stoppedSeq!, message: `held: rig stopped (event ${stopped.stoppedSeq})` }; }
          };
          units: for (let unit = 0; unit < addIntent.count; unit++) {
            if (!active()) { held = JOB_STOPPED; break; }
            // The comeback first: the lowest eligible `drained` slot, then the next one when no snapshot qualifies.
            for (;;) {
              const slot = deps.slots.forModel(modelNodeId)
                .find((s) => s.phase === "drained" && s.reuseHold === null && s.nodeId !== null && !looked.has(s.slotId));
              if (!slot) break;
              looked.add(slot.slotId);
              const nodeId = slot.nodeId!;
              // The slot's node exists: its row goes with the node (ON DELETE CASCADE), and nothing awaits since the read.
              const logicalId = nodeLogicalId(deps.db, nodeId)!;
              const note = { slotNumber: slot.slotNumber, logicalId, nodeId };
              // Without the comeback, an eligible slot is not brought back, and no new number takes its place.
              if (!comebackReady) { comebackNotes.push({ ...note, code: "comeback_not_composed" }); break units; }
              const selection = deps.comeback!.select(rigId, nodeId, logicalId);
              if (selection.chosen === null) {
                // No snapshot qualifies, or the newest usable one recorded conflicting occupants: no call, and the slot
                // keeps `drained` with the pool's own hold.
                const hold = selection.conflict !== undefined
                  ? { code: "conflicting_occupants", nodeId, snapshotId: selection.conflict.snapshotId, candidateIds: selection.conflict.candidateIds, read: selection.read, failed: selection.failed }
                  : { code: "no_qualifying_snapshot", nodeId, read: selection.read, failed: selection.failed };
                comebackNotes.push(deps.slots.holdComeback(slot.slotId, JSON.stringify(hold)) ? { ...note, hold } : { ...note, code: "slot_moved_on" });
                continue;
              }
              const snapshotId = selection.chosen.id;
              const unknowns = selection.failed.flatMap((f) => (f.unknown ? [{ snapshotId: f.snapshotId, ...f.unknown }] : []));
              // The reservation, on the slot's own row, with the chosen snapshot, and the issue: the job's state and the
              // holds again, then the issued attempt and what it was issued on (the snapshot, the node's latest session and
              // the rig's latest event), in one transaction. A comeback held or not issued is `drained` again in the same
              // transaction, its row never removed; an unexpected error rolls it all back, so the slot stays `drained`
              // with the attempt it had.
              const attemptId = randomUUID();
              const issueComeback = deps.db.transaction((): { code: string; stopped?: SeatPoolHoldRead } | null => {
                if (!deps.slots.reserveComeback({ slotId: slot.slotId, attemptId, snapshotId })) return { code: "slot_moved_on" };
                const returnUnissued = (code: string, stopped?: SeatPoolHoldRead) => {
                  deps.slots.returnComebackToDrained(slot.slotId, attemptId, JSON.stringify({ ok: false, code, launched: false }));
                  return { code, ...(stopped ? { stopped } : {}) };
                };
                const recheck = readSeatPoolHold(deps.db, rigId);
                if (!active() || recheck.stoppedSeq !== null) return returnUnissued("held", recheck);
                const eventSeq = (deps.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE rig_id = ?").get(rigId) as { seq: number | null }).seq;
                const basis = JSON.stringify({ snapshotId, sessionId: latestSession(deps.db, nodeId)?.id ?? null, eventSeq });
                if (!deps.slots.issueAttempt(slot.slotId, attemptId, basis)) return returnUnissued("slot_changed");
                return null;
              });
              const unissued = issueComeback();
              if (unissued !== null) {
                if (unissued.stopped !== undefined) { heldAtIssue(unissued.stopped); break units; }
                comebackNotes.push({ ...note, snapshotId, code: unissued.code });
                continue;
              }
              // The request goes out only once its issue committed.
              comebacks.push({ jobId: job.jobId, modelNodeId, rigId, slotId: slot.slotId, slotNumber: slot.slotNumber, nodeId, logicalId, attemptId, snapshotId, cwdFromModel: spec.cwdTemplate === null });
              comebackNotes.push({ ...note, snapshotId, attempt: inFlight(attemptId), ...(unknowns.length ? { unknownOccupants: unknowns } : {}) });
              continue units;
            }

            // No drained slot to bring back: a new number.
            if (!deps.add) break;
            // An add that settled `not_running` holds every new number while its slot stays; the comebacks above still ran.
            const failedAdd = deps.slots.forModel(modelNodeId).find(confirmedFailedAdd);
            if (failedAdd) { failedAddNote = failedAddHeld(failedAdd); break; }
            inputs ??= newNumberInputs();
            if (typeof inputs === "string") { refused = inputs; break; }
            const { raw, inherited, pod, rigRoot, launchAdditionsFrom } = inputs;
            // The reservation: a new number and its row in one transaction. The operation id is a UUID.
            const attemptId = randomUUID();
            const { slot, logicalId } = deps.slots.reserveAdd({ modelNodeId, attemptId, at: deps.now().toISOString() });
            const memberId = logicalId.slice(pod.length + 1);
            const folder = spec.cwdTemplate === null
              ? null
              : spec.cwdTemplate.replace(/\{(rig|slot)\}/g, (_, key: string) => (key === "rig" ? model.rigName : memberId));
            // A pool agent is never kept alive: a kept-alive agent would be relaunched against the pool's own stops. Leaving
            // the key out is not enough, since the add then resolves it from the agent spec's profile or defaults.
            const member = { id: memberId, ...inherited, cwd: folder ?? raw["cwd"], keep_alive: false };

            // The re-check just before the issue, with nothing awaited since the reservation: the job, the holds and the
            // stored block again, then a new plan with this reservation counted. A lower `max`, `drain: true`, any other
            // change to the block, a hold, or surplus that reaches this reservation cancels it before any operation row
            // or call, and ends this cycle's adds.
            let stopped: SeatPoolHoldRead | undefined;
            const recheck = (): string | null => {
              if (!active()) return "job_stopped";
              const holdNow = readSeatPoolHold(deps.db, rigId);
              if (holdNow.stoppedSeq !== null) { stopped = holdNow; return "rig_stopped"; }
              const storedSpec = deps.rigRepo.getNodePool(modelNodeId);
              const specNow = storedSpec !== undefined && "spec" in storedSpec ? storedSpec.spec : null;
              if (blockChangedNow()) {
                if (specNow === null) return "pool_block_changed";
                return specNow.max < spec.max ? "max_lowered" : specNow.drain ? "drain" : "pool_block_changed";
              }
              const slotsNow = deps.slots.forModel(modelNodeId);
              const replan = planSeatPool(spec, { ...readSeatPoolState(deps, model, slotsNow), lastStepAt: lastDrainStep(slotsNow) }, deps.now().getTime());
              return replan.intents.some((i) => i.kind === "cancel" && i.slotNumber === slot.slotNumber) ? "surplus" : null;
            };
            let cancelCause: string | null;
            try {
              cancelCause = recheck();
            } catch (error) {
              // A re-check that fails leaves no reservation behind: the reserved row goes before its error is raised.
              try { deps.slots.cancelReservedAdd(slot.slotId, attemptId); } catch { /* the re-check's own error is the one raised */ }
              throw error;
            }
            if (cancelCause !== null) {
              // Reported cancelled only when its reserved row went; a row that no longer holds the reservation is reported
              // as not issued, as the issue reports it.
              if (deps.slots.cancelReservedAdd(slot.slotId, attemptId)) {
                cancelled.push({ slotNumber: slot.slotNumber, logicalId, attempt: { id: attemptId, status: "cancelled", message: CANCELLED_NOT_ISSUED, code: cancelCause } });
              } else {
                notIssued.push({ slotNumber: slot.slotNumber, logicalId, code: "slot_changed" });
              }
              if (cancelCause === "job_stopped") held = JOB_STOPPED;
              else if (stopped !== undefined) {
                hold = stopped;
                held = { cause: "rig stopped", seq: stopped.stoppedSeq!, message: `held: rig stopped (event ${stopped.stoppedSeq})` };
              }
              break;
            }

            // The issue: the issued attempt, what it was issued on and the operation id, in one transaction.
            const targets = [rigId, pod];
            const body = JSON.stringify({ member, rigRoot });
            let operation: IssuedAdd["operation"];
            try {
              const eventSeq = (deps.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE rig_id = ?").get(rigId) as { seq: number | null }).seq;
              const basis = JSON.stringify({ eventSeq, targets, body });
              operation = deps.db.transaction(() => {
                if (!deps.slots.issueAttempt(slot.slotId, attemptId, basis)) throw new AddNotIssued("slot_changed");
                const reserved = reserveOperation(deps.db, attemptId, "member.add", targets, body);
                if (reserved.state !== "fresh") throw new AddNotIssued(`operation_${reserved.state}`);
                return reserved;
              })();
            } catch (error) {
              // Whatever stops the issue after the reservation, the reserved row goes, so its number is free again. A
              // failed removal does not hide the error that stopped the issue.
              try { deps.slots.removeAddWithoutNode(slot.slotId, attemptId); } catch { /* the issue's own error is the one raised */ }
              if (!(error instanceof AddNotIssued)) throw error;
              notIssued.push({ slotNumber: slot.slotNumber, logicalId, code: error.code });
              continue;
            }
            inFlightAttempts.add(attemptId);
            issued.push({
              slotId: slot.slotId, slotNumber: slot.slotNumber, logicalId, attemptId, rigId, rigRoot, folder, launchAdditionsFrom, operation,
              op: { kind: "add_member", pod, member },
            });
            issuedView.push({ slotNumber: slot.slotNumber, logicalId, attempt: inFlight(attemptId) });
          }
          addNotes = {
            ...(refused !== undefined ? { refused } : {}),
            ...(comebackNotes.length ? { comebacks: comebackNotes } : {}),
            ...(failedAddNote ?? {}),
            ...(issuedView.length ? { issued: issuedView } : {}),
            ...(notIssued.length ? { failed: notIssued } : {}),
            ...(cancelled.length ? { cancelled } : {}),
          };
        });
      } catch (error) {
        thrown = error;
      }
      // The calls go out after the lease is released, whatever happened after their issue: the comebacks through the
      // executor's own `comeback`, then the new numbers.
      startCalls([
        ...(comebackCall ? comebacks.map((request) => () => comebackCall(request)) : []),
        ...issued.map((add) => () => runAdd(modelNodeId, add)),
      ]);
      if (thrown !== undefined) {
        // A refused custody is not a failure: the cycle had no effect.
        if (!(thrown instanceof DeliveryGuardError)) throw thrown;
        custody = { code: thrown.code, message: thrown.message };
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
        /** What holds the pool now: the job, the model and rig holds, and the current block. Null when none does. */
        const holdsNow = (): string | null => {
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
          return null;
        };
        /** What keeps an agent from being stopped now, read again at the checked stop's final step before each effect
         *  (after its liveness probe): the job, the rig and model holds, the current block, the agent's work and activity,
         *  and, for a retry (`idleSince` null), whether the pool still has surplus. Null when the stop may go on. */
        const keeps = (slotNumber: number, nodeId: string, idleSince: string | null): string | null => {
          const holding = holdsNow();
          if (holding !== null) return holding;
          const now = readSeatPoolState(deps, model, deps.slots.forModel(modelNodeId));
          const agent = now.agents.find((a) => a.slotNumber === slotNumber);
          if (!agent || agent.phase !== "draining") return "slot_moved_on";
          // Work first: `running` comes from the recorded status, so false does not prove the process is gone.
          if (agent.openRows > 0 || agent.heldCount > 0) return "work_arrived";
          // An agent positively gone keeps nothing: the stop only confirms it. Gone is its latest session `exited`, or the
          // node's executor confirmed stopped (session missing or pane exited); an unknown or stale status keeps it.
          if (!agent.running) {
            return agent.latestSessionStatus === "exited" || deps.confirmedStopped(nodeId) ? null : "not_confirmed_gone";
          }
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

        /** What keeps a gone agent's slot from being `drained` now, read under its lifecycle lease and again at the
         *  checked stop's final step: the holds, its work, and whether it is still positively gone. */
        const keepsGone = (slotNumber: number, nodeId: string): string | null => {
          const holding = holdsNow();
          if (holding !== null) return holding;
          const agent = readSeatPoolAgents(deps, deps.slots.forModel(modelNodeId)).find((a) => a.slotNumber === slotNumber);
          if (!agent || agent.phase !== "draining") return "slot_moved_on";
          if (agent.openRows > 0 || agent.heldCount > 0) return "work_arrived";
          if (agent.running) return "running";
          return agent.latestSessionStatus === "exited" || deps.confirmedStopped(nodeId) ? null : "not_confirmed_gone";
        };
        for (const g of gone) {
          if (held) break;
          if (!active()) { held = JOB_STOPPED; break; }
          const step = { slotNumber: g.slot.slotNumber, session: g.session };
          try {
            drains.push(await effects.lifecycle([g.nodeId], async (): Promise<DrainReport> => {
              // Relaunched since the plan read it: someone's seat now, left alone.
              if (latestSession(deps.db, g.nodeId)?.id !== g.sessionId) return { ...step, phase: moveTo(g.slot, "live"), outcome: "left", code: "relaunched" };
              const before = keepsGone(g.slot.slotNumber, g.nodeId);
              if (before === "slot_moved_on") return { ...step, phase: phaseNow(g.slot), outcome: "skipped", code: before };
              if (before !== null) {
                return { ...step, phase: moveTo(g.slot, "live"), outcome: before === "work_arrived" ? "returned" : "left", code: before };
              }
              const refused: { code: string | null } = { code: null };
              const stop = await effects.stopSeat({
                seatRef: g.session, reason: stopReason("its session is gone; drained"),
                expected: { nodeId: g.nodeId, sessionId: g.sessionId },
                recheck: () => {
                  const code = keepsGone(g.slot.slotNumber, g.nodeId);
                  if (code === null) return null;
                  refused.code = code;
                  return { ok: false as const, code: "selection_changed" as const, message: `The seat pool drain stops nothing: ${code} right before the stop.` };
                },
              });
              // Refused at the stop's final step before any effect: nothing was stopped, and the slot is `live` again.
              if (refused.code !== null && !stop.ok && stop.partialEffect !== true) {
                return { ...step, phase: moveTo(g.slot, "live", null), outcome: refused.code === "work_arrived" ? "returned" : "left", code: refused.code };
              }
              // A session found absent returns before the stop's final step, so its recheck never ran: the same reading
              // again before the slot is `drained`. Nothing was stopped, so a slot that got work meanwhile is `live` again.
              if (seatPoolStopReport(stop).result === "absent") {
                const after = keepsGone(g.slot.slotNumber, g.nodeId);
                if (after === "slot_moved_on") return { ...step, phase: phaseNow(g.slot), outcome: "skipped", code: after };
                if (after !== null) {
                  return { ...step, phase: moveTo(g.slot, "live", null), outcome: after === "work_arrived" ? "returned" : "left", code: after };
                }
              }
              return settle(g, stop);
            }));
          } catch (error) {
            // The guard refused the lease: nothing was stopped, and the slot is `live` again.
            if (!(error instanceof DeliveryGuardError)) throw error;
            drains.push({ ...step, phase: moveTo(g.slot, "live"), outcome: "left", code: error.code, message: error.message });
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
              // The job, the holds and the block again after the refresh, which can take a while: one that holds the pool
              // now captures nothing and stops nothing. Nothing was stopped, so the slot goes back to `live` in a later cycle.
              const heldAfterRefresh = holdsNow();
              if (heldAfterRefresh !== null) return { ...step, phase: "draining", outcome: "draining", code: heldAfterRefresh };
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

      // After `pool: {}`, the block again before the job ends: one stored again (or broken) while the cycle waited for
      // custody, with no effect to read it, keeps the job active. Read before the notes, which report the block it finds.
      const ends = removed && !held && !custody && !blockChanged && !blockChangedNow()
        && deps.slots.forModel(modelNodeId).every((s) => s.phase === "drained");
      const restore = !held && hold && hold.unfinishedRestoreSeq !== null
        ? {
          seq: hold.unfinishedRestoreSeq,
          completed: false,
          message: `restore at event ${hold.unfinishedRestoreSeq} has no restore.completed; nothing is held without a rig.stopped`,
        }
        : undefined;
      const notes = {
        ...base(),
        ...(blockChanged ? {} : removal),
        ...(held ? { held } : {}),
        ...(advisory ? { advisory } : {}),
        ...(restore ? { restore } : {}),
        ...(moved.length ? { moved } : {}),
        ...(skipped.length ? { skipped } : {}),
        ...(failed.length ? { failed } : {}),
        ...(drains.length ? { drains } : {}),
        ...(addNotes && Object.keys(addNotes).length ? { add: addNotes } : {}),
        ...(custody ? { custody } : {}),
      };
      // After `pool: {}`: the job ends once every agent is drained (busy agents stay `live` until they are free).
      if (ends) {
        // What this cycle (or an earlier one) settled goes in the last report too.
        const done = settled.get(modelNodeId);
        settled.delete(modelNodeId);
        return { action: "terminal", reason: "seat_pool_removed_drained", notes: done?.length ? { ...notes, settled: done } : notes };
      }
      return report(notes);
    },
  };
  return executor;
}
