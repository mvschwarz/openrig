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
import type { SeatPoolSlot, SeatPoolSlotsRepository } from "./seat-pool-slots.js";
import type { SeatPoolSpec, StoredSeatPool } from "./seat-pool-spec.js";
import { deriveCanonicalSessionName } from "./session-name.js";
import { seatLaunchAdditionPathsForNode } from "./seat-launch-additions.js";
import type { SeatSkillPaths } from "./seat-skill-storage.js";
import type { AddMemberOutcome } from "./rigspec-instantiator.js";
import type { ConvergeResult, TopologyOp } from "./topology-converge.js";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";

// #3395 (Piece 1): the seat-pool executor, which the `seat-pool` policy hands each evaluation to.
//
// One cycle reads the pool afresh (the model's stored block, its slot rows, each pool agent's latest session, activity,
// open rows and held messages, and the rows waiting for the model or for a drained agent), plans with the pure planner,
// and applies two effects: moving a waiting row to a free pool agent, and adding agents. The plan is read outside any
// lease; the hold check, the moves and the add's reservation and issue run under the delivery guard's custody lease on
// the model node, and each move re-checks the stored block and the agent just before it.
//
// An add reserves a new `<member>-s<n>` slot, issues it with an operation id, and, after the lease is released, adds the
// member through the same converge path as `rig add`, from the model member as the export writes it (without
// `pool`, `id`, `label`, `cwd` and `session_source`, and with `keep_alive: false`). The cycle does not wait for the launch: it reports
// the add in flight, and the settlement writes the outcome to the slot row (the agent runs: `live`; no node was created:
// the row goes and frees the number). A later cycle reports what settled.
//
// The whole pool is held, and nothing is moved or added, while the job is not `active`, while the stored block can't be
// read, while the model node is gone (or has no canonical session), and from the rig's latest `rig.stopped` until a
// later `restore.completed`, whatever its result. The cause goes in the job's notes. Draining and bringing agents back
// are not done here; while a slot is `drained`, no new number is added.

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

export interface SeatPoolExecutorDeps {
  /** The job's model, the agents' latest sessions and the rig's events. */
  db: Database.Database;
  rigRepo: Pick<RigRepository, "getNodePool" | "getNodeLaunchRecipe" | "getRig">;
  slots: Pick<SeatPoolSlotsRepository, "forModel" | "get" | "reserveAdd" | "issueAttempt" | "recordAttemptNode" | "settleAdd"
    | "recordAttemptOutcome" | "removeAddWithoutNode">;
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
  /** The add's effects. Without them a cycle adds nothing (and skips the whole add stage). */
  add?: SeatPoolAddDeps;
}

