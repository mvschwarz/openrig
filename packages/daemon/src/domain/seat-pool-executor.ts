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
// the refusal's code as its reuse hold, so the same snapshot is never sent again. A launch that ends without proof that
// the agent runs holds the slot and is never repeated: awaiting a decision, or failed with no session running, the slot
// is `drained` and held; needing attention, left attached, or failed while its session still runs, it is `live` and
// held (it takes room, is not free, receives no row and is never drained by the pool). A live session that the launch
// found already there (`alreadyRunning`) makes the slot `live` with no hold, free only once idle at its prompt. Right
// before its issue the comeback is checked as an add is (the job, the holds, the block and surplus): one that would not
// be issued is cancelled (`cancelled: not issued`) and the slot stays `drained` and eligible. Right before its launch
// the job and the rig are read again: with the job stopped or the rig down, it is never launched and the slot is
// `drained` again. Only when no eligible slot is left does the unit take a new number.
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
// same rule as above. The add is never issued again. An issued comeback no process runs any more is settled from the
// `restore.subset_completed` after what it was issued on that names its node (the launch records it before it returns),
// by the same rule as its launch; with no such event and no newer session on its node, it stays issued and `unknown`,
// takes room, and is never launched again.
//
// A held slot (a reuse hold on a `drained` or `live` slot) is read again at the start of each cycle, under the custody
// lease: only a later change on its node (a session newer than the one the hold was set with, or a new status or startup
// status on that session) can end the hold, and the node's latest session decides. Ready and not confirmed stopped: the
// slot is `live` with no hold. Confirmed absent (exited, or confirmed stopped): `drained` and eligible, unless the hold
// awaits a decision and no later session reached `ready`. Running with a startup that needs attention or failed: `live`
// and held. Anything else is reported `unknown` with what was read, and read again next cycle.
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
    | "reserveComeback" | "holdComeback" | "settleComebackRefused" | "returnComebackToDrained" | "settleAddHeldLive"
    | "settleComebackHeld" | "recordHeldSession" | "changeHeld" | "reopenHeld" | "settleIssuedByLater">;
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
/** The actor and note the queue records when a handover or a fresh launch releases the retiring occupant's claims back
 *  to pending (`releaseClaimsByGeneration`). */
const HANDOVER_RELEASE_ACTOR = "system";
const HANDOVER_RELEASE_NOTE = "released: claimant generation retired (seat handover)";
/** No cut: list() keeps the newest rows first, so any limit would drop the oldest rows, which move first. */
const ALL_ROWS = Number.MAX_SAFE_INTEGER;
/** Refusals that mean the row moved on since it was read: skipped, never a failure. */
const ROW_MOVED_ON: ReadonlySet<string> = new Set(["fallback_state_mismatch", "fallback_destination_mismatch", "qitem_not_found"]);

/** A queue-only seat's cold watchdog reminder is about that seat, never its work (the stuck sweep's rule). */
function isWatchdogReminder(row: { sourceSession: string; tags?: string[] | null }): boolean {
  return row.sourceSession === "watchdog@system" && !!row.tags?.includes("watchdog") && row.tags.includes("queue-only");
}

/** When the row's waiting clock last restarted, from its transitions: its latest reroute or its latest release back to
 *  pending by a handover or a fresh launch, or null when neither happened. Only the queue's own records count (no
 *  identity provenance). */
