import { existsSync, accessSync, constants, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getCompatibleOpenRigPath } from "../openrig-compat.js";

// --- Types ---

export type CheckStatus = "green" | "yellow" | "red";
export type Verdict = "restorable" | "restorable_with_caveats" | "not_restorable" | "unknown";

export interface CheckEntry {
  check: string;
  status: CheckStatus;
  evidence: string;
  remediation: string;
}

export interface RestoreCheckResult {
  verdict: Verdict;
  counts: { red: number; yellow: number; green: number };
  checks: CheckEntry[];
  repairPacket: null;
}

export interface RestoreCheckOpts {
  rig?: string;
  noQueue?: boolean;
  noHooks?: boolean;
}

// --- Deps (framework-free per ADR-0001; reads from existing projections per ADR-0002) ---

export interface NodeInventoryEntry {
  rigId: string;
  rigName: string;
  logicalId: string;
  podId: string | null;
  podNamespace?: string | null;
  canonicalSessionName: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: string | null;
  tmuxAttachCommand: string | null;
  latestError: string | null;
}

export interface RestoreCheckDeps {
  /** Get all rigs as summaries */
  listRigs: () => Array<{ rigId: string; name: string; hasServices?: boolean }>;
  /** Get node inventory for a rig (ADR-0002: NodeInventory projection) */
  getNodeInventory: (rigId: string) => NodeInventoryEntry[];
  /** Check if a snapshot exists for a rig */
  hasSnapshot: (rigId: string) => boolean;
  /** Probe daemon health: returns { healthy: boolean; evidence: string } */
  probeDaemonHealth: () => { healthy: boolean; evidence: string };
  /** Filesystem probes */
  exists: (path: string) => boolean;
  /** Substrate root for queue file path resolution */
  substrateRoot?: string;
}

// --- Service ---

const DAEMON_HEALTHY_PATTERN = /^Daemon running\b/m;

export class RestoreCheckService {
  private deps: RestoreCheckDeps;

  constructor(deps: RestoreCheckDeps) {
    this.deps = deps;
  }

  check(opts: RestoreCheckOpts): RestoreCheckResult {
    const checks: CheckEntry[] = [];

    // Host-level checks
    checks.push(this.checkDaemonReachable());
    checks.push(this.checkStateDirWritable());

    // Get rigs
    let rigs: Array<{ rigId: string; name: string; hasServices?: boolean }>;
    try {
      rigs = this.deps.listRigs();
    } catch {
      return this.buildResult([
        ...checks,
        { check: "host.rigs", status: "red", evidence: "Failed to list rigs", remediation: "Check daemon status with: rig daemon status" },
      ]);
    }

    if (opts.rig) {
      rigs = rigs.filter((r) => r.name === opts.rig);
      if (rigs.length === 0) {
        return this.buildResult([
          ...checks,
          { check: `rig.${opts.rig}.exists`, status: "red", evidence: `Rig "${opts.rig}" not found`, remediation: "List rigs with: rig ps" },
        ]);
      }
    }

    // Per-rig checks
    for (const rig of rigs) {
      checks.push(this.checkSnapshot(rig));

      // Per-seat checks
      let nodes: NodeInventoryEntry[];
      try {
        nodes = this.deps.getNodeInventory(rig.rigId);
      } catch {
        checks.push({ check: `rig.${rig.name}.seats-healthy`, status: "red", evidence: "Failed to get node inventory", remediation: "Check daemon status" });
        continue;
      }

      for (const node of nodes) {
        checks.push(this.checkTranscript(rig.name, node));
        checks.push(this.checkResumePath(node));
        if (!opts.noQueue) {
          checks.push(this.checkQueueFile(rig.name, node));
        }
        if (!opts.noHooks) {
          checks.push(this.checkHooks(node));
        }
      }
    }

    return this.buildResult(checks);
  }

  private checkDaemonReachable(): CheckEntry {
    try {
      const probe = this.deps.probeDaemonHealth();
      // Anchored positive match: only "Daemon running" at line start is green.
      // Anything else (including "Daemon not running", empty output, or text
      // that contains "running" non-anchored) is red. This preserves the
      // reviewer fix from prototype 0e2af8d.
      if (probe.healthy && DAEMON_HEALTHY_PATTERN.test(probe.evidence)) {
        return { check: "daemon.reachable", status: "green", evidence: probe.evidence, remediation: "" };
      }
      return {
        check: "daemon.reachable", status: "red",
        evidence: probe.evidence || "Daemon health probe returned non-positive result",
        remediation: "Start the daemon with: rig daemon start",
      };
    } catch (err) {
      return {
        check: "daemon.reachable", status: "red",
        evidence: `Probe failed: ${err instanceof Error ? err.message : String(err)}`,
        remediation: "Start the daemon with: rig daemon start",
      };
    }
  }

