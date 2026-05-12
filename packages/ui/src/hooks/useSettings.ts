// User Settings v0 — UI hooks for the daemon /api/config route.
//
// Consumed by the System drawer Settings tab. Bypasses CLI shell-out
// because the CLI remains the canonical agent-edit path while UI reads
// and writes settings through the daemon HTTP route directly.

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
  | "files.allowlist" | "progress.scan_roots"
  // Preview Terminal v0 (PL-018) keys.
  | "ui.preview.refresh_interval_seconds"
  | "ui.preview.max_pins"
  | "ui.preview.default_lines"
  // V1 Phase 4 ConfigStore allowlist exception (advisor/operator seats).
  | "agents.advisor_session" | "agents.operator_session"
  // V1 Phase 5 P5-3 ConfigStore allowlist exception (For You feed
  // subscription toggles per for-you-feed.md L144-L151). Same SC-29
  // exception scope as Phase 4 (allowlist-only; no schema migrations
  // / new endpoints / event types).
  | "feed.subscriptions.action_required"
  | "feed.subscriptions.approvals"
  | "feed.subscriptions.shipped"
  | "feed.subscriptions.progress"
  | "feed.subscriptions.audit_log"
  // Slice 27 — Claude auto-compaction policy keys (SC-29 EXCEPTION #10).
  | "policies.claude_compaction.enabled"
  | "policies.claude_compaction.threshold_percent"
  | "policies.claude_compaction.compact_instruction"
  | "policies.claude_compaction.message_inline"
  | "policies.claude_compaction.message_file_path";

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
