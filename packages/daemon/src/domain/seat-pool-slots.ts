import type Database from "better-sqlite3";
import { ulid } from "ulid";

// #3395 (Piece 1): the agents of a seat pool, one row per slot, keyed by the model node. A drained agent keeps its node,
// name and history. The only row the pool removes is an add's own row when the add ended with no node, which frees the
// number. Deleting a node by hand takes its slot row with it (ON DELETE CASCADE), which frees the number too.
//
// An add's attempt lives on its row: reserved with a new number, issued under the model's custody lease, then settled
// (the agent runs) or removed (no node was created).

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

  /** An issued add that runs: settled, with its outcome and the session it settled with, and the slot `live`. */
  settleAdd(slotId: string, attemptId: string, input: { outcome: string; result: string; at: string }): boolean {
    return this.db.prepare(
      `UPDATE seat_pool_slots SET attempt_state = 'settled', attempt_outcome = ?, attempt_result = ?, phase = 'live', phase_changed_at = ?
        WHERE slot_id = ? AND attempt_id = ? AND attempt_state = 'issued'`,
    ).run(input.outcome, input.result, input.at, slotId, attemptId).changes === 1;
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

  get(slotId: string): SeatPoolSlot | undefined {
    const row = this.db.prepare("SELECT * FROM seat_pool_slots WHERE slot_id = ?").get(slotId) as SlotRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** A model's slots, lowest number first. */
  forModel(modelNodeId: string): SeatPoolSlot[] {
    return (this.db.prepare("SELECT * FROM seat_pool_slots WHERE model_node_id = ? ORDER BY slot_number").all(modelNodeId) as SlotRow[])
      .map(fromRow);
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
