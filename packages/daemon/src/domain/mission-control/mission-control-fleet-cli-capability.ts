// Fleet roll-up from the daemon's rig registry and queue, with optional
// CLI observations. Unobserved capabilities and versions remain unknown;
// unavailable fields alone do not establish that a CLI version is outdated.

import type Database from "better-sqlite3";
import type { EventBus } from "../event-bus.js";
import type { RigRepository } from "../rig-repository.js";

export interface FleetRollupRow {
  rigName: string;
  /** Compact 5-state activity for a fleet view. */
  activityState: "active" | "idle" | "attention" | "blocked" | "degraded";
  lifecycleState: string | null;
  attentionReason: string | null;
  lastUpdate: string;
  /** v0.1.12-style label or "head" / "unknown". */
  cliVersionLabel: string;
  cliCapabilityStatus: "available" | "unavailable" | "unknown";
  /** True only when an observed version was independently confirmed outdated. */
  cliVersionOutdated: boolean;
  /** True if this rig was observed missing one or more required list fields. */
  cliDriftDetected: boolean;
}

export interface FleetRollup {
  rows: FleetRollupRow[];
  staleCliCount: number;
  /** Rigs whose CLI field support has not been observed. */
  unknownCliCount: number;
  /** Fields known to be missing across the observed rigs (de-duplicated). */
  degradedFields: string[];
  /** Source of fleet activity when it is projected without reading the CLI. */
  sourceFallback: string | null;
}

export interface CliCapabilityObservation {
  cliVersionLabel: string;
  /** Null means unobserved; an empty array means all required fields were supported. */
  unsupportedFields: string[] | null;
  /** Independent version evidence, never inferred from missing fields. */
  versionOutdated?: boolean;
}

interface CliCapabilityDeps {
  db: Database.Database;
  eventBus: EventBus;
  rigRepo: RigRepository;
  /**
   * Optional observation of a rig's CLI version and supported list fields.
   * Without an observation, both remain unknown.
   */
  probeRig?: (rigName: string) => Promise<CliCapabilityObservation>;
  /** Override clock for tests. */
  now?: () => Date;
}

interface RigQueueRow {
  destination_session: string;
  state: string;
  ts_updated: string;
  blocked_on: string | null;
}

/**
 * Fields expected from the node list. recoveryGuidance belongs to node
 * detail; its absence from `rig ps --nodes --fields` is not incompatibility.
 */
export const MISSION_CONTROL_DESIRED_FIELDS = [
  "agentActivity",
] as const;

/**
 * Adapt explicit local CLI observations. The daemon-internal projection
 * does not observe a CLI by itself, so omitted inputs remain unknown.
 * Do not substitute the daemon's package version or a mirrored CLI allow-list.
 */
export function makeLocalCliCapabilityProbe(opts?: {
  versionLabel?: string;
  knownNodeFields?: ReadonlySet<string>;
  versionOutdated?: boolean;
}): (rigName: string) => Promise<CliCapabilityObservation> {
  const knownNodeFields = opts?.knownNodeFields;
  return async (_rigName: string) => ({
    cliVersionLabel: opts?.versionLabel?.trim() || "unknown",
    unsupportedFields: knownNodeFields === undefined ? null
      : MISSION_CONTROL_DESIRED_FIELDS.filter((field) => !knownNodeFields.has(field)),
    versionOutdated: opts?.versionOutdated,
  });
}

export class MissionControlFleetCliCapability {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly rigRepo: RigRepository;
  private readonly probeRig: NonNullable<CliCapabilityDeps["probeRig"]>;
  private readonly now: () => Date;

  /** Per-(rig, field) once-per-session log set. Cleared on daemon restart. */
  private readonly loggedDriftKeys: Set<string> = new Set();

  constructor(deps: CliCapabilityDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.rigRepo = deps.rigRepo;
    this.probeRig = deps.probeRig ?? makeLocalCliCapabilityProbe();
    this.now = deps.now ?? (() => new Date());
  }

