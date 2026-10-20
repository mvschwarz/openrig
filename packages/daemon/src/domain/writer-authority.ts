import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";

/**
 * Writer authority (OpenRig writer-authority extract).
 *
 * v1 guarantee: OpenRig-mediated publish/integration mutations require a live
 * fenced lease on the protected resource. This is NOT a full FS sandbox —
 * workers may write isolated candidates freely; only protected effects
 * (publish / integrate / transfer of the named resource) are gated here.
 */

export const WRITER_RESOURCE_KINDS = [
  "candidate",
  "integration_branch",
  "publish_target",
] as const;
export type WriterResourceKind = (typeof WRITER_RESOURCE_KINDS)[number];

export const WRITER_LEASE_STATES = ["active", "released", "revoked", "expired", "transferred"] as const;
export type WriterLeaseState = (typeof WRITER_LEASE_STATES)[number];

export interface WriterLease {
  leaseId: string;
  resourceKind: WriterResourceKind;
  resourceId: string;
  holderSession: string;
  generation: number;
  acquiredAt: string;
  expiresAt: string;
  lastRenewedAt: string;
  state: WriterLeaseState;
  revokedBySession: string | null;
  revokeReason: string | null;
  transferredFromSession: string | null;
}

interface WriterLeaseRow {
  lease_id: string;
  resource_kind: string;
  resource_id: string;
  holder_session: string;
  generation: number;
  acquired_at: string;
  expires_at: string;
  last_renewed_at: string;
  state: string;
  revoked_by_session: string | null;
  revoke_reason: string | null;
  transferred_from_session: string | null;
}

export class WriterAuthorityError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface WriterAuthorityOptions {
  ttlMs?: number;
  now?: () => Date;
}

export class WriterAuthority {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(db: Database.Database, eventBus: EventBus, opts?: WriterAuthorityOptions) {
    this.db = db;
    this.eventBus = eventBus;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts?.now ?? (() => new Date());
  }