export interface SeatPoolExecutor {
  /** One cycle of the job: read, hold, plan, move, add. Never throws for a refused move or a custody refusal. */
  cycle(job: Pick<PolicyJob, "jobId" | "context">): Promise<PolicyEvaluation>;
  /** Resolves once every add started so far has settled. */
  idle(): Promise<void>;
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

/** How a slot's attempt is reported. Reserved or issued: in flight. Settled: the add settled running. */
interface AttemptView { id: string; status: "in_flight" | "running" | "no_node"; message?: string; code?: string }

function inFlight(attemptId: string): AttemptView {
  return { id: attemptId, status: "in_flight", message: `in flight (attempt ${attemptId})` };
}

function slotsView(slots: readonly SeatPoolSlot[]): Array<{ slotNumber: number; nodeId: string | null; phase: SeatPoolPhase; attempt?: AttemptView }> {
  return slots.map((slot) => ({
    slotNumber: slot.slotNumber,
    nodeId: slot.nodeId,
    phase: slot.phase,
    ...(slot.attemptId === null || slot.attemptState === null
      ? {}
      : { attempt: slot.attemptState === "settled" ? { id: slot.attemptId, status: "running" as const } : inFlight(slot.attemptId) }),
  }));
}

/** The interim rule until drained slots come back: no new number while one is `drained`. Reported for the add only. */
const DRAINED_SLOT_GUARD = "held: drained slot awaiting comeback";
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

/** What one add settled as, reported by the model's next cycle. */
interface SettledAdd { slotNumber: number; logicalId: string; nodeId?: string; attempt: AttemptView }

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A refusal to issue an add, raised inside the issue transaction so it rolls back. */
class AddNotIssued extends Error {
  constructor(readonly code: string) { super(code); }
}

export function makeSeatPoolExecutor(deps: SeatPoolExecutorDeps): SeatPoolExecutor {
  /** The adds started and not settled yet. */
  const pending = new Set<Promise<void>>();
  /** model node id → what settled since that model's last report. */
  const settled = new Map<string, SettledAdd[]>();

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
    const report = (entry: SettledAdd) => settled.set(modelNodeId, [...(settled.get(modelNodeId) ?? []), entry]);
    try {
      let outcome: AddCallOutcome | undefined;
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
      const stored = JSON.stringify(outcome);
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
      const runs = outcome.ok && outcome.status === "launched" && latest !== null
        && (latest.status === "running" || latest.status === "idle") && latest.startupStatus === "ready";
      if (runs && deps.slots.settleAdd(add.slotId, add.attemptId, {
        outcome: stored, result: JSON.stringify({ nodeId: slot.nodeId, sessionId: latest!.id }), at: deps.now().toISOString(),
      })) {
        report({ slotNumber: add.slotNumber, logicalId: add.logicalId, nodeId: slot.nodeId, attempt: { id: add.attemptId, status: "running" } });
        return;
      }
      // A node that does not run (or not yet) is not settled here: the attempt stays issued, with its outcome kept.
      deps.slots.recordAttemptOutcome(add.slotId, add.attemptId, stored);
    } catch (error) {
      report({ slotNumber: add.slotNumber, logicalId: add.logicalId, attempt: { ...inFlight(add.attemptId), code: "settle_failed", message: errorMessage(error) } });
    }
  };

  /** One add after another, each after the lease is released; the cycle does not wait for them. */
  const startAdds = (modelNodeId: string, adds: readonly IssuedAdd[]) => {
    if (adds.length === 0) return;
    const run = adds.reduce<Promise<void>>((previous, add) => previous.then(() => runAdd(modelNodeId, add)), Promise.resolve());
    pending.add(run);
    void run.finally(() => pending.delete(run));
  };

