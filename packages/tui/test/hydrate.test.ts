import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";

// Fixtures mirror the SERVED shapes traced firsthand at 5f3b5bd4 (Phase-2
// endpoint-shape survey): real field names, real enum values, real evidence
// strings — fixture realism is the point (a text-only stub would false-green).

const FIXTURES: Record<string, unknown> = {
  "/api/rigs/summary": [
    { id: "01JRIG", name: "myrig", nodeCount: 4, hasServices: false, latestSnapshotAt: null, latestSnapshotId: null, archivedAt: null, lifecycleState: "running" },
    { id: "01JDOWN", name: "downrig", nodeCount: 2, hasServices: false, latestSnapshotAt: null, latestSnapshotId: null, archivedAt: null, lifecycleState: "recoverable" },
  ],
  "/api/rigs/01JDOWN/nodes": [],
  "/api/rigs/01JDOWN/spec.json": { schemaVersion: 1, name: "downrig", version: "0.1.0", nodes: [], edges: [] },
  "/api/rigs/01JDOWN/status": {
    rigId: "01JDOWN", rigName: "downrig", isKernel: false, status: "down", seatsTotal: 2, seatsRunning: 0,
    recoverable: true, perSeat: [], src: ["ps: 0/2 running · lifecycle=recoverable"],
  },
  "/api/specs/library/a1/review": {
    sourceState: "library_item", kind: "rig", name: "myrig", version: "0.2",
    format: "pod_aware",
    pods: [{
      id: "dev", label: "Development",
      members: [
        { id: "impl", agentRef: "local:../../../agents/development/implementer", runtime: "claude-code", profile: "default" },
        { id: "qa", agentRef: "qa-agent", runtime: "codex", profile: "default" },
      ],
      edges: [{ from: "impl", to: "qa", kind: "delegates_to" }],
    }],
    edges: [{ from: "dev.impl", to: "review.r1", kind: "collaborates_with" }],
    graph: { nodes: [], edges: [] }, raw: "name: myrig",
    libraryEntryId: "a1", sourcePath: "/s/rig.yaml",
  },
  "/api/specs/library/a2/review": {
    sourceState: "library_item", kind: "agent", name: "implementer", version: "0.1.0",
    description: "Implements locked slices",
    profiles: [{ name: "default" }],
    resources: { skills: ["tdd", "verification"], guidance: ["guidance.md"], plugins: ["openrig-core"], subagents: ["reviewer"] },
    startup: { files: [{ path: "STARTUP.md", required: true }], actions: [] },
    raw: "name: implementer",
  },
  "/api/rigs/01JRIG/nodes": [
    {
      rigId: "01JRIG", rigName: "myrig", logicalId: "dev.impl", podId: "01JPOD", podNamespace: "dev",
      role: "implementer", canonicalSessionName: "dev-impl@myrig", nodeKind: "agent", runtime: "claude-code",
      sessionStatus: "running", startupStatus: "ready", restoreOutcome: "resumed", oriented: "verified",
      lifecycleState: "running", occupantLifecycle: "active", continuityOutcome: null, handoverResult: null,
      previousOccupant: null, handoverAt: null, tmuxAttachCommand: null, resumeCommand: null,
      recoveryGuidance: null, latestError: null, model: null, agentRef: "implementer", profile: "default",
      resolvedSpecName: "implementer", resolvedSpecVersion: "0.1.0", resolvedSpecHash: "ab12", cwd: "/repo",
      restorePolicy: "resume_if_possible", resumeType: "native", resumeToken: "sess-abc", startupCompletedAt: null,
      contextUsage: { availability: "known", reason: null, source: "claude_statusline_json", usedPercentage: 42.5, remainingPercentage: 57.5, contextWindowSize: 200000, totalInputTokens: 120345, totalOutputTokens: 8422, currentUsage: null, transcriptPath: null, sessionId: null, sessionName: null, sampledAt: null, fresh: true },
      hasAssignedWork: true, pendingWorkCount: 2,
    },
    {
      rigId: "01JRIG", rigName: "myrig", logicalId: "dev.qa", podId: "01JPOD", podNamespace: "dev",
      role: "qa", canonicalSessionName: "dev-qa@myrig", nodeKind: "agent", runtime: "codex",
      sessionStatus: null, startupStatus: null, restoreOutcome: "n-a", oriented: "n-a",
      lifecycleState: "detached", occupantLifecycle: "unknown", continuityOutcome: null, handoverResult: null,
      previousOccupant: null, handoverAt: null, tmuxAttachCommand: null, resumeCommand: null,
      recoveryGuidance: null, latestError: null, model: null, agentRef: "qa", profile: "default",
      resolvedSpecName: "qa-agent", resolvedSpecVersion: null, resolvedSpecHash: null, cwd: null,
      restorePolicy: null, resumeType: null, resumeToken: null, startupCompletedAt: null,
      contextUsage: { availability: "unknown", reason: "missing_sidecar", source: null, usedPercentage: null, remainingPercentage: null, contextWindowSize: null, totalInputTokens: null, totalOutputTokens: null, currentUsage: null, transcriptPath: null, sessionId: null, sessionName: null, sampledAt: null, fresh: false },
      hasAssignedWork: false, pendingWorkCount: 0,
    },
    { rigId: "01JRIG", rigName: "myrig", logicalId: "svc.db", podId: null, podNamespace: null, role: null, canonicalSessionName: null, nodeKind: "infrastructure", runtime: null, sessionStatus: null, startupStatus: null, restoreOutcome: "n-a", oriented: "n-a", lifecycleState: "running", occupantLifecycle: "unknown", continuityOutcome: null, handoverResult: null, previousOccupant: null, handoverAt: null, tmuxAttachCommand: null, resumeCommand: null, recoveryGuidance: null, latestError: null, model: null, agentRef: null, profile: null, resolvedSpecName: null, resolvedSpecVersion: null, resolvedSpecHash: null, cwd: null, restorePolicy: null, resumeType: null, resumeToken: null, startupCompletedAt: null },
  ],
  "/api/rigs/01JRIG/spec.json": {
    version: "0.2", name: "myrig",
    pods: [{ id: "dev", label: "Development", members: [{ id: "impl", agentRef: "local:../../../agents/development/implementer", profile: "default", runtime: "claude-code", cwd: "/repo" }, { id: "qa", agentRef: "qa-agent", profile: "default", runtime: "codex", cwd: "/repo" }], edges: [] }],
    edges: [],
  },
  "/api/specs/library": [
    { id: "a1", kind: "rig", name: "myrig", version: "0.2", sourceType: "user_file", sourcePath: "/s/rig.yaml", relativePath: "rig.yaml", updatedAt: "2026-08-01T00:00:00.000Z" },
    { id: "a2", kind: "agent", name: "implementer", version: "0.1.0", sourceType: "builtin", sourcePath: "/s/implementer.yaml", relativePath: "agents/implementer.yaml", updatedAt: "2026-08-01T00:00:00.000Z" },
    { id: "a3", kind: "workflow", name: "conveyor", version: "0.3.0", sourceType: "user_file", sourcePath: "/s/conveyor.yaml", relativePath: "workflows/conveyor.yaml", updatedAt: "2026-08-01T00:00:00.000Z", isBuiltIn: false, rolesCount: 4, stepsCount: 9, status: "valid", errorMessage: null },
  ],
  "/api/review/rig": {
    scope: "rig",
    needsYou: {
      items: [
        { source: "agent", identity: "qitem-2026080201", summary: "approve slice 11 proof", leg: "human-routed", where: "human@kernel", ageIso: "2026-08-02T08:40:00.000Z", priority: "high", tier: "human-gate", evidenceRef: "proof/qa.md", unblocks: null, qitemId: "qitem-2026080201", destinationSession: "human@kernel", derived: null },
        { source: "derived", identity: "dev-impl@myrig|stuck|2026-08-02T08:43:00.000Z", summary: "impl looks stuck", leg: "stuck", where: "rig", ageIso: null, priority: null, tier: null, evidenceRef: null, unblocks: null, qitemId: null, destinationSession: null, derived: { kind: "stuck", evidence: "idle 47m >= 30m default · holds 2", threshold: "idle-with-work >= 30m" } },
        { source: "derived", identity: "dev-qa@myrig|too-long-in-state|2026-08-02T05:00:00.000Z", summary: "qa has not transitioned in 180m", leg: "stuck", where: "rig", ageIso: null, priority: null, tier: null, evidenceRef: null, unblocks: null, qitemId: null, destinationSession: null, derived: { kind: "stuck", evidence: "no transition for 180m >= 120m default · holds 2", threshold: "too-long-in-state >= 120m" } },
      ],
      provenance: "computed from queue+ps (rig scope) · window: today at 2026-08-02T09:30:00.000Z",
    },
    agents: { scope: "rig", rows: [], provenance: "computed", coordinationHealth: null },
    settled: [], settledProvenance: "computed", composedAt: "2026-08-02T09:30:00.000Z",
  },
  "/api/stream/list?limit=5": [
    { streamItemId: "si-1", tsEmitted: "2026-08-02T10:00:00.000Z", streamSortKey: "k1", sourceSession: "dev-guard@myrig", body: "gate cleared: slice-11", format: "text", hintType: null, hintUrgency: null, hintDestination: null, hintTags: null, interrupt: false, archivedAt: null },
  ],
  "/api/queue/attention-aggregate": {
    items: [],
    hosts: [
      { hostId: "local", status: "ok" },
      { hostId: "mm2-host", status: "unreachable", error: "read timed out after 5000ms", failedStep: "remote-daemon-unreachable" },
    ],
  },
};

