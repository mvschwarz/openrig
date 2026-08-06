// Crash-cart C2 — daemon-DOWN bounded direct-read discovery (plan c015d9ed §C2, arch a1344201).
//
// When the daemon is down (or won't start), the cockpit must still SHOW what is on this host —
// looking is always safe. This module reads the daemon's durable SQLite state WITHOUT a running
// daemon, via COPY-THEN-READ (arch Q1): the daemon DB is WAL-mode, so a post-crash `-wal` holds
// the last committed-but-unreplayed frames (exactly the where-work-stopped rows we must show).
// We copy the {db, -wal, -shm} triple to a disposable scratch dir and open the COPY read-only, so
// SQLite replays the WAL on the copy → a FRESH view with ZERO interference to the originals a
// restarting daemon will reopen. READ-ONLY by construction: nothing here ever writes daemon state.
//
// The read is fail-closed: it REFUSES if a daemon is live (see assertDaemonDown) — never contend
// with the process it exists to recover. All process/IO probes are injected so the logic is
// hermetically unit-testable.

import Database from "better-sqlite3";
import { basename, isAbsolute, join } from "node:path";

/** Refusal: a live daemon holds the DB, so the direct read is unsafe (route to the live read API). */
export class DaemonLiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonLiveError";
  }
}

/** Loud failure in the direct-read path (e.g. the daemon DB is not where we resolved it). */
export class CrashCartReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrashCartReadError";
  }
}

/** The daemon's default DB basename (`$OPENRIG_HOME/openrig.sqlite`) — NOT `main.db`. */
export const DAEMON_DB_BASENAME = "openrig.sqlite";

/** The daemon state file shape (`$OPENRIG_HOME/daemon.json`) — the authoritative DB-path + liveness record. */
export interface DaemonJson {
  pid: number;
  port: number;
  host?: string;
  /** The exact resolved DB path the daemon opened (prefer this over recomputing). */
  db: string;
  startedAt?: string;
}

