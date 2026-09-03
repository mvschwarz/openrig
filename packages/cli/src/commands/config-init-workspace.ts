// Canonical project-workspace scaffold used by `rig config init-workspace`.
//
// Keep this byte-compatible with
// packages/daemon/src/domain/workspace/default-workspace-scaffold.ts. The two
// packages intentionally do not depend on one another, and the daemon parity
// test pins their shared output.

import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../config-store.js";

export interface InitWorkspaceOpts {
  root?: string;
  /** Deprecated compatibility input. Existing files are always preserved. */
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface InitWorkspaceResult {
  root: string;
  rootCreated: boolean;
  subdirs: Array<{ name: string; path: string; created: boolean }>;
  files: Array<{ relPath: string; absPath: string; created: boolean; skipped: "exists" | null }>;
  dryRun: boolean;
}

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
missions:
  root: missions
# Add ordered install.context references and managed skill selectors here.
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

export function initWorkspaceCommand(configPath?: string): Command {
  const cmd = new Command("init-workspace")
    .description("Scaffold a repo-ready project workspace")
    .option("--root <path>", "Override workspace root (default: workspace.root setting)")
    .option("--force", "Deprecated compatibility flag; existing files are still preserved")
    .option("--dry-run", "Show what would be created without writing")
    .option("--json", "JSON output")
    .action((opts: InitWorkspaceOpts) => {
      try {
        const effectiveJson = opts.json ?? Boolean(cmd.optsWithGlobals().json);
        const result = runInitWorkspace({ ...opts, json: effectiveJson, configPath });
        if (effectiveJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.dryRun) console.log(`(dry-run) workspace root: ${result.root}`);
          else console.log(`workspace root: ${result.root}`);
          for (const sub of result.subdirs) {
            console.log(`  ${sub.created ? "+" : " "} ${sub.name}/`);
          }
          for (const file of result.files) {
            console.log(`  ${file.created ? "+" : " "} ${file.relPath}${file.skipped ? `  (skipped: ${file.skipped})` : ""}`);
          }
          if (result.dryRun) console.log("(dry-run; no files written.)");
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
  return cmd;
}

export function runInitWorkspace(opts: InitWorkspaceOpts & { configPath?: string }): InitWorkspaceResult {
  const store = new ConfigStore(opts.configPath);
  const root = opts.root ?? (store.get("workspace.root") as string);
  const dryRun = !!opts.dryRun;
  const scaffoldFiles = workspaceScaffoldFiles();
  const scaffoldDirs = workspaceScaffoldDirs();
  const rootExists = existsSync(root);
  const result: InitWorkspaceResult = {
    root,
    rootCreated: !rootExists,
    subdirs: [],
    files: [],
    dryRun,
  };

  if (!rootExists && !dryRun) mkdirSync(root, { recursive: true });

  for (const sub of scaffoldDirs) {
    const subPath = join(root, sub);
    const subExists = existsSync(subPath);
    if (!subExists && !dryRun) mkdirSync(subPath, { recursive: true });
    result.subdirs.push({ name: sub, path: subPath, created: !subExists });
  }

  for (const file of scaffoldFiles) {
    const absPath = join(root, file.relPath);
    const exists = existsSync(absPath);
    if (exists) {
      result.files.push({ relPath: file.relPath, absPath, created: false, skipped: "exists" });
      continue;
    }
    if (!dryRun) writeFileSync(absPath, file.content, "utf-8");
    result.files.push({ relPath: file.relPath, absPath, created: true, skipped: null });
  }

  return result;
}
