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
    <SettingsPageShell testId="settings-page-log" title="Log">
      {events.length === 0 ? (
        <EmptyState
          label="LOG IS QUIET"
          description="Activity events from rigs will stream here."
          variant="card"
          testId="settings-log-empty"
        />
      ) : (
        <ul
          data-testid="settings-log-stream"
          className="divide-y divide-outline-variant border border-outline-variant max-h-[60vh] overflow-y-auto"
        >
          {events.slice(0, 100).map((evt) => (
            <li
              key={evt.seq}
              className="px-3 py-2 flex items-baseline gap-3 font-mono text-xs"
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
    </SettingsPageShell>
  );
}
