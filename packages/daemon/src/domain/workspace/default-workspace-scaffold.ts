// V0.3.1 slice 21 onboarding-conveyor: rich narrative content for the
// getting-started mission's two slices (the click-through-to-learn
// teaching surface).
import * as fs from "node:fs";
import * as path from "node:path";
import { GETTING_STARTED_NARRATIVE } from "./getting-started-narrative.js";

type DefaultSlice = {
  id: string;
  /** §1 dot-ID per conventions/scope-and-versioning. Minted into the
   *  slice SPEC frontmatter so the seeded scaffold satisfies the
   *  GA-convention coherence target without needing to round-trip
   *  through `rig scope`. */
  dotId: string;
  title: string;
  status: "active" | "draft";
  objective: string;
};

type DefaultMission = {
  id: string;
  /** §1 mission dot-ID — escape band for non-release missions. */
  dotId: string;
  title: string;
  status: "active" | "draft";
  objective: string;
  slices: DefaultSlice[];
};

// Release-0.3.2 slice 01 (OPR.0.3.2.1) — seeded missions/slices now
// carry §1 dot-IDs in frontmatter so the scaffold coheres with
// `conventions/scope-and-versioning`. `getting-started` is a
// non-release mission → escape band `OPR.99.0.1`; its slices fan out
// as `OPR.99.0.1.<n>` (numbers monotonic, never reused).
const DEFAULT_MISSIONS: DefaultMission[] = [
  {
    id: "getting-started",
    dotId: "OPR.99.0.1",
    title: "Getting Started",
    status: "active",
    objective: "Launch the conveyor starter and learn how OpenRig moves work through queue-backed slices.",
    slices: [
      {
        id: "first-conveyor-run",
        dotId: "OPR.99.0.1.1",
        title: "First Conveyor Run",
        status: "active",
        objective: "Move one small packet through intake, planning, build, review, and close on the conveyor starter.",
      },
      {
        id: "inspect-project-evidence",
        dotId: "OPR.99.0.1.2",
        title: "Inspect Project Evidence",
        status: "draft",
        objective: "Open Project, Queue, Story, and Tests to inspect the evidence created by the first conveyor run.",
      },
    ],
  },
];

export function workspaceScaffoldDirs(): string[] {
  return [
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
      ...mission.slices.flatMap((slice) => [
        `missions/${mission.id}/slices/${slice.id}`,
        `missions/${mission.id}/slices/${slice.id}/proof`,
      ]),
    ]),
  ];
}

function subdirReadmeContent(subdir: string): string {
  switch (subdir) {
    case "missions":
      return "# missions\n\nMissions live here. Each mission owns a `slices/` child folder and appears in the OpenRig TUI.\n\nExpected shape:\n\n```text\nmissions/<mission-name>/SPEC.md\nmissions/<mission-name>/NOTES.md\nmissions/<mission-name>/PROGRESS.md\nmissions/<mission-name>/slices/<slice-name>/SPEC.md\nmissions/<mission-name>/slices/<slice-name>/PROGRESS.md\nmissions/<mission-name>/slices/<slice-name>/PROOF.md\n```\n\nEvery mission and slice SPEC carries an authored `intent:`, advisory sibling build-order `depends_on:` dot-IDs, and a stable dot-ID (`id: OPR.<ver>[.<n>]`). Use `rig scope mission create <name>` and `rig scope slice create <mission> <slug>` to mint conformant artifacts. Folder names are operator-facing slugs; `id:` is the stable handle that survives renames.\n";
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
      return "# dogfood-evidence\n\nProof packets live here. Each proof packet folder is matched to a slice by folder-name tokens and may contain markdown, screenshots, videos, traces, and other verification artifacts.\n";
    default:
      return `# ${subdir}\n`;
  }
}

const WORKSPACE_README = `# OpenRig Workspace

This workspace is file-backed. The OpenRig TUI mirrors this structure:

- \`missions/<mission-id>\` becomes a TUI mission.
- \`missions/<mission-id>/slices/<slice-id>\` becomes a TUI slice.
- Queue items should mention or tag the mission id and slice id so the TUI can attach live work to the right slice.
- \`artifacts/\` is for work products that a slice needs to keep.
- \`evidence/\` is for proof notes and verification summaries.
- \`dogfood-evidence/<proof-packet-id>\` supplies test evidence when the packet id contains the slice id tokens.

Use stable kebab-case names for mission and slice folders. Every mission/slice \`SPEC.md\` carries authored \`intent:\`, advisory sibling build-order \`depends_on:\`, and a stable dot-ID (\`id: OPR.<ver>[.<n>]\`). Mint conformant artifacts via \`rig scope mission create <name>\` and \`rig scope slice create <mission> <slug>\`. Folder names are operator-facing slugs; \`id:\` is the rename-proof handle.
`;

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
missions:
  root: missions