  acquire(
    resourceKind: WriterResourceKind,
    resourceId: string,
    holderSession: string,
  ): WriterLease {
    this.assertKind(resourceKind);
    if (!resourceId?.trim()) {
      throw new WriterAuthorityError("resource_id_required", "resourceId is required");
    }
    if (!holderSession?.trim()) {
      throw new WriterAuthorityError("holder_required", "holderSession is required");
    }

    const active = this.getActive(resourceKind, resourceId);
    if (active) {
      if (active.holderSession === holderSession) {
        return active; // idempotent re-acquire
      }
      throw new WriterAuthorityError(
        "writer_held",
        `writer on ${resourceKind}:${resourceId} is held by ${active.holderSession} (generation ${active.generation})`,
        {
          holder: active.holderSession,
          generation: active.generation,
          expiresAt: active.expiresAt,
        },
      );
    }

    const leaseId = ulid();
    const acquiredAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();
    const generation = this.nextGeneration(resourceKind, resourceId);

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO writer_authority_leases (
            lease_id, resource_kind, resource_id, holder_session, generation,
            acquired_at, expires_at, last_renewed_at, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        )
        .run(
          leaseId,
          resourceKind,
          resourceId,
          holderSession,
          generation,
          acquiredAt,
          expiresAt,
          acquiredAt,
        );

      return this.eventBus.persistWithinTransaction({
        type: "writer.acquired",
        leaseId,
        resourceKind,
        resourceId,
        holderSession,
        generation,
        acquiredAt,
        expiresAt,
      });
    });

    const persisted = txn();
    this.eventBus.notifySubscribers(persisted);
    return this.getByIdOrThrow(leaseId);
  }

  renew(leaseId: string, holderSession: string): WriterLease {
    const lease = this.requireActiveHolder(leaseId, holderSession);
    const now = this.now();
    const lastRenewedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    this.db
      .prepare(
        `UPDATE writer_authority_leases
           SET last_renewed_at = ?, expires_at = ?
         WHERE lease_id = ? AND state = 'active'`,
      )
      .run(lastRenewedAt, expiresAt, lease.leaseId);
    return this.getByIdOrThrow(lease.leaseId);
  }

  release(leaseId: string, holderSession: string): WriterLease {
    const lease = this.requireActiveHolder(leaseId, holderSession);
    const releasedAt = this.now().toISOString();
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE writer_authority_leases SET state = 'released' WHERE lease_id = ? AND state = 'active'`,
        )
        .run(lease.leaseId);
      return this.eventBus.persistWithinTransaction({
        type: "writer.released",
        leaseId: lease.leaseId,
        resourceKind: lease.resourceKind,
        resourceId: lease.resourceId,
        holderSession,
        generation: lease.generation,
        releasedAt,
      });
    });
    const persisted = txn();
    this.eventBus.notifySubscribers(persisted);
    return this.getByIdOrThrow(lease.leaseId);
  }

  /**
   * Operator/core revoke. Immediately blocks protected mutation for the prior
   * holder (generation fence). Does not kill worker processes.
   */
  revoke(leaseId: string, bySession: string, reason?: string): WriterLease {
    const lease = this.getById(leaseId);
    if (!lease) {
      throw new WriterAuthorityError("lease_not_found", `lease ${leaseId} not found`);
    }
    if (lease.state !== "active") {
      throw new WriterAuthorityError(
        "lease_not_active",
        `lease ${leaseId} is in state ${lease.state}; cannot revoke`,
      );
    }
    const revokeReason = reason ?? "operator-revoke";
    const revokedAt = this.now().toISOString();
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE writer_authority_leases
             SET state = 'revoked', revoked_by_session = ?, revoke_reason = ?
           WHERE lease_id = ? AND state = 'active'`,
        )
        .run(bySession, revokeReason, lease.leaseId);
      return this.eventBus.persistWithinTransaction({
        type: "writer.revoked",
        leaseId: lease.leaseId,
        resourceKind: lease.resourceKind,
        resourceId: lease.resourceId,
        previousHolder: lease.holderSession,
        revokedBySession: bySession,
        generation: lease.generation,
        reason: revokeReason,
        revokedAt,
      });
    });
    const persisted = txn();
    this.eventBus.notifySubscribers(persisted);
    return this.getByIdOrThrow(lease.leaseId);
  }

  /**
   * Atomically hand the active lease to another session with a new generation.
   */
  transfer(leaseId: string, fromSession: string, toSession: string): WriterLease {
    if (!toSession?.trim()) {
      throw new WriterAuthorityError("holder_required", "toSession is required");
    }
    const lease = this.requireActiveHolder(leaseId, fromSession);
    const transferredAt = this.now().toISOString();
    const newLeaseId = ulid();
    const generation = lease.generation + 1;
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();

    const events: PersistedEvent[] = [];
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE writer_authority_leases SET state = 'transferred' WHERE lease_id = ? AND state = 'active'`,
        )
        .run(lease.leaseId);
      this.db
        .prepare(
          `INSERT INTO writer_authority_leases (
            lease_id, resource_kind, resource_id, holder_session, generation,
            acquired_at, expires_at, last_renewed_at, state, transferred_from_session
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          newLeaseId,
          lease.resourceKind,
          lease.resourceId,
          toSession,
          generation,
          transferredAt,
          expiresAt,
          transferredAt,
          fromSession,
        );
      events.push(
        this.eventBus.persistWithinTransaction({
          type: "writer.transferred",
          previousLeaseId: lease.leaseId,
          leaseId: newLeaseId,
          resourceKind: lease.resourceKind,
          resourceId: lease.resourceId,
          fromSession,
          toSession,
          generation,
          transferredAt,
        }),
      );
    });
    txn();
    for (const e of events) this.eventBus.notifySubscribers(e);
    return this.getByIdOrThrow(newLeaseId);
  }

  /**
   * Gate for protected mutation. Caller must present the lease id + generation
   * observed at acquire time; revoke/transfer invalidates both.
   */
  assertHolder(
    resourceKind: WriterResourceKind,
    resourceId: string,
    holderSession: string,
    expectedGeneration: number,
  ): WriterLease {
    const active = this.getActive(resourceKind, resourceId);
    if (!active) {
      throw new WriterAuthorityError(
        "no_active_writer",
        `no active writer on ${resourceKind}:${resourceId}`,
        { resourceKind, resourceId },
      );
    }
    if (active.holderSession !== holderSession) {
      throw new WriterAuthorityError(
        "writer_held",
        `writer on ${resourceKind}:${resourceId} is held by ${active.holderSession}, not ${holderSession}`,
        { holder: active.holderSession, generation: active.generation },
      );
    }
    if (active.generation !== expectedGeneration) {
      throw new WriterAuthorityError(
        "generation_mismatch",
        `writer generation ${expectedGeneration} is stale; current is ${active.generation} (revoked or transferred)`,
        { expectedGeneration, currentGeneration: active.generation },
      );
    }
    if (active.expiresAt < this.now().toISOString()) {
      throw new WriterAuthorityError(
        "lease_expired",
        `writer lease ${active.leaseId} expired at ${active.expiresAt}`,
        { leaseId: active.leaseId },
      );
    }
    return active;
  }

  /**
   * Run a protected mutation only while the fence holds. On revoke between
   * assert and callback, the callback is never invoked.
   */
  withProtectedMutation<T>(
    resourceKind: WriterResourceKind,
    resourceId: string,
    holderSession: string,
    expectedGeneration: number,
    mutate: (lease: WriterLease) => T,
  ): T {
    const lease = this.assertHolder(resourceKind, resourceId, holderSession, expectedGeneration);
    return mutate(lease);
  }

  getActive(resourceKind: WriterResourceKind, resourceId: string): WriterLease | null {
    const row = this.db
      .prepare(
        `SELECT * FROM writer_authority_leases
         WHERE resource_kind = ? AND resource_id = ? AND state = 'active'
         LIMIT 1`,
      )
      .get(resourceKind, resourceId) as WriterLeaseRow | undefined;
    return row ? this.rowToLease(row) : null;
  }

  getById(leaseId: string): WriterLease | null {
    const row = this.db
      .prepare(`SELECT * FROM writer_authority_leases WHERE lease_id = ?`)
      .get(leaseId) as WriterLeaseRow | undefined;
    return row ? this.rowToLease(row) : null;
  }

  private requireActiveHolder(leaseId: string, holderSession: string): WriterLease {
    const lease = this.getById(leaseId);
    if (!lease) {
      throw new WriterAuthorityError("lease_not_found", `lease ${leaseId} not found`);
    }
    if (lease.holderSession !== holderSession) {
      throw new WriterAuthorityError(
        "lease_session_mismatch",
        `lease ${leaseId} is held by ${lease.holderSession}, not ${holderSession}`,
      );
    }
    if (lease.state !== "active") {
      throw new WriterAuthorityError(
        "lease_not_active",
        `lease ${leaseId} is in state ${lease.state}`,
      );
    }
    return lease;
  }

  private nextGeneration(resourceKind: WriterResourceKind, resourceId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(generation) AS max_gen FROM writer_authority_leases
         WHERE resource_kind = ? AND resource_id = ?`,
      )
      .get(resourceKind, resourceId) as { max_gen: number | null } | undefined;
    return (row?.max_gen ?? 0) + 1;
  }

  private assertKind(kind: string): asserts kind is WriterResourceKind {
    if (!(WRITER_RESOURCE_KINDS as readonly string[]).includes(kind)) {
      throw new WriterAuthorityError(
        "invalid_resource_kind",
        `resourceKind must be one of ${WRITER_RESOURCE_KINDS.join(", ")}`,
        { resourceKind: kind },
      );
    }
  }

  private getByIdOrThrow(leaseId: string): WriterLease {
    const lease = this.getById(leaseId);
    if (!lease) {
      throw new WriterAuthorityError("lease_not_found", `lease ${leaseId} not found after write`);
    }
    return lease;
  }

  private rowToLease(row: WriterLeaseRow): WriterLease {
    return {
      leaseId: row.lease_id,
      resourceKind: row.resource_kind as WriterResourceKind,
      resourceId: row.resource_id,
      holderSession: row.holder_session,
      generation: row.generation,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      lastRenewedAt: row.last_renewed_at,
      state: row.state as WriterLeaseState,
      revokedBySession: row.revoked_by_session,
      revokeReason: row.revoke_reason,
      transferredFromSession: row.transferred_from_session,
    };
  }
}
