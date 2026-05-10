// User Settings v0 — `rig config init-workspace` workspace scaffolding.
//
// Creates the mission-aware default workspace at ~/.openrig/workspace/ (or a
// caller-supplied --root). The same scaffold is also used idempotently by
// daemon startup so a fresh install has a browsable Project workspace before
// the user discovers the explicit command.
//
// Behavior:
//   - Reads workspace.root setting (default ~/.openrig/workspace/).
//   - Creates canonical subdirs: missions/ progress/ field-notes/ specs/ dogfood-evidence/.
//   - Seeds two example missions with multiple slices.
//   - Drops workspace README.md + STEERING.md.
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

type DefaultSlice = {
  id: string;
  title: string;
  status: "active" | "draft";
  objective: string;
};

type DefaultMission = {
  id: string;
  title: string;
  status: "active" | "draft";
  objective: string;
  slices: DefaultSlice[];
};

const DEFAULT_MISSIONS: DefaultMission[] = [
  {
    id: "getting-started",
    title: "Getting Started",
    status: "active",
    objective: "Launch the conveyor starter and learn how OpenRig moves work through queue-backed slices.",
    slices: [
      {
        id: "first-conveyor-run",
        title: "First Conveyor Run",
        status: "active",
        objective: "Move one small packet through intake, planning, build, review, and close on the conveyor starter.",
      },
      {
        id: "inspect-project-evidence",
        title: "Inspect Project Evidence",
        status: "draft",
        objective: "Open Project, Queue, Story, and Tests to inspect the evidence created by the first conveyor run.",
      },
    ],
  },
];

const WORKSPACE_DIRS = [
  "missions",
  "artifacts",
  "evidence",
  "progress",
  "field-notes",
  "specs",
  "dogfood-evidence",
  ...DEFAULT_MISSIONS.flatMap((mission) => [
    `missions/${mission.id}`,
    `missions/${mission.id}/slices`,
    ...mission.slices.map((slice) => `missions/${mission.id}/slices/${slice.id}`),
  ]),
] as const;

function subdirReadmeContent(subdir: string): string {
  switch (subdir) {
    case "missions":
      return "# missions\n\nProject missions live here. Each mission folder maps to one Project mission in the UI and owns a `slices/` child folder.\n\nExpected shape:\n\n```text\nmissions/<mission-id>/README.md\nmissions/<mission-id>/PROGRESS.md\nmissions/<mission-id>/slices/<slice-id>/README.md\n```\n";
    case "artifacts":
      return "# artifacts\n\nWork products live here: plans, drafts, generated outputs, and other files that a slice may reference before closure.\n";
    case "evidence":
      return "# evidence\n\nHuman-readable verification notes live here. Use this for compact proof summaries that are not tied to a screenshot or video packet.\n";
    case "progress":
      return "# progress\n\nPROGRESS.md tree. OpenRig's Progress browse view scans this directory recursively for PROGRESS.md files and renders them as a hierarchical tree.\n";
    case "field-notes":
      return "# field-notes\n\nOperator field notes. Free-form markdown notes from your daily work. OpenRig surfaces these alongside missions and slices for context.\n";
    case "specs":
      return "# specs\n\nWorkspace specs (rig specs / agent specs / workflow specs / context packs / skills). OpenRig's Library browses this directory alongside bundled specs.\n";
    case "dogfood-evidence":
      return "# dogfood-evidence\n\nProof packets live here. Each proof packet folder is matched to a Project slice by folder-name tokens and may contain markdown, screenshots, videos, traces, and other verification artifacts.\n";
    default:
      return `# ${subdir}\n`;
  }
}

const WORKSPACE_README = `# OpenRig Workspace

This workspace is file-backed. The Project UI mirrors this structure:

- \`missions/<mission-id>\` becomes a Project mission.
- \`missions/<mission-id>/slices/<slice-id>\` becomes a Project slice.
- Queue items should mention or tag the mission id and slice id so Project can attach live work to the right slice.
- \`artifacts/\` is for work products that a slice needs to keep.
- \`evidence/\` is for proof notes and verification summaries.
- \`dogfood-evidence/<proof-packet-id>\` becomes Tests proof when the packet id contains the slice id tokens.

Use stable kebab-case ids for mission and slice folders. Keep slice ids unique inside the workspace.
`;

const STEERING_PLACEHOLDER = `---
title: Priority Stack
status: placeholder
---

# OpenRig Priority Stack

This file is a placeholder created by \`rig config init-workspace\`. Edit it
to record your top priorities. OpenRig's Steering surface reads this file
alongside your Project workspace.

## Top 3

1. Run the \`conveyor\` starter rig.
2. Move one packet through \`basic-loop\` or \`conveyor\`.
3. Inspect the Project, Queue, Story, and Tests surfaces.

## In Motion

(Active slices land here as you push them through the priority rail.)

## Loop State

(Health gates + loop diagnostics land here.)
`;

