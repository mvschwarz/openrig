import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";

/**
 * Classifier lease manager (PL-004 Phase B).
 *
 * Daemon-enforced single-writer lease for the project (classifier) primitive.
 * Per PRD § L2 hard rule + slice IMPL § Guard Checkpoint Focus item 2:
 *
 * - Single-writer: at most one lease in `state='active'` at any time, enforced
 *   via partial UNIQUE index `idx_classifier_leases_active_singleton`.
 * - TTL-based expiry: every lease has an `expires_at` (acquired_at + ttlMs).
 * - Heartbeat: `last_heartbeat` is updated by the lease holder. Stale heartbeat
 *   past TTL signals deadness.
 * - Deadness detection: caller of `evaluateDeadness` is the project verb path
 *   OR a watchdog. The manager itself does NOT auto-reclaim — only marks
 *   `expired` when heartbeat is stale.
 * - Reclaim is OPERATOR-VERB ONLY: `rig project --reclaim-classifier
 *   [--if-dead]`. Daemon does NOT auto-reclaim. The reclaim path takes the
 *   active lease away from the previous holder and emits classifier.reclaimed.
 *
 * Pattern mirrors Phase A's hot-potato-enforcer.ts shape: pure validation +
 * lifecycle methods, no Hono. Routes import this; this does not import routes.
 */

export const LEASE_STATES = ["active", "expired", "reclaimed"] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

export interface ClassifierLease {
  leaseId: string;
  classifierSession: string;
  acquiredAt: string;
  expiresAt: string;
  lastHeartbeat: string;
  state: LeaseState;
  reclaimedBySession: string | null;
  reclaimReason: string | null;
}

interface ClassifierLeaseRow {
  lease_id: string;
  classifier_session: string;
  acquired_at: string;
  expires_at: string;
  last_heartbeat: string;
  state: string;
  reclaimed_by_session: string | null;
  reclaim_reason: string | null;
}

export class ClassifierLeaseError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

/**
 * Default lease TTL: 15 minutes. Per PRD: "TTL-based"; concrete value is
 * implementation choice. 15 min is the operator-friendly midpoint between
 * stale-detection latency (longer = slower deadness signal) and unnecessary
 * heartbeat traffic (shorter = more wake-ups). Configurable via constructor
 * option for tests + future tuning.
 */
const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

export interface ClassifierLeaseManagerOptions {
  ttlMs?: number;
  /** For tests: inject a deterministic clock. Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Liveness check (per PRD: via whoami-service / node-inventory). Returns
   * true if the session is still alive. The lease-manager calls this when
   * evaluating deadness; if the function returns false AND the lease's
   * heartbeat is stale, the lease is marked expired.
   *
   * Defaults to `() => true` (no liveness check; tests can stub).
   */
  isAlive?: (classifierSession: string) => boolean;
}

export class ClassifierLeaseManager {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private isAlive: (classifierSession: string) => boolean;

  constructor(
    db: Database.Database,
    eventBus: EventBus,
    opts?: ClassifierLeaseManagerOptions,
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.now = opts?.now ?? (() => new Date());
    this.isAlive = opts?.isAlive ?? (() => true);
  }

  /**
   * Wire post-construction liveness check (used by startup.ts when
   * whoami-service is constructed later in the dep graph).
   */
  attachIsAlive(check: (classifierSession: string) => boolean): void {
    this.isAlive = check;
  }

