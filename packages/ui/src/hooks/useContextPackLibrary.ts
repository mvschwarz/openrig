// Rig Context / Composable Context Injection v0 (PL-014) — UI hooks
// for the context_packs library + review + send.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface ContextPackEntryFile {
  path: string;
  role: string;
  summary: string | null;
  absolutePath: string | null;
  bytes: number | null;
  estimatedTokens: number | null;
}

export interface ContextPackEntry {
  id: string;
  kind: "context-pack";
  name: string;
  version: string;
  purpose: string | null;
  sourceType: "builtin" | "user_file" | "workspace";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  files: ContextPackEntryFile[];
}

export interface ContextPackPreview {
  id: string;
  name: string;
  version: string;
  bundleText: string;
  bundleBytes: number;
  estimatedTokens: number;
  files: Array<{ path: string; role: string; bytes: number; estimatedTokens: number }>;
  missingFiles: Array<{ path: string; role: string }>;
}

async function fetchContextPacks(): Promise<ContextPackEntry[]> {
  const res = await fetch("/api/context-packs/library");
  if (!res.ok) {
    if (res.status === 503) return []; // honest fallback when library not configured
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => null);
  // Cross-CLI-version drift guard: an older daemon that doesn't ship
  // the route may surface 200 with a non-array placeholder. Fall back
  // to an empty list rather than letting consumers .map() into an
  // exception.
  return Array.isArray(body) ? body : [];
}

export function useContextPackLibrary() {
  return useQuery({
    queryKey: ["context-packs", "library"],
    queryFn: fetchContextPacks,
    staleTime: 30_000,
  });
}

// Slice-03 Atom 5: preview addresses by the pack's path-like ref.
async function fetchContextPackPreview(ref: string): Promise<ContextPackPreview> {
  const res = await fetch(`/api/context-packs/library/by-ref/preview?ref=${encodeURIComponent(ref)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useContextPackPreview(ref: string | null) {
  return useQuery({
    queryKey: ["context-packs", "preview", ref],
    queryFn: () => fetchContextPackPreview(ref!),
    enabled: !!ref,
    staleTime: 30_000,
  });
}

export function useContextPackSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/context-packs/library/sync", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ count: number; entries: ContextPackEntry[] }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["context-packs"] });
    },
  });
}
