import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import { probeShowsNoServer, type TmuxAdapter } from "../adapters/tmux.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { readProcessTable, type ProcessTableRow } from "./process-table.js";
import { lstartToMinTs } from "./codex-thread-id.js";

export interface ReconcileResult {
  checked: number;
  detached: number;
  /** The sessions this reconcile marked detached. */
  detachedSessionIds: string[];
  /** #2940: sessions with a recorded stop request that were gone, now confirmed stopped (never detached): a daemon lost
   *  during a stop or a down leaves the seat down, not fallen. */
  stopsConfirmed?: string[];
  /** Not on this daemon's tmux server, yet the seat's last observed process is still running: most likely on a tmux
   *  server this daemon can't see (it didn't inherit the seats' TMUX). Left as they were, never detached, so nothing
   *  relaunches them. `parent` is that process's immediate parent when the process table shows it; it may be the tmux
   *  server, or a shell or wrapper in between. */
  unseen: { sessionId: string; sessionName: string; pid: number; parent: { pid: number; command: string } | null }[];
  /** #2940, with `absenceProof: "positive"` only: sessions whose probe proved neither presence nor absence (tmux's
   *  socket unreachable, say). Left as they were. */
  undetermined?: { sessionId: string; sessionName: string; cause: string }[];
  errors: { sessionId: string; error: string }[];
}

interface ReconcilerDeps {
  db: Database.Database;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  /** The OS process table; injectable for tests. */
  readProcesses?: () => Promise<ProcessTableRow[]>;
}

// Only an active/non-terminal session can become detached. In particular,
// superseded rows are occupant history: rewriting one to detached resurrects
// it as a restore candidate and makes the next reboot ambiguous.
const SKIP_STATUSES = new Set(["detached", "exited", "superseded"]);

export class Reconciler {
  private db: Database.Database;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;
  private readProcesses: () => Promise<ProcessTableRow[]>;

  constructor(deps: ReconcilerDeps) {
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("Reconciler: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("Reconciler: eventBus must share the same db handle");
    }

    this.db = deps.db;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.readProcesses = deps.readProcesses ?? readProcessTable;
  }

