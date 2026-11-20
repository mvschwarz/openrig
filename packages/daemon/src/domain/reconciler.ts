import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { readProcessTable, type ProcessTableCensus, type ProcessTableRow } from "./process-table.js";
import { lstartToMinTs } from "./codex-thread-id.js";

export interface ReconcileResult {
  checked: number;
  detached: number;
  /** The sessions this reconcile marked detached. */
  detachedSessionIds: string[];
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
    const detachedSessionIds: string[] = [];
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
        const elsewhere = await recordedProcessStillRunning(this.db, session, processes);
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

    return { checked, detached, detachedSessionIds, unseen, errors };
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

/** Positive evidence that the seat's last observed process has ended, for reopening a tmux server under a session the
 *  boot reconcile detached. True only when: the evidence recorded for this very session names at least one pid with a
 *  readable observation time; that observation is at or after the detached session's own creation (`createdAt`,
 *  SQLite's UTC `YYYY-MM-DD HH:MM:SS`), so an earlier occupant's evidence, kept when a later verdict had no pid,
 *  can't authorize it; the census reads; the evidence is the same after the census as before it; no recorded pid is
 *  hidden from it (EPERM/EACCES: a live process this daemon can't read is not an ended one); and no recorded pid is a
 *  process that started at or before the observation. `census` must begin its census when called, after the evidence
 *  is read: a process recorded before then is listed if it still runs, while one recorded during the census may have
 *  started after it began, so it can't be listed. Anything else is not evidence of an end (false), unlike
 *  recordedProcessStillRunning's null, which also covers "can't tell". Limit: the proof covers only the LAST recorded
 *  process; a replacement no poll had recorded by the second read, followed by a lost socket, is outside it. */
export async function recordedProcessEnded(
  db: Database.Database,
  session: { nodeId: string; sessionName: string; createdAt: string | null | undefined },
  census: () => Promise<ProcessTableCensus | null>,
): Promise<boolean> {
  const store = new SeatIdentityStore(db);
  const evidence = store.getProcessEvidence(session.nodeId);
  if (!evidence || evidence.sessionName !== session.sessionName) return false;
  const observedAt = Date.parse(evidence.observedAt) / 1000;
  const createdAt = typeof session.createdAt === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(session.createdAt)
    ? Date.parse(session.createdAt.replace(" ", "T") + "Z") / 1000 : Number.NaN;
  const pids = [evidence.panePid, evidence.pid]
    .filter((pid): pid is number => typeof pid === "number" && pid > 0);
  if (!pids.length || Number.isNaN(observedAt) || Number.isNaN(createdAt) || observedAt < createdAt) return false;
  const table = await census();
  if (!table) return false;
  const after = store.getProcessEvidence(session.nodeId);
  if (after?.observedAt !== evidence.observedAt || after.sessionName !== evidence.sessionName
    || after.pid !== evidence.pid || after.panePid !== evidence.panePid) return false;
  if (pids.some((pid) => table.permissionHiddenPids.includes(pid))) return false;
  return pids.every((pid) => {
    const row = table.rows.find((r) => r.pid === pid);
    if (!row) return true;
    const started = lstartToMinTs(row.startedAt);
    return started !== undefined && started > observedAt;
  });
}
