import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";

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
        { id: "impl", agentRef: "local:../../../agents/development/implementer", runtime: "codex", profile: "default" },
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
    resources: { skills: [], guidance: ["guidance.md"], plugins: ["openrig-core"], subagents: ["reviewer"] },
    startup: { files: [{ path: "STARTUP.md", required: true }], actions: [] },
    raw: [
      "name: implementer",
      "defaults:",
      "  runtime: claude-code",
      "profiles:",
      "  default:",
      "    uses:",
      "      skills: [using-superpowers, tdd]",
    ].join("\n"),
  },
  "/api/rigs/01JRIG/nodes": [
    {
      rigId: "01JRIG", rigName: "myrig", logicalId: "dev.impl", podId: "01JPOD", podNamespace: "dev",
      role: "implementer", canonicalSessionName: "dev-impl@myrig", nodeKind: "agent", runtime: "claude-code",
      sessionStatus: "running", startupStatus: "ready", restoreOutcome: "resumed", oriented: "verified",
      terminalActive: false,
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
      terminalActive: null,
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
  // slice-17: the topology view consumes the DECLARED graph read — the
  // closed route enumeration gains the row; assertions below are unchanged
  "/api/rigs/01JRIG/graph": { nodes: [], edges: [] },
  "/api/rigs/01JDOWN/graph": { nodes: [], edges: [] },
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
  "/api/review/fleet": {
    scope: "rig",
    needsYou: {
      items: [
        { source: "agent", identity: "qitem-2026080201", summary: "approve slice 11 proof", leg: "human-routed", where: "human@kernel", ageIso: "2026-08-02T08:40:00.000Z", priority: "high", tier: "human-gate", evidenceRef: "proof/qa.md", unblocks: null, qitemId: "qitem-2026080201", destinationSession: "human@kernel", derived: null, hostId: "local" },
        { source: "agent", identity: "qitem-remote", summary: "remote founder gate", leg: "human-routed", where: "human@kernel", ageIso: "2026-08-02T08:41:00.000Z", priority: "high", tier: "human-gate", evidenceRef: null, unblocks: null, qitemId: "qitem-remote", destinationSession: "human@kernel", derived: null, hostId: "mm2-host" },
        { source: "derived", identity: "dev-impl@myrig|stuck|2026-08-02T08:43:00.000Z", summary: "impl looks stuck", leg: "stuck", where: "rig", ageIso: null, priority: null, tier: null, evidenceRef: null, unblocks: null, qitemId: null, destinationSession: null, derived: { kind: "stuck", evidence: "idle 47m >= 30m default · holds 2", threshold: "idle-with-work >= 30m" }, hostId: "local" },
        { source: "derived", identity: "dev-qa@myrig|too-long-in-state|2026-08-02T05:00:00.000Z", summary: "qa has not transitioned in 180m", leg: "stuck", where: "rig", ageIso: null, priority: null, tier: null, evidenceRef: null, unblocks: null, qitemId: null, destinationSession: null, derived: { kind: "stuck", evidence: "no transition for 180m >= 120m default · holds 2", threshold: "too-long-in-state >= 120m" }, hostId: "local" },
      ],
      provenance: "computed from queue+ps (rig scope) · window: today at 2026-08-02T09:30:00.000Z",
    },
    agents: { scope: "rig", rows: [], provenance: "computed", coordinationHealth: null },
    settled: [], settledProvenance: "computed", composedAt: "2026-08-02T09:30:00.000Z",
    hosts: [{ hostId: "local", status: { hostId: "local", status: "ok" } }, { hostId: "mm2-host", status: { hostId: "mm2-host", status: "ok" } }],
  },
  "/api/stream/list?limit=5&direction=latest": [
    { streamItemId: "si-1", tsEmitted: "2026-08-02T10:00:00.000Z", streamSortKey: "k1", sourceSession: "dev-guard@myrig", body: "gate cleared: slice-11", format: "text", hintType: null, hintUrgency: null, hintDestination: null, hintTags: null, interrupt: false, archivedAt: null },
  ],
  "/api/queue/attention-aggregate": {
    items: [],
    hosts: [
      { hostId: "local", status: "ok" },
      { hostId: "mm2-host", status: "unreachable", error: "read timed out after 5000ms", failedStep: "remote-daemon-unreachable" },
    ],
  },
  // PULSE exception joins (increment 2) — default empty; per-test responses override
  "/api/queue/list?attention=1": [],
  "/api/queue/list?state=blocked": [],
};

function fixtureClient(overrides: Record<string, { status: number } | undefined> = {}, responses: Record<string, unknown> = {}): DaemonClient {
  const fetchImpl = (async (url: unknown) => {
    const route = String(url).replace("http://x", "");
    const failure = overrides[route];
    if (failure) return { ok: false, status: failure.status, json: async () => ({}) } as Response;
    if (route in responses) return { ok: true, json: async () => responses[route] } as Response;
    if (!(route in FIXTURES)) throw new Error(`unexpected route in test: ${route}`);
    return { ok: true, json: async () => FIXTURES[route] } as Response;
  }) as typeof fetch;
  return new DaemonClient({ baseUrl: "http://x", fetchImpl });
}

function expectIncompleteNeedsTruth(snap: Awaited<ReturnType<typeof hydrateSnapshot>>): void {
  const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
  view.dispatch({ type: "jump", section: "needs" });
  const text = renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines.join("\n");
  // guard round-5 (NOT-CLEAR at b92c2a58): a SETTLED unprobed queue renders the
  // honest static "not yet known" — "(read pending)" is reserved for a real
  // in-flight refresh (load lifecycle), so the settled default drops it
  expect(text).toContain("human-queue: not yet known");
  expect(text).not.toContain("(read pending)");
  expect(text).not.toContain("no fleet attention items right now");
}

describe("snapshot hydration over the §4.A reads (Phase 2)", () => {
  it("maps topology: pods grouped, agent rows VERBATIM from the maintained projection (PIN 2)", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    const local = snap.hosts.find((h) => h.name === "local");
    expect(local?.rigs[0]?.name).toBe("myrig");
    const dev = local?.rigs[0]?.pods.find((p) => p.name === "dev");
    expect(dev?.agents.map((a) => a.name)).toEqual(["dev.impl", "dev.qa"]);
    const impl = dev?.agents[0];
    expect(impl).toMatchObject({ runtime: "claude-code", spec: "implementer", context: 43, tokens: "129k", status: "idle", canRun: false });
    // honest-unknown: availability "unknown" → null cells; lifecycleState verbatim
    const qa = dev?.agents[1];
    expect(qa).toMatchObject({ context: null, tokens: null, status: "unknown", canRun: true });
    // infrastructure nodes are not agent rows
    expect(local?.rigs[0]?.pods.flatMap((p) => p.agents.map((a) => a.name))).not.toContain("svc.db");
  });

  it("keeps the two stuck legs DISTINCT — served evidence/threshold strings verbatim, no client threshold", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    const stuck = snap.needs.filter((n) => n.kind === "stuck");
    expect(stuck).toHaveLength(2);
    expect(stuck[0]).toMatchObject({ target: "dev-impl@myrig", hostId: "local" });
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
      skills: ["using-superpowers", "tdd"],
      hasGuidance: true,
      startupFiles: [{ path: "STARTUP.md", required: true }],
      profiles: ["default"],
      resources: {
        skills: [],
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
          { id: "impl", agentRef: "implementer", runtime: "codex", profile: "default" },
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
    expect(snap.needs.filter((item) => item.source === "agent")).toEqual([
      { source: "agent", kind: "human-routed", target: "human@kernel", detail: "approve slice 11 proof", hostId: "local" },
      { source: "agent", kind: "human-routed", target: "human@kernel", detail: "remote founder gate", hostId: "mm2-host" },
    ]);
  });

  it("preserves the daemon's fleet-wide Needs priority order across agent and derived sources", async () => {
    const ordered = [
      { source: "derived", identity: "urgent@rig|stuck|1", summary: "urgent derived", leg: "stuck", where: "rig", priority: "urgent", derived: { kind: "stuck", evidence: "urgent evidence" }, hostId: "local" },
      { source: "agent", identity: "q-high", summary: "high human", leg: "human-routed", where: "human@kernel", priority: "high", destinationSession: "human@kernel", derived: null, hostId: "local" },
      { source: "derived", identity: "normal@rig|stuck|2", summary: "normal derived", leg: "stuck", where: "rig", priority: "normal", derived: { kind: "stuck", evidence: "normal evidence" }, hostId: "local" },
      { source: "agent", identity: "q-low", summary: "low human", leg: "human-routed", where: "human@kernel", priority: "low", destinationSession: "human@kernel", derived: null, hostId: "local" },
    ];
    const snap = await hydrateSnapshot(fixtureClient({}, {
      "/api/review/fleet": {
        needsYou: { items: ordered },
        hosts: [{ hostId: "local", status: { hostId: "local", status: "ok" } }],
      },
    }));

    expect(snap.needs.map((item) => [item.source, item.detail.split(" — ")[0]])).toEqual([
      ["derived", "urgent derived"],
      ["agent", "high human"],
      ["derived", "normal derived"],
      ["agent", "low human"],
    ]);
  });

  it("keeps a served-first high human gate visible at 140x34 above a long normal-derived tail", async () => {
    const items = [
      { source: "agent", identity: "q-high", summary: "HIGH HUMAN APPROVAL", leg: "human-routed", where: "human@kernel", priority: "high", destinationSession: "human@kernel", derived: null, hostId: "local" },
      ...Array.from({ length: 30 }, (_, index) => ({
        source: "derived", identity: `normal-${index}@rig|stuck|${index}`, summary: `normal exception ${index}`, leg: "stuck", where: "rig", priority: "normal",
        derived: { kind: "stuck", evidence: `normal evidence ${index}` }, hostId: "local",
      })),
    ];
    const snap = await hydrateSnapshot(fixtureClient({}, {
      "/api/review/fleet": {
        needsYou: { items },
        hosts: [{ hostId: "local", status: { hostId: "local", status: "ok" } }],
      },
    }));
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });
    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });

    const humanRow = screen.lines.findIndex((line) => line.includes("HIGH HUMAN APPROVAL"));
    const firstNormalRow = screen.lines.findIndex((line) => line.includes("normal exception 0"));
    expect(humanRow).toBeGreaterThanOrEqual(0);
    expect(humanRow).toBeLessThan(firstNormalRow);
  });

  it("marks fleet attention incomplete when any remote host is absent, never proven-empty", async () => {
    const snap = await hydrateSnapshot(fixtureClient({}, {
      "/api/review/fleet": {
        needsYou: { items: [] },
        hosts: [
          { hostId: "local", status: { hostId: "local", status: "ok" } },
          { hostId: "mm2-host", status: { hostId: "mm2-host", status: "unreachable" } },
        ],
      },
    }));
    expect(snap.humanQueueProbed).toBe(false);
    expect(snap.needs).toEqual([]);
    expectIncompleteNeedsTruth(snap);
  });

  it("treats a fleet registry error as named incomplete state, never proven-empty", async () => {
    const snap = await hydrateSnapshot(fixtureClient({}, {
      "/api/review/fleet": {
        needsYou: { items: [] },
        hosts: [{ hostId: "local", status: { hostId: "local", status: "ok" } }],
        registryError: "failed to parse hosts.yaml",
      },
    }));
    expect(snap.humanQueueProbed).toBe(false);
    expect(snap.readErrors).toContain("review-fleet registry: failed to parse hosts.yaml");
    expectIncompleteNeedsTruth(snap);
  });

  it("gives failed, attention, and needs-input truth precedence over terminal active/idle", async () => {
    const base = (FIXTURES["/api/rigs/01JRIG/nodes"] as Array<Record<string, unknown>>)[0]!;
    const nodes = [
      { ...base, logicalId: "dev.failed", startupStatus: "failed", lifecycleState: "attention_required", terminalActive: true },
      { ...base, logicalId: "dev.attention", startupStatus: "attention_required", lifecycleState: "attention_required", terminalActive: false },
      { ...base, logicalId: "dev.input", startupStatus: "ready", agentActivity: { state: "needs_input" }, terminalActive: true },
      { ...base, logicalId: "dev.active", startupStatus: "ready", agentActivity: { state: "running" }, terminalActive: true },
      { ...base, logicalId: "dev.mismatch", startupStatus: "ready", lifecycleState: "attention_required", agentActivity: { state: "running" }, terminalActive: true, identityVerdict: { verdict: "mismatch" } },
      { ...base, logicalId: "dev.missing", startupStatus: "ready", lifecycleState: "attention_required", agentActivity: { state: "running" }, terminalActive: true, identityVerdict: { verdict: "pane_missing" } },
    ];
    const snap = await hydrateSnapshot(fixtureClient({}, { "/api/rigs/01JRIG/nodes": nodes }));
    const statuses = Object.fromEntries(snap.hosts[0]!.rigs[0]!.pods[0]!.agents.map((agent) => [agent.name, agent.status]));
    expect(statuses).toEqual({
      "dev.failed": "failed",
      "dev.attention": "attention_required",
      "dev.input": "needs_input",
      "dev.active": "active",
      "dev.mismatch": "attention_required",
      "dev.missing": "attention_required",
    });
    const byName = Object.fromEntries(snap.hosts[0]!.rigs[0]!.pods[0]!.agents.map((agent) => [agent.name, agent]));
    expect(byName["dev.mismatch"]?.canRun).toBe(false);
    expect(byName["dev.missing"]?.canRun).toBe(false);
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "rig", name: "myrig" });
    const output = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    expect(output.lines.find((line) => line.includes("dev.mismatch"))).not.toContain("run ▸");
    expect(output.lines.find((line) => line.includes("dev.missing"))).not.toContain("run ▸");
  });

  it("joins Specs↔Topology over existing reads: rig agentRefs + agent usedByRigs", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    expect(snap.specs.find((s) => s.name === "myrig")?.agentRefs).toEqual(["implementer", "qa-agent"]);
    expect(snap.specs.find((s) => s.name === "implementer")?.usedByRigs).toEqual(["myrig"]);
    expect(snap.specs.find((s) => s.name === "conveyor")?.kind).toBe("workflow");
  });

  it("leaves a failed read honest-empty with a NAMED error; other sections still hydrate", async () => {
    const snap = await hydrateSnapshot(fixtureClient({ "/api/review/fleet": { status: 503 } }));
    expect(snap.humanQueueProbed).toBe(false);
    expect(snap.needs).toEqual([]);
    expect(snap.readErrors).toEqual([expect.stringMatching(/review-fleet: .*503/)]);
    expect(snap.hosts.find((h) => h.name === "local")?.rigs[0]?.name).toBe("myrig");
    expectIncompleteNeedsTruth(snap);
  });
});

