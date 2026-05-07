// V1 attempt-3 Phase 5 P5-3 — For You subscription toggle surface.
//
// Renders the 5 subscriptions per for-you-feed.md L144–L151 as a small
// settings-shaped list (NOT a feed-shaped UX per L134-L140 LOAD-BEARING
// SC-16). Each non-forced row toggles on click and writes the matching
// feed.subscriptions.* ConfigStore key. action_required is forced ON
// (L145 — load-bearing human-gate items cannot be disabled) and renders
// as a disabled-looking row with "forced ON" label.

import { useFeedSubscriptions } from "../../hooks/useFeedSubscriptions.js";

interface ToggleRow {
  toggleKey: "approvals" | "shipped" | "progress" | "auditLog" | null;
  label: string;
  description: string;
  forced?: boolean;
  testId: string;
}

const ROWS: ToggleRow[] = [
  {
    toggleKey: null,
    label: "Action required",
    description: "Items the human must act on",
    forced: true,
    testId: "subscription-toggle-action-required",
  },
  {
    toggleKey: "approvals",
    label: "Approvals",
    description: "Closeout-pending-ratify items",
    testId: "subscription-toggle-approvals",
  },
  {
    toggleKey: "shipped",
    label: "Feature ships",
    description: "Slice / mission deliveries + git tag landings",
    testId: "subscription-toggle-shipped",
  },
  {
    toggleKey: "progress",
    label: "Slice progress",
    description: "Compact progress rollups",
    testId: "subscription-toggle-progress",
  },
  {
    toggleKey: "auditLog",
    label: "Audit log",
    description: "Verbose stream + watchdog observations",
    testId: "subscription-toggle-audit-log",
  },
];

export function SubscriptionToggleList() {
  const { state, toggle, isMutating, unavailable } = useFeedSubscriptions();

  return (
    <div data-testid="subscription-toggle-list" className="font-mono text-xs">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant mb-2">
        Subscriptions
      </div>
      <ul className="space-y-1">
        {ROWS.map((row) => {
          // Resolve current value for this row.
          const value =
            row.toggleKey === null
              ? state.actionRequired // always true in V1
              : state[row.toggleKey];
          const interactive = !row.forced && !unavailable;
          return (
            <li
              key={row.testId}
              data-testid={row.testId}
              data-on={value ? "true" : "false"}
              className="flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="text-stone-900 truncate">{row.label}</div>
                <div className="font-mono text-[9px] text-on-surface-variant truncate">
                  {row.description}
                </div>
              </div>
              {row.forced ? (
                <span className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant shrink-0">
                  forced ON
                </span>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={value}
                  disabled={!interactive || isMutating}
                  data-testid={`${row.testId}-button`}
                  onClick={() => row.toggleKey && toggle(row.toggleKey)}
                  className={
                    "shrink-0 px-2 py-0.5 border font-mono text-[9px] uppercase tracking-wide " +
                    (value
                      ? "border-success text-success"
                      : "border-stone-300 text-on-surface-variant") +
                    (interactive
                      ? " hover:bg-stone-100/60"
                      : " opacity-60 cursor-not-allowed")
                  }
                >
                  {value ? "on" : "off"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {unavailable ? (
        <p
          data-testid="subscription-toggle-unavailable"
          className="mt-3 font-mono text-[9px] text-on-surface-variant italic"
        >
          Settings endpoint unreachable (legacy daemon &lt; v0.3.0). Toggles render the
          canonical defaults; configure via CLI:
          <code className="ml-1 text-stone-700">
            rig config set feed.subscriptions.&lt;kind&gt; true|false
          </code>
        </p>
      ) : null}
    </div>
  );
}
