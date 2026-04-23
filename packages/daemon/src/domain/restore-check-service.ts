import { existsSync, accessSync, constants } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { getCompatibleOpenRigPath } from "../openrig-compat.js";

// --- Types ---

export type CheckStatus = "green" | "yellow" | "red";
export type Verdict = "restorable" | "restorable_with_caveats" | "not_restorable" | "unknown";
export type FullyBackStatus = "fully_back" | "not_fully_back" | "unknown";
export type HostInfraStatus = "not_inspected" | "not_declared" | "declared" | "unknown";

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

export type RecoveryStatus = "not_needed" | "actionable" | "blocked" | "unknown";

export interface RecoveryAction {
  scope: "rig";
  rigId: string;
  rigName: string;
  action: "restore_from_latest_snapshot";
  command: string;
  reason: string;
  safe: boolean;
  blocking: boolean;
}

export interface RecoveryIssue {
  scope: "host" | "rig";
  rigId?: string;
  rigName?: string;
  reason: string;
}

export interface RecoveryPlan {
  status: RecoveryStatus;
  summary: string;
  actions: RecoveryAction[];
  blocked: RecoveryIssue[];
  unknown: RecoveryIssue[];
}

export interface StartupContextResolvedFile {
  absolutePath: string;
  required: boolean;
  path?: string | null;
  deliveryHint?: string | null;
}

export interface StartupContextProjectionEntry {
  absolutePath: string;
  effectiveId?: string | null;
  category?: string | null;
}

export type StartupContextProbeResult =
  | {
      status: "ok";
      runtime: string | null;
      resolvedStartupFiles: StartupContextResolvedFile[];
      projectionEntries: StartupContextProjectionEntry[];
    }
  | {
      status: "missing" | "malformed" | "probe_error";
      evidence: string;
    };

export interface RestoreCheckResult {
  verdict: Verdict;
  fullyBack: boolean;
  assertion: RestoreAssertion;
  rigs: RigRestoreRollup[];
  hostInfra: HostInfraAssertion;
  recovery: RecoveryPlan;
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
  nodeId?: string | null;
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
  cwd?: string | null;
}

export interface RestoreCheckDeps {
  /** Get all rigs as summaries */
  listRigs: () => Array<{ rigId: string; name: string; hasServices?: boolean }>;
  /** Get node inventory for a rig (ADR-0002: NodeInventory projection) */
  getNodeInventory: (rigId: string) => NodeInventoryEntry[];
  /** Get persisted startup context for a node */
  getStartupContext: (nodeId: string) => StartupContextProbeResult;
  /** Check if a snapshot exists for a rig */
  hasSnapshot: (rigId: string) => boolean;
  /** Get the newest snapshot for exact restore planning when available */
  getLatestSnapshot?: (rigId: string) => { id: string; kind: string } | null;
  /** Probe daemon health: returns { healthy: boolean; evidence: string } */
  probeDaemonHealth: () => { healthy: boolean; evidence: string };
  /** Filesystem probes */
  exists: (path: string) => boolean;
  /** Read a declaration/config file. Kept injectable so restore-check remains testable and source-safe. */
  readFile: (path: string) => string;
  /** Substrate root for queue file path resolution */
  substrateRoot?: string;
}

interface RigRollupInput {
  rig: { rigId: string; name: string };
  nodes: NodeInventoryEntry[];
  checks: CheckEntry[];
}

interface RecoveryRigInput {
  rigId: string;
  rigName: string;
  expectedNodes: number;
  runningReadyNodes: number;
  blockingChecks: CheckEntry[];
  latestSnapshot: { id: string; kind: string } | null;
  snapshotLookupError?: string;
}

interface HostInfraCheckResult {
  check: CheckEntry;
  hostInfra: HostInfraAssertion;
}

// --- Service ---

const DAEMON_HEALTHY_PATTERN = /^Daemon running\b/m;
const CLAUDE_SESSION_START_COMPACT_COMMAND = "/Users/wrandom/code/substrate/shared-docs/control-plane/services/claude-hooks/bin/session-start-compact-context.sh";
const CLAUDE_USER_PROMPT_SUBMIT_COMMAND = "/Users/wrandom/code/substrate/shared-docs/control-plane/services/claude-hooks/bin/userpromptsubmit-queue-attention.sh";
const CLAUDE_HOOK_FRAGMENT_PATH = "/Users/wrandom/code/substrate/shared-docs/control-plane/services/claude-hooks/config/settings.fragment.json";

