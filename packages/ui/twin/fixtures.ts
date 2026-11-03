// TYPED dummy fixtures = the drift guard. Every fixture is typed against the
// REAL exported @openrig/ui hook interface, so a real-interface change breaks
// the twin build (compile-time drift detection). Data is a believable rig
// family (multiple pods/seats, mixed agent states) so the twin reads like the
// real product. Identifiers are fictional demo data, not live operator state.
//
// To author a feature-version for a slice: copy the relevant fixture, change
// the ONE field the slice proposes, rebuild. The diff of THIS file IS the
// essence of the proposed change.

import type { RigSummary } from "../src/hooks/useRigSummary.js";
import type { PsEntry } from "../src/hooks/usePsEntries.js";
import type { SpecLibraryEntry } from "../src/hooks/useSpecLibrary.js";
import type { NodeInventoryEntry } from "../src/hooks/useNodeInventory.js";
import type { SteeringPayload } from "../src/hooks/useSteering.js";
import type { NodeDetailData } from "../src/hooks/useNodeDetail.js";
import type { NodePreviewResponse } from "../src/hooks/useNodePreview.js";
import type { SliceListResponse } from "../src/hooks/useSlices.js";

export const rigSummary: RigSummary[] = [
  { id: "rig_alpha", name: "acme-build", nodeCount: 11, hasServices: true, latestSnapshotAt: "2025-09-01T01:40:00.000Z", latestSnapshotId: "snap_a_204" },
  { id: "rig_bravo", name: "acme-comms", nodeCount: 8, hasServices: true, latestSnapshotAt: "2025-09-01T00:55:00.000Z", latestSnapshotId: "snap_b_087" },
  { id: "rig_gamma", name: "acme-core", nodeCount: 4, hasServices: false, latestSnapshotAt: "2025-08-31T22:10:00.000Z", latestSnapshotId: "snap_g_031" },
];

export const psEntries: PsEntry[] = [
  { rigId: "rig_alpha", name: "acme-build", nodeCount: 11, runningCount: 11, activeCount: 6, hasWorkCount: 3, status: "running", uptime: "4h 12m", latestSnapshot: "2025-09-01T01:40:00.000Z" },
  { rigId: "rig_bravo", name: "acme-comms", nodeCount: 8, runningCount: 7, activeCount: 2, hasWorkCount: 1, status: "partial", uptime: "2h 03m", latestSnapshot: "2025-09-01T00:55:00.000Z" },
  { rigId: "rig_gamma", name: "acme-core", nodeCount: 4, runningCount: 4, activeCount: 1, hasWorkCount: 0, status: "running", uptime: "9h 47m", latestSnapshot: "2025-08-31T22:10:00.000Z" },
];

export const specLibrary: SpecLibraryEntry[] = [
  { id: "spec_build_rig", kind: "rig", name: "acme-build", version: "1.0.0", sourceType: "user_file", sourcePath: "/specs/rigs/build.yaml", relativePath: "rigs/build.yaml", updatedAt: "2025-08-31T18:00:00.000Z", summary: "Multi-seat build rig", hasServices: true },
  { id: "spec_builder_agent", kind: "agent", name: "builder-agent", version: "1.0.0", sourceType: "builtin", sourcePath: "/specs/agents/builder.yaml", relativePath: "agents/builder.yaml", updatedAt: "2025-08-30T12:00:00.000Z", summary: "TDD build seat" },
  { id: "spec_review_flow", kind: "workflow", name: "review-changes", version: "1.0.0", sourceType: "builtin", sourcePath: "/specs/workflows/review.yaml", relativePath: "workflows/review.yaml", updatedAt: "2025-08-29T09:30:00.000Z", summary: "Dimension review with verification", stepsCount: 3, status: "valid" },
];

