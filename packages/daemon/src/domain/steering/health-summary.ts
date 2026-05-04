// Operator Surface Reconciliation v0 — health summary aggregator.
//
// Item 1F: compact health gates on the steering surface. Two
// aggregations:
//   - nodes: cross-rig roll-up of node sessionStatus + lifecycleState
//     (mirrors `rig ps --nodes --summary` shape; UI consumes for the
//     "running / detached / attention-required" badges).
//   - context: cross-rig roll-up of context-usage urgency + freshness
//     (mirrors `rigx-context --json` summary; UI consumes for the
//     "critical / warning / ok / stale" badges).
//
// Daemon-side aggregation rather than CLI shell-out: the steering
// composer stays in-process and avoids spawning subprocesses per
// request. Same data, cheaper.

import type Database from "better-sqlite3";
import type { RigRepository } from "../rig-repository.js";
import { getNodeInventory } from "../node-inventory.js";

export interface NodeHealthSummary {
  /** Total nodes across all rigs. */
  total: number;
  /** Counts grouped by node.sessionStatus (running / detached / exited / unknown). */
  bySessionStatus: Record<string, number>;
  /** Counts grouped by lifecycleState (running / recoverable / detached / attention_required). */
  byLifecycle: Record<string, number>;
  /** Convenience tally for the steering surface's headline number. */
  attentionRequired: number;
}

export interface ContextHealthSummary {
  /** Total nodes that the context store knows about. */
  total: number;
  /** Counts grouped by context urgency (critical / warning / low / unknown). */
  byUrgency: Record<string, number>;
  /** Counts grouped by freshness of the last sample (fresh / stale / none). */
  byFreshness: Record<string, number>;
  /** Convenience tallies the steering surface foregrounds. */
  critical: number;
  warning: number;
  stale: number;
}

const FRESHNESS_THRESHOLD_S = 300;
const URGENCY_CRITICAL_PCT = 80;
const URGENCY_WARNING_PCT = 60;

export function computeNodeHealthSummary(deps: { db: Database.Database; rigRepo: RigRepository }): NodeHealthSummary {
  const rigs = deps.rigRepo.listRigs();
  const bySessionStatus: Record<string, number> = {};
  const byLifecycle: Record<string, number> = {};
  let total = 0;
  let attentionRequired = 0;
  for (const rig of rigs) {
    const inventory = getNodeInventory(deps.db, rig.id);
    for (const node of inventory) {
      total++;
      const sessionStatus = node.sessionStatus ?? "unknown";
      bySessionStatus[sessionStatus] = (bySessionStatus[sessionStatus] ?? 0) + 1;
      const lifecycle = (node as { lifecycleState?: string }).lifecycleState ?? "unknown";
      byLifecycle[lifecycle] = (byLifecycle[lifecycle] ?? 0) + 1;
      if (lifecycle === "attention_required") attentionRequired++;
    }
  }
  return { total, bySessionStatus, byLifecycle, attentionRequired };
}

/** Reduces context_usage rows into the steering health summary.
 *  Urgency derived from usedPercentage thresholds (≥80 critical, ≥60
 *  warning, otherwise low). Freshness derived from sampledAt age vs
 *  FRESHNESS_THRESHOLD_S (300s). Reads context_usage directly because
 *  ContextUsageStore intentionally exposes per-node accessors only;
 *  listing all rows is a steering-surface concern, not a per-node
 *  concern. */
export function computeContextHealthSummary(deps: { db: Database.Database }): ContextHealthSummary {
  let samples: Array<{ usedPercentage: number | null; sampledAt: string | null }> = [];
  try {
    samples = deps.db.prepare(
      `SELECT used_percentage AS usedPercentage, sampled_at AS sampledAt FROM context_usage`,
    ).all() as Array<{ usedPercentage: number | null; sampledAt: string | null }>;
  } catch {
    // Table absent (test harness without the migration): empty summary.
    samples = [];
  }
  const byUrgency: Record<string, number> = { critical: 0, warning: 0, low: 0, unknown: 0 };
  const byFreshness: Record<string, number> = { fresh: 0, stale: 0, none: 0 };
  let critical = 0;
  let warning = 0;
  let stale = 0;
  const now = Date.now();
  for (const sample of samples) {
    const used = sample.usedPercentage;
    let urgencyKey: keyof typeof byUrgency;
    if (used == null) urgencyKey = "unknown";
    else if (used >= URGENCY_CRITICAL_PCT) { urgencyKey = "critical"; critical++; }
    else if (used >= URGENCY_WARNING_PCT) { urgencyKey = "warning"; warning++; }
    else urgencyKey = "low";
    byUrgency[urgencyKey] = (byUrgency[urgencyKey] ?? 0) + 1;

    let freshnessKey: keyof typeof byFreshness;
    if (!sample.sampledAt) freshnessKey = "none";
    else {
      const ageS = (now - new Date(sample.sampledAt).getTime()) / 1000;
      if (ageS > FRESHNESS_THRESHOLD_S) { freshnessKey = "stale"; stale++; }
      else freshnessKey = "fresh";
    }
    byFreshness[freshnessKey] = (byFreshness[freshnessKey] ?? 0) + 1;
  }
  return {
    total: samples.length,
    byUrgency,
    byFreshness,
    critical,
    warning,
    stale,
  };
}
