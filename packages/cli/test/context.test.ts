import { describe, it, expect, vi, beforeEach } from "vitest";
import { contextCommand, type ContextDeps } from "../src/commands/context.js";

function makeDeps(overrides?: {
  daemonState?: string;
  rigNames?: string[];
  nodesByRig?: Record<string, unknown[]>;
}): ContextDeps {
  const rigs = (overrides?.rigNames ?? ["test-rig"]).map((name, i) => ({
    rigId: `rig-${i}`, name, nodeCount: 1, runningCount: 1, status: "running", uptime: "1h", latestSnapshot: null,
  }));

  const nodesByRig = overrides?.nodesByRig ?? {
    "rig-0": [
      {
        rigId: "rig-0", rigName: "test-rig", logicalId: "dev.impl", canonicalSessionName: "dev-impl@test-rig",
        nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready",
        restoreOutcome: "n-a", tmuxAttachCommand: null, resumeCommand: null, latestError: null,
        contextUsage: {
          usedPercentage: 85, remainingPercentage: 15, contextWindowSize: 1000000,
          source: "claude_statusline_json", availability: "known",
          sampledAt: new Date(Date.now() - 60_000).toISOString(), fresh: true,
        },
      },
      {
        rigId: "rig-0", rigName: "test-rig", logicalId: "dev.qa", canonicalSessionName: "dev-qa@test-rig",
        nodeKind: "agent", runtime: "codex", sessionStatus: "running", startupStatus: "ready",
        restoreOutcome: "n-a", tmuxAttachCommand: null, resumeCommand: null, latestError: null,
        contextUsage: { usedPercentage: null, remainingPercentage: null, contextWindowSize: null, source: null, availability: "unknown", sampledAt: null, fresh: false },
      },
      {
        rigId: "rig-0", rigName: "test-rig", logicalId: "dev.synth", canonicalSessionName: "dev-synth@test-rig",
        nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready",
        restoreOutcome: "n-a", tmuxAttachCommand: null, resumeCommand: null, latestError: null,
        contextUsage: {
          usedPercentage: 50, remainingPercentage: 50, contextWindowSize: 1000000,
          source: "claude_statusline_json", availability: "known",
          sampledAt: new Date(Date.now() - 3600_000).toISOString(), fresh: false,
        },
      },
    ],
  };

  return {
    lifecycleDeps: {} as ContextDeps["lifecycleDeps"],
    clientFactory: () => ({
      get: vi.fn(async (path: string) => {
        if (path === "/api/ps") return { status: 200, data: rigs };
        for (const [key, nodes] of Object.entries(nodesByRig)) {
          if (path.includes(key)) return { status: 200, data: nodes };
        }
        return { status: 200, data: [] };
      }),
    }) as unknown as ReturnType<ContextDeps["clientFactory"]>,
  };
}

// Patch getDaemonStatus + getDaemonUrl for tests
vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

