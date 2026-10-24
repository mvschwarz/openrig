import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { readProcessTable, type ProcessTableRow } from "./process-table.js";
import { lstartToMinTs } from "./codex-thread-id.js";

export interface ReconcileResult {
  checked: number;
  detached: number;
  /** Not on this daemon's tmux server, yet the seat's last observed process is still running: most likely on a tmux
   *  server this daemon can't see (it didn't inherit the seats' TMUX). Left as they were, never detached, so nothing
   *  relaunches them. `parent` is that process's immediate parent when the process table shows it; it may be the tmux
   *  server, or a shell or wrapper in between. */
  unseen: { sessionId: string; sessionName: string; pid: number; parent: { pid: number; command: string } | null }[];
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

  async reconcile(rigId: string): Promise<ReconcileResult> {
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    let checked = 0;
    let detached = 0;
    const unseen: ReconcileResult["unseen"] = [];
    const errors: { sessionId: string; error: string }[] = [];
    let table: Promise<ProcessTableRow[] | null> | null = null;
    const processes = () => (table ??= this.readProcesses().catch(() => null));

    for (const session of sessions) {
      if (SKIP_STATUSES.has(session.status)) {
        continue;
      }

      let alive: boolean;
      try {
        // Boot-time reconciliation against a dead tmux server must still
        // detach stale rows: transport-absence is treated as detachable HERE,
        // by explicit choice at this call site (OPR.0.5.4.2 mini-req 2 — the
        // adapter no longer collapses that decision for its callers).
        const probe = await this.tmuxAdapter.probeSession(session.sessionName);
        alive = probe.state === "present";
        checked++;
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
        const elsewhere = await this.recordedProcessStillRunning(session, processes);
        if (elsewhere) {
          unseen.push({ sessionId: session.id, sessionName: session.sessionName, ...elsewhere });
          continue;
        }
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
          this.eventBus.notifySubscribers(persistedEvent);
          detached++;
        } catch (err) {
          errors.push({
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { checked, detached, unseen, errors };
  }

  /** The seat's last observed process, as a conservative hint that it still runs, not proof of identity: the last pid
   *  evidence recorded for this very session (kept with its own time, so a later poll that couldn't see the seat doesn't
   *  erase it), and a process with that pid whose start isn't observably later than that observation. Start times are
   *  whole seconds, so a pid reused within the observation's second still passes. An unreadable table or record is no
   *  evidence. */
  private async recordedProcessStillRunning(
    session: { nodeId: string; sessionName: string },
    processes: () => Promise<ProcessTableRow[] | null>,
  ): Promise<{ pid: number; parent: { pid: number; command: string } | null } | null> {
    const evidence = new SeatIdentityStore(this.db).getProcessEvidence(session.nodeId);
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
}