// Per-rig node inventory (seeded for when a twin surface navigates into a rig's topology).
const buildNodes: NodeInventoryEntry[] = [
  { rigId: "rig_alpha", rigName: "acme-build", logicalId: "lead.coordinator", podId: "pod_lead", podNamespace: "lead", canonicalSessionName: "coordinator@acme-build", nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "clean", tmuxAttachCommand: "tmux attach -t coordinator", resumeCommand: null, latestError: null, contextUsage: { usedPercentage: 58, remainingPercentage: 42, contextWindowSize: 1000000, availability: "ok", sampledAt: "2025-09-01T01:39:00.000Z", fresh: true }, agentActivity: { state: "running", reason: "tool_use", evidenceSource: "tmux", sampledAt: "2025-09-01T01:39:00.000Z" }, terminalActive: true, hasAssignedWork: true, pendingWorkCount: 2 },
  { rigId: "rig_alpha", rigName: "acme-build", logicalId: "builders.builder2", podId: "pod_builders", podNamespace: "builders", canonicalSessionName: "builder2@acme-build", nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "clean", tmuxAttachCommand: "tmux attach -t builder2", resumeCommand: null, latestError: null, contextUsage: { usedPercentage: 81, remainingPercentage: 19, contextWindowSize: 1000000, availability: "ok", sampledAt: "2025-09-01T01:39:00.000Z", fresh: true }, agentActivity: { state: "running", reason: "building", evidenceSource: "tmux", sampledAt: "2025-09-01T01:39:00.000Z" }, terminalActive: true, hasAssignedWork: true, pendingWorkCount: 1 },
  { rigId: "rig_alpha", rigName: "acme-build", logicalId: "builders.reviewer1", podId: "pod_builders", podNamespace: "builders", canonicalSessionName: "reviewer1@acme-build", nodeKind: "agent", runtime: "codex", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "clean", tmuxAttachCommand: "tmux attach -t reviewer1", resumeCommand: null, latestError: null, agentActivity: { state: "idle", reason: "awaiting_review", evidenceSource: "queue", sampledAt: "2025-09-01T01:38:00.000Z" }, terminalActive: false, hasAssignedWork: false, pendingWorkCount: 0 },
];

export const nodeInventoryByRig: Record<string, NodeInventoryEntry[]> = {
  rig_alpha: buildNodes,
  // C10 acceptance: Active agents tile = 6+2+1 = 9 across the three demo rigs.
  rig_bravo: [
    { rigId: "rig_bravo", rigName: "acme-comms", logicalId: "comms.writer", podId: "pod_comms", podNamespace: "comms", canonicalSessionName: "writer@acme-comms", nodeKind: "agent", runtime: "codex", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "clean", tmuxAttachCommand: "tmux attach -t writer", resumeCommand: null, latestError: null },
    { rigId: "rig_bravo", rigName: "acme-comms", logicalId: "comms.listener", podId: "pod_comms", podNamespace: "comms", canonicalSessionName: "listener@acme-comms", nodeKind: "agent", runtime: "codex", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "clean", tmuxAttachCommand: "tmux attach -t listener", resumeCommand: null, latestError: null },
  ],
  rig_gamma: [
    { rigId: "rig_gamma", rigName: "acme-core", logicalId: "core.guardian", podId: "pod_core", podNamespace: "core", canonicalSessionName: "guardian@acme-core", nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "clean", tmuxAttachCommand: "tmux attach -t guardian", resumeCommand: null, latestError: null },
  ],
};

// C10 Dashboard v2 — demo attention items for the "Needs you" section
// (typed against useAttentionItems' AttentionData; fictional demo data).
export const attentionItems = {
  items: [
    {
      qitemId: "q-demo-001",
      tsCreated: "2025-09-01T01:20:00.000Z",
      tsUpdated: "2025-09-01T01:35:00.000Z",
      sourceSession: "builder2@acme-build",
      destinationSession: "human@host",
      state: "pending",
      priority: "high",
      tier: "human-gate",
      tags: null,
      blockedOn: null,
      handedOffTo: null,
      handedOffFrom: null,
      body: "Approve deploy plan\nsecond line",
      summary: "Approve deploy plan",
      evidenceRef: null,
    },
  ],
  hosts: [],
};

