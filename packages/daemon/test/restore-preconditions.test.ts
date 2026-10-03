import { describe, expect, it, vi } from "vitest";
import { validatePreRestore } from "../src/domain/restore-preconditions.js";
import { RestoreCheckService, type RestoreCheckDeps, type NodeInventoryEntry } from "../src/domain/restore-check-service.js";
import type { SnapshotData, RigServicesRecord } from "../src/domain/types.js";

function data(): SnapshotData {
  return {
    rig: { id: "rig-1", name: "test-rig", createdAt: "", updatedAt: "" },
    nodes: [{ id: "node-1", logicalId: "seat", cwd: "/project" }],
    sessions: [], edges: [], checkpoints: {},
    nodeStartupContext: { "node-1": {
      runtime: "claude-code", projectionEntries: [], startupActions: [],
      resolvedStartupFiles: [{ path: "notes.md", ownerRoot: "/owner", absolutePath: "/files/notes.md", required: true }],
    } },
  } as SnapshotData;
}

function services(): RigServicesRecord {
  return { rigId: "rig-1", kind: "compose", specJson: "{}", rigRoot: "/services", composeFile: "/services/compose.yaml", projectName: "test", latestReceiptJson: null, createdAt: "", updatedAt: "" };
}

function node(rigId = "rig-1", running = false): NodeInventoryEntry {
  return {
    nodeId: "node-1", logicalId: "seat", rigId, rigName: rigId,
    podId: null, canonicalSessionName: `seat@${rigId}`, nodeKind: "infrastructure", runtime: "terminal",
    sessionStatus: running ? "running" : "exited", startupStatus: "ready", tmuxAttachCommand: null, latestError: null,
  };
}

function deps(overrides: Partial<RestoreCheckDeps> = {}): RestoreCheckDeps {
  return {
    listRigs: () => [{ rigId: "rig-1", name: "test-rig" }],
    getNodeInventory: () => [node()],
    getStartupContext: () => ({ status: "ok", runtime: "terminal", resolvedStartupFiles: [], projectionEntries: [] }),
    hasSnapshot: () => true,
    getRestoreInputs: () => ({ snapshot: { id: "chosen-snapshot", kind: "manual", data: data() }, servicesRecord: services() }),
    probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
    exists: () => true,
    readFile: () => JSON.stringify({ schemaVersion: 1, daemonBootstrap: { declared: true, mechanism: "service", evidence: "fixture" }, supportingInfra: [] }),
    ...overrides,
  };
}

const cases = [
  ["/owner", "startup_owner_root_missing", "Required startup file owner root is missing for seat: /owner", "Restore the agent/source root or capture a new snapshot with reachable startup context."],
  ["/services", "service_rig_root_missing", "Service rig root is missing: /services", "Restore the service rig root or update the services record before retrying restore."],
  ["/services/compose.yaml", "service_compose_file_missing", "Service compose file is missing: /services/compose.yaml", "Restore the compose file or update the services record before retrying restore."],
] as const;

describe("shared restore preconditions", () => {
  it.each(cases)("preserves the exact refusal for missing %s", (missing, code, message, remediation) => {
    const result = validatePreRestore(data(), { fsOps: { exists: (path) => path !== missing }, servicesRecord: services() });
    expect(result).toEqual({
      blockers: [{ code, severity: "critical", message, remediation, path: missing,
        ...(code === "startup_owner_root_missing"
          ? { nodeId: "node-1", logicalId: "seat", target: "notes.md" }
          : { target: code === "service_rig_root_missing" ? "services.rigRoot" : "services.composeFile" }),
      }], warnings: [],
    });
  });

  it("retains blocker order and optional-file warnings", () => {
    const snapshot = data();
    snapshot.nodeStartupContext!["node-1"]!.resolvedStartupFiles.push({ path: "optional.md", ownerRoot: "/optional", absolutePath: "/optional/file", required: false } as never);
    const result = validatePreRestore(snapshot, { fsOps: { exists: () => false }, servicesRecord: services() });
    expect(result.blockers.map((b) => b.code)).toEqual([
      "startup_owner_root_missing", "required_startup_file_missing", "service_rig_root_missing", "service_compose_file_missing",
    ]);
    expect(result.warnings).toEqual(["Restore pre-validation: optional startup file missing for seat: /optional/file"]);
  });

  it("does not validate replay-only files on native resume; explicit fresh does", () => {
    const snapshot = data();
    snapshot.sessions = [{ id: "session-1", nodeId: "node-1", status: "exited", resumeToken: "native-token", resumeType: "claude_id", restorePolicy: "resume_if_possible" }] as SnapshotData["sessions"];
    snapshot.activeSessionIdByNode = { "node-1": "session-1" };
    const opts = { fsOps: { exists: () => false }, servicesRecord: null };
    expect(validatePreRestore(snapshot, opts)).toEqual({ blockers: [], warnings: [] });
    expect(validatePreRestore(snapshot, { ...opts, freshLogicalIds: ["seat"] }).blockers.map((b) => b.code))
      .toEqual(["startup_owner_root_missing", "required_startup_file_missing"]);
  });

  it("preserves the absent-service and default-existence behavior", () => {
    expect(validatePreRestore(data(), {})).toEqual({ blockers: [], warnings: [] });
  });
});

