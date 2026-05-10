// Fork Primitive + Starter Agent Images v0 (PL-016) — UI hooks for the
// agent_images library + preview + lifecycle verbs. Mirrors
// useContextPackLibrary (PL-014) shape.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface AgentImageEntry {
  id: string;
  kind: "agent-image";
  name: string;
  version: string;
  runtime: "claude-code" | "codex";
  sourceSeat: string;
  sourceSessionId: string;
  /** Source seat's cwd at snapshot time. null when the manifest predates
   *  source_cwd support (back-compat). The Use-as-starter
   *  snippet emits `cwd: <sourceCwd>` when this is non-null. */
  sourceCwd: string | null;
  notes: string | null;
  createdAt: string;
  sourceType: "user_file" | "workspace" | "builtin";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  files: Array<{
    path: string;
    role: string;
    summary: string | null;
    absolutePath: string | null;
    bytes: number | null;
    estimatedTokens: number | null;
  }>;
  /** Always "(redacted)" over the wire — UI never sees real tokens. */
  sourceResumeToken: string;
  stats: {
    forkCount: number;
    lastUsedAt: string | null;
    estimatedSizeBytes: number;
    lineage: string[];
  };
  lineage: string[];
  pinned: boolean;
}

export interface AgentImagePreview {
  id: string;
  name: string;
  version: string;
  runtime: "claude-code" | "codex";
  sourceSeat: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  stats: AgentImageEntry["stats"];
  lineage: string[];
  pinned: boolean;
  notes: string | null;
  files: AgentImageEntry["files"];
  starterSnippet: string;
}

async function fetchAgentImages(): Promise<AgentImageEntry[]> {
  const res = await fetch("/api/agent-images/library");
  if (!res.ok) {
    if (res.status === 503) return [];
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => null);
  return Array.isArray(body) ? body : [];
}

export function useAgentImageLibrary() {
  return useQuery({
    queryKey: ["agent-images", "library"],
    queryFn: fetchAgentImages,
    staleTime: 30_000,
  });
}

async function fetchAgentImagePreview(id: string): Promise<AgentImagePreview> {
  const res = await fetch(`/api/agent-images/library/${encodeURIComponent(id)}/preview`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useAgentImagePreview(id: string | null) {
  return useQuery({
    queryKey: ["agent-images", "preview", id],
    queryFn: () => fetchAgentImagePreview(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useAgentImagePin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; pin: boolean }) => {
      const verb = input.pin ? "pin" : "unpin";
      const res = await fetch(`/api/agent-images/library/${encodeURIComponent(input.id)}/${verb}`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ ok: boolean; pinned: boolean }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-images"] });
    },
  });
}