// --- Hard surface 1: TOPOLOGY GRAPH (xyflow) ------------------------------------------
// The daemon /api/rigs/<id>/graph payload. useRigGraph types nodes/edges as unknown[], so
// this is typed against a local interface mirroring exactly what RigGraph + applyTreeLayout
// read: node {id, type, parentId, position, data}; edge {id, source, target, data.kind}.
// Pod membership is by node.parentId (xyflow parent grouping), NOT edges; applyTreeLayout
// assigns final positions (the {x:0,y:0} here is just the placeholder it overwrites).
export interface TwinGraphNode {
  id: string;
  type: "rigNode" | "podGroup";
  parentId?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}
export interface TwinGraphEdge {
  id: string;
  source: string;
  target: string;
  data?: { kind?: string };
}
export interface TwinGraph {
  nodes: TwinGraphNode[];
  edges: TwinGraphEdge[];
}

const ZERO = { x: 0, y: 0 };
const act = (state: string, reason: string, source = "tmux") => ({ state, reason, evidenceSource: source, sampledAt: "2025-09-01T01:39:00.000Z" });

export const rigGraphByRig: Record<string, TwinGraph> = {
  rig_alpha: {
    nodes: [
      { id: "pod_lead", type: "podGroup", position: ZERO, data: { podId: "pod_lead", podNamespace: "lead", podLabel: "lead" } },
      { id: "n_lead_coordinator", type: "rigNode", parentId: "pod_lead", position: ZERO, data: { logicalId: "lead.coordinator", canonicalSessionName: "coordinator@acme-build", podId: "pod_lead", podNamespace: "lead", startupStatus: "ready", agentActivity: act("running", "coordinating"), terminalActive: true, hasAssignedWork: true, pendingWorkCount: 2, currentQitems: [] } },
      { id: "pod_builders", type: "podGroup", position: ZERO, data: { podId: "pod_builders", podNamespace: "builders", podLabel: "builders" } },
      { id: "n_builders_builder2", type: "rigNode", parentId: "pod_builders", position: ZERO, data: { logicalId: "builders.builder2", canonicalSessionName: "builder2@acme-build", podId: "pod_builders", podNamespace: "builders", startupStatus: "ready", agentActivity: act("running", "building"), terminalActive: true, hasAssignedWork: true, pendingWorkCount: 1, currentQitems: [] } },
      { id: "n_builders_reviewer1", type: "rigNode", parentId: "pod_builders", position: ZERO, data: { logicalId: "builders.reviewer1", canonicalSessionName: "reviewer1@acme-build", podId: "pod_builders", podNamespace: "builders", startupStatus: "ready", agentActivity: act("idle", "awaiting_review", "queue"), terminalActive: false, hasAssignedWork: false, pendingWorkCount: 0, currentQitems: [] } },
    ],
    edges: [
      { id: "e_lead_builder2", source: "n_lead_coordinator", target: "n_builders_builder2", data: { kind: "delegates_to" } },
      { id: "e_lead_reviewer1", source: "n_lead_coordinator", target: "n_builders_reviewer1", data: { kind: "delegates_to" } },
      { id: "e_builder2_reviewer1", source: "n_builders_builder2", target: "n_builders_reviewer1", data: { kind: "collaborates_with" } },
    ],
  },
  rig_bravo: { nodes: [], edges: [] },
  rig_gamma: { nodes: [], edges: [] },
};