export interface AssertDaemonDownDeps {
  /** `$OPENRIG_HOME` — where daemon.json lives. */
  openrigHome: string;
  /** Parse `$OPENRIG_HOME/daemon.json` → the record, or undefined if absent/unparseable (treated as down). */
  readDaemonJson: (openrigHome: string) => DaemonJson | undefined;
  /** True if `pid` is a live process (e.g. `process.kill(pid, 0)` succeeds). */
  isProcessAlive: (pid: number) => boolean;
  /** GET `<url>` → true if ANY daemon answered (the control-plane is live). Never throws. */
  probeHealthz: (url: string) => Promise<boolean>;
  /** `OPENRIG_URL` override — when set, its /healthz is probed too (bypasses the state file, like getDaemonStatus). */
  openrigUrl?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7433;

function stripTrailingSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

/**
 * FAIL-CLOSED guard: throw DaemonLiveError if a daemon is live, else resolve. A daemon counts as
 * live if EITHER the recorded pid is alive OR a /healthz probe answers (both must be negative to
 * proceed). Mirrors the daemon's own liveness logic (daemon.json pid + /healthz, honoring
 * OPENRIG_URL) so the crash-cart never disagrees with `getDaemonStatus` about "is it running".
 */
export async function assertDaemonDown(deps: AssertDaemonDownDeps): Promise<void> {
  const { openrigHome, readDaemonJson, isProcessAlive, probeHealthz, openrigUrl } = deps;

  // OPENRIG_URL, when set, is a direct daemon target — probe it first (a live answer = refuse).
  if (openrigUrl && openrigUrl.trim().length > 0) {
    if (await probeHealthz(`${stripTrailingSlash(openrigUrl.trim())}/healthz`)) {
      throw new DaemonLiveError(`a daemon answered OPENRIG_URL ${openrigUrl} — refusing the direct read`);
    }
  }

  const state = readDaemonJson(openrigHome);
  if (state) {
    if (typeof state.pid === "number" && isProcessAlive(state.pid)) {
      throw new DaemonLiveError(`daemon.json pid ${state.pid} is still alive — refusing the direct read`);
    }
    const host = state.host ?? DEFAULT_HOST;
    const port = state.port ?? DEFAULT_PORT;
    if (await probeHealthz(`http://${host}:${port}/healthz`)) {
      throw new DaemonLiveError(`a daemon answered http://${host}:${port}/healthz — refusing the direct read`);
    }
    return;
  }

  // No state file — a daemon could still be up without a readable one; probe the default address.
  if (await probeHealthz(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/healthz`)) {
    throw new DaemonLiveError(
      `a daemon answered the default http://${DEFAULT_HOST}:${DEFAULT_PORT}/healthz — refusing the direct read`,
    );
  }
}

/** The resolved daemon DB location + provenance. `relative` flags a state-file path we cannot
 *  reliably locate (the daemon's CWD is unknown to a separate reader) — the caller must handle it. */
export interface ResolvedDbPath {
  path: string;
  fromStateFile: boolean;
  relative: boolean;
}

/**
 * Resolve the daemon DB path. PREFER `daemon.json.db` (the exact path the daemon opened) over
 * recomputing; fall back to `$OPENRIG_HOME/openrig.sqlite`. A relative state-file path is flagged
 * (it resolves against the daemon's CWD, unknown here) rather than silently mis-located.
 */
export function resolveDaemonDbPath(
  openrigHome: string,
  readDaemonJson: (openrigHome: string) => DaemonJson | undefined,
): ResolvedDbPath {
  const state = readDaemonJson(openrigHome);
  if (state?.db && state.db.trim().length > 0) {
    return { path: state.db, fromStateFile: true, relative: !isAbsolute(state.db) };
  }
  return { path: join(openrigHome, DAEMON_DB_BASENAME), fromStateFile: false, relative: false };
}

export interface SnapshotDeps {
  /** Copy one file (e.g. `copyFileSync`). */
  copyFile: (src: string, dest: string) => void;
  /** True if the path exists (e.g. `existsSync`). */
  exists: (p: string) => boolean;
}

/**
 * Copy the `{db, -wal, -shm}` triple into `scratchDir` and return the copied db path. The db file is
 * required (loud fail if absent); sidecars are copied only when present (a clean-shutdown DB may have
 * no -wal). The daemon-down precondition (no concurrent writer) is what makes a plain file-copy
 * consistent — opening the COPY then replays the WAL on the copy, never touching the originals.
 */
export function snapshotDaemonDb(dbPath: string, scratchDir: string, deps: SnapshotDeps): string {
  if (!deps.exists(dbPath)) {
    throw new CrashCartReadError(`daemon DB not found at ${dbPath} — cannot copy-then-read`);
  }
  const destDb = join(scratchDir, basename(dbPath));
  deps.copyFile(dbPath, destDb);
  for (const suffix of ["-wal", "-shm"]) {
    if (deps.exists(dbPath + suffix)) deps.copyFile(dbPath + suffix, destDb + suffix);
  }
  return destDb;
}

/**
 * Open a COPIED daemon DB read-only. On the copy (in a writable scratch dir with its -wal/-shm
 * alongside) SQLite replays the WAL → the fresh, last-pre-crash view. Read-only is safe here because
 * the copy is disposable and the ORIGINALS are never opened by this path.
 */
export function openDaemonDbReadonly(copyDbPath: string): Database.Database {
  return new Database(copyDbPath, { readonly: true, fileMustExist: true });
}

// ── The discovery read-model (reproduces the daemon-side facts from the DB, daemon-down) ──────────

/** Header facts. `stopReason`/`priorUptimeMs` are ALWAYS null: no shutdown/uptime record is persisted
 *  anywhere (verified at source), so they are honest-null daemon-down — never fabricated. */
export interface CrashCartHeader {
  /** Newest write-timestamp across the durable tables (best-effort "last activity"); null if empty. */
  lastActivityAt: string | null;
  /** Last daemon boot (self_host_identity.reconciled_at advances every boot); null if never booted. */
  lastBootAt: string | null;
  /** First-ever boot (self_host_identity.minted_at). */
  firstBootAt: string | null;
  hostId: string | null;
  /** UNRECOVERABLE daemon-down — no shutdown record exists. Honest-null. */
  stopReason: null;
  /** UNRECOVERABLE daemon-down — no persisted uptime. Honest-null. */
  priorUptimeMs: null;
}

/** One rig found on this host, with the recovery-relevant counts. */
export interface RigFound {
  rigId: string;
  rigName: string;
  seatCount: number;
  runningCount: number;
  /** Seats whose LATEST session was probed resumable (derived; the recoverable bucket). */
  resumableCount: number;
  /** Newest persisted `sessions.last_seen_at` for the rig; null if none. (Live "last active" is a
   *  tmux observation, unavailable daemon-down — this is the honest DB approximation.) */
  lastActiveAt: string | null;
}

/** One in-progress queue item at crash time (display-only; the cart never mutates queue state). */
export interface StoppedWork {
  qitemId: string;
  destinationSession: string;
  sourceSession: string;
  state: string;
  claimedAt: string | null;
  summary: string | null;
  tsUpdated: string;
}

export interface CrashCartDiscovery {
  header: CrashCartHeader;
  foundOnHost: RigFound[];
  whereWorkStopped: StoppedWork[];
}

/** Read the full daemon-down discovery view from an already-opened (copied) daemon DB. Read-only. */
export function readCrashCartDiscovery(db: Database.Database): CrashCartDiscovery {
  return {
    header: readHeader(db),
    foundOnHost: readFoundOnHost(db),
    whereWorkStopped: readWhereWorkStopped(db),
  };
}

function readHeader(db: Database.Database): CrashCartHeader {
  const id = db
    .prepare("SELECT host_id, minted_at, reconciled_at FROM self_host_identity WHERE singleton = 1")
    .get() as { host_id: string; minted_at: string; reconciled_at: string } | undefined;
  // Newest write across the durable tables. datetime() in ORDER BY normalizes the mixed timestamp
  // formats (ISO-Z app writes vs SQLite `datetime('now')` defaults) so the comparison is chronological;
  // we return the ORIGINAL string of that newest row.
  const act = db
    .prepare(
      `SELECT ts FROM (
         SELECT last_seen_at AS ts FROM sessions
         UNION ALL SELECT created_at FROM sessions
         UNION ALL SELECT created_at FROM events
         UNION ALL SELECT ts_updated FROM queue_items
         UNION ALL SELECT last_seen_at FROM discovered_sessions
         UNION ALL SELECT reconciled_at FROM self_host_identity WHERE singleton = 1
       ) WHERE ts IS NOT NULL ORDER BY datetime(ts) DESC LIMIT 1`,
    )
    .get() as { ts: string } | undefined;
  return {
    lastActivityAt: act?.ts ?? null,
    lastBootAt: id?.reconciled_at ?? null,
    firstBootAt: id?.minted_at ?? null,
    hostId: id?.host_id ?? null,
    stopReason: null,
    priorUptimeMs: null,
  };
}

function readFoundOnHost(db: Database.Database): RigFound[] {
  // Per rig: seat count + counts folded over the LATEST session per node (max ULID id, per the
  // daemon's own latest-per-node convention) + newest persisted last_seen_at.
  const rows = db
    .prepare(
      `SELECT r.id AS rigId, r.name AS rigName,
         (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id) AS seatCount,
         (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id
            AND (SELECT s.status FROM sessions s WHERE s.node_id = n.id ORDER BY s.id DESC LIMIT 1) = 'running'
         ) AS runningCount,
         (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id
            AND (SELECT s.resume_last_probe_status FROM sessions s WHERE s.node_id = n.id ORDER BY s.id DESC LIMIT 1) = 'resumable'
         ) AS resumableCount,
         (SELECT MAX(s.last_seen_at) FROM sessions s JOIN nodes n ON s.node_id = n.id WHERE n.rig_id = r.id) AS lastActiveAt
       FROM rigs r
       WHERE r.archived_at IS NULL
       ORDER BY r.name ASC`,
    )
    .all() as Array<{
    rigId: string;
    rigName: string;
    seatCount: number;
    runningCount: number;
    resumableCount: number;
    lastActiveAt: string | null;
  }>;
  return rows.map((r) => ({
    rigId: r.rigId,
    rigName: r.rigName,
    seatCount: r.seatCount,
    runningCount: r.runningCount,
    resumableCount: r.resumableCount,
    lastActiveAt: r.lastActiveAt ?? null,
  }));
}

export interface LoadCrashCartDiscoveryDeps extends AssertDaemonDownDeps {
  /** Copy one file (e.g. `copyFileSync`). */
  copyFile: (src: string, dest: string) => void;
  /** True if the path exists (e.g. `existsSync`). */
  exists: (p: string) => boolean;
  /** Create a fresh disposable scratch dir for the DB copy; returns its path. */
  makeScratchDir: () => string;
  /** Remove the scratch dir (best-effort cleanup). */
  removeScratchDir: (dir: string) => void;
  /** Open the copied DB read-only. Defaults to openDaemonDbReadonly; injected in tests. */
  openDb?: (copyDbPath: string) => Database.Database;
}

/**
 * The public C2 entry: safely read the daemon-down discovery view. FAIL-CLOSED FIRST (throws
 * DaemonLiveError before touching disk if a daemon is live), then copy-then-read the DB into a
 * disposable scratch dir, read the view, and ALWAYS clean up the scratch copy. Read-only end to end.
 */
export async function loadCrashCartDiscovery(
  deps: LoadCrashCartDiscoveryDeps,
): Promise<{ discovery: CrashCartDiscovery; dbPath: ResolvedDbPath }> {
  // Refuse before any disk work if a daemon holds the DB.
  await assertDaemonDown(deps);

  const resolved = resolveDaemonDbPath(deps.openrigHome, deps.readDaemonJson);
  if (resolved.relative) {
    throw new CrashCartReadError(
      `daemon DB path '${resolved.path}' is relative — the daemon CWD is unknown, cannot locate it daemon-down`,
    );
  }

  const scratchDir = deps.makeScratchDir();
  try {
    const copyDb = snapshotDaemonDb(resolved.path, scratchDir, {
      copyFile: deps.copyFile,
      exists: deps.exists,
    });
    const db = (deps.openDb ?? openDaemonDbReadonly)(copyDb);
    try {
      return { discovery: readCrashCartDiscovery(db), dbPath: resolved };
    } finally {
      db.close();
    }
  } finally {
    deps.removeScratchDir(scratchDir);
  }
}

function readWhereWorkStopped(db: Database.Database): StoppedWork[] {
  const rows = db
    .prepare(
      `SELECT qitem_id AS qitemId, destination_session AS destinationSession, source_session AS sourceSession,
              state, claimed_at AS claimedAt, summary, ts_updated AS tsUpdated
       FROM queue_items
       WHERE state = 'in-progress'
       ORDER BY datetime(ts_updated) DESC, qitem_id DESC`,
    )
    .all() as Array<{
    qitemId: string;
    destinationSession: string;
    sourceSession: string;
    state: string;
    claimedAt: string | null;
    summary: string | null;
    tsUpdated: string;
  }>;
  return rows.map((r) => ({
    qitemId: r.qitemId,
    destinationSession: r.destinationSession,
    sourceSession: r.sourceSession,
    state: r.state,
    claimedAt: r.claimedAt ?? null,
    summary: r.summary ?? null,
    tsUpdated: r.tsUpdated,
  }));
}
