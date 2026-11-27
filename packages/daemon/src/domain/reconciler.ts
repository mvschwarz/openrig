import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import { isMissingTmuxServer, probeShowsNoServer, type SessionProbe, type TmuxAdapter } from "../adapters/tmux.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { readProcessTable, type ProcessTableCensus, type ProcessTableRow } from "./process-table.js";
import { lstartToMinTs } from "./codex-thread-id.js";
import { resolveSeatKind, seatProcessOwner } from "./seat-kinds.js";

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
   *  socket unreachable, say), a detached or terminal row tmux still shows, or a session whose seat's recorded process
   *  couldn't be checked because the process table was unreadable. Left as they were. */
  undetermined?: { sessionId: string; sessionName: string; cause: string }[];
  /** #2940, with `absenceProof: "positive"` only: the sessions this reconcile proved gone (tmux reports them absent or
   *  no server running, and their seat's recorded process isn't running), whatever their status. */
  provenAbsent?: string[];
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

  /** The rig's seats whose binding is an external CLI (`rig attach`). An unreadable record reads as none, as before. */
  private externalCliNodes(rigId: string): Set<string> {
    try {
      return new Set((this.db.prepare(`SELECT b.node_id, b.attachment_type FROM bindings b JOIN nodes n ON n.id = b.node_id
        WHERE n.rig_id = ?`).all(rigId) as Array<{ node_id: string; attachment_type: string | null }>)
        .filter((r) => seatProcessOwner(resolveSeatKind(r.attachment_type)) === "external").map((r) => r.node_id));
    } catch { return new Set(); }
  }

  /** `nodeIds` (#2940): reconcile only these seats' sessions, leaving the rest of the rig as it is; the keep_alive
   *  supervisor uses it at runtime for its own seats. Without it, every session of the rig is reconciled, as at boot.
   *  `absenceProof: "positive"` (#2940): a session counts as gone only when tmux says it's absent or that no server is
   *  running; an unreachable socket proves nothing, so that row stays as it is and is reported undetermined. A missing
   *  socket (a reboot's /tmp cleanup) is the exception when a seat's process recorded for its latest session is proven
   *  gone and no tmux server is seen running: as `rig down` does, an empty server is started and the sessions probed
   *  again. Terminal rows (exited, superseded) are probed too, never rewritten, and an unreadable process table proves
   *  nothing for a seat with a recorded process. Without it, an unreachable tmux counts as gone, as at boot. */
  async reconcile(
    rigId: string,
    opts?: { nodeIds?: readonly string[]; absenceProof?: "positive" },
  ): Promise<ReconcileResult> {
    const only = opts?.nodeIds ? new Set(opts.nodeIds) : null;
    // A seat joined with `rig attach` as an external CLI runs in someone else's program: OpenRig neither launches nor stops
    // it (seatProcessOwner), and tmux never held it, so a tmux probe says nothing about it. Its sessions are left as they are.
    const external = this.externalCliNodes(rigId);
    const sessions = this.sessionRegistry.getSessionsForRig(rigId)
      .filter((session) => (!only || only.has(session.nodeId)) && !external.has(session.nodeId));

    let checked = 0;
    let detached = 0;
    const detachedSessionIds: string[] = [];
    const stopsConfirmed: string[] = [];
    const unseen: ReconcileResult["unseen"] = [];
    const undetermined: NonNullable<ReconcileResult["undetermined"]> = [];
    const errors: { sessionId: string; error: string }[] = [];
    const provenAbsent: string[] = [];
    const positive = opts?.absenceProof === "positive";
    let table: Promise<ProcessTableRow[] | null> | null = null;
    const processes = () => (table ??= this.readProcesses().catch(() => null));
    /** The seat's recorded process: still running, or, with `strict` (positive proof asked for, or a pending stop),
     *  unknowable because the process table couldn't be read while there was a recorded process to look for. */
    const census = async (session: { nodeId: string; sessionName: string }, strict: boolean) => {
      let consulted = false;
      const running = await recordedProcessStillRunning(this.db, session, () => { consulted = true; return processes(); });
      return { running, unreadable: !running && strict && consulted && (await processes()) === null };
    };
    // With positive proof asked for, terminal history is probed too: each session name is probed once per reconcile.
    const probes = new Map<string, Promise<SessionProbe>>();
    const probe = (name: string) => {
      if (!positive) return this.tmuxAdapter.probeSession(name);
      if (!probes.has(name)) probes.set(name, this.tmuxAdapter.probeSession(name));
      return probes.get(name)!;
    };
    const startEmptyServer = async () => {
      try {
        return typeof this.tmuxAdapter.startServer === "function" && (await this.tmuxAdapter.startServer()).ok;
      } catch {
        return false;
      }
    };

    const stopRequested = this.db.prepare("SELECT intentionally_stopped AS flag FROM sessions WHERE id = ?");
    const latestOfNode = this.db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1");
    if (positive) {
      // A reboot's /tmp cleanup removes tmux's socket. As `rig down` does, an empty server is started and every session
      // probed again, so a missing server is proven absent. It is decided per seat on its latest session alone, and only
      // when that seat's process recorded for this very session is proven gone and the process table shows no tmux
      // server still running: a server may only have lost its socket (an age cleanup of /tmp, say) and keep running
      // other seats, and an empty server on the same socket would then "prove" them absent while they still run.
      for (const nodeId of new Set(sessions.map((session) => session.nodeId))) {
        const latestId = (latestOfNode.get(nodeId) as { id: string } | undefined)?.id;
        const latest = sessions.find((session) => session.id === latestId);
        if (!latest) continue;
        let observed: SessionProbe;
        try { observed = await probe(latest.sessionName); } catch { continue; }
        if (probeShowsNoServer(observed) || !isMissingTmuxServer(observed)) continue;
        if (!await recordedProcessProvenGone(this.db, latest, processes)) continue;
        if (await noTmuxServerRunning(processes) && await startEmptyServer()) probes.clear();
        break;
      }
    }
    for (const session of sessions) {
      // #2940: a stop request still pending on a live or detached row is confirmed once the session is gone.
      const requested = (stopRequested.get(session.id) as { flag: number } | undefined)?.flag === 1;
      // With positive proof asked for, a detached row is probed again too: its status may be stale (a boot reconcile
      // that couldn't reach tmux detached it), and the caller acts on it only when it is proven gone now.
      const recheckDetached = session.status === "detached" && (requested || positive);
      // With positive proof asked for, a terminal row is probed too and never rewritten: the caller needs to know
      // whether it is gone (a failed launch can leave its session in any status).
      const probeOnly = positive && (session.status === "exited" || session.status === "superseded");
      if (SKIP_STATUSES.has(session.status) && !recheckDetached && !probeOnly) {
        continue;
      }

      let alive: boolean;
      let provenGone: boolean;
      try {
        // Boot-time reconciliation against a dead tmux server must still
        // detach stale rows: transport-absence is treated as detachable HERE,
        // by explicit choice at this call site (OPR.0.5.4.2 mini-req 2 — the
        // adapter no longer collapses that decision for its callers).
        const observed = await probe(session.sessionName);
        alive = observed.state === "present";
        provenGone = observed.state === "absent" || probeShowsNoServer(observed);
        checked++;
        // A pending stop is confirmed only on proof that the session is gone, at boot too; and so is any fall when the
        // caller asked for positive proof. An unreachable socket proves nothing: the row stays as it is.
        if (!alive && !provenGone && (requested || positive)) {
          undetermined.push({ sessionId: session.id, sessionName: session.sessionName,
            cause: observed.state === "transport_unavailable" ? observed.cause : observed.state });
          continue;
        }
        if (alive && ((session.status === "detached" && !requested) || probeOnly)) {
          // A detached or terminal row whose session tmux shows present isn't a fall; it is left as it is, reported
          // undetermined.
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
        // live seats. Without that evidence (after a reboot nothing recorded is running), it detaches as before. With
        // positive proof asked for, or for a pending stop (confirmed only on proof), a process table that couldn't be
        // read proves nothing either.
        const recorded = await census(session, positive || requested);
        if (recorded.running) {
          unseen.push({ sessionId: session.id, sessionName: session.sessionName, ...recorded.running });
          continue;
        }
        if (recorded.unreadable) {
          undetermined.push({ sessionId: session.id, sessionName: session.sessionName, cause: "the process table couldn't be read" });
          continue;
        }
        if (positive) provenAbsent.push(session.id);
        if (probeOnly) continue;
        // The request may have been withdrawn while the probe and the census were awaited (a stop proven to have had no
        // effect puts it back): a session it no longer carries is a fall, not a confirmed stop. Read right before the
        // write, with no await in between, as the stop and the clean do (stopStillRequested).
        if (requested && (stopRequested.get(session.id) as { flag: number } | undefined)?.flag === 1) {
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
      ...(positive || undetermined.length ? { undetermined } : {}), ...(positive ? { provenAbsent } : {}), errors,
    };
  }
}

/** #2940: positive proof that the seat's process recorded for this very session is gone: the evidence names the session,
 *  was observed since the session began (to the second, the precision of its creation time), has pids, the process
 *  table can be read, and none of those pids is held by the observed process: a pid not listed, or held by a process
 *  that started after the observation (a pid reused after a reboot), is gone. A holder whose start can't be dated, like
 *  anything else unknown, is no proof. */
async function recordedProcessProvenGone(
  db: Database.Database,
  session: { nodeId: string; sessionName: string; createdAt: string },
  processes: () => Promise<ProcessTableRow[] | null>,
): Promise<boolean> {
  const evidence = new SeatIdentityStore(db).getProcessEvidence(session.nodeId);
  if (!evidence || evidence.sessionName !== session.sessionName) return false;
  const created = Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(session.createdAt) ? session.createdAt : `${session.createdAt.replace(" ", "T")}Z`);
  const observed = Date.parse(evidence.observedAt);
  if (!Number.isFinite(created) || !Number.isFinite(observed) || observed < Math.floor(created / 1000) * 1000) return false;
  const pids = [evidence.panePid, evidence.pid].filter((pid): pid is number => typeof pid === "number" && pid > 0);
  if (!pids.length) return false;
  const rows = await processes();
  // A pid held by a process that started after the observation was reused (after a reboot, say): it isn't the seat's.
  return !!rows && pids.every((pid) => {
    const row = rows.find((r) => r.pid === pid);
    return !row || isRecordedProcess(row, observed / 1000) === false;
  });
}

/** Whether the process now holding a recorded pid is the one observed: true when it started at or before the
 *  observation (`observedAt`, in seconds); false when it observably started after it, so the pid was reused; undefined
 *  when its start can't be dated, which proves neither. Start times are whole seconds, so a pid reused within the
 *  observation's second still counts as the observed process. */
function isRecordedProcess(row: Pick<ProcessTableRow, "startedAt">, observedAt: number): boolean | undefined {
  const started = lstartToMinTs(row.startedAt);
  return started === undefined ? undefined : started <= observedAt;
}

/** #2940: positive proof that no tmux server runs: the process table can be read and shows none. Conservative: any
 *  server counts, whatever its socket or user (on Linux tmux names it `tmux: server`; elsewhere it keeps the name
 *  `tmux`, which a client has too). */
async function noTmuxServerRunning(processes: () => Promise<ProcessTableRow[] | null>): Promise<boolean> {
  const rows = await processes();
  return !!rows && !rows.some((row) => row.executableName === "tmux: server" || row.executableName === "tmux");
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
    if (!row || isRecordedProcess(row, observedAt) !== true) continue;
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
    return !row || isRecordedProcess(row, observedAt) === false;
  });
}