  /** `nodeIds` (#2940): reconcile only these seats' sessions, leaving the rest of the rig as it is; the keep_alive
   *  supervisor uses it at runtime for its own seats. Without it, every session of the rig is reconciled, as at boot.
   *  `absenceProof: "positive"` (#2940): a session counts as gone only when tmux says it's absent or that no server is
   *  running; an unreachable socket proves nothing, so that row stays as it is and is reported undetermined. Without
   *  it, an unreachable tmux counts as gone, as at boot. */
  async reconcile(
    rigId: string,
    opts?: { nodeIds?: readonly string[]; absenceProof?: "positive" },
  ): Promise<ReconcileResult> {
    const only = opts?.nodeIds ? new Set(opts.nodeIds) : null;
    const sessions = this.sessionRegistry.getSessionsForRig(rigId).filter((session) => !only || only.has(session.nodeId));

    let checked = 0;
    let detached = 0;
    const detachedSessionIds: string[] = [];
    const stopsConfirmed: string[] = [];
    const unseen: ReconcileResult["unseen"] = [];
    const undetermined: NonNullable<ReconcileResult["undetermined"]> = [];
    const errors: { sessionId: string; error: string }[] = [];
    let table: Promise<ProcessTableRow[] | null> | null = null;
    const processes = () => (table ??= this.readProcesses().catch(() => null));

    const stopRequested = this.db.prepare("SELECT intentionally_stopped AS flag FROM sessions WHERE id = ?");
    const latestOfNode = this.db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1");
    for (const session of sessions) {
      // #2940: a stop request still pending on a live or detached row is confirmed once the session is gone.
      const requested = (stopRequested.get(session.id) as { flag: number } | undefined)?.flag === 1;
      // With positive proof asked for, a detached row is probed again too: its status may be stale (a boot reconcile
      // that couldn't reach tmux detached it), and the caller acts on it only when it is proven gone now.
      const recheckDetached = session.status === "detached" && (requested || opts?.absenceProof === "positive");
      if (SKIP_STATUSES.has(session.status) && !recheckDetached) {
        continue;
      }

      let alive: boolean;
      let provenAbsent: boolean;
      try {
        // Boot-time reconciliation against a dead tmux server must still
        // detach stale rows: transport-absence is treated as detachable HERE,
        // by explicit choice at this call site (OPR.0.5.4.2 mini-req 2 — the
        // adapter no longer collapses that decision for its callers).
        const probe = await this.tmuxAdapter.probeSession(session.sessionName);
        alive = probe.state === "present";
        provenAbsent = probe.state === "absent" || probeShowsNoServer(probe);
        checked++;
        // A pending stop is confirmed only on proof that the session is gone, at boot too; and so is any fall when the
        // caller asked for positive proof. An unreachable socket proves nothing: the row stays as it is.
        if (!alive && !provenAbsent && (requested || opts?.absenceProof === "positive")) {
          undetermined.push({ sessionId: session.id, sessionName: session.sessionName,
            cause: probe.state === "transport_unavailable" ? probe.cause : probe.state });
          continue;
        }
        if (alive && session.status === "detached" && !requested) {
          // A detached row whose session tmux shows present isn't a fall; it is left as it is, reported undetermined.
          undetermined.push({ sessionId: session.id, sessionName: session.sessionName, cause: "the session is present in tmux" });
          continue;
        }
      } catch (err) {
        errors.push({
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!alive) {
        // A session this server doesn't show isn't gone while its seat's recorded process still runs: the daemon is
        // looking at a different tmux server. Detaching it would have the kernel relaunch duplicates and supersede the
        // live seats. Without that evidence (after a reboot nothing recorded is running), it detaches as before.
        const elsewhere = await recordedProcessStillRunning(this.db, session, processes);
        if (elsewhere) {
          unseen.push({ sessionId: session.id, sessionName: session.sessionName, ...elsewhere });
          continue;
        }
        if (requested) {
          try {
            const txn = this.db.transaction(() => {
              this.sessionRegistry.markIntentionallyStopped(session.id);
              // The binding is the seat's: cleared only when this is still its latest session.
              if ((latestOfNode.get(session.nodeId) as { id: string } | undefined)?.id === session.id) {
                this.sessionRegistry.clearBinding(session.nodeId);
              }
              return this.eventBus.persistWithinTransaction({
                type: "session.stopped",
                rigId,
                nodeId: session.nodeId,
                sessionName: session.sessionName,
                reason: "stop completed: the session was gone when the daemon reconciled",
                operator: null,
              });
            });
            const persistedEvent = txn();
            stopsConfirmed.push(session.id);
            this.eventBus.notifySubscribers(persistedEvent);
          } catch (err) {
            errors.push({ sessionId: session.id, error: err instanceof Error ? err.message : String(err) });
          }
          continue;
        }
        if (session.status === "detached") continue;
        try {
          const txn = this.db.transaction(() => {
            this.sessionRegistry.markDetached(session.id);
            return this.eventBus.persistWithinTransaction({
              type: "session.detached",
              rigId,
              nodeId: session.nodeId,
              sessionName: session.sessionName,
            });
          });
          const persistedEvent = txn();
          // Detached once the transaction commits, even if notifying afterwards throws.
          detached++;
          detachedSessionIds.push(session.id);
          this.eventBus.notifySubscribers(persistedEvent);
        } catch (err) {
          errors.push({
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return {
      checked, detached, detachedSessionIds, ...(stopsConfirmed.length ? { stopsConfirmed } : {}), unseen,
      ...(opts?.absenceProof === "positive" || undetermined.length ? { undetermined } : {}), errors,
    };
  }
}

/** The seat's last observed process, as a conservative hint that it still runs, not proof of identity: the last pid
 *  evidence recorded for this very session (kept with its own time, so a later poll that couldn't see the seat doesn't
 *  erase it), and a process with that pid whose start isn't observably later than that observation. Start times are
 *  whole seconds, so a pid reused within the observation's second still passes. An unreadable table or record is no
 *  evidence. */
export async function recordedProcessStillRunning(
  db: Database.Database,
  session: { nodeId: string; sessionName: string },
  processes: () => Promise<Array<Pick<ProcessTableRow, "pid" | "ppid" | "command" | "startedAt">> | null>,
): Promise<{ pid: number; parent: { pid: number; command: string } | null } | null> {
  const evidence = new SeatIdentityStore(db).getProcessEvidence(session.nodeId);
  if (!evidence || evidence.sessionName !== session.sessionName) return null;
  const observedAt = Date.parse(evidence.observedAt) / 1000;
  const pids = [evidence.panePid, evidence.pid]
    .filter((pid): pid is number => typeof pid === "number" && pid > 0);
  if (!pids.length || Number.isNaN(observedAt)) return null;
  const rows = await processes();
  if (!rows) return null;
  for (const pid of pids) {
    const row = rows.find((r) => r.pid === pid);
    const started = row ? lstartToMinTs(row.startedAt) : undefined;
    if (!row || started === undefined || started > observedAt) continue;
    const parent = rows.find((r) => r.pid === row.ppid);
    return { pid, parent: parent ? { pid: parent.pid, command: parent.command } : null };
  }
  return null;
}
