// The seat-pool planner: how many extra agents a pool wants, which waiting rows move to which free agent, which free
// agents drain and which reserved adds are cancelled.
//
// A seat pool clones one model member into extra agents named `<member>-s<n>`. Each agent has a slot on record, in one
// of four phases: `adding`, `live`, `draining` or `drained`. The planner is pure: the same facts and clock always give
// the same plan. It reads no database and starts, stops or moves nothing; its caller is the seat-pool executor
// (seat-pool-executor.ts), which reads the facts (the slots, each agent's latest session, its open rows and held
// messages, the waiting rows) and applies the plan.
//
// The `seat-pool` watchdog policy, at the end of this file, is the job's side. It hands each evaluation to the
// executor it is given, which reads the pool, applies the holds and moves waiting rows. The watchdog engine does not run
// it until the activation change arms the job.
//
// The rules are the agreed sizing for Piece 1:
//   L (live)      agents in phase `live` whose session runs;
//   S (starting)  agents in phase `adding`, reserved or issued;
//   I (issued)    starting agents whose attempt is `issued` and not settled;
//   O (occupied)  agents in L that are not free, or that receive a row in this plan;
//   R (unplaced)  movable rows that got no free agent in this plan.
//
//   desired = R + O
//   wanted  = max(min, desired, O + S)             the demand before the clamp
//   target  = drain ? 0 : min(max, wanted)
//   current = L + S
//   surplus = max(0, current − I − target)
//   room    = max − (adding + live + draining slots on record)
//
// Surplus first cancels `reserved` adds, newest first, then drains free agents idle past `idle_grace_s`, newest first.
// An `issued` attempt is never cancelled or drained by sizing. A held message counts once, as occupancy: there is no
// separate term for it and no "+1".
//
// A plan that would read `steady` while `wanted` is above `max` and movable rows are still unplaced reads
// `max_reached` instead: the pool is full and work waits. Only the reason changes; the target and the intents stay.

import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";

/** A slot's phase. Nothing is removed: a drained agent keeps its node, sessions and history. */
export type SeatPoolPhase = "adding" | "live" | "draining" | "drained";

/** Where an add or comeback attempt stands. `issued` and not settled is what `I` counts. */
export type SeatPoolAttemptState = "reserved" | "issued" | "settled";

/** The part of the pool block the planner reads. */
export interface SeatPoolPlanSpec {
  /** Extra agents on record (adding, live or draining) the pool may hold. 0 is valid: no extra agent. */
  max: number;
  min: number;
  /** How long a pending row waits at its destination before the pool may move it. */
  dispatchAfterSeconds: number;
  /** How long a free agent stays idle before surplus may drain it. */
  idleGraceSeconds: number;
  /** The quiet time after an add or drain step before the next one. Ignored under `drain`. */
  cooldownSeconds: number;
  /** Only rows to the model that carry this tag move and count. Null: every row to the model. */
  dispatchTag: string | null;
  /** True sets the target to 0: nothing moves, no add, and free agents drain without waiting for the cooldown. */
  drain: boolean;
}

/** The raw facts about one pool agent. The planner decides from these; the caller fills them and decides nothing. */
export interface SeatPoolAgentFacts {
  /** The `n` of `<member>-s<n>`. A higher number is newer: drains and the agents above `max` count from the highest. */
  slotNumber: number;
  /** The agent's session name, which rows are addressed to. Null for an add that has no node yet. */
  sessionName: string | null;
  phase: SeatPoolPhase;
  /** The attempt on the slot, if any. Only `reserved` and `issued` on an `adding` slot matter to sizing. */
  attemptState: SeatPoolAttemptState | null;
  /** The agent's latest session runs. False for a session that stopped, is gone or is unknown, and for an agent whose
   *  attempt settled without proof that it runs. */
  running: boolean;
  /** The agent sits idle at its prompt. */
  idleAtPrompt: boolean;
  /** Since when it has sat idle at its prompt, as an ISO time. Null when unknown: it then never passes `idle_grace_s`. */
  idleSince: string | null;
  /** Its open rows: pending, in progress or blocked. */
  openRows: number;
  /** Messages held for it in the outbox. */
  heldCount: number;
}

/** A pending row addressed to the model or to a pool agent. Priority is not read: rows move oldest first. */
export interface SeatPoolPendingRow {
  qitemId: string;
  destination: string;
  /** When the row started waiting where it is (its creation, its latest reroute or its latest release back to pending by a
   *  handover or a fresh launch), as an ISO time. */
  waitingSince: string;
  tags: readonly string[];
}

export interface SeatPoolPlanState {
  /** The model agent's session name: rows addressed to it are the pool's to move (with `dispatch_tag`, only tagged). */
  modelSession: string;
  agents: readonly SeatPoolAgentFacts[];
  pending: readonly SeatPoolPendingRow[];
  /** The time of the latest add or drain step, as an ISO time. Null: none yet. */
  lastStepAt: string | null;
}

