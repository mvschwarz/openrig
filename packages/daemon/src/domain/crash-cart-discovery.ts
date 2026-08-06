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
