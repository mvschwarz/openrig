import { describe, expect, it } from "vitest";
import { compareConversations, describePartners, describeSharedConversation, describeUnavailable } from "../src/domain/shared-conversation.js";
import { validatePreRestore } from "../src/domain/restore-preconditions.js";
import { RestoreCheckService, type RestoreCheckDeps, type NodeInventoryEntry } from "../src/domain/restore-check-service.js";
import type { SnapshotData } from "../src/domain/types.js";

// #3218 item 3: agents that hold the same recorded conversation are named on restore and on rig restore-check, with
// the resume type and never the token. Nothing is refused, stopped or picked; an unreadable comparison says so.

describe("compareConversations", () => {
  it("groups agents that carry the same resume type and token, keeping the token out of the group", () => {
    const { groups, unavailable } = compareConversations([
      { seat: "b@r2", state: "stopped", resumeType: "claude_id", resumeToken: "conv-x" },
      { seat: "a@r1", state: "running", resumeType: "claude_id", resumeToken: " conv-x " },
      { seat: "c@r1", resumeType: "claude_id", resumeToken: "conv-y" },
    ]);
    expect(groups).toEqual([{ resumeType: "claude_id", seats: [{ seat: "a@r1", state: "running" }, { seat: "b@r2", state: "stopped" }] }]);
    expect(JSON.stringify(groups)).not.toContain("conv-x");
    expect(unavailable).toEqual([]);
  });

  it("finds nothing for distinct tokens, a missing token, a none type or another type", () => {
    expect(compareConversations([
      { seat: "a@r1", resumeType: "claude_id", resumeToken: "conv-a" },
      { seat: "b@r1", resumeType: "claude_id", resumeToken: "conv-b" },
      { seat: "c@r1", resumeType: "claude_id", resumeToken: null },
      { seat: "d@r1", resumeType: "claude_id", resumeToken: "  " },
      { seat: "e@r1", resumeType: "none", resumeToken: "conv-a" },
      { seat: "f@r1", resumeType: null, resumeToken: "conv-b" },
      { seat: "g@r1", resumeType: "codex_id", resumeToken: "conv-a" },
    ])).toEqual({ groups: [], unavailable: [] });
    expect(compareConversations([
      { seat: "a@r1", resumeType: "none", resumeToken: "t" },
      { seat: "b@r1", resumeType: "none", resumeToken: "t" },
    ]).groups).toEqual([]);
  });

  it("does not pair an agent with itself and names every agent of a larger group", () => {
    expect(compareConversations([
      { seat: "a@r1", resumeType: "codex_id", resumeToken: "t" },
      { seat: "a@r1", resumeType: "codex_id", resumeToken: "t" },
    ]).groups).toEqual([]);
    const [group] = compareConversations(["c@r1", "a@r1", "b@r1"].map((seat) => ({ seat, resumeType: "codex_id", resumeToken: "t" }))).groups;
    expect(describeSharedConversation(group!)).toContain("a@r1, b@r1 and c@r1");
  });

  it("makes the comparison unavailable for saved data that is not text, without throwing", () => {
    const { groups, unavailable } = compareConversations([
      { seat: "a@r1", resumeType: "claude_id", resumeToken: 42 },
      { seat: "b@r1", resumeType: { bad: true }, resumeToken: "conv-x" },
      { seat: "c@r1", resumeType: "claude_id", resumeToken: "conv-x" },
    ]);
    expect(groups).toEqual([]);
    expect(unavailable).toEqual(["a@r1", "b@r1"]);
    expect(describeUnavailable(unavailable)).toContain("unavailable for a@r1 and b@r1");
  });

  it("says what is known and leaves the choice to the person, without the token", () => {
    const text = describeSharedConversation({ resumeType: "claude_id", seats: [{ seat: "a@r1", state: "running" }, { seat: "b@r2", state: "stopped" }] });
    expect(text).toContain("a@r1 (running) and b@r2 (stopped) have the same recorded claude_id conversation");
    expect(text).toContain("the person's choice");
    expect(text).not.toMatch(/resumes it|would resume/);
  });
});