export type SeatPoolIntent =
  /** Move a waiting row to a free agent, only while it is still pending and addressed to `from`. */
  | { kind: "dispatch"; qitemId: string; from: string; slotNumber: number }
  /** Cancel a reserved add or comeback before it is issued. */
  | { kind: "cancel"; slotNumber: number }
  /** Drain a free agent that has been idle since `idleSince`, as the plan read it. */
  | { kind: "drain"; slotNumber: number; idleSince: string }
  /** Start `count` more agents. */
  | { kind: "add"; count: number };

export type SeatPoolPlanReason = "draining" | "scale_up" | "scale_down" | "steady" | "cooldown" | "max_reached";

export interface SeatPoolPlan {
  intents: SeatPoolIntent[];
  reason: SeatPoolPlanReason;
  target: number;
  current: number;
  surplus: number;
  room: number;
  /** The terms the target came from, for the job's history. `wanted` is the demand before the clamp to `max`. */
  counts: { live: number; starting: number; issued: number; occupied: number; unplaced: number; wanted: number };
}

/** Whether a slot takes room under `max`: every slot on record except a `drained` one. */
function takesRoom(agent: SeatPoolAgentFacts): boolean {
  return agent.phase !== "drained";
}

/** In `L`: phase `live` and its session runs. */
function isLive(agent: SeatPoolAgentFacts): boolean {
  return agent.phase === "live" && agent.running;
}

/** Free: `live`, running, idle at its prompt, no open row and no held message. */
function isFree(agent: SeatPoolAgentFacts): boolean {
  return isLive(agent) && agent.idleAtPrompt && agent.openRows === 0 && agent.heldCount === 0;
}

/** Newest first: the highest slot number first. */
function newestFirst(a: SeatPoolAgentFacts, b: SeatPoolAgentFacts): number {
  return b.slotNumber - a.slotNumber;
}

/** A stable tie-break for rows that waited since the same moment. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether `iso` is at least `seconds` before `nowMs`. An unreadable time never passes. */
function elapsed(iso: string | null, seconds: number, nowMs: number): boolean {
  if (iso === null) return false;
  const atMs = Date.parse(iso);
  return Number.isFinite(atMs) && nowMs - atMs >= seconds * 1000;
}

/**
 * The slot numbers of the agents above `max`: the slots that take room, counted newest first, beyond the first `max`
 * from the lowest number. After `max` is lowered they receive no new row, and they come first in the drain order. With
 * `max: 0` that is every agent. A lower slot that takes room without serving (`adding`, `draining`, or `live` and not
 * running) still keeps its place, so a free agent above it can wait with no row until that slot settles.
 */
export function seatPoolAboveMax(spec: Pick<SeatPoolPlanSpec, "max">, agents: readonly SeatPoolAgentFacts[]): Set<number> {
  const onRecord = agents.filter(takesRoom).sort((a, b) => a.slotNumber - b.slotNumber);
  return new Set(onRecord.slice(Math.max(0, spec.max)).map((agent) => agent.slotNumber));
}

/**
 * Whether an agent may receive a moved row now: the pool is not draining, the agent is free (`live`, running, idle at
 * its prompt, no open row, no held message) and it is not above `max`. The planner asks this, and the caller asks it
 * again just before the move.
 */
export function seatPoolCanReceive(
  spec: Pick<SeatPoolPlanSpec, "drain" | "max">,
  agents: readonly SeatPoolAgentFacts[],
  agent: SeatPoolAgentFacts,
): boolean {
  return canReceive(spec, seatPoolAboveMax(spec, agents), agent);
}

/** The check behind seatPoolCanReceive, with the above-max set the planner computes once per plan. */
function canReceive(
  spec: Pick<SeatPoolPlanSpec, "drain">,
  aboveMax: ReadonlySet<number>,
  agent: SeatPoolAgentFacts,
): boolean {
  return !spec.drain && isFree(agent) && !aboveMax.has(agent.slotNumber);
}

/** How many more agents `max` leaves room for: every slot on record but a `drained` one takes room. */
export function seatPoolRoom(spec: Pick<SeatPoolPlanSpec, "max">, agents: readonly SeatPoolAgentFacts[]): number {
  return Math.max(0, spec.max - agents.filter(takesRoom).length);
}

