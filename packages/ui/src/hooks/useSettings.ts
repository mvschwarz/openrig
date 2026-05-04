// User Settings v0 — UI hooks for the daemon /api/config route.
//
// Consumed by the System drawer Settings tab. Bypasses CLI shell-out
// per founder dialog (CLI is the canonical agent-edit path; UI uses
// the daemon HTTP route directly).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type SettingSource = "env" | "file" | "default";

export interface ResolvedSetting {
  value: string | number | boolean;
  source: SettingSource;
  defaultValue: string | number | boolean;
}

export type SettingsKey =
  | "daemon.port" | "daemon.host" | "db.path"
  | "transcripts.enabled" | "transcripts.path"
  | "workspace.root" | "workspace.slices_root" | "workspace.steering_path"
  | "workspace.field_notes_root" | "workspace.specs_root"
  | "files.allowlist" | "progress.scan_roots";

export interface SettingsResponse {
  settings: Record<SettingsKey, ResolvedSetting>;
}

async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetch("/api/config");
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings", "all"],
    queryFn: fetchSettings,
    staleTime: 0,
  });
}

export function useSetSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { key: SettingsKey; value: string }) => {
      const res = await fetch(`/api/config/${encodeURIComponent(input.key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: input.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ ok: boolean; resolved: ResolvedSetting }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export function useResetSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (key: SettingsKey) => {
      const res = await fetch(`/api/config/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ ok: boolean; resolved: ResolvedSetting }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export interface InitWorkspaceResponse {
  root: string;
  rootCreated: boolean;
  subdirs: Array<{ name: string; path: string; created: boolean }>;
  files: Array<{ relPath: string; absPath: string; created: boolean; skipped: "exists" | null }>;
  dryRun: boolean;
}

export function useInitWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { root?: string; force?: boolean; dryRun?: boolean }) => {
      const res = await fetch("/api/config/init-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<InitWorkspaceResponse>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
