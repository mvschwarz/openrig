import { describe, expect, it } from "vitest";
import { describeSharedConversation, findSharedConversations } from "../src/domain/shared-conversation.js";
import { validatePreRestore } from "../src/domain/restore-preconditions.js";
import { RestoreCheckService, type RestoreCheckDeps, type NodeInventoryEntry } from "../src/domain/restore-check-service.js";
import type { SnapshotData } from "../src/domain/types.js";

// #3218 item 3: two seats that would resume the same recorded conversation are named, with the
// conversation, on restore and on rig restore-check. Nothing is refused, stopped or picked.

describe("findSharedConversations", () => {
  it("groups seats that carry the same resume type and token", () => {
    expect(findSharedConversations([
      { seat: "b@r2", resumeType: "claude_id", resumeToken: "conv-x" },
      { seat: "a@r1", resumeType: "claude_id", resumeToken: " conv-x " },
      { seat: "c@r1", resumeType: "claude_id", resumeToken: "conv-y" },
    ])).toEqual([{ resumeType: "claude_id", resumeToken: "conv-x", seats: ["a@r1", "b@r2"] }]);
  });

  it("finds nothing for distinct tokens, a missing token or a none type", () => {
    expect(findSharedConversations([
      { seat: "a@r1", resumeType: "claude_id", resumeToken: "conv-a" },
      { seat: "b@r1", resumeType: "claude_id", resumeToken: "conv-b" },
      { seat: "c@r1", resumeType: "claude_id", resumeToken: null },
      { seat: "d@r1", resumeType: "claude_id", resumeToken: "  " },
      { seat: "e@r1", resumeType: "none", resumeToken: "conv-a" },
      { seat: "f@r1", resumeType: null, resumeToken: "conv-b" },
      { seat: "g@r1", resumeType: "codex_id", resumeToken: "conv-a" },
    ])).toEqual([]);
  });

  it("does not pair a seat with itself and keeps every seat of a larger group", () => {
    expect(findSharedConversations([
      { seat: "a@r1", resumeType: "codex_id", resumeToken: "t" },
      { seat: "a@r1", resumeType: "codex_id", resumeToken: "t" },
    ])).toEqual([]);
    const [group] = findSharedConversations(["c@r1", "a@r1", "b@r1"].map((seat) => ({ seat, resumeType: "codex_id", resumeToken: "t" })));
    expect(group?.seats).toEqual(["a@r1", "b@r1", "c@r1"]);
    expect(describeSharedConversation(group!)).toContain("a@r1, b@r1 and c@r1");
  });

  it("names the conversation and the seats without picking one", () => {
    const text = describeSharedConversation({ resumeType: "claude_id", resumeToken: "conv-x", seats: ["a@r1", "b@r2"] });
    expect(text).toContain("conv-x");
    expect(text).toContain("a@r1 and b@r2");
    expect(text).toContain("resumes it in each of them");
  });
});

function twoSeatSnapshot(tokenA: string, tokenB: string): SnapshotData {
  return {
    rig: { id: "rig-1", name: "test-rig", createdAt: "", updatedAt: "" },
    nodes: [
      { id: "node-a", logicalId: "dev.a", runtime: "claude-code", cwd: "/project" },
      { id: "node-b", logicalId: "dev.b", runtime: "claude-code", cwd: "/project" },
    ],
    sessions: [
      { id: "s-a", nodeId: "node-a", status: "exited", resumeToken: tokenA, resumeType: "claude_id", restorePolicy: "resume_if_possible" },
      { id: "s-b", nodeId: "node-b", status: "exited", resumeToken: tokenB, resumeType: "claude_id", restorePolicy: "resume_if_possible" },
    ],
    activeSessionIdByNode: { "node-a": "s-a", "node-b": "s-b" },
    edges: [], checkpoints: {},
  } as unknown as SnapshotData;
}

