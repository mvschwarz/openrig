// Slice 09 — daemon-persisted typed primitive (SQLite-backed).
//
// Follows the workspace-primitive precedent: structured table,
// JSON column for the 10-field record (validator owns integrity at
// write time). NO parallel/forked store (HG-5).
//
// The store exposes:
//   - setBinding(scope, qualifier, mode, record)  → upserts a row
//                                                    (mode is binding-level
//                                                    Component-2 identity;
//                                                    record is the frozen
//                                                    10-field Component-3
//                                                    settings)
//   - getBinding(scope, qualifier)                → reads one row
//   - listBindings()                              → all rows (for show)
//   - resolveEffective(readContext)               → most-specific binding
//   - deleteBinding(scope, qualifier)             → unset
//
// Update authority is operator-only: setBinding hard-codes
// `set_by = 'operator'`. The HTTP route + CLI are the only authoring
// surfaces; agent code paths read but never write. (HG-4)
//
// HG-SAFE preserved here: this store NEVER writes to permission
// allowlists / runtime configs / auth / tmux / lifecycle. It writes
// to ONE table (operator_context_mode_bindings) and reads JSON. A
// future contributor cannot widen permission authority via this
// service because the surface area is the bindings table only.

import type Database from "better-sqlite3";
import {
  type EffectiveOperatorContextMode,
  type OperatorContextMode,
  type OperatorContextModeBinding,
  type OperatorContextModeRecord,
  type OperatorContextReadContext,
  type OperatorContextScope,
  SCOPE_SPECIFICITY,
} from "./rig-policy-types.js";
import { validateModeName, validateRecord } from "./rig-policy-validator.js";

interface BindingRow {
  id: string;
  scope: OperatorContextScope;
  qualifier: string | null;
  mode: OperatorContextMode;
  record_json: string;
  set_at: string;
  set_by: string;
}

function rowToBinding(row: BindingRow): OperatorContextModeBinding {
  return {
    id: row.id,
    mode: row.mode,
    record: JSON.parse(row.record_json) as OperatorContextModeRecord,
    qualifier: row.qualifier,
    setAt: row.set_at,
    setBy: "operator",
  };
}

function bindingId(scope: OperatorContextScope, qualifier: string | null): string {
  return `${scope}:${qualifier ?? "host"}`;
}

export interface SetBindingResult {
  ok: true;
  binding: OperatorContextModeBinding;
}

export interface SetBindingError {
  ok: false;
  errors: string[];
}

export interface RigPolicyStoreOpts {
  /** Override the clock for tests; defaults to new Date(). */
  now?: () => Date;
}