// --- Hard surface 2: LIVE NODE DETAILS ------------------------------------------------
// useNodeDetail key ["rig", rigId, "nodes", logicalId] -> the exported NodeDetailData
// (strongly typed = drift guard). Keyed "<rigId>::<logicalId>".
export const nodeDetailByKey: Record<string, NodeDetailData> = {
  "rig_alpha::lead.coordinator": {
    rigId: "rig_alpha",
    rigName: "acme-build",
    logicalId: "lead.coordinator",
    podId: "pod_lead",
    podNamespace: "lead",
    canonicalSessionName: "coordinator@acme-build",
    nodeKind: "agent",
    runtime: "claude-code",
    sessionStatus: "running",
    startupStatus: "ready",
    restoreOutcome: "clean",
    tmuxAttachCommand: "tmux attach -t coordinator",
    resumeCommand: null,
    recoveryGuidance: { summary: "Healthy — no recovery action needed.", commands: [], notes: ["Last snapshot 2025-09-01T01:40Z"] },
    latestError: null,
    model: "claude-opus-4-8",
    agentRef: "agents/coordinator.yaml",
    profile: "orchestrator",
    resolvedSpecName: "coordinator",
    resolvedSpecVersion: "1.0.0",
    cwd: "/Users/x/code/projects/example-workspace",
    startupFiles: [
      { path: "CLAUDE.md", deliveryHint: "context", required: true },
      { path: "MISSION_NOTES.md", deliveryHint: "context", required: false },
    ],
    startupActions: [{ type: "skill", value: "openrig-user" }],
    recentEvents: [
      { type: "node.ready", createdAt: "2025-08-31T21:28:00.000Z" },
      { type: "queue.handoff", createdAt: "2025-09-01T01:22:00.000Z" },
    ],
    infrastructureStartupCommand: null,
    peers: [
      { logicalId: "builders.builder2", canonicalSessionName: "builder2@acme-build", runtime: "claude-code" },
      { logicalId: "builders.reviewer1", canonicalSessionName: "reviewer1@acme-build", runtime: "codex" },
    ],
    edges: {
      outgoing: [{ kind: "delegates_to", to: { logicalId: "builders.builder2", sessionName: "builder2@acme-build" } }],
      incoming: [{ kind: "collaborates_with", from: { logicalId: "builders.builder1", sessionName: "builder1@acme-build" } }],
    },
    transcript: { enabled: true, path: "/Users/x/.openrig/transcripts/acme-build/coordinator@acme-build.log", tailCommand: "rig transcript coordinator@acme-build --tail 100" },
    compactSpec: { name: "coordinator", version: "1.0.0", profile: "orchestrator", skillCount: 6, guidanceCount: 3 },
    agentActivity: act("running", "coordinating") as NodeDetailData["agentActivity"],
    currentQitems: [{ qitemId: "wf-demo-002", bodyExcerpt: "Example fold-in: hook-path follow-up on the next iteration…", tier: "build" }],
    terminalActive: true,
    hasAssignedWork: true,
    pendingWorkCount: 2,
    contextUsage: { availability: "ok", usedPercentage: 58, remainingPercentage: 42, contextWindowSize: 1000000, sampledAt: "2025-09-01T01:39:00.000Z", fresh: true },
  },
};

// Embedded live-terminal preview. Keyed by sessionName ONLY (the polled `lines` count
// varies by surface/settings — 100 on node-details — so the fetch stub matches by name and
// echoes whatever line count was requested; the dummy content is the same regardless).
export const sessionPreviewByName: Record<string, NodePreviewResponse> = {
  "coordinator@acme-build": {
    sessionName: "coordinator@acme-build",
    lines: 100,
    capturedAt: "2025-09-01T01:40:12.000Z",
    content: [
      "coordinator@acme-build $ rig queue list --destination builder2 --state pending",
      "  wf-demo-002  Example queue item (follow-up build)  pending",
      "coordinator@acme-build $ # routing the follow-up to builder2",
      "Sent to builder2@acme-build",
      "  Verified: yes  Delivery: rendered",
      "coordinator@acme-build $ rig ps --nodes --rig acme-build",
      "  acme-build   11 nodes   6 active   3 has-work",
      "  lead.coordinator  running   builders.builder2  building   builders.reviewer1  idle",
      "coordinator@acme-build $ _",
    ].join("\n"),
  },
};

