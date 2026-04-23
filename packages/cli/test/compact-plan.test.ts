import { describe, it, expect, vi, beforeEach } from "vitest";
import { compactPlanCommand, type CompactPlanDeps } from "../src/commands/compact-plan.js";
import { createProgram } from "../src/index.js";

const freshSample = () => new Date(Date.now() - 60_000).toISOString();
const staleSample = () => new Date(Date.now() - 3_600_000).toISOString();

interface TestNode {
  rigId: string;
  rigName: string;
  logicalId: string;
  canonicalSessionName: string | null;
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: string | null;
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  contextUsage?: {
    usedPercentage: number | null;
    remainingPercentage: number | null;
    contextWindowSize: number | null;
    source: string | null;
    availability: string | null;
    sampledAt: string | null;
    fresh: boolean;
  };
}

function node(overrides: Partial<TestNode> = {}): TestNode {
  const session = overrides.canonicalSessionName ?? "orch-lead@test-rig";
  return {
    rigId: "rig-0",
    rigName: "test-rig",
    logicalId: "orch.lead",
    canonicalSessionName: session,
    runtime: "claude-code",
    sessionStatus: "running",
    startupStatus: "ready",
    tmuxAttachCommand: session ? `tmux attach -t ${session}` : null,
    resumeCommand: null,
    contextUsage: {
      usedPercentage: 85,
      remainingPercentage: 15,
      contextWindowSize: 1_000_000,
      source: "claude_statusline_json",
      availability: "known",
      sampledAt: freshSample(),
      fresh: true,
    },
    ...overrides,
  };
}

function defaultNodes(): TestNode[] {
  return [
    node({
      logicalId: "orch.lead",
      canonicalSessionName: "orch-lead@test-rig",
      contextUsage: {
        usedPercentage: 85,
        remainingPercentage: 15,
        contextWindowSize: 1_000_000,
        source: "claude_statusline_json",
        availability: "known",
        sampledAt: freshSample(),
        fresh: true,
      },
    }),
    node({
      logicalId: "dev.impl",
      canonicalSessionName: "dev-impl@test-rig",
      contextUsage: {
        usedPercentage: 30,
        remainingPercentage: 70,
        contextWindowSize: 1_000_000,
        source: "claude_statusline_json",
        availability: "known",
        sampledAt: freshSample(),
        fresh: true,
      },
    }),
    node({
      logicalId: "dev.qa",
      canonicalSessionName: "dev-qa@test-rig",
      runtime: "codex",
      contextUsage: {
        usedPercentage: 90,
        remainingPercentage: 10,
        contextWindowSize: 1_000_000,
        source: "codex",
        availability: "known",
        sampledAt: freshSample(),
        fresh: true,
      },
    }),
  ];
}

function makeDeps(overrides?: {
  rigNames?: string[];
  nodesByRig?: Record<string, TestNode[]>;
  refreshStatus?: number;
  refreshThrows?: boolean;
}): { deps: CompactPlanDeps; requestedPaths: string[]; mutationMethods: Record<string, ReturnType<typeof vi.fn>> } {
  const rigs = (overrides?.rigNames ?? ["test-rig"]).map((name, i) => ({ rigId: `rig-${i}`, name }));
  const nodesByRig = overrides?.nodesByRig ?? { "rig-0": defaultNodes() };
  const requestedPaths: string[] = [];
  const mutationMethods = {
    post: vi.fn(() => { throw new Error("compact-plan must not mutate daemon state"); }),
    delete: vi.fn(() => { throw new Error("compact-plan must not mutate daemon state"); }),
    postText: vi.fn(() => { throw new Error("compact-plan must not mutate daemon state"); }),
    postExpectText: vi.fn(() => { throw new Error("compact-plan must not mutate daemon state"); }),
  };

  return {
    requestedPaths,
    mutationMethods,
    deps: {
      lifecycleDeps: {} as CompactPlanDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => {
          requestedPaths.push(path);
          if (path === "/api/ps") return { status: 200, data: rigs };
          if (path.includes("refresh=true")) {
            if (overrides?.refreshThrows) throw new Error("statusline unavailable");
            return { status: overrides?.refreshStatus ?? 200, data: overrides?.refreshStatus && overrides.refreshStatus >= 400 ? { error: "refresh failed" } : [] };
          }
          for (const [rigId, nodes] of Object.entries(nodesByRig)) {
            if (path === `/api/rigs/${rigId}/nodes`) return { status: 200, data: nodes };
          }
          return { status: 200, data: [] };
        }),
        getText: vi.fn(async (path: string) => {
          requestedPaths.push(path);
          return { status: 200, data: "" };
        }),
        ...mutationMethods,
      }) as unknown as ReturnType<CompactPlanDeps["clientFactory"]>,
    },
  };
}

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

