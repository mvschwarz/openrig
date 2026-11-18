import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { latestHookState, type AgentActivityStore } from "./agent-activity-store.js";
import { collectReactiveEventSignals } from "./provider/reactive-tap.js";
import { resolveGuardTarget } from "./seat-delivery-guard.js";
import { claudeConfigRootFor, seatRuntimeHome } from "./seat-runtime-home.js";
import { latestRuntimeHomeRecord } from "./seat-runtime-home-record.js";
import type { AgentActivity } from "./types.js";

export interface WatchdogUsageLimitState {
  /** Opaque comparison key, not an account path or credential. */
  identity: string;
  limit: { asOf: string; resetsAt: string } | null;
  /** Positive activity/clear evidence; absence is unknown, not recovery. */
  clearedAt?: string;
}

/** Read existing, generation-checked provider evidence and selected-home metadata. No native probes or login reads.
 * A retained latest Claude limit stays relevant until its stated reset, even when its hook freshness window expires.
 * Codex's banner currently supplies no stated reset; it keeps the ordinary retry rather than guessing one. */
export function readWatchdogUsageLimitState(deps: {
  db: Database.Database;
  activity: Pick<AgentActivityStore, "getLatestForNode">;
  currentActivity?: (session: string, hook: AgentActivity | null, runtime: string) => AgentActivity | null;
  now?: () => Date;
}, session: string): WatchdogUsageLimitState | null {
  try {
    const target = resolveGuardTarget(deps.db, session);
    if (!target?.occupant) return null;
    const node = deps.db.prepare("SELECT runtime FROM nodes WHERE id=?").get(target.nodeId) as { runtime: string | null } | undefined;
    if (!node?.runtime) return null;
    const runtime = node.runtime, now = (deps.now ?? (() => new Date()))();
    const home = runtime === "claude-code" ? claudeConfigRootFor(deps.db, target.nodeId)
      : runtime === "codex" ? seatRuntimeHome(deps.db, target.nodeId, "codex").home : null;
    const record = latestRuntimeHomeRecord(deps.db, target.nodeId);
    const identity = createHash("sha256").update(JSON.stringify([target.nodeId, target.occupant, runtime, home, record?.revision])).digest("hex");
    const activity = deps.activity.getLatestForNode({ nodeId: target.nodeId, sessionName: target.session, now,
      order: runtime === "claude-code" ? "source" : "arrival" });
    // Reuse #2917's typed at_limit conversion and reset validation. Only age staleness may be lifted here:
    // generation mismatch/unresolved evidence remains ineligible. Eight days is the existing relay/tap reset bound.
    const retained = activity?.reason === "stale_runtime_hook" ? { ...activity, stale: false } : activity;
    const signal = runtime === "claude-code" ? collectReactiveEventSignals({
      seats: [{ seatSession: target.session, runtime }], auth: { profiles: [], seats: [] },
      activity: { getLatestForNode: () => retained }, now: now.toISOString(), freshnessMs: 8 * 24 * 3600_000,
    }).signals.find(s => s.resetsAt) : undefined;
    const limit = signal?.resetsAt && Date.parse(signal.resetsAt) > now.getTime()
      // A recorded account/home move postdating the hook means the hook describes the old selection.
      && !(record && Date.parse(record.recordedAt) >= Date.parse(signal.asOf))
      ? { asOf: signal.asOf, resetsAt: signal.resetsAt } : null;
    const state = latestHookState(activity, runtime);
    let clearedAt = state === "running" || state === "idle" ? activity?.eventAt ?? undefined : undefined;
    const current = deps.currentActivity?.(session, activity, runtime);
    if (current && !current.stale && (current.state === "running" || current.state === "idle")) {
      const at = current.eventAt ?? current.sampledAt;
      if (!clearedAt || Date.parse(at) > Date.parse(clearedAt)) clearedAt = at;
    }
    return { identity, limit, ...(clearedAt ? { clearedAt } : {}) };
  } catch {
    // Unreadable state must not turn an ordinary failed wake into a long hold.
    return null;
  }
}
