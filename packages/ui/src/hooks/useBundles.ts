import { useMutation } from "@tanstack/react-query";

/** Item 1 / slice-05: provenance metadata surfaced by /api/bundles/inspect (camelCase contract per both v1 + v2 routes). */
export interface InspectProvenance {
  createdAt?: string;
  sourceHost?: string;
  authorSession?: string;
  sourceRigId?: string;
  sourceRigName?: string;
  daemonVersion?: string;
  cliVersion?: string;
  notes?: string;
}

/** Item 2 / slice-05: compatibility block surfaced by /api/bundles/inspect (camelCase contract). */
export interface InspectCompatibility {
  minDaemonVersion?: string;
  minCliVersion?: string;
  schemaVersion?: number;
}

export interface InspectResult {
  manifest: {
    name: string;
    version: string;
    rigSpec: string;
    schemaVersion?: number;
    packages?: Array<{ name: string; version: string; path: string }>;
    agents?: Array<{ name: string; version: string; path: string }>;
    /** Item 1 provenance block (when bundle carries it). */
    provenance?: InspectProvenance;
    /** Item 2 compatibility block (when bundle carries it). */
    compatibility?: InspectCompatibility;
  };
  digestValid: boolean;
  integrityResult: { passed: boolean; mismatches: string[]; missing: string[]; extra: string[]; errors: string[] };
}

export interface BundleInstallResult {
  runId: string;
  status: string;
  rigId?: string;
  stages: Array<{ stage: string; status: string; detail?: { source?: string; [key: string]: unknown } }>;
  errors: string[];
}

export function useBundleInspect() {
  return useMutation<InspectResult, Error, { bundlePath: string }>({
    mutationFn: async ({ bundlePath }) => {
      const res = await fetch("/api/bundles/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return data as InspectResult;
    },
  });
}

export function useBundleInstall() {
  return useMutation<BundleInstallResult, Error, { bundlePath: string; plan?: boolean; autoApprove?: boolean; targetRoot?: string }>({
    mutationFn: async ({ bundlePath, plan, autoApprove, targetRoot }) => {
      const res = await fetch("/api/bundles/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath, plan, autoApprove, targetRoot }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      return data;
    },
  });
}