function missionReadme(mission: DefaultMission): string {
  return `---
title: ${mission.title}
status: ${mission.status}
mission: ${mission.id}
---

# ${mission.title}

${mission.objective}

## Slices

${mission.slices.map((slice) => `- [${slice.title}](slices/${slice.id}/README.md)`).join("\n")}
`;
}

function missionProgress(mission: DefaultMission): string {
  return `---
title: ${mission.title} Progress
status: ${mission.status}
mission: ${mission.id}
---

# ${mission.title} Progress

- [ ] Keep mission README current.
- [ ] Keep active slices queue-backed with mission and slice ids.
`;
}

function sliceReadme(mission: DefaultMission, slice: DefaultSlice): string {
  return `---
title: ${slice.title}
status: ${slice.status}
mission: ${mission.id}
rail-item: ${mission.id}
slice: ${slice.id}
---

# ${slice.title}

${slice.objective}

## Queue Mapping

Queue items for this slice should mention or tag:

- mission: \`${mission.id}\`
- slice: \`${slice.id}\`

This lets Project attach queue activity to the slice story, queue, tests, and topology tabs.
`;
}

function sliceProgress(mission: DefaultMission, slice: DefaultSlice): string {
  return `---
title: ${slice.title} Progress
status: ${slice.status}
mission: ${mission.id}
rail-item: ${mission.id}
slice: ${slice.id}
---

# ${slice.title} Progress

- [ ] Define the next concrete packet.
- [ ] Attach queue work to this slice id.
- [ ] Capture proof or notes before closing.
`;
}

function slicePrd(mission: DefaultMission, slice: DefaultSlice): string {
  return `---
title: ${slice.title} Implementation Notes
status: ${slice.status}
mission: ${mission.id}
rail-item: ${mission.id}
slice: ${slice.id}
---

# ${slice.title} Implementation Notes

## Goal

${slice.objective}

## Acceptance

- [ ] The work is visible in the Project slice.
- [ ] Queue items include enough body or tag context to link back to \`${slice.id}\`.
- [ ] Any proof artifacts are referenced from the slice before closure.
`;
}

export function workspaceScaffoldDirs(): string[] {
  return [...WORKSPACE_DIRS];
}

export function workspaceScaffoldFiles(): Array<{ relPath: string; content: string }> {
  const files: Array<{ relPath: string; content: string }> = [
    { relPath: "README.md", content: WORKSPACE_README },
    { relPath: "STEERING.md", content: STEERING_PLACEHOLDER },
    { relPath: "missions/README.md", content: subdirReadmeContent("missions") },
    { relPath: "artifacts/README.md", content: subdirReadmeContent("artifacts") },
    { relPath: "evidence/README.md", content: subdirReadmeContent("evidence") },
    { relPath: "progress/README.md", content: subdirReadmeContent("progress") },
    { relPath: "field-notes/README.md", content: subdirReadmeContent("field-notes") },
    { relPath: "specs/README.md", content: subdirReadmeContent("specs") },
    { relPath: "dogfood-evidence/README.md", content: subdirReadmeContent("dogfood-evidence") },
  ];
  for (const mission of DEFAULT_MISSIONS) {
    files.push(
      { relPath: `missions/${mission.id}/README.md`, content: missionReadme(mission) },
      { relPath: `missions/${mission.id}/PROGRESS.md`, content: missionProgress(mission) },
    );
    for (const slice of mission.slices) {
      files.push(
        { relPath: `missions/${mission.id}/slices/${slice.id}/README.md`, content: sliceReadme(mission, slice) },
        { relPath: `missions/${mission.id}/slices/${slice.id}/PROGRESS.md`, content: sliceProgress(mission, slice) },
        { relPath: `missions/${mission.id}/slices/${slice.id}/IMPLEMENTATION-PRD.md`, content: slicePrd(mission, slice) },
      );
    }
  }
  return files;
}

export function initWorkspaceCommand(configPath?: string): Command {
  const cmd = new Command("init-workspace")
    .description("Scaffold the default workspace at ~/.openrig/workspace/ with mission/slice folders")
    .option("--root <path>", "Override workspace root (default: workspace.root setting)")
    .option("--force", "Overwrite existing scaffolded files (does NOT remove directories)")
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

  for (const sub of workspaceScaffoldDirs()) {
    const subPath = join(root, sub);
    const subExists = existsSync(subPath);
    if (!subExists && !dryRun) mkdirSync(subPath, { recursive: true });
    result.subdirs.push({ name: sub, path: subPath, created: !subExists });
  }

  for (const file of workspaceScaffoldFiles()) {
    const absPath = join(root, file.relPath);
    const exists = existsSync(absPath);
    if (exists && !force) {
      result.files.push({ relPath: file.relPath, absPath, created: false, skipped: "exists" });
    } else {
      if (!dryRun) writeFileSync(absPath, file.content, "utf-8");
      result.files.push({ relPath: file.relPath, absPath, created: true, skipped: null });
    }
  }

  return result;
}
