// V1 attempt-3 Phase 3 — Recent Activity per dashboard.md L88–L91 + SC-14.
//
// Compact one-column list of most recent system activity (shipped slices,
// completed reviews, etc.). Reuses ActivityFeed event source.

import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { useActivityFeed } from "../../hooks/useActivityFeed.js";
import { formatEventPayload } from "../../lib/format-event-payload.js";

const MAX_ITEMS = 10;

export function RecentActivity() {
  const { events } = useActivityFeed();
  const items = events.slice(0, MAX_ITEMS);

  return (
    <section data-testid="dashboard-recent-activity" className="mt-8">
      <SectionHeader tone="muted">Recent activity</SectionHeader>
      <div className="mt-2 border-t border-outline-variant">
        {items.length === 0 ? (
          <div className="py-6">
            <EmptyState
              label="NO ACTIVITY"
              description="Activity from rigs in flight will appear here."
              variant="minimal"
              testId="recent-activity-empty"
            />
          </div>
        ) : (
          <ul className="divide-y divide-outline-variant">
            {items.map((evt) => (
              <li
                key={evt.seq}
                data-testid="recent-activity-item"
                className="py-2 flex items-baseline gap-3 font-mono text-xs"
              >
                <span className="text-on-surface-variant text-[10px] uppercase tracking-wide w-32 shrink-0 truncate">
                  {evt.type}
                </span>
                <span className="text-stone-900 truncate" title={formatEventPayload(evt.payload)}>
                  {formatEventPayload(evt.payload)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
