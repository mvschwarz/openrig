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
    id: "idea-ledger",
    title: "Idea Ledger",
    status: "active",
    objective: "Capture, triage, and advance product ideas as queue-backed slices.",
    slices: [
      {
        id: "capture-product-ideas",
        title: "Capture Product Ideas",
        status: "active",
        objective: "Collect useful product ideas into queue items tagged with idea-ledger and this slice id.",
      },
      {
        id: "triage-product-ideas",
        title: "Triage Product Ideas",
        status: "draft",
        objective: "Review captured ideas, select the next slice, and preserve rationale in Project.",
      },
    ],
  },
  {
    id: "handoff-loop",
    title: "Handoff Loop",
    status: "active",
    objective: "Demonstrate queue handoffs moving work through a small agent workflow.",
    slices: [
      {
        id: "route-work-packets",
        title: "Route Work Packets",
        status: "active",
        objective: "Create queue packets that move from orchestration to delivery to review.",
      },
      {
        id: "verify-loop-evidence",
        title: "Verify Loop Evidence",
        status: "draft",
        objective: "Collect proof that handoffs, artifacts, and closure decisions are visible in Project.",
      },
    ],
  },
];

export function workspaceScaffoldDirs(): string[] {
  return [
    "missions",
    "progress",
    "field-notes",
    "specs",
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
      return "# missions\n\nProject missions live here. Each mission folder maps to one Project mission in the UI and owns a `slices/` child folder.\n\nExpected shape:\n\n```text\nmissions/<mission-id>/README.md\nmissions/<mission-id>/PROGRESS.md\nmissions/<mission-id>/slices/<slice-id>/README.md\n```\n";
    case "progress":
      return "# progress\n\nPROGRESS.md tree. OpenRig's Progress browse view scans this directory recursively for PROGRESS.md files and renders them as a hierarchical tree.\n";
    case "field-notes":
      return "# field-notes\n\nOperator field notes. Free-form markdown notes from your daily work. OpenRig surfaces these alongside missions and slices for context.\n";
    case "specs":
      return "# specs\n\nWorkspace specs (rig specs / agent specs / workflow specs / context packs / skills). OpenRig's Library browses this directory alongside bundled specs.\n";
    default:
      return `# ${subdir}\n`;
  }
}

const WORKSPACE_README = `# OpenRig Workspace

This workspace is file-backed. The Project UI mirrors this structure:

- \`missions/<mission-id>\` becomes a Project mission.
- \`missions/<mission-id>/slices/<slice-id>\` becomes a Project slice.
- Queue items should mention or tag the mission id and slice id so Project can attach live work to the right slice.

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

1. <priority one>
2. <priority two>
3. <priority three>

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

export function workspaceScaffoldFiles(): Array<{ relPath: string; content: string }> {
  const files: Array<{ relPath: string; content: string }> = [
    { relPath: "README.md", content: WORKSPACE_README },
    { relPath: "STEERING.md", content: STEERING_PLACEHOLDER },
    { relPath: "missions/README.md", content: subdirReadmeContent("missions") },
    { relPath: "progress/README.md", content: subdirReadmeContent("progress") },
    { relPath: "field-notes/README.md", content: subdirReadmeContent("field-notes") },
    { relPath: "specs/README.md", content: subdirReadmeContent("specs") },
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
