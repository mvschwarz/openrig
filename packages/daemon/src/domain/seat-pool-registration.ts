import type Database from "better-sqlite3";
import { stringify as stringifyYaml } from "yaml";
import { SEAT_POOL_POLICY_NAME } from "./policies/seat-pool.js";
import type { RigRepository } from "./rig-repository.js";
import { deriveCanonicalSessionName, parseSessionName, validateSessionName } from "./session-name.js";
import { serializePoolBlock, type SeatPoolSpec } from "./seat-pool-spec.js";
import { formatWatchdogRegistrationError } from "./watchdog-auto-registration.js";
import {
  WatchdogJobsError,
  type EnsureAutoRegistrationInput,
  type WatchdogJob,
  type WatchdogJobsRepository,
} from "./watchdog-jobs-repository.js";

// #3395 (Piece 1): registering the `seat-pool` watchdog job, one per model member that has a `pool` block.
//
// Nothing in the daemon calls this module yet: the job stays unarmed until the activation change, which calls the
// ensure on launch and re-apply and the start loop at daemon start, and hands the policy to the watchdog engine.
//
// The job's identity is the model's canonical session, with no generation, registered by `daemon@kernel`; the
// model's other canonical session names in the same rig are passed as aliases, as the idle-gate registration passes
// them. Its spec carries the model node id, which is how the job (and any replacement) finds the pool's agents, and
// the pool block it was ensured with.
//
// Outcomes of the ensure:
//   - an `active` job is refreshed with the new spec and keeps running;
//   - a `stopped` job gets the new spec and stays stopped (an operator's stop is never undone here);
//   - only a `terminal` job, or no job, means one new job;
//   - an ambiguous or invalid state is reported and no job is picked: nothing is registered or retired.
// A node with no block never gets a job, and a stored block that can't be read leaves the job as it is.
// Stopping the job while the pool has agents is allowed: the agents stay plain members.

/** Who registers the job. */
export const SEAT_POOL_REGISTRAR = "daemon@kernel";

/** How often the job is evaluated once armed, in seconds. */
export const SEAT_POOL_INTERVAL_SECONDS = 60;

export interface SeatPoolRegistrationDeps {
  db: Database.Database;
  rigRepo: Pick<RigRepository, "getNodePool">;
  jobsRepo: WatchdogJobsRepository;
  /** Where the start loop reports a node it could not ensure; console.warn by default. */
  warn?: (message: string) => void;
}

/** The model member a job is for: its node, its canonical session and that session's aliases. */
export interface SeatPoolModel {
  nodeId: string;
  rigName: string;
  sessionName: string;
  aliases: string[];
}

export type SeatPoolEnsureResult =
  | { outcome: "active"; job: WatchdogJob }
  | { outcome: "stopped"; job: WatchdogJob }
  | { outcome: "registered"; job: WatchdogJob; replaced: "none" | "terminal" }
  | {
    outcome: "ambiguous";
    code: "auto_registration_ambiguous" | "auto_registration_state_invalid";
    message: string;
    details?: Record<string, unknown>;
  };

export type SeatPoolReconcileResult =
  | ({ nodeId: string } & SeatPoolEnsureResult)
  | { nodeId: string; outcome: "no_block" }
  | { nodeId: string; outcome: "unusable"; error: string }
  | { nodeId: string; outcome: "no_model_session" }
  | { nodeId: string; outcome: "failed"; message: string };

interface ModelRow {
  node_id: string;
  logical_id: string;
  pod_id: string | null;
  rig_name: string | null;
}

/** The model member's canonical session and aliases, or null when the node is gone or has no pod-aware name. */
export function resolveSeatPoolModel(db: Database.Database, nodeId: string): SeatPoolModel | null {
  const row = db.prepare(
    `SELECT n.id AS node_id, n.logical_id AS logical_id, n.pod_id AS pod_id, r.name AS rig_name
       FROM nodes n LEFT JOIN rigs r ON r.id = n.rig_id
      WHERE n.id = ?`,
  ).get(nodeId) as ModelRow | undefined;
  if (!row || row.rig_name === null || row.pod_id === null) return null;
  const dot = row.logical_id.indexOf(".");
  if (dot <= 0 || dot === row.logical_id.length - 1) return null;
  const sessionName = deriveCanonicalSessionName(row.logical_id.slice(0, dot), row.logical_id.slice(dot + 1), row.rig_name);
  if (!isCanonicalInRig(sessionName, row.rig_name)) return null;
  const recorded = db.prepare(
    `SELECT session_name FROM sessions WHERE node_id = ? ORDER BY created_at ASC, id ASC`,
  ).all(nodeId) as Array<{ session_name: string }>;
  const aliases = [...new Set([...recorded.map((r) => r.session_name), sessionName])]
    .filter((candidate) => isCanonicalInRig(candidate, row.rig_name!));
  return { nodeId: row.node_id, rigName: row.rig_name, sessionName, aliases };
}