  return {
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    async cycle(job) {
      const active = () => deps.jobsRepo.getById(job.jobId)?.state === "active";
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
      if (block.block === "none") return report(base());
      if (block.block === "unusable") return report({ ...base(), held: BLOCK_UNREADABLE, advisory: unreadableAdvisory(block.error) });

      // The plan is read outside the lease; the custody is for the hold check, the moves and the add's reservation and
      // issue. The add's call goes out after it.
      const spec = block.spec;
      const read = readSeatPoolState(deps, model, slots);
      const plan = planSeatPool(spec, read, deps.now().getTime());
      const dispatches = plan.intents.filter((i): i is Extract<SeatPoolIntent, { kind: "dispatch" }> => i.kind === "dispatch");
      const addIntent = plan.intents.find((i): i is Extract<SeatPoolIntent, { kind: "add" }> => i.kind === "add");
      const plannedTo = (slotNumber: number) => read.agents.find((a) => a.slotNumber === slotNumber)?.sessionName ?? `slot ${slotNumber}`;

      let held: Held | undefined;
      let advisory: string | undefined;
      let hold: SeatPoolHoldRead | undefined;
      let custody: { code: string; message: string } | undefined;
      const moved: Move[] = [];
      const skipped: Array<Move & { code: string }> = [];
      const failed: Array<Move & { code: string; message: string }> = [];
      let addNotes: Record<string, unknown> | undefined;
      const issued: IssuedAdd[] = [];
      let blockChanged = false;
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
          for (const [index, d] of dispatches.entries()) {
            // A job stopped while an earlier move awaited: no later effect.
            if (!active()) { held = JOB_STOPPED; break; }
            const from = read.rawDestination.get(d.qitemId)!;
            // The block again: a re-apply since the plan (cleared, broken or with any other value) stops the planned moves
            // here, since the plan may no longer hold (a new dispatch_tag, a longer dispatch_after_s, drain, a lower max).
            // The next evaluation plans against the block as it is then.
            const storedNow = deps.rigRepo.getNodePool(modelNodeId);
            if (storedNow === undefined || !("spec" in storedNow) || !sameSpec(storedNow.spec, spec)) {
              blockChanged = true;
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

          // The add, after the moves of the same cycle, under the same lease. Nothing in it awaits.
          if (!addIntent || !deps.add || held || blockChanged) return;
          if (!active()) { held = JOB_STOPPED; return; }
          const storedNow = deps.rigRepo.getNodePool(modelNodeId);
          if (storedNow === undefined || !("spec" in storedNow) || !sameSpec(storedNow.spec, spec)) {
            addNotes = { skipped: "pool_block_changed" };
            return;
          }
          const current = deps.slots.forModel(modelNodeId);
          if (current.some((slot) => slot.phase === "drained")) { addNotes = { held: DRAINED_SLOT_GUARD }; return; }
          const refusal = addRefusal(rigId, modelNodeId);
          if (refusal) { addNotes = { refused: refusal }; return; }
          let raw: Record<string, unknown>;
          try {
            raw = deps.add.exportMember(rigId, modelNodeId);
          } catch (error) {
            addNotes = { refused: `add refused: the model member can't be exported (${errorMessage(error)})` };
            return;
          }
          const inherited = Object.fromEntries(Object.entries(raw).filter(([key]) => !NOT_INHERITED.includes(key)));
          const pod = modelPod(deps.db, modelNodeId);
          if (pod === null) { addNotes = { refused: "add refused: the model member has no pod" }; return; }
          const rigRoot = deps.rigRepo.getNodeLaunchRecipe(modelNodeId)?.rigRoot ?? ".";
          const launchAdditionsFrom = seatLaunchAdditionPathsForNode(deps.db, modelNodeId);
          const issuedView: Array<{ slotNumber: number; logicalId: string; attempt: AttemptView }> = [];
          const notIssued: Array<{ slotNumber: number; logicalId: string; code: string }> = [];
          for (let unit = 0; unit < addIntent.count; unit++) {
            if (!active()) { held = JOB_STOPPED; break; }
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

            // The re-check just before the issue (a lower max, drain, a hold or surplus since the plan) goes here.

            // The issue: the job's state and the holds again, then the issued attempt, what it was issued on and the
            // operation id, in one transaction.
            const targets = [rigId, pod];
            const body = JSON.stringify({ member, rigRoot });
            let operation: IssuedAdd["operation"];
            let stopped: SeatPoolHoldRead | undefined;
            try {
              const recheck = readSeatPoolHold(deps.db, rigId);
              if (!active() || recheck.stoppedSeq !== null) {
                stopped = recheck;
                throw new AddNotIssued("held");
              }
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
              if (stopped !== undefined) {
                if (!active()) held = JOB_STOPPED;
                else { hold = stopped; held = { cause: "rig stopped", seq: stopped.stoppedSeq!, message: `held: rig stopped (event ${stopped.stoppedSeq})` }; }
                break;
              }
              notIssued.push({ slotNumber: slot.slotNumber, logicalId, code: error.code });
              continue;
            }
            issued.push({
              slotId: slot.slotId, slotNumber: slot.slotNumber, logicalId, attemptId, rigId, rigRoot, folder, launchAdditionsFrom, operation,
              op: { kind: "add_member", pod, member },
            });
            issuedView.push({ slotNumber: slot.slotNumber, logicalId, attempt: inFlight(attemptId) });
          }
          addNotes = {
            ...(issuedView.length ? { issued: issuedView } : {}),
            ...(notIssued.length ? { failed: notIssued } : {}),
          };
        });
      } catch (error) {
        thrown = error;
      }
      // The calls go out after the lease is released, whatever happened after their issue.
      startAdds(modelNodeId, issued);
      if (thrown !== undefined) {
        // A refused custody is not a failure: the cycle had no effect.
        if (!(thrown instanceof DeliveryGuardError)) throw thrown;
        custody = { code: thrown.code, message: thrown.message };
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
        ...(addNotes && Object.keys(addNotes).length ? { add: addNotes } : {}),
        ...(custody ? { custody } : {}),
      });
    },
  };
}
