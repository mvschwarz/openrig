import { useQuery } from "@tanstack/react-query";
import type { FileEntry, FilesListResponse, FilesRootsResponse, FilesUnavailable } from "./useFiles.js";

// Slice 28 — skill discovery recurses into one level of category
// folders. Pre-slice-28, the hook listed each candidate skills base
// path, treated every top-level dir as a candidate skill folder, and
// dropped any dir that didn't have markdown files at its immediate
// level. That worked for flat layouts like
// `packages/daemon/specs/agents/shared/skills/claude-compact-in-place/SKILL.md`
// but missed every NESTED skill (e.g.
// `packages/daemon/specs/agents/shared/skills/core/openrig-user/SKILL.md`
// — `core/` has no .md children, so the entire category was skipped).
// HG-5 root cause.
//
// MAX_NESTING_DEPTH=1 recurses exactly one level when a candidate
// folder has no markdown but has subdirs. depth 0 = base path's
// direct children; depth 1 = one-level-nested children (category
// contents). The shared skills tree observed on disk only nests one
// level deep, so depth 1 is sufficient. Cap prevents pathological
// runaway on unexpected directory structures.
const MAX_NESTING_DEPTH = 1;

export type LibrarySkillSource = "workspace" | "openrig-managed";

export interface LibrarySkillFile {
  name: string;
  path: string;
  size: number | null;
  mtime: string | null;
}

export interface LibrarySkillEntry {
  id: string;
  name: string;
  source: LibrarySkillSource;
  root: string;
  directoryPath: string;
  files: LibrarySkillFile[];
}

const SKILL_DIRECTORIES: Array<{ source: LibrarySkillSource; path: string }> = [
  { source: "workspace", path: ".openrig/skills" },
  { source: "openrig-managed", path: "packages/daemon/specs/agents/shared/skills" },
  { source: "openrig-managed", path: "node_modules/@openrig/daemon/specs/agents/shared/skills" },
];

function isUnavailable(data: unknown): data is FilesUnavailable {
  return Boolean(data && typeof data === "object" && "unavailable" in (data as Record<string, unknown>));
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  if (res.status === 404 || res.status === 400 || res.status === 503) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function listDirectory(root: string, path: string): Promise<FilesListResponse | null> {
  return fetchJson<FilesListResponse>(
    `/api/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
  );
}

function markdownFiles(directoryPath: string, entries: FileEntry[]): LibrarySkillFile[] {
  return entries
    .filter((entry) => entry.type === "file" && /\.(md|mdx)$/i.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: `${directoryPath}/${entry.name}`,
      size: entry.size,
      mtime: entry.mtime,
    }))
    .sort((a, b) => {
      if (a.name === "SKILL.md") return -1;
      if (b.name === "SKILL.md") return 1;
      return a.name.localeCompare(b.name);
    });
}

function skillDedupeKey(skill: LibrarySkillEntry): string {
  if (skill.source === "workspace") return skill.id;
  return `${skill.source}:${skill.name}`;
}

function managedSkillPriority(skill: LibrarySkillEntry): number {
  if (skill.source === "workspace") return 0;
  if (skill.root === "openrig" && skill.directoryPath.startsWith("packages/daemon/")) return 1;
  if (skill.directoryPath.startsWith("packages/daemon/")) return 2;
  return 3;
}

function dedupeSkills(skills: LibrarySkillEntry[]): LibrarySkillEntry[] {
  const bestByKey = new Map<string, LibrarySkillEntry>();
  for (const skill of skills) {
    const key = skillDedupeKey(skill);
    const existing = bestByKey.get(key);
    if (!existing || managedSkillPriority(skill) < managedSkillPriority(existing)) {
      bestByKey.set(key, skill);
    }
  }
  return Array.from(bestByKey.values());
}

// Recursively collect skill entries from a directory listing. A
// "skill" is a directory containing one or more markdown files (SKILL.md
// or other .md/.mdx). A "category" is a directory with no markdown
// but with subdirs (e.g. `core/`, `pm/`). Categories recurse one level;
// skills become leaves. See MAX_NESTING_DEPTH comment for the why.
async function collectSkillsFromListing(
  rootName: string,
  basePath: string,
  listing: FilesListResponse,
  source: LibrarySkillSource,
  depth: number,
): Promise<LibrarySkillEntry[]> {
  const result: LibrarySkillEntry[] = [];
  const subdirs = listing.entries.filter((entry) => entry.type === "dir");
  for (const subdir of subdirs) {
    const subdirPath = `${basePath}/${subdir.name}`;
    const subdirListing = await listDirectory(rootName, subdirPath);
    if (!subdirListing) continue;
    const mdFiles = markdownFiles(subdirPath, subdirListing.entries);
    if (mdFiles.length > 0) {
      result.push({
        id: `${source}:${rootName}:${subdirPath}`,
        name: subdir.name,
        source,
        root: rootName,
        directoryPath: subdirPath,
        files: mdFiles,
      });
    } else if (depth < MAX_NESTING_DEPTH) {
      const nested = await collectSkillsFromListing(rootName, subdirPath, subdirListing, source, depth + 1);
      result.push(...nested);
    }
    // else: no markdown + cannot recurse further → skip
  }
  return result;
}

async function fetchLibrarySkills(): Promise<LibrarySkillEntry[]> {
  const rootsResponse = await fetchJson<FilesRootsResponse | FilesUnavailable>("/api/files/roots");
  if (!rootsResponse || isUnavailable(rootsResponse)) return [];

  const skills: LibrarySkillEntry[] = [];
  for (const root of rootsResponse.roots) {
    for (const candidate of SKILL_DIRECTORIES) {
      const directory = await listDirectory(root.name, candidate.path);
      if (!directory) continue;
      const collected = await collectSkillsFromListing(
        root.name,
        candidate.path,
        directory,
        candidate.source,
        0,
      );
      skills.push(...collected);
    }
  }

  return dedupeSkills(skills).sort((a, b) => {
    if (a.source !== b.source) return a.source === "workspace" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function useLibrarySkills() {
  return useQuery({
    queryKey: ["library", "skills"],
    queryFn: fetchLibrarySkills,
    staleTime: 30_000,
  });
}
