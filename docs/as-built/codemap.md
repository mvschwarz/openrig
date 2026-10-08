---
kind: as-built
title: OpenRig Codemap — Modules and Source Entry Points
status: active
topics: [knowledge-and-context, observability]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  You know the behavior you need to inspect but not its owning source files.
  Follow the module and source entry points below, then read the implementation.
siblings: [README.md, arteries.md, test-layers.md, cli-reference.md]
prerequisite-reads: [README.md]
last-verified-against-source: 2caac7dd1bb16585138a6f7c1dd8b1f0752c49f7
last-updated: 2026-10-05
---

# OpenRig codemap

The paths and named entry points below were checked at main
`2caac7dd1bb16585138a6f7c1dd8b1f0752c49f7`. This is a navigation map, not a replacement for
reading the implementation. Linked documents retain their individual verification stamps.
[README.md](README.md) lists the complete document tree and commands to derive its inventory.

## Package entry points

Paths in backticks are relative to the repository root.

| Surface | Start here |
|---|---|
| Daemon process | `packages/daemon/src/index.ts`; `createDaemon()` in `packages/daemon/src/startup.ts`. |
| HTTP application | `createApp()` in `packages/daemon/src/server.ts`; route modules under `packages/daemon/src/routes/`. |
| State and migrations | `packages/daemon/src/db/connection.ts`, `packages/daemon/src/db/migrate.ts`, `packages/daemon/src/db/all-migrations.ts`. |
| CLI | `createProgram()` in `packages/cli/src/index.ts`; commands under `packages/cli/src/commands/`, HTTP in `packages/cli/src/client.ts`. |
| MCP | `createMcpServer()` in `packages/cli/src/mcp-server.ts`; stdio command in `packages/cli/src/commands/mcp.ts`. |
| Terminal UI | `packages/tui/src/main.ts`, `packages/tui/src/state.ts`, `packages/tui/src/render.ts`; HTTP in `packages/tui/src/daemon-client.ts`. |
| Web UI | `packages/ui/src/main.tsx`, `packages/ui/src/routes.tsx`. |
| npm assembly | `scripts/build-package.sh`, `scripts/rewrite-daemon-imports.mjs`, `packages/cli/package.json`. |

