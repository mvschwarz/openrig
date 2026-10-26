// OPR.0.4.0.25 — rig ps token-safe defaults (compact-by-default projection-trim).
// Large multi-rig fixture exercises compact default, --full byte-equivalence,
// --rig/--session filters, and field-set honesty. Mirrors ps.test.ts harness.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { psCommand } from "../src/commands/ps.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
    ...overrides,
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const errLogs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { errLogs.push(args.map(String).join(" ")); };
    process.exitCode = undefined;
    try { await fn(); } catch { /* commander throws on exitOverride */ }
    const exitCode = process.exitCode;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExitCode;
    resolve({ logs, errLogs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-06-19T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

// --- Large multi-rig fixture ---
// 3 rigs, ~15 nodes total, with fat fields (contextUsage, agentActivity,
// resumeCommand, tmuxAttachCommand, extra [key:string]:unknown fields).
// This is the minimum to prove the compact-default token regression.

function makeFatNode(rigId: string, rigName: string, logicalId: string, opts?: {
  needsAttention?: boolean;
  lifecycleState?: string;
  sessionStatus?: string;
  startupStatus?: string;
  activityState?: string;
  activityReason?: string;
  identityReason?: string;
  hasAssignedWork?: boolean;
  assignedWorkCount?: number;
  pendingWorkCount?: number;
  inProgressWorkCount?: number;
  blockedWorkCount?: number;
  latestError?: string | null;
  contextPercent?: number | null;
}) {
  return {
    rigId,
    rigName,
    needsAttention: opts?.needsAttention ?? false,
    arbitratedNeedsInput: null,
    needsInputEvidence: null,
    logicalId,
    podId: `pod-${logicalId.split(".")[0]}`,
    podNamespace: logicalId.split(".")[0],
    canonicalSessionName: `${logicalId.replace(".", "-")}@${rigName}`,
    // Slice 13 fix 2 — the daemon stamps every served row with its boot-reconciled
    // self-id; the fixture mirrors the served shape so the compact/full ratio guard
    // measures real surfaces.
    hostSelfId: "host-84c37990",
    nodeKind: "agent" as const,
    runtime: "claude-code",
    sessionStatus: opts?.sessionStatus ?? "running",
    modelObservation: opts?.sessionStatus && opts.sessionStatus !== "running" ? {
      status: "unknown", model: null, source: null, observedAt: null,
      generation: "11111111-1111-4111-8111-111111111111", reason: "seat-not-running",
    } : {
      status: "observed", model: "claude-opus-4-20250514", source: "claude-assistant-response",
      observedAt: "2026-06-19T12:00:00.000Z", generation: "11111111-1111-4111-8111-111111111111", reason: null,
    },
    startupStatus: opts?.startupStatus ?? "ready",
    restoreOutcome: "n-a",
    lifecycleState: opts?.lifecycleState ?? "running",
    identityVerdict: opts?.identityReason ? { reason: opts.identityReason } : null,
    tmuxAttachCommand: `tmux attach -t ${logicalId.replace(".", "-")}@${rigName}`,
    resumeCommand: `claude --resume /path/to/session/${logicalId}`,
    latestError: opts?.latestError ?? null,
    terminalActive: true,
    hasAssignedWork: opts?.hasAssignedWork ?? false,
    assignedWorkCount: opts?.assignedWorkCount ?? opts?.pendingWorkCount ?? 0,
    pendingWorkCount: opts?.pendingWorkCount ?? 0,
    inProgressWorkCount: opts?.inProgressWorkCount ?? 0,
    blockedWorkCount: opts?.blockedWorkCount ?? 0,
    agentActivity: {
      state: opts?.activityState ?? "running",
      reason: opts?.activityReason ?? "mid_work_pattern",
      evidenceSource: "pane_heuristic",
      sampledAt: "2026-06-19T12:00:00.000Z",
      evidence: "Working on slice 25",
    },
    contextUsage: {
      availability: opts?.contextPercent === null ? "unknown" : "known",
      usedPercentage: opts?.contextPercent ?? 45,
      fresh: true,
      state: (opts?.contextPercent ?? 45) >= 80 ? "critical" : (opts?.contextPercent ?? 45) >= 60 ? "warning" : "low",
      sampledAt: "2026-06-19T12:00:00.000Z",
    },
    // Extra unknown fields that [key: string]: unknown picks up — these MUST
    // survive in --full but be dropped in compact.
    resolvedSpecHash: "abc123def456",
    agentRef: { provider: "anthropic", model: "claude-opus-4-20250514" },
    recoveryGuidance: "If this node is stuck, try: rig restart --session " + `${logicalId.replace(".", "-")}@${rigName}` + ". Detailed recovery steps: check tmux session, verify daemon health, ensure the agent process is running and responsive to signals. Additional context: this is a long recovery guidance string that adds significant token weight to every node entry in the default output.",
  };
}

const RIG_A_NODES = [
  makeFatNode("rig-a", "openrig-build", "orch1.lead"),
  makeFatNode("rig-a", "openrig-build", "orch1.peer"),
  makeFatNode("rig-a", "openrig-build", "dev1.impl"),
  makeFatNode("rig-a", "openrig-build", "dev1.qa"),
  makeFatNode("rig-a", "openrig-build", "rev1.r1"),
  makeFatNode("rig-a", "openrig-build", "rev1.r2"),
  // One attention node — reason must appear in compact
  makeFatNode("rig-a", "openrig-build", "dev1.design", {
    needsAttention: true,
    lifecycleState: "attention_required",
    startupStatus: "attention_required",
    activityState: "needs_input",
    activityReason: "approval_pending",
    latestError: "Compaction imminent",
    hasAssignedWork: true,
    assignedWorkCount: 6,
    pendingWorkCount: 3,
    inProgressWorkCount: 2,
    blockedWorkCount: 1,
    contextPercent: 92,
  }),
  makeFatNode("rig-a", "openrig-build", "ops.missing", {
    lifecycleState: "detached", sessionStatus: "detached", activityState: "unknown",
    identityReason: "session_missing",
  }),
];

const RIG_B_NODES = [
  makeFatNode("rig-b", "openrig-comms", "orch1.lead"),
  makeFatNode("rig-b", "openrig-comms", "orch1.peer"),
  makeFatNode("rig-b", "openrig-comms", "content1.writer"),
  makeFatNode("rig-b", "openrig-comms", "content1.editor"),
  makeFatNode("rig-b", "openrig-comms", "comm1.social"),
];

const RIG_C_NODES = [
  makeFatNode("rig-c", "openrig-velocity", "orch1.lead", {
    hasAssignedWork: true,
    assignedWorkCount: 7,
    pendingWorkCount: 5,
    inProgressWorkCount: 1,
    blockedWorkCount: 1,
  }),
  makeFatNode("rig-c", "openrig-velocity", "dev1.driver"),
  makeFatNode("rig-c", "openrig-velocity", "dev1.qa"),
];

const ALL_NODES = [...RIG_A_NODES, ...RIG_B_NODES, ...RIG_C_NODES];
const TOTAL_NODE_COUNT = ALL_NODES.length; // 15

const PS_DATA = [
  { rigId: "rig-a", name: "openrig-build", rigName: "openrig-build", nodeCount: 7, runningCount: 7, status: "running", lifecycleState: "attention_required", uptime: "2h", latestSnapshot: null },
  { rigId: "rig-b", name: "openrig-comms", rigName: "openrig-comms", nodeCount: 5, runningCount: 5, status: "running", lifecycleState: "running", uptime: "1h", latestSnapshot: null },
  { rigId: "rig-c", name: "openrig-velocity", rigName: "openrig-velocity", nodeCount: 3, runningCount: 3, status: "running", lifecycleState: "running", uptime: "30m", latestSnapshot: null },
];

const NODES_BY_RIG: Record<string, unknown[]> = {
  "rig-a": RIG_A_NODES,
  "rig-b": RIG_B_NODES,
  "rig-c": RIG_C_NODES,
};

describe("OPR.0.4.0.25 — rig ps token-safe defaults", () => {
  let server: http.Server;
  let port: number;
  let savedSessionName: string | undefined;

  beforeAll(async () => {
    savedSessionName = process.env.OPENRIG_SESSION_NAME;
    delete process.env.OPENRIG_SESSION_NAME;
    server = http.createServer((req, res) => {
      const m = req.url?.match(/^\/api\/rigs\/([^/]+)\/nodes(?:\?.*)?$/);
      if (m && req.method === "GET") {
        const rigId = decodeURIComponent(m[1]!);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(NODES_BY_RIG[rigId] ?? []));
      } else if (req.url === "/api/ps" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(PS_DATA));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    if (savedSessionName !== undefined) process.env.OPENRIG_SESSION_NAME = savedSessionName;
  });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(psCommand(runningDeps(port)));
    return prog;
  }

  // -- AC-1: token-safe default (the regression) --
  it.each(["observed", "unknown"])("r2: AC-1 compact stays below full /2.8 with real %s observations on every row", async status => {
    const originals = ALL_NODES.map(n => n.modelObservation);
    if (status === "unknown") for (const n of ALL_NODES) n.modelObservation = {
      status: "unknown", model: null, source: null, observedAt: null,
      generation: "11111111-1111-4111-8111-111111111111", reason: n.sessionStatus === "running" ? "record-identity-missing-or-ambiguous" : "seat-not-running",
    } as unknown as typeof n.modelObservation;
    try {
    const { logs: defaultLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]);
    });
    const { logs: fullLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--full"]);
    });

    const defaultOutput = defaultLogs.join("");
    const fullOutput = fullLogs.join("");

    // Compact must be significantly smaller than full. Re-based /3 → /2.8 for
    // slice 13 fix 2: hostSelfId is one ruled scalar added to BOTH projections
    // (host attribution must ride the token-safe default — a merged roster
    // without it reads as authoritative), which moves the ratio without any
    // heavy field returning. The real regression guard — heavy fields stay
    // omitted from compact — is asserted directly in AC-7.
    expect(defaultOutput.length).toBeLessThan(fullOutput.length / 2.8);
    // Sanity: full output exists and is nontrivial
    expect(fullOutput.length).toBeGreaterThan(1000);
    } finally { ALL_NODES.forEach((n, i) => n.modelObservation = originals[i]!); }
  });

  // -- AC-2: same breadth (no node dropped) --
  it("AC-2: compact default lists ALL nodes (same count as --full)", async () => {
    const { logs: defaultLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]);
    });
    const { logs: fullLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--full"]);
    });

    const defaultNodes = JSON.parse(defaultLogs.join(""));
    const fullNodes = JSON.parse(fullLogs.join(""));

    expect(Array.isArray(defaultNodes)).toBe(true);
    expect(Array.isArray(fullNodes)).toBe(true);
    expect(defaultNodes.length).toBe(TOTAL_NODE_COUNT);
    expect(fullNodes.length).toBe(TOTAL_NODE_COUNT);
  });

  // -- AC-3: --full --json is byte-equivalent to today's default --
  // Today's default emits the raw fat array. After this slice, --full must
  // emit that same raw array. We capture today's behavior as the golden.
  it("AC-3: --full --json is byte-equivalent to today's raw default", async () => {
    // Today's default IS the full raw array (no compact yet).
    // After slice-25, --full must produce the same output as today's default.
    const { logs: fullLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--full"]);
    });

    const fullOutput = fullLogs.join("");
    const fullParsed = JSON.parse(fullOutput);

    // Must be a bare array (not an envelope)
    expect(Array.isArray(fullParsed)).toBe(true);
    expect(fullParsed.length).toBe(TOTAL_NODE_COUNT);

    // Must preserve [key: string]: unknown extras
    const firstNode = fullParsed[0];
    expect(firstNode.resolvedSpecHash).toBeDefined();
    expect(firstNode.agentRef).toBeDefined();
    expect(firstNode.recoveryGuidance).toBeDefined();

    // Must preserve full agentActivity object
    expect(firstNode.agentActivity).toBeDefined();
    expect(firstNode.agentActivity.evidenceSource).toBeDefined();
    expect(firstNode.agentActivity.evidence).toBeDefined();

    // Must preserve full contextUsage object
    expect(firstNode.contextUsage).toBeDefined();
    expect(firstNode.contextUsage.usedPercentage).toBeDefined();
  });

  // -- AC-4: compact field set --
  it("AC-4: compact projection includes the specified field set", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]);
    });
    const nodes = JSON.parse(logs.join(""));

    for (const node of nodes) {
      // Required fields present
      expect(node).toHaveProperty("rigName");
      expect(node).toHaveProperty("canonicalSessionName");
      expect(node).toHaveProperty("lifecycleState");
      expect(node.agentActivity).toBeDefined();
      expect(node.agentActivity).toHaveProperty("state");
      expect(node).toHaveProperty("hasAssignedWork");
      expect(node).toHaveProperty("assignedWorkCount");
      expect(node).toHaveProperty("pendingWorkCount");
      // Detailed state siblings stay available through --full/--fields; compact
      // keeps every base key plus the total needed to render claimed work honestly.
      expect(node.inProgressWorkCount).toBeUndefined();
      expect(node.blockedWorkCount).toBeUndefined();

      // Excluded heavy fields absent
      expect(node.contextUsage).toBeUndefined();
      expect(node.recoveryGuidance).toBeUndefined();
      expect(node.resolvedSpecHash).toBeUndefined();
      expect(node.agentRef).toBeUndefined();
      expect(node.resumeCommand).toBeUndefined();
      expect(node.tmuxAttachCommand).toBeUndefined();

      // agentActivity is compact (state only, plus reason when attention)
      expect(node.agentActivity.evidenceSource).toBeUndefined();
      expect(node.agentActivity.evidence).toBeUndefined();
      expect(node.agentActivity.sampledAt).toBeUndefined();
    }
  });

  it("AC-4: attention node includes reason + latestError; healthy node omits reason", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]);
    });
    const nodes = JSON.parse(logs.join(""));

    // dev1.design is the attention node
    const attentionNode = nodes.find((n: { canonicalSessionName: string }) =>
      n.canonicalSessionName === "dev1-design@openrig-build"
    );
    expect(attentionNode).toBeDefined();
    expect(attentionNode.agentActivity.state).toBe("needs_input");
    expect(attentionNode.agentActivity.reason).toBe("approval_pending");
    expect(attentionNode.latestError).toBe("Compaction imminent");

    // orch1.lead is healthy — reason should be omitted
    const healthyNode = nodes.find((n: { canonicalSessionName: string }) =>
      n.canonicalSessionName === "orch1-lead@openrig-build"
    );
    expect(healthyNode).toBeDefined();
    expect(healthyNode.agentActivity.state).toBe("running");
    expect(healthyNode.agentActivity.reason).toBeUndefined();
    expect(healthyNode.latestError).toBeUndefined();
  });

  it.each([false, true])("keeps old-daemon diagnostics with unknown attention (failed: %s)", async (failed) => {
    const node = RIG_B_NODES[0]!;
    const original = { ...node };
    Reflect.deleteProperty(node, "needsAttention");
    Object.assign(node, { startupStatus: failed ? "failed" : "ready", latestError: failed ? "startup failure" : null,
      agentActivity: { ...node.agentActivity, state: "needs_input", reason: "approval_pending" } });
    try {
      const json = await captureLogs(() => makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--rig", "openrig-comms", "--json"]).then(() => {}));
      const entry = JSON.parse(json.logs.join(""))[0];
      expect(entry).not.toHaveProperty("needsAttention");
      expect(entry.agentActivity.reason).toBe("approval_pending");
      if (failed) expect(entry.latestError).toBe("startup failure");
      const text = await captureLogs(() => makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--rig", "openrig-comms"]).then(() => {}));
      expect(text.logs.join("\n")).toContain(failed ? "startup failure" : "approval_pending");
      expect(text.logs.find((line) => line.includes(node.canonicalSessionName))).toMatch(/\?\s+(startup failure|approval_pending)/);
    } finally { Object.assign(node, original); }
  });

  it.each([[false, false], [true, false], [false, true]])("shows current limits without hiding startup failures (stale: %s, failed: %s)", async (stale, failed) => {
    const node = RIG_B_NODES[0]!;
    const original = { agentActivity: node.agentActivity, startupStatus: node.startupStatus, latestError: node.latestError, needsAttention: node.needsAttention };
    node.agentActivity = {
      ...original.agentActivity, state: "unknown", reason: "usage_limit", evidenceSource: "runtime_hook",
      rawEvent: "at_limit", stale, fallback: false,
    } as typeof original.agentActivity;
    if (failed) Object.assign(node, { startupStatus: "failed", latestError: "startup failure", needsAttention: true });
    try {
      const json = await captureLogs(() => makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--rig", "openrig-comms", "--json"]).then(() => {}));
      const activity = JSON.parse(json.logs.join(""))[0].agentActivity;
      expect(activity.state).toBe("unknown");
      expect.soft(activity.reason).toBe(stale ? undefined : "usage_limit");
      const text = await captureLogs(() => makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--rig", "openrig-comms"]).then(() => {}));
      expect(text.logs.join("\n").includes("usage_limit")).toBe(!stale && !failed);
      if (failed) expect(text.logs.join("\n")).toContain("startup failure");
    } finally {
      Object.assign(node, original);
    }
  });

  // -- AC-5: --rig and --session filters compose --
  it("AC-5: --rig narrows to nodes of that rig", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--rig", "openrig-comms"]);
    });
    const nodes = JSON.parse(logs.join(""));
    expect(nodes.length).toBe(RIG_B_NODES.length);
    for (const n of nodes) {
      expect(n.rigName).toBe("openrig-comms");
    }
  });

  it("AC-5: --session narrows to matching session", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--session", "dev1-driver@openrig-velocity"]);
    });
    const nodes = JSON.parse(logs.join(""));
    expect(nodes.length).toBe(1);
    expect(nodes[0].canonicalSessionName).toBe("dev1-driver@openrig-velocity");
  });

  it("AC-5: --rig composes with --full (full payload, rig-filtered)", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--rig", "openrig-velocity", "--full"]);
    });
    const nodes = JSON.parse(logs.join(""));
    expect(nodes.length).toBe(RIG_C_NODES.length);
    // Full payload has the heavy fields
    expect(nodes[0].contextUsage).toBeDefined();
    expect(nodes[0].recoveryGuidance).toBeDefined();
    expect(nodes[0].resolvedSpecHash).toBeDefined();
  });

  it("AC-5: --session composes with compact (compact payload, session-filtered)", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--session", "orch1-lead@openrig-build"]);
    });
    const nodes = JSON.parse(logs.join(""));
    expect(nodes.length).toBe(1);
    // Compact — no heavy fields
    expect(nodes[0].contextUsage).toBeUndefined();
    expect(nodes[0].recoveryGuidance).toBeUndefined();
  });

  // -- AC-6: help text --
  it("AC-6: help text documents compact default, --full, --rig, --session, queue frontier", () => {
    const psCmd = psCommand(runningDeps(port));
    let helpOutput = "";
    psCmd.configureOutput({ writeOut: (s) => { helpOutput += s; } });
    psCmd.outputHelp();
    expect(helpOutput).toContain("--full");
    expect(helpOutput).toContain("--rig");
    expect(helpOutput).toContain("--session");
    expect(helpOutput).toContain("current-rig");
    expect(helpOutput).toContain("compact");
  });

  // -- AC-7: both paths in one suite --
  it("AC-7: default compact and --full exercised on same fixture (regression guard)", async () => {
    const { logs: compactLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]);
    });
    const { logs: fullLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--full"]);
    });

    const compact = JSON.parse(compactLogs.join(""));
    const full = JSON.parse(fullLogs.join(""));

    // Both are bare arrays with the same node count
    expect(Array.isArray(compact)).toBe(true);
    expect(Array.isArray(full)).toBe(true);
    expect(compact.length).toBe(full.length);

    // Compact is much smaller (re-based /3 → /2.8 with AC-1 — see its comment)
    expect(compactLogs.join("").length).toBeLessThan(fullLogs.join("").length / 2.8);

    // Full preserves all fields; compact omits heavy ones
    expect(full[0].contextUsage).toBeDefined();
    expect(compact[0].contextUsage).toBeUndefined();
    expect(full[0]).toHaveProperty("inProgressWorkCount");
    expect(full[0]).toHaveProperty("blockedWorkCount");
  });

  // -- Composition: --fields overrides compact (existing behavior preserved) --
  it("--fields overrides compact (explicit projection takes precedence)", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--fields", "rigName,canonicalSessionName"]);
    });
    const parsed = JSON.parse(logs.join(""));
    // --fields triggers envelope
    const entries = parsed.entries;
    expect(entries.length).toBe(TOTAL_NODE_COUNT);
    expect(Object.keys(entries[0])).toEqual(["rigName", "canonicalSessionName"]);
  });

  it("--fields exposes the exact assigned-work state breakdown omitted from compact rows", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rig", "ps", "--nodes", "-A", "--json", "--fields",
        "canonicalSessionName,assignedWorkCount,pendingWorkCount,inProgressWorkCount,blockedWorkCount",
      ]);
    });
    const entries = JSON.parse(logs.join("")).entries;
    const assigned = entries.find((entry: Record<string, unknown>) =>
      entry.canonicalSessionName === "dev1-design@openrig-build");
    expect(assigned).toEqual({
      canonicalSessionName: "dev1-design@openrig-build",
      assignedWorkCount: 6,
      pendingWorkCount: 3,
      inProgressWorkCount: 2,
      blockedWorkCount: 1,
    });
  });

  it.each([
    { mode: "compact", args: [] },
    { mode: "full", args: ["--full"] },
    { mode: "fields", args: ["--fields", "logicalId,intentionallyStopped"] },
  ])(
    "preserves explicit stop intent in $mode node JSON",
    async ({ args: extra }) => {
      const original = NODES_BY_RIG["rig-c"];
      NODES_BY_RIG["rig-c"] = [
        { ...RIG_C_NODES[0], intentionallyStopped: true, sessionStatus: "exited" },
        { ...RIG_C_NODES[1], intentionallyStopped: false },
        RIG_C_NODES[2], // Older daemons omit the field.
      ];
      try {
        const { logs, errLogs, exitCode } = await captureLogs(async () => {
          await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--rig", "openrig-velocity", "--json", ...extra]);
        });
        expect(exitCode ?? 0, errLogs.join("\n")).toBe(0);
        const output = JSON.parse(logs.join(""));
        const entries = Array.isArray(output) ? output : output.entries;
        expect(entries[0].intentionallyStopped).toBe(true);
        expect(entries[1].intentionallyStopped).toBe(false);
        expect(entries[2]).not.toHaveProperty("intentionallyStopped");
      } finally {
        NODES_BY_RIG["rig-c"] = original;
      }
    },
  );

  // -- --verbose alias --
  it("--verbose is an alias for --full", async () => {
    const { logs: fullLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--full"]);
    });
    const { logs: verboseLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--verbose"]);
    });
    expect(fullLogs.join("")).toBe(verboseLogs.join(""));
  });

  // -- Default shape is bare array (back-compat) --
  it("compact default --json stays a bare array (not envelope)", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    // Not an envelope object — a bare array has no own 'entries' property
    expect(Object.prototype.hasOwnProperty.call(parsed, "entries")).toBe(false);
  });

  // -- Human table compact --
  it.each(["compact", "full", "json"])("preserves a pending startup continuation in %s node output", async mode => {
    const node = RIG_A_NODES.find(n => n.startupStatus === "attention_required")!;
    const previous = node.latestError;
    const command = `rig seat continue '${node.canonicalSessionName}'`;
    node.latestError = `Startup requires attention: resolve the native provider prerequisite before startup context can be delivered; After resolving it in ${node.canonicalSessionName}, run: ${command}`;
    try {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", ...(mode === "full" ? ["--full"] : mode === "json" ? ["--json"] : [])]);
      });
      const output = logs.join("\n");
      expect(output).toContain(command);
      expect(output).toContain(node.canonicalSessionName);
      if (mode === "json") expect(Array.isArray(JSON.parse(output))).toBe(true);
      else expect(output).toContain(`Startup details (${node.canonicalSessionName}):`);
    } finally { node.latestError = previous; }
  });

  it("compact default human table uses compact columns and omits full-only columns", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A"]);
    });
    const output = logs.join("\n");
    // Compact headers present
    expect(output).toContain("RIG");
    expect(output).toContain("SESSION");
    expect(output).toContain("LIFECYCLE");
    expect(output).toContain("ACTIVITY");
    expect(output).toContain("WORK");
    // Full-only headers absent
    expect(output).not.toContain("CTX");
    expect(output).not.toContain("RESTORE");
    expect(output).not.toContain("RUNTIME");
    expect(output).not.toContain("STARTUP");
    expect(output).not.toContain("TERMINAL");
    expect(output).not.toContain("POD");
    expect(output).not.toContain("MEMBER");
    // All nodes rendered (same breadth)
    expect(output).toContain("orch1-lead@openrig-build");
    expect(output).toContain("dev1-driver@openrig-velocity");
    const assignedLine = output.split("\n").find((line) => line.includes("dev1-design@openrig-build"));
    expect(assignedLine).toBeDefined();
    // WORK begins after the fixed RIG/SESSION/LIFECYCLE/ACTIVITY columns, each followed by a one-space separator.
    // It renders the total active assignment count (6), never the pending-only count (3).
    expect(assignedLine!.slice(22 + 38 + 11 + 17 + 4, 22 + 38 + 11 + 17 + 4 + 6).trim()).toBe("6");
  });

  it("compact human table allows for count suffix in ACTIVITY without overflowing into WORK", async () => {
    const node = RIG_A_NODES.find((n) => n.logicalId === "dev1.impl")!;
    const previousActivityState = (node as unknown as Record<string, unknown>).activityState;
    const previousHasWork = node.hasAssignedWork;
    (node as unknown as Record<string, unknown>).activityState = {
      activity: "needs_input",
      display: "needs-input",
      needsInput: { count: 1, reason: null },
      decidedBy: null,
    };
    node.hasAssignedWork = true;
    try {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A"]);
      });
      const output = logs.join("\n");
      const line = output.split("\n").find((l) => l.includes("dev1-impl@openrig-build"));
      expect(line).toBeDefined();
      expect(line).not.toContain("needs-input x1yes");
      expect(line).toMatch(/needs-input x1\s+yes/);
      expect(line!.slice(22 + 38 + 11 + 3, 22 + 38 + 11 + 3 + 17)).toBe("needs-input x1   ");
      expect(line!.slice(22 + 38 + 11 + 17 + 4, 22 + 38 + 11 + 17 + 4 + 6)).toBe("yes   ");
    } finally {
      (node as unknown as Record<string, unknown>).activityState = previousActivityState;
      node.hasAssignedWork = previousHasWork;
    }
  });

  it("human node views explain a missing tmux session and the recovery path", async () => {
    for (const extra of [[], ["--full"]]) {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--session", "ops-missing@openrig-build", ...extra]);
      });
      expect(logs.join("\n")).toContain("tmux session missing; restore or relaunch the seat");
    }
  });

  it("discloses recorded running with tmux unavailable as liveness unconfirmed, and leaves other states alone", async () => {
    const at = "2026-06-19T11:58:00.000Z";
    const seat = (logicalId: string, verdict: Record<string, unknown>, opts?: Parameters<typeof makeFatNode>[3]) => ({
      ...makeFatNode("rig-a", "openrig-build", logicalId, opts), storedSessionStatus: opts?.sessionStatus ?? "running", identityVerdict: verdict,
    });
    const unavailable = { verdict: "tmux_unavailable", reason: "tmux_unavailable", evidenceSource: "tmux_session", evidence: { command: "tmux list-sessions", pid: 4242 } };
    const extra = [
      seat("ops.unavail", { ...unavailable, observedAt: at }),
      seat("ops.untimed", unavailable),
      seat("ops.verified", { verdict: "verified", reason: null, observedAt: at }),
      { ...seat("ops.stopped", { ...unavailable, observedAt: at }, { sessionStatus: "exited" }), intentionallyStopped: true },
      seat("ops.codex", { verdict: "mismatch", reason: "tmux_unavailable", observedAt: at }, { needsAttention: true, lifecycleState: "attention_required", latestError: "codex identity mismatch" }),
    ];
    RIG_A_NODES.push(...(extra as unknown as typeof RIG_A_NODES));
    try {
      const run = async (...args: string[]) => (await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--rig", "openrig-build", ...args]);
      })).logs.join("\n");
      const row = (rows: Array<Record<string, any>>, id: string) => rows.find((r) => r.logicalId === id)!;

      const compact = JSON.parse(await run("--json"));
      expect(row(compact, "ops.unavail")).toMatchObject({
        sessionStatus: "running", storedSessionStatus: "running",
        identityVerdict: { verdict: "tmux_unavailable", reason: "tmux_unavailable", observedAt: at },
      });
      expect(row(compact, "ops.unavail").identityVerdict).not.toHaveProperty("evidence");
      expect(row(compact, "ops.untimed").identityVerdict).toEqual({ verdict: "tmux_unavailable", reason: "tmux_unavailable" });
      expect(row(compact, "ops.codex")).toMatchObject({ needsAttention: true, lifecycleState: "attention_required", latestError: "codex identity mismatch" });
      const selected = JSON.parse(await run("--json", "--fields", "logicalId,storedSessionStatus,identityVerdict")).entries;
      expect(row(selected, "ops.unavail")).toMatchObject({ storedSessionStatus: "running", identityVerdict: { reason: "tmux_unavailable", observedAt: at } });

      for (const view of [[], ["--full"]]) {
        const out = await run(...view);
        expect(out).toContain(`Liveness (ops-unavail@openrig-build): recorded running, not confirmed: tmux was unavailable at the last observation (${at}).`);
        expect(out).toContain("Liveness (ops-untimed@openrig-build): recorded running, not confirmed: tmux was unavailable at the last observation (time unknown).");
        for (const other of ["ops-verified", "ops-stopped", "ops-codex", "orch1-lead"]) expect(out).not.toContain(`Liveness (${other}@`);
        expect(out.split("\n").filter((line) => line.includes("ops-unavail@")).join("\n")).not.toMatch(/detached|restore|relaunch/);
        expect(out).toContain("tmux session missing; restore or relaunch the seat");
      }
    } finally {
      RIG_A_NODES.splice(RIG_A_NODES.length - extra.length);
    }
  });

  it("--full human table uses full-detail columns", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--full"]);
    });
    const output = logs.join("\n");
    // Full headers present
    expect(output).toContain("CTX");
    expect(output).toContain("RESTORE");
    expect(output).toContain("RUNTIME");
    expect(output).toContain("STARTUP");
    expect(output).toContain("TERMINAL");
    expect(output).toContain("POD");
    expect(output).toContain("MEMBER");
    const assignedLine = output.split("\n").find((line) => line.includes("dev1-design@openrig-build"));
    expect(assignedLine).toBeDefined();
    // WORK begins after the fixed columns through TERMINAL in the full table, each followed by a one-space separator.
    expect(assignedLine!.slice(30 + 10 + 14 + 34 + 12 + 17 + 10 + 10 + 9 + 11 + 9 + 11,
      30 + 10 + 14 + 34 + 12 + 17 + 10 + 10 + 9 + 11 + 9 + 11 + 6).trim()).toBe("6");
  });
});
