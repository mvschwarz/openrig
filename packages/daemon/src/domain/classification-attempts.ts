import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { ClassifierLeaseManager } from "./classifier-lease-manager.js";

/**
 * Classification attempt ledger (0.6.0 S02 P1).
 *
 * Holds everything a classifier occupant must remember that does NOT belong in
 * the immutable `project_classifications` row: in-flight work, abstentions and
 * errors. It is a ledger, not a scheduler — the occupant is woken by the
 * existing watchdog/wake cadence and asks `eligible()` what to do next.
 *
 * Identity: (stream_item_id, classifier_version, taxonomy_version, evidence_epoch).
 * - abstained: terminal for that identity only. A new classifier/taxonomy
 *   version or an owner-authorized evidence epoch is a new identity.
 * - error / abandoned in_flight: retried after a bounded, doubling delay until
 *   the retry budget is spent, then `exhausted` (terminal, visible).
 * - written: set by ProjectClassifier in the same transaction as the row.
 *
 * Every state change validates the lease (active, same session, same lease id,
 * not expired) inside its write transaction.
 *
 * Execution fence: each begin — first try, timeout reissue or error retry —
 * mints a new executionId. abstain / fail / the classify attempt binding must
 * present the CURRENT executionId; an older execution is refused
 * (`attempt_superseded`) without touching the current one. A lease can be
 * renewed indefinitely, so lease validity never proves an older execution is
 * dead; only the fence does.
 */

