// Slice 28 Checkpoint C-4 — useLibrarySkills consumes /api/skills/library.
//
// Pre-C4 the hook fanned out per-allowlist-root × per-candidate-path probes
// (N×3 fetches) and recursively walked nested category folders client-side.
// QA verdict on slice 28 C-2 (qitem-20260513045711-39ccfdf3) proved that
// approach fails when the operator's allowlist doesn't include the daemon's
// source tree.
//
// Daemon-owned discovery (SkillLibraryDiscoveryService, SC-29 EXCEPTION #11
// cumulative) is the single source of truth: shared skills resolve via the
// daemon install path; workspace skills via the daemon's filesAllowlist.

import { useQuery } from "@tanstack/react-query";

export type LibrarySkillSource = "workspace" | "openrig-managed";

export interface LibrarySkillFile {
  /** Filename only (no path prefix). */
  name: string;
  /** Path relative to the skill folder root (e.g., "SKILL.md" or "examples/basic.md"). */
  path: string;
  size: number;
  mtime: string;
}

export interface LibrarySkillEntry {
  /** Stable id incl. source + relative path within source tree
   *  (e.g., "openrig-managed:core/openrig-user" or "workspace:<root-name>:skill-name"). */
  id: string;
  /** Leaf skill folder name. */
  name: string;
  source: LibrarySkillSource;
  /** Top-level markdown files of the skill folder. */
  files: LibrarySkillFile[];
}

async function fetchLibrarySkills(): Promise<LibrarySkillEntry[]> {
  const res = await fetch("/api/skills/library");
  if (res.status === 503) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as LibrarySkillEntry[];
}

export function useLibrarySkills() {
  return useQuery({
    queryKey: ["skills", "library"],
    queryFn: fetchLibrarySkills,
    staleTime: 30_000,
  });
}
