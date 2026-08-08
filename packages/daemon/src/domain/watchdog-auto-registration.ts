import type Database from "better-sqlite3";
import { parseSessionName } from "./session-name.js";
import type { SettingsStore } from "./user-settings/settings-store.js";
import {
  WatchdogJobsError,
  type WatchdogJob,
  type WatchdogJobsRepository,
} from "./watchdog-jobs-repository.js";

const POLICY = "idle-gate-qitem";
const REGISTRAR = "daemon@kernel";
const TERMINAL_SESSION_STATUSES = new Set(["superseded", "detached", "exited"]);

export class WatchdogAutoRegistrationError extends Error {
  constructor(
    public readonly code: "target_mismatch" | "missing",
    message: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = "WatchdogAutoRegistrationError";
  }
}

interface TopologyRow {
  node_id: string;
  rig_id: string;
  rig_name: string | null;
}

interface LatestSessionRow {
  node_id: string;
  session_name: string;
  status: string;
}

export interface WatchdogAutoRegistrationDeps {
  db: Database.Database;
  jobsRepo: WatchdogJobsRepository;
  settingsStore: SettingsStore;
  warn?: (message: string) => void;
}

/**
 * W2c's one structural seam: every canonical seat mint ensures its role-bound
 * idle-gate job, while startup only audits existing live-like seats. Core seat
 * creation remains fail-isolated from this additive supervision layer.
 */
export class WatchdogAutoRegistration {
  private readonly warn: (message: string) => void;

  constructor(private readonly deps: WatchdogAutoRegistrationDeps) {
    this.warn = deps.warn ?? ((message) => console.warn(message));
  }

  /** Named exclusions: flat legacy and noncanonical/external seats cannot own qitems. */
  isEligibleSessionName(sessionName: string): boolean {
    return parseSessionName(sessionName).kind === "canonical";
  }

  ensure(nodeId: string, sessionName: string): WatchdogJob | null {
    const topology = this.resolveTopology(nodeId, sessionName);
    if (!topology) return null;
    const cadence = this.resolveCadence();
    return this.deps.jobsRepo.ensureAutoRegistration({
      policy: POLICY,
      specYaml: this.generatedSpec(sessionName, cadence.scan, cadence.activeWake),
      targetSession: sessionName,
      intervalSeconds: cadence.scan,
      scanIntervalSeconds: cadence.scan,
      activeWakeIntervalSeconds: cadence.activeWake,
      registeredBySession: REGISTRAR,
      targetGenerationUuid: null,
    });
  }

  assertCoverage(nodeId: string, sessionName: string): WatchdogJob | null {
    const topology = this.resolveTopology(nodeId, sessionName);
    if (!topology) return null;
    const rows = this.deps.jobsRepo.listExactTuple(POLICY, sessionName, null);
    const nonterminal = rows.filter((row) => row.state !== "terminal");
    if (nonterminal.length === 0) {
      throw new WatchdogAutoRegistrationError(
        "missing",
        `watchdog auto-registration missing for node_id="${nodeId}" session="${sessionName}"`,
        { nodeId, sessionName, policy: POLICY },
      );
    }
    if (nonterminal.length > 1) {
      throw new WatchdogJobsError(
        "auto_registration_ambiguous",
        `auto-registration is ambiguous for ${POLICY}/${sessionName}: ${nonterminal.length} nonterminal rows`,
        {
          nodeId,
          targetSession: sessionName,
          rows: nonterminal.map((row) => ({ jobId: row.jobId, state: row.state })),
        },
      );
    }
    return nonterminal[0]!;
  }

  /** Audit every latest live-like seat at startup; never create or delete rows. */
  assertLiveSeatCoverage(): void {
    const rows = this.deps.db.prepare(
      `SELECT node_id, session_name, status
         FROM sessions
        ORDER BY created_at DESC, id DESC`,
    ).all() as LatestSessionRow[];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.node_id)) continue;
      seen.add(row.node_id);
      if (TERMINAL_SESSION_STATUSES.has(row.status)) continue;
      if (!this.isEligibleSessionName(row.session_name)) continue;
      try {
        this.assertCoverage(row.node_id, row.session_name);
      } catch (error) {
        this.warn(
          `[watchdog-auto-registration] startup coverage FAILED for node_id="${row.node_id}" ` +
          `session="${row.session_name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private resolveTopology(nodeId: string, sessionName: string): TopologyRow | null {
    const parsed = parseSessionName(sessionName);
    if (parsed.kind !== "canonical") return null;
    const row = this.deps.db.prepare(
      `SELECT n.id AS node_id, n.rig_id AS rig_id, r.name AS rig_name
         FROM nodes n LEFT JOIN rigs r ON r.id = n.rig_id
        WHERE n.id = ?`,
    ).get(nodeId) as TopologyRow | undefined;
    if (!row || row.rig_name === null || row.rig_name !== parsed.rig) {
      throw new WatchdogAutoRegistrationError(
        "target_mismatch",
        `canonical seat topology mismatch for node_id="${nodeId}" session="${sessionName}"`,
        { nodeId, sessionName, parsedRig: parsed.rig, actualRig: row?.rig_name ?? null },
      );
    }
    return row;
  }

  private resolveCadence(): { scan: number; activeWake: number } {
    return {
      scan: this.deps.settingsStore.resolveOne("policies.idle_gate_qitem.scan_interval_seconds").value as number,
      activeWake: this.deps.settingsStore.resolveOne("policies.idle_gate_qitem.active_wake_interval_seconds").value as number,
    };
  }

  private generatedSpec(sessionName: string, scan: number, activeWake: number): string {
    return `policy: ${POLICY}\n` +
      `generated_by: openrig-daemon\n` +
      `target:\n  session: ${sessionName}\n` +
      `interval_seconds: ${scan}\n` +
      `scan_interval_seconds: ${scan}\n` +
      `active_wake_interval_seconds: ${activeWake}\n`;
  }
}
