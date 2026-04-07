import { useMutation, useQueryClient } from "@tanstack/react-query";

export class ImportError extends Error {
  errors: string[];
  warnings: string[];
  code: string;

  constructor(data: { code?: string; errors?: string[]; warnings?: string[]; message?: string }) {
    const msg = data.errors?.join(", ") ?? data.message ?? "Import failed";
    super(msg);
    this.name = "ImportError";
    this.code = data.code ?? "unknown";
    this.errors = data.errors ?? (data.message ? [data.message] : ["Import failed"]);
    this.warnings = data.warnings ?? [];
  }
}

export class RestoreError extends Error {
  code: string;

  constructor(data: { code?: string; error?: string }, status: number) {
    super(data.error ?? `HTTP ${status}`);
    this.name = "RestoreError";
    this.code = data.code ?? "unknown";
  }
}

export function useCreateSnapshot(rigId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/snapshots`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Snapshot failed (HTTP ${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rig", rigId, "snapshots"] });
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
    },
  });
}

export function useRestoreSnapshot(rigId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (snapshotId: string) => {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/restore/${encodeURIComponent(snapshotId)}`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new RestoreError(data as { code?: string; error?: string }, res.status);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rig", rigId] });
    },
  });
}

export function useTeardownRig(rigId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/down", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rigId }),
      });
      const data = await res.json().catch(() => ({})) as {
        errors?: string[];
        error?: string;
        sessionsKilled?: number;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Teardown failed (HTTP ${res.status})`);
      }
      // Body-driven: errors[] on 200 is a failure
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        throw new Error(data.errors.join("; "));
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["ps"] });
    },
  });
}

export function useStartRig(rigId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/up`, { method: "POST" });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `Start failed (HTTP ${res.status})`);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["ps"] });
      queryClient.invalidateQueries({ queryKey: ["rig", rigId] });
    },
  });
}

export function useImportRig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ yaml, rigRoot }: { yaml: string; rigRoot?: string }) => {
      const headers: Record<string, string> = { "Content-Type": "text/yaml" };
      if (rigRoot) headers["X-Rig-Root"] = rigRoot;
      const res = await fetch("/api/rigs/import", {
        method: "POST",
        headers,
        body: yaml,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { code?: string; errors?: string[]; warnings?: string[]; message?: string };
        if (data.code === "cycle_error") {
          throw new ImportError({ ...data, errors: data.errors ?? ["Cycle detected in rig topology"] });
        }
        throw new ImportError(data);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
    },
  });
}

export interface ExpandRigResult {
  ok: boolean;
  status?: "ok" | "partial" | "failed";
  podId?: string;
  podNamespace?: string;
  nodes?: Array<{ logicalId: string; nodeId: string; status: string; error?: string; sessionName?: string }>;
  warnings?: string[];
  retryTargets?: string[];
  code?: string;
  error?: string;
}

export function useExpandRig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ rigId, pod, crossPodEdges }: { rigId: string; pod: Record<string, unknown>; crossPodEdges?: unknown[] }) => {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pod, crossPodEdges }),
      });
      const data = await res.json() as ExpandRigResult;
      if (res.status >= 400 || !data.ok) {
        throw new Error(data.error ?? `Expansion failed (HTTP ${res.status})`);
      }
      return data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["ps"] });
      queryClient.invalidateQueries({ queryKey: ["rig", variables.rigId, "nodes"] });
      queryClient.invalidateQueries({ queryKey: ["rig", variables.rigId, "graph"] });
    },
  });
}