  /**
   * Acquire the active lease for a classifier session. Fails with
   * `lease_held` (409) if another session currently holds an active lease
   * AND that session is alive. If the held lease is by a dead session, the
   * caller should first invoke `evaluateDeadness` (which marks it expired)
   * or use the operator reclaim path.
   *
   * Idempotent for the SAME classifier_session: re-calling acquire on the
   * lease holder's behalf returns the existing lease unchanged (heartbeat
   * is updated separately via `heartbeat`).
   */
  acquire(classifierSession: string): ClassifierLease {
    const active = this.getActiveLease();
    if (active) {
      if (active.classifierSession === classifierSession) {
        // Idempotent re-acquire by current holder.
        return active;
      }
      throw new ClassifierLeaseError(
        "lease_held",
        `classifier lease is held by ${active.classifierSession} until ${active.expiresAt}; reclaim via 'rig project --reclaim-classifier' if needed`,
        { holder: active.classifierSession, expiresAt: active.expiresAt },
      );
    }

    const leaseId = ulid();
    const acquiredAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO classifier_leases (
            lease_id, classifier_session, acquired_at, expires_at,
            last_heartbeat, state
          ) VALUES (?, ?, ?, ?, ?, 'active')`
        )
        .run(leaseId, classifierSession, acquiredAt, expiresAt, acquiredAt);

      return this.eventBus.persistWithinTransaction({
        type: "classifier.lease_acquired",
        leaseId,
        classifierSession,
        acquiredAt,
        expiresAt,
      });
    });

    const persisted = txn();
    this.eventBus.notifySubscribers(persisted);
    return this.getByIdOrThrow(leaseId);
  }

  /**
   * Heartbeat from the lease holder. Updates `last_heartbeat` and extends
   * `expires_at` by the TTL (sliding-window TTL semantics).
   */
  heartbeat(leaseId: string, classifierSession: string): ClassifierLease {
    const lease = this.getById(leaseId);
    if (!lease) {
      throw new ClassifierLeaseError("lease_not_found", `lease ${leaseId} not found`);
    }
    if (lease.classifierSession !== classifierSession) {
      throw new ClassifierLeaseError(
        "lease_session_mismatch",
        `lease ${leaseId} is held by ${lease.classifierSession}, not ${classifierSession}`,
      );
    }
    if (lease.state !== "active") {
      throw new ClassifierLeaseError(
        "lease_not_active",
        `lease ${leaseId} is in state ${lease.state}; cannot heartbeat`,
      );
    }

    const now = this.now();
    const lastHeartbeat = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();

    this.db
      .prepare(
        `UPDATE classifier_leases
           SET last_heartbeat = ?, expires_at = ?
         WHERE lease_id = ?`
      )
      .run(lastHeartbeat, expiresAt, leaseId);

    return this.getByIdOrThrow(leaseId);
  }

  /**
   * Evaluate deadness for the currently-active lease. If the lease's
   * heartbeat is stale (now > expires_at) OR the holder is reported dead
   * by `isAlive`, mark the lease expired and emit classifier.lease_expired
   * + classifier.dead. Returns the (now-expired) lease, or null if no
   * active lease exists or it remains alive.
   *
   * Called by: project verb path (before acquire, to clear dead leases),
   * watchdog (periodic sweep), or operator-driven check.
   *
   * Per PRD: this method does NOT reclaim — it only marks expired. The
   * next `acquire` call by ANY session can then succeed (since the partial
   * UNIQUE on state='active' is now empty).
   */
  evaluateDeadness(): ClassifierLease | null {
    const active = this.getActiveLease();
    if (!active) return null;
    const nowIso = this.now().toISOString();
    const ttlPassed = nowIso > active.expiresAt;
    const sessionDead = !this.isAlive(active.classifierSession);
    if (!ttlPassed && !sessionDead) return null;

    const events: PersistedEvent[] = [];
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE classifier_leases SET state = 'expired' WHERE lease_id = ? AND state = 'active'`,
        )
        .run(active.leaseId);

      events.push(this.eventBus.persistWithinTransaction({
        type: "classifier.lease_expired",
        leaseId: active.leaseId,
        classifierSession: active.classifierSession,
        expiredAt: nowIso,
      }));