describe("footer stream tail via the bounded latest-active projection", () => {
  function streamClient(responses: unknown[][]): DaemonClient {
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const route = String(url).replace("http://x", "");
      calls.push(route);
      if (route.startsWith("/api/stream/list")) {
        return { ok: true, json: async () => responses.shift() ?? [] } as Response;
      }
      if (route in FIXTURES) return { ok: true, json: async () => FIXTURES[route] } as Response;
      return { ok: true, json: async () => [] } as Response;
    }) as typeof fetch;
    const client = new DaemonClient({ baseUrl: "http://x", fetchImpl });
    return Object.assign(client, { __calls: calls });
  }

  const item = (n: number) => ({
    streamItemId: `si-${n}`, tsEmitted: `2026-08-03T07:${String(n % 60).padStart(2, "0")}:00.000Z`,
    streamSortKey: `k${String(n).padStart(4, "0")}`, sourceSession: "qa@rig", body: `item-${n}`,
    format: "text", hintType: null, hintUrgency: null, hintDestination: null, hintTags: null, interrupt: false, archivedAt: null,
  });

  it("beyond-cap: with 6 unarchived items the ticker shows the SIXTH (QA's exact repro shape)", async () => {
    const six = Array.from({ length: 6 }, (_, i) => item(i + 1));
    const client = streamClient([six.slice(-5)]);
    const snap = await hydrateSnapshot(client, new Map());
    expect(snap.stream.at(-1)?.body).toBe("item-6");
    expect((client as unknown as { __calls: string[] }).__calls.filter((route) => route.startsWith("/api/stream/list"))).toEqual([
      "/api/stream/list?limit=5&direction=latest",
    ]);
  });

  it("archive truth replaces a cached newest row on the very next refresh", async () => {
    const client = streamClient([[item(1), item(2)], [item(1)]]);
    const first = await hydrateSnapshot(client, new Map());
    const afterArchive = await hydrateSnapshot(client, new Map());
    expect(first.stream.at(-1)?.body).toBe("item-2");
    expect(afterArchive.stream.at(-1)?.body).toBe("item-1");
  });

  it("an empty stream and a failed latest read stay honest instead of reusing stale rows", async () => {
    const empty = streamClient([[]]);
    const snap = await hydrateSnapshot(empty, new Map());
    expect(snap.stream).toEqual([]);

    const failing = new DaemonClient({
      baseUrl: "http://x",
      fetchImpl: (async (url: unknown) => {
        const route = String(url).replace("http://x", "");
        if (route.startsWith("/api/stream/list")) return { ok: false, status: 503, json: async () => ({}) } as Response;
        if (route in FIXTURES) return { ok: true, json: async () => FIXTURES[route] } as Response;
        return { ok: true, json: async () => [] } as Response;
      }) as typeof fetch,
    });
    const snap2 = await hydrateSnapshot(failing, new Map());
    expect(snap2.stream).toEqual([]);
    expect(snap2.readErrors.some((e) => e.startsWith("stream-tail"))).toBe(true);
  });

  it("one bounded read completes even when the source could always append another full page", async () => {
    let calls = 0;
    const client = streamClient([Array.from({ length: 5 }, (_, index) => item(index + 10))]);
    const original = (client as unknown as { __calls: string[] }).__calls;
    const snap = await hydrateSnapshot(client, new Map());
    calls = original.filter((route) => route.startsWith("/api/stream/list")).length;
    expect(calls).toBe(1);
    expect(snap.stream.at(-1)?.body).toBe("item-14");
  });

  it("concurrent hydrations have no shared cursor and report no false non-progress error", async () => {
    const client = streamClient([[item(1)], [item(2)]]);
    const [first, second] = await Promise.all([
      hydrateSnapshot(client, new Map()),
      hydrateSnapshot(client, new Map()),
    ]);
    expect([first.stream.at(-1)?.body, second.stream.at(-1)?.body].sort()).toEqual(["item-1", "item-2"]);
    expect([...first.readErrors, ...second.readErrors].filter((error) => error.startsWith("stream-tail"))).toEqual([]);
  });
});
