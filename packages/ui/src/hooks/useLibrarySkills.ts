import { useQuery } from "@tanstack/react-query";
import type { FileEntry, FilesListResponse, FilesRootsResponse, FilesUnavailable } from "./useFiles.js";

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

async function fetchLibrarySkills(): Promise<LibrarySkillEntry[]> {
  const rootsResponse = await fetchJson<FilesRootsResponse | FilesUnavailable>("/api/files/roots");
  if (!rootsResponse || isUnavailable(rootsResponse)) return [];

  const skills: LibrarySkillEntry[] = [];
  for (const root of rootsResponse.roots) {
    for (const candidate of SKILL_DIRECTORIES) {
      const directory = await listDirectory(root.name, candidate.path);
      if (!directory) continue;
      const skillDirs = directory.entries.filter((entry) => entry.type === "dir");
      for (const skillDir of skillDirs) {
        const skillPath = `${candidate.path}/${skillDir.name}`;
        const skillFiles = await listDirectory(root.name, skillPath);
        if (!skillFiles) continue;
        const files = markdownFiles(skillPath, skillFiles.entries);
        if (files.length === 0) continue;
        skills.push({
          id: `${candidate.source}:${root.name}:${skillPath}`,
          name: skillDir.name,
          source: candidate.source,
          root: root.name,
          directoryPath: skillPath,
          files,
        });
      }
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
