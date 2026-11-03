// Slice 26 — Log destination page (route-driven).
//
// Lifts the LogPanel content that used to live inside SettingsCenter's
// inline tab. Now mounted at /settings/log via its own page.

import { SettingsPageShell } from "./SettingsPageShell.js";
import { EmptyState } from "../ui/empty-state.js";
import { useActivityFeed } from "../../hooks/useActivityFeed.js";
import { formatEventPayload } from "../../lib/format-event-payload.js";

export function LogPage() {
  const { events } = useActivityFeed();
  return (
    <SettingsPageShell
      testId="settings-page-log"
      title="Log"
      description="A live stream of daemon activity events. Newest events appear first."
    >
      {events.length === 0 ? (
        <EmptyState
          label="Log is quiet"
          title="Log is quiet"
          description="Activity events from your rigs will stream here once agents start working."
          variant="card"
          testId="settings-log-empty"
        />
      ) : (
        <ul
          data-testid="settings-log-stream"
          className="divide-y divide-outline-variant rounded-lg border bg-surface-lowest max-h-[60vh] overflow-y-auto"
        >
          {events.slice(0, 100).map((evt) => (
            <li
              key={evt.seq}
              className="px-3 py-2 flex items-baseline gap-3 text-sm"
            >
              <span className="text-xs text-on-surface-variant w-32 shrink-0 truncate font-mono">
                {evt.type}
              </span>
              <span className="text-on-surface truncate" title={formatEventPayload(evt.payload)}>
                {formatEventPayload(evt.payload)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsPageShell>
  );
}
