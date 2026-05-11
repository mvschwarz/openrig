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

// V0.3.1 slice 21 onboarding-conveyor — narrative content for the
// getting-started mission's two slices. PARITY CONTRACT with
// `packages/daemon/src/domain/workspace/getting-started-narrative.ts`:
// the daemon side is the canonical source; this CLI-side mirror MUST
// stay byte-identical. The narrative-parity test in
// `packages/daemon/test/getting-started-narrative-parity.test.ts`
// (added in this slice) asserts byte-identity by reading both this
// file and the daemon module — if either drifts, the test fails.
// If you update content here, update the daemon mirror in lockstep.

const FIRST_CONVEYOR_RUN_README = `# First Conveyor Run

Welcome to OpenRig. This is the first slice in your getting-started mission. It exists to teach you what a **conveyor run** is + how OpenRig moves work through a multi-agent topology.

## What a conveyor run is

A **conveyor** is OpenRig's central work-movement primitive. One conveyor run = one complete flow of work through your topology:

1. **Slice declared** — operator (you) or an agent declares a slice with intent + acceptance criteria
2. **Work routed** — orchestrator picks the slice up + routes it to the right agent
3. **Agents collaborate** — work moves agent-to-agent via durable handoffs (queue items)
4. **Evidence accumulates** — each step leaves a trail: commits, files, proof packets, screenshots
5. **Slice closes** — acceptance criteria met; orchestrator routes the result back

You're looking at a mocked conveyor run RIGHT NOW. The other tabs (Story / Progress / Artifacts / Tests / Queue / Topology) each show a different slice of this same run.

## Walking the tabs

- **Overview** (you're here) — read what a slice intends + how to use the rest of the tabs
- **Story** — narrative timeline of what happened, beat by beat
- **Progress** — acceptance checklist; what's done, what's pending
- **Artifacts** — files produced, commits, proof packets — the durable evidence trail
- **Tests** — pass/fail summaries + screenshots + verification proof
- **Queue** — operational qitems showing how work moved between agents
- **Topology** — the rig graph; which agents touched this slice + which edges fired

## Click through

Try them in order. Each tab teaches itself.
`;

const FIRST_CONVEYOR_RUN_TIMELINE = `# Story — First Conveyor Run

## 2026-04-15 09:00 — Slice declared

Operator request: "Build a CLI tool that lints todo lists." Slice declared in \`getting-started/slices/first-conveyor-run/\`. Acceptance: \`tdl lint <file>\` exits non-zero on malformed entries.

## 09:02 — Orchestrator routes

\`orch-lead@getting-started\` picks up the slice. Routes to \`driver@getting-started\` via \`rig queue handoff\`. Driver receives nudge; opens IMPL-PRD; reads acceptance.

## 09:05 — Driver picks up

Driver claims qitem. Reads slice scope. Surveys existing tdl repo (this is a worked example — imagine the repo is real). Plans: parse YAML; validate entries; exit code per finding.

## 09:30 — First commit

\`feat(lint): parse + validate todo entries\` — driver commits 4 files. Stream event emitted; visible in Artifacts tab.

## 10:15 — Driver hands to reviewer

Acceptance met locally. Driver hands off to \`reviewer@getting-started\`. Reviewer opens diff; reads tests.

## 10:25 — Reviewer flags concern

"Edge case: what about UTF-8 entries with combining characters?" Hands back to driver as \`concerning\`.

## 10:40 — Driver addresses

Driver fixes UTF-8 handling. Re-runs tests; all pass. Hands back.

## 11:00 — Reviewer accepts

\`accept\` decision; closes qitem with \`closure-reason: handed_off_to orch-lead\`. Conveyor proceeds.

## 11:05 — Slice ships

Orchestrator merges. Proof packet generated. Slice marked SHIPPED.

---

**What you just read**: one conveyor run from declaration to ship. ~2 hours wall-clock; 3 agents involved; 1 handoff with concern + remediation; 5 stream events; 1 proof packet.

The Story tab shows this kind of narrative for any real slice. Driver-authored \`timeline.md\` files live in each slice folder; this is yours to read + your operator's to update as work moves.
`;

const FIRST_CONVEYOR_RUN_PROGRESS = `---
title: First Conveyor Run Progress
status: active
mission: getting-started
rail-item: getting-started
slice: first-conveyor-run
---

# Progress — First Conveyor Run

## Acceptance criteria

- [x] Parse YAML todo entries
- [x] Validate per-entry shape (id, title, status, due-date)
- [x] Exit non-zero on malformed entries
- [x] Handle UTF-8 entries with combining characters
- [x] Tests pass (12/12)
- [x] Reviewer accepts
- [x] Slice merged

## Status: SHIPPED

This was a mocked conveyor run — no real code was produced. But the Progress tab works the same way for real work: as acceptance criteria are met, boxes get checked; the operator can scan at a glance whether the slice is on track.

## How the Progress tab works

The tab renders the slice's \`PROGRESS.md\` markdown file. Driver updates it as work progresses. Operator scans it during walks. Founder reviews at slice closure.

Try writing one for a real slice you start. It's just markdown; live updates appear here.
`;

