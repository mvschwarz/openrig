import type Database from "better-sqlite3";

/** The caller's occupant generation from its seat env, stamped by the CLI (`X-OpenRig-Occupant-Generation`). */
export const OCCUPANT_GENERATION_HEADER = "x-openrig-occupant-generation";

export interface RuntimeSwitchCustodyRefusal {
  status: 409;
  body: { ok: false; error: string; code: string; message: string; switchId: string };
}

/**
 * Slice 16's narrow check (the successor-first decision: extra generation checks narrowed to
 * the switch itself). While a runtime switch is in progress, and after it commits, two processes may act as one seat.
 * Only the generations a switch record names are refused, and only on the seat it names:
 * - after commit, the predecessor's generation (`occupant_retired_by_switch`);
 * - before commit, the staged successor's reserved generation (`switch_not_committed`); its confirmation is a
 *   separate route this check doesn't cover.
 * A request without a generation, a generation no switch names, and every seat with no switch go on as before.
 * A successor whose switch was abandoned stays fenced while its retirement is unconfirmed (the switch keeps attention
 * until recovery retires it): a failed retirement isn't a release of custody.
 */
const NAMED_BY_SWITCH = `canonical_session = ? AND ((committed_at IS NOT NULL AND predecessor_generation = ?)
  OR (committed_at IS NULL AND successor_generation = ? AND (phase IN ('preparing', 'confirmed') OR (phase = 'abandoned' AND attention IS NOT NULL))))`;

/** For activity hooks: whether this generation is a switch's staged successor (before commit) or its retired predecessor
 *  (after) on the seat it names. Neither speaks for the seat; anything else (including no generation) is as before. */
export function runtimeSwitchActivityRole(
  db: Database.Database,
  session: string | null | undefined,
  generation: string | null | undefined,
): { id: string; role: "staged_successor" | "retired_predecessor" } | null {
  if (!session || !generation) return null;
  try {
    const row = db.prepare(`SELECT id, committed_at FROM seat_runtime_switches WHERE ${NAMED_BY_SWITCH}
      ORDER BY created_at DESC LIMIT 1`).get(session, generation, generation) as { id: string; committed_at: string | null } | undefined;
    return row ? { id: row.id, role: row.committed_at ? "retired_predecessor" : "staged_successor" } : null;
  } catch {
    return null;
  }
}

export function runtimeSwitchCustodyRefusal(
  db: Database.Database,
  actorSession: string | null | undefined,
  generation: string | null | undefined,
): RuntimeSwitchCustodyRefusal | null {
  if (!actorSession || !generation) return null;
  let row: { id: string; canonical_session: string; from_runtime: string; to_runtime: string; committed_at: string | null; predecessor_generation: string;
    phase: string } | undefined;
  try {
    row = db.prepare(`SELECT id, canonical_session, from_runtime, to_runtime, committed_at, predecessor_generation, phase FROM seat_runtime_switches
      WHERE ${NAMED_BY_SWITCH} ORDER BY created_at DESC LIMIT 1`).get(actorSession, generation, generation) as typeof row;
  } catch {
    return null; // A store without switch records has no switch to protect.
  }
  if (!row) return null;
  const seat = row.canonical_session;
  if (row.committed_at && row.predecessor_generation === generation) {
    return { status: 409, body: { ok: false, error: "occupant_retired_by_switch", code: "occupant_retired_by_switch", switchId: row.id,
      message: `This process was ${seat}'s ${row.from_runtime} occupant. The seat moved to ${row.to_runtime} at ${row.committed_at} (switch ${row.id}), so this process no longer acts as the seat. Nothing was changed.` } };
  }
  if (row.phase === "abandoned") {
    return { status: 409, body: { ok: false, error: "switch_not_committed", code: "switch_not_committed", switchId: row.id,
      message: `You were ${seat}'s staged ${row.to_runtime} successor, but switch ${row.id} didn't commit. The ${row.from_runtime} occupant holds the seat, so nothing was changed. Stop here; OpenRig retires this process when it next recovers the switch.` } };
  }
  return { status: 409, body: { ok: false, error: "switch_not_committed", code: "switch_not_committed", switchId: row.id,
    message: `You are ${seat}'s staged ${row.to_runtime} successor (switch ${row.id}). The ${row.from_runtime} occupant still holds the seat, so nothing was changed. Read the handover, confirm it with: rig seat set-runtime ${seat} --confirm ${row.id} --note "<what you'll do first>", then wait for the activation message before acting as the seat.` } };
}
