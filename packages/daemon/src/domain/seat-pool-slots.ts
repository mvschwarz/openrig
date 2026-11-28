import type Database from "better-sqlite3";
import { ulid } from "ulid";

// #3395 (Piece 1): the agents of a seat pool, one row per slot, keyed by the model node. A drained agent keeps its node,
// name and history. The only row the pool removes is an add's own row when the add ended with no node (or was cancelled
// before it was issued), which frees the number. Deleting a node by hand takes its slot row with it (ON DELETE CASCADE),
// which frees the number too.
//
// An add's attempt lives on its row: reserved with a new number, issued under the model's custody lease, then settled
// running (`live`), settled not running (`drained`, with a reuse hold, never tried again), settled `live` and held (a
// launch that needs attention while a session may run: not free, never drained by the pool), kept issued with an
// `unknown` outcome until a later read settles it, or removed (cancelled before the issue, or no node was created). A
// comeback's attempt lives on the drained slot's own row: reserved, issued, then settled running (`live`), already
// running (`live`, no hold), held (`drained` when nothing runs, `live` when a session may run), refused (`drained`
// again, with a reuse hold) or never launched (`drained` again, with no hold). Every write of an attempt checks the row
// still holds that attempt id in the state the write expects.
//
// A held slot keeps in `attempt_result` the node's latest session as it was when the hold was set (its id, status and
// startup status): a later change on the node (a newer session, or a new status on that session) is what can clear the
// hold, and nothing else does.

export type SeatPoolSlotPhase = "adding" | "live" | "draining" | "drained";
export type SeatPoolSlotAttemptKind = "add" | "comeback";
export type SeatPoolSlotAttemptState = "reserved" | "issued" | "settled";

export interface SeatPoolSlot {
  slotId: string;
  modelNodeId: string;
  /** The `n` of the agent's `<model logical id>-s<n>`. */
  slotNumber: number;
  /** The agent's node; null until the add has created it. */
  nodeId: string | null;
  phase: SeatPoolSlotPhase;
  phaseChangedAt: string;
  /** The slot's latest attempt; null when it has none. The add's id is its operation id. */
  attemptId: string | null;
  attemptKind: SeatPoolSlotAttemptKind | null;
  attemptState: SeatPoolSlotAttemptState | null;
  /** JSON: what the attempt was issued on. */
  attemptBasis: string | null;
  /** JSON: the attempt's outcome as the call returned it. */
  attemptOutcome: string | null;
  /** JSON: `{ nodeId, sessionId }` of the session the attempt settled with. */
  attemptResult: string | null;
  reuseHold: string | null;
  createdAt: string;
}

interface SlotRow {
  slot_id: string;
  model_node_id: string;
  slot_number: number;
  node_id: string | null;
  phase: SeatPoolSlotPhase;
  phase_changed_at: string;
  attempt_id: string | null;
  attempt_kind: SeatPoolSlotAttemptKind | null;
  attempt_state: SeatPoolSlotAttemptState | null;
  attempt_basis: string | null;
  attempt_outcome: string | null;
  attempt_result: string | null;
  reuse_hold: string | null;
  created_at: string;
}

const fromRow = (row: SlotRow): SeatPoolSlot => ({
  slotId: row.slot_id,
  modelNodeId: row.model_node_id,
  slotNumber: row.slot_number,
  nodeId: row.node_id,
  phase: row.phase,
  phaseChangedAt: row.phase_changed_at,
  attemptId: row.attempt_id,
  attemptKind: row.attempt_kind,
  attemptState: row.attempt_state,
  attemptBasis: row.attempt_basis,
  attemptOutcome: row.attempt_outcome,
  attemptResult: row.attempt_result,
  reuseHold: row.reuse_hold,
  createdAt: row.created_at,
});

