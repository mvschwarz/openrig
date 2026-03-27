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
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
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

export function useImportRig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (yaml: string) => {
      const res = await fetch("/api/rigs/import", {
        method: "POST",
        headers: { "Content-Type": "text/yaml" },
        body: yaml,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ImportError(data as { code?: string; errors?: string[]; warnings?: string[]; message?: string });
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
    },
  });
}