function isCanonicalInRig(sessionName: string, rigName: string): boolean {
  if (!validateSessionName(sessionName)) return false;
  const parsed = parseSessionName(sessionName);
  return parsed.kind === "canonical" && parsed.rig === rigName;
}

/** The ensure input for a model's job: its identity, cadence and spec. */
export function seatPoolJobInput(model: SeatPoolModel, spec: SeatPoolSpec): EnsureAutoRegistrationInput {
  return {
    policy: SEAT_POOL_POLICY_NAME,
    targetSession: model.sessionName,
    targetGenerationUuid: null,
    registeredBySession: SEAT_POOL_REGISTRAR,
    intervalSeconds: SEAT_POOL_INTERVAL_SECONDS,
    activeWakeIntervalSeconds: null,
    scanIntervalSeconds: null,
    specYaml: stringifyYaml({
      policy: SEAT_POOL_POLICY_NAME,
      target: { session: model.sessionName },
      context: { model_node_id: model.nodeId, pool: serializePoolBlock(spec) },
    }),
  };
}

/** Ensure one job for a model with a usable block. Throws only what is not an ambiguous or invalid job state. */
export function ensureSeatPoolJob(
  deps: Pick<SeatPoolRegistrationDeps, "jobsRepo">,
  model: SeatPoolModel,
  spec: SeatPoolSpec,
): SeatPoolEnsureResult {
  try {
    const before = deps.jobsRepo.findAutoRegistration(SEAT_POOL_POLICY_NAME, model.sessionName, null, model.aliases);
    const job = deps.jobsRepo.ensureAutoRegistration(seatPoolJobInput(model, spec), model.aliases);
    if (before) return { outcome: job.state === "stopped" ? "stopped" : "active", job };
    const ended = model.aliases.some((alias) =>
      deps.jobsRepo.listExactTuple(SEAT_POOL_POLICY_NAME, alias, null).some((row) => row.state === "terminal"));
    return { outcome: "registered", job, replaced: ended ? "terminal" : "none" };
  } catch (error) {
    if (
      error instanceof WatchdogJobsError
      && (error.code === "auto_registration_ambiguous" || error.code === "auto_registration_state_invalid")
    ) {
      return { outcome: "ambiguous", code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
    }
    throw error;
  }
}

/** Reconcile one model node to its stored block. A node with no block, or a block that can't be read, is left alone. */
export function reconcileSeatPoolNode(deps: SeatPoolRegistrationDeps, nodeId: string): SeatPoolReconcileResult {
  const stored = deps.rigRepo.getNodePool(nodeId);
  if (stored === undefined) return { nodeId, outcome: "no_block" };
  if (!("spec" in stored)) return { nodeId, outcome: "unusable", error: stored.error };
  const model = resolveSeatPoolModel(deps.db, nodeId);
  if (!model) return { nodeId, outcome: "no_model_session" };
  return { nodeId, ...ensureSeatPoolJob(deps, model, stored.spec) };
}

/**
 * The daemon-start loop: every node with a stored block, one at a time, each in its own try/catch, so one node that
 * throws never stops the others. A failure and an ambiguous job state are warned with the node and the reason.
 */
export function reconcileSeatPoolsAtStartup(deps: SeatPoolRegistrationDeps): SeatPoolReconcileResult[] {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const nodes = deps.db.prepare(
    `SELECT n.id AS id FROM nodes n JOIN rigs r ON r.id = n.rig_id
      WHERE n.pool IS NOT NULL
      ORDER BY r.name, n.logical_id, n.id`,
  ).all() as Array<{ id: string }>;
  const results: SeatPoolReconcileResult[] = [];
  for (const { id } of nodes) {
    let result: SeatPoolReconcileResult;
    try {
      result = reconcileSeatPoolNode(deps, id);
    } catch (error) {
      result = { nodeId: id, outcome: "failed", message: formatWatchdogRegistrationError(error) };
    }
    if (result.outcome === "failed") {
      warn(`[seat-pool] daemon start could not ensure the seat-pool job for node_id="${id}" and continued: ${result.message}`);
    } else if (result.outcome === "no_model_session") {
      warn(`[seat-pool] node_id="${id}" has a pool block but no canonical pod member session; no seat-pool job ensured`);
    } else if (result.outcome === "ambiguous") {
      warn(
        `[seat-pool] node_id="${id}" has an ambiguous seat-pool job state (${result.code}); no job picked: ${result.message}`
        + (result.details ? `; details=${JSON.stringify(result.details)}` : ""),
      );
    }
    results.push(result);
  }
  return results;
}