/** The plan for one cycle. Pure: the same spec, state and clock always give the same plan. */
export function planSeatPool(spec: SeatPoolPlanSpec, state: SeatPoolPlanState, nowMs: number): SeatPoolPlan {
  const { agents } = state;
  const intents: SeatPoolIntent[] = [];

  // A row to a `drained` agent is movable whatever its tag; a row to an agent in `adding`, `live` or `draining` stays
  // with that agent and counts only through its occupancy. A row to the model moves only with the dispatch tag, if set.
  const drainedSessions = new Set(
    agents.filter((agent) => agent.phase === "drained" && agent.sessionName !== null).map((agent) => agent.sessionName),
  );
  const movable = state.pending
    .filter((row) => elapsed(row.waitingSince, spec.dispatchAfterSeconds, nowMs))
    .filter((row) => drainedSessions.has(row.destination)
      || (row.destination === state.modelSession && (spec.dispatchTag === null || row.tags.includes(spec.dispatchTag))))
    .sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince) || compareIds(a.qitemId, b.qitemId));

  // Oldest row first, each to the lowest-numbered free agent not taken yet. Under `drain` nothing moves.
  const aboveMax = seatPoolAboveMax(spec, agents);
  const receivers = agents
    .filter((agent) => canReceive(spec, aboveMax, agent))
    .sort((a, b) => a.slotNumber - b.slotNumber);
  const receiving = new Set<number>();
  for (const [index, row] of movable.entries()) {
    const receiver = receivers[index];
    if (!receiver) break;
    receiving.add(receiver.slotNumber);
    intents.push({ kind: "dispatch", qitemId: row.qitemId, from: row.destination, slotNumber: receiver.slotNumber });
  }

  const live = agents.filter(isLive);
  const starting = agents.filter((agent) => agent.phase === "adding");
  const issued = starting.filter((agent) => agent.attemptState === "issued");
  const occupied = live.filter((agent) => !isFree(agent) || receiving.has(agent.slotNumber));
  const unplaced = movable.length - receiving.size;

  const current = live.length + starting.length;
  const wanted = Math.max(spec.min, unplaced + occupied.length, occupied.length + starting.length);
  const target = spec.drain ? 0 : Math.min(spec.max, wanted);
  const surplus = Math.max(0, current - issued.length - target);
  const room = seatPoolRoom(spec, agents);
  // Inside the cooldown after the latest step. An unreadable time starts no cooldown.
  const lastStepMs = state.lastStepAt === null ? Number.NaN : Date.parse(state.lastStepAt);
  const cooling = !spec.drain && Number.isFinite(lastStepMs) && nowMs - lastStepMs < spec.cooldownSeconds * 1000;

  // Surplus cancels reserved adds first, newest first. Cancelling is not a step, so it does not wait for the cooldown.
  const reserved = starting.filter((agent) => agent.attemptState === "reserved").sort(newestFirst);
  const cancelled = reserved.slice(0, surplus);
  for (const agent of cancelled) intents.push({ kind: "cancel", slotNumber: agent.slotNumber });

  // Then the surplus left falls on the free agents, newest first. Of those, only an agent idle past `idle_grace_s` is
  // drained, outside the cooldown. A newer free agent still inside the grace keeps its place in the drain order, so the
  // surplus waits for it rather than draining an older agent instead. An occupied agent is never drained: surplus above
  // the busy agents waits for them to finish.
  const chosen = live
    .filter((agent) => isFree(agent) && !receiving.has(agent.slotNumber))
    .sort(newestFirst)
    .slice(0, surplus - cancelled.length);
  const drainable = chosen.filter((agent) => elapsed(agent.idleSince, spec.idleGraceSeconds, nowMs));
  if (!cooling) {
    for (const agent of drainable) intents.push({ kind: "drain", slotNumber: agent.slotNumber, idleSince: agent.idleSince! });
  }

  let reason: SeatPoolPlanReason = spec.drain
    ? "draining"
    : target > current ? "scale_up" : target < current ? "scale_down" : "steady";
  if (!spec.drain && target > current) {
    const count = Math.min(target - current, room);
    if (count <= 0) reason = "max_reached";
    else if (cooling) reason = "cooldown";
    else intents.push({ kind: "add", count });
  }
  // Full at max with work still waiting: not steady. The dispatches above stay, and no add is made.
  if (reason === "steady" && wanted > spec.max && unplaced > 0) reason = "max_reached";
  if (cooling && drainable.length > 0) reason = "cooldown";

  return {
    intents,
    reason,
    target,
    current,
    surplus,
    room,
    counts: {
      live: live.length, starting: starting.length, issued: issued.length, occupied: occupied.length, unplaced, wanted,
    },
  };
}

/** The watchdog policy name of the seat pool job. */
export const SEAT_POOL_POLICY_NAME = "seat-pool";

/** What the seat pool policy calls, injected by whoever composes it: the executor's cycle. */
export interface SeatPoolPolicyDeps {
  cycle(job: Pick<PolicyJob, "jobId" | "context">): Promise<PolicyEvaluation>;
}

/**
 * The `seat-pool` job's policy. The job finds its pool through the model node named in its spec (`model_node_id`),
 * never through a list kept on the job, so a replacement job finds the same agents. Each evaluation is the executor's
 * cycle: it reads the pool afresh, applies the holds and moves waiting rows to free pool agents.
 */
export function makeSeatPoolPolicy(deps: SeatPoolPolicyDeps): Policy {
  return { name: SEAT_POOL_POLICY_NAME, evaluate: (job) => deps.cycle(job) };
}
