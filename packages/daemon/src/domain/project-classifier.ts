import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { EventBus } from "./event-bus.js";
import type { ClassifierLeaseManager } from "./classifier-lease-manager.js";

/**
 * Project classifier (PL-004 Phase B; L2 Project / Classifier — write path).
 *
 * Per PRD § L2 + slice IMPL § Guard Checkpoint Focus item 1+2+4:
 * - Lease validation via classifier-lease-manager (single-writer contract).
 * - Idempotency via UNIQUE constraint on stream_item_id (re-projection → 409).
 * - Daemon does NOT enforce taxonomies on classification fields — those are
 *   agent-authoritative per the founder direction. Daemon only owns the
 *   contract (lease + idempotency + reclaim).
 * - Emits project.classified event after the row is committed.
 *
 * Pattern mirrors Phase A's stream-store.ts shape (single class, atomic
 * transactions, persist-event-then-notify). No Hono.
 */

export interface ProjectClassification {
  projectId: string;
  streamItemId: string;
  classificationType: string | null;
  classificationUrgency: string | null;
  classificationMaturity: string | null;
  classificationConfidence: string | null;
  classificationDestination: string | null;
  action: string | null;
  classifierSession: string;
  tsProjected: string;
}

export interface ProjectClassifyInput {
  streamItemId: string;
  classifierSession: string;
  classificationType?: string;
  classificationUrgency?: string;
  classificationMaturity?: string;
  classificationConfidence?: string;
  classificationDestination?: string;
  action?: string;
}

export interface ProjectListOptions {
  classifierSession?: string;
  classificationDestination?: string;
  limit?: number;
}

interface ProjectClassificationRow {
  project_id: string;
  stream_item_id: string;
  classification_type: string | null;
  classification_urgency: string | null;
  classification_maturity: string | null;
  classification_confidence: string | null;
  classification_destination: string | null;
  action: string | null;
  classifier_session: string;
  ts_projected: string;
}

export class ProjectClassifierError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

export class ProjectClassifier {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly leaseManager: ClassifierLeaseManager;
  private readonly now: () => Date;

  constructor(
    db: Database.Database,
    eventBus: EventBus,
    leaseManager: ClassifierLeaseManager,
    opts?: { now?: () => Date },
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.leaseManager = leaseManager;
    this.now = opts?.now ?? (() => new Date());
  }

  /**
   * Project a stream item — agent-authored classification, daemon-enforced
   * idempotency + lease.
   *
   * 1. Verify the caller holds the active lease (delegates to leaseManager).
   * 2. INSERT project_classifications row (UNIQUE on stream_item_id catches
   *    re-projection attempts; we map the constraint violation to a clean
   *    `idempotency_violation` error).
   * 3. Emit project.classified event.
   */
  classify(input: ProjectClassifyInput): ProjectClassification {
    // Step 1: lease check. Throws ClassifierLeaseError on no_active_lease,
    // lease_held by other session, or lease_expired.
    this.leaseManager.requireActiveHolder(input.classifierSession);

    // R1 fix (BLOCKER 1): existence check on stream_item_id. The L1→L2
    // FK in migration 028 is a defense-in-depth safety net, but the SQLite
    // FK violation would surface as an opaque error string. Pre-checking
    // here gives a clean structured error (`unknown_stream_item`) that
    // routes can map to a 400-class status.
    const streamRow = this.db
      .prepare(`SELECT 1 FROM stream_items WHERE stream_item_id = ? LIMIT 1`)
      .get(input.streamItemId) as { 1: number } | undefined;
    if (!streamRow) {
      throw new ProjectClassifierError(
        "unknown_stream_item",
        `stream_item_id ${input.streamItemId} does not exist in stream_items; emit it first via 'rig stream emit' or check the id`,
        { streamItemId: input.streamItemId },
      );
    }

    // Pre-check idempotency for a clean error path (constraint violation
    // would also catch this but the SQLite error message is opaque).
    const existing = this.db
      .prepare(`SELECT * FROM project_classifications WHERE stream_item_id = ?`)
      .get(input.streamItemId) as ProjectClassificationRow | undefined;
    if (existing) {
      throw new ProjectClassifierError(
        "idempotency_violation",
        `stream_item_id ${input.streamItemId} is already projected as project_id ${existing.project_id} by ${existing.classifier_session}`,
        { existingProjectId: existing.project_id, existingClassifier: existing.classifier_session },
      );
    }

    const projectId = ulid();
    const tsProjected = this.now().toISOString();

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO project_classifications (
            project_id, stream_item_id,
            classification_type, classification_urgency, classification_maturity,
            classification_confidence, classification_destination, action,
            classifier_session, ts_projected
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          projectId,
          input.streamItemId,
          input.classificationType ?? null,
          input.classificationUrgency ?? null,
          input.classificationMaturity ?? null,
          input.classificationConfidence ?? null,
          input.classificationDestination ?? null,
          input.action ?? null,
          input.classifierSession,
          tsProjected,
        );

      return this.eventBus.persistWithinTransaction({
        type: "project.classified",
        projectId,
        streamItemId: input.streamItemId,
        classifierSession: input.classifierSession,
        classificationType: input.classificationType ?? null,
        classificationDestination: input.classificationDestination ?? null,
      });
    });

    const persisted = txn();
    this.eventBus.notifySubscribers(persisted);
    return this.getByIdOrThrow(projectId);
  }

  getById(projectId: string): ProjectClassification | null {
    const row = this.db
      .prepare(`SELECT * FROM project_classifications WHERE project_id = ?`)
      .get(projectId) as ProjectClassificationRow | undefined;
    return row ? this.rowToProject(row) : null;
  }

  getByStreamItemId(streamItemId: string): ProjectClassification | null {
    const row = this.db
      .prepare(`SELECT * FROM project_classifications WHERE stream_item_id = ?`)
      .get(streamItemId) as ProjectClassificationRow | undefined;
    return row ? this.rowToProject(row) : null;
  }

  list(opts?: ProjectListOptions): ProjectClassification[] {
    const limit = opts?.limit ?? 100;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.classifierSession) {
      conditions.push("classifier_session = ?");
      params.push(opts.classifierSession);
    }
    if (opts?.classificationDestination) {
      conditions.push("classification_destination = ?");
      params.push(opts.classificationDestination);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM project_classifications ${where} ORDER BY ts_projected DESC LIMIT ?`,
      )
      .all(...params) as ProjectClassificationRow[];
    return rows.map((r) => this.rowToProject(r));
  }

  private getByIdOrThrow(projectId: string): ProjectClassification {
    const p = this.getById(projectId);
    if (!p) {
      throw new ProjectClassifierError(
        "project_not_found",
        `project ${projectId} not found after write`,
      );
    }
    return p;
  }

  private rowToProject(row: ProjectClassificationRow): ProjectClassification {
    return {
      projectId: row.project_id,
      streamItemId: row.stream_item_id,
      classificationType: row.classification_type,
      classificationUrgency: row.classification_urgency,
      classificationMaturity: row.classification_maturity,
      classificationConfidence: row.classification_confidence,
      classificationDestination: row.classification_destination,
      action: row.action,
      classifierSession: row.classifier_session,
      tsProjected: row.ts_projected,
    };
  }
}
