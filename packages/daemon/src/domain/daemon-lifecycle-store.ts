import type Database from "better-sqlite3";

/** The daemon's lifecycle record (mig-061 singleton) — started / last-seen /
 *  stopped for the current boot epoch. Distinct from the identity record (059). */
export interface DaemonLifecycleRecord {
  bootEpoch: string;
  startedAt: string;
  lastHeartbeatAt: string | null;
  stoppedAt: string | null;
}

interface Row {
  boot_epoch: string;
  started_at: string;
  last_heartbeat_at: string | null;
  stopped_at: string | null;
}

/**
 * P7 — accessors for the daemon_lifecycle singleton. Each write is a single
 * statement = its own implicit SQLite transaction (arch: "own tiny transaction").
 * The heartbeat guards not-stopped and the stop is terminal-per-epoch, so a stray
 * post-stop tick can never advance last-seen (the binding write-order pin).
 */
export class DaemonLifecycleStore {
  constructor(private readonly db: Database.Database) {}

  /** A new boot: mint a new epoch, set started_at, and CLEAR the prior run's
   *  heartbeat + stopped_at (a fresh epoch never shows the previous run's stop). */
  recordBoot(bootEpoch: string, nowIso: string): void {
    this.db
      .prepare(
        `INSERT INTO daemon_lifecycle (singleton, boot_epoch, started_at, last_heartbeat_at, stopped_at)
           VALUES (1, ?, ?, NULL, NULL)
         ON CONFLICT(singleton) DO UPDATE SET
           boot_epoch = excluded.boot_epoch,
           started_at = excluded.started_at,
           last_heartbeat_at = NULL,
           stopped_at = NULL`,
      )
      .run(bootEpoch, nowIso);
  }

  /** Advance last-seen — ONLY while not stopped (a stray tick after stopped_at
   *  must never move last-seen; stopped_at is terminal per epoch). */
  recordHeartbeat(nowIso: string): void {
    this.db
      .prepare(`UPDATE daemon_lifecycle SET last_heartbeat_at = ? WHERE singleton = 1 AND stopped_at IS NULL`)
      .run(nowIso);
  }

  /** Clean-shutdown mark — set stopped_at ONLY for the matching epoch and only if
   *  not already stopped (terminal per epoch). */
  recordStop(bootEpoch: string, nowIso: string): void {
    this.db
      .prepare(`UPDATE daemon_lifecycle SET stopped_at = ? WHERE singleton = 1 AND boot_epoch = ? AND stopped_at IS NULL`)
      .run(nowIso, bootEpoch);
  }

  get(): DaemonLifecycleRecord | null {
    const row = this.db
      .prepare(`SELECT boot_epoch, started_at, last_heartbeat_at, stopped_at FROM daemon_lifecycle WHERE singleton = 1`)
      .get() as Row | undefined;
    if (!row) return null;
    return {
      bootEpoch: row.boot_epoch,
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at ?? null,
      stoppedAt: row.stopped_at ?? null,
    };
  }
}