const INSPECT_PROJECT_EVIDENCE_README = `# Inspect Project Evidence

The previous slice (First Conveyor Run) showed you what a conveyor run looks like as it happens. This slice teaches you how to inspect the evidence after a run completes.

## Why inspect evidence?

In OpenRig, agents work autonomously. The operator (you) doesn't watch every keystroke. Instead, the operator:

1. Declares slices with clear acceptance
2. Routes them to agents
3. Inspects evidence when slices close

The Artifacts + Tests + Queue + Topology tabs are your inspection surface. They show you what happened, with enough detail to:

- Verify the acceptance was actually met
- Spot subtle issues a passing test might miss
- Build trust in the agents over time

## Walking the tabs

- **Overview** — you're here; learn what to look for
- **Story** — read the narrative of what happened (high-level)
- **Progress** — acceptance status at a glance
- **Artifacts** — the durable evidence: files, commits, proof packets. **THIS IS THE TAB YOU LEARN MOST FROM.**
- **Tests** — pass/fail + screenshots + verification proof
- **Queue** — who handed what to whom (audit trail of decisions)
- **Topology** — which agents touched this; which edges fired

## Key inspection skills

When walking a finished slice:

1. **Read the Story** for context — what was the operator trying to do?
2. **Check Progress** — did acceptance actually pass? Any TODO boxes?
3. **Open Artifacts → Files** — sample-read 2-3 files; does the code match what the Story claimed?
4. **Open Tests → Proof packets** — do screenshots actually show what was claimed?
5. **Read Queue** — were there concerning decisions? Hand-offs to escalation?
6. **Skim Topology** — were unexpected agents involved?

Trust comes from repeated successful inspections, not from a single proof packet.
`;

const INSPECT_PROJECT_EVIDENCE_TIMELINE = `# Story — Inspect Project Evidence

This slice mirrors the previous one (First Conveyor Run). The same agents shipped the same work. But this view is from the inspector's angle, not the runner's.

## 11:10 — Operator opens project

Operator (you, in the real world) opens \`/project/slice/first-conveyor-run\` after the slice ships. First read: the Progress tab. All boxes checked.

## 11:12 — Read Story

Operator reads the Story narrative. Notices the reviewer's UTF-8 concern + driver's remediation. Confidence-building: there was friction, friction was caught, friction was addressed.

## 11:15 — Open Artifacts

Operator clicks Artifacts. Sees 4 commits, 5 files, 1 proof packet, 2 screenshots. Opens commit \`feat(lint): parse + validate todo entries\`. Reads the diff.

## 11:18 — Read tests

Operator opens Tests tab. 12/12 passing. Opens the proof packet — screenshot shows CLI output \`Error: malformed entry at line 3\`. Visually verifies the acceptance was met.

## 11:22 — Skim Queue

Operator scrolls Queue. 4 qitems in chronological order. Sees the \`concerning\` decision + subsequent \`accept\`. Confidence reinforced.

## 11:25 — Mark complete

Operator marks slice acceptance complete. Closes the inspection.

---

**What you just read**: a clean inspection in ~15 minutes. Operator builds trust through the evidence trail. This is the OpenRig usage pattern at scale: declare → route → inspect.
`;

const INSPECT_PROJECT_EVIDENCE_PROGRESS = `---
title: Inspect Project Evidence Progress
status: active
mission: getting-started
rail-item: getting-started
slice: inspect-project-evidence
---

# Progress — Inspect Project Evidence

## Inspection checklist

- [x] Read Story (context: what was being done)
- [x] Check Progress (acceptance status)
- [x] Sample-read Artifacts files
- [x] Verify Tests proof packets visually
- [x] Skim Queue for concerning decisions
- [x] Skim Topology for unexpected agents

## Status: COMPLETE

This was a mocked inspection — a worked example of the inspection workflow.

## How to apply this

For any real slice that ships in YOUR project: open the slice page, walk the tabs in this order, check each box mentally. Over time you'll develop instincts for what passes the smell test vs what needs deeper investigation.
`;

const GETTING_STARTED_NARRATIVE: Record<
  string,
  { readme: string; timeline: string; progress: string }
> = {
  "first-conveyor-run": {
    readme: FIRST_CONVEYOR_RUN_README,
    timeline: FIRST_CONVEYOR_RUN_TIMELINE,
    progress: FIRST_CONVEYOR_RUN_PROGRESS,
  },
  "inspect-project-evidence": {
    readme: INSPECT_PROJECT_EVIDENCE_README,
    timeline: INSPECT_PROJECT_EVIDENCE_TIMELINE,
    progress: INSPECT_PROJECT_EVIDENCE_PROGRESS,
  },
};

function sliceReadme(mission: DefaultMission, slice: DefaultSlice): string {
  // V0.3.1 slice 21: getting-started slices ship rich narrative.
  const narrative = GETTING_STARTED_NARRATIVE[slice.id];
  if (narrative) {
    return `---
title: ${slice.title}
status: ${slice.status}
mission: ${mission.id}
rail-item: ${mission.id}
slice: ${slice.id}
---

${narrative.readme}`;
  }
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

function sliceTimeline(mission: DefaultMission, slice: DefaultSlice): string | null {
  const narrative = GETTING_STARTED_NARRATIVE[slice.id];
  return narrative ? narrative.timeline : null;
}

function sliceProgress(mission: DefaultMission, slice: DefaultSlice): string {
  const narrative = GETTING_STARTED_NARRATIVE[slice.id];
  if (narrative) return narrative.progress;
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
      // V0.3.1 slice 21: getting-started slices ship timeline.md.
      const timeline = sliceTimeline(mission, slice);
      if (timeline) {
        files.push({
          relPath: `missions/${mission.id}/slices/${slice.id}/timeline.md`,
          content: timeline,
        });
      }
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