describe("rig context", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    process.exitCode = undefined;
  });

  it("human output includes seat table with status + fleet summary", async () => {
    const cmd = contextCommand(makeDeps());
    await cmd.parseAsync(["node", "rig"]);

    const output = logs.join("\n");
    expect(output).toContain("CONTEXT USAGE");
    expect(output).toContain("dev-impl@test-rig");
    expect(output).toContain("CRITICAL");
    expect(output).toContain("dev-qa@test-rig");
    expect(output).toContain("unknown");
    expect(output).toContain("dev-synth@test-rig");
    expect(output).toContain("stale");
    expect(output).toContain("FLEET SUMMARY:");
  });

  it("JSON output includes seats array + summary with correct fields", async () => {
    const cmd = contextCommand(makeDeps());
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.seats).toBeInstanceOf(Array);
    expect(json.seats.length).toBe(3);
    expect(json.summary).toBeDefined();
    expect(json.summary.total).toBe(3);

    const critical = json.seats.find((s: { session: string }) => s.session === "dev-impl@test-rig");
    expect(critical.urgency).toBe("critical");
    expect(critical.freshness).toBe("fresh");
    expect(critical.status).toBe("critical");
    expect(critical.usedPercentage).toBe(85);

    const unknown = json.seats.find((s: { session: string }) => s.session === "dev-qa@test-rig");
    expect(unknown.urgency).toBe("unknown");
    expect(unknown.status).toBe("unknown");

    const stale = json.seats.find((s: { session: string }) => s.session === "dev-synth@test-rig");
    expect(stale.urgency).toBe("low");
    expect(stale.freshness).toBe("stale");
    expect(stale.status).toBe("stale");
  });

  it("sort order: critical > warning > stale > ok > unknown", async () => {
    const cmd = contextCommand(makeDeps());
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    const sessions = json.seats.map((s: { session: string }) => s.session);
    // critical first, then stale (low+stale), then unknown
    expect(sessions).toEqual(["dev-impl@test-rig", "dev-synth@test-rig", "dev-qa@test-rig"]);
  });

  it("--rig filters to one rig", async () => {
    const cmd = contextCommand(makeDeps({ rigNames: ["rig-a", "rig-b"] }));
    await cmd.parseAsync(["node", "rig", "--rig", "rig-a", "--json"]);

    const output = logs.join("\n");
    // Should not error — even if node data is empty for the filtered rig
    expect(process.exitCode).toBeUndefined();
  });

  it("--rig with unknown rig name exits 1", async () => {
    const cmd = contextCommand(makeDeps());
    await cmd.parseAsync(["node", "rig", "--rig", "nonexistent"]);

    expect(process.exitCode).toBe(1);
    expect(errors.join(" ")).toContain("not found");
  });

  it("--threshold filters seats but keeps unknown and stale visible", async () => {
    const cmd = contextCommand(makeDeps());
    await cmd.parseAsync(["node", "rig", "--threshold", "80", "--json"]);

    const json = JSON.parse(logs.join(""));
    const sessions = json.seats.map((s: { session: string }) => s.session);
    // 85% critical (above threshold) + 50% stale (always visible) + unknown (always visible)
    expect(sessions).toContain("dev-impl@test-rig");
    expect(sessions).toContain("dev-synth@test-rig"); // stale — always visible
    expect(sessions).toContain("dev-qa@test-rig");    // unknown — always visible
  });

  it("--threshold abc rejects with nonzero exit", async () => {
    const cmd = contextCommand(makeDeps());
    await cmd.parseAsync(["node", "rig", "--threshold", "abc"]);

    expect(process.exitCode).toBe(2);
    expect(errors.join(" ")).toContain("integer percentage");
  });

  it("--threshold -1 rejects with nonzero exit", async () => {
    const cmd = contextCommand(makeDeps());
    await cmd.parseAsync(["node", "rig", "--threshold", "-1"]);

    expect(process.exitCode).toBe(2);
  });

  it("low + fresh = ok; low + stale = stale (never ok)", async () => {
    const cmd = contextCommand(makeDeps());
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    const stale = json.seats.find((s: { session: string }) => s.session === "dev-synth@test-rig");
    // 50% (low urgency) + stale freshness => status must be "stale", NOT "ok"
    expect(stale.status).toBe("stale");
    expect(stale.displayStatus).toBe("stale");
  });

  it("unknown seats have honest unknown status", async () => {
    const cmd = contextCommand(makeDeps());
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    const unknown = json.seats.find((s: { session: string }) => s.session === "dev-qa@test-rig");
    expect(unknown.usedPercentage).toBeNull();
    expect(unknown.urgency).toBe("unknown");
    expect(unknown.status).toBe("unknown");
    expect(unknown.fresh).toBe(false);
  });

  // --- --refresh CLI tests ---

  it("--refresh calls /nodes?refresh=true once then fetches inventory normally", async () => {
    const requestedPaths: string[] = [];
    const deps: ContextDeps = {
      lifecycleDeps: {} as ContextDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => {
          requestedPaths.push(path);
          if (path === "/api/ps") return { status: 200, data: [{ rigId: "rig-0", name: "test-rig" }] };
          return { status: 200, data: [] };
        }),
      }) as unknown as ReturnType<ContextDeps["clientFactory"]>,
    };
    const cmd = contextCommand(deps);
    await cmd.parseAsync(["node", "rig", "--refresh", "--json"]);

    // First non-ps call should be refresh, then normal inventory
    const nodeCalls = requestedPaths.filter((p) => p.includes("/nodes"));
    expect(nodeCalls.length).toBe(2);
    expect(nodeCalls[0]).toContain("refresh=true");
    expect(nodeCalls[1]).not.toContain("refresh=true");
    expect(process.exitCode).toBeUndefined();
  });

  it("--refresh failure exits 2 with honest error copy", async () => {
    const deps: ContextDeps = {
      lifecycleDeps: {} as ContextDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => {
          if (path === "/api/ps") return { status: 200, data: [{ rigId: "rig-0", name: "test-rig" }] };
          if (path.includes("refresh=true")) return { status: 502, data: { code: "context_refresh_failed", error: "statusline read failed" } };
          return { status: 200, data: [] };
        }),
      }) as unknown as ReturnType<ContextDeps["clientFactory"]>,
    };
    const cmd = contextCommand(deps);
    await cmd.parseAsync(["node", "rig", "--refresh"]);

    expect(process.exitCode).toBe(2);
    const errorOutput = errors.join("\n");
    expect(errorOutput).toContain("Context refresh failed");
    expect(errorOutput).toContain("Fix:");
  });

  it("--refresh success returns same JSON semantics as non-refresh", async () => {
    const deps = makeDeps();
    const cmd = contextCommand(deps);
    await cmd.parseAsync(["node", "rig", "--refresh", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.seats).toBeInstanceOf(Array);
    expect(json.summary).toBeDefined();
    // Should have the same structure as non-refresh output
    expect(json.summary.total).toBeDefined();
    expect(process.exitCode).toBeUndefined();
  });
});
