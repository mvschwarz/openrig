import { useQuery } from "@tanstack/react-query";
import type { RigSpecReview, AgentSpecReview } from "./useSpecReview.js";

export type SpecLibraryKind = "rig" | "agent" | "workflow";

export interface SpecLibraryEntry {
  id: string;
  kind: SpecLibraryKind;
  name: string;
  version: string;
  sourceType: "builtin" | "user_file";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  summary?: string;
  hasServices?: boolean;
  // Workflows in Spec Library v0 — workflow-only metadata.
  isBuiltIn?: boolean;
  rolesCount?: number;
  stepsCount?: number;
  terminalTurnRule?: string;
  targetRig?: string | null;
}

export interface LibraryReview {
  libraryEntryId: string;
  sourcePath: string;
  sourceState: "library_item";
}

export type LibraryRigReview = RigSpecReview & LibraryReview;
export type LibraryAgentReview = AgentSpecReview & LibraryReview;

// Workflows in Spec Library v0 — workflow review payload shape.
export interface LibraryWorkflowReview {
  kind: "workflow";
  libraryEntryId: string;
  name: string;
  version: string;
  purpose: string | null;
  targetRig: string | null;
  terminalTurnRule: string;
  rolesCount: number;
  stepsCount: number;
  isBuiltIn: boolean;
  sourcePath: string;
  cachedAt: string;
  topology: {
    nodes: Array<{
      stepId: string;
      role: string;
      objective: string | null;
      preferredTarget: string | null;
      isEntry: boolean;
      isTerminal: boolean;
    }>;
    edges: Array<{
      fromStepId: string;
      toStepId: string;
      routingType: "direct";
    }>;
  };
  steps: Array<{
    stepId: string;
    role: string;
    objective: string | null;
    allowedExits: string[];
    allowedNextSteps: Array<{ stepId: string; role: string }>;
  }>;
}

async function fetchLibraryEntries(kind?: SpecLibraryKind): Promise<SpecLibraryEntry[]> {
  const url = kind ? `/api/specs/library?kind=${kind}` : "/api/specs/library";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchLibraryReview(id: string): Promise<LibraryRigReview | LibraryAgentReview | LibraryWorkflowReview> {
  const res = await fetch(`/api/specs/library/${encodeURIComponent(id)}/review`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function useSpecLibrary(kind?: SpecLibraryKind) {
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

// --- Workflows in Spec Library v0: active lens hook ---

export interface ActiveLensPayload {
  specName: string;
  specVersion: string;
  activatedAt: string;
}

async function fetchActiveLens(): Promise<ActiveLensPayload | null> {
  const res = await fetch("/api/specs/library/active-lens");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { activeLens: ActiveLensPayload | null };
  return body.activeLens ?? null;
}

export function useActiveLens() {
  return useQuery({
    queryKey: ["spec-library", "active-lens"],
    queryFn: fetchActiveLens,
    staleTime: 0,
  });
}

export async function setActiveLens(specName: string, specVersion: string): Promise<ActiveLensPayload | null> {
  const res = await fetch("/api/specs/library/active-lens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ specName, specVersion }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { activeLens: ActiveLensPayload | null };
  return body.activeLens ?? null;
}

export async function clearActiveLens(): Promise<void> {
  const res = await fetch("/api/specs/library/active-lens", { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
