import { existsSync, accessSync, constants } from "node:fs";
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

    // Host-level checks — daemon probe throw produces unknown (not not_restorable).
    // Daemon definitely-down (healthy=false, negative text) is red/not_restorable.
    // Daemon probe exception (socket unavailable, etc.) is unknown.
    const daemonCheck = this.checkDaemonReachable();
    if (daemonCheck === null) {
      // Probe threw — state is uninspectable
      return this.buildUnknown([
        { check: "daemon.reachable", status: "red", evidence: "Daemon health probe failed (unable to determine state)", remediation: "Start the daemon with: rig daemon start" },
      ]);
    }
    checks.push(daemonCheck);
    checks.push(this.checkStateDirWritable());

    // Get rigs — probe error produces unknown, not not_restorable
    let rigs: Array<{ rigId: string; name: string; hasServices?: boolean }>;
    try {
      rigs = this.deps.listRigs();
    } catch (err) {
      return this.buildUnknown([
        ...checks,
        { check: "probe.error", status: "red", evidence: `Failed to list rigs: ${err instanceof Error ? err.message : String(err)}`, remediation: "Check daemon status with: rig daemon status" },
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

      // Rig spec/root check
      checks.push(this.checkSpecPresent(rig));

      // Per-seat checks — probe error produces unknown, not not_restorable
      let nodes: NodeInventoryEntry[];
      try {
        nodes = this.deps.getNodeInventory(rig.rigId);
      } catch (err) {
        return this.buildUnknown([
          ...checks,
          { check: "probe.error", status: "red", evidence: `Failed to get node inventory for ${rig.name}: ${err instanceof Error ? err.message : String(err)}`, remediation: "Check daemon status" },
        ]);
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

  /** Returns CheckEntry on success/definite-down; null on probe exception
   *  (uninspectable state → caller should produce verdict: unknown). */
  private checkDaemonReachable(): CheckEntry | null {
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
    } catch {
      // Probe threw — return null to signal uninspectable state
      return null;
    }
  }

  private checkStateDirWritable(): CheckEntry {
    const stateDir = getCompatibleOpenRigPath("");
    try {
      // Non-mutating permission probe — no file creation/deletion.
      // accessSync throws if the directory is not writable.
      accessSync(stateDir, constants.W_OK);
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
    // Slice 1: hook inspection not yet implemented. Honestly report as
    // yellow/not-inspected rather than false-green. --no-hooks removes
    // the check entirely; without --no-hooks, the check is present but
    // honestly classified as uninspected.
    return {
      check: `seat.${session}.hooks`, status: "yellow",
      evidence: "Hook inspection not yet implemented (Slice 2)",
      remediation: "Use --no-hooks to skip, or wait for Slice 2 hook inspection",
    };
  }

  private checkSpecPresent(rig: { rigId: string; name: string }): CheckEntry {
    const substrateRoot = this.deps.substrateRoot ?? join(process.env["HOME"] ?? "~", "code", "substrate", "shared-docs");
    const rigRoot = join(substrateRoot, "rigs", rig.name);
    const rigYaml = join(rigRoot, "rig.yaml");

    if (!this.deps.exists(rigRoot)) {
      return {
        check: `rig.${rig.name}.spec-present`, status: "red",
        evidence: `Rig root missing: ${rigRoot}`,
        remediation: `Create the rig root directory at ${rigRoot} with a rig.yaml spec`,
      };
    }
    if (!this.deps.exists(rigYaml)) {
      return {
        check: `rig.${rig.name}.spec-present`, status: "yellow",
        evidence: `Rig root exists but rig.yaml missing: ${rigYaml}`,
        remediation: `Add a rig.yaml spec to ${rigRoot}`,
      };
    }
    return { check: `rig.${rig.name}.spec-present`, status: "green", evidence: `Spec present at ${rigYaml}`, remediation: "" };
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

  /** Probe error produces verdict=unknown (not not_restorable) so operators
   *  can distinguish "definitely broken" from "checker couldn't inspect." */
  private buildUnknown(checks: CheckEntry[]): RestoreCheckResult {
    const red = checks.filter((c) => c.status === "red").length;
    const yellow = checks.filter((c) => c.status === "yellow").length;
    const green = checks.filter((c) => c.status === "green").length;
    return { verdict: "unknown", counts: { red, yellow, green }, checks, repairPacket: null };
  }
}
