import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { EventBus } from "./event-bus.js";

/**
 * View projector (PL-004 Phase B; L5 View — read-only projections).
 *
 * Per PRD § L5 + slice IMPL § Guard Checkpoint Focus item 5+6:
 * - 6 built-in views over Phase A's queue_items + queue_transitions tables.
 * - Custom view registration via views_custom table.
 * - Read-only over Phase A state + Phase B state. NO writes to queue_items
 *   or queue_transitions from this module.
 * - Sub-100 ms latency target (per PRD § Acceptance Criteria); achieved by
 *   leaning on Phase A's existing indexes.
 * - Fixture rig exclusion default: rig names matching `^test-` or `^fixture-`
 *   are excluded; opt-in via OPENRIG_VIEW_INCLUDE_FIXTURES=1.
 *
 * Custom views in views_custom store a SQL string (`definition`) that the
 * projector executes verbatim. Operator-defined; no taxonomy enforced.
 *
 * Pattern mirrors Phase A's queue-repository.ts read-API shape.
 */

export const BUILT_IN_VIEW_NAMES = [
  "recently-active",
  "founder",
  "pod-load",
  "escalations",
  "held",
  "activity",
] as const;

export type BuiltInViewName = (typeof BUILT_IN_VIEW_NAMES)[number];

export interface ViewQueryResult {
  viewName: string;
  generatedAt: string;
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface CustomView {
  viewId: string;
  viewName: string;
  definition: string;
  registeredBySession: string;
  registeredAt: string;
  lastEvaluatedAt: string | null;
}

interface CustomViewRow {
  view_id: string;
  view_name: string;
  definition: string;
  registered_by_session: string;
  registered_at: string;
  last_evaluated_at: string | null;
}

export class ViewProjectorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Detect fixture rigs by session name suffix `@<rig>` where <rig> starts
 * with `test-` or `fixture-`. Used to filter views by default; opt-in via
 * OPENRIG_VIEW_INCLUDE_FIXTURES=1.
 */
function fixtureExclusionClause(): string {
  if (process.env.OPENRIG_VIEW_INCLUDE_FIXTURES === "1") return "1=1";
  // Exclude qitems whose source_session OR destination_session has a rig
  // name starting with test- or fixture-.
  return `(
    destination_session NOT LIKE '%@test-%' AND
    destination_session NOT LIKE '%@fixture-%' AND
    source_session NOT LIKE '%@test-%' AND
    source_session NOT LIKE '%@fixture-%'
  )`;
}

export class ViewProjector {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly now: () => Date;

  constructor(
    db: Database.Database,
    eventBus: EventBus,
    opts?: { now?: () => Date },
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.now = opts?.now ?? (() => new Date());
  }

  /**
   * Run a view by name. Built-in names (BUILT_IN_VIEW_NAMES) dispatch to
   * hardcoded SQL; other names dispatch to custom-view lookup.
   */
  show(viewName: string, opts?: { rig?: string; limit?: number }): ViewQueryResult {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
    if ((BUILT_IN_VIEW_NAMES as readonly string[]).includes(viewName)) {
      return this.runBuiltIn(viewName as BuiltInViewName, opts?.rig, limit);
    }
    const custom = this.getCustomView(viewName);
    if (!custom) {
      throw new ViewProjectorError("view_not_found", `view '${viewName}' is not registered (built-in or custom)`);
    }
    return this.runCustom(custom, limit);
  }

  list(): { builtIn: BuiltInViewName[]; custom: CustomView[] } {
    return { builtIn: [...BUILT_IN_VIEW_NAMES], custom: this.listCustomViews() };
  }

