// PL-005 Phase A: shared list view used by 4 of the 7 views.
// MyQueueView, HumanGateView, ActiveWorkView, RecentShipsView,
// RecentlyActiveView, RecentObservationsView all render a list of
// CompactStatusRow with optional verb actions.

import { CompactStatusRow } from "../components/CompactStatusRow.js";
import { VerbActions } from "../components/VerbActions.js";
import {
  type MissionControlViewName,
  useMissionControlView,
} from "../hooks/useMissionControlView.js";
import type { MissionControlVerb } from "../hooks/useMissionControlAction.js";

export interface GenericListViewProps {
  viewName: MissionControlViewName;
  operatorSession?: string;
  /** Optional restriction on which verbs are offered per row. */
  enabledVerbs?: MissionControlVerb[];
  /** Optional empty-state message. */
  emptyMessage?: string;
  /** Header label. */
  title: string;
  /** Optional subtitle / description. */
  subtitle?: string;
  /** Show row-level verb actions. Default true for actionable views,
   * false for read-only views (recent-ships, recently-active, etc.). */
  withVerbActions?: boolean;
}

export function GenericListView({
  viewName,
  operatorSession,
  enabledVerbs,
  emptyMessage = "Nothing here right now.",
  title,
  subtitle,
  withVerbActions = false,
}: GenericListViewProps) {
  const query = useMissionControlView(viewName, { operatorSession });
  const actorSession = operatorSession ?? "human-wrandom@kernel";

  return (
    <div data-testid={`mc-view-${viewName}`} className="space-y-3 p-3">
      <header className="space-y-0.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-500">
          {viewName}
        </div>
        <h2 className="font-headline text-lg text-stone-900">{title}</h2>
        {subtitle ? <p className="text-xs text-stone-600">{subtitle}</p> : null}
      </header>
      {query.isLoading ? (
        <div data-testid="mc-view-loading" className="font-mono text-[10px] text-stone-500">
          loading...
        </div>
      ) : query.isError ? (
        <div data-testid="mc-view-error" className="font-mono text-[11px] text-red-700">
          error: {query.error.message}
        </div>
      ) : query.data?.rows.length === 0 ? (
        <div data-testid="mc-view-empty" className="font-mono text-[11px] text-stone-500">
          {emptyMessage}
        </div>
      ) : (
        <ul data-testid="mc-view-rows" className="space-y-1.5">
          {query.data?.rows.map((row, idx) => (
            <li key={row.qitemId ?? `${viewName}-${idx}`} className="space-y-1">
              <CompactStatusRow row={row} density="expanded" />
              {withVerbActions && row.qitemId ? (
                <VerbActions
                  qitemId={row.qitemId}
                  actorSession={actorSession}
                  enabledVerbs={enabledVerbs}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {query.data?.meta ? (
        <footer
          data-testid="mc-view-meta"
          className="font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500"
        >
          rows: {query.data.meta.rowCount}
        </footer>
      ) : null}
    </div>
  );
}
