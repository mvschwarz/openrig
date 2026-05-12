// Slice 26 — Settings destination Explorer sidebar.
//
// Renders the 4 Settings destinations as a flat sidebar list (peer to
// Topology / Project / Library / For-You destinations per dispatch).
// Each item is a TanStack Router Link to its sub-route. The active
// item is derived from the current router pathname so the sidebar
// stays in sync regardless of how the user navigated.

import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";

interface SettingsExplorerItem {
  id: "settings" | "policies" | "log" | "status";
  label: string;
  href: string;
  /**
   * Predicate matching the current pathname to "active" state.
   * The Settings root is the exact match `/settings`; sub-routes
   * match their full path.
   */
  isActive: (pathname: string) => boolean;
}

const SETTINGS_ITEMS: SettingsExplorerItem[] = [
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    // Active for the bare /settings only — not for /settings/<sub>.
    isActive: (path) => path === "/settings",
  },
  {
    id: "policies",
    label: "Policies",
    href: "/settings/policies",
    isActive: (path) => path.startsWith("/settings/policies"),
  },
  {
    id: "log",
    label: "Log",
    href: "/settings/log",
    isActive: (path) => path.startsWith("/settings/log"),
  },
  {
    id: "status",
    label: "Status",
    href: "/settings/status",
    isActive: (path) => path.startsWith("/settings/status"),
  },
];

export function SettingsExplorer() {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;

  return (
    <div data-testid="settings-explorer" className="flex-1 overflow-y-auto py-2">
      <div className="px-2 mb-2">
        <span
          data-testid="settings-explorer-heading"
          className="block font-mono text-[11px] uppercase tracking-wide text-stone-900 px-2 py-1"
        >
          {"> "}Settings
        </span>
      </div>
      <ul className="px-2 space-y-0.5">
        {SETTINGS_ITEMS.map((item) => {
          const active = item.isActive(pathname);
          return (
            <li key={item.id}>
              <Link
                to={item.href}
                data-testid={`settings-explorer-item-${item.id}`}
                data-active={active}
                className={cn(
                  "block font-mono text-[11px] uppercase tracking-wide px-2 py-1",
                  active
                    ? "bg-stone-900 text-stone-50"
                    : "text-stone-700 hover:text-stone-900 hover:bg-surface-low",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