export class RigPolicyStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(db: Database.Database, opts?: RigPolicyStoreOpts) {
    this.db = db;
    this.now = opts?.now ?? (() => new Date());
  }

  /**
   * Operator-only set. Validates the candidate record + the
   * scope/qualifier shape, then upserts. Returns the typed binding
   * on success.
   *
   * scope == 'global_host' REQUIRES qualifier === null;
   * scope != 'global_host' REQUIRES a non-empty qualifier string.
   * Both are operator/host invariants — the route validates and
   * the store rejects on disagreement.
   */
  setBinding(
    scope: OperatorContextScope,
    qualifier: string | null,
    mode: unknown,
    candidateRecord: unknown,
  ): SetBindingResult | SetBindingError {
    const errors: string[] = [];
    if (scope === "global_host" && qualifier !== null) {
      errors.push(
        `Global-host bindings cannot carry a qualifier (got ${JSON.stringify(qualifier)}). Pass null for the global_host scope.`,
      );
    }
    if (scope !== "global_host" && (typeof qualifier !== "string" || qualifier.length === 0)) {
      errors.push(
        `${scope} bindings require a qualifier (rigId / workstreamId / qitemId). Got ${JSON.stringify(qualifier)}.`,
      );
    }
    const modeCheck = validateModeName(mode);
    if (!modeCheck.ok) errors.push(modeCheck.error);
    const validation = validateRecord(candidateRecord);
    if (!validation.ok) errors.push(...validation.errors);
    if (errors.length > 0 || !modeCheck.ok || !validation.ok) {
      return { ok: false, errors };
    }

    const record = validation.record;
    if (record.scope !== scope) {
      return {
        ok: false,
        errors: [
          `Record scope mismatch: binding scope is "${scope}" but record.scope is "${record.scope}". The record's scope field MUST agree with the binding scope.`,
        ],
      };
    }

    const id = bindingId(scope, qualifier);
    const setAt = this.now().toISOString();
    this.db.prepare(`
      INSERT INTO operator_context_mode_bindings (id, scope, qualifier, mode, record_json, set_at, set_by)
      VALUES (?, ?, ?, ?, ?, ?, 'operator')
      ON CONFLICT(id) DO UPDATE SET
        mode = excluded.mode,
        record_json = excluded.record_json,
        set_at = excluded.set_at
    `).run(id, scope, qualifier, modeCheck.mode, JSON.stringify(record), setAt);

    return {
      ok: true,
      binding: {
        id,
        mode: modeCheck.mode,
        record,
        qualifier,
        setAt,
        setBy: "operator",
      },
    };
  }

  getBinding(
    scope: OperatorContextScope,
    qualifier: string | null,
  ): OperatorContextModeBinding | null {
    const row = this.db.prepare(`
      SELECT id, scope, qualifier, mode, record_json, set_at, set_by
      FROM operator_context_mode_bindings
      WHERE id = ?
    `).get(bindingId(scope, qualifier)) as BindingRow | undefined;
    return row ? rowToBinding(row) : null;
  }

  listBindings(): OperatorContextModeBinding[] {
    const rows = this.db.prepare(`
      SELECT id, scope, qualifier, mode, record_json, set_at, set_by
      FROM operator_context_mode_bindings
      ORDER BY scope, qualifier NULLS FIRST, id
    `).all() as BindingRow[];
    return rows.map(rowToBinding);
  }

  deleteBinding(scope: OperatorContextScope, qualifier: string | null): boolean {
    const info = this.db.prepare(`
      DELETE FROM operator_context_mode_bindings WHERE id = ?
    `).run(bindingId(scope, qualifier));
    return info.changes > 0;
  }

  /**
   * Resolve the most-specific applicable binding for a read context.
   * Returns null when no binding matches — callers MUST treat null as
   * `unknown_posture` per convention §Q6 (do NOT default to `desk`).
   *
   * Specificity ranks (qitem > workstream > rig > global_host) are
   * defined in rig-policy-types.SCOPE_SPECIFICITY. For each scope the
   * resolver picks the binding whose qualifier matches the read
   * context. Among multiple matching bindings, the most-specific
   * scope wins.
   */
  resolveEffective(ctx: OperatorContextReadContext): EffectiveOperatorContextMode | null {
    const candidates: OperatorContextModeBinding[] = [];
    if (ctx.qitemId) {
      const b = this.getBinding("qitem", ctx.qitemId);
      if (b) candidates.push(b);
    }
    if (ctx.workstreamId) {
      const b = this.getBinding("workstream", ctx.workstreamId);
      if (b) candidates.push(b);
    }
    if (ctx.rigId) {
      const b = this.getBinding("rig", ctx.rigId);
      if (b) candidates.push(b);
    }
    const host = this.getBinding("global_host", null);
    if (host) candidates.push(host);

    if (candidates.length === 0) return null;

    candidates.sort(
      (a, b) => SCOPE_SPECIFICITY[b.record.scope] - SCOPE_SPECIFICITY[a.record.scope],
    );
    const winner = candidates[0]!;
    return {
      binding: winner,
      resolvedScope: winner.record.scope,
    };
  }
}