// --- Easy surface: WORKSPACE (/project) -----------------------------------------------
// useSlices -> /api/slices -> SliceListResponse (exported = drift-guarded). Project missions
// are derived from these slices (partitionProjectMissions), so this one fixture populates
// both the slice list and the mission grouping.
export const sliceList: SliceListResponse = {
  filter: "all",
  totalCount: 4,
  slices: [
    { name: "EX.1.0.0.01", missionId: "release-1.0.0", displayName: "Seat-scoped post-compaction restore (example)", railItem: "01", status: "done", rawStatus: "merged", qitemCount: 6, hasProofPacket: true, lastActivityAt: "2025-09-01T01:55:00.000Z" },
    { name: "EX.1.0.0.02", missionId: "release-1.0.0", displayName: "UI digital-twin harness (example)", railItem: "02", status: "active", rawStatus: "building", qitemCount: 4, hasProofPacket: false, lastActivityAt: "2025-09-01T02:05:00.000Z" },
    { name: "EX.1.0.0.03", missionId: "release-1.0.0", displayName: "Table-view crash fix (example)", railItem: "03", status: "done", rawStatus: "merged", qitemCount: 2, hasProofPacket: true, lastActivityAt: "2025-08-31T23:40:00.000Z" },
    { name: "EX.1.0.0.04", missionId: "release-1.0.0", displayName: "Security posture consistency (example)", railItem: "04", status: "draft", rawStatus: "scoped", qitemCount: 0, hasProofPacket: false, lastActivityAt: null },
  ],
};

// --- Easy surface: FOR-YOU (/for-you) — SSE activity events -> feed cards --------------
// The feed is SSE-driven (useActivityFeed subscribes to /api/events), NOT cache-seed, so the
// EventSource stub EMITS these. addEvent builds ActivityEvent{type,seq,payload:<whole obj>,
// createdAt}; classifyEvent maps queue.* by `state` -> action-required / approval / shipped /
// progress. Loosely typed (SSE payloads are dynamic; the classifier reads them defensively).
export interface TwinFeedEvent { type: string; seq: number; createdAt: string; [key: string]: unknown; }
export const feedEvents: TwinFeedEvent[] = [
  { type: "queue.updated", seq: 104, createdAt: "2025-09-01T02:05:00.000Z", summary: "Example item: hardest-first checkpoint delivered", sourceSession: "builder2@acme-build", destinationSession: "coordinator@acme-build", rigId: "rig_alpha", qitemId: "wf-demo-002", state: "in_progress", priority: "routine" },
  { type: "queue.delivery.closed", seq: 103, createdAt: "2025-09-01T01:55:00.000Z", summary: "Example merge: seat-scoped post-compaction restore", sourceSession: "coordinator@acme-build", rigId: "rig_alpha", qitemId: "wf-demo-001", state: "closed", closureReason: "handed_off_to" },
  { type: "queue.updated", seq: 102, createdAt: "2025-09-01T01:30:00.000Z", summary: "Ratify request: digital-twin ergonomics proof", sourceSession: "coord@acme-pm", rigId: "rig_alpha", qitemId: "wf-demo-ratify", state: "closeout-pending-ratify", priority: "routine" },
  { type: "queue.updated", seq: 101, createdAt: "2025-09-01T01:10:00.000Z", summary: "Sign-off needed: example release brief", sourceSession: "coordinator@acme-build", rigId: "rig_alpha", qitemId: "wf-demo-signoff", state: "human-gate", priority: "urgent" },
];