interface ClaudeSettingsCandidate {
  path: string;
  scope: "host-global" | "project" | "project-local";
}

interface ClaudeHookInspection {
  path: string;
  hasSessionStartCompact: boolean;
  hasUserPromptSubmit: boolean;
}

export class RestoreCheckService {
  private deps: RestoreCheckDeps;

  constructor(deps: RestoreCheckDeps) {
    this.deps = deps;
  }

  check(opts: RestoreCheckOpts): RestoreCheckResult {
    const checks: CheckEntry[] = [];
    const rigRollupInputs: RigRollupInput[] = [];
    const recoveryRigInputs: RecoveryRigInput[] = [];

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
    const hostInfraCheck = this.checkHostInfraDeclaration();
    checks.push(hostInfraCheck.check);

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
        ], [], hostInfraCheck.hostInfra);
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

        const startupContextCheck = this.checkStartupContext(node);
        if ("unknownChecks" in startupContextCheck) {
          return this.buildUnknown([
            ...checks,
            ...startupContextCheck.unknownChecks,
          ]);
        }
        checks.push(startupContextCheck.check);
        rigChecks.push(startupContextCheck.check);

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

    const rigRollups = rigRollupInputs.map((input) => this.buildRigRollup(input));
    for (const rollup of rigRollups) {
      const latestSnapshot = this.inspectLatestSnapshot(rollup.rigId);
      recoveryRigInputs.push({
        rigId: rollup.rigId,
        rigName: rollup.rigName,
        expectedNodes: rollup.expectedNodes,
        runningReadyNodes: rollup.runningReadyNodes,
        blockingChecks: rollup.blockingChecks,
        latestSnapshot: latestSnapshot.snapshot,
        snapshotLookupError: latestSnapshot.error,
      });
    }

    return this.buildResult(checks, rigRollups, hostInfraCheck.hostInfra, recoveryRigInputs);
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

  private checkHostInfraDeclaration(): HostInfraCheckResult {
    const declarationPath = getCompatibleOpenRigPath("host-infra.json");
    const check = "host.bootstrap-autostart.declaration";

    try {
      if (!this.deps.exists(declarationPath)) {
        const evidence = `Host infra declaration missing at ${declarationPath}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Create host infra declaration at ${declarationPath}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "not_declared",
            evidence,
          },
        };
      }

      let raw: string;
      try {
        raw = this.deps.readFile(declarationPath);
      } catch (err) {
        const evidence = `Host infra declaration inspection failed at ${declarationPath}: ${err instanceof Error ? err.message : String(err)}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Inspect or fix host infra declaration at ${declarationPath}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "unknown",
            evidence,
          },
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const evidence = `Host infra declaration JSON parse failed at ${declarationPath}: ${err instanceof Error ? err.message : String(err)}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Fix host infra declaration JSON at ${declarationPath}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "not_declared",
            evidence,
          },
        };
      }

      const validation = this.validateHostInfraDeclaration(parsed);
      if (validation.errors.length > 0) {
        const evidence = `Invalid host infra declaration at ${declarationPath}: missing/invalid ${validation.errors.join(", ")}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Fix host infra declaration shape at ${declarationPath}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "not_declared",
            evidence,
          },
        };
      }

      if (validation.schemaVersion === 2 && validation.evidenceProblems.length > 0) {
        const evidence = `Host infra declaration at ${declarationPath} declared with insufficient evidence paths; ${validation.evidenceProblems.join("; ")}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Add or repair host infra evidence path(s): ${validation.evidenceProblems.join("; ")}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "declared",
            evidence,
          },
        };
      }

      const evidence = validation.schemaVersion === 2
        ? `Host infra declaration at ${declarationPath} declared, evidence paths present, not autostart verified; daemonBootstrap mechanism=${validation.mechanism}; requiredSupportingInfra=${validation.requiredSupportingInfra}; evidencePaths=${validation.evidencePaths.join(", ")}`
        : `Host infra declaration at ${declarationPath} declared, not verified; daemonBootstrap mechanism=${validation.mechanism}; requiredSupportingInfra=${validation.requiredSupportingInfra}`;
      return {
        check: {
          check,
          status: "green",
          evidence,
          remediation: "",
        },
        hostInfra: {
          status: "declared",
          evidence,
        },
      };
    } catch (err) {
      const evidence = `Host infra declaration inspection failed at ${declarationPath}: ${err instanceof Error ? err.message : String(err)}`;
      return {
        check: {
          check,
          status: "yellow",
          evidence,
          remediation: `Inspect or fix host infra declaration at ${declarationPath}`,
          remediationSafe: false,
        },
        hostInfra: {
          status: "unknown",
          evidence,
        },
      };
    }
  }

  private validateHostInfraDeclaration(value: unknown): {
    errors: string[];
    schemaVersion: 1 | 2 | null;
    mechanism: string;
    requiredSupportingInfra: number;
    evidencePaths: string[];
    evidenceProblems: string[];
  } {
    const errors: string[] = [];
    const evidencePaths: string[] = [];
    const evidenceProblems: string[] = [];
    const obj = isRecord(value) ? value : null;
    if (obj === null) {
      return {
        errors: ["schemaVersion", "daemonBootstrap.mechanism", "supportingInfra"],
        schemaVersion: null,
        mechanism: "unknown",
        requiredSupportingInfra: 0,
        evidencePaths,
        evidenceProblems,
      };
    }

    const schemaVersion = obj["schemaVersion"] === 1 || obj["schemaVersion"] === 2
      ? obj["schemaVersion"]
      : null;
    if (schemaVersion === null) {
      errors.push("schemaVersion");
    }

    const daemonBootstrap = isRecord(obj["daemonBootstrap"]) ? obj["daemonBootstrap"] : null;
    const mechanism = daemonBootstrap && typeof daemonBootstrap["mechanism"] === "string"
      ? daemonBootstrap["mechanism"].trim()
      : "";
    if (!mechanism) {
      errors.push("daemonBootstrap.mechanism");
    }
    if (daemonBootstrap?.["declared"] !== true) {
      errors.push("daemonBootstrap.declared");
    }

    const supportingInfra = Array.isArray(obj["supportingInfra"]) ? obj["supportingInfra"] : null;
    if (!supportingInfra) {
      errors.push("supportingInfra");
    }
    const requiredSupportingInfra = supportingInfra
      ? supportingInfra.filter((entry) => isRecord(entry) && entry["required"] === true).length
      : 0;

    if (schemaVersion === 2 && errors.length === 0) {
      this.collectRequiredEvidencePaths(
        "daemonBootstrap.evidencePaths",
        daemonBootstrap?.["evidencePaths"],
        evidencePaths,
        evidenceProblems,
      );

      supportingInfra?.forEach((entry, index) => {
        if (!isRecord(entry) || entry["required"] !== true) return;
        const id = typeof entry["id"] === "string" && entry["id"].trim()
          ? entry["id"].trim()
          : String(index);
        this.collectRequiredEvidencePaths(
          `supportingInfra[${id}].evidencePaths`,
          entry["evidencePaths"],
          evidencePaths,
          evidenceProblems,
        );
      });
    }

    return {
      errors,
      schemaVersion,
      mechanism: mechanism || "unknown",
      requiredSupportingInfra,
      evidencePaths,
      evidenceProblems,
    };
  }

  private collectRequiredEvidencePaths(
    label: string,
    value: unknown,
    evidencePaths: string[],
    evidenceProblems: string[],
  ): void {
    if (!Array.isArray(value) || value.length === 0) {
      evidenceProblems.push(`${label} missing or empty`);
      return;
    }

    for (const candidate of value) {
      if (typeof candidate !== "string" || candidate.trim() === "") {
        evidenceProblems.push(`${label} contains invalid evidence path ${String(candidate)}`);
        continue;
      }

      const resolved = this.resolveHostInfraEvidencePath(candidate.trim());
      if ("error" in resolved) {
        evidenceProblems.push(`${label} invalid evidence path ${candidate}: ${resolved.error}`);
        continue;
      }

      const resolvedPath = resolved.path;
      evidencePaths.push(resolvedPath);
      if (!this.deps.exists(resolvedPath)) {
        evidenceProblems.push(`${label} missing evidence path ${resolvedPath}`);
      }
    }
  }

  private resolveHostInfraEvidencePath(rawPath: string): { path: string; error?: undefined } | { path?: undefined; error: string } {
    const openRigPrefix = "${OPENRIG_HOME}/";
    const hasTraversal = rawPath.split(/[\\/]+/).includes("..");

    if (rawPath.startsWith(openRigPrefix)) {
      const relativePath = rawPath.slice(openRigPrefix.length);
      if (!relativePath || isAbsolute(relativePath) || hasTraversal) {
        return { error: "path traversal or empty OPENRIG_HOME-relative path rejected" };
      }
      const openRigHome = getCompatibleOpenRigPath("");
      const resolved = join(openRigHome, relativePath);
      const relativeToHome = relative(openRigHome, resolved);
      if (relativeToHome.startsWith("..") || isAbsolute(relativeToHome)) {
        return { error: "path traversal outside OPENRIG_HOME rejected" };
      }
      return { path: resolved };
    }

    if (!isAbsolute(rawPath)) {
      return { error: "plain relative evidence paths are rejected; use absolute or ${OPENRIG_HOME}/..." };
    }
    if (hasTraversal) {
      return { error: "path traversal evidence paths are rejected" };
    }
    return { path: rawPath };
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

  private checkStartupContext(node: NodeInventoryEntry): { check: CheckEntry } | { unknownChecks: CheckEntry[] } {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.startup-context`;
    const runningReady = node.sessionStatus === "running" && node.startupStatus === "ready";

    if (!node.nodeId) {
      return {
        check: this.buildStartupContextAvailabilityCheck(
          check,
          runningReady,
          `Startup context cannot be inspected because node id is missing for ${session}`,
        ),
      };
    }

    const probe = this.deps.getStartupContext(node.nodeId);
    switch (probe.status) {
      case "probe_error":
        return {
          unknownChecks: [{
            check: "probe.error",
            status: "red",
            evidence: `Failed to inspect startup context for ${session}: ${probe.evidence}`,
            remediation: "Check daemon logs with: rig daemon logs",
            remediationSafe: true,
          }],
        };
      case "missing":
      case "malformed":
        return {
          check: this.buildStartupContextAvailabilityCheck(check, runningReady, probe.evidence),
        };
      case "ok":
        break;
    }

    const startupContext = probe;
    const missingRequired = startupContext.resolvedStartupFiles.filter((file) => file.required && !this.deps.exists(file.absolutePath));
    const missingOptional = startupContext.resolvedStartupFiles.filter((file) => !file.required && !this.deps.exists(file.absolutePath));
    const missingProjectionEntries = startupContext.projectionEntries.filter((entry) => !this.deps.exists(entry.absolutePath));

    if (missingRequired.length === 0 && missingOptional.length === 0 && missingProjectionEntries.length === 0) {
      const detailParts: string[] = [];
      if (startupContext.resolvedStartupFiles.length > 0) {
        detailParts.push(
          `resolved startup files present: ${startupContext.resolvedStartupFiles.map((file) => file.absolutePath).join(", ")}`
        );
      }
      if (startupContext.projectionEntries.length > 0) {
        detailParts.push(
          `projection source paths present: ${startupContext.projectionEntries.map((entry) => entry.absolutePath).join(", ")}`
        );
      }
      if (detailParts.length === 0) {
        detailParts.push("no persisted startup files or projection source paths declared");
      }
      return {
        check: {
          check,
          status: "green",
          evidence: `Startup context present for node ${node.nodeId}; ${detailParts.join("; ")}`,
          remediation: "",
        },
      };
    }

    const evidenceParts: string[] = [];
    if (missingRequired.length > 0) {
      evidenceParts.push(`missing required startup file(s): ${missingRequired.map((file) => file.absolutePath).join(", ")}`);
    }
    if (missingOptional.length > 0) {
      evidenceParts.push(`missing optional startup file(s): ${missingOptional.map((file) => file.absolutePath).join(", ")}`);
    }
    if (missingProjectionEntries.length > 0) {
      evidenceParts.push(`missing projection source path(s): ${missingProjectionEntries.map((entry) => entry.absolutePath).join(", ")}`);
    }

    const status: CheckStatus = missingRequired.length > 0 && !runningReady ? "red" : "yellow";
    return {
      check: {
        check,
        status,
        evidence: `Startup context present for node ${node.nodeId}, but replay inputs are incomplete: ${evidenceParts.join("; ")}`,
        remediation: `Restore or recreate the missing startup inputs from the rig or agent spec before trusting replay: ${[
          ...missingRequired.map((file) => file.absolutePath),
          ...missingOptional.map((file) => file.absolutePath),
          ...missingProjectionEntries.map((entry) => entry.absolutePath),
        ].join(", ")}`,
        remediationSafe: false,
      },
    };
  }

  private buildStartupContextAvailabilityCheck(
    check: string,
    runningReady: boolean,
    evidence: string,
  ): CheckEntry {
    return {
      check,
      status: runningReady ? "yellow" : "red",
      evidence,
      remediation: "Recreate the seat startup context from the rig or agent spec before trusting replay inputs",
      remediationSafe: false,
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

    if (node.nodeKind !== "agent") {
      return {
        check: `seat.${session}.hooks`, status: "green",
        evidence: "Infrastructure/terminal node; Claude Code hook inspection not applicable",
        remediation: "",
      };
    }

    if (node.runtime !== "claude-code") {
      return {
        check: `seat.${session}.hooks`, status: "green",
        evidence: `${node.runtime ?? "non-Claude"} seat; Claude Code hook inspection not applicable`,
        remediation: "",
      };
    }

    const candidates = this.getClaudeSettingsCandidates(node);
    const searchedPaths = candidates.map((candidate) => candidate.path);
    const cwdUnavailable = !node.cwd;
    const inspections: ClaudeHookInspection[] = [];
    const malformed: string[] = [];

    for (const candidate of candidates) {
      if (!this.deps.exists(candidate.path)) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(this.deps.readFile(candidate.path));
      } catch (err) {
        malformed.push(`${candidate.path}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      inspections.push({
        path: candidate.path,
        hasSessionStartCompact: this.hasClaudeCommandHook(parsed, "SessionStart", CLAUDE_SESSION_START_COMPACT_COMMAND, "compact"),
        hasUserPromptSubmit: this.hasClaudeCommandHook(parsed, "UserPromptSubmit", CLAUDE_USER_PROMPT_SUBMIT_COMMAND),
      });
    }

    if (malformed.length > 0) {
      return {
        check: `seat.${session}.hooks`, status: "yellow",
        evidence: `Malformed applicable Claude settings file(s): ${malformed.join("; ")}. Claude hook configuration could not be trusted until the malformed applicable settings file is fixed. Searched settings paths: ${searchedPaths.join(", ")}`,
        remediation: `Fix Claude settings JSON before trusting hook readiness: ${malformed.map((entry) => entry.split(":")[0]).join(", ")}`,
        remediationSafe: false,
      };
    }

    const sessionStartPaths = inspections
      .filter((inspection) => inspection.hasSessionStartCompact)
      .map((inspection) => inspection.path);
    const userPromptSubmitPaths = inspections
      .filter((inspection) => inspection.hasUserPromptSubmit)
      .map((inspection) => inspection.path);
    const hasSessionStart = sessionStartPaths.length > 0;
    const hasUserPromptSubmit = userPromptSubmitPaths.length > 0;

    if (hasSessionStart && hasUserPromptSubmit) {
      return {
        check: `seat.${session}.hooks`, status: "green",
        evidence: `Claude Code hook configuration present, not hook-execution verified; SessionStart matcher compact command found in ${sessionStartPaths.join(", ")}; UserPromptSubmit command found in ${userPromptSubmitPaths.join(", ")}. Searched settings paths: ${searchedPaths.join(", ")}`,
        remediation: "",
      };
    }

    const missing = [];
    if (!hasSessionStart) {
      missing.push(`SessionStart matcher compact command ${CLAUDE_SESSION_START_COMPACT_COMMAND}`);
    }
    if (!hasUserPromptSubmit) {
      missing.push(`UserPromptSubmit command ${CLAUDE_USER_PROMPT_SUBMIT_COMMAND}`);
    }

    const inspected = inspections.length > 0
      ? `Existing settings inspected: ${inspections.map((inspection) => inspection.path).join(", ")}.`
      : "No existing Claude settings files were found.";
    const cwdEvidence = cwdUnavailable
      ? " project settings were not inspected because cwd is unavailable."
      : "";

    return {
      check: `seat.${session}.hooks`, status: "yellow",
      evidence: `Claude Code hook configuration missing required entries: ${missing.join("; ")}. Searched settings paths: ${searchedPaths.join(", ")}. ${inspected}${cwdEvidence}`,
      remediation: `Merge required Claude hook entries from ${CLAUDE_HOOK_FRAGMENT_PATH} into host-global or project Claude settings`,
      remediationSafe: false,
    };
  }

  private getClaudeSettingsCandidates(node: NodeInventoryEntry): ClaudeSettingsCandidate[] {
    const home = process.env["HOME"] ?? "~";
    const candidates: ClaudeSettingsCandidate[] = [{
      path: join(home, ".claude", "settings.json"),
      scope: "host-global",
    }];

    if (node.cwd) {
      candidates.push({
        path: join(node.cwd, ".claude", "settings.json"),
        scope: "project",
      });
      candidates.push({
        path: join(node.cwd, ".claude", "settings.local.json"),
        scope: "project-local",
      });
    }

    return candidates;
  }

  private hasClaudeCommandHook(settings: unknown, eventName: string, requiredCommand: string, requiredMatcher?: string): boolean {
    if (!isRecord(settings) || !isRecord(settings["hooks"])) return false;
    const eventEntries = settings["hooks"][eventName];
    if (!Array.isArray(eventEntries)) return false;

    return eventEntries.some((entry) => {
      if (!isRecord(entry)) return false;
      if (requiredMatcher !== undefined && entry["matcher"] !== requiredMatcher) return false;
      const hooks = entry["hooks"];
      if (!Array.isArray(hooks)) return false;
      return hooks.some((hook) => isRecord(hook) && hook["command"] === requiredCommand);
    });
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

  private inspectLatestSnapshot(rigId: string): { snapshot: { id: string; kind: string } | null; error?: string } {
    if (!this.deps.getLatestSnapshot) {
      return { snapshot: null };
    }

    try {
      const snapshot = this.deps.getLatestSnapshot(rigId);
      if (!snapshot) return { snapshot: null };
      return { snapshot: { id: snapshot.id, kind: snapshot.kind } };
    } catch (err) {
      return {
        snapshot: null,
        error: `Latest snapshot lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private buildResult(
    checks: CheckEntry[],
    rigs: RigRestoreRollup[],
    hostInfra?: HostInfraAssertion,
    recoveryInputs: RecoveryRigInput[] = [],
  ): RestoreCheckResult {
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
    const recovery = this.buildRecovery(verdict, checks, recoveryInputs);
    return this.withAssertion({ verdict, counts: { red, yellow, green }, checks, repairPacket, recovery }, rigs, hostInfra);
  }

  /** Probe error produces verdict=unknown (not not_restorable) so operators
   *  can distinguish "definitely broken" from "checker couldn't inspect." */
  private buildUnknown(checks: CheckEntry[]): RestoreCheckResult {
    const red = checks.filter((c) => c.status === "red").length;
    const yellow = checks.filter((c) => c.status === "yellow").length;
    const green = checks.filter((c) => c.status === "green").length;
    const repairPacket = this.buildRepairPacket(checks, "unknown");
    const evidence = checks.find((check) => check.status === "red")?.evidence
      ?? "Restore-check state could not be inspected";
    return this.withAssertion({
      verdict: "unknown",
      counts: { red, yellow, green },
      checks,
      repairPacket,
      recovery: {
        status: "unknown",
        summary: "Recovery status could not be inspected because restore-check state is unknown.",
        actions: [],
        blocked: [],
        unknown: [{ scope: "host", reason: evidence }],
      },
    }, []);
  }

  private withAssertion(
    result: Pick<RestoreCheckResult, "verdict" | "counts" | "checks" | "repairPacket" | "recovery">,
    rigs: RigRestoreRollup[],
    hostInfra?: HostInfraAssertion,
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
      reason = hostInfra?.status === "declared"
        ? "observable_rigs_fully_back_host_infra_declared_not_verified"
        : "observable_rigs_fully_back";
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
      hostInfra: result.verdict === "unknown"
        ? {
            status: "unknown",
            evidence: "Host bootstrap/autostart source could not be inspected because restore-check state is unknown",
          }
        : (hostInfra ?? {
            status: "not_inspected",
            evidence: "No host bootstrap/autostart source inspected by v0; fullyBack only covers observable daemon, rig, and seat readiness",
          }),
      recovery: result.recovery,
    };
  }

  private buildRecovery(
    verdict: Verdict,
    checks: CheckEntry[],
    recoveryInputs: RecoveryRigInput[],
  ): RecoveryPlan {
    if (verdict === "unknown") {
      const evidence = checks.find((check) => check.status === "red")?.evidence
        ?? "Restore-check state could not be inspected";
      return {
        status: "unknown",
        summary: "Recovery status could not be inspected because restore-check state is unknown.",
        actions: [],
        blocked: [],
        unknown: [{ scope: "host", reason: evidence }],
      };
    }

    if (recoveryInputs.length === 0) {
      const firstRed = checks.find((check) => check.status === "red");
      if (firstRed) {
        return {
          status: "blocked",
          summary: "No exact recovery action is known in v0 because restore-check found blockers outside runnable rig inventory.",
          actions: [],
          blocked: [{ scope: "host", reason: firstRed.evidence }],
          unknown: [],
        };
      }
      return {
        status: "not_needed",
        summary: "All observable rigs are already running/ready; no recovery action needed.",
        actions: [],
        blocked: [],
        unknown: [],
      };
    }

    const allReady = recoveryInputs.every((input) => input.runningReadyNodes === input.expectedNodes);
    if (allReady) {
      return {
        status: "not_needed",
        summary: "All observable rigs are already running/ready; no recovery action needed.",
        actions: [],
        blocked: [],
        unknown: [],
      };
    }

    const actions: RecoveryAction[] = [];
    const blocked: RecoveryIssue[] = [];
    const unknown: RecoveryIssue[] = [];

    for (const input of recoveryInputs) {
      if (input.runningReadyNodes === input.expectedNodes) continue;

      if (input.snapshotLookupError) {
        unknown.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          reason: input.snapshotLookupError,
        });
        continue;
      }

      const restoreInputBlockers = input.blockingChecks.filter((check) =>
        this.classifyRecoveryBlockingCheck(check) === "restore_input"
      );
      if (restoreInputBlockers.length > 0) {
        blocked.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          reason: `No exact recovery action is known in v0 because restore-input blockers remain: ${restoreInputBlockers.map((check) => check.evidence).join("; ")}`,
        });
        continue;
      }

      if (input.latestSnapshot) {
        actions.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          action: "restore_from_latest_snapshot",
          command: `rig restore ${input.latestSnapshot.id} --rig ${input.rigId}`,
          reason: "Rig has a latest snapshot and one or more seats are not running/ready.",
          safe: false,
          blocking: true,
        });
        continue;
      }

      blocked.push({
        scope: "rig",
        rigId: input.rigId,
        rigName: input.rigName,
        reason: "No exact recovery action is known in v0 because latest snapshot input is missing.",
      });
    }

    const status: RecoveryStatus = unknown.length > 0
      ? "unknown"
      : actions.length > 0
        ? "actionable"
        : blocked.length > 0
          ? "blocked"
          : "not_needed";

    return {
      status,
      summary: this.buildRecoverySummary(status, actions, blocked, unknown),
      actions,
      blocked,
      unknown,
    };
  }

  private classifyRecoveryBlockingCheck(check: CheckEntry): "restore_input" | "runtime" | "other" {
    if (check.status !== "red") return "other";

    if (check.check.startsWith("seat.") && check.check.endsWith(".readiness")) {
      if (check.evidence.includes("Missing canonical session identity")) {
        return "restore_input";
      }
      return "runtime";
    }

    if (check.check.startsWith("seat.") && check.check.endsWith(".startup-context")) {
      return "restore_input";
    }

    return "other";
  }

  private buildRecoverySummary(
    status: RecoveryStatus,
    actions: RecoveryAction[],
    blocked: RecoveryIssue[],
    unknown: RecoveryIssue[],
  ): string {
    if (status === "not_needed") {
      return "All observable rigs are already running/ready; no recovery action needed.";
    }
    if (status === "unknown") {
      return `Recovery status could not be inspected completely; ${actions.length} actionable, ${blocked.length} blocked, ${unknown.length} unknown.`;
    }
    if (status === "actionable") {
      return `${actions.length} ${pluralize(actions.length, "rig")} can be recovered by known OpenRig command; ${blocked.length} ${pluralize(blocked.length, "rig")} blocked; ${unknown.length} unknown.`;
    }
    return `${blocked.length} ${pluralize(blocked.length, "rig")} blocked; ${actions.length} actionable; ${unknown.length} unknown.`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
