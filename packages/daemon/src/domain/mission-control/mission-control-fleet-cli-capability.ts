// Fleet roll-up from the daemon's rig registry and queue, with optional
// CLI observations. Unobserved capabilities and versions remain unknown;
// unavailable fields alone do not establish that a CLI version is outdated.

import type Database from "better-sqlite3";
import type { EventBus } from "../event-bus.js";
import type { RigRepository } from "../rig-repository.js";
import { runSyncSite } from "../sync-site-wrap.js";
import { cooperativeReadFile, readRowsCooperatively } from "../execution-candidate-reader.js";

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

// Ties go newest row first: the order the ts_updated index's backward walk already gave them, now stated, so the
// windowed read below and a database without that index give the same rows.
const RIG_QUEUE_SQL = `SELECT destination_session, state, ts_updated, blocked_on
           FROM queue_items
          WHERE destination_session LIKE ?
            OR source_session LIKE ?
          ORDER BY ts_updated DESC, rowid DESC LIMIT 100`;
// The same rows one rowid window at a time, for readRowsCooperatively: each window's own latest 100, which together hold
// the latest 100 overall. NOT INDEXED keeps each window on its rowid range: with idx_queue_items_ts_updated present, the
// planner may otherwise walk that index for the ORDER BY, which visits every row of the table in every window.
const RIG_QUEUE_WINDOW_SQL = `SELECT rowid AS rid, destination_session, state, ts_updated, blocked_on
           FROM queue_items NOT INDEXED
          WHERE queue_items.rowid > ? AND queue_items.rowid <= ?
            AND (destination_session LIKE ? OR source_session LIKE ?)
          ORDER BY ts_updated DESC, rowid DESC LIMIT 100`;

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
      const queueState = await this.summarizeRigQueue(rig.name);
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
  private async summarizeRigQueue(rigName: string): Promise<{
    activityState: FleetRollupRow["activityState"];
    lifecycleState: string | null;
    attentionReason: string | null;
    lastUpdate: string;
  }> {
    const ownedSessions = await this.readRigQueueRows(`%@${rigName}`);

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

  /** A rig's latest 100 rows by update time. A suffix LIKE can't use an index, so the statement walks rows until it has
   *  100, which is every row for a quiet rig. On a WAL file it's read on its own read-only connection one rowid window
   *  at a time, yielding to the event loop between windows (readRowsCooperatively). Only the running latest 100 are kept
   *  as windows arrive, so no stretch grows with the queue. Inside a transaction, on a memory database or on a non-WAL
   *  file, it's the statement on the main connection. */
  private async readRigQueueRows(pattern: string): Promise<RigQueueRow[]> {
    const file = cooperativeReadFile(this.db);
    if (!file) {
      return runSyncSite("mission_control.rig_queue_summary", () => this.db.prepare(RIG_QUEUE_SQL).all(pattern, pattern) as RigQueueRow[]);
    }
    // ts_updated is ISO-8601 text, where JS's string order is SQLite's BINARY order.
    const newestFirst = (a: RigQueueRow & { rid: number }, b: RigQueueRow & { rid: number }) =>
      (a.ts_updated < b.ts_updated ? 1 : a.ts_updated > b.ts_updated ? -1 : b.rid - a.rid);
    let latest: Array<RigQueueRow & { rid: number }> = [];
    await readRowsCooperatively<RigQueueRow & { rid: number }>(file, "queue_items", RIG_QUEUE_WINDOW_SQL, [pattern, pattern], undefined, undefined, {
      onWindow: (rows) => { if (rows.length > 0) latest = [...latest, ...rows].sort(newestFirst).slice(0, 100); },
    });
    return latest.map(({ rid: _rid, ...row }) => row);
  }

  /** Test/observability helper: clear the once-per-session log set. */
  resetDriftLogForTest(): void {
    this.loggedDriftKeys.clear();
  }
}
