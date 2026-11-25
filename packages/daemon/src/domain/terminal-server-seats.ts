import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { OutboxEntry } from "./outbox-handler.js";
import type { RigDeliveryDrainStore } from "./rig-delivery-drain.js";
import { resolveGuardTarget } from "./seat-delivery-guard.js";
import { TerminalServerReachability, type TerminalServerChange, type TerminalServerObservation } from "./terminal-server-reachability.js";

/**
 * #3315 — which seats a lost tmux server holds. A seat is on the daemon's tmux server when its binding is a tmux
 * attachment with a tmux session. External-CLI, hosted and gateway destinations never go through tmux, so a lost
 * server never holds them. A database that can't answer reads as not held: delivery then fails as it did before.
 */
export function isTmuxBoundSession(db: Database.Database, sessionName: string): boolean {
  try {
    const target = resolveGuardTarget(db, sessionName);
    if (!target) return false;
    const binding = db.prepare(
      `SELECT COALESCE(attachment_type, 'tmux') AS attachment, tmux_session AS session FROM bindings WHERE node_id = ?`,
    ).get(target.nodeId) as { attachment: string; session: string | null } | undefined;
    return binding?.attachment === "tmux" && !!binding.session;
  } catch {
    return false;
  }
}

/** The running seats on tmux, by their newest session: the ones whose owed work is looked at again when the server
 *  answers again. */
export function runningTmuxSessions(db: Database.Database): string[] {
  try {
    return (db.prepare(`
      SELECT DISTINCT s.session_name AS name FROM sessions s JOIN bindings b ON b.node_id = s.node_id
      WHERE s.id = (SELECT latest.id FROM sessions latest WHERE latest.node_id = s.node_id
          ORDER BY datetime(latest.created_at) DESC, latest.rowid DESC LIMIT 1)
        AND s.status = 'running' AND s.session_name IS NOT NULL
        AND COALESCE(b.attachment_type, 'tmux') = 'tmux' AND b.tmux_session IS NOT NULL
    `).all() as Array<{ name: string }>).map(row => row.name);
  } catch {
    return [];
  }
}

/**
 * #3315 — the daemon's wiring of its tmux server's reachability (startup.ts), kept here so it can be tested whole:
 * the adapter's classified probes feed the record; a loss counts only while a running tmux seat depends on the server;
 * each change becomes one event; delivery to the seats on it is held through the queue's delivery hold; a read-only
 * probe notices the return, and then owed work is offered again: pending wake intents go out as at a drain's END, and
 * the reachable-seat retry runs for the running tmux seats. A return probe that can't be read ends the hold the same
 * way, without recording a return. Nothing here starts a server or a seat.
 */
export function wireTerminalReachability(opts: {
  db: Database.Database;
  adapter: Pick<TmuxAdapter, "probeSession" | "serverObserver" | "serverEpoch">;
  drains: RigDeliveryDrainStore;
  socket: string;
  emit: (change: TerminalServerChange) => void;
  drainPendingWakeIntents: (opts: { eligible: (entry: OutboxEntry) => boolean }) => Promise<unknown>;
  retryPromptWakes: (sessionName: string) => void;
  probeIntervalMs?: number;
  probeMaxIntervalMs?: number;
}): TerminalServerReachability {
  const { db, adapter, drains, socket } = opts;
  // Owed work offered again once a hold ends: pending wake intents go out as at a drain's END, and the reachable-seat
  // retry runs for the running tmux seats.
  const offerOwedWork = () => {
    void opts.drainPendingWakeIntents({ eligible: entry => entry.deliveryState === "pending"
      && isTmuxBoundSession(db, entry.destinationSession) })
      .catch(error => console.warn(`Terminal-server return wake pass: ${error instanceof Error ? error.name : typeof error}`));
    for (const session of runningTmuxSessions(db)) {
      try { opts.retryPromptWakes(session); } catch { /* one seat's retry never stops the others' */ }
    }
  };
  const reach: TerminalServerReachability = new TerminalServerReachability({
    probeIntervalMs: opts.probeIntervalMs,
    probeMaxIntervalMs: opts.probeMaxIntervalMs,
    watched: () => runningTmuxSessions(db).length > 0,
    onChange: (change) => {
      try { opts.emit(change); } catch (error) { console.warn(`[tmux] Could not record ${change.type}: ${error instanceof Error ? error.message : String(error)}`); }
      if (change.type === "tmux.server_back") offerOwedWork();
    },
    // The hold ended on an unreadable probe: owed work resumes through the same existing pass, with nothing proven.
    onUnknown: () => offerOwedWork(),
    // The adapter's own probe reports to the record (serverObserver) with tmux's one-line diagnostic. A classified
    // no-server answer keeps the loss (with the diagnostic the observer just recorded); any other tmux error throws out
    // of probeSession, which the record reads as an unreadable probe.
    probe: async (): Promise<TerminalServerObservation> => {
      const probe = await adapter.probeSession(`openrig-reachability-${randomUUID()}`);
      return probe.state === "transport_unavailable"
        ? { reachable: false, cause: reach.unreachable(socket)?.cause ?? probe.cause }
        : { reachable: true };
    },
  });
  // Each classified probe carries the epoch it started in, so one that finishes after a newer loss or return can't
  // overwrite it.
  adapter.serverEpoch = () => reach.epoch(socket);
  adapter.serverObserver = (observation, startedIn) => reach.observe(socket, observation, startedIn);
  drains.attachTerminalHold(session => reach.unreachable(socket) !== null && isTmuxBoundSession(db, session),
    () => reach.anyUnreachable());
  return reach;
}
