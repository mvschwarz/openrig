// V0.3.1 slice 21 onboarding-conveyor: rich narrative content for the
// getting-started mission's two slices (the click-through-to-learn
// teaching surface).
import * as fs from "node:fs";
import * as path from "node:path";
import { GETTING_STARTED_NARRATIVE } from "./getting-started-narrative.js";

type DefaultSlice = {
  id: string;
  /** §1 dot-ID per conventions/scope-and-versioning. Minted into the
   *  slice README frontmatter so the seeded scaffold satisfies the
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
      ...mission.slices.map((slice) => `missions/${mission.id}/slices/${slice.id}`),
    ]),
  ];
}

function subdirReadmeContent(subdir: string): string {
  switch (subdir) {
    case "missions":
      return "# missions\n\nProject missions live here. Each mission folder maps to one Project mission in the UI and owns a `slices/` child folder.\n\nExpected shape:\n\n```text\nmissions/<mission-name>/README.md\nmissions/<mission-name>/PROGRESS.md\nmissions/<mission-name>/slices/<slice-name>/README.md\n```\n\nEvery mission and slice README carries a stable dot-ID in its frontmatter (`id: OPR.<ver>[.<n>]`) per the scope-and-versioning convention. Use `rig scope mission create <name>` and `rig scope slice create <mission> <slug>` to mint conformant artifacts; the CLI handles the dot-ID + auto-numbering for you. The folder name is the operator-facing slug; the `id:` is the stable handle that survives renames.\n";
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

Use stable kebab-case names for mission and slice folders. Every mission/slice README also carries a stable dot-ID in its frontmatter (\`id: OPR.<ver>[.<n>]\`) per the \`scope-and-versioning\` convention; mint conformant artifacts via \`rig scope mission create <name>\` and \`rig scope slice create <mission> <slug>\`. Folder names are operator-facing slugs; the \`id:\` is the rename-proof handle.
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
id: ${mission.dotId}
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

// FR-5e A1 (daemon-side symmetry) — MISSION_NOTES template +
// rendering for the daemon's `/api/config/init-workspace` route so
// UI-driven init lands the same scaffold as CLI-driven init. The
// template content is duplicated here from
// packages/cli/src/lib/scope-templates/mission-notes.md to keep the
// daemon side dependency-free of the cli package; a parity test in
// getting-started-narrative-parity.test.ts asserts CLI + daemon emit
// byte-identical MISSION_NOTES content given the same opts. Same
// env-var-pivot pattern the CLI surface honors:
// OPENRIG_MISSION_NOTES_TEMPLATE_PATH > built-in.
const MISSION_NOTES_BUILT_IN = `---
mission: {{mission_id}}
name: {{mission_name}}
status: active
authored: {{created_date}}
last-updated: {{created_date}}
---

# Mission Notes — {{mission_name}}

> Read the frontmatter \`last-updated\` first. If stale relative to runtime,
> treat this file as \`provisional\` and re-verify before relying on it.
> Pointer-first by design — index durable canonical artifacts; don't duplicate
> them (duplication is the stale-breadcrumb failure mode this convention
> exists to kill).

## §1. Top-of-mind context

(Current most-load-bearing state — gates, open scope-decisions, in-flight
surprises. Updated by anyone when material changes. Keep to 5-15 lines.)

## §2. Active workstreams + drivers + tips

(Per-workstream rows. THIS SECTION IS THE MISSION CODEMAP. Each row:
state / driver / branch+tip-SHA / latest blocker or ACK.)

- (workstream-id) — state — driver — tip-SHA — blocker/ACK

## §3. Open scope-decisions

(Labeled gates the operator owns. Per gate: where the gate is, what's needed,
who routed.)

- OQ-1: (decision needed) — gate at <artifact-path> — surfaced by <seat>

## §4. Slice inventory

(Full table of slices on this mission.)

| # | slice | state | driver | blocker |
|---|---|---|---|---|

## §5. Pending dispatches

(Next-go items waiting on driver availability or convergence. Immediately-ready
set, not full backlog.)

## §6. Ledgers

(Mission-specific shared ledgers: release version + tag, SC counts, cumulative
deltas, etc.)

## §7. Banked memories that apply here

(Bulleted: banked-feedback / banked-project memories load-bearing on restore
for this mission. Ones learned during this mission go into the same list.)

## §8. Convention pointers

(Which banked conventions this mission inherits. Cross-reference each by path.
This section is the principles/conventions inheritance surface for the mission.)

- \`conventions/mission-notes/README.md\` — this convention (apply on every restore)

## §9. Reconstruction protocol

(Commands to run after compaction or for onboarding. Refresh as the mission's
restore-needs evolve.)

1. \`rig whoami --json\` — confirm seat identity
2. Read this file's §1 + your §A-§X section + this §9
3. Read \`missions/{{mission_id}}/README.md\` for mission scope
4. Read \`missions/{{mission_id}}/PROGRESS.md\` for delivery state
5. \`rig queue list --destination <your-session>\` — your durable inbox
6. State "restored from {{mission_id}}; resumed at <action>" before acting

## §10. What NOT to reconstruct

(Explicit pruning — completed slices / merged commits / closed ACK packets are
recoverable on demand and don't need to be in working memory. Name them to
free attention.)

## §A. <first-seat>@<rig> notes

(First seat's notes. Pattern: append cont.N entries with date + state of the
world from this seat's perspective. Latest = truth. Other seats READ but
don't modify.)

DONE {{created_date}} (cont.0 — mission scaffolded):
- Mission scaffolded via \`rig scope mission create\`. Template applied; this
  file is the seed state. First substantive cont.1 entry follows when work
  begins.

## §B / §C / ... — per-seat sections

(Each additional seat adds an h2 ## §X section under their own header as they
join. Section pattern matches §A.)
`;

interface MissionNotesOpts {
  mission_id: string;
  mission_name: string;
  created_date: string;
}

function applyMissionNotesPlaceholders(content: string, opts: MissionNotesOpts): string {
  return content
    .replace(/\{\{mission_id\}\}/g, opts.mission_id)
    .replace(/\{\{mission_name\}\}/g, opts.mission_name)
    .replace(/\{\{created_date\}\}/g, opts.created_date);
}

export function renderDaemonMissionNotes(opts: MissionNotesOpts): string {
  const envValue = process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH;
  if (envValue && envValue.trim().length > 0) {
    const absPath = path.resolve(envValue.trim());
    if (!fs.existsSync(absPath)) {
      throw new Error(
        `OPENRIG_MISSION_NOTES_TEMPLATE_PATH points at "${envValue}", which does not exist. ` +
          "MISSION_NOTES.md not scaffolded. Set it to an absolute path to a readable template file, " +
          "or unset it to use the built-in bundled fallback.",
      );
    }
    const raw = fs.readFileSync(absPath, "utf8");
    return applyMissionNotesPlaceholders(raw, opts);
  }
  return applyMissionNotesPlaceholders(MISSION_NOTES_BUILT_IN, opts);
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
      // FR-5e A1 (daemon-side symmetry) — match CLI scaffold so UI-init
      // produces a workspace that passes doctor check #7. The template
      // resolution + env-var-pivot mirrors the CLI surface;
      // getting-started-narrative-parity.test.ts asserts byte-identity.
      {
        relPath: `missions/${mission.id}/MISSION_NOTES.md`,
        content: renderDaemonMissionNotes({
          mission_id: mission.dotId,
          mission_name: mission.title,
          created_date: new Date().toISOString().slice(0, 10),
        }),
      },
    );
    for (const slice of mission.slices) {
      files.push(
        { relPath: `missions/${mission.id}/slices/${slice.id}/README.md`, content: sliceReadme(mission, slice) },
        { relPath: `missions/${mission.id}/slices/${slice.id}/PROGRESS.md`, content: sliceProgress(mission, slice) },
        { relPath: `missions/${mission.id}/slices/${slice.id}/IMPLEMENTATION-PRD.md`, content: slicePrd(mission, slice) },
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