  private checkStateDirWritable(): CheckEntry {
    const stateDir = getCompatibleOpenRigPath("");
    const probePath = join(stateDir, ".restore-check-probe");
    try {
      writeFileSync(probePath, "probe", "utf-8");
      unlinkSync(probePath);
      return { check: "host.state-dir-writable", status: "green", evidence: `${stateDir} is writable`, remediation: "" };
    } catch {
      return {
        check: "host.state-dir-writable", status: "red",
        evidence: `${stateDir} is not writable`,
        remediation: `Fix permissions: chmod u+w ${stateDir}`,
      };
    }
  }

  private checkSnapshot(rig: { rigId: string; name: string }): CheckEntry {
    try {
      const has = this.deps.hasSnapshot(rig.rigId);
      if (has) {
        return { check: `rig.${rig.name}.snapshot`, status: "green", evidence: "Snapshot available", remediation: "" };
      }
      return {
        check: `rig.${rig.name}.snapshot`, status: "yellow",
        evidence: "No snapshot found (first-boot or adopted rig)",
        remediation: "Create a snapshot with: rig snapshot <rigId>",
      };
    } catch {
      return { check: `rig.${rig.name}.snapshot`, status: "yellow", evidence: "Could not check snapshots", remediation: "" };
    }
  }

  private checkTranscript(rigName: string, node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.transcript`;

    // Terminal/infrastructure nodes are exempt from transcript checks
    if (node.nodeKind === "infrastructure") {
      return { check, status: "yellow", evidence: "Terminal/infrastructure node — transcript exempt", remediation: "" };
    }

    const transcriptPath = join(
      getCompatibleOpenRigPath("transcripts"),
      rigName,
      `${session}.log`
    );
    if (this.deps.exists(transcriptPath)) {
      return { check, status: "green", evidence: `Transcript exists at ${transcriptPath}`, remediation: "" };
    }
    return {
      check, status: "yellow",
      evidence: `Transcript missing: ${transcriptPath}`,
      remediation: "Transcript will be created on next session launch",
    };
  }

  private checkResumePath(node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    if (node.tmuxAttachCommand) {
      return { check: `seat.${session}.resume-path`, status: "green", evidence: node.tmuxAttachCommand, remediation: "" };
    }
    return {
      check: `seat.${session}.resume-path`, status: "yellow",
      evidence: "No attach command available",
      remediation: "Session will be created fresh on restore",
    };
  }

  private checkQueueFile(rigName: string, node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.queue-file`;

    // Derive queue file path from pod/member
    const podName = node.podNamespace ?? (node.logicalId.includes(".") ? node.logicalId.split(".")[0] : null);
    const memberName = node.logicalId.includes(".") ? node.logicalId.split(".").slice(1).join(".") : node.logicalId;

    if (!podName) {
      return { check, status: "yellow", evidence: "Cannot derive queue path (no pod namespace)", remediation: "" };
    }

    const substrateRoot = this.deps.substrateRoot ?? join(process.env["HOME"] ?? "~", "code", "substrate", "shared-docs");
    const queuePath = join(substrateRoot, "rigs", rigName, "state", podName, `${memberName}.queue.md`);

    if (this.deps.exists(queuePath)) {
      return { check, status: "green", evidence: `Queue file exists at ${queuePath}`, remediation: "" };
    }
    return {
      check, status: "yellow",
      evidence: `Queue file missing: ${queuePath}`,
      remediation: "Create queue file per attention-queue convention",
    };
  }

  private checkHooks(node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    // Slice 1: hook check is a placeholder — checks for hook install records
    return { check: `seat.${session}.hooks`, status: "green", evidence: "Hook check not yet implemented (Slice 2)", remediation: "" };
  }

  private buildResult(checks: CheckEntry[]): RestoreCheckResult {
    const red = checks.filter((c) => c.status === "red").length;
    const yellow = checks.filter((c) => c.status === "yellow").length;
    const green = checks.filter((c) => c.status === "green").length;

    let verdict: Verdict;
    if (red > 0) {
      verdict = "not_restorable";
    } else if (yellow > 0) {
      verdict = "restorable_with_caveats";
    } else {
      verdict = "restorable";
    }

    return { verdict, counts: { red, yellow, green }, checks, repairPacket: null };
  }
}