describe("restore-check consumes the shared snapshot validation", () => {
  it.each(cases)("reports %s as red with the original message, remediation and snapshot", (missing, code, message, remediation) => {
    const result = new RestoreCheckService(deps({ exists: (path) => path !== missing })).check({ compact: true, noQueue: true, noHooks: true });
    expect(result.checks.find((c) => c.check === "rig.test-rig.restore-preconditions")).toEqual({
      check: "rig.test-rig.restore-preconditions", status: "red",
      evidence: `Snapshot chosen-snapshot: ${code}: ${message}`, remediation, remediationSafe: false,
    });
    expect(result.verdict).toBe("not_restorable");
    expect(result.recovery.status).toBe("blocked");
    expect(result.recovery.actions).toEqual([]);
    expect(result.recovery.blocked[0]?.reason).toContain(message);
  });

  it("uses yellow for warnings only and green for a completed empty result", () => {
    const snapshot = data();
    snapshot.nodeStartupContext!["node-1"]!.resolvedStartupFiles[0]!.required = false;
    const getRestoreInputs = () => ({ snapshot: { id: "optional", kind: "manual", data: snapshot }, servicesRecord: null });
    const warning = new RestoreCheckService(deps({ getRestoreInputs, exists: (path) => path !== "/files/notes.md" })).check({});
    expect(warning.checks.find((c) => c.check.endsWith("restore-preconditions"))?.status).toBe("yellow");
    const green = new RestoreCheckService(deps({ getRestoreInputs })).check({});
    expect(green.checks.find((c) => c.check.endsWith("restore-preconditions"))?.status).toBe("green");
  });

  it.each(["no usable current-occupant snapshot", "snapshot read failed"])("isolates unavailable inputs: %s", (reason) => {
    const getRestoreInputs = vi.fn((rigId: string) => {
      if (rigId === "rig-1") {
        if (reason === "snapshot read failed") throw new Error(reason);
        return { unavailable: reason };
      }
      return { snapshot: { id: "other-snapshot", kind: "manual", data: data() }, servicesRecord: null };
    });
    const result = new RestoreCheckService(deps({
      listRigs: () => [{ rigId: "rig-1", name: "broken" }, { rigId: "rig-2", name: "healthy" }],
      getNodeInventory: (id) => [node(id)], getRestoreInputs,
    })).check({ noQueue: true, noHooks: true });
    expect(getRestoreInputs).toHaveBeenCalledTimes(2);
    expect(result.verdict).toBe("unknown");
    expect(result.rigs.find((r) => r.rigId === "rig-1")?.status).toBe("unknown");
    expect(result.rigs.find((r) => r.rigId === "rig-2")?.status).not.toBe("unknown");
    expect(result.recovery.unknown[0]?.reason).toContain(reason);
    expect(result.recovery.actions.map((a) => a.rigId)).toEqual(["rig-2"]);
    expect(result.checks.find((c) => c.check === "rig.healthy.restore-preconditions")?.status).toBe("green");
  });

  it("skips added reads only for all-ready recovery polls, never an explicit check", () => {
    const getRestoreInputs = vi.fn(deps().getRestoreInputs);
    const service = new RestoreCheckService(deps({ getRestoreInputs, getNodeInventory: () => [node("rig-1", true)] }));
    expect(service.check({ recoveryOnly: true }).recovery.status).toBe("not_needed");
    expect(getRestoreInputs).not.toHaveBeenCalled();
    service.check({});
    expect(getRestoreInputs).toHaveBeenCalledTimes(1);
  });

  it("validates mixed and empty rigs even in recovery-only mode", () => {
    for (const nodes of [[], [node("rig-1", true), node("rig-1", false)]]) {
      const getRestoreInputs = vi.fn(deps().getRestoreInputs);
      new RestoreCheckService(deps({ getRestoreInputs, getNodeInventory: () => nodes })).check({ recoveryOnly: true });
      expect(getRestoreInputs).toHaveBeenCalledTimes(1);
    }
  });
});
