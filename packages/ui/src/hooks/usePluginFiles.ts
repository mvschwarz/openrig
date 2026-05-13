// Slice 28 Checkpoint C-2 — plugin docs-browser file hooks.
//
// Wraps the new daemon endpoints (SC-29 EXCEPTION #11) added in
// Checkpoint C-1:
//   GET /api/plugins/:id/files/list?path=<rel>  → usePluginFilesList
//   GET /api/plugins/:id/files/read?path=<rel>  → usePluginFilesRead
//
// Same react-query shape as useFilesList / useFilesRead but the daemon
// returns response objects scoped to a single plugin (no allowlist root
// concept). Plugins live outside the operator's OPENRIG_FILES_ALLOWLIST,
// so this is the only way to browse plugin folder contents at v0.

import { useQuery } from "@tanstack/react-query";
import type { FileEntry } from "./useFiles.js";

export interface PluginFilesListResponse {
  pluginId: string;
  path: string;
  entries: FileEntry[];
}

export interface PluginFilesReadResponse {
  pluginId: string;
  path: string;
  absolutePath: string;
  content: string;
  mtime: string;
  contentHash: string;
  size: number;
  truncated?: boolean;
  truncatedAtBytes?: number | null;
  totalBytes?: number;
}

async function fetchList(pluginId: string, path: string): Promise<PluginFilesListResponse> {
  const res = await fetch(
    `/api/plugins/${encodeURIComponent(pluginId)}/files/list?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PluginFilesListResponse;
}

async function fetchRead(pluginId: string, path: string): Promise<PluginFilesReadResponse> {
  const res = await fetch(
    `/api/plugins/${encodeURIComponent(pluginId)}/files/read?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PluginFilesReadResponse;
}

export function usePluginFilesList(pluginId: string | null, path: string | null) {
  return useQuery({
    queryKey: ["plugin-files", "list", pluginId, path],
    queryFn: () => fetchList(pluginId!, path ?? ""),
    enabled: !!pluginId,
    staleTime: 15_000,
  });
}

export function usePluginFilesRead(pluginId: string | null, path: string | null) {
  return useQuery({
    queryKey: ["plugin-files", "read", pluginId, path],
    queryFn: () => fetchRead(pluginId!, path!),
    enabled: !!pluginId && !!path,
    staleTime: 15_000,
  });
}