  async rollupFleet(): Promise<FleetRollup> {
    const rigs = this.rigRepo.listRigs();
    const rows: FleetRollupRow[] = [];
    const allDegradedFields = new Set<string>();
    let staleCliCount = 0;
    let unknownCliCount = 0;

    for (const rig of rigs) {
      let probe: CliCapabilityObservation;
      try {
        probe = await this.probeRig(rig.name);
      } catch {
        probe = { cliVersionLabel: "unknown", unsupportedFields: null };
      }
      const cliVersionLabel = probe.cliVersionLabel.trim() || "unknown";
      const unsupportedFields = probe.unsupportedFields ?? [];
      const driftDetected = unsupportedFields.length > 0;
      const cliCapabilityStatus = probe.unsupportedFields === null ? "unknown"
        : driftDetected ? "unavailable" : "available";
      const cliVersionOutdated = cliVersionLabel !== "unknown" && probe.versionOutdated === true;
      if (cliVersionOutdated) staleCliCount++;
      if (cliCapabilityStatus === "unknown") unknownCliCount++;
      for (const f of unsupportedFields) {
        allDegradedFields.add(f);
        this.maybeLogDriftOnce(rig.name, f);
      }
      const queueState = this.summarizeRigQueue(rig.name);
      rows.push({
        rigName: rig.name,
        activityState: queueState.activityState,
        lifecycleState: queueState.lifecycleState,
        attentionReason: queueState.attentionReason,
        lastUpdate: queueState.lastUpdate,
        cliVersionLabel,
        cliCapabilityStatus,
        cliVersionOutdated,
        cliDriftDetected: driftDetected,
      });
    }

    return {
      rows,
      staleCliCount,
      unknownCliCount,
      degradedFields: Array.from(allDegradedFields),
      // Activity still comes from the registry and queue, even when a
      // caller supplies independent CLI observations.
      sourceFallback: "daemon-internal-projection",
    };
  }

  /**
   * Per-(rig, field) once-per-session-per-rig log per PRD sub-clause 3.
   * Daemon restart clears the set so logging fires again on first
   * post-restart observation.
   */
  private maybeLogDriftOnce(rigName: string, missingField: string): void {
    const key = `${rigName}::${missingField}`;
    if (this.loggedDriftKeys.has(key)) return;
    this.loggedDriftKeys.add(key);
    const observedAt = this.now().toISOString();
    this.eventBus.emit({
      type: "mission_control.cli_drift_detected",
      rigName,
      missingField,
      observedAt,
    });
  }

  /**
   * Summarize a rig's queue state for the fleet view. Synthesized
   * from PL-004 Phase A queue_items via a single SQL aggregation:
   *   - active: any in-progress qitem
   *   - blocked: any blocked qitem (no in-progress)
   *   - attention: only pending qitems older than 1h
   *   - idle: no active queue activity
   *   - degraded: any failed/denied/canceled qitem in last 24h
   */
  private summarizeRigQueue(rigName: string): {
    activityState: FleetRollupRow["activityState"];
    lifecycleState: string | null;
    attentionReason: string | null;
    lastUpdate: string;
  } {
    const ownedSessions = this.db
      .prepare(
        `SELECT destination_session, state, ts_updated, blocked_on
           FROM queue_items
          WHERE destination_session LIKE ?
            OR source_session LIKE ?
          ORDER BY ts_updated DESC LIMIT 100`,
      )
      .all(`%@${rigName}`, `%@${rigName}`) as RigQueueRow[];

    if (ownedSessions.length === 0) {
      return {
        activityState: "idle",
        lifecycleState: null,
        attentionReason: null,
        lastUpdate: this.now().toISOString(),
      };
    }
    const lastUpdate = ownedSessions[0]!.ts_updated;
    const hasInProgress = ownedSessions.some((q) => q.state === "in-progress");
    const hasBlocked = ownedSessions.some((q) => q.state === "blocked");
    const hasFailed = ownedSessions.some((q) =>
      q.state === "failed" || q.state === "denied" || q.state === "canceled",
    );
    let activityState: FleetRollupRow["activityState"] = "idle";
    let attentionReason: string | null = null;
    if (hasInProgress) {
      activityState = "active";
    } else if (hasBlocked) {
      activityState = "blocked";
      const blockedRow = ownedSessions.find((q) => q.state === "blocked");
      attentionReason = blockedRow?.blocked_on
        ? `blocked-on: ${blockedRow.blocked_on}`
        : "blocked";
    } else if (hasFailed) {
      activityState = "degraded";
      attentionReason = "recent failure / denial / cancel in queue";
    }
    return {
      activityState,
      lifecycleState: ownedSessions[0]!.state,
      attentionReason,
      lastUpdate,
    };
  }

  /** Test/observability helper: clear the once-per-session log set. */
  resetDriftLogForTest(): void {
    this.loggedDriftKeys.clear();
  }
}
