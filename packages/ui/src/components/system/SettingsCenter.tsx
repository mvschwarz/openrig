// V1 attempt-3 Phase 3 — Settings destination as 3-tab CENTER workspace
// per universal-shell.md L133–L135 (SC-7) + dashboard.md.
//
// Tabs: Settings · Log · Status. Mounted at /settings route.
// All in CENTER workspace, NOT right sidebar.

import { useState } from "react";
import { cn } from "../../lib/utils.js";
import { SectionHeader } from "../ui/section-header.js";
import { SettingsTab } from "./SettingsTab.js";
import { SettingsSystemStatusPanel } from "./SettingsSystemStatusPanel.js";
import { useActivityFeed } from "../../hooks/useActivityFeed.js";
import { EmptyState } from "../ui/empty-state.js";
import { formatEventPayload } from "../../lib/format-event-payload.js";

type SettingsCenterTab = "settings" | "log" | "status";

const TABS: { id: SettingsCenterTab; label: string }[] = [
  { id: "settings", label: "Settings" },
  { id: "log", label: "Log" },
  { id: "status", label: "Status" },
];

function LogPanel() {
  const { events } = useActivityFeed();
  if (events.length === 0) {
    return (
      <EmptyState
        label="LOG IS QUIET"
        description="Activity events from rigs will stream here."
        variant="card"
        testId="settings-log-empty"
      />
    );
  }
  return (
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
  );
}

export function SettingsCenter() {
  const [active, setActive] = useState<SettingsCenterTab>("settings");

  return (
    <div
      data-testid="settings-center"
      className="mx-auto w-full max-w-[960px] px-6 py-8"
    >
      <div className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">Configuration</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-stone-900 mt-1">
          Settings
        </h1>
      </div>
      <div
        data-testid="settings-tab-nav"
        role="tablist"
        aria-label="Settings sections"
        className="flex gap-1 mb-6 border-b border-outline-variant"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            data-testid={`settings-tab-${tab.id}`}
            data-active={active === tab.id}
            onClick={() => setActive(tab.id)}
            className={cn(
              "px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] border-b-2 -mb-px",
              active === tab.id
                ? "border-stone-900 text-stone-900"
                : "border-transparent text-on-surface-variant hover:text-stone-900",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div data-testid="settings-active-panel" role="tabpanel">
        {active === "settings" ? <SettingsTab /> : null}
        {active === "log" ? <LogPanel /> : null}
        {active === "status" ? <SettingsSystemStatusPanel /> : null}
      </div>
    </div>
  );
}
