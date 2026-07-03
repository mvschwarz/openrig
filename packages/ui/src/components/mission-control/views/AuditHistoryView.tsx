// PL-005 Phase B: read-only audit-history browse view.
//
// Filter UI for 4 dimensions (qitem_id, action_verb, actor_session,
// time range) + paginated result table. Calls GET /api/mission-control/audit.
// Read-only — no verb actions on rows.

import { useState } from "react";
import {
  type AuditQueryFilters,
  useMissionControlAudit,
} from "../hooks/useMissionControlAudit.js";
import { MISSION_CONTROL_VERBS } from "../hooks/useMissionControlAction.js";

function urlParam(name: string): string {
  if (typeof window === "undefined") return "";
  return new URL(window.location.href).searchParams.get(name) ?? "";
}

export function AuditHistoryView() {
  const [qitemId, setQitemId] = useState(() => urlParam("qitem_id") || urlParam("qitem"));
  const [actionVerb, setActionVerb] = useState(() => urlParam("action_verb") || urlParam("verb"));
  const [actorSession, setActorSession] = useState(() => urlParam("actor_session") || urlParam("actor"));
  const [since, setSince] = useState(() => urlParam("since"));
  const [until, setUntil] = useState(() => urlParam("until"));
  const [limit] = useState(50);
  const [beforeIdStack, setBeforeIdStack] = useState<string[]>([]);

  const filters: AuditQueryFilters = {
    qitemId: qitemId || undefined,
    actionVerb: actionVerb || undefined,
    actorSession: actorSession || undefined,
    since: since || undefined,
    until: until || undefined,
    limit,
    beforeId: beforeIdStack[beforeIdStack.length - 1],
  };

  const query = useMissionControlAudit(filters);

  function applyFilters() {
    setBeforeIdStack([]);
  }
  function nextPage() {
    if (query.data?.nextBeforeId) {
      setBeforeIdStack([...beforeIdStack, query.data.nextBeforeId]);
    }
  }
  function prevPage() {
    setBeforeIdStack(beforeIdStack.slice(0, -1));
  }

  return (
    <div data-testid="mc-view-audit-history" className="space-y-3 p-3">
      <header className="space-y-0.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-on-surface-variant">
          audit-history
        </div>
        <h2 className="font-headline text-lg text-on-surface">Audit history</h2>
        <p className="text-xs text-on-surface-variant">
          Browse <code>mission_control_actions</code> by qitem, verb, actor,
          and time range. Read-only.
        </p>
      </header>

      {/* Filters */}
      <div
        data-testid="mc-audit-filters"
        className="grid grid-cols-1 gap-2 border border-outline-variant bg-background p-2 sm:grid-cols-2"
      >
        <input
          type="text"
          data-testid="mc-audit-filter-qitem-id"
          placeholder="qitem_id (exact)"
          value={qitemId}
          onChange={(e) => setQitemId(e.target.value)}
          className="border border-outline-variant px-2 py-1 font-mono text-xs"
        />
        <select
          data-testid="mc-audit-filter-action-verb"
          value={actionVerb}
          onChange={(e) => setActionVerb(e.target.value)}
          className="border border-outline-variant px-2 py-1 font-mono text-xs"
        >
          <option value="">all verbs</option>
          {MISSION_CONTROL_VERBS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <input
          type="text"
          data-testid="mc-audit-filter-actor-session"
          placeholder="actor_session (e.g., operator-alex@kernel)"
          value={actorSession}
          onChange={(e) => setActorSession(e.target.value)}
          className="border border-outline-variant px-2 py-1 font-mono text-xs"
        />
        <div className="flex items-center gap-1">
          <input
            type="datetime-local"
            data-testid="mc-audit-filter-since"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="flex-1 border border-outline-variant px-2 py-1 font-mono text-[11px]"
            title="since"
          />
          <input
            type="datetime-local"
            data-testid="mc-audit-filter-until"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="flex-1 border border-outline-variant px-2 py-1 font-mono text-[11px]"
            title="until"
          />
        </div>
        <button
          type="button"
          data-testid="mc-audit-filter-apply"
          onClick={applyFilters}
          className="border border-on-surface bg-inverse-surface px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-background"
        >
          Apply filters
        </button>
      </div>

      {/* Results */}
      {query.isLoading ? (
        <div data-testid="mc-audit-loading" className="font-mono text-[10px] text-on-surface-variant">
          loading...
        </div>
      ) : query.isError ? (
        <div data-testid="mc-audit-error" className="font-mono text-[11px] text-red-700">
          error: {query.error.message}
        </div>
      ) : query.data?.rows.length === 0 ? (
        <div data-testid="mc-audit-empty" className="font-mono text-[11px] text-on-surface-variant">
          No audit entries match these filters.
        </div>
      ) : (
        <ul data-testid="mc-audit-rows" className="space-y-1">
          {query.data?.rows.map((row) => (
            <li
              key={row.actionId}
              data-testid="mc-audit-row"
              data-action-id={row.actionId}
              className="border border-outline-variant bg-surface-lowest p-2 text-[11px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono uppercase tracking-[0.1em] text-on-surface">
                  {row.actionVerb}
                </span>
                <span className="font-mono text-[10px] text-on-surface-variant">
                  {row.actedAt}
                </span>
              </div>
              <div className="mt-1 text-on-surface">
                qitem: <span className="font-mono">{row.qitemId ?? "—"}</span>
              </div>
              <div className="text-on-surface">
                actor: <span className="font-mono">{row.actorSession}</span>
              </div>
              {row.reason ? (
                <div className="text-on-surface">
                  reason: <span className="italic">{row.reason}</span>
                </div>
              ) : null}
              {row.annotation ? (
                <div className="text-on-surface">
                  annotation: <span className="italic">{row.annotation}</span>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* Pagination */}
      <footer
        data-testid="mc-audit-pagination"
        className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant"
      >
        <button
          type="button"
          data-testid="mc-audit-prev-page"
          onClick={prevPage}
          disabled={beforeIdStack.length === 0}
          className="border border-outline-variant px-2 py-0.5 disabled:opacity-50"
        >
          ← prev
        </button>
        <span>rows: {query.data?.rows.length ?? 0}</span>
        <button
          type="button"
          data-testid="mc-audit-next-page"
          onClick={nextPage}
          disabled={!query.data?.hasMore}
          className="border border-outline-variant px-2 py-0.5 disabled:opacity-50"
        >
          next →
        </button>
      </footer>
    </div>
  );
}
