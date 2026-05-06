// V1 attempt-3 Phase 3 bounce-fix A5 — useWorkspaceName.
//
// Reads the configured workspace root from ConfigStore (via useSettings)
// and returns its basename for display. When unset (or settings endpoint
// is unreachable on shipped daemon < v0.3.0), returns null so consumers
// render an honest "No workspace connected" empty-state.

import { useSettings } from "./useSettings.js";

export interface WorkspaceNameResult {
  /** Live basename of the configured workspace root, or null when unset/unreachable. */
  name: string | null;
  /** The full configured root path; null when unset/unreachable. */
  root: string | null;
  /** Settings endpoint reachable (daemon supports /api/config). */
  settingsAvailable: boolean;
  /** True while initial settings request is in flight. */
  isLoading: boolean;
}

function basename(p: string): string {
  if (!p) return "";
  const trimmed = p.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

export function useWorkspaceName(): WorkspaceNameResult {
  const { data, isLoading, error } = useSettings();

  if (error || !data || !data.settings || typeof data.settings !== "object") {
    return {
      name: null,
      root: null,
      settingsAvailable: false,
      isLoading,
    };
  }

  const resolved = data.settings["workspace.root"];
  const rawValue = resolved?.value;
  const root = typeof rawValue === "string" && rawValue.length > 0 ? rawValue : null;

  return {
    name: root ? basename(root) : null,
    root,
    settingsAvailable: true,
    isLoading,
  };
}
