import Database from "better-sqlite3";
import { join } from "node:path";
import { OPENRIG_HOME, readOpenRigEnv } from "./openrig-compat.js";

/** The daemon's lifecycle record (mig-061), read CLI-side for the status render. */
export interface DaemonLifecycleRecord {
  bootEpoch: string;
  startedAt: string;
  lastHeartbeatAt: string | null;
  stoppedAt: string | null;
}

export interface LifecycleDescription {
  /** clean-shutdown = stopped_at was written; no-clean-shutdown = it wasn't (crash/
   *  kill-9/power-loss); unknown = no record at all (pre-P7 daemon or never booted). */
  kind: "clean-shutdown" | "no-clean-shutdown" | "unknown";
  /** best last-seen: stopped_at if clean, else last heartbeat, else boot time. */
  lastSeen: string | null;
  stoppedAt: string | null;
}

/**
 * P7 render classification — pure. A stopped_at means the daemon marked a clean
 * shutdown; its ABSENCE (with a boot record present) is the money case: the daemon
 * died without recording a clean stop, so we render "no clean shutdown recorded,
 * last-seen T" instead of a bare "not running".
 */
export function describeLifecycle(record: DaemonLifecycleRecord | null): LifecycleDescription {
  if (!record) return { kind: "unknown", lastSeen: null, stoppedAt: null };
  if (record.stoppedAt) {
    return { kind: "clean-shutdown", lastSeen: record.stoppedAt, stoppedAt: record.stoppedAt };
  }
  return {
    kind: "no-clean-shutdown",
    lastSeen: record.lastHeartbeatAt ?? record.startedAt,
    stoppedAt: null,
  };
}

/**
 * Read the daemon_lifecycle singleton directly from the daemon's SQLite db,
 * READ-ONLY. This is the crash-surviving read path: on a dead pid the daemon
 * isn't answering HTTP and daemon.json is deleted, but the SQLite row persists.
 * Returns null if the db/table is absent or unreadable (→ "unknown").
 */
/** The daemon's db path, resolved the SAME way the daemon resolves it (D15):
 *  explicit OPENRIG_DB/RIGGED_DB wins, else OPENRIG_HOME/openrig.sqlite. Never
 *  CWD-relative. */
export function resolveLifecycleDbPath(): string {
  return readOpenRigEnv("OPENRIG_DB", "RIGGED_DB") || join(OPENRIG_HOME, "openrig.sqlite");
}

/** Read + classify the lifecycle record from the resolved db path (crash-surviving). */
export function readLifecycleDescription(): LifecycleDescription {
  return describeLifecycle(readDaemonLifecycle(resolveLifecycleDbPath()));
}

export function readDaemonLifecycle(dbPath: string): DaemonLifecycleRecord | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(`SELECT boot_epoch, started_at, last_heartbeat_at, stopped_at FROM daemon_lifecycle WHERE singleton = 1`)
      .get() as
      | { boot_epoch: string; started_at: string; last_heartbeat_at: string | null; stopped_at: string | null }
      | undefined;
    if (!row) return null;
    return {
      bootEpoch: row.boot_epoch,
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at ?? null,
      stoppedAt: row.stopped_at ?? null,
    };
  } catch {
    return null; // no db / no table / locked → unknown, never a crash of `rig status`
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
  }
}