      if (sessionDead) {
        events.push(this.eventBus.persistWithinTransaction({
          type: "classifier.dead",
          leaseId: active.leaseId,
          classifierSession: active.classifierSession,
          lastHeartbeat: active.lastHeartbeat,
          detectedAt: nowIso,
        }));
      }
    });

    txn();
    for (const e of events) this.eventBus.notifySubscribers(e);
    return this.getByIdOrThrow(active.leaseId);
  }

  /**
   * Operator-verb reclaim. Per PRD § L2 hard rule: ONLY this path may take
   * an active lease away from its holder. Daemon does NOT auto-reclaim.
   *
   * - If `ifDead`: only succeed when isAlive(holder) returns false. If the
   *   holder is alive, refuse with `lease_still_active`.
   * - If `!ifDead`: take the lease unconditionally.
   *
   * Marks the active lease state='reclaimed', records reclaimed_by_session
   * + reclaim_reason, and emits classifier.reclaimed. The next acquire
   * (by ANY session) can then succeed.
   */
  reclaim(byClassifierSession: string, opts?: { ifDead?: boolean; reason?: string }): ClassifierLease {
    const active = this.getActiveLease();
    if (!active) {
      throw new ClassifierLeaseError(
        "no_active_lease",
        "no active classifier lease to reclaim",
      );
    }
    if (opts?.ifDead === true && this.isAlive(active.classifierSession)) {
      throw new ClassifierLeaseError(
        "lease_still_active",
        `classifier lease holder ${active.classifierSession} is still alive; --if-dead refuses to reclaim`,
        { holder: active.classifierSession },
      );
    }
    const reason = opts?.reason ?? (opts?.ifDead ? "operator-reclaim --if-dead" : "operator-reclaim");
    const reclaimedAt = this.now().toISOString();

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE classifier_leases
             SET state = 'reclaimed',
                 reclaimed_by_session = ?,
                 reclaim_reason = ?
           WHERE lease_id = ? AND state = 'active'`,
        )
        .run(byClassifierSession, reason, active.leaseId);

      return this.eventBus.persistWithinTransaction({
        type: "classifier.reclaimed",
        leaseId: active.leaseId,
        previousClassifierSession: active.classifierSession,
        reclaimedBySession: byClassifierSession,
        reason,
        reclaimedAt,
      });
    });

    const persisted = txn();
    this.eventBus.notifySubscribers(persisted);
    return this.getByIdOrThrow(active.leaseId);
  }

  /**
   * Validation hook used by project-classifier: returns the active lease
   * iff the supplied session holds it, else throws. Centralizes the
   * "must hold the lease to project" check.
   */
  requireActiveHolder(classifierSession: string): ClassifierLease {
    const active = this.getActiveLease();
    if (!active) {
      throw new ClassifierLeaseError(
        "no_active_lease",
        "no active classifier lease; call acquire first",
      );
    }
    if (active.classifierSession !== classifierSession) {
      throw new ClassifierLeaseError(
        "lease_held",
        `classifier lease is held by ${active.classifierSession}, not ${classifierSession}`,
        { holder: active.classifierSession },
      );
    }
    if (active.expiresAt < this.now().toISOString()) {
      throw new ClassifierLeaseError(
        "lease_expired",
        `classifier lease for ${classifierSession} expired at ${active.expiresAt}`,
      );
    }
    return active;
  }

  getActiveLease(): ClassifierLease | null {
    const row = this.db
      .prepare(`SELECT * FROM classifier_leases WHERE state = 'active' LIMIT 1`)
      .get() as ClassifierLeaseRow | undefined;
    return row ? this.rowToLease(row) : null;
  }

  getById(leaseId: string): ClassifierLease | null {
    const row = this.db
      .prepare(`SELECT * FROM classifier_leases WHERE lease_id = ?`)
      .get(leaseId) as ClassifierLeaseRow | undefined;
    return row ? this.rowToLease(row) : null;
  }

  list(opts?: { classifierSession?: string; limit?: number }): ClassifierLease[] {
    const limit = opts?.limit ?? 100;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.classifierSession) {
      conditions.push("classifier_session = ?");
      params.push(opts.classifierSession);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM classifier_leases ${where} ORDER BY acquired_at DESC LIMIT ?`)
      .all(...params) as ClassifierLeaseRow[];
    return rows.map((r) => this.rowToLease(r));
  }

  private getByIdOrThrow(leaseId: string): ClassifierLease {
    const lease = this.getById(leaseId);
    if (!lease) {
      throw new ClassifierLeaseError("lease_not_found", `lease ${leaseId} not found after write`);
    }
    return lease;
  }

  private rowToLease(row: ClassifierLeaseRow): ClassifierLease {
    return {
      leaseId: row.lease_id,
      classifierSession: row.classifier_session,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      lastHeartbeat: row.last_heartbeat,
      state: row.state as LeaseState,
      reclaimedBySession: row.reclaimed_by_session,
      reclaimReason: row.reclaim_reason,
    };
  }
}
