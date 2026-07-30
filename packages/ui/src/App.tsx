import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { router } from "./routes.js";

export const UI_MAINTENANCE_NOTICE_STORAGE_KEY = "openrig.uiMaintenanceNoticeDismissed";

const UI_MAINTENANCE_NOTICE =
  "The OpenRig UI is experimental and in maintenance mode. It is not under active development; support is best-effort. The CLI is the primary supported interface. Contributions welcome.";

function wasMaintenanceNoticeDismissed(): boolean {
  try {
    return localStorage.getItem(UI_MAINTENANCE_NOTICE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function UiMaintenanceNotice() {
  const [dismissed, setDismissed] = useState(wasMaintenanceNoticeDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(UI_MAINTENANCE_NOTICE_STORAGE_KEY, "1");
    } catch {
      // localStorage can be unavailable; dismissal still works for this load.
    }
    setDismissed(true);
  };

  return (
    <div
      className="fixed inset-x-0 top-0 z-[100] flex items-start justify-between gap-3 border-b border-amber-500/40 bg-amber-50 px-4 py-2 text-sm text-amber-950 shadow-sm dark:bg-amber-950 dark:text-amber-50"
      data-testid="ui-maintenance-notice"
      role="status"
    >
      <span>{UI_MAINTENANCE_NOTICE}</span>
      <button
        aria-label="Dismiss maintenance notice"
        className="shrink-0 rounded px-1.5 font-semibold hover:bg-amber-200/60 dark:hover:bg-amber-900"
        onClick={dismiss}
        type="button"
      >
        ×
      </button>
    </div>
  );
}

export function App() {
  return (
    <>
      <UiMaintenanceNotice />
      <RouterProvider router={router} />
    </>
  );
}
