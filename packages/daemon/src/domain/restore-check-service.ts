import { existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { getCompatibleOpenRigPath } from "../openrig-compat.js";

// --- Types ---

export type CheckStatus = "green" | "yellow" | "red";
export type Verdict = "restorable" | "restorable_with_caveats" | "not_restorable" | "unknown";
export type FullyBackStatus = "fully_back" | "not_fully_back" | "unknown";
export type HostInfraStatus = "not_inspected" | "not_declared" | "unknown";

export interface CheckEntry {
  check: string;
  status: CheckStatus;
  evidence: string;
  remediation: string;
  /** Whether the remediation action is execution-safe (read-only / manual
   *  inspection). false for mutating actions (daemon start, chmod, create
   *  files, snapshot). Defaults to false (unsafe) if omitted — conservative
   *  so new checks without explicit classification don't invite agents to
   *  auto-execute mutating commands. */
  remediationSafe?: boolean;
}

export interface RepairStep {
  step: number;
  command: string;
  rationale: string;
  safe: boolean;
  blocking: boolean;
}

export interface RestoreAssertion {
  level: "host";
  status: FullyBackStatus;
  reason: string;
  blockingRigCount: number;
  caveatRigCount: number;
  unknownRigCount: number;
}

export interface RigRestoreRollup {
  rigId: string;
  rigName: string;
  status: FullyBackStatus;
  verdict: Verdict;
  expectedNodes: number;
  runningReadyNodes: number;
  blockedNodes: number;
  caveatNodes: number;
  blockingChecks: CheckEntry[];
  caveatChecks: CheckEntry[];
}

export interface HostInfraAssertion {
  status: HostInfraStatus;
  evidence: string;
}

export interface RestoreCheckResult {
  verdict: Verdict;
  fullyBack: boolean;
  assertion: RestoreAssertion;
  rigs: RigRestoreRollup[];
  hostInfra: HostInfraAssertion;
  counts: { red: number; yellow: number; green: number };
  checks: CheckEntry[];
  repairPacket: RepairStep[] | null;
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

interface RigRollupInput {
  rig: { rigId: string; name: string };
  nodes: NodeInventoryEntry[];
  checks: CheckEntry[];
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
    const rigRollupInputs: RigRollupInput[] = [];

    // Host-level checks — daemon probe throw produces unknown (not not_restorable).
    // Daemon definitely-down (healthy=false, negative text) is red/not_restorable.
    // Daemon probe exception (socket unavailable, etc.) is unknown.
    const daemonCheck = this.checkDaemonReachable();
    if (daemonCheck === null) {
      // Probe threw — state is uninspectable
      return this.buildUnknown([
        { check: "daemon.reachable", status: "red", evidence: "Daemon health probe failed (unable to determine state)", remediation: "Start the daemon with: rig daemon start",
      remediationSafe: false },
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
        { check: "probe.error", status: "red", evidence: `Failed to list rigs: ${err instanceof Error ? err.message : String(err)}`, remediation: "Check daemon status with: rig daemon status", remediationSafe: true },
      ]);
    }

    if (opts.rig) {
      rigs = rigs.filter((r) => r.name === opts.rig);
      if (rigs.length === 0) {
        return this.buildResult([
          ...checks,
          { check: `rig.${opts.rig}.exists`, status: "red", evidence: `Rig "${opts.rig}" not found`, remediation: "List rigs with: rig ps", remediationSafe: true },
        ], []);
      }
    }

    // Per-rig checks
    for (const rig of rigs) {
      const rigChecks: CheckEntry[] = [];

      const snapshotCheck = this.checkSnapshot(rig);
      checks.push(snapshotCheck);
      rigChecks.push(snapshotCheck);

      // Rig spec/root check
      const specCheck = this.checkSpecPresent(rig);
      checks.push(specCheck);
      rigChecks.push(specCheck);

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
        const readinessCheck = this.checkSeatReadiness(node);
        checks.push(readinessCheck);
        rigChecks.push(readinessCheck);

        const transcriptCheck = this.checkTranscript(rig.name, node);
        checks.push(transcriptCheck);
        rigChecks.push(transcriptCheck);

        const resumeCheck = this.checkResumePath(node);
        checks.push(resumeCheck);
        rigChecks.push(resumeCheck);

        if (!opts.noQueue) {
          const queueCheck = this.checkQueueFile(rig.name, node);
          checks.push(queueCheck);
          rigChecks.push(queueCheck);
        }
        if (!opts.noHooks) {
          const hooksCheck = this.checkHooks(node);
          checks.push(hooksCheck);
          rigChecks.push(hooksCheck);
        }
      }

      rigRollupInputs.push({ rig, nodes, checks: rigChecks });
    }

    return this.buildResult(checks, rigRollupInputs.map((input) => this.buildRigRollup(input)));
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
      remediationSafe: false,
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
      remediationSafe: false,
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
      remediationSafe: false,
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
      return { check, status: "green", evidence: "Terminal/infrastructure node — transcript exempt", remediation: "" };
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
      remediationSafe: true,
    };
  }

  private checkSeatReadiness(node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.readiness`;

    if (!node.canonicalSessionName) {
      return {
        check,
        status: "red",
        evidence: "Missing canonical session identity",
        remediation: "Restore or relaunch the seat so it has a canonical session identity",
        remediationSafe: false,
      };
    }

    if (node.sessionStatus !== "running" || node.startupStatus !== "ready") {
      const latestError = node.latestError ? ` latestError=${node.latestError}` : "";
      return {
        check,
        status: "red",
        evidence: `Seat not running/ready: sessionStatus=${node.sessionStatus ?? "unknown"} startupStatus=${node.startupStatus ?? "unknown"}${latestError}`,
        remediation: "Restore or relaunch the seat, then rerun rig restore-check",
        remediationSafe: false,
      };
    }

    return {
      check,
      status: "green",
      evidence: `Seat running and ready: ${node.canonicalSessionName}`,
      remediation: "",
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
      remediationSafe: true,
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
      remediationSafe: false,
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
      remediationSafe: true,
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
      remediationSafe: false,
      };
    }
    if (!this.deps.exists(rigYaml)) {
      return {
        check: `rig.${rig.name}.spec-present`, status: "yellow",
        evidence: `Rig root exists but rig.yaml missing: ${rigYaml}`,
        remediation: `Add a rig.yaml spec to ${rigRoot}`,
      remediationSafe: false,
      };
    }
    return { check: `rig.${rig.name}.spec-present`, status: "green", evidence: `Spec present at ${rigYaml}`, remediation: "" };
  }

  private buildResult(checks: CheckEntry[], rigs: RigRestoreRollup[]): RestoreCheckResult {
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

    const repairPacket = this.buildRepairPacket(checks, verdict);
    return this.withAssertion({ verdict, counts: { red, yellow, green }, checks, repairPacket }, rigs);
  }

  /** Probe error produces verdict=unknown (not not_restorable) so operators
   *  can distinguish "definitely broken" from "checker couldn't inspect." */
  private buildUnknown(checks: CheckEntry[]): RestoreCheckResult {
    const red = checks.filter((c) => c.status === "red").length;
    const yellow = checks.filter((c) => c.status === "yellow").length;
    const green = checks.filter((c) => c.status === "green").length;
    const repairPacket = this.buildRepairPacket(checks, "unknown");
    return this.withAssertion({ verdict: "unknown", counts: { red, yellow, green }, checks, repairPacket }, []);
  }

  private withAssertion(
    result: Pick<RestoreCheckResult, "verdict" | "counts" | "checks" | "repairPacket">,
    rigs: RigRestoreRollup[],
  ): RestoreCheckResult {
    const blockingRigCount = rigs.filter((rig) => rig.blockedNodes > 0 || rig.blockingChecks.length > 0).length;
    const caveatRigCount = rigs.filter((rig) => rig.blockedNodes === 0 && rig.blockingChecks.length === 0 && (rig.caveatNodes > 0 || rig.caveatChecks.length > 0)).length;
    const unknownRigCount = rigs.filter((rig) => rig.status === "unknown").length;

    let status: FullyBackStatus;
    let reason: string;
    if (result.verdict === "unknown") {
      status = "unknown";
      reason = "unknown_probe_state";
    } else if (result.counts.red > 0) {
      status = "not_fully_back";
      reason = "blockers_present";
    } else if (result.counts.yellow > 0) {
      status = "not_fully_back";
      reason = "caveats_present";
    } else {
      status = "fully_back";
      reason = "observable_rigs_fully_back";
    }

    return {
      ...result,
      fullyBack: status === "fully_back",
      assertion: {
        level: "host",
        status,
        reason,
        blockingRigCount,
        caveatRigCount,
        unknownRigCount,
      },
      rigs,
      hostInfra: {
        status: result.verdict === "unknown" ? "unknown" : "not_inspected",
        evidence: result.verdict === "unknown"
          ? "Host bootstrap/autostart source could not be inspected because restore-check state is unknown"
          : "No host bootstrap/autostart source inspected by v0; fullyBack only covers observable daemon, rig, and seat readiness",
      },
    };
  }

  private buildRigRollup(input: RigRollupInput): RigRestoreRollup {
    const blockingChecks = input.checks.filter((check) => check.status === "red");
    const caveatChecks = input.checks.filter((check) => check.status === "yellow");
    const expectedNodes = input.nodes.length;
    let runningReadyNodes = 0;
    let blockedNodes = 0;
    let caveatNodes = 0;

    for (const node of input.nodes) {
      const session = node.canonicalSessionName ?? node.logicalId;
      const nodeChecks = input.checks.filter((check) => check.check.startsWith(`seat.${session}.`));
      const hasBlocking = nodeChecks.some((check) => check.status === "red");
      const hasCaveat = nodeChecks.some((check) => check.status === "yellow");
      if (node.canonicalSessionName && node.sessionStatus === "running" && node.startupStatus === "ready") {
        runningReadyNodes += 1;
      }
      if (hasBlocking) blockedNodes += 1;
      else if (hasCaveat) caveatNodes += 1;
    }

    let verdict: Verdict;
    let status: FullyBackStatus;
    if (blockingChecks.length > 0) {
      verdict = "not_restorable";
      status = "not_fully_back";
    } else if (caveatChecks.length > 0) {
      verdict = "restorable_with_caveats";
      status = "not_fully_back";
    } else {
      verdict = "restorable";
      status = "fully_back";
    }

    return {
      rigId: input.rig.rigId,
      rigName: input.rig.name,
      status,
      verdict,
      expectedNodes,
      runningReadyNodes,
      blockedNodes,
      caveatNodes,
      blockingChecks,
      caveatChecks,
    };
  }

  /** Generate ordered repair steps from non-green checks with remediation.
   *  null when all green (restorable — nothing to repair).
   *  Blockers (red) first in check order, then caveats (yellow). */
  private buildRepairPacket(checks: CheckEntry[], verdict: Verdict): RepairStep[] | null {
    if (verdict === "restorable") return null;

    // Blockers first, then caveats, preserving original check order within each group
    const blockers = checks.filter((c) => c.status === "red" && c.remediation);
    const caveats = checks.filter((c) => c.status === "yellow" && c.remediation);
    const ordered = [...blockers, ...caveats];

    if (ordered.length === 0) return null;

    let step = 0;
    return ordered.map((c) => ({
      step: ++step,
      command: c.remediation,
      rationale: c.evidence,
      safe: c.remediationSafe === true,  // conservative: default false unless explicitly marked safe
      blocking: c.status === "red",
    }));
  }
}