The daemon's route handlers obtain domain services from request context. `startup.ts` constructs
those services, repositories and runtime adapters; `server.ts` wires them into the application.
CLI and TUI clients use the daemon's HTTP projections. Package boundaries and the development
versus bundled paths are described in [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Runtime and state modules

Each row names an existing module and a small set of source starting points. Directories group
related code; they are not an exhaustive dependency list.

| Question | Module | Source entry points |
|---|---|---|
| How are the daemon, database and routes assembled? | [Daemon core](architecture/daemon-core.md) | `packages/daemon/src/startup.ts`, `packages/daemon/src/server.ts`, `packages/daemon/src/db/`. |
| How do runtime launch, projection and resume work? | [Adapters and runtimes](architecture/adapters-and-runtimes.md) | `packages/daemon/src/domain/runtime-adapter.ts`, `packages/daemon/src/adapters/`, `packages/daemon/src/domain/native-resume-probe.ts`. |
| How do authored specs become launched agents with identity? | [Agent spec and startup](architecture/agent-spec-and-startup.md) | `packages/daemon/src/domain/rigspec-schema.ts`, `packages/daemon/src/domain/startup-orchestrator.ts`, `packages/daemon/src/domain/whoami-service.ts`. |
| Where are durable work, delivery and handoff handled? | [Coordination](architecture/coordination-primitive.md) | `packages/daemon/src/domain/queue-repository.ts`, `packages/daemon/src/domain/stream-store.ts`, `packages/daemon/src/domain/inbox-handler.ts`, `packages/daemon/src/domain/outbox-handler.ts`. |
| How does a workflow retain progress and resume? | [Workflow runtime](architecture/workflow-runtime.md) | `packages/daemon/src/domain/workflow-runtime.ts`, `packages/daemon/src/domain/workflow-projector.ts`, `packages/daemon/src/domain/policies/`, `packages/daemon/src/routes/workflow.ts`. |
| How are queue observations and actions exposed? | [Mission control](architecture/mission-control.md) | `packages/daemon/src/domain/mission-control/`, `packages/daemon/src/routes/mission-control.ts`. |
| What is captured and checked during restore? | [Lifecycle, snapshot and restore](architecture/lifecycle-snapshot-restore.md) | `packages/daemon/src/domain/snapshot-capture.ts`, `packages/daemon/src/domain/restore-orchestrator.ts`, `packages/daemon/src/routes/restore-check.ts`. |
| How do messages and transcript reads reach sessions? | [Transport and transcripts](architecture/transport-and-transcripts.md) | `packages/daemon/src/domain/session-transport.ts`, `packages/daemon/src/domain/transcript-store.ts`, `packages/daemon/src/routes/transport.ts`. |
| Where do workspaces, projects and repository scope resolve? | [Workspace](architecture/workspace-primitive.md) | `packages/daemon/src/domain/workspace/`, `packages/daemon/src/domain/current-work.ts`, `packages/daemon/src/routes/projects.ts`. |
| How are files, progress and steering read or written? | [Content surfaces](architecture/content-surfaces.md) | `packages/daemon/src/domain/files/`, `packages/daemon/src/domain/progress/`, `packages/daemon/src/domain/steering/`. |
| How are review inputs, proof and approvals composed? | [Living notes and review](architecture/living-notes-review.md) | `packages/daemon/src/domain/review/`, `packages/daemon/src/domain/scope/`, `packages/daemon/src/routes/review.ts`. |
| Where are plugins, agent images and context packs discovered? | [Plugins, images and context packs](architecture/plugin-agent-image-context-pack.md) | `packages/daemon/src/domain/plugin-discovery-service.ts`, `packages/daemon/src/domain/agent-images/`, `packages/daemon/src/domain/context-packs/`. |
| How are reusable bundles assembled and installed? | [Packaging, bootstrap and bundles](architecture/packaging-bootstrap-bundles.md) | `packages/daemon/src/domain/pod-bundle-assembler.ts`, `packages/daemon/src/domain/bootstrap-orchestrator.ts`, `packages/daemon/src/routes/bundles.ts`, `packages/daemon/src/routes/up.ts`. |
| Where are event types, publication and SSE handled? | [Architecture rules and events](architecture/architecture-rules-and-event-system.md) | `packages/daemon/src/domain/types.ts`, `packages/daemon/src/domain/event-bus.ts`, `packages/daemon/src/routes/events.ts`. |

For an execution projection, also read `packages/daemon/src/domain/execution-view.ts` and
`packages/daemon/src/domain/view-projector.ts`. The terminal-side consumer starts in
`packages/tui/src/execution/`. These sit alongside the queue and workflow sources above.

### Newer entry points

These features were added after the module pages above were last verified. Each module's own
stamp says whether it already covers them; until then, start from the source named here.

| Question | Source entry points | Nearest module |
|---|---|---|
| How does a GitHub folder link become a bundle source? | `isGitHubBundleLink()` and the bundle source in `packages/cli/src/lib/bundle-source.ts`, used by `packages/cli/src/commands/up.ts` and `packages/cli/src/commands/bundle.ts`. | [Packaging and bundles](architecture/packaging-bootstrap-bundles.md) |
| What does `rig bundle check` read? | `checkBundleFolder()` in `packages/cli/src/lib/bundle-check.ts`: advisory file reads against `openrig.bundle-standard/v1`, with no daemon, launch or provider call. | [Packaging and bundles](architecture/packaging-bootstrap-bundles.md) |
| How does a member's `permission_policy` become a launch posture, including `builtin:auto`? | `builtinLaunchPosture()` and `resolvePermissionPolicyAttachment()` in `packages/daemon/src/domain/permission-policy/policy-ref.ts` (`builtin:yolo` is full bypass, `builtin:auto` is auto, the other built-ins are the floor), bound per seat in `packages/daemon/src/domain/rigspec-instantiator.ts`. `packages/daemon/src/domain/bundle-behaviour.ts` is the read-only preview of the same mapping for an unopened bundle. | [Adapters and runtimes](architecture/adapters-and-runtimes.md) |
| What does a non-interruptive launch add? | `nonInterruptiveArgs()` in `packages/daemon/src/adapters/non-interruptive.ts` (per-launch arguments only; it never changes permissions or native settings files). The separate instance-wide YOLO setting, off by default, is in `packages/daemon/src/adapters/yolo-mode.ts`. | [Adapters and runtimes](architecture/adapters-and-runtimes.md) |
| What launch arguments does a kernel seat get? | `operationalLaunchArgs()` and `KERNEL_CLAUDE_ALLOW` in `packages/daemon/src/adapters/kernel-authority.ts`; `NativePermissionStore.launchOverride()` in `packages/daemon/src/domain/native-permission-store.ts` decides it per launch (only the rig named `kernel`, with no explicit seat choice, permission policy or Codex profile). | [Adapters and runtimes](architecture/adapters-and-runtimes.md) |
| What launch default does a seat in any other rig get? | Under the same conditions `launchOverride()` sets `teamPermissionDefault`: a Claude seat at the floor posture gets `TEAM_CLAUDE_ALLOW` and `TEAM_CLAUDE_ASK` from `operationalLaunchArgs()` in `packages/daemon/src/adapters/kernel-authority.ts`, whose `claudeCommandSettings()` hands the kernel or team lists to the session-only Bash hook `packages/daemon/assets/claude-team-permissions.cjs`, which returns the allow or ask decision; a workspace-write Codex seat gets `--add-dir` roots from `prepareCodexTeamWorkspace()` in `packages/daemon/src/domain/codex-team-workspace.ts`. | [Adapters and runtimes](architecture/adapters-and-runtimes.md) |
| How does `rig seat continue` finish a fresh startup that stopped before its context was delivered? | `continueFreshStartup()` in `packages/daemon/src/domain/seat-lifecycle-service.ts`, `canContinueFresh()` in `packages/daemon/src/domain/startup-orchestrator.ts`, the route in `packages/daemon/src/routes/seat.ts`, and the command in `packages/cli/src/commands/seat.ts`. | [Agent spec and startup](architecture/agent-spec-and-startup.md) |
| How does `rig context work-install` choose a project and position? | `resolveWorkPosition()` in `packages/cli/src/lib/work-install.ts`, `packages/cli/src/commands/context.ts`, and `packages/daemon/src/domain/workspace/project-catalog.ts`. | [Workspace](architecture/workspace-primitive.md) |
| Where do rosters come from? | `packages/cli/src/commands/roster.ts`: `rig roster list`, `show` and `find` read JSON roster files from `<workspace.root>/rosters` (or `--folder`) and are read-only. | [Agent spec and startup](architecture/agent-spec-and-startup.md), "Specialist rosters" |
| What telemetry can be read? | `packages/daemon/src/domain/finite-telemetry.ts` (the `events`, `queue-transitions` and `tenures` streams), `/api/telemetry` in `packages/daemon/src/routes/telemetry.ts`, and `packages/cli/src/commands/telemetry.ts`. | [Architecture rules and events](architecture/architecture-rules-and-event-system.md), "Telemetry read surface" |

## Change and verification guides

| Need | Read |
|---|---|
| Contributor setup and a small change recipe | [CONTRIBUTING.md](../../CONTRIBUTING.md), [ARCHITECTURE.md](../../ARCHITECTURE.md). |
| What depends on a sensitive source path | [arteries.md](arteries.md). |
| Unit, route, scenario, package and CI coverage | [test-layers.md](test-layers.md), `packages/test-system/README.md`, `.github/workflows/tests.yml`. |
| Exact CLI syntax | [cli-reference.md](cli-reference.md), then `packages/cli/src/index.ts`, its command module and current command help. |
| As-built metadata | [frontmatter-schema.md](frontmatter-schema.md). |
| An older architecture link | [architecture.md](architecture.md), which redirects into this module tree. |
| Visual specification | [DESIGN.md](../DESIGN.md). |

## Existing web UI references

These historical documents are still indexed; this pass checks their locations, not their
current implementation claims. Consult each page's stamp.

| Reference | Source area |
|---|---|
| [UI compatibility pointer](ui.md) | `packages/ui/src/`. |
| [Shell and routing](ui/shell-and-routing.md) | `packages/ui/src/routes.tsx`, `packages/ui/src/components/AppShell.tsx`. |
| [Topology](ui/topology.md) | `packages/ui/src/components/topology/`. |
| [Project and For You](ui/project-and-for-you.md) | `packages/ui/src/routes.tsx`. |
| [Library/specs and design system](ui/library-specs-and-design-system.md) | `packages/ui/src/components/specs/`. |
