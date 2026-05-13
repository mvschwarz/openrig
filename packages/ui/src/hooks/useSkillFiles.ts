// Slice 28 Checkpoint C-4 — skill docs-browser file hooks.
//
// Wraps the new daemon endpoints (SC-29 EXCEPTION #11 cumulative):
//   GET /api/skills/:id/files/list?path=<rel>  → useSkillFilesList
//   GET /api/skills/:id/files/read?path=<rel>  → useSkillFilesRead
//
// Symmetric with usePluginFiles (slice 28 C-1). The daemon resolves the
// skill's absolute path internally; UI passes only the skill id +
// optional relative path within the skill folder.

import { useQuery } from "@tanstack/react-query";
import type { FileEntry } from "./useFiles.js";

export interface SkillFilesListResponse {
  skillId: string;
  path: string;
  entries: FileEntry[];
}

export interface SkillFilesReadResponse {
  skillId: string;
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

async function fetchList(skillId: string, path: string): Promise<SkillFilesListResponse> {
  const res = await fetch(
    `/api/skills/${encodeURIComponent(skillId)}/files/list?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SkillFilesListResponse;
}

async function fetchRead(skillId: string, path: string): Promise<SkillFilesReadResponse> {
  const res = await fetch(
    `/api/skills/${encodeURIComponent(skillId)}/files/read?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SkillFilesReadResponse;
}

export function useSkillFilesList(skillId: string | null, path: string | null) {
  return useQuery({
    queryKey: ["skill-files", "list", skillId, path],
    queryFn: () => fetchList(skillId!, path ?? ""),
    enabled: !!skillId,
    staleTime: 15_000,
  });
}

export function useSkillFilesRead(skillId: string | null, path: string | null) {
  return useQuery({
    queryKey: ["skill-files", "read", skillId, path],
    queryFn: () => fetchRead(skillId!, path!),
    enabled: !!skillId && !!path,
    staleTime: 15_000,
  });
}
