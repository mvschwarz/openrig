import { useQuery } from "@tanstack/react-query";
import type { RigSpecReview, AgentSpecReview } from "./useSpecReview.js";

export interface SpecLibraryEntry {
  id: string;
  kind: "rig" | "agent";
  name: string;
  version: string;
  sourceType: "builtin" | "user_file";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  summary?: string;
}

export interface LibraryReview {
  libraryEntryId: string;
  sourcePath: string;
  sourceState: "library_item";
}

export type LibraryRigReview = RigSpecReview & LibraryReview;
export type LibraryAgentReview = AgentSpecReview & LibraryReview;

async function fetchLibraryEntries(kind?: "rig" | "agent"): Promise<SpecLibraryEntry[]> {
  const url = kind ? `/api/specs/library?kind=${kind}` : "/api/specs/library";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchLibraryReview(id: string): Promise<LibraryRigReview | LibraryAgentReview> {
  const res = await fetch(`/api/specs/library/${encodeURIComponent(id)}/review`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function useSpecLibrary(kind?: "rig" | "agent") {
  return useQuery({
    queryKey: ["spec-library", kind ?? "all"],
    queryFn: () => fetchLibraryEntries(kind),
  });
}

export function useLibraryReview(id: string | null) {
  return useQuery({
    queryKey: ["spec-library", "review", id],
    queryFn: () => fetchLibraryReview(id!),
    enabled: !!id,
  });
}