function fixtureClient(overrides: Record<string, { status: number } | undefined> = {}): DaemonClient {
  const fetchImpl = (async (url: unknown) => {
    const route = String(url).replace("http://x", "");
    const failure = overrides[route];
    if (failure) return { ok: false, status: failure.status, json: async () => ({}) } as Response;
    if (!(route in FIXTURES)) throw new Error(`unexpected route in test: ${route}`);
    return { ok: true, json: async () => FIXTURES[route] } as Response;
  }) as typeof fetch;
  return new DaemonClient({ baseUrl: "http://x", fetchImpl });
}

describe("snapshot hydration over the §4.A reads (Phase 2)", () => {
  it("maps topology: pods grouped, agent rows VERBATIM from the maintained projection (PIN 2)", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    const local = snap.hosts.find((h) => h.name === "local");
    expect(local?.rigs[0]?.name).toBe("myrig");
    const dev = local?.rigs[0]?.pods.find((p) => p.name === "dev");
    expect(dev?.agents.map((a) => a.name)).toEqual(["dev.impl", "dev.qa"]);
    const impl = dev?.agents[0];
    expect(impl).toMatchObject({ runtime: "claude-code", spec: "implementer", context: 43, tokens: "129k", status: "running" });
    // honest-unknown: availability "unknown" → null cells; lifecycleState verbatim
    const qa = dev?.agents[1];
    expect(qa).toMatchObject({ context: null, tokens: null, status: "detached" });
    // infrastructure nodes are not agent rows
    expect(local?.rigs[0]?.pods.flatMap((p) => p.agents.map((a) => a.name))).not.toContain("svc.db");
  });

  it("keeps the two stuck legs DISTINCT — served evidence/threshold strings verbatim, no client threshold", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    const stuck = snap.needs.filter((n) => n.kind === "stuck");
    expect(stuck).toHaveLength(2);
    expect(stuck[0]?.target).toBe("dev-impl@myrig");
    expect(stuck[0]?.detail).toContain("idle 47m >= 30m default");
    expect(stuck[1]?.target).toBe("dev-qa@myrig");
    expect(stuck[1]?.detail).toContain("no transition for 180m >= 120m default");
  });

  it("composes host-down AND rig-down BESIDE the items, never into the item shape (PIN 3)", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    expect(snap.hostsDown).toEqual([
      { hostId: "mm2-host", status: "unreachable", error: "read timed out after 5000ms" },
      { hostId: "rig:downrig", status: "recoverable (down)", error: "0/2 seats running" },
    ]);
    expect(snap.needs.some((n) => n.target === "mm2-host" || n.target.includes("downrig"))).toBe(false);
    // and the unreachable host appears in topology with honest reachability
    expect(snap.hosts.find((h) => h.name === "mm2-host")?.reachable).toBe(false);
    // the non-running rig carries its served lifecycleState verbatim (QA blocker 3)
    expect(snap.hosts.find((h) => h.name === "local")?.rigs.find((r) => r.name === "downrig")?.lifecycleState).toBe("recoverable");
  });

  it("hydrates agent-spec structured detail from the LIVE /:id/review route (QA blocker 2)", async () => {
    const cache = new Map();
    const snap = await hydrateSnapshot(fixtureClient(), cache);
    const impl = snap.specs.find((s) => s.name === "implementer");
    expect(impl).toMatchObject({
      version: "0.1.0",
      sourcePath: "/s/implementer.yaml",
      description: "Implements locked slices",
      runtime: "claude-code",
      skills: ["tdd", "verification"],
      hasGuidance: true,
      startupFiles: [{ path: "STARTUP.md", required: true }],
      profiles: ["default"],
      resources: {
        skills: ["tdd", "verification"],
        guidance: ["guidance.md"],
        plugins: ["openrig-core"],
        subagents: ["reviewer"],
      },
    });
    expect(cache.size).toBe(2); // rig + agent reviews memoized by id@updatedAt
  });

  it("hydrates the locked rig-spec structure and library provenance from the LIVE /:id/review route", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    expect(snap.specs.find((s) => s.name === "myrig")).toMatchObject({
      sourceState: "library_item",
      sourceType: "user_file",
      sourcePath: "/s/rig.yaml",
      relativePath: "rig.yaml",
      format: "pod_aware",
      pods: [{
        id: "dev",
        label: "Development",
        members: [
          { id: "impl", agentRef: "implementer", runtime: "claude-code", profile: "default" },
          { id: "qa", agentRef: "qa-agent", runtime: "codex", profile: "default" },
        ],
        edges: [{ from: "impl", to: "qa", kind: "delegates_to" }],
      }],
      edges: [{ from: "dev.impl", to: "review.r1", kind: "collaborates_with" }],
    });
  });

  it("maps the human-queue leg and marks it PROBED (proven-empty vs not-yet-known)", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    expect(snap.humanQueueProbed).toBe(true);
    expect(snap.humanQueue).toEqual([{ kind: "human-routed", target: "human@kernel", detail: "approve slice 11 proof" }]);
  });

  it("joins Specs↔Topology over existing reads: rig agentRefs + agent usedByRigs", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    expect(snap.specs.find((s) => s.name === "myrig")?.agentRefs).toEqual(["implementer", "qa-agent"]);
    expect(snap.specs.find((s) => s.name === "implementer")?.usedByRigs).toEqual(["myrig"]);
    expect(snap.specs.find((s) => s.name === "conveyor")?.kind).toBe("workflow");
  });

  it("leaves a failed read honest-empty with a NAMED error; other sections still hydrate", async () => {
    const snap = await hydrateSnapshot(fixtureClient({ "/api/review/rig": { status: 503 } }));
    expect(snap.humanQueueProbed).toBe(false);
    expect(snap.needs).toEqual([]);
    expect(snap.readErrors).toEqual([expect.stringMatching(/review-rig: .*503/)]);
    expect(snap.hosts.find((h) => h.name === "local")?.rigs[0]?.name).toBe("myrig");
  });
});
