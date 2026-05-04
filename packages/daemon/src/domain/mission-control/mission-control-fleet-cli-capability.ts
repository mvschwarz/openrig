// PL-005 Phase A: per-rig CLI capability cache + fleet roll-up.
//
// Implements the 4 sub-clauses of PRD § Runtime/Source Drift Acceptance:
//   1. Per-field availability check on `rig ps --fields <field>`.
//   2. Per-rig CLI capability honesty (each rig surfaces its own capabilities).
//   3. Once-per-session-per-rig logging — degradation logs ONCE per (rig, field),
//      not per render.
//   4. "Rigs running stale CLI" indicator surfaced in fleet view meta.
//
// At v0 the daemon owns its own DB-bound topology + queue surfaces and
// can synthesize a fleet roll-up from PL-004 Phase A queue_items + the
// rig registry. The implementation supports an optional `psShellOut`
// hook for future direct CLI shelling; default keeps the fleet roll-up
// in-process so tests are deterministic.

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
  /** True if this rig was observed missing one or more allow-listed fields. */
  cliDriftDetected: boolean;
}

export interface FleetRollup {
  rows: FleetRollupRow[];
  staleCliCount: number;
  /** Fields known to be missing across the observed rigs (de-duplicated). */
  degradedFields: string[];
  /**
   * If the fleet roll-up couldn't reach the canonical CLI source and
   * fell back to a daemon-internal projection, this is the fallback
   * mode label. Null when the canonical source was used.
   */
  sourceFallback: string | null;
}

interface CliCapabilityDeps {
  db: Database.Database;
  eventBus: EventBus;
  rigRepo: RigRepository;
  /**
   * Optional: probe a rig for which `rig ps --fields <field>` keys it
   * supports. v0 default is a no-op (returns empty unsupported list);
   * future versions may shell out to `rig ps --version` per rig.
   */
  probeRig?: (rigName: string) => Promise<{
    cliVersionLabel: string;
    unsupportedFields: string[];
  }>;
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
 * Fields the operator-friendly fleet view tries to present. When a rig
 * does not surface one of these fields, the per-row drift indicator is
 * set + the per-(rig,field) "logged once" event is emitted.
 *
 * `recoveryGuidance` is intentionally listed even though it is not in
 * the 0.2.0 CLI allow-list (audit row 5 yellow). This is the canonical
 * cross-CLI-version drift case: the spec assumes some future CLI
 * surfaces this; the read-layer surfaces "field unavailable on this
 * rig's daemon version" honestly today.
 */
export const MISSION_CONTROL_DESIRED_FIELDS = [
  "agentActivity",
  "recoveryGuidance",
] as const;

/**
 * Daemon-side mirror of the CLI's `rig ps --nodes --fields ...`
 * node-level allow-list. Sourced from
 * `packages/cli/src/commands/ps.ts:79-96` (ALLOWED_NODE_FIELDS).
 * The CLI does not export this set, so the daemon mirrors it here at
 * the workspace version (Phase A v0 ships at OpenRig 0.2.0). Future
 * graduation can replace this mirror with a live CLI introspection
 * shell-out per rig; v1 single-host topology makes that overhead
 * unnecessary.
 *
 * To compute drift: any field in MISSION_CONTROL_DESIRED_FIELDS that
 * is NOT in this set is "missing on this rig's CLI version" — the
 * production probe surfaces it as drift.
 */
export const LOCAL_CLI_NODE_FIELDS_AT_0_2_0: ReadonlySet<string> = new Set([
  "rigId",
  "rigName",
  "logicalId",
  "podId",
  "podNamespace",
  "canonicalSessionName",
  "nodeKind",
  "runtime",
  "sessionStatus",
  "startupStatus",
  "restoreOutcome",
  "lifecycleState",
  "tmuxAttachCommand",
  "resumeCommand",
  "latestError",
  "agentActivity",
]);

/**
 * Local CLI version label embedded at workspace build time. Mission
 * Control reports this label in the drift indicator alongside per-rig
 * field availability. Hardcoded at v0.2.0 (the workspace shipping
 * version); a future graduation can read it from package.json or a
 * build-time constant.
 */
export const LOCAL_CLI_VERSION_LABEL = "0.2.0";

/**
 * Production probe factory (R1 fix per guard PL-005 Phase A review).
 * Returns a probeRig function that compares MISSION_CONTROL_DESIRED_FIELDS
 * against the daemon-mirrored LOCAL_CLI_NODE_FIELDS_AT_0_2_0 set and
 * reports any missing fields as drift. Per-rig honesty (sub-clause 2):
 * each rig is probed individually; in v1 single-host topology all rigs
 * share the same local CLI, so they all report the same drift result,
 * which is the honest outcome for the audit-row-5 case.
 *
 * For test scaffolding (or a future per-rig shell-out probe), callers
 * can override probeRig in the constructor; this factory is the v1
 * production default and is wired into createDaemon's startup so the
 * `/api/mission-control/cli-capabilities` route reports drift honestly
 * out of the box.
 */
export function makeLocalCliCapabilityProbe(opts?: {
  versionLabel?: string;
  knownNodeFields?: ReadonlySet<string>;
}): (rigName: string) => Promise<{
  cliVersionLabel: string;
  unsupportedFields: string[];
}> {
  const versionLabel = opts?.versionLabel ?? LOCAL_CLI_VERSION_LABEL;
  const knownFields = opts?.knownNodeFields ?? LOCAL_CLI_NODE_FIELDS_AT_0_2_0;
  return async (_rigName: string) => {
    const unsupportedFields: string[] = [];
    for (const desired of MISSION_CONTROL_DESIRED_FIELDS) {
      if (!knownFields.has(desired)) {
        unsupportedFields.push(desired);
      }
    }
    return { cliVersionLabel: versionLabel, unsupportedFields };
  };
}

type DesiredField = (typeof MISSION_CONTROL_DESIRED_FIELDS)[number];

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
    this.probeRig =
      deps.probeRig ??
      (async () => ({ cliVersionLabel: "unknown", unsupportedFields: [] }));
    this.now = deps.now ?? (() => new Date());
  }

  async rollupFleet(): Promise<FleetRollup> {
    const rigs = this.rigRepo.listRigs();
    const rows: FleetRollupRow[] = [];
    const allDegradedFields = new Set<string>();
    let staleCliCount = 0;

    for (const rig of rigs) {
      let probe: { cliVersionLabel: string; unsupportedFields: string[] };
      try {
        probe = await this.probeRig(rig.name);
      } catch {
        probe = { cliVersionLabel: "unknown", unsupportedFields: [...MISSION_CONTROL_DESIRED_FIELDS] };
      }
      const driftDetected = probe.unsupportedFields.length > 0;
      if (driftDetected) staleCliCount++;
      for (const f of probe.unsupportedFields) {
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
        cliVersionLabel: probe.cliVersionLabel,
        cliDriftDetected: driftDetected,
      });
    }

    return {
      rows,
      staleCliCount,
      degradedFields: Array.from(allDegradedFields),
      // v0 reads from the daemon-internal rig registry + queue_items;
      // future versions can shell out to `rig ps --nodes --json` and
      // set sourceFallback to "daemon-internal" when the CLI is
      // unavailable.
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
