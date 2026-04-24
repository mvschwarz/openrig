import type { RigRepository } from "./rig-repository.js";
import { SeatStatusService, type SeatStatus, type SeatStatusResult } from "./seat-status-service.js";

export type SeatHandoverSourceMode = "fresh" | "rebuild" | "fork" | "discovered";

export interface SeatHandoverSource {
  mode: SeatHandoverSourceMode;
  ref: string | null;
  raw: string;
  defaulted: boolean;
}

export interface SeatHandoverStep {
  id: string;
  title: string;
  description: string;
  willMutate: false;
}

export interface SeatHandoverPhase {
  id: "prepare" | "commit";
  title: string;
  bindingUnchangedUntilComplete: boolean;
  steps: SeatHandoverStep[];
}

export interface SeatHandoverPlan {
  ok: true;
  dryRun: true;
  willMutate: false;
  seat: {
    ref: string;
    rigId: string;
    rigName: string;
    logicalId: string;
    podId: string | null;
    podNamespace: string | null;
    runtime: string | null;
  };
  source: SeatHandoverSource;
  reason: string;
  operator: string | null;
  currentOccupant: string | null;
  currentStatus: {
    sessionStatus: string | null;
    startupStatus: SeatStatus["startup_status"];
    occupantLifecycle: SeatStatus["occupant_lifecycle"];
    continuityOutcome: SeatStatus["continuity_outcome"];
    handoverResult: SeatStatus["handover_result"];
    previousOccupant: string | null;
    handoverAt: string | null;
    restoreOutcome: SeatStatus["restore_outcome"];
  };
  phases: SeatHandoverPhase[];
}

export type SeatHandoverPlanResult =
  | { ok: true; plan: SeatHandoverPlan }
  | { ok: false; code: "missing_reason" | "invalid_source" | "mutation_disabled"; message: string; guidance: string }
  | Extract<SeatStatusResult, { ok: false }>;

export class SeatHandoverPlanner {
  private statusService: SeatStatusService;

  constructor(deps: { rigRepo: RigRepository }) {
    this.statusService = new SeatStatusService({ rigRepo: deps.rigRepo });
  }

  plan(input: {
    seatRef: string;
    reason?: string | null;
    source?: string | null;
    operator?: string | null;
    dryRun?: boolean;
  }): SeatHandoverPlanResult {
    const reason = input.reason?.trim() ?? "";
    if (!reason) {
      return {
        ok: false,
        code: "missing_reason",
        message: "Missing required option: --reason <reason>",
        guidance: "Provide an explicit handover reason, for example: --reason context-wall",
      };
    }

    const source = parseHandoverSource(input.source);
    if (!source.ok) {
      return source;
    }

    const statusResult = this.statusService.getStatus(input.seatRef);
    if (!statusResult.ok) {
      return statusResult;
    }

    if (!input.dryRun) {
      return {
        ok: false,
        code: "mutation_disabled",
        message: "Seat handover mutation is not implemented in this slice.",
        guidance: "Re-run with --dry-run to inspect the two-phase handover plan without changing topology.",
      };
    }

    return {
      ok: true,
      plan: buildPlan({
        seatRef: input.seatRef,
        status: statusResult.status,
        source: source.source,
        reason,
        operator: input.operator?.trim() || null,
      }),
    };
  }
}

export function parseHandoverSource(source?: string | null): { ok: true; source: SeatHandoverSource } | { ok: false; code: "invalid_source"; message: string; guidance: string } {
  const raw = source?.trim();
  if (!raw || raw === "default" || raw === "fresh") {
    return {
      ok: true,
      source: { mode: "fresh", ref: null, raw: raw || "fresh", defaulted: !raw || raw === "default" },
    };
  }

  if (raw === "rebuild") {
    return {
      ok: true,
      source: { mode: "rebuild", ref: null, raw, defaulted: false },
    };
  }

  if (raw.startsWith("fork:")) {
    const ref = raw.slice("fork:".length).trim();
    if (ref) {
      return {
        ok: true,
        source: { mode: "fork", ref, raw, defaulted: false },
      };
    }
  }

  if (raw.startsWith("discovered:")) {
    const ref = raw.slice("discovered:".length).trim();
    if (ref) {
      return {
        ok: true,
        source: { mode: "discovered", ref, raw, defaulted: false },
      };
    }
  }

  return {
    ok: false,
    code: "invalid_source",
    message: `Invalid handover source "${raw}".`,
    guidance: "Use --source fresh, --source rebuild, --source fork:<id>, or --source discovered:<id>.",
  };
}

function buildPlan(input: {
  seatRef: string;
  status: SeatStatus;
  source: SeatHandoverSource;
  reason: string;
  operator: string | null;
}): SeatHandoverPlan {
  const { status } = input;
  return {
    ok: true,
    dryRun: true,
    willMutate: false,
    seat: {
      ref: input.seatRef,
      rigId: status.rig_id,
      rigName: status.rig_name,
      logicalId: status.logical_id,
      podId: status.pod_id,
      podNamespace: status.pod_namespace,
      runtime: status.runtime,
    },
    source: input.source,
    reason: input.reason,
    operator: input.operator,
    currentOccupant: status.current_occupant,
    currentStatus: {
      sessionStatus: status.session_status,
      startupStatus: status.startup_status,
      occupantLifecycle: status.occupant_lifecycle,
      continuityOutcome: status.continuity_outcome,
      handoverResult: status.handover_result,
      previousOccupant: status.previous_occupant,
      handoverAt: status.handover_at,
      restoreOutcome: status.restore_outcome,
    },
    phases: [
      {
        id: "prepare",
        title: "Phase A - prepare successor with seat binding unchanged",
        bindingUnchangedUntilComplete: true,
        steps: [
          {
            id: "validate-seat",
            title: "Validate seat",
            description: "Confirm the seat exists and capture current occupant/status from node inventory.",
            willMutate: false,
          },
          {
            id: "capture-departing-context",
            title: "Capture departing context",
            description: "Would collect final pane state, queue state, and session log tail before successor creation.",
            willMutate: false,
          },
          {
            id: "create-successor",
            title: "Create successor occupant",
            description: `Would create a successor using ${describeSource(input.source)} while leaving the current seat binding unchanged.`,
            willMutate: false,
          },
          {
            id: "verify-successor-readiness",
            title: "Verify successor readiness",
            description: "Would run runtime readiness checks before allowing any seat rebind.",
            willMutate: false,
          },
        ],
      },
      {
        id: "commit",
        title: "Phase B - commit atomic seat rebind after successor readiness",
        bindingUnchangedUntilComplete: false,
        steps: [
          {
            id: "archive-departing-occupant",
            title: "Archive departing occupant",
            description: "Would mark the departing occupant lifecycle and preserve handover provenance.",
            willMutate: false,
          },
          {
            id: "rebind-seat",
            title: "Rebind seat",
            description: "Would atomically point the stable seat identity at the successor session.",
            willMutate: false,
          },
          {
            id: "deliver-startup-context",
            title: "Deliver startup context",
            description: "Would deliver handover context through startup orchestration.",
            willMutate: false,
          },
          {
            id: "record-provenance",
            title: "Record provenance",
            description: "Would finalize the handover record and append the pod shared session log.",
            willMutate: false,
          },
        ],
      },
    ],
  };
}

function describeSource(source: SeatHandoverSource): string {
  if (source.mode === "fork") return `fork source ${source.ref}`;
  if (source.mode === "discovered") return `already-created discovered successor ${source.ref}`;
  if (source.mode === "rebuild") return "artifact rebuild source";
  return source.defaulted ? "the default fresh source" : "fresh source";
}