describe("describePartners", () => {
  it("names an agent of the restore and the outside agents, running or stopped, that hold its conversation", () => {
    const warnings = describePartners(
      [{ seat: "dev.impl@r1", resumeType: "claude_id", resumeToken: "conv-x" }],
      [
        { seat: "dev-parent@r1", state: "running", resumeType: "claude_id", resumeToken: "conv-x" },
        { seat: "dev-old@r2", state: "stopped", resumeType: "claude_id", resumeToken: "conv-x" },
        { seat: "dev-other@r2", state: "stopped", resumeType: "claude_id", resumeToken: "conv-y" },
      ],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dev.impl@r1 has the same recorded claude_id conversation as dev-old@r2 (stopped) and dev-parent@r1 (running), outside this restore");
    expect(warnings[0]).not.toContain("conv-x");
  });

  it("leaves to the other reports a group of the restore's own agents or of outside agents alone", () => {
    expect(describePartners(
      [{ seat: "a@r1", resumeType: "claude_id", resumeToken: "conv-a" }, { seat: "b@r1", resumeType: "claude_id", resumeToken: "conv-a" }],
      [{ seat: "c@r2", resumeType: "claude_id", resumeToken: "conv-b" }, { seat: "d@r2", resumeType: "claude_id", resumeToken: "conv-b" }],
    )).toEqual([]);
  });

  it("names an outside agent whose saved data is not readable, and never the restore's own twice", () => {
    expect(describePartners(
      [{ seat: "a@r1", resumeType: "claude_id", resumeToken: 7 }],
      [{ seat: "z@r2", state: "stopped", resumeType: "claude_id", resumeToken: 9 }],
    )).toEqual([describeUnavailable(["z@r2"])]);
  });
});

function twoSeatSnapshot(tokenA: unknown, tokenB: unknown): SnapshotData {
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

describe("validatePreRestore names a conversation two resuming agents share", () => {
  it("warns with both agents and the resume type, never the token, and blocks nothing", () => {
    const result = validatePreRestore(twoSeatSnapshot("conv-shared", "conv-shared"), {});
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("dev.a (exited) and dev.b (exited) have the same recorded claude_id conversation");
    expect(result.warnings[0]).not.toContain("conv-shared");
  });

  // The review of #3250's delta: the agents a restore resumes carry their recorded status too ("unknown" when none),
  // as the agents outside it do; never "stopped" for every status that is not running.
  it("names each resuming agent with its recorded status, and unknown when none was recorded", () => {
    const data = twoSeatSnapshot("conv-shared", "conv-shared");
    const sessions = data.sessions as Array<{ status?: string }>;
    sessions[0]!.status = "detached";
    delete sessions[1]!.status;
    const result = validatePreRestore(data, {});
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("dev.a (detached) and dev.b (unknown) have the same recorded claude_id conversation");
    expect(result.warnings[0]).not.toContain("stopped");
  });

  it("stays quiet for distinct conversations", () => {
    expect(validatePreRestore(twoSeatSnapshot("conv-a", "conv-b"), {})).toEqual({ blockers: [], warnings: [] });
  });

  it("leaves out an agent restored fresh, a terminal now, or a relaunch-fresh policy", () => {
    expect(validatePreRestore(twoSeatSnapshot("conv-shared", "conv-shared"), { freshLogicalIds: ["dev.b"] }).warnings).toEqual([]);
    expect(validatePreRestore(twoSeatSnapshot("conv-shared", "conv-shared"), { currentRuntimes: { "dev.b": "terminal" } }).warnings).toEqual([]);
    const fresh = twoSeatSnapshot("conv-shared", "conv-shared");
    (fresh.sessions as Array<{ restorePolicy: string }>)[1]!.restorePolicy = "relaunch_fresh";
    expect(validatePreRestore(fresh, {}).warnings).toEqual([]);
  });

  it("reports malformed saved data as an unavailable comparison and does not throw or block", () => {
    const result = validatePreRestore(twoSeatSnapshot(12345, "conv-b"), {});
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([`Restore pre-validation: ${describeUnavailable(["dev.a"])}`]);
  });
});

function seat(rig: string, logicalId: string, token: unknown, status = "running"): NodeInventoryEntry {
  return {
    nodeId: `${rig}-${logicalId}`, rigId: rig, rigName: rig, logicalId,
    podId: "dev", canonicalSessionName: `${logicalId.replace(".", "-")}@${rig}`,
    nodeKind: "agent", runtime: "claude-code", sessionStatus: status, startupStatus: "ready",
    tmuxAttachCommand: `tmux attach -t ${logicalId}`, latestError: null,
    restorePolicy: "resume_if_possible", resumeType: "claude_id", resumeToken: token,
  } as NodeInventoryEntry;
}

function liveDeps(inventory: Record<string, NodeInventoryEntry[] | Error>): RestoreCheckDeps {
  return {
    listRigs: () => Object.keys(inventory).map((rigId) => ({ rigId, name: rigId })),
    getNodeInventory: (rigId) => {
      const entry = inventory[rigId];
      if (entry instanceof Error) throw entry;
      return entry ?? [];
    },
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

const check = (opts: Record<string, unknown> = {}) => ({ compact: true, noQueue: true, noHooks: true, ...opts });

describe("rig restore-check names agents that hold the same recorded conversation", () => {
  it("reports both agents and the type as a caveat, also for a partner in a rig left out by --rig", () => {
    const result = new RestoreCheckService(liveDeps({
      r1: [seat("r1", "dev.a", "conv-x")],
      r2: [seat("r2", "dev.b", "conv-x")],
    })).check(check({ rig: "r1" }));
    const shared = result.checks.find((c) => c.check === "seat.dev-a@r1.shared-conversation");
    expect(shared?.status).toBe("yellow");
    expect(shared?.evidence).toContain("dev-a@r1 (running) and dev-b@r2 (running) have the same recorded claude_id conversation");
    expect(shared?.evidence).not.toContain("conv-x");
    expect(shared?.remediation).toBe("");
    expect(result.verdict).toBe("restorable_with_caveats");
    // the caveat adds no repair step (the roster note of a seat outside the recorded roster is main's, not this one)
    expect((result.repairPacket ?? []).filter((step) => /conversation/i.test(`${step.command} ${step.rationale}`))).toEqual([]);
    expect(result.recovery.actions).toEqual([]);
  });

  it("reports stopped agents with a recorded resumable conversation, as after a reboot", () => {
    const result = new RestoreCheckService(liveDeps({
      r1: [seat("r1", "dev.a", "conv-x", "exited")],
      r2: [seat("r2", "dev.b", "conv-x", "exited")],
    })).check(check());
    const shared = result.checks.filter((c) => c.check.endsWith(".shared-conversation"));
    expect(shared.map((c) => c.check).sort()).toEqual(["seat.dev-a@r1.shared-conversation", "seat.dev-b@r2.shared-conversation"]);
    expect(shared[0]!.evidence).toContain("dev-a@r1 (exited) and dev-b@r2 (exited)");
  });

  // The maintainer's review of #3250: each agent is named with its recorded status as it is (a detached one may still
  // be live), and "unknown" when there is none; never "stopped" for every status that is not running.
  it("names a detached partner as detached, and an agent with no recorded status as unknown", () => {
    const noStatus = { ...seat("r2", "dev.c", "conv-x"), sessionStatus: null } as NodeInventoryEntry;
    const result = new RestoreCheckService(liveDeps({
      r1: [seat("r1", "dev.a", "conv-x")],
      r2: [seat("r2", "dev.b", "conv-x", "detached"), noStatus],
    })).check(check({ rig: "r1" }));
    const shared = result.checks.find((c) => c.check === "seat.dev-a@r1.shared-conversation");
    expect(shared?.evidence).toContain("dev-a@r1 (running), dev-b@r2 (detached) and dev-c@r2 (unknown) have the same recorded claude_id conversation");
    expect(shared?.evidence).not.toContain("stopped");
  });

  it("counts a running agent whatever its restore policy, and a stopped one only if it would resume", () => {
    const relaunchFresh = (entry: NodeInventoryEntry) => ({ ...entry, restorePolicy: "relaunch_fresh" }) as NodeInventoryEntry;
    const result = new RestoreCheckService(liveDeps({
      r1: [seat("r1", "dev.a", "conv-x")],
      r2: [relaunchFresh(seat("r2", "dev.b", "conv-x")), relaunchFresh(seat("r2", "dev.c", "conv-x", "exited"))],
    })).check(check({ rig: "r1" }));
    const shared = result.checks.find((c) => c.check === "seat.dev-a@r1.shared-conversation");
    expect(shared?.evidence).toContain("dev-a@r1 (running) and dev-b@r2 (running) have the same recorded claude_id conversation");
    expect(shared?.evidence).not.toContain("dev-c@r2");
  });

  it("reports nothing for distinct conversations", () => {
    const result = new RestoreCheckService(liveDeps({ r1: [seat("r1", "dev.a", "conv-a"), seat("r1", "dev.b", "conv-b")] })).check(check());
    expect(result.checks.filter((c) => c.check.endsWith(".shared-conversation"))).toEqual([]);
  });

  it("names an outside rig it could not read as an unavailable comparison and keeps going", () => {
    const result = new RestoreCheckService(liveDeps({
      r1: [seat("r1", "dev.a", "conv-x"), seat("r1", "dev.b", "conv-x")],
      r2: new Error("inventory read failed"),
    })).check(check({ rig: "r1" }));
    const unavailable = result.checks.find((c) => c.check === "rig.r2.shared-conversation");
    expect(unavailable?.status).toBe("yellow");
    expect(unavailable?.evidence).toContain("unavailable: inventory read failed");
    expect(result.checks.some((c) => c.check === "seat.dev-a@r1.shared-conversation")).toBe(true);
  });

  it("names an agent whose saved data is not readable, without throwing", () => {
    const result = new RestoreCheckService(liveDeps({ r1: [seat("r1", "dev.a", 7), seat("r1", "dev.b", "conv-x")] })).check(check());
    const unavailable = result.checks.find((c) => c.check === "seat.dev-a@r1.shared-conversation");
    expect(unavailable?.evidence).toBe(describeUnavailable(["dev-a@r1"]));
  });

  // The maintainer's 2nd review of #3250: the seats the snapshot would resume are named by their current record; a
  // snapshot taken by rig down records them running, before it marks them exited.
  it("names the seats the snapshot would resume by their current record, not the running the snapshot recorded", () => {
    const data = twoSeatSnapshot("conv-x", "conv-x");
    for (const sess of data.sessions as Array<{ status: string }>) sess.status = "running";
    const deps = liveDeps({ r1: [seat("r1", "dev.a", "conv-x", "exited"), seat("r1", "dev.b", "conv-x", "exited")] });
    const result = new RestoreCheckService({
      ...deps,
      getRestoreInputs: () => ({ snapshot: { id: "snap-r1", kind: "manual", data }, servicesRecord: null }),
    } as RestoreCheckDeps).check(check());
    const evidence = result.checks.map((c) => c.evidence).filter((e) => e.includes("have the same recorded"));
    expect(evidence.some((e) => e.includes("dev.a (exited) and dev.b (exited) have the same recorded claude_id conversation"))).toBe(true);
    expect(evidence.some((e) => e.includes("dev-a@r1 (exited) and dev-b@r1 (exited)"))).toBe(true);
    expect(evidence.join("\n")).not.toContain("(running)");
  });

  // Sol's review of the 2nd round: a seat kept attached to an external CLI is not one restore launches, so the
  // snapshot's own comparison leaves it out; the fleet comparison still names it with the seat it shares with.
  it("leaves a seat kept attached to an external CLI out of the snapshot's own comparison", () => {
    const data = twoSeatSnapshot("conv-x", "conv-x");
    const attached = { ...seat("r1", "dev.b", "conv-x"), attachmentType: "external_cli" } as NodeInventoryEntry;
    const deps = liveDeps({ r1: [seat("r1", "dev.a", "conv-x", "exited"), attached] });
    const result = new RestoreCheckService({
      ...deps,
      getRestoreInputs: () => ({ snapshot: { id: "snap-r1", kind: "manual", data }, servicesRecord: null }),
    } as RestoreCheckDeps).check(check());
    const evidence = result.checks.map((c) => c.evidence);
    expect(evidence.some((e) => /dev\.a \([a-z]+\) and dev\.b/.test(e))).toBe(false);
    expect(evidence.some((e) => e.includes("dev-a@r1 (exited) and dev-b@r1 (running) have the same recorded claude_id conversation"))).toBe(true);
  });

  it("stays out of the recovery-only status poll", () => {
    const result = new RestoreCheckService(liveDeps({
      r1: [seat("r1", "dev.a", "conv-x"), seat("r1", "dev.b", "conv-x")],
    })).check({ recoveryOnly: true, noQueue: true, noHooks: true });
    expect(result.checks.filter((c) => c.check.endsWith(".shared-conversation"))).toEqual([]);
  });
});
