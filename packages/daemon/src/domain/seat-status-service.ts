import type { RigRepository } from "./rig-repository.js";
import { getNodeInventory } from "./node-inventory.js";
import type { NodeInventoryEntry } from "./types.js";

const SEAT_LOOKUP_GUIDANCE = "List seats with: rig ps --nodes";

export interface SeatStatus {
  seat_ref: string;
  rig_id: string;
  rig_name: string;
  logical_id: string;
  pod_id: string | null;
  pod_namespace: string | null;
  runtime: string | null;
  current_occupant: string | null;
  session_status: string | null;
  startup_status: NodeInventoryEntry["startupStatus"];
  occupant_lifecycle: NodeInventoryEntry["occupantLifecycle"];
  continuity_outcome: NodeInventoryEntry["continuityOutcome"];
  handover_result: NodeInventoryEntry["handoverResult"];
  previous_occupant: string | null;
  handover_at: string | null;
  restore_outcome: NodeInventoryEntry["restoreOutcome"];
}

export type SeatStatusResult =
  | { ok: true; status: SeatStatus }
  | { ok: false; code: "seat_ref_required" | "seat_not_found"; message: string; guidance: string }
  | { ok: false; code: "seat_ambiguous"; message: string; guidance: string; matches: Array<{ rig_name: string; logical_id: string; current_occupant: string | null }> };

interface SeatMatch {
  entry: NodeInventoryEntry;
}

export class SeatStatusService {
  private rigRepo: RigRepository;

  constructor(deps: { rigRepo: RigRepository }) {
    this.rigRepo = deps.rigRepo;
  }

  getStatus(seatRef: string): SeatStatusResult {
    const ref = seatRef.trim();
    if (!ref) {
      return { ok: false, code: "seat_ref_required", message: "seat reference is required", guidance: SEAT_LOOKUP_GUIDANCE };
    }

    const matches = this.findMatches(ref);
    if (matches.length === 0) {
      return { ok: false, code: "seat_not_found", message: `Seat "${ref}" not found`, guidance: SEAT_LOOKUP_GUIDANCE };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        code: "seat_ambiguous",
        message: `Seat "${ref}" matched multiple nodes`,
        guidance: SEAT_LOOKUP_GUIDANCE,
        matches: matches.map(({ entry }) => ({
          rig_name: entry.rigName,
          logical_id: entry.logicalId,
          current_occupant: entry.canonicalSessionName,
        })),
      };
    }

    return { ok: true, status: this.projectStatus(ref, matches[0]!.entry) };
  }

  private findMatches(ref: string): SeatMatch[] {
    const atIndex = ref.lastIndexOf("@");
    if (atIndex > 0 && atIndex < ref.length - 1) {
      const localRef = ref.slice(0, atIndex);
      const rigName = ref.slice(atIndex + 1);
      const rigs = this.rigRepo.findRigsByName(rigName);
      return rigs.flatMap((rig) => this.entriesForRig(rig.id).filter((entry) =>
        entry.canonicalSessionName === ref || entry.logicalId === localRef
      ).map((entry) => ({ entry })));
    }

    return this.rigRepo.listRigs().flatMap((rig) =>
      this.entriesForRig(rig.id).filter((entry) =>
        entry.canonicalSessionName === ref || entry.logicalId === ref
      ).map((entry) => ({ entry }))
    );
  }

  private entriesForRig(rigId: string): NodeInventoryEntry[] {
    return getNodeInventory(this.rigRepo.db, rigId);
  }

  private projectStatus(seatRef: string, entry: NodeInventoryEntry): SeatStatus {
    return {
      seat_ref: seatRef,
      rig_id: entry.rigId,
      rig_name: entry.rigName,
      logical_id: entry.logicalId,
      pod_id: entry.podId,
      pod_namespace: entry.podNamespace ?? null,
      runtime: entry.runtime,
      current_occupant: entry.canonicalSessionName,
      session_status: entry.sessionStatus,
      startup_status: entry.startupStatus,
      occupant_lifecycle: entry.occupantLifecycle,
      continuity_outcome: entry.continuityOutcome,
      handover_result: entry.handoverResult,
      previous_occupant: entry.previousOccupant,
      handover_at: entry.handoverAt,
      restore_outcome: entry.restoreOutcome,
    };
  }
}