function waitingRestartedAt(queueRepo: Pick<QueueRepository, "transitionLog">, qitemId: string): string | null {
  const transitions = queueRepo.transitionLog.listForQitem(qitemId);
  for (let i = transitions.length - 1; i >= 0; i--) {
    const t = transitions[i]!;
    if (t.identityProvenance !== null) continue;
    if (t.actorSession === QUEUE_FALLBACK_ACTOR && t.transitionNote?.startsWith(FALLBACK_NOTE)) return t.ts;
    if (t.state === "pending" && t.actorSession === HANDOVER_RELEASE_ACTOR && t.transitionNote === HANDOVER_RELEASE_NOTE) return t.ts;
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
          waitingSince: waitingRestartedAt(queueRepo, row.qitemId) ?? row.tsCreated,
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
    // A `live` slot with a reuse hold is not proven to run: it takes room, but it is not free and receives no row.
    const heldLive = slot.phase === "live" && slot.reuseHold !== null;
    const running = nodeId !== null && !heldLive && (latestSessionStatus === "running" || latestSessionStatus === "idle")
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
 * (issued, with a node whose result can't be told yet; read again every cycle). A comeback: `in_flight` while its call
 * runs in this process, then `running` (with the snapshot it was launched from), `already_running` (a live session the
 * launch found), `not_running` (a decision awaited, or failed with nothing running, its launch status in `code`) or
 * `refused` before any launch, with its code; `cancelled` before its issue; `unknown` while it stays issued with no
 * call running. A `live` slot that is held, whichever attempt it came from, is reported `attention_required` or
 * `left_attached`, with the launch's status in `code` when it is another one (a failure whose session still runs).
 */
interface AttemptView {
  id: string;
  status: "in_flight" | "cancelled" | "running" | "already_running" | "no_node" | "not_running" | "attention_required"
    | "left_attached" | "unknown" | "refused";
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

/** The statuses a held `live` slot is reported with (the E1 L10 row). */
type HeldLiveStatus = "attention_required" | "left_attached";

/** How a held `live` slot is reported, from its hold: `left_attached`, or `attention_required` (with the launch's status in
 *  `code` when it is another one, as a failure whose session still runs), with the hold's error. */
function heldLiveView(attemptId: string, hold: Record<string, unknown>): AttemptView {
  const code = typeof hold["code"] === "string" ? hold["code"] : "attention_required";
  const status: HeldLiveStatus = code === "left_attached" ? "left_attached" : "attention_required";
  return {
    id: attemptId, status,
    ...(code !== status ? { code } : {}),
    ...(typeof hold["error"] === "string" ? { message: hold["error"] } : {}),
  };
}

/** A slot's attempt as its row records it. A `live` slot that is held is reported from its hold. A comeback: in flight
 *  while its call runs in this process (`inFlightIds`; without it, every issued one), `unknown` once no call runs it,
 *  then by how it settled. An add: an issued one with an `unknown` outcome is reported so, and a settled one by the
 *  status its outcome kept (a settled add with no such status settled running). */
function attemptView(slot: SeatPoolSlot, inFlightIds?: ReadonlySet<string>): AttemptView | undefined {
  if (slot.attemptId === null || slot.attemptState === null) return undefined;
  const outcome = readAttemptOutcome(slot.attemptOutcome);
  const text = (key: string) => (typeof outcome[key] === "string" ? { [key]: outcome[key] as string } : {});
  if (slot.attemptState === "settled" && slot.phase === "live" && slot.reuseHold !== null) {
    return heldLiveView(slot.attemptId, slotRecord(slot.reuseHold) ?? {});
  }
  // Put back in `adding` by a later session that has not settled: unknown, read again every cycle.
  if (slot.attemptState === "issued" && outcome["reread"] === "session") {
    const pending = slotRecord(JSON.stringify(outcome["pending"] ?? null)) ?? {};
    return { id: slot.attemptId, status: "unknown", code: typeof pending["code"] === "string" ? pending["code"] : "later_session_not_settled",
      ...(typeof pending["message"] === "string" ? { message: pending["message"] } : {}) };
  }
  if (slot.attemptState === "settled") {
    const hold = slotRecord(slot.reuseHold);
    // Held `drained` for a decision or a failure the launch (or a later restore) returned: not running, with that status.
    if (slot.phase === "drained" && hold !== null && !("observed" in hold) && (hold["code"] === "awaiting-decision" || hold["code"] === "failed")) {
      return { id: slot.attemptId, status: "not_running", code: hold["code"], ...(typeof hold["error"] === "string" ? { message: hold["error"] } : {}) };
    }
    // Settled by a later session on its node rather than by its call.
    // Reported by what that session read when it settled the attempt, not by the slot's phase now (a normal drain later
    // does not change how the attempt settled).
    if (outcome["settledBy"] === "later_session") {
      const later = slotRecord(JSON.stringify(outcome["later"] ?? null));
      const ran = later !== null && typeof later["read"] === "string" ? later["read"] === "ready" : slot.phase === "live" && slot.reuseHold === null;
      return ran
        ? { id: slot.attemptId, status: "running", code: "later_session" }
        : { id: slot.attemptId, status: "not_running", code: "later_session_absent" };
    }
  }
  if (slot.attemptKind === "comeback") {
    if (slot.attemptState !== "settled") {
      if (inFlightIds === undefined || inFlightIds.has(slot.attemptId)) return inFlight(slot.attemptId);
      return { id: slot.attemptId, status: "unknown", code: typeof outcome["code"] === "string" ? outcome["code"] : "no_outcome",
        message: typeof outcome["message"] === "string" ? outcome["message"]
          : "unknown: the comeback's launch is not running in this process and its result is not recorded" };
    }
    if (outcome["cancelled"] === true) {
      return { id: slot.attemptId, status: "cancelled", message: CANCELLED_NOT_ISSUED, ...text("code") };
    }
    if (outcome["settledAs"] === "already_running") return { id: slot.attemptId, status: "already_running" };
    if (outcome["settledAs"] === "attention_required" || outcome["settledAs"] === "left_attached") {
      return heldLiveView(slot.attemptId, { code: typeof outcome["status"] === "string" ? outcome["status"] : outcome["settledAs"],
        ...(typeof outcome["error"] === "string" ? { error: outcome["error"] } : {}) });
    }
    if (outcome["settledAs"] === "not_running") {
      return { id: slot.attemptId, status: "not_running", ...(typeof outcome["status"] === "string" ? { code: outcome["status"] } : {}),
        ...(typeof outcome["error"] === "string" ? { message: outcome["error"] } : {}) };
    }
    if (outcome["ok"] === false) {
      return { id: slot.attemptId, status: "refused", ...(typeof outcome["code"] === "string" ? { code: outcome["code"] } : {}) };
    }
    const selection = outcome["snapshotSelection"] as AttemptView["snapshotSelection"] | undefined;
    return { id: slot.attemptId, status: "running", ...(selection ? { snapshotSelection: selection } : {}) };
  }
  if (slot.attemptState === "settled") {
    if (outcome["status"] === "attention_required" || outcome["status"] === "left_attached") {
      return heldLiveView(slot.attemptId, { code: typeof outcome["code"] === "string" ? outcome["code"] : outcome["status"], ...(typeof outcome["message"] === "string" ? { error: outcome["message"] } : {}) });
    }
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
function slotsView(slots: readonly SeatPoolSlot[], inFlightIds?: ReadonlySet<string>): Array<{
  slotNumber: number; nodeId: string | null; phase: SeatPoolPhase; attempt?: AttemptView; reuseHold?: Record<string, unknown>;
}> {
  return slots.map((slot) => {
    const attempt = attemptView(slot, inFlightIds);
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
  const outcome = readAttemptOutcome(slot.attemptOutcome);
  return slot.phase === "drained" && slot.attemptKind === "add" && slot.attemptState === "settled" && slot.attemptId !== null
    && slot.reuseHold !== null && outcome["status"] === "not_running" && outcome["later"] === undefined;
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
  | { status: HeldLiveStatus; code: string; message?: string }
  | { status: "unknown"; code: string; message: string };

/**
 * The one rule an add with a node settles by, in the cycle that ran it and in a later cycle (or process) that reads it
 * again. Exited, or the node's executor confirmed stopped: not running, never retried. Running or idle while the call is
 * known to have returned anything but a launch (`attention_required`, `left_attached`, a failure): held `live`, reported
 * by the launch's status (`left_attached`, else `attention_required`, with the status or code in `code`). Running or idle
 * with startup `ready` after a launch: running. Anything else (startup not ready, no session, another status): unknown.
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
  // The add said it needs attention or was left attached: held `live` whatever its session reads, since a pane may run.
  if (call !== null && call.ok && (call.status === "attention_required" || call.status === "left_attached")) {
    return { status: call.status, code: call.status, ...(call.error !== undefined ? { message: call.error } : {}) };
  }
  if (latest === null) return { status: "unknown", code: "no_session", message: "unknown: the node has no session yet" };
  const evidence = `latest session ${latest.status}, startup ${latest.startupStatus ?? "unknown"}`;
  if (latest.status === "running" || latest.status === "idle") {
    if (call !== null && !(call.ok && call.status === "launched")) {
      const code = call.ok ? call.status : call.code;
      const message = call.ok ? call.error : call.message;
      return { status: code === "left_attached" ? "left_attached" : "attention_required", code, ...(message !== undefined ? { message } : {}) };
    }
    if (latest.startupStatus === "ready") return { status: "running", sessionId: latest.id };
    // A startup that needs attention or failed while the session runs (the add's call not known, as after a restart).
    if (latest.startupStatus === "attention_required" || latest.startupStatus === "failed") {
      return { status: "attention_required", code: latest.startupStatus, message: `startup ${latest.startupStatus}; ${evidence}` };
    }
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

/** A node's session as a later change reads it. */
type SessionView = { id: string; status: string; startupStatus: string | null };

/** A node's latest session with its startup status, in the order the reader uses, leaving out a session a launch rolled
 *  back (`superseded`): that one was never the node's occupant. Null: none. */
function latestSessionView(db: Database.Database, nodeId: string): SessionView | null {
  return (db.prepare(
    `SELECT id, status, startup_status AS startupStatus FROM sessions WHERE node_id = ? AND status != 'superseded'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(nodeId) as SessionView | undefined) ?? null;
}

/** A session by id as a later change reads it; null for null or an unknown id. */
function sessionViewOf(db: Database.Database, sessionId: string | null): SessionView | null {
  if (sessionId === null) return null;
  return (db.prepare("SELECT id, status, startup_status AS startupStatus FROM sessions WHERE id = ?").get(sessionId) as SessionView | undefined) ?? null;
}

/** The highest event seq of the node's rig; 0 when none. */
function rigEventSeq(db: Database.Database, nodeId: string): number {
  return (db.prepare("SELECT MAX(seq) AS seq FROM events WHERE rig_id = (SELECT rig_id FROM nodes WHERE id = ?)").get(nodeId) as
    { seq: number | null }).seq ?? 0;
}

/** What a hold is measured from, kept on the slot row (`attempt_result`, marked `held`): the node's latest session as read
 *  when the hold was set, with its status and startup status (`sessionId: null` when the node has none), and the rig's
 *  event seq then. A later change is measured against it. */
function heldSession(nodeId: string, latest: SessionView | null, eventSeq: number): string {
  return JSON.stringify({
    held: true, nodeId, sessionId: latest?.id ?? null,
    ...(latest !== null ? { status: latest.status, startupStatus: latest.startupStatus } : {}),
    eventSeq,
  });
}

/** What a hold is measured from, read back from the slot row; null when the row keeps none (an attempt's own result, or
 *  anything that does not read as one). */
function readHeldSession(text: string | null): { sessionId: string | null; status?: string; startupStatus: string | null; eventSeq: number } | null {
  const record = slotRecord(text);
  if (record === null || record["held"] !== true) return null;
  const sessionId = record["sessionId"];
  if (sessionId !== null && (typeof sessionId !== "string" || sessionId === "")) return null;
  return {
    sessionId,
    ...(typeof record["status"] === "string" ? { status: record["status"] } : {}),
    startupStatus: typeof record["startupStatus"] === "string" ? record["startupStatus"] : null,
    eventSeq: typeof record["eventSeq"] === "number" ? record["eventSeq"] : 0,
  };
}

/** The status a held comeback settles with, from its launch's status for the node: a decision awaited, or a failure with
 *  no session running, holds it `drained` (`not_running`); attention, left attached, or a failure whose session still
 *  runs holds it `live`. Null for a status that runs, or one this does not settle. */
function heldComeback(nodeStatus: string, sessionRuns: boolean): { as: "not_running" } | { as: HeldLiveStatus } | null {
  if (nodeStatus === "awaiting-decision") return { as: "not_running" };
  if (nodeStatus === "attention_required") return { as: "attention_required" };
  if (nodeStatus === "left_attached") return { as: "left_attached" };
  if (nodeStatus === "failed") return sessionRuns ? { as: "attention_required" } : { as: "not_running" };
  return null;
}

/** A slot whose hold a later change on its node can end: a reuse hold on a `drained` or `live` slot with a node, and no
 *  attempt running. */
function isWatchedHold(slot: SeatPoolSlot): boolean {
  return slot.reuseHold !== null && slot.nodeId !== null && (slot.phase === "drained" || slot.phase === "live")
    && (slot.attemptState === null || slot.attemptState === "settled");
}

/** What a later change on a slot's node made of it, as the cycle reports it (`laterChanges`). `read` is how it read: a
 *  restore since the hold that launched the node and did not run (`restore`, with its event: the slot takes that
 *  outcome), or the node's latest session: `ready` (the slot is `live`, no hold), `absent` (`drained` and eligible, or
 *  still held while its decision is awaited), `attention` (`live` and held) or `unknown` (the slot is `adding` and its
 *  attempt issued again, read again every cycle, as an unknown result). */
interface LaterChange {
  slotNumber: number;
  logicalId: string;
  nodeId: string;
  session: SessionView | null;
  read: "restore" | "ready" | "absent" | "attention" | "unknown";
  restore?: { seq: number; status: string };
  phase: SeatPoolPhase;
  reuseHold?: Record<string, unknown>;
}

/** The newest restore since `sinceSeq` (a whole-rig `restore.completed` or a `restore.subset_completed`) that names the
 *  node, with its status and error for it; null when none does. A payload that can't be read names no node. */
function restoreOf(db: Database.Database, nodeId: string, sinceSeq: number, snapshotId?: string):
  { seq: number; status: string; error?: string; snapshotSelection?: { snapshotId: string; mode: string } } | null {
  // A comeback's own launch records only a `restore.subset_completed`; a later change also reads a whole-rig restore.
  const events = db.prepare(
    `SELECT seq, type, payload FROM events WHERE rig_id = (SELECT rig_id FROM nodes WHERE id = ?)
      AND type IN ('restore.subset_completed'${snapshotId === undefined ? ", 'restore.completed'" : ""}) AND seq > ? ORDER BY seq DESC`,
  ).all(nodeId, sinceSeq) as Array<{ seq: number; type: string; payload: string }>;
  for (const event of events) {
    let payload: { snapshotId?: unknown; result?: { nodes?: unknown; snapshotSelection?: unknown } };
    try {
      payload = JSON.parse(event.payload) as typeof payload;
    } catch {
      continue;
    }
    if (snapshotId !== undefined && payload.snapshotId !== snapshotId) continue;
    const nodes = Array.isArray(payload.result?.nodes) ? payload.result.nodes as unknown[] : [];
    const node = nodes.find((n): n is Record<string, unknown> => n !== null && typeof n === "object" && (n as Record<string, unknown>)["nodeId"] === nodeId);
    if (!node || typeof node["status"] !== "string") continue;
    const selection = payload.result?.snapshotSelection as { snapshotId?: unknown; mode?: unknown } | undefined;
    return {
      seq: event.seq, status: node["status"],
      ...(typeof node["error"] === "string" ? { error: node["error"] } : {}),
      ...(selection && typeof selection.snapshotId === "string" && typeof selection.mode === "string"
        ? { snapshotSelection: { snapshotId: selection.snapshotId, mode: selection.mode } } : {}),
    };
  }
  return null;
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
        result: heldSession(add.nodeId, latest, rigEventSeq(deps.db, add.nodeId)),
      }) ? entry({ id: add.attemptId, status: "not_running", ...seen }) : null;
    }
    if (settlement.status === "attention_required" || settlement.status === "left_attached") {
      // Held `live`: a session may run, so the slot takes room, but it is not free, receives no row and is never drained.
      const hold = { code: settlement.code, ...(settlement.message !== undefined ? { error: settlement.message } : {}) };
      return deps.slots.settleAddHeldLive(add.slotId, add.attemptId, {
        outcome: JSON.stringify({ status: settlement.status, code: settlement.code, ...(settlement.message !== undefined ? { message: settlement.message } : {}), call }),
        hold: JSON.stringify(hold), result: heldSession(add.nodeId, latest, rigEventSeq(deps.db, add.nodeId)), at: at(),
      }) ? entry(heldLiveView(add.attemptId, hold)) : null;
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
    // An add read with no session yet made none of its own: a session found now is someone else's, so the call that
    // returned without one does not hold it. With still no session, the call is kept with its failure.
    const call = latest !== null && readAttemptOutcome(slot.attemptOutcome)["code"] === "no_session" ? null : keptCall(slot);
    return settleWithNode({ slotId: slot.slotId, slotNumber: slot.slotNumber, logicalId, attemptId, nodeId: slot.nodeId }, call, latest);
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
    // Running in this process until it settles, whoever calls it: a cycle does not read it as left over meanwhile.
    inFlightAttempts.add(request.attemptId);
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
      const storedOutcome: Record<string, unknown> = {
        ok: launch.ok && !threw,
        ...(launch.code !== undefined ? { code: launch.code } : {}),
        ...(launch.message !== undefined ? { message: launch.message } : {}),
        ...(threw ? { threw: true } : {}),
        ...(node ? { nodeId: node.nodeId, status: node.status, ...(node.error ? { error: node.error } : {}) } : {}),
        ...(launch.alreadyRunning?.length ? { alreadyRunning: launch.alreadyRunning.map((n) => n.nodeId) } : {}),
        ...(selection ? { snapshotSelection: selection } : {}),
      };
      const stored = JSON.stringify(storedOutcome);
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
      // Launched on the same node and not running: held, and never launched again (a decision awaited, a failure with
      // nothing running: `drained`; attention, left attached, a failure whose session still runs: `live`).
      if (!threw && launch.ok && node && node.nodeId === request.nodeId) {
        const held = settleHeldComeback(request, node.status, node.error, storedOutcome);
        if (held === "moved_on") return;
        if (held !== "not_held") {
          report({ ...base, attempt: held, ...warning });
          return;
        }
      }
      // No launch, and the node in `alreadyRunning`: a live session the pool did not start. `live`, with no hold and no
      // session of the attempt's own; free only once idle at its prompt.
      if (!threw && launch.ok && !launch.launched?.length && launch.alreadyRunning?.some((n) => n.nodeId === request.nodeId)) {
        if (deps.slots.settleAdd(request.slotId, request.attemptId, {
          outcome: JSON.stringify({ ...storedOutcome, settledAs: "already_running" }), result: null, at: at(),
        })) {
          report({ ...base, attempt: { id: request.attemptId, status: "already_running" }, ...warning });
        }
        return;
      }
      // Refused before any launch: settled, `drained` again with the code as the reuse hold.
      if (!threw && !launch.ok && launch.code !== undefined && COMEBACK_REFUSALS.has(launch.code)) {
        const hold = JSON.stringify({ code: launch.code, snapshotId: request.snapshotId });
        if (deps.slots.settleComebackRefused(request.slotId, request.attemptId, {
          outcome: stored, hold, result: heldSession(request.nodeId, latestSessionView(deps.db, request.nodeId), rigEventSeq(deps.db, request.nodeId)),
        })) {
          report({
            ...base,
            attempt: { id: request.attemptId, status: "refused", code: launch.code, ...(launch.message ? { message: launch.message } : {}) },
            ...warning,
          });
          return;
        }
      }
      // Anything else (another refusal, a launch on another node, a call that threw) is not settled here: the attempt
      // stays issued, with its outcome kept, and later cycles report it `unknown` and read it again. Nothing is reported
      // when its row went with a node deleted by hand, or the attempt moved on.
      if (!deps.slots.recordAttemptOutcome(request.slotId, request.attemptId, stored)) return;
      const code = launch.code ?? (launch.alreadyRunning?.length ? "already_running" : node?.status ?? "no_launch_result");
      report({
        ...base,
        attempt: { ...inFlight(request.attemptId), code, ...(launch.message ? { message: launch.message } : node?.error ? { message: node.error } : {}) },
        ...warning,
      });
    } catch (error) {
      report({ ...base, attempt: { ...inFlight(request.attemptId), code: "settle_failed", message: errorMessage(error) } });
    } finally {
      inFlightAttempts.delete(request.attemptId);
    }
  };

  /**
   * An issued comeback whose launch on its node did not run, settled held from the launch's status for the node (from the
   * call, or from the restore event a later cycle reads): `drained` (`not_running`) or `live` (`attention_required`,
   * `left_attached`), with the status as the reuse hold's code, the launch's error and the snapshot. The hold is measured
   * from the node's latest session now (or, with `measuredFrom`, from that session: null when there was none) and the
   * rig's event seq. `not_held` for a status this does not settle; `moved_on` when the row no longer holds the issued
   * attempt.
   */
  const settleHeldComeback = (
    attempt: { slotId: string; attemptId: string; nodeId: string; snapshotId: string },
    nodeStatus: string, error: string | undefined, outcome: Record<string, unknown>,
    measuredFrom?: { sessionId: string | null },
  ): AttemptView | "not_held" | "moved_on" => {
    const latest = latestSessionView(deps.db, attempt.nodeId);
    const from = measuredFrom === undefined ? latest : sessionViewOf(deps.db, measuredFrom.sessionId);
    const held = heldComeback(nodeStatus, sessionRuns(attempt.nodeId, latest));
    if (held === null) return "not_held";
    const hold = { code: nodeStatus, snapshotId: attempt.snapshotId, ...(error !== undefined ? { error } : {}) };
    if (!deps.slots.settleComebackHeld(attempt.slotId, attempt.attemptId, {
      phase: held.as === "not_running" ? "drained" : "live",
      outcome: JSON.stringify({ ...outcome, settledAs: held.as }), hold: JSON.stringify(hold),
      result: heldSession(attempt.nodeId, from, rigEventSeq(deps.db, attempt.nodeId)), at: at(),
    })) return "moved_on";
    return held.as === "not_running"
      ? { id: attempt.attemptId, status: "not_running", code: nodeStatus, ...(error !== undefined ? { message: error } : {}) }
      : heldLiveView(attempt.attemptId, hold);
  };

  /** Whether the session runs: running or idle, and its node's executor not confirmed stopped. */
  const sessionRuns = (nodeId: string, latest: SessionView | null): boolean =>
    latest !== null && (latest.status === "running" || latest.status === "idle") && !deps.confirmedStopped(nodeId);

  /** How a node's latest session reads for a later change: confirmed absent (exited, or its executor confirmed stopped),
   *  ready (running or idle with startup `ready`), needing attention (running with a startup that needs attention or
   *  failed), or anything else. */
  const readSession = (nodeId: string, latest: SessionView): "absent" | "ready" | "attention" | "unknown" => {
    if (latest.status === "exited" || deps.confirmedStopped(nodeId)) return "absent";
    const runs = latest.status === "running" || latest.status === "idle";
    if (runs && latest.startupStatus === "ready") return "ready";
    if (runs && (latest.startupStatus === "attention_required" || latest.startupStatus === "failed")) return "attention";
    return "unknown";
  };

  /** Whether a session of the node reached startup `ready` after `sinceSessionId` (any, when null or unknown), in the
   *  order `latestSessionView` reads sessions (`created_at`, then `id`), so "later" means one thing. */
  const laterReady = (nodeId: string, sinceSessionId: string | null): boolean => deps.db.prepare(
    `SELECT 1 FROM sessions s WHERE s.node_id = ? AND s.startup_status = 'ready'
       AND (NOT EXISTS (SELECT 1 FROM sessions WHERE id = ?)
            OR (s.created_at, s.id) > (SELECT created_at, id FROM sessions WHERE id = ?)) LIMIT 1`,
  ).get(nodeId, sinceSessionId, sinceSessionId) !== undefined;

  /** The hold a later attention reading gives: its startup status as the code, and the session. */
  const attentionHold = (latest: SessionView) => ({ code: latest.startupStatus === "failed" ? "failed" : "attention_required", sessionId: latest.id });

  /**
   * An issued attempt no call runs any more, settled by its node's latest session (a comeback cut off before its launch
   * recorded anything, or a slot a later change left `unknown`): ready, the slot is `live` with no hold and no session of
   * the attempt's own; confirmed absent, `drained` and eligible, unless the hold it had awaits a decision and no session
   * reached `ready` since `since` (it is held again); needing attention, `live` and held; anything else is not settled.
   * With `newerThan`, only a session other than that one counts. Returns what changed, or null.
   */
  const settleIssuedBySession = (
    modelNodeId: string, slot: SeatPoolSlot, opts: { newerThan?: string | null; since: string | null; sinceSeq?: number },
  ): LaterChange | null => {
    const nodeId = slot.nodeId!;
    const latest = latestSessionView(deps.db, nodeId);
    const logicalId = logicalIdOf(modelNodeId, slot.slotNumber);
    const settledBy = (read: LaterChange["read"]) => JSON.stringify({
      ...readAttemptOutcome(slot.attemptOutcome), settledBy: "later_session", later: { sessionId: latest?.id ?? null, read, at: at() },
    });
    // A restore since the slot was put back in `adding` that launched the node and did not run gives it that outcome,
    // unless a session reads ready now.
    const restore = opts.sinceSeq === undefined ? null : restoreOf(deps.db, nodeId, opts.sinceSeq);
    if (restore !== null && !launchStatusIsRunning(restore.status) && (latest === null || readSession(nodeId, latest) !== "ready")) {
      const held = heldComeback(restore.status, sessionRuns(nodeId, latest));
      if (held !== null) {
        const hold = { code: restore.status, ...(restore.error !== undefined ? { error: restore.error } : {}), restoreSeq: restore.seq };
        const phase = held.as === "not_running" ? "drained" : "live";
        return deps.slots.settleIssuedByLater({
          slotId: slot.slotId, attemptId: slot.attemptId!, phase, hold: JSON.stringify(hold), outcome: settledBy("restore"),
          result: heldSession(nodeId, latest, restore.seq), at: at(),
        }) ? { slotNumber: slot.slotNumber, logicalId, nodeId, session: latest, read: "restore", restore: { seq: restore.seq, status: restore.status }, phase, reuseHold: hold } : null;
      }
    }
    if (latest === null) return null;
    if (opts.newerThan !== undefined && latest.id === opts.newerThan) return null;
    const read = readSession(nodeId, latest);
    if (read === "unknown") return null;
    const note = { slotNumber: slot.slotNumber, logicalId, nodeId, session: latest, read };
    const outcome = settledBy(read);
    const settle = (phase: "drained" | "live", hold: Record<string, unknown> | null, result: string | null) =>
      deps.slots.settleIssuedByLater({ slotId: slot.slotId, attemptId: slot.attemptId!, phase, hold: hold === null ? null : JSON.stringify(hold), outcome, result, at: at() });
    if (read === "ready") return settle("live", null, null) ? { ...note, phase: "live" } : null;
    if (read === "attention") {
      const hold = attentionHold(latest);
      return settle("live", hold, heldSession(nodeId, latest, rigEventSeq(deps.db, nodeId))) ? { ...note, phase: "live", reuseHold: hold } : null;
    }
    const prior = slotRecord(slot.reuseHold);
    if (prior?.["code"] === "awaiting-decision" && !laterReady(nodeId, opts.since)) {
      return settle("drained", prior, heldSession(nodeId, latest, rigEventSeq(deps.db, nodeId))) ? { ...note, phase: "drained", reuseHold: prior } : null;
    }
    return settle("drained", null, null) ? { ...note, phase: "drained" } : null;
  };

  /**
   * An issued comeback no process runs any more (its launch was cut off by a daemon restart, or returned what it does not
   * settle), read again under the custody lease. The launch records a `restore.subset_completed` naming the node, for the
   * comeback's snapshot, before it returns, so the newest one after what the comeback was issued on settles it by the same
   * rule as the call: running (`live`, while its session runs), held, or not settled; the hold is measured from the
   * session the comeback was issued on, so a session someone started since is a later change. The node's current state
   * comes first: when its latest session reads ready, the slot is `live` with no hold, whatever the event recorded
   * (someone recovered the agent by hand before this read). With no such event, a
   * session newer than that one settles it by the later-change rule (`changes`). With neither, it stays issued and
   * `unknown`: it takes room and is never launched again. Nothing is written then.
   */
  const settleComebackLeftover = (modelNodeId: string, slot: SeatPoolSlot, changes: LaterChange[]): SettledAdd | null => {
    const attemptId = slot.attemptId!;
    const nodeId = slot.nodeId!;
    const logicalId = logicalIdOf(modelNodeId, slot.slotNumber);
    const entry = (attempt: AttemptView): SettledAdd => ({ slotNumber: slot.slotNumber, logicalId, nodeId, attempt });
    if (slot.attemptState === "reserved") {
      // A reservation is issued in the transaction that made it, so none is left behind; one that is goes back.
      const outcome = JSON.stringify({ ok: false, code: "interrupted_before_issue", launched: false, cancelled: true });
      return deps.slots.returnComebackToDrained(slot.slotId, attemptId, outcome)
        ? entry({ id: attemptId, status: "cancelled", message: CANCELLED_NOT_ISSUED, code: "interrupted_before_issue" })
        : null;
    }
    const basis = slotRecord(slot.attemptBasis);
    const snapshotId = typeof basis?.["snapshotId"] === "string" ? basis["snapshotId"] : null;
    const basisSession = typeof basis?.["sessionId"] === "string" ? basis["sessionId"] : null;
    const eventSeq = typeof basis?.["eventSeq"] === "number" ? basis["eventSeq"] : 0;
    if (snapshotId === null) return null;
    const event = restoreOf(deps.db, nodeId, eventSeq, snapshotId);
    if (event !== null) {
      const outcome = {
        ok: true, nodeId, status: event.status, ...(event.error !== undefined ? { error: event.error } : {}), fromEvent: event.seq,
        ...(event.snapshotSelection ? { snapshotSelection: event.snapshotSelection } : {}),
      };
      const latest = latestSessionView(deps.db, nodeId);
      const readyNow = latest !== null && readSession(nodeId, latest) === "ready";
      if (launchStatusIsRunning(event.status) && readyNow) {
        return deps.slots.settleAdd(slot.slotId, attemptId, { outcome: JSON.stringify(outcome), result: JSON.stringify({ nodeId, sessionId: latest!.id }), at: at() })
          ? entry({ id: attemptId, status: "running", ...(event.snapshotSelection ? { snapshotSelection: event.snapshotSelection } : {}) })
          : null;
      }
      // The node's current state first: a session that reads ready now (an agent recovered by hand since the event) is
      // not held from the event's outcome; the later-change rule below settles it `live` with no hold.
      if (!launchStatusIsRunning(event.status) && !readyNow) {
        // An `awaiting-decision` launch was rolled back, so the node's latest session is someone else's: that hold is
        // measured from the session the comeback was issued on, and a session started since (not ready yet) is a later
        // change the next read takes. Any other status keeps the launch's own session as what the hold is measured from.
        const held = settleHeldComeback({ slotId: slot.slotId, attemptId, nodeId, snapshotId }, event.status, event.error, outcome,
          event.status === "awaiting-decision" ? { sessionId: basisSession } : undefined);
        if (typeof held !== "string") return entry(held);
        if (held === "moved_on") return null;
      }
      if (readyNow) {
        // no `newerThan`: the session the comeback was issued on counts too, when it reads ready now
        const change = settleIssuedBySession(modelNodeId, slot, { since: basisSession });
        if (change) changes.push(change);
        return null;
      }
    }
    const change = settleIssuedBySession(modelNodeId, slot, { newerThan: basisSession, since: basisSession });
    if (change) changes.push(change);
    return null;
  };

  /**
   * The held slots of a model, read again under the custody lease. A hold ends only through a later change on the slot's
   * node, measured from what the hold kept: a restore since then that launched the node (a whole-rig `rig up`, or a
   * `rig launch --seats`) and did not run gives the slot that outcome (`drained` and held for a decision or a failure
   * with nothing running, `live` and held otherwise); otherwise a session newer than the kept one (which the pool did not
   * start: it never relaunches a held slot), or a new status or startup status on the kept session of a `live` slot
   * (`rig seat continue` reruns startup on the same session), is read: ready, the slot is `live` with no hold; confirmed
   * absent, `drained` and eligible, unless its hold awaits a decision and no session reached `ready` since the kept one,
   * when it stays held; needing attention, `live` and held; anything else puts the slot back in `adding` with its attempt
   * issued and `unknown`, read again every cycle. A `drained` slot's kept session ending again is no change: nothing ran
   * on it when the hold was set. A hold kept before what it is measured from was kept gets it now. No event is written.
   */
  const laterChanges = (modelNodeId: string): LaterChange[] => {
    const out: LaterChange[] = [];
    for (const slot of deps.slots.forModel(modelNodeId)) {
      if (!isWatchedHold(slot)) continue;
      const nodeId = slot.nodeId!;
      const from = slot.phase as "drained" | "live";
      const latest = latestSessionView(deps.db, nodeId);
      const seen = readHeldSession(slot.attemptResult);
      if (seen === null) {
        deps.slots.recordHeldSession(slot.slotId, slot.attemptId, slot.attemptResult, heldSession(nodeId, latest, rigEventSeq(deps.db, nodeId)));
        continue;
      }
      const hold = slotRecord(slot.reuseHold) ?? { unreadable: slot.reuseHold };
      const logicalId = logicalIdOf(modelNodeId, slot.slotNumber);
      const later = (read: LaterChange["read"], sessionId: string | null) =>
        JSON.stringify({ ...readAttemptOutcome(slot.attemptOutcome), later: { sessionId, read, at: at() } });
      const change = (to: "drained" | "live", newHold: Record<string, unknown> | null, result: string | null, outcome: string | null) =>
        deps.slots.changeHeld({
          slotId: slot.slotId, attemptId: slot.attemptId, from, to, hold: newHold === null ? null : JSON.stringify(newHold), outcome, result, at: at(),
        });
      const restore = restoreOf(deps.db, nodeId, seen.eventSeq);
      // A session that reads ready now wins over a restore outcome recorded before it.
      if (restore !== null && !launchStatusIsRunning(restore.status) && (latest === null || readSession(nodeId, latest) !== "ready")) {
        // The restore's own outcome for the node, as for a comeback's launch.
        const held = heldComeback(restore.status, sessionRuns(nodeId, latest));
        if (held !== null) {
          const newHold = { code: restore.status, ...(restore.error !== undefined ? { error: restore.error } : {}), restoreSeq: restore.seq };
          const to = held.as === "not_running" ? "drained" : "live";
          if (change(to, newHold, heldSession(nodeId, latest, restore.seq), later("restore", latest?.id ?? null))) {
            out.push({ slotNumber: slot.slotNumber, logicalId, nodeId, session: latest, read: "restore", restore: { seq: restore.seq, status: restore.status }, phase: to, reuseHold: newHold });
          }
          continue;
        }
      }
      const eventSeq = restore?.seq ?? seen.eventSeq;
      /** Nothing to end the hold: measured from now on from what was read. */
      const rebase = () => { if (eventSeq !== seen.eventSeq || latest?.id !== seen.sessionId) change(from, hold, heldSession(nodeId, latest, eventSeq), slot.attemptOutcome); };
      if (latest === null) { rebase(); continue; }
      const newer = latest.id !== seen.sessionId;
      const statusChanged = !newer && seen.status !== undefined && (latest.status !== seen.status || latest.startupStatus !== seen.startupStatus);
      // A held `live` slot whose session's executor is now confirmed stopped: its session ended, even with a stale status.
      const probeAbsent = !newer && from === "live" && deps.confirmedStopped(nodeId);
      if (!newer && !statusChanged && !probeAbsent) { rebase(); continue; }
      const read = readSession(nodeId, latest);
      // A held `drained` slot's own session: nothing ran on it when the hold was set, so only a resume of it (ready, or
      // needing attention) is a change; marked down, detached or stale, it is not.
      if (!newer && from === "drained" && read !== "ready" && read !== "attention") { rebase(); continue; }
      const note = { slotNumber: slot.slotNumber, logicalId, nodeId, session: latest, read };
      if (read === "ready") {
        if (change("live", null, null, later(read, latest.id))) out.push({ ...note, phase: "live" });
      } else if (read === "absent") {
        if (hold["code"] === "awaiting-decision" && !laterReady(nodeId, seen.sessionId)) {
          // The decision is still awaited: the hold stays, measured from this session now.
          if (change(from, hold, heldSession(nodeId, latest, eventSeq), slot.attemptOutcome)) out.push({ ...note, phase: from, reuseHold: hold });
        } else if (change("drained", null, null, later(read, latest.id))) {
          out.push({ ...note, phase: "drained" });
        }
      } else if (read === "attention") {
        const attention = attentionHold(latest);
        if (change("live", attention, heldSession(nodeId, latest, eventSeq), later(read, latest.id))) out.push({ ...note, phase: "live", reuseHold: attention });
      } else if (slot.attemptId !== null) {
        // Not settled yet (a startup still pending): counted as an unknown result, `adding` with its attempt issued, the
        // hold it had kept, and read again every cycle by its session.
        const outcome = JSON.stringify({
          ...readAttemptOutcome(slot.attemptOutcome), reread: "session", since: seen.sessionId, sinceSeq: eventSeq,
          pending: { code: "later_session_not_settled", message: `unknown: a later session on the node, ${latest.status}, startup ${latest.startupStatus ?? "unknown"}` },
          later: { sessionId: latest.id, read, at: at() },
        });
        if (deps.slots.reopenHeld({ slotId: slot.slotId, attemptId: slot.attemptId, from, outcome, at: at() })) out.push({ ...note, phase: "adding", reuseHold: hold });
      } else {
        out.push({ ...note, phase: from, reuseHold: hold });
      }
    }
    return out;
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
        return report({ modelNodeId: found.modelNodeId, slots: slotsView(deps.slots.forModel(found.modelNodeId), inFlightAttempts), held });
      }
      const { model, modelNodeId, rigId } = found;
      let block = blockView(deps.rigRepo.getNodePool(modelNodeId));
      // The report reads the slot rows when it is built, not the snapshot the plan used: an add that settles while the cycle
      // waits for custody is then reported the same way in `slots` and in `settled`.
      const base = () => ({ modelNodeId, ...block, slots: slotsView(deps.slots.forModel(modelNodeId), inFlightAttempts) });
      if (!active()) return report({ ...base(), held: JOB_STOPPED });
      if (block.block === "unusable") return report({ ...base(), held: BLOCK_UNREADABLE, advisory: unreadableAdvisory(block.error) });
      // After `pool: {}` the model has no block: the job drains with the spec last stored on its row (`drain` set), and
      // ends once every agent is drained. A job with no readable spec of its own does nothing.
      const removed = block.block === "none";
      const lastSpec = removed ? lastEnsuredSpec(job.context) : null;
      if (block.block === "none" && lastSpec === null) return report(base());
      const spec: SeatPoolSpec = block.block === "stored" ? block.spec : { ...lastSpec!, drain: true };
      const removal = removed ? { removal: "the pool block was removed; draining with the spec last stored on the job" } : {};

      // A held slot, read again before the plan, under the custody lease, so the plan sees what a later change on its
      // node made of it. Only while a slot is held, and never while the pool is: a held pool changes nothing.
      let changes: LaterChange[] = [];
      if (deps.slots.forModel(modelNodeId).some(isWatchedHold)) {
        try {
          await deps.custody([modelNodeId], async () => {
            if (!active() || readSeatPoolHold(deps.db, rigId).stoppedSeq !== null) return;
            if (blockView(deps.rigRepo.getNodePool(modelNodeId)).block === "unusable") return;
            changes = laterChanges(modelNodeId);
          });
        } catch (error) {
          // A refused custody changes nothing here; the cycle's own lease below reports it.
          if (!(error instanceof DeliveryGuardError)) throw error;
        }
      }
      const slots = deps.slots.forModel(modelNodeId);

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
          // A comeback no process runs any more is read again the same way, from the event its launch records, or by a
          // later session on its node; a slot a later change left `unknown` is read again by its node's latest session.
          for (const slot of deps.slots.forModel(modelNodeId)) {
            if (slot.phase !== "adding" || slot.attemptId === null || inFlightAttempts.has(slot.attemptId)) continue;
            const outcome = readAttemptOutcome(slot.attemptOutcome);
            if (outcome["reread"] === "session" && slot.nodeId !== null && slot.attemptState === "issued") {
              const change = settleIssuedBySession(modelNodeId, slot, {
                since: typeof outcome["since"] === "string" ? outcome["since"] : null,
                sinceSeq: typeof outcome["sinceSeq"] === "number" ? outcome["sinceSeq"] : undefined,
              });
              if (change) changes.push(change);
              continue;
            }
            const entry = slot.attemptKind === "add" ? settleLeftover(modelNodeId, slot)
              : slot.attemptKind === "comeback" && slot.nodeId !== null ? settleComebackLeftover(modelNodeId, slot, changes)
              : null;
            if (entry) reportSettled(modelNodeId, entry);
          }
          // A leftover settled `not_running` here drains its slot, which starts the cooldown the plan could not see: under
          // it, this cycle's drains wait (`drain: true` keeps its exemption), and so does its add, comebacks included.
          // Read again right before the add too: an add that settles `not_running` while the moves await is one more.
          const coolingSince = () => {
            const step = lastDrainStep(deps.slots.forModel(modelNodeId));
            return !spec.drain && step !== null && step !== read.lastStepAt
              && deps.now().getTime() - Date.parse(step) < spec.cooldownSeconds * 1000;
          };
          const coolingNow = coolingSince();
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
            // A held `live` slot is never drained by the pool: only a later change on its node ends its hold.
            for (const slot of current.filter((s) => s.phase === "live" && s.nodeId !== null && s.reuseHold === null)) {
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
          if (coolingSince()) { addNotes = { skipped: "cooldown" }; return; }
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
          /**
           * The re-check of a reservation just before its issue, add or comeback, with nothing awaited since it was made:
           * the job, the holds and the stored block again, then a new plan with the reservation counted. The cause that
           * cancels it (a stopped job, a `rig.stopped`, a lower `max`, `drain: true`, any other change to the block, or
           * surplus that reaches it), or null when it may be issued. A cause that holds the pool also sets the hold.
           */
          const recheckReservation = (slotNumber: number, comebackSession?: string | null): string | null => {
            if (!active()) { held = JOB_STOPPED; return "job_stopped"; }
            const holdNow = readSeatPoolHold(deps.db, rigId);
            if (holdNow.stoppedSeq !== null) {
              hold = holdNow;
              held = {
                cause: "rig stopped", seq: holdNow.stoppedSeq, message: `held: rig stopped (event ${holdNow.stoppedSeq})`,
                ...(holdNow.seatsLaunchedSeq !== null
                  ? { exit: `seats launched with \`rig launch --seats\` (event ${holdNow.seatsLaunchedSeq}) do not end the hold; run \`rig down\`, then \`rig up\`` }
                  : {}),
              };
              return "rig_stopped";
            }
            const storedSpec = deps.rigRepo.getNodePool(modelNodeId);
            const specNow = storedSpec !== undefined && "spec" in storedSpec ? storedSpec.spec : null;
            if (blockChangedNow()) {
              if (specNow === null) return "pool_block_changed";
              return specNow.max < spec.max ? "max_lowered" : specNow.drain ? "drain" : "pool_block_changed";
            }
            const slotsNow = deps.slots.forModel(modelNodeId);
            const stateNow = readSeatPoolState(deps, model, slotsNow);
            // A comeback's reservation took its slot out of `drained`: the rows left with that agent still wait for it, and
            // count as work waiting, as they did in the plan.
            const pending = [...stateNow.pending];
            if (comebackSession) {
              for (const row of deps.queue.pendingRows(comebackSession)) {
                if (stateNow.rawDestination.has(row.qitemId)) continue;
                pending.push({ qitemId: row.qitemId, destination: model.sessionName, waitingSince: row.waitingSince, tags: spec.dispatchTag ? [spec.dispatchTag] : row.tags });
              }
            }
            const replan = planSeatPool(spec, { ...stateNow, pending, lastStepAt: lastDrainStep(slotsNow) }, deps.now().getTime());
            return replan.intents.some((i) => i.kind === "cancel" && i.slotNumber === slotNumber) ? "surplus" : null;
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
                const measured = heldSession(nodeId, latestSessionView(deps.db, nodeId), rigEventSeq(deps.db, nodeId));
                comebackNotes.push(deps.slots.holdComeback(slot.slotId, JSON.stringify(hold), measured) ? { ...note, hold } : { ...note, code: "slot_moved_on" });
                continue;
              }
              const snapshotId = selection.chosen.id;
              const unknowns = selection.failed.flatMap((f) => (f.unknown ? [{ snapshotId: f.snapshotId, ...f.unknown }] : []));
              // The reservation, on the slot's own row, with the chosen snapshot, and the issue: the re-check of the
              // reservation (as an add's), then the issued attempt and what it was issued on (the snapshot, the node's
              // latest session and the rig's latest event), in one transaction. A comeback the re-check cancels, or not
              // issued, is `drained` again in the same transaction, eligible, its row never removed, and never launched;
              // an unexpected error rolls it all back, so the slot stays `drained` with the attempt it had.
              const attemptId = randomUUID();
              const issueComeback = deps.db.transaction((): { code: string; cancelled?: true } | null => {
                if (!deps.slots.reserveComeback({ slotId: slot.slotId, attemptId, snapshotId })) return { code: "slot_moved_on" };
                const cause = recheckReservation(slot.slotNumber, agentNode(deps.db, nodeId)?.sessionName ?? null);
                if (cause !== null) {
                  deps.slots.returnComebackToDrained(slot.slotId, attemptId, JSON.stringify({ ok: false, code: cause, launched: false, cancelled: true }));
                  return { code: cause, cancelled: true };
                }
                const eventSeq = (deps.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE rig_id = ?").get(rigId) as { seq: number | null }).seq;
                const basis = JSON.stringify({ snapshotId, sessionId: latestSessionView(deps.db, nodeId)?.id ?? null, eventSeq });
                if (!deps.slots.issueAttempt(slot.slotId, attemptId, basis)) {
                  deps.slots.returnComebackToDrained(slot.slotId, attemptId, JSON.stringify({ ok: false, code: "slot_changed", launched: false }));
                  return { code: "slot_changed" };
                }
                return null;
              });
              const unissued = issueComeback();
              if (unissued !== null) {
                if (unissued.cancelled) {
                  // Cancelled before its issue (`cancelled: not issued`): never launched, and this cycle's adds end.
                  cancelled.push({ slotNumber: slot.slotNumber, logicalId, attempt: { id: attemptId, status: "cancelled", message: CANCELLED_NOT_ISSUED, code: unissued.code } });
                  break units;
                }
                comebackNotes.push({ ...note, snapshotId, code: unissued.code });
                continue;
              }
              // The request goes out only once its issue committed; its call runs in this process until it settles.
              inFlightAttempts.add(attemptId);
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

            // The re-check just before the issue (recheckReservation): what cancels the reservation cancels it before any
            // operation row or call, and ends this cycle's adds.
            let cancelCause: string | null;
            try {
              cancelCause = recheckReservation(slot.slotNumber);
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
        ...(changes.length ? { laterChanges: changes } : {}),
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