// --- Mission Steering tab surfaces -----------------------------------------------------
// Panel 1: GET /api/steering -> SteeringPayload (typed = drift guard).
export const steeringPayload: SteeringPayload = {
  priorityStack: {
    content: [
      "# Steering — release-1.0.0 (example)",
      "",
      "**Mode:** example-mode · **Workflow:** example-flow",
      "",
      "**What agents are told to do right now:**",
      "- Example directive A.",
      "- Example directive B — visual intent before build.",
      "- Example directive C — human-readable summary on every queue item.",
      "- Steering is the mission landing — the source directive lives here.",
    ].join("\n"),
    absolutePath: "/Users/x/code/workspace/STEERING.md",
    mtime: "2025-09-01T08:00:00.000Z",
    byteCount: 360,
  },
  roadmapRail: null,
  laneRails: [],
  unavailableSources: [],
};

// Panel 2: MISSION_BRIEF.md content (pinned schema — byte-exact headers + order).
export const missionBriefMd = [
  "# release-1.0.0 — Brief (example)",
  "_An example workspace observability brief._",
  "",
  "## What & why",
  "An example mission brief demonstrating the locked 7-section doctype.",
  "",
  "## Building",
  "Example tabs and surfaces in flight.",
  "",
  "## Progress",
  "Example wave A shipped; example wave B in flight.",
  "",
  "## Proven",
  "Example proof items rendered through the twin.",
  "",
  "## Needs you",
  "Review the example design mockups — approval unblocks the next wave.",
  "",
  "## Pointers",
  "→ MISSION_NOTES.md · → PROGRESS.md · → the Proof tab.",
].join("\n");

// --- Artifacts altitude file-navigator ---------------------------------------------
// GET /api/files/list?root=&path= -> entries per folder (dirs-first, like the daemon).
// Keyed by the relPath under TWIN_WORKSPACE_ROOT so the navigator's lazy per-folder
// listing resolves through the twin fetch-stub. mtime/size come straight from here.
import type { FileEntry } from "../src/hooks/useFiles.js";
export const artifactsTreeByPath: Record<string, FileEntry[]> = {
  "missions/release-1.0.0": [
    { name: "slices", type: "dir", size: null, mtime: "2025-09-01T22:52:00.000Z" },
    { name: "digital-twin", type: "dir", size: null, mtime: "2025-09-01T01:34:00.000Z" },
    { name: "README.md", type: "file", size: 4096, mtime: "2025-09-01T22:01:00.000Z" },
    { name: "PROGRESS.md", type: "file", size: 3170, mtime: "2025-09-01T05:00:00.000Z" },
    { name: "MISSION_BRIEF.md", type: "file", size: 1284, mtime: "2025-09-01T08:30:00.000Z" },
  ],
  "missions/release-1.0.0/slices": [
    { name: "01-seat-restore", type: "dir", size: null, mtime: "2025-09-01T01:55:00.000Z" },
    { name: "02-twin-harness", type: "dir", size: null, mtime: "2025-09-01T02:05:00.000Z" },
    { name: "05-workspace-ux", type: "dir", size: null, mtime: "2025-09-01T22:52:00.000Z" },
    { name: "07-mission-steering-tab", type: "dir", size: null, mtime: "2025-09-01T08:35:00.000Z" },
  ],
  "missions/release-1.0.0/slices/05-workspace-ux": [
    { name: "README.md", type: "file", size: 4096, mtime: "2025-09-01T22:01:00.000Z" },
    { name: "rescope-2025-09-01.md", type: "file", size: 3174, mtime: "2025-09-01T05:00:00.000Z" },
    { name: "batch-1.change.diff", type: "file", size: 12288, mtime: "2025-09-01T22:52:00.000Z" },
    { name: "03-story-dag.intent.png", type: "file", size: 129024, mtime: "2025-09-01T22:53:00.000Z" },
    { name: "01-02-altitude-steering.intent.png", type: "file", size: 142336, mtime: "2025-09-01T22:52:00.000Z" },
  ],
  "missions/release-1.0.0/digital-twin": [
    { name: "example-mockup-01", type: "dir", size: null, mtime: "2025-09-01T01:34:00.000Z" },
  ],
};
