// Canonical daemon-side project-workspace scaffold.
//
// Keep this byte-compatible with
// packages/cli/src/commands/config-init-workspace.ts. The two packages do not
// depend on one another, and the parity test pins their shared output.

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