describe("validatePreRestore names a conversation two resuming seats share", () => {
  it("warns with the conversation and both seats, and blocks nothing", () => {
    const result = validatePreRestore(twoSeatSnapshot("conv-shared", "conv-shared"), {});
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("conv-shared");
    expect(result.warnings[0]).toContain("dev.a and dev.b");
  });

  it("stays quiet for distinct conversations", () => {
    expect(validatePreRestore(twoSeatSnapshot("conv-a", "conv-b"), {})).toEqual({ blockers: [], warnings: [] });
  });

  it("leaves out a seat restored fresh", () => {
    expect(validatePreRestore(twoSeatSnapshot("conv-shared", "conv-shared"), { freshLogicalIds: ["dev.b"] }).warnings).toEqual([]);
  });
});

function seat(rig: string, logicalId: string, token: string, status = "running"): NodeInventoryEntry {
  return {
    nodeId: `${rig}-${logicalId}`, rigId: rig, rigName: rig, logicalId,
    podId: "dev", canonicalSessionName: `${logicalId.replace(".", "-")}@${rig}`,
    nodeKind: "agent", runtime: "claude-code", sessionStatus: status, startupStatus: "ready",
    tmuxAttachCommand: `tmux attach -t ${logicalId}`, latestError: null,
    restorePolicy: "resume_if_possible", resumeType: "claude_id", resumeToken: token,
  } as NodeInventoryEntry;
}

function liveDeps(inventory: Record<string, NodeInventoryEntry[]>): RestoreCheckDeps {
  return {
    listRigs: () => Object.keys(inventory).map((rigId) => ({ rigId, name: rigId })),
    getNodeInventory: (rigId) => inventory[rigId] ?? [],
    getStartupContext: () => ({ status: "ok", runtime: "claude-code", resolvedStartupFiles: [], projectionEntries: [] }),
    hasSnapshot: () => true,
    getRestoreInputs: (rigId) => ({
      snapshot: { id: `snap-${rigId}`, kind: "manual", data: {
        rig: { id: rigId, name: rigId, createdAt: "", updatedAt: "" },
        nodes: [], sessions: [], edges: [], checkpoints: {},
      } as unknown as SnapshotData },
      servicesRecord: null,
    }),
    probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
    exists: () => true,
    readFile: () => JSON.stringify({ schemaVersion: 1, daemonBootstrap: { declared: true, mechanism: "service", evidence: "fixture" }, supportingInfra: [] }),
  } as RestoreCheckDeps;
}

describe("rig restore-check names a conversation two running seats share", () => {
  it("reports both seats and the conversation as a caveat, also for a partner in a rig left out by --rig", () => {
    const result = new RestoreCheckService(liveDeps({
      r1: [seat("r1", "dev.a", "conv-x")],
      r2: [seat("r2", "dev.b", "conv-x")],
    })).check({ rig: "r1", compact: true, noQueue: true, noHooks: true });
    const shared = result.checks.find((c) => c.check === "seat.dev-a@r1.shared-conversation");
    expect(shared?.status).toBe("yellow");
    expect(shared?.evidence).toContain("conv-x");
    expect(shared?.evidence).toContain("dev-a@r1 and dev-b@r2");
    expect(shared?.remediation).toBe("");
    expect(result.verdict).toBe("restorable_with_caveats");
    expect(result.repairPacket ?? []).toEqual([]);
    expect(result.recovery.actions).toEqual([]);
  });

  it("reports nothing for distinct conversations or a partner that is not running", () => {
    for (const inventory of [
      { r1: [seat("r1", "dev.a", "conv-a"), seat("r1", "dev.b", "conv-b")] },
      { r1: [seat("r1", "dev.a", "conv-x"), seat("r1", "dev.b", "conv-x", "exited")] },
    ]) {
      const result = new RestoreCheckService(liveDeps(inventory)).check({ compact: true, noQueue: true, noHooks: true });
      expect(result.checks.filter((c) => c.check.endsWith(".shared-conversation"))).toEqual([]);
    }
  });

  it("stays out of the recovery-only status poll", () => {
    const result = new RestoreCheckService(liveDeps({
      r1: [seat("r1", "dev.a", "conv-x"), seat("r1", "dev.b", "conv-x")],
    })).check({ recoveryOnly: true, noQueue: true, noHooks: true });
    expect(result.checks.filter((c) => c.check.endsWith(".shared-conversation"))).toEqual([]);
  });
});
