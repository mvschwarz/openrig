import type Database from "better-sqlite3";
import { ulid } from "ulid";

// #3395 (Piece 1): the agents of a seat pool, one row per slot, keyed by the model node. Nothing here removes a slot:
// a drained agent keeps its node, name and history, and the next add reuses the lowest drained slot before it takes a
// new number. Deleting a node by hand takes its slot row with it (ON DELETE CASCADE), which frees the number.

export type SeatPoolSlotPhase = "adding" | "live" | "draining" | "drained";

export interface SeatPoolSlot {
  slotId: string;
  modelNodeId: string;
  /** The `n` of the agent's `<model logical id>-s<n>`. */
  slotNumber: number;
  /** The agent's node; null until the add has created it. */
  nodeId: string | null;
  phase: SeatPoolSlotPhase;
  phaseChangedAt: string;
  createdAt: string;
}

interface SlotRow {
  slot_id: string;
  model_node_id: string;
  slot_number: number;
  node_id: string | null;
  phase: SeatPoolSlotPhase;
  phase_changed_at: string;
  created_at: string;
}

const fromRow = (row: SlotRow): SeatPoolSlot => ({
  slotId: row.slot_id,
  modelNodeId: row.model_node_id,
  slotNumber: row.slot_number,
  nodeId: row.node_id,
  phase: row.phase,
  phaseChangedAt: row.phase_changed_at,
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

  get(slotId: string): SeatPoolSlot | undefined {
    const row = this.db.prepare("SELECT * FROM seat_pool_slots WHERE slot_id = ?").get(slotId) as SlotRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** A model's slots, lowest number first. */
  forModel(modelNodeId: string): SeatPoolSlot[] {
    return (this.db.prepare("SELECT * FROM seat_pool_slots WHERE model_node_id = ? ORDER BY slot_number").all(modelNodeId) as SlotRow[])
      .map(fromRow);
  }

  /** The nodes of every pool agent in a rig, in every phase (`drained` included). */
  poolAgentNodeIds(rigId: string): string[] {
    return (this.db.prepare(
      `SELECT s.node_id FROM seat_pool_slots s JOIN nodes m ON m.id = s.model_node_id
        WHERE m.rig_id = ? AND s.node_id IS NOT NULL ORDER BY s.model_node_id, s.slot_number`,
    ).all(rigId) as Array<{ node_id: string }>).map((row) => row.node_id);
  }
}
