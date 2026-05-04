// User Settings v0 — `rig config init-workspace` operator-explicit scaffolding.
//
// Creates the 5-subdir default workspace at ~/.openrig/workspace/ (or a
// caller-supplied --root). Operator-explicit per founder safety stop:
// never auto-runs on `rig setup` / `rig daemon start` / first `rig up`.
//
// Behavior:
//   - Reads workspace.root setting (default ~/.openrig/workspace/).
//   - Creates the 5 canonical subdirs: slices/ steering/ progress/ field-notes/ specs/.
//   - Drops a 1-paragraph README.md in each subdir.
//   - Drops a placeholder steering/STEERING.md.
//   - --dry-run: report what would be created without acting.
//   - --force: overwrite existing files (NOT directories — never deletes
//     operator content).
//   - Idempotent without --force: existing-dir + existing-readme is a no-op.

import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../config-store.js";

export interface InitWorkspaceOpts {
  root?: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface InitWorkspaceResult {
  root: string;
  /** True when this run would (or did) create the root dir; false if root existed. */
  rootCreated: boolean;
  subdirs: Array<{ name: string; path: string; created: boolean }>;
  files: Array<{ relPath: string; absPath: string; created: boolean; skipped: "exists" | null }>;
  /** True when --dry-run; nothing was actually written. */
  dryRun: boolean;
}

const SUBDIRS = ["slices", "steering", "progress", "field-notes", "specs"] as const;

function readmeContent(subdir: string): string {
  switch (subdir) {
    case "slices":
      return "# slices\n\nYour slice authoring workspace. OpenRig's Slice Story View browses\nthis directory by default. Each slice lives in its own subdirectory\nwith README.md + IMPLEMENTATION-PRD.md + dogfood-evidence.\n";
    case "steering":
      return "# steering\n\nThe `STEERING.md` priority-stack lives here. OpenRig's Steering surface\ncomposes the 6-panel view (priority stack, roadmap rail, in-motion,\nlane rails, loop state, health gates) from this file.\n";
    case "progress":
      return "# progress\n\nPROGRESS.md tree. OpenRig's Progress browse view scans this directory\nrecursively (max depth 6) for PROGRESS.md files and renders them as a\nhierarchical tree.\n";
    case "field-notes":
      return "# field-notes\n\nOperator field notes. Free-form markdown notes from your daily work.\nOpenRig's UI surfaces these alongside slices for context.\n";
    case "specs":
      return "# specs\n\nWorkspace specs (rig specs / agent specs / workflow specs / context\npacks). OpenRig's Spec Library browses this directory alongside the\ndaemon's bundled built-in specs.\n";
    default:
      return `# ${subdir}\n`;
  }
}

const STEERING_PLACEHOLDER = `---
title: Priority Stack
status: placeholder
---

# OpenRig Priority Stack

This file is a placeholder created by \`rig config init-workspace\`. Edit
it to record your top 3 priorities. OpenRig's Steering surface composes
the 6-panel view from this file alongside your PROGRESS.md tree.

## Top 3

1. <priority one>
2. <priority two>
3. <priority three>

## In Motion

(Active slices land here as you push them through the priority rail.)

## Loop State

(Health gates + loop diagnostics land here.)
`;

export function initWorkspaceCommand(configPath?: string): Command {
  const cmd = new Command("init-workspace")
    .description("Scaffold the default workspace at ~/.openrig/workspace/ with 5 subdirs")
    .option("--root <path>", "Override workspace root (default: workspace.root setting)")
    .option("--force", "Overwrite existing scaffolded files (does NOT remove directories)")
    .option("--dry-run", "Show what would be created without writing")
    .option("--json", "JSON output")
    .action((opts: InitWorkspaceOpts) => {
      try {
        const result = runInitWorkspace({ ...opts, configPath });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.dryRun) console.log(`(dry-run) workspace root: ${result.root}`);
          else console.log(`workspace root: ${result.root}`);
          for (const sub of result.subdirs) {
            console.log(`  ${sub.created ? "+" : " "} ${sub.name}/`);
          }
          for (const f of result.files) {
            console.log(`  ${f.created ? "+" : " "} ${f.relPath}${f.skipped ? `  (skipped: ${f.skipped})` : ""}`);
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
  const force = !!opts.force;

  const rootExists = existsSync(root);
  const result: InitWorkspaceResult = {
    root,
    rootCreated: !rootExists,
    subdirs: [],
    files: [],
    dryRun,
  };

  if (!rootExists && !dryRun) mkdirSync(root, { recursive: true });

  for (const sub of SUBDIRS) {
    const subPath = join(root, sub);
    const subExists = existsSync(subPath);
    if (!subExists && !dryRun) mkdirSync(subPath, { recursive: true });
    result.subdirs.push({ name: sub, path: subPath, created: !subExists });

    // README.md per subdir.
    const readmePath = join(subPath, "README.md");
    const readmeExists = existsSync(readmePath);
    if (readmeExists && !force) {
      result.files.push({ relPath: `${sub}/README.md`, absPath: readmePath, created: false, skipped: "exists" });
    } else {
      if (!dryRun) writeFileSync(readmePath, readmeContent(sub), "utf-8");
      result.files.push({ relPath: `${sub}/README.md`, absPath: readmePath, created: true, skipped: null });
    }
  }

  // steering/STEERING.md placeholder (dropped at the steering subdir).
  const steeringPath = join(root, "steering", "STEERING.md");
  const steeringExists = existsSync(steeringPath);
  if (steeringExists && !force) {
    result.files.push({ relPath: "steering/STEERING.md", absPath: steeringPath, created: false, skipped: "exists" });
  } else {
    if (!dryRun) writeFileSync(steeringPath, STEERING_PLACEHOLDER, "utf-8");
    result.files.push({ relPath: "steering/STEERING.md", absPath: steeringPath, created: true, skipped: null });
  }

  return result;
}