/** A recorded outcome as an object; one that isn't a JSON object reads as empty. */
export function readAttemptOutcome(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export class SeatPoolSlotsRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * The number and name for a new slot of a model: one more than the highest number recorded for that model, skipping
   * any `<model>-s<n>` the rig already has, so creating the agent never meets an existing member.
   */
  nextSlot(modelNodeId: string): { slotNumber: number; logicalId: string } {
    const model = this.db.prepare("SELECT rig_id, logical_id FROM nodes WHERE id = ?").get(modelNodeId) as
      { rig_id: string; logical_id: string } | undefined;
    if (!model) throw new Error(`seat pool: model node ${modelNodeId} not found`);
    const highest = this.db.prepare("SELECT MAX(slot_number) AS n FROM seat_pool_slots WHERE model_node_id = ?")
      .get(modelNodeId) as { n: number | null };
    const taken = this.db.prepare("SELECT 1 FROM nodes WHERE rig_id = ? AND logical_id = ?");
    let n = highest.n ?? 0;
    do {
      if (n >= Number.MAX_SAFE_INTEGER) throw new Error(`seat pool: no slot number left for model node ${modelNodeId}`);
      n++;
    } while (taken.get(model.rig_id, `${model.logical_id}-s${n}`));
    return { slotNumber: n, logicalId: `${model.logical_id}-s${n}` };
  }

  /** Refuses a slot number that is not a positive safe integer, and an agent node that is the model's own node or a
   *  node of another rig. */
  insert(input: { modelNodeId: string; slotNumber: number; nodeId: string | null; phase: SeatPoolSlotPhase; at: string }): SeatPoolSlot {
    if (!Number.isSafeInteger(input.slotNumber) || input.slotNumber < 1) {
      throw new Error(`seat pool: slot number must be a positive safe integer, got ${input.slotNumber}`);
    }
    if (input.nodeId !== null) {
      if (input.nodeId === input.modelNodeId) throw new Error("seat pool: a model node cannot be its own pool agent");
      const rigOf = this.db.prepare("SELECT rig_id FROM nodes WHERE id = ?");
      const model = rigOf.get(input.modelNodeId) as { rig_id: string } | undefined;
      const agent = rigOf.get(input.nodeId) as { rig_id: string } | undefined;
      if (model && agent && agent.rig_id !== model.rig_id) {
        throw new Error(`seat pool: agent node ${input.nodeId} is in another rig than model node ${input.modelNodeId}`);
      }
    }
    const slotId = ulid();
    this.db.prepare(
      `INSERT INTO seat_pool_slots (slot_id, model_node_id, slot_number, node_id, phase, phase_changed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(slotId, input.modelNodeId, input.slotNumber, input.nodeId, input.phase, input.at, input.at);
    return this.get(slotId)!;
  }

  /**
   * An add's reservation, in one transaction: the next number (nextSlot) and its row in `adding`, with a reserved add
   * attempt under `attemptId` and no node yet.
   */
  reserveAdd(input: { modelNodeId: string; attemptId: string; at: string }): { slot: SeatPoolSlot; logicalId: string } {
    return this.db.transaction(() => {
      const next = this.nextSlot(input.modelNodeId);
      const slotId = ulid();
      this.db.prepare(
        `INSERT INTO seat_pool_slots (slot_id, model_node_id, slot_number, node_id, phase, phase_changed_at, attempt_id, attempt_kind,
           attempt_state, created_at)
         VALUES (?, ?, ?, NULL, 'adding', ?, ?, 'add', 'reserved', ?)`,
      ).run(slotId, input.modelNodeId, next.slotNumber, input.at, input.attemptId, input.at);
      return { slot: this.get(slotId)!, logicalId: next.logicalId };
    })();
  }

  /** A reserved attempt becomes issued, with what it was issued on. False when the row no longer holds that reserved
   *  attempt. */
  issueAttempt(slotId: string, attemptId: string, basis: string): boolean {
    return this.db.prepare(
      "UPDATE seat_pool_slots SET attempt_state = 'issued', attempt_basis = ? WHERE slot_id = ? AND attempt_id = ? AND attempt_state = 'reserved'",
    ).run(basis, slotId, attemptId).changes === 1;
  }

  /** The node an attempt created, written in the transaction that creates it. */
  recordAttemptNode(slotId: string, attemptId: string, nodeId: string): void {
    const changed = this.db.prepare("UPDATE seat_pool_slots SET node_id = ? WHERE slot_id = ? AND attempt_id = ? AND node_id IS NULL")
      .run(nodeId, slotId, attemptId).changes;
    if (changed !== 1) throw new Error(`seat pool: slot ${slotId} no longer waits for the node of attempt ${attemptId}`);
  }

  /** An issued add or comeback that runs: settled, with its outcome and the session it settled with (null when it can't
   *  be told apart, as for a comeback that found a live session), and the slot `live`. */
  settleAdd(slotId: string, attemptId: string, input: { outcome: string; result: string | null; at: string }): boolean {
    return this.db.prepare(
      `UPDATE seat_pool_slots SET attempt_state = 'settled', attempt_outcome = ?, attempt_result = ?, phase = 'live', phase_changed_at = ?
        WHERE slot_id = ? AND attempt_id = ? AND attempt_state = 'issued'`,
    ).run(input.outcome, input.result, input.at, slotId, attemptId).changes === 1;
  }

  /** An issued add that settled without running (its latest session exited, or its executor is confirmed stopped):
   *  settled, with its outcome, and the slot `drained` with a reuse hold, so it is never tried again. */
  settleAddNotRunning(slotId: string, attemptId: string, input: { outcome: string; hold: string; at: string; result?: string | null }): boolean {
    return this.db.prepare(
      `UPDATE seat_pool_slots SET attempt_state = 'settled', attempt_outcome = ?, reuse_hold = ?, attempt_result = ?, phase = 'drained',
         phase_changed_at = ?
        WHERE slot_id = ? AND attempt_id = ? AND attempt_kind = 'add' AND attempt_state = 'issued' AND phase = 'adding'`,
    ).run(input.outcome, input.hold, input.result ?? null, input.at, slotId, attemptId).changes === 1;
  }

  /** An issued add whose launch needs attention while its session may run (`attention_required`, `left_attached`, or a
   *  failure with its session still running): settled, with its outcome, and the slot `live` and held. */
  settleAddHeldLive(slotId: string, attemptId: string, input: { outcome: string; hold: string; result: string | null; at: string }): boolean {
    return this.db.prepare(
      `UPDATE seat_pool_slots SET attempt_state = 'settled', attempt_outcome = ?, reuse_hold = ?, attempt_result = ?, phase = 'live',
         phase_changed_at = ?
        WHERE slot_id = ? AND attempt_id = ? AND attempt_kind = 'add' AND attempt_state = 'issued' AND phase = 'adding'`,
    ).run(input.outcome, input.hold, input.result, input.at, slotId, attemptId).changes === 1;
  }

  /** A reserved add that is not issued: its row goes, which frees its number. Only while it is still reserved. */
  cancelReservedAdd(slotId: string, attemptId: string): boolean {
    return this.db.prepare(
      `DELETE FROM seat_pool_slots WHERE slot_id = ? AND attempt_id = ? AND attempt_kind = 'add' AND attempt_state = 'reserved'
         AND phase = 'adding' AND node_id IS NULL`,
    ).run(slotId, attemptId).changes === 1;
  }

  /** An issued attempt's outcome, kept while the attempt stays issued. */
  recordAttemptOutcome(slotId: string, attemptId: string, outcome: string): boolean {
    return this.db.prepare("UPDATE seat_pool_slots SET attempt_outcome = ? WHERE slot_id = ? AND attempt_id = ? AND attempt_state = 'issued'")
      .run(outcome, slotId, attemptId).changes === 1;
  }

  /** An add that ended with no node: its row goes, which frees its number. Only the row of that attempt, with no node. */
  removeAddWithoutNode(slotId: string, attemptId: string): boolean {
    return this.db.prepare(
      "DELETE FROM seat_pool_slots WHERE slot_id = ? AND attempt_id = ? AND attempt_kind = 'add' AND phase = 'adding' AND node_id IS NULL",
    ).run(slotId, attemptId).changes === 1;
  }

  // A comeback brings a `drained` slot back on its own row, node and name. Its writes keep the slot's
  // `phase_changed_at` (the time of the drain): only a comeback that settles running (settleAdd) changes it, so a
  // comeback held or refused does not restart the drain's cooldown.

  /**
   * A comeback's reservation on the slot's own row, only while it is `drained`, with its node and no `reuse_hold`:
   * `adding`, with a new reserved comeback attempt under `attemptId` that holds the chosen snapshot. False when the
   * slot moved on.
   */
  reserveComeback(input: { slotId: string; attemptId: string; snapshotId: string }): boolean {
    return this.db.prepare(
      `UPDATE seat_pool_slots SET phase = 'adding', attempt_id = ?, attempt_kind = 'comeback', attempt_state = 'reserved',
         attempt_basis = ?, attempt_outcome = NULL, attempt_result = NULL
        WHERE slot_id = ? AND phase = 'drained' AND reuse_hold IS NULL AND node_id IS NOT NULL`,
    ).run(input.attemptId, JSON.stringify({ snapshotId: input.snapshotId }), input.slotId).changes === 1;
  }

  /** A `drained` slot no snapshot qualifies for, or whose newest usable snapshot recorded conflicting occupants: it
   *  stays `drained` with the pool's own reuse hold, and no attempt.
   *  False when the slot is no longer `drained` or already has a hold. */
  holdComeback(slotId: string, hold: string, result?: string): boolean {
    return this.db.prepare(
      `UPDATE seat_pool_slots SET reuse_hold = ?, attempt_result = COALESCE(?, attempt_result)
        WHERE slot_id = ? AND phase = 'drained' AND reuse_hold IS NULL`,
    ).run(hold, result ?? null, slotId).changes === 1;
  }

  /** An issued comeback refused before any launch: settled with its outcome, and the slot `drained` again with the
   *  reuse hold, so the same snapshot is never sent again. */
  settleComebackRefused(slotId: string, attemptId: string, input: { outcome: string; hold: string; result?: string | null }): boolean {
    return this.db.prepare(
      `UPDATE seat_pool_slots SET attempt_state = 'settled', attempt_outcome = ?, reuse_hold = ?, attempt_result = ?, phase = 'drained'
        WHERE slot_id = ? AND attempt_id = ? AND attempt_kind = 'comeback' AND attempt_state = 'issued'`,
    ).run(input.outcome, input.hold, input.result ?? null, slotId, attemptId).changes === 1;
  }

  /** An issued comeback that settled without proof that it runs: held, `drained` when nothing runs (a decision is
   *  awaited, or it failed with no session running) or `live` when a session may run (it needs attention, is left
   *  attached, or failed with its session still running). A `drained` one keeps the drain's time, as a refusal does. */
  settleComebackHeld(slotId: string, attemptId: string, input: {
    phase: "drained" | "live"; outcome: string; hold: string; result: string | null; at: string;
  }): boolean {
    return this.db.prepare(
      `UPDATE seat_pool_slots SET attempt_state = 'settled', attempt_outcome = ?, reuse_hold = ?, attempt_result = ?, phase = ?,
         phase_changed_at = CASE WHEN ? = 'drained' THEN phase_changed_at ELSE ? END
        WHERE slot_id = ? AND attempt_id = ? AND attempt_kind = 'comeback' AND attempt_state = 'issued' AND phase = 'adding'`,
    ).run(input.outcome, input.hold, input.result, input.phase, input.phase, input.at, slotId, attemptId).changes === 1;
  }

  /** What a held slot's hold is measured from, kept where the hold has none yet (a hold written before it was kept), only
   *  while the row still has the result it was read with. */
  recordHeldSession(slotId: string, attemptId: string | null, readResult: string | null, result: string): boolean {
    return this.db.prepare(
      "UPDATE seat_pool_slots SET attempt_result = ? WHERE slot_id = ? AND attempt_id IS ? AND reuse_hold IS NOT NULL AND attempt_result IS ?",
    ).run(result, slotId, attemptId, readResult).changes === 1;
  }

  /** A held slot whose node got a later session that has not settled: back to `adding`, its settled attempt issued again
   *  with the outcome given (an unknown result, read again every cycle), and the hold it had kept. A `live` slot takes the
   *  reopen's time, so a later settle to `drained` (which keeps the phase time) counts its drain from when it left `live`;
   *  a `drained` one keeps its drain's time. */
  reopenHeld(input: { slotId: string; attemptId: string; from: "drained" | "live"; outcome: string; at: string }): boolean {
    return this.db.prepare(
      `UPDATE seat_pool_slots SET phase = 'adding', attempt_state = 'issued', attempt_outcome = ?,
         phase_changed_at = CASE WHEN phase = 'live' THEN ? ELSE phase_changed_at END
        WHERE slot_id = ? AND attempt_id = ? AND phase = ? AND reuse_hold IS NOT NULL AND attempt_state = 'settled'`,
    ).run(input.outcome, input.at, input.slotId, input.attemptId, input.from).changes === 1;
  }

  /** An issued attempt, of either kind, settled by its node's latest session rather than by its call: the slot goes to
   *  `phase` with the hold given (null: none), the outcome and what the hold is measured from (null: nothing). A slot that
   *  goes to `drained` keeps its phase time, unless `drainedNow` (a held `live` slot put back in `adding`): then it is
   *  drained from `at`. */
  settleIssuedByLater(input: {
    slotId: string; attemptId: string; phase: "drained" | "live"; hold: string | null; outcome: string; result: string | null; at: string;
    drainedNow?: boolean;
  }): boolean {
    return this.db.prepare(
      `UPDATE seat_pool_slots SET attempt_state = 'settled', phase = ?, reuse_hold = ?, attempt_outcome = ?, attempt_result = ?,
         phase_changed_at = CASE WHEN ? = 'drained' AND ? = 0 THEN phase_changed_at ELSE ? END
        WHERE slot_id = ? AND attempt_id = ? AND attempt_state = 'issued' AND phase = 'adding'`,
    ).run(input.phase, input.hold, input.outcome, input.result, input.phase, input.drainedNow === true ? 1 : 0, input.at, input.slotId, input.attemptId).changes === 1;
  }

  /**
   * A later change on a held slot's node, only while the slot is still held in `from` under the same attempt: the slot
   * goes to `to` with the hold given (null clears it), the outcome given and the session it was read with. A slot that
   * stays where it is keeps its phase time; one that moves takes the change's time (a `live` slot whose session ended is
   * `drained` from then, which the cooldown counts as any drain step).
   */
  changeHeld(input: {
    slotId: string; attemptId: string | null; from: "drained" | "live"; to: "drained" | "live"; hold: string | null;
    outcome: string | null; result: string | null; at: string;
  }): boolean {
    return this.db.prepare(
      `UPDATE seat_pool_slots SET phase = ?, reuse_hold = ?, attempt_outcome = ?, attempt_result = ?,
         phase_changed_at = CASE WHEN phase = ? THEN phase_changed_at ELSE ? END
        WHERE slot_id = ? AND attempt_id IS ? AND phase = ? AND reuse_hold IS NOT NULL AND (attempt_state IS NULL OR attempt_state = 'settled')`,
    ).run(input.to, input.hold, input.outcome, input.result, input.to, input.at, input.slotId, input.attemptId, input.from)
      .changes === 1;
  }

  /** A comeback that was never launched (not issued, or held after its issue): settled with its outcome, and the slot
   *  `drained` again with no reuse hold, its node and history kept. Never removes the row. */
  returnComebackToDrained(slotId: string, attemptId: string, outcome: string): boolean {
    return this.db.prepare(
      `UPDATE seat_pool_slots SET phase = 'drained', attempt_state = 'settled', attempt_outcome = ?
        WHERE slot_id = ? AND attempt_id = ? AND attempt_kind = 'comeback' AND attempt_state IN ('reserved', 'issued')
          AND phase = 'adding'`,
    ).run(outcome, slotId, attemptId).changes === 1;
  }

  get(slotId: string): SeatPoolSlot | undefined {
    const row = this.db.prepare("SELECT * FROM seat_pool_slots WHERE slot_id = ?").get(slotId) as SlotRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** A model's slots, lowest number first. */
  forModel(modelNodeId: string): SeatPoolSlot[] {
    return (this.db.prepare("SELECT * FROM seat_pool_slots WHERE model_node_id = ? ORDER BY slot_number").all(modelNodeId) as SlotRow[])
      .map(fromRow);
  }

  /**
   * Moves a slot from `from` to `to`, only while it is still in `from`: false when it moved on. With `stop`, also sets
   * (an object) or clears (null) the `stop` key of the slot's recorded outcome, keeping its other keys.
   */
  setPhase(input: { slotId: string; from: SeatPoolSlotPhase; to: SeatPoolSlotPhase; at: string; stop?: Record<string, unknown> | null }): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT phase, attempt_outcome FROM seat_pool_slots WHERE slot_id = ?").get(input.slotId) as
        { phase: SeatPoolSlotPhase; attempt_outcome: string | null } | undefined;
      if (!row || row.phase !== input.from) return false;
      let outcome = row.attempt_outcome;
      if (input.stop !== undefined) {
        const kept = { ...readAttemptOutcome(outcome) };
        delete kept.stop;
        const next = input.stop === null ? kept : { ...kept, stop: input.stop };
        outcome = Object.keys(next).length > 0 ? JSON.stringify(next) : null;
      }
      // The phase's time changes only with the phase: rewriting the outcome of a slot that stays where it is keeps it.
      this.db.prepare(
        "UPDATE seat_pool_slots SET phase = ?, phase_changed_at = CASE WHEN phase = ? THEN phase_changed_at ELSE ? END, attempt_outcome = ? WHERE slot_id = ?",
      ).run(input.to, input.to, input.at, outcome, input.slotId);
      return true;
    })();
  }

  /** The `stop` key of the slot's recorded outcome: what the pool's last stop of this agent returned. Null: none. */
  stopOutcome(slotId: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT attempt_outcome FROM seat_pool_slots WHERE slot_id = ?").get(slotId) as
      { attempt_outcome: string | null } | undefined;
    const stop = readAttemptOutcome(row?.attempt_outcome ?? null).stop;
    return stop !== null && typeof stop === "object" && !Array.isArray(stop) ? stop as Record<string, unknown> : null;
  }

  /** Whether the node is a pool agent the pool drained: restore keeps it down until the pool brings it back. */
  isDrainedPoolNode(nodeId: string): boolean {
    return this.db.prepare("SELECT 1 FROM seat_pool_slots WHERE node_id = ? AND phase = 'drained'").get(nodeId) !== undefined;
  }

  /** The nodes of every pool agent in a rig, in every phase (`drained` included). */
  poolAgentNodeIds(rigId: string): string[] {
    return (this.db.prepare(
      `SELECT s.node_id FROM seat_pool_slots s JOIN nodes m ON m.id = s.model_node_id
        WHERE m.rig_id = ? AND s.node_id IS NOT NULL ORDER BY s.model_node_id, s.slot_number`,
    ).all(rigId) as Array<{ node_id: string }>).map((row) => row.node_id);
  }
}