describe("rig compact-plan", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(async () => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    (getDaemonStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "running", healthy: true, pid: 1234, port: 7433 });
    process.exitCode = undefined;
  });

  it("is registered on createProgram and runs with injected deps", async () => {
    const { deps } = makeDeps();
    const program = createProgram({ compactPlanDeps: deps });
    program.exitOverride();

    await program.parseAsync(["node", "rig", "compact-plan", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.policy.mode).toBe("read_only_plan");
    expect(json.candidates[0].session).toBe("orch-lead@test-rig");
  });

  it("returns read-only JSON policy, candidates, recommended order, and skipped Codex seats", async () => {
    const { deps, mutationMethods } = makeDeps();
    const cmd = compactPlanCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.policy).toEqual({
      mode: "read_only_plan",
      defaultThresholdTokens: 400_000,
      oneSeatAtATime: true,
      autoCompactAllowed: false,
      explicitAuthorizationRequired: true,
    });
    expect(json.summary.requiresAuthorization).toBe(true);

    const candidate = json.candidates.find((entry: { session: string }) => entry.session === "orch-lead@test-rig");
    expect(candidate.status).toBe("candidate_with_caveats");
    expect(candidate.estimatedUsedTokens).toBe(850_000);
    expect(candidate.reasons).toContain("above_threshold");
    expect(candidate.reasons).toContain("authorization_required");
    expect(candidate.missingEvidence).toContain("checkpoint_or_restore_packet_verification");
    expect(json.recommendedOrder).toEqual(["orch-lead@test-rig"]);

    const belowThreshold = json.skipped.find((entry: { session: string }) => entry.session === "dev-impl@test-rig");
    expect(belowThreshold.reason).toBe("below_threshold");

    const codex = json.skipped.find((entry: { session: string }) => entry.session === "dev-qa@test-rig");
    expect(codex.reason).toBe("codex_not_managed_by_claude_compact_in_place");
    for (const mutate of Object.values(mutationMethods)) {
      expect(mutate).not.toHaveBeenCalled();
    }
  });

  it("uses percent fallback only for Claude seats at or above 80 percent when context window is missing", async () => {
    const { deps } = makeDeps({
      nodesByRig: {
        "rig-0": [
          node({
            canonicalSessionName: "high-missing-window@test-rig",
            contextUsage: {
              usedPercentage: 85,
              remainingPercentage: 15,
              contextWindowSize: null,
              source: "claude_statusline_json",
              availability: "known",
              sampledAt: freshSample(),
              fresh: true,
            },
          }),
          node({
            logicalId: "mid.missing",
            canonicalSessionName: "mid-missing-window@test-rig",
            contextUsage: {
              usedPercentage: 79,
              remainingPercentage: 21,
              contextWindowSize: null,
              source: "claude_statusline_json",
              availability: "known",
              sampledAt: freshSample(),
              fresh: true,
            },
          }),
        ],
      },
    });
    const cmd = compactPlanCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.candidates.map((entry: { session: string }) => entry.session)).toContain("high-missing-window@test-rig");
    const candidate = json.candidates.find((entry: { session: string }) => entry.session === "high-missing-window@test-rig");
    expect(candidate.status).toBe("candidate_with_caveats");
    expect(candidate.estimatedUsedTokens).toBeNull();
    expect(candidate.missingEvidence).toContain("context_window_size");
    expect(json.skipped.find((entry: { session: string }) => entry.session === "mid-missing-window@test-rig").reason).toBe("below_threshold");
  });

  it("surfaces stale context and missing attach or resume evidence as candidate caveats", async () => {
    const { deps } = makeDeps({
      nodesByRig: {
        "rig-0": [node({
          canonicalSessionName: "stale-no-attach@test-rig",
          tmuxAttachCommand: null,
          resumeCommand: null,
          contextUsage: {
            usedPercentage: 90,
            remainingPercentage: 10,
            contextWindowSize: 1_000_000,
            source: "claude_statusline_json",
            availability: "known",
            sampledAt: staleSample(),
            fresh: false,
          },
        })],
      },
    });
    const cmd = compactPlanCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    const candidate = json.candidates[0];
    expect(candidate.contextFreshness).toBe("stale");
    expect(candidate.reasons).toContain("context_stale");
    expect(candidate.missingEvidence).toContain("fresh_context_sample");
    expect(candidate.missingEvidence).toContain("attach_or_resume_evidence");
  });

  it("blocks unknown context and missing canonical session, and excludes them from recommended order", async () => {
    const { deps } = makeDeps({
      nodesByRig: {
        "rig-0": [
          node({
            logicalId: "unknown.context",
            canonicalSessionName: "unknown-context@test-rig",
            contextUsage: { usedPercentage: null, remainingPercentage: null, contextWindowSize: null, source: null, availability: "unknown", sampledAt: null, fresh: false },
          }),
          node({
            logicalId: "missing.session",
            canonicalSessionName: null,
            contextUsage: {
              usedPercentage: 90,
              remainingPercentage: 10,
              contextWindowSize: 1_000_000,
              source: "claude_statusline_json",
              availability: "known",
              sampledAt: freshSample(),
              fresh: true,
            },
          }),
        ],
      },
    });
    const cmd = compactPlanCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.candidates).toHaveLength(0);
    expect(json.recommendedOrder).toEqual([]);
    expect(json.blocked.find((entry: { logicalId: string }) => entry.logicalId === "unknown.context").reasons).toContain("context_unknown");
    expect(json.blocked.find((entry: { logicalId: string }) => entry.logicalId === "missing.session").reasons).toContain("missing_canonical_session");
  });

  it("does not recommend non-running or not-ready Claude seats", async () => {
    const { deps } = makeDeps({
      nodesByRig: {
        "rig-0": [
          node({ canonicalSessionName: "stopped@test-rig", sessionStatus: "stopped" }),
          node({ canonicalSessionName: "pending@test-rig", startupStatus: "pending" }),
        ],
      },
    });
    const cmd = compactPlanCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.recommendedOrder).toEqual([]);
    expect(json.blocked.map((entry: { reasons: string[] }) => entry.reasons).flat()).toContain("seat_not_running_or_ready");
  });

  it("--rig filters to one rig and unknown rig exits before refresh", async () => {
    const { deps, requestedPaths } = makeDeps({
      rigNames: ["rig-a", "rig-b"],
      nodesByRig: {
        "rig-0": [node({ rigId: "rig-0", rigName: "rig-a", canonicalSessionName: "lead@rig-a" })],
        "rig-1": [node({ rigId: "rig-1", rigName: "rig-b", canonicalSessionName: "lead@rig-b" })],
      },
    });
    const cmd = compactPlanCommand(deps);
    await cmd.parseAsync(["node", "rig", "--rig", "rig-b", "--json"]);
    let json = JSON.parse(logs.join(""));
    expect(json.candidates.map((entry: { session: string }) => entry.session)).toEqual(["lead@rig-b"]);

    logs = [];
    errors = [];
    process.exitCode = undefined;
    const unknownCmd = compactPlanCommand(deps);
    await unknownCmd.parseAsync(["node", "rig", "--rig", "missing", "--refresh"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join(" ")).toContain("not found");
    expect(requestedPaths.some((path) => path.includes("refresh=true"))).toBe(false);
  });

  it("--refresh calls refresh before inventory and hard-fails without printing a plan on refresh failure", async () => {
    const success = makeDeps();
    const cmd = compactPlanCommand(success.deps);
    await cmd.parseAsync(["node", "rig", "--refresh", "--json"]);
    const nodeCalls = success.requestedPaths.filter((path) => path.includes("/nodes"));
    expect(nodeCalls[0]).toContain("refresh=true");
    expect(nodeCalls[1]).not.toContain("refresh=true");

    logs = [];
    errors = [];
    process.exitCode = undefined;
    const failure = makeDeps({ refreshStatus: 502 });
    const failCmd = compactPlanCommand(failure.deps);
    await failCmd.parseAsync(["node", "rig", "--refresh"]);
    expect(process.exitCode).toBe(2);
    expect(errors.join("\n")).toContain("Compact-plan refresh failed");
    expect(logs.join("\n")).not.toContain("READ-ONLY PLAN");
  });

  it("daemon down exits nonzero with honest next step copy", async () => {
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    (getDaemonStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "stopped", healthy: false });

    const { deps } = makeDeps();
    const cmd = compactPlanCommand(deps);
    await cmd.parseAsync(["node", "rig"]);

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Daemon is not running");
    expect(errors.join("\n")).toContain("rig daemon start");
  });

  it("human output is explicit that this is a read-only triage plan, not compact permission", async () => {
    const { deps } = makeDeps();
    const cmd = compactPlanCommand(deps);
    await cmd.parseAsync(["node", "rig"]);

    const output = logs.join("\n");
    expect(output).toContain("READ-ONLY PLAN");
    expect(output).toContain("does not compact");
    expect(output).toContain("one-seat-at-a-time");
    expect(output).toContain("orch-lead@test-rig");
    expect(output).toContain("authorization");
    expect(output).toContain("checkpoint/restore");
    expect(output).toContain("claude-compact-in-place");
  });
});
