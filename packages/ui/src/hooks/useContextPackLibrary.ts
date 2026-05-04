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

export interface ContextPackSendResponse {
  id: string;
  name: string;
  version: string;
  destinationSession: string;
  bundleBytes: number;
  estimatedTokens: number;
  files: Array<{ path: string; role: string; bytes: number; estimatedTokens: number }>;
  missingFiles: Array<{ path: string; role: string }>;
  dryRun: boolean;
  bundleText?: string;
  sent?: boolean;
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

async function fetchContextPackPreview(id: string): Promise<ContextPackPreview> {
  const res = await fetch(`/api/context-packs/library/${encodeURIComponent(id)}/preview`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useContextPackPreview(id: string | null) {
  return useQuery({
    queryKey: ["context-packs", "preview", id],
    queryFn: () => fetchContextPackPreview(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useContextPackSend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; destinationSession: string; dryRun?: boolean }): Promise<ContextPackSendResponse> => {
      const res = await fetch(`/api/context-packs/library/${encodeURIComponent(input.id)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destinationSession: input.destinationSession,
          dryRun: input.dryRun ?? false,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["context-packs"] });
    },
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
