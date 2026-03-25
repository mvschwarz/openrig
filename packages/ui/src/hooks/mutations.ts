import { useMutation, useQueryClient } from "@tanstack/react-query";

export function useCreateSnapshot(rigId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/rigs/${rigId}/snapshots`, { method: "POST" });
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
      const res = await fetch(`/api/rigs/${rigId}/restore/${snapshotId}`, { method: "POST" });
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
        throw new Error(JSON.stringify(data));
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
    },
  });
}
