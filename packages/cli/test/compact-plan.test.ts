import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactPlanCommand, type CompactPlanDeps } from "../src/commands/compact-plan.js";
import { createProgram } from "../src/index.js";

const freshSample = () => new Date(Date.now() - 60_000).toISOString();
const staleSample = () => new Date(Date.now() - 3_600_000).toISOString();

// A path that deliberately does not exist: the config store then reports the built-in
// defaults, independent of the developer's own configuration file.
const MISSING_CONFIG_PATH = join(tmpdir(), "openrig-compact-plan-missing-config.json");
const COMPACTION_ENV_KEYS = [
  "OPENRIG_POLICIES_CLAUDE_COMPACTION_ENABLED",
  "OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT",
] as const;

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
  configPath?: string;
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
      configPath: overrides?.configPath ?? MISSING_CONFIG_PATH,
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
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    logs = [];
    errors = [];
    savedEnv = {};
    for (const key of COMPACTION_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    (getDaemonStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "running", healthy: true, pid: 1234, port: 7433 });
    process.exitCode = undefined;
  });

  afterEach(() => {
    for (const key of COMPACTION_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
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
      defaultThresholdPercent: 80,
      thresholdTokens: 400_000,
      thresholdPercent: 80,
      automaticCompactionEnabled: false,
      automaticCompactionThresholdPercent: 80,
      automaticCompactionUnavailableReason: null,
      oneSeatAtATime: true,
      autoCompactAllowed: false,
      explicitAuthorizationRequired: true,
    });
    expect(json.summary.requiresAuthorization).toBe(true);

    const candidate = json.candidates.find((entry: { session: string }) => entry.session === "orch-lead@test-rig");
    expect(candidate.status).toBe("candidate_with_caveats");
    expect(candidate.estimatedUsedTokens).toBe(850_000);
    expect(candidate.thresholdReason).toBe("above_token_threshold");
    expect(candidate.reasons).toContain("above_token_threshold");
    expect(candidate.reasons).toContain("authorization_required");
    expect(candidate.missingEvidence).toContain("checkpoint_or_restore_packet_verification");
    expect(candidate.precompactRequirements).toContain("explicit_operator_authorization");
    expect(candidate.seatPolicy).toEqual({
      oneSeatAtATime: true,
      autoCompactAllowed: false,
      explicitAuthorizationRequired: true,
    });
    expect(candidate.notificationPacket.recipient).toBe("orch-lead@test-rig");
    expect(candidate.notificationPacket.text).toContain("No automatic compaction has been run");
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
    expect(candidate.thresholdReason).toBe("above_percent_threshold_missing_window");
    expect(candidate.estimatedUsedTokens).toBeNull();
    expect(candidate.missingEvidence).toContain("context_window_size");
    expect(json.skipped.find((entry: { session: string }) => entry.session === "mid-missing-window@test-rig").reason).toBe("below_threshold");
  });

  it("honors custom token and percent thresholds in JSON policy and candidate selection", async () => {
    const { deps } = makeDeps({
      nodesByRig: {
        "rig-0": [
          node({
            logicalId: "lower.token",
            canonicalSessionName: "lower-token@test-rig",
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
            logicalId: "lower.percent",
            canonicalSessionName: "lower-percent@test-rig",
            contextUsage: {
              usedPercentage: 75,
              remainingPercentage: 25,
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
    await cmd.parseAsync(["node", "rig", "--threshold-tokens", "250000", "--threshold-percent", "70", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.policy.thresholdTokens).toBe(250_000);
    expect(json.policy.thresholdPercent).toBe(70);
    // The plan's flags stay separate from the automatic compaction setting.
    expect(json.policy.automaticCompactionThresholdPercent).toBe(80);
    expect(json.candidates.map((entry: { session: string }) => entry.session)).toEqual([
      "lower-token@test-rig",
      "lower-percent@test-rig",
    ]);
    expect(json.candidates.find((entry: { session: string }) => entry.session === "lower-token@test-rig").thresholdReason).toBe("above_token_threshold");
    expect(json.candidates.find((entry: { session: string }) => entry.session === "lower-percent@test-rig").thresholdReason).toBe("above_percent_threshold_missing_window");
  });

  it("rejects invalid threshold options before reading daemon inventory", async () => {
    const { deps, requestedPaths } = makeDeps();
    const cmd = compactPlanCommand(deps);

    await cmd.parseAsync(["node", "rig", "--threshold-tokens", "0"]);

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--threshold-tokens");
    expect(requestedPaths).toEqual([]);
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
    const missingSession = json.blocked.find((entry: { logicalId: string }) => entry.logicalId === "missing.session");
    expect(missingSession.reasons).toContain("missing_canonical_session");
    expect(missingSession.notificationPacket.text).toContain("cannot safely plan");
    expect(missingSession.precompactRequirements).toContain("one_seat_at_a_time_only");
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
    expect(output).toContain("Plan thresholds (this plan's own, not the automatic compaction setting):");
    expect(output).toContain("Automatic compaction: off (its threshold setting policies.claude_compaction.threshold_percent is 80%).");
    expect(output).toContain("one-seat-at-a-time");
    expect(output).toContain("orch-lead@test-rig");
    expect(output).toContain("authorization");
    expect(output).toContain("checkpoint/restore");
    expect(output).toContain("claude-compaction-restore");
    expect(output).toContain("No automatic compaction has been run");
  });

  it("shows a configured automatic compaction threshold and that compaction is on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-compact-plan-config-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify({ policies: { claudeCompaction: { enabled: true, thresholdPercent: 60 } } }));
      const { deps } = makeDeps({ configPath });

      await compactPlanCommand(deps).parseAsync(["node", "rig", "--json"]);
      const json = JSON.parse(logs.join(""));
      expect(json.policy.thresholdTokens).toBe(400_000);
      expect(json.policy.thresholdPercent).toBe(80);
      expect(json.policy.automaticCompactionEnabled).toBe(true);
      expect(json.policy.automaticCompactionThresholdPercent).toBe(60);
      expect(json.policy.automaticCompactionUnavailableReason).toBeNull();

      logs = [];
      await compactPlanCommand(deps).parseAsync(["node", "rig"]);
      const output = logs.join("\n");
      expect(output).toContain("Plan thresholds (this plan's own, not the automatic compaction setting): 400000 estimated tokens; 80%");
      expect(output).toContain("Automatic compaction: on, at 60% (policies.claude_compaction.threshold_percent).");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still prints the plan when the config can't be read, reporting the automatic setting as unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-compact-plan-bad-config-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, "{ not valid json");
      const { deps } = makeDeps({ configPath });

      await compactPlanCommand(deps).parseAsync(["node", "rig", "--json"]);
      const json = JSON.parse(logs.join(""));
      expect(json.policy.automaticCompactionEnabled).toBeNull();
      expect(json.policy.automaticCompactionThresholdPercent).toBeNull();
      expect(json.policy.automaticCompactionUnavailableReason).toContain("malformed");
      expect(json.candidates[0].session).toBe("orch-lead@test-rig");
      expect(process.exitCode).toBeUndefined();

      logs = [];
      await compactPlanCommand(deps).parseAsync(["node", "rig"]);
      const output = logs.join("\n");
      expect(output).toContain("READ-ONLY PLAN");
      expect(output).toContain("Automatic compaction: couldn't be read:");
      expect(output).toContain("malformed");
      expect(output).toContain("rig config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
