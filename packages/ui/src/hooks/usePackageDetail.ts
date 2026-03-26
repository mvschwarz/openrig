import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface PackageInfo {
  id: string;
  name: string;
  version: string;
  sourceKind: string;
  sourceRef: string;
  manifestHash: string;
  summary: string | null;
  createdAt: string;
}

export interface InstallSummary {
  id: string;
  packageId: string;
  targetRoot: string;
  scope: string;
  status: string;
  riskTier: string | null;
  createdAt: string;
  appliedAt: string | null;
  rolledBackAt: string | null;
  appliedCount: number;
  deferredCount: null;
}

export interface JournalEntry {
  id: string;
  installId: string;
  seq: number;
  action: string;
  exportType: string;
  classification: string;
  targetPath: string;
  status: string;
  createdAt: string;
}

export function usePackageInfo(packageId: string) {
  return useQuery<PackageInfo>({
    queryKey: ["packages", packageId],
    queryFn: async () => {
      const res = await fetch(`/api/packages/${packageId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!packageId,
  });
}

export function useInstallHistory(packageId: string) {
  return useQuery<InstallSummary[]>({
    queryKey: ["packages", packageId, "installs"],
    queryFn: async () => {
      const res = await fetch(`/api/packages/${packageId}/installs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!packageId,
  });
}

export function useJournalEntries(installId: string | null) {
  return useQuery<JournalEntry[]>({
    queryKey: ["installs", installId, "journal"],
    queryFn: async () => {
      const res = await fetch(`/api/packages/installs/${installId}/journal`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!installId,
  });
}

export function useRollbackInstall(packageId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (installId: string) => {
      const res = await fetch(`/api/packages/${installId}/rollback`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["packages", packageId, "installs"] });
    },
  });
}