install:
  context: []
  skills: []
# Optional enrichment is added here; absence inherits defaults.
`;

const MISSION_MANIFEST = `schema: openrig.mission/v0alpha1
kind: mission
composition:
  mission_markdown:
    spec: SPEC.md
# Optional team and SDLC sections are added here.
`;

const SLICE_MANIFEST = `schema: openrig.slice/v0alpha1
kind: slice
composition:
  mission: ../../mission.yaml
  slice_markdown:
    spec: SPEC.md
    progress: PROGRESS.md
    proof: PROOF.md
# Optional assignment, SDLC, and evidence sections are added here.
`;

const STEERING_PLACEHOLDER = `---
title: Priority Stack
status: placeholder
---

# OpenRig Priority Stack

This file is a placeholder created by \`rig config init-workspace\`. Edit it
to record your top priorities. The OpenRig TUI reads this file alongside the
work tree.

## Top 3

1. Run the \`conveyor\` starter rig.
2. Move one packet through \`basic-loop\` or \`conveyor\`.
3. Inspect the mission, queue, story, and proof surfaces in the TUI.

## In Motion

(Active slices land here as you push them through the priority rail.)

## Loop State

(Health gates + loop diagnostics land here.)
`;

function missionReadme(mission: DefaultMission): string {
  return `---
id: ${mission.dotId}
title: ${mission.title}
status: ${mission.status}
mission: ${mission.id}
intent: ${JSON.stringify(mission.objective)}
depends_on: []
---

# ${mission.title}

${mission.objective}

## Slices

${mission.slices.map((slice) => `- [${slice.title}](slices/${slice.id}/SPEC.md)`).join("\n")}
`;
}

function missionProgress(mission: DefaultMission): string {
  return `---
title: ${mission.title} Progress
status: ${mission.status}
mission: ${mission.id}
---

# ${mission.title} Progress

## Acceptance

- [ ] Keep mission SPEC current.
- [ ] Keep active slices queue-backed with mission and slice ids.
`;
}

function sliceReadme(mission: DefaultMission, slice: DefaultSlice): string {
  // V0.3.1 slice 21: getting-started slices ship rich narrative
  // content that teaches both "what a conveyor is" and "what each
  // tab does". Other slices keep the boilerplate.
  const narrative = GETTING_STARTED_NARRATIVE[slice.id];
  if (narrative) {
    return `---
id: ${slice.dotId}
title: ${slice.title}
status: ${slice.status}
mission: ${mission.id}
rail-item: ${mission.id}
slice: ${slice.id}
intent: ${JSON.stringify(slice.objective)}
depends_on: []
---

${narrative.readme}`;
  }
  return `---
id: ${slice.dotId}
title: ${slice.title}
status: ${slice.status}
mission: ${mission.id}
rail-item: ${mission.id}
slice: ${slice.id}
intent: ${JSON.stringify(slice.objective)}
depends_on: []
---

# ${slice.title}

## Intent

${slice.objective}

## Mini-requirements

1. The work is visible in the Project slice and its queue items link back to \`${slice.id}\`.

## Proof contract

- [ ] The work is visible in the Project slice — captured from this SPEC.md.

## Queue Mapping

Queue items for this slice should mention or tag:

- mission: \`${mission.id}\`
- slice: \`${slice.id}\`

This lets Project attach queue activity to the slice story, queue, tests, and topology tabs.
`;
}

/** V0.3.1 slice 21: getting-started slices emit a timeline.md that
 *  the slice Story tab renders via the slice-06 useSliceTimelineMarkdown
 *  hook. Returns null when no narrative is defined for the slice id
 *  (default mission slices don't ship a timeline). */
function sliceTimeline(mission: DefaultMission, slice: DefaultSlice): string | null {
  const narrative = GETTING_STARTED_NARRATIVE[slice.id];
  if (!narrative) return null;
  return narrative.timeline;
}

