// Canonical project-workspace scaffold. S01 owns these bytes; S05's instance
// initializer calls this owner rather than copying its behavior.

import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE_DIRS = ["missions", "exhaust"] as const;

const PROJECT_SPEC = `---
intent: Organize this project's durable work as missions and slices, then move it through queue-backed agent collaboration.
---

# Project

This is the project-level context for the default OpenRig workspace. It gives
agents a stable project intent before they descend into the active mission and
slice. Edit it to describe what your project is for and who benefits from it.
`;

const PROJECT_MANIFEST = `schema: openrig.project/v0alpha1
kind: project
install:
  intent: SPEC.md
  context: []
  skills: []
missions:
  root: missions
# Add ordered project Markdown addresses and stable catalog skill IDs above.
# Skill source and the System World remain outside the project workspace.
`;

const WORKSPACE_CATALOG = `schema: openrig.workspace/v0alpha1
projects:
  - id: default
    root: .
`;

const WORKSPACE_GITIGNORE = `# OpenRig disposable work and local runtime projection state.
/exhaust/
/.openrig/
`;

export function workspaceScaffoldDirs(): string[] {
  return [...WORKSPACE_DIRS];
}

export function workspaceScaffoldFiles(): Array<{ relPath: string; content: string }> {
  return [
    { relPath: "SPEC.md", content: PROJECT_SPEC },
    { relPath: "project.yaml", content: PROJECT_MANIFEST },
    { relPath: "workspace.yaml", content: WORKSPACE_CATALOG },
    { relPath: ".gitignore", content: WORKSPACE_GITIGNORE },
  ];
}

export type ManagedPathKind = "missing" | "file" | "directory" | "other";

export interface InitializationFsOps {
  pathKind(path: string): ManagedPathKind;
  mkdirp(path: string): void;
  writeFile(path: string, content: string): void;
}

export interface InitializationConflict {
  path: string;
  expected: "file" | "directory";
  actual: Exclude<ManagedPathKind, "missing">;
}

export interface InitWorkspaceResult {
  ok: boolean;
  root: string;
  rootCreated: boolean;
  subdirs: Array<{ name: string; path: string; created: boolean }>;
  files: Array<{ relPath: string; absPath: string; created: boolean; skipped: "exists" | null }>;
  conflicts: InitializationConflict[];
  dryRun: boolean;
}

export function nodeInitializationFs(): InitializationFsOps {
  return {
    pathKind(path) {
      try {
        const value = lstatSync(path);
        if (value.isDirectory()) return "directory";
        if (value.isFile()) return "file";
        return "other";
      } catch {
        return "missing";
      }
    },
    mkdirp: (path) => mkdirSync(path, { recursive: true }),
    writeFile: (path, content) => writeFileSync(path, content, "utf8"),
  };
}

/** Additively reconcile the S01 project workspace. All collisions are found
 * before the first write, so a malformed user-owned path never leaves a
 * half-created scaffold. */
export function ensureDefaultWorkspace(options: {
  root: string;
  dryRun?: boolean;
  fs?: InitializationFsOps;
}): InitWorkspaceResult {
  const fs = options.fs ?? nodeInitializationFs();
  const dryRun = options.dryRun ?? false;
  const rootKind = fs.pathKind(options.root);
  const subdirs = workspaceScaffoldDirs().map((name) => {
    const path = join(options.root, name);
    return { name, path, created: fs.pathKind(path) === "missing" };
  });
  const files = workspaceScaffoldFiles().map(({ relPath }) => {
    const absPath = join(options.root, relPath);
    const created = fs.pathKind(absPath) === "missing";
    return { relPath, absPath, created, skipped: created ? null : "exists" as const };
  });
  const conflicts: InitializationConflict[] = [];

  if (rootKind !== "missing" && rootKind !== "directory") {
    conflicts.push({ path: options.root, expected: "directory", actual: rootKind });
  }
  for (const subdir of subdirs) {
    const actual = fs.pathKind(subdir.path);
    if (actual !== "missing" && actual !== "directory") {
      conflicts.push({ path: subdir.path, expected: "directory", actual });
    }
  }
  for (const file of files) {
    const actual = fs.pathKind(file.absPath);
    if (actual !== "missing" && actual !== "file") {
      conflicts.push({ path: file.absPath, expected: "file", actual });
    }
  }

  if (conflicts.length === 0 && !dryRun) {
    if (rootKind === "missing") fs.mkdirp(options.root);
    for (const subdir of subdirs) if (subdir.created) fs.mkdirp(subdir.path);
    for (const file of workspaceScaffoldFiles()) {
      const absPath = join(options.root, file.relPath);
      if (fs.pathKind(absPath) === "missing") fs.writeFile(absPath, file.content);
    }
  }

  return {
    ok: conflicts.length === 0,
    root: options.root,
    rootCreated: rootKind === "missing",
    subdirs,
    files,
    conflicts,
    dryRun,
  };
}