  private runBuiltIn(name: BuiltInViewName, rig: string | undefined, limit: number): ViewQueryResult {
    const fixtureClause = fixtureExclusionClause();
    const rigClause = rig ? `AND (destination_session LIKE ? OR source_session LIKE ?)` : "";
    const rigParams: unknown[] = rig ? [`%@${rig}`, `%@${rig}`] : [];

    let sql: string;
    let params: unknown[] = [];
    switch (name) {
      case "recently-active":
        // qitems by ts_updated DESC; live states (pending/in-progress/blocked).
        sql = `
          SELECT qitem_id, source_session, destination_session, state, priority, tier, ts_updated, body
          FROM queue_items
          WHERE state IN ('pending', 'in-progress', 'blocked')
            AND ${fixtureClause}
            ${rigClause}
          ORDER BY ts_updated DESC
          LIMIT ?
        `;
        params = [...rigParams, limit];
        break;
      case "founder":
        // priority='critical' OR tier='critical' OR tier='fast'.
        sql = `
          SELECT qitem_id, source_session, destination_session, state, priority, tier, ts_updated
          FROM queue_items
          WHERE (priority = 'critical' OR tier IN ('critical', 'fast'))
            AND state IN ('pending', 'in-progress', 'blocked')
            AND ${fixtureClause}
            ${rigClause}
          ORDER BY ts_updated DESC
          LIMIT ?
        `;
        params = [...rigParams, limit];
        break;
      case "pod-load":
        // Per-destination qitem counts (active states only).
        sql = `
          SELECT destination_session AS pod, COUNT(*) AS active_count
          FROM queue_items
          WHERE state IN ('pending', 'in-progress', 'blocked')
            AND ${fixtureClause}
            ${rigClause}
          GROUP BY destination_session
          ORDER BY active_count DESC
          LIMIT ?
        `;
        params = [...rigParams, limit];
        break;
      case "escalations":
        // closure_reason = 'escalation' OR transition note matches.
        sql = `
          SELECT qitem_id, source_session, destination_session, state, closure_reason, closure_target, ts_updated
          FROM queue_items
          WHERE closure_reason = 'escalation'
            AND ${fixtureClause}
            ${rigClause}
          ORDER BY ts_updated DESC
          LIMIT ?
        `;
        params = [...rigParams, limit];
        break;
      case "held":
        // state = 'blocked' OR blocked_on is non-null.
        sql = `
          SELECT qitem_id, source_session, destination_session, state, blocked_on, ts_updated, body
          FROM queue_items
          WHERE (state = 'blocked' OR blocked_on IS NOT NULL)
            AND ${fixtureClause}
            ${rigClause}
          ORDER BY ts_updated DESC
          LIMIT ?
        `;
        params = [...rigParams, limit];
        break;
      case "activity": {
        // Recent transitions joined with qitem state. Fixture-clause must
        // reference queue_items columns, so use the prefixed clause.
        const fixtureClauseQI = fixtureClause === "1=1"
          ? "1=1"
          : `(
              q.destination_session NOT LIKE '%@test-%' AND
              q.destination_session NOT LIKE '%@fixture-%' AND
              q.source_session NOT LIKE '%@test-%' AND
              q.source_session NOT LIKE '%@fixture-%'
            )`;
        const rigClauseQI = rig
          ? `AND (q.destination_session LIKE ? OR q.source_session LIKE ?)`
          : "";
        sql = `
          SELECT t.transition_id, t.qitem_id, t.ts, t.state, t.actor_session, t.transition_note,
                 q.destination_session, q.source_session
          FROM queue_transitions t
          JOIN queue_items q ON t.qitem_id = q.qitem_id
          WHERE ${fixtureClauseQI}
            ${rigClauseQI}
          ORDER BY t.ts DESC
          LIMIT ?
        `;
        params = [...rigParams, limit];
        break;
      }
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return {
      viewName: name,
      generatedAt: this.now().toISOString(),
      rows,
      rowCount: rows.length,
    };
  }

  private runCustom(view: CustomView, limit: number): ViewQueryResult {
    // Custom view definitions are operator-supplied SQL. Append LIMIT if
    // the operator's SQL does not already include one. We do not parse SQL;
    // operators are responsible for the definition's correctness.
    const sql = view.definition.toLowerCase().includes("limit")
      ? view.definition
      : `${view.definition.trim().replace(/;$/, "")} LIMIT ${limit}`;
    let rows: Record<string, unknown>[];
    try {
      rows = this.db.prepare(sql).all() as Record<string, unknown>[];
    } catch (err) {
      throw new ViewProjectorError(
        "view_query_failed",
        `custom view '${view.viewName}' query failed: ${(err as Error).message}`,
      );
    }
    // Touch last_evaluated_at (best-effort; not transactional).
    this.db
      .prepare(`UPDATE views_custom SET last_evaluated_at = ? WHERE view_id = ?`)
      .run(this.now().toISOString(), view.viewId);
    return {
      viewName: view.viewName,
      generatedAt: this.now().toISOString(),
      rows,
      rowCount: rows.length,
    };
  }

  /**
   * Register a custom view. UNIQUE on view_name; re-registration of the
   * same name updates the definition (operator-friendly: edit views.yaml,
   * re-register, get the new query).
   */
  registerCustomView(input: {
    viewName: string;
    definition: string;
    registeredBySession: string;
  }): CustomView {
    if ((BUILT_IN_VIEW_NAMES as readonly string[]).includes(input.viewName)) {
      throw new ViewProjectorError(
        "view_name_reserved",
        `view name '${input.viewName}' is a reserved built-in name; choose a different name`,
      );
    }
    const existing = this.db
      .prepare(`SELECT * FROM views_custom WHERE view_name = ?`)
      .get(input.viewName) as CustomViewRow | undefined;
    const registeredAt = this.now().toISOString();
    if (existing) {
      this.db
        .prepare(
          `UPDATE views_custom
             SET definition = ?, registered_by_session = ?, registered_at = ?
           WHERE view_id = ?`,
        )
        .run(input.definition, input.registeredBySession, registeredAt, existing.view_id);
      return this.getCustomViewByIdOrThrow(existing.view_id);
    }
    const viewId = ulid();
    this.db
      .prepare(
        `INSERT INTO views_custom (
          view_id, view_name, definition, registered_by_session, registered_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(viewId, input.viewName, input.definition, input.registeredBySession, registeredAt);
    return this.getCustomViewByIdOrThrow(viewId);
  }

  getCustomView(viewName: string): CustomView | null {
    const row = this.db
      .prepare(`SELECT * FROM views_custom WHERE view_name = ?`)
      .get(viewName) as CustomViewRow | undefined;
    return row ? this.rowToCustomView(row) : null;
  }

  listCustomViews(): CustomView[] {
    const rows = this.db
      .prepare(`SELECT * FROM views_custom ORDER BY view_name ASC`)
      .all() as CustomViewRow[];
    return rows.map((r) => this.rowToCustomView(r));
  }

  /**
   * Used by routes/views.ts to emit view.changed when underlying state
   * changes. Phase B does not auto-evaluate; callers (route SSE handlers)
   * subscribe to event-bus events and trigger this notify.
   */
  notifyViewChanged(viewName: string, cause: string): void {
    const persisted = this.eventBus.persistWithinTransaction({
      type: "view.changed",
      viewName,
      cause,
    });
    this.eventBus.notifySubscribers(persisted);
  }

  private getCustomViewByIdOrThrow(viewId: string): CustomView {
    const row = this.db
      .prepare(`SELECT * FROM views_custom WHERE view_id = ?`)
      .get(viewId) as CustomViewRow | undefined;
    if (!row) {
      throw new ViewProjectorError("view_not_found", `custom view ${viewId} not found after write`);
    }
    return this.rowToCustomView(row);
  }

  private rowToCustomView(row: CustomViewRow): CustomView {
    return {
      viewId: row.view_id,
      viewName: row.view_name,
      definition: row.definition,
      registeredBySession: row.registered_by_session,
      registeredAt: row.registered_at,
      lastEvaluatedAt: row.last_evaluated_at,
    };
  }
}