function sliceProgress(mission: DefaultMission, slice: DefaultSlice): string {
  // V0.3.1 slice 21: getting-started slices ship the worked-example
  // PROGRESS narrative (acceptance criteria for a mocked conveyor run
  // / inspection); other slices keep the boilerplate.
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

## Acceptance

- [ ] Define the next concrete packet.
- [ ] Attach queue work to this slice id.
- [ ] Capture proof or notes before closing.
`;
}

function sliceProof(slice: DefaultSlice): string {
  return `# PROOF — ${slice.dotId} ${slice.title}

> **WHO/WHEN:** the impl/QA pair that worked the slice, at slice-close — a slice is NOT done until this file exists and every \`SPEC.md\` proof-contract item has evidence (mapped 1:1, artifacts under \`proof/\`). See the \`mission-slice-sop\` skill + the conventions SSOT (\`docs/reference/sdlc-conventions.md\` in the repo, \`$OPENRIG_HOME/reference/sdlc-conventions.md\` on an installed package).
>
> **HOW (the drop verb, not hand-placement):** put media files under \`proof/\`, then ATTACH them with \`rig proof add ${slice.dotId} --artifact-type qa --verdict PASS --candidate-sha <tip> --money-evidence "<one line>" --evidences "1" --media "screenshot-01.png"\` — the drop writes the C1 header the Living Notes DELIVERED pairing joins on. Hand-placing files without a drop leaves the deliverable unpaired and \`unverified\`.

Closed by: <seat>   Date: <date>   Verdict: <pass | pass-with-residue | ...>

## What this proves

<1-3 sentences: the claim the slice made, now demonstrated>

## Artifacts (media in proof/)

Dropped via \`rig proof add … --evidences … --media …\` (one drop per verdict; media attached, never only hand-listed):

- proof/screenshot-01.png — <what it shows>
- proof/capture-behavior.gif — <what it shows>
- proof/command-output.txt — <what it proves>

## Residue / caveats (if any)

<documented residue: what's not covered + where it's tracked>
`;
}

interface NotesOpts {
  mission_id: string;
  mission_name: string;
  created_date: string;
}

function applyNotesPlaceholders(content: string, opts: NotesOpts): string {
  return content
    .replace(/\{\{mission_id\}\}/g, opts.mission_id)
    .replace(/\{\{mission_name\}\}/g, opts.mission_name)
    .replace(/\{\{created_date\}\}/g, opts.created_date);
}

const NOTES_BUILT_IN = `---
mission: {{mission_id}}
name: {{mission_name}}
created: {{created_date}}
---

# Notes — {{mission_name}}

Context and observations that help the mission but do not change its
\`SPEC.md\` contract or \`PROGRESS.md\` acceptance checklist belong here.

## Notes

- {{created_date}} — mission scaffolded.
`;

/** Current NOTES.md renderer. The retired environment variable remains a
 * readable fallback so existing installs do not break during the rename. */
export function renderDaemonNotes(opts: NotesOpts): string {
  const current = process.env.OPENRIG_NOTES_TEMPLATE_PATH;
  const legacy = process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH;
  const selected = current?.trim() ? current : legacy?.trim() ? legacy : null;
  if (selected) {
    const variable = current?.trim()
      ? "OPENRIG_NOTES_TEMPLATE_PATH"
      : "OPENRIG_MISSION_NOTES_TEMPLATE_PATH";
    const absPath = path.resolve(selected.trim());
    if (!fs.existsSync(absPath)) {
      throw new Error(
        `${variable} points at "${selected}", which does not exist. ` +
          "NOTES.md not scaffolded. Set OPENRIG_NOTES_TEMPLATE_PATH to an absolute readable file, or unset the override.",
      );
    }
    return applyNotesPlaceholders(fs.readFileSync(absPath, "utf8"), opts);
  }
  return applyNotesPlaceholders(NOTES_BUILT_IN, opts);
}

export function workspaceScaffoldFiles(): Array<{ relPath: string; content: string }> {
  const files: Array<{ relPath: string; content: string }> = [
    { relPath: "README.md", content: WORKSPACE_README },
    { relPath: "SPEC.md", content: PROJECT_SPEC },
    { relPath: "project.yaml", content: PROJECT_MANIFEST },
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
      { relPath: `missions/${mission.id}/SPEC.md`, content: missionReadme(mission) },
      { relPath: `missions/${mission.id}/mission.yaml`, content: MISSION_MANIFEST },
      { relPath: `missions/${mission.id}/PROGRESS.md`, content: missionProgress(mission) },
      {
        relPath: `missions/${mission.id}/NOTES.md`,
        content: renderDaemonNotes({
          mission_id: mission.dotId,
          mission_name: mission.title,
          created_date: new Date().toISOString().slice(0, 10),
        }),
      },
    );
    for (const slice of mission.slices) {
      files.push(
        { relPath: `missions/${mission.id}/slices/${slice.id}/SPEC.md`, content: sliceReadme(mission, slice) },
        { relPath: `missions/${mission.id}/slices/${slice.id}/slice.yaml`, content: SLICE_MANIFEST },
        { relPath: `missions/${mission.id}/slices/${slice.id}/PROGRESS.md`, content: sliceProgress(mission, slice) },
        { relPath: `missions/${mission.id}/slices/${slice.id}/PROOF.md`, content: sliceProof(slice) },
      );
      // V0.3.1 slice 21: getting-started slices ship a timeline.md
      // so the Story tab renders the worked-example narrative via
      // slice-06's useSliceTimelineMarkdown hook.
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