export const ATTEMPT_STATUSES = ["in_flight", "abstained", "written", "error", "exhausted"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
const TERMINAL: readonly AttemptStatus[] = ["abstained", "written", "exhausted"];

/**
 * Retry defaults, chosen against the existing cadence rather than a new
 * scheduler:
 * - budget 3 attempts per identity: one try plus two retries is enough to ride
 *   out a transient provider or daemon blip without looping on a poison item;
 * - backoff 5 min, doubling, capped at 60 min: coarser than the occupant's own
 *   wake so a failing item never spins, and bounded so a recovered provider is
 *   retried within the hour;
 * - in-flight timeout 15 min: after this long without a finish, the attempt
 *   may be reissued as a new execution (a crash is the common cause). This is
 *   NOT proof the older execution is dead — leases are renewable — which is why
 *   the reissue mints a new executionId and the old one can no longer finish.
 *   Reissues count against the budget.
 * All are constructor options; tests inject time instead of sleeping.
 */
export const DEFAULT_RETRY_BUDGET = 3;
export const DEFAULT_BASE_BACKOFF_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1000;
export const DEFAULT_IN_FLIGHT_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_ELIGIBLE_PAGE = 100;

export interface AttemptIdentity {
  streamItemId: string;
  classifierVersion: string;
  taxonomyVersion: string;
  /** Owner-authorized retry epoch bound to changed evidence; "0" when unused. */
  evidenceEpoch: string;
}

export interface ClassificationAttempt extends AttemptIdentity {
  attemptId: string;
  /** Current execution; only this value may finish the attempt. */
  executionId: string;
  status: AttemptStatus;
  attemptCount: number;
  leaseId: string;
  classifierSession: string;
  retryAfter: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EligibleItem {
  streamItemId: string;
  tsEmitted: string;
  streamSortKey: string;
  sourceSession: string;
}

export interface EligiblePage {
  items: EligibleItem[];
  /** Pass as `afterSortKey` to read the next page of THIS pass; null when done. */
  nextAfterSortKey: string | null;
}

interface AttemptRow {
  attempt_id: string;
  stream_item_id: string;
  classifier_version: string;
  taxonomy_version: string;
  evidence_epoch: string;
  status: string;
  attempt_count: number;
  execution_id: string;
  lease_id: string;
  classifier_session: string;
  retry_after: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export class ClassificationAttemptError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

export interface ClassificationAttemptLedgerOptions {
  now?: () => Date;
  retryBudget?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  inFlightTimeoutMs?: number;
}

export class ClassificationAttemptLedger {
  readonly db: Database.Database;
  private readonly leaseManager: ClassifierLeaseManager;
  private readonly now: () => Date;
  private readonly retryBudget: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly inFlightTimeoutMs: number;

  constructor(db: Database.Database, leaseManager: ClassifierLeaseManager, opts?: ClassificationAttemptLedgerOptions) {
    this.db = db;
    this.leaseManager = leaseManager;
    this.now = opts?.now ?? (() => new Date());
    this.retryBudget = opts?.retryBudget ?? DEFAULT_RETRY_BUDGET;
    this.baseBackoffMs = opts?.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = opts?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.inFlightTimeoutMs = opts?.inFlightTimeoutMs ?? DEFAULT_IN_FLIGHT_TIMEOUT_MS;
  }

  /**
   * Start (or legitimately resume) an attempt for one identity under the
   * caller's lease. Refuses terminal identities, fresh in-flight attempts and
   * errors that are not yet due. An in-flight attempt older than the in-flight
   * timeout, or owned by a replaced lease, counts as an abandoned crash.
   */
  begin(input: AttemptIdentity & { leaseId: string; classifierSession: string }): ClassificationAttempt {
    requireIdentity(input);
    requireStringFields(input, ["leaseId", "classifierSession"]);
    const txn = this.db.transaction((): { attemptId: string; exhausted: boolean } => {
      this.leaseManager.requireActiveHolder(input.classifierSession, input.leaseId);
      const stream = this.db
        .prepare(`SELECT 1 FROM stream_items WHERE stream_item_id = ?`)
        .get(input.streamItemId);
      if (!stream) {
        throw new ClassificationAttemptError("unknown_stream_item", `stream_item_id ${input.streamItemId} does not exist`, {
          streamItemId: input.streamItemId,
        });
      }
      const classified = this.db
        .prepare(`SELECT project_id FROM project_classifications WHERE stream_item_id = ?`)
        .get(input.streamItemId) as { project_id: string } | undefined;
      if (classified) {
        throw new ClassificationAttemptError("already_classified", `stream_item_id ${input.streamItemId} is already classified`, {
          existingProjectId: classified.project_id,
        });
      }

      const nowIso = this.now().toISOString();
      const existing = this.findRow(input);
      if (!existing) {
        const attemptId = ulid();
        this.db
          .prepare(
            `INSERT INTO classification_attempts (
              attempt_id, stream_item_id, classifier_version, taxonomy_version, evidence_epoch,
              status, attempt_count, execution_id, lease_id, classifier_session, retry_after, reason, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'in_flight', 1, ?, ?, ?, NULL, NULL, ?, ?)`,
          )
          .run(
            attemptId, input.streamItemId, input.classifierVersion, input.taxonomyVersion, input.evidenceEpoch,
            ulid(), input.leaseId, input.classifierSession, nowIso, nowIso,
          );
        return { attemptId, exhausted: false };
      }

      const status = existing.status as AttemptStatus;
      if (TERMINAL.includes(status)) {
        throw new ClassificationAttemptError("attempt_terminal", `attempt for this identity is ${status}`, {
          attemptId: existing.attempt_id,
          status,
        });
      }
      if (status === "in_flight") {
        const abandoned =
          existing.lease_id !== input.leaseId ||
          Date.parse(existing.updated_at) + this.inFlightTimeoutMs <= this.now().getTime();
        if (!abandoned) {
          throw new ClassificationAttemptError("attempt_in_flight", "an attempt for this identity is already in flight", {
            attemptId: existing.attempt_id,
          });
        }
      }
      if (status === "error" && existing.retry_after !== null && existing.retry_after > nowIso) {
        throw new ClassificationAttemptError("attempt_not_due", `retry is not due until ${existing.retry_after}`, {
          attemptId: existing.attempt_id,
          retryAfter: existing.retry_after,
        });
      }
      if (existing.attempt_count >= this.retryBudget) {
        this.db
          .prepare(
            `UPDATE classification_attempts
               SET status = 'exhausted', retry_after = NULL, updated_at = ?,
                   reason = COALESCE(reason, 'retry budget spent')
             WHERE attempt_id = ?`,
          )
          .run(nowIso, existing.attempt_id);
        // Commit the terminal transition; the refusal is raised after commit.
        return { attemptId: existing.attempt_id, exhausted: true };
      }
      this.db
        .prepare(
          `UPDATE classification_attempts
             SET status = 'in_flight', attempt_count = attempt_count + 1, execution_id = ?,
                 lease_id = ?, classifier_session = ?, retry_after = NULL, updated_at = ?
           WHERE attempt_id = ?`,
        )
        .run(ulid(), input.leaseId, input.classifierSession, nowIso, existing.attempt_id);
      return { attemptId: existing.attempt_id, exhausted: false };
    });
    const result = txn();
    if (result.exhausted) {
      throw new ClassificationAttemptError("attempt_exhausted", `retry budget of ${this.retryBudget} is spent`, {
        attemptId: result.attemptId,
      });
    }
    return this.getByIdOrThrow(result.attemptId);
  }

  /** Terminal abstention for this identity (below threshold / INDETERMINATE). */
  abstain(input: FinishInput): ClassificationAttempt {
    return this.finish(input, (row, nowIso) => {
      this.db
        .prepare(`UPDATE classification_attempts SET status = 'abstained', reason = ?, retry_after = NULL, updated_at = ? WHERE attempt_id = ?`)
        .run(input.reason, nowIso, row.attempt_id);
    });
  }

  /** Transient failure: schedule a bounded retry, or exhaust the budget. */
  fail(input: FinishInput): ClassificationAttempt {
    return this.finish(input, (row, nowIso) => {
      if (row.attempt_count >= this.retryBudget) {
        this.db
          .prepare(`UPDATE classification_attempts SET status = 'exhausted', reason = ?, retry_after = NULL, updated_at = ? WHERE attempt_id = ?`)
          .run(input.reason, nowIso, row.attempt_id);
        return;
      }
      const retryAfter = new Date(this.now().getTime() + this.backoffMs(row.attempt_count)).toISOString();
      this.db
        .prepare(`UPDATE classification_attempts SET status = 'error', reason = ?, retry_after = ?, updated_at = ? WHERE attempt_id = ?`)
        .run(input.reason, retryAfter, nowIso, row.attempt_id);
    });
  }

  /**
   * One bounded page of items the occupant may attempt now for the given
   * versions and epoch, in stream order. Derived by anti-join every call, so a
   * later-due retry reappears on the next pass without any stored cursor
   * skipping it. `afterSortKey` pages within a single pass only.
   */
  eligible(opts: {
    classifierVersion: string;
    taxonomyVersion: string;
    evidenceEpoch: string;
    limit?: number;
    afterSortKey?: string;
  }): EligiblePage {
    requireIdentity({ streamItemId: "-", ...opts });
    const limit = Math.max(1, Math.min(opts.limit ?? MAX_ELIGIBLE_PAGE, MAX_ELIGIBLE_PAGE));
    const nowIso = this.now().toISOString();
    const inFlightCutoff = new Date(this.now().getTime() - this.inFlightTimeoutMs).toISOString();
    const params: unknown[] = [
      opts.classifierVersion, opts.taxonomyVersion, opts.evidenceEpoch, nowIso, inFlightCutoff,
    ];
    let cursorClause = "";
    if (opts.afterSortKey) {
      const cursor = this.db
        .prepare(`SELECT ts_emitted, stream_sort_key FROM stream_items WHERE stream_sort_key = ?`)
        .get(opts.afterSortKey) as { ts_emitted: string; stream_sort_key: string } | undefined;
      if (!cursor) {
        throw new ClassificationAttemptError("unknown_cursor", `afterSortKey ${opts.afterSortKey} is not a stream sort key`);
      }
      cursorClause = "AND (s.ts_emitted, s.stream_sort_key) > (?, ?)";
      params.push(cursor.ts_emitted, cursor.stream_sort_key);
    }
    params.push(limit + 1);
    const rows = this.db
      .prepare(
        `SELECT s.stream_item_id, s.ts_emitted, s.stream_sort_key, s.source_session
           FROM stream_items s
           LEFT JOIN project_classifications p ON p.stream_item_id = s.stream_item_id
           LEFT JOIN classification_attempts a
             ON a.stream_item_id = s.stream_item_id
            AND a.classifier_version = ? AND a.taxonomy_version = ? AND a.evidence_epoch = ?
          WHERE s.archived_at IS NULL
            AND p.stream_item_id IS NULL
            AND (
              a.attempt_id IS NULL
              OR (a.status = 'error' AND (a.retry_after IS NULL OR a.retry_after <= ?))
              OR (a.status = 'in_flight' AND a.updated_at <= ?)
            )
            ${cursorClause}
          ORDER BY s.ts_emitted, s.stream_sort_key
          LIMIT ?`,
      )
      .all(...params) as Array<{ stream_item_id: string; ts_emitted: string; stream_sort_key: string; source_session: string }>;
    const more = rows.length > limit;
    const page = rows.slice(0, limit).map((r) => ({
      streamItemId: r.stream_item_id,
      tsEmitted: r.ts_emitted,
      streamSortKey: r.stream_sort_key,
      sourceSession: r.source_session,
    }));
    return { items: page, nextAfterSortKey: more ? page[page.length - 1]!.streamSortKey : null };
  }

  getById(attemptId: string): ClassificationAttempt | null {
    const row = this.db.prepare(`SELECT * FROM classification_attempts WHERE attempt_id = ?`).get(attemptId) as
      | AttemptRow
      | undefined;
    return row ? rowToAttempt(row) : null;
  }

  private finish(input: FinishInput, apply: (row: AttemptRow, nowIso: string) => void): ClassificationAttempt {
    requireStringFields(input, ["attemptId", "executionId", "leaseId", "classifierSession", "reason"]);
    const txn = this.db.transaction(() => {
      this.leaseManager.requireActiveHolder(input.classifierSession, input.leaseId);
      const row = this.db.prepare(`SELECT * FROM classification_attempts WHERE attempt_id = ?`).get(input.attemptId) as
        | AttemptRow
        | undefined;
      if (!row) throw new ClassificationAttemptError("attempt_not_found", `attempt ${input.attemptId} not found`);
      if (row.execution_id !== input.executionId) {
        throw new ClassificationAttemptError("attempt_superseded", "this execution was superseded by a newer execution of the attempt", {
          attemptId: row.attempt_id,
        });
      }
      if (row.status !== "in_flight" || row.lease_id !== input.leaseId) {
        throw new ClassificationAttemptError("attempt_mismatch", "attempt is not in flight under this lease", {
          attemptId: row.attempt_id,
          status: row.status,
          attemptLeaseId: row.lease_id,
        });
      }
      apply(row, this.now().toISOString());
    });
    txn();
    return this.getByIdOrThrow(input.attemptId);
  }

  private backoffMs(attemptCount: number): number {
    return Math.min(this.baseBackoffMs * 2 ** Math.max(0, attemptCount - 1), this.maxBackoffMs);
  }

  private findRow(id: AttemptIdentity): AttemptRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM classification_attempts
          WHERE stream_item_id = ? AND classifier_version = ? AND taxonomy_version = ? AND evidence_epoch = ?`,
      )
      .get(id.streamItemId, id.classifierVersion, id.taxonomyVersion, id.evidenceEpoch) as AttemptRow | undefined;
  }

  private getByIdOrThrow(attemptId: string): ClassificationAttempt {
    const a = this.getById(attemptId);
    if (!a) throw new ClassificationAttemptError("attempt_not_found", `attempt ${attemptId} not found after write`);
    return a;
  }
}

export interface FinishInput {
  attemptId: string;
  /** The executionId returned by the begin() that started THIS execution. */
  executionId: string;
  leaseId: string;
  classifierSession: string;
  reason: string;
}

/** Shape check for code-consumed string fields: present, a string, not blank. */
function requireStringFields(input: object, fields: readonly string[]): void {
  for (const field of fields) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new ClassificationAttemptError("invalid_field", `${field} must be a non-empty string`, { field });
    }
  }
}

function requireIdentity(id: AttemptIdentity): void {
  for (const key of ["streamItemId", "classifierVersion", "taxonomyVersion", "evidenceEpoch"] as const) {
    if (typeof id[key] !== "string" || id[key].trim() === "") {
      throw new ClassificationAttemptError("invalid_attempt_identity", `${key} is required`, { field: key });
    }
  }
}

function rowToAttempt(row: AttemptRow): ClassificationAttempt {
  return {
    attemptId: row.attempt_id,
    streamItemId: row.stream_item_id,
    classifierVersion: row.classifier_version,
    taxonomyVersion: row.taxonomy_version,
    evidenceEpoch: row.evidence_epoch,
    status: row.status as AttemptStatus,
    attemptCount: row.attempt_count,
    executionId: row.execution_id,
    leaseId: row.lease_id,
    classifierSession: row.classifier_session,
    retryAfter: row.retry_after,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
