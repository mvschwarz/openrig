import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { getOpenRigHome, isFixtureScopedHome, readOpenRigEnv } from "../openrig-compat.js";
import { ConfigStore } from "../config-store.js";
import { realDeps } from "./daemon.js";

// The daemon.port default (DEFAULT_CONFIG in config-store.ts). A fixture
// target "diverges" when it is resolved from file/env AND is not this value.
const DEFAULT_DAEMON_PORT = 7433;

interface FixtureLeak {
  fixtureHome: string;
  /** The divergent daemon target (port number, or the leaked OPENRIG_URL). */
  target: string | number;
  source: string;
}

/**
 * OPR.0.4.3.12 — Detect a leaked fixture-scoped home with a divergent daemon
 * target. Composes the PATH-ONLY `isFixtureScopedHome` predicate (from
 * openrig-compat, no ConfigStore dependency) with a ConfigStore
 * divergent-target confirmation HERE (restore-check is downstream of both, so
 * no import cycle). Returns null unless BOTH hold, so a legit non-default port
 * under the real home never trips the guard.
 */
function detectFixtureLeak(): FixtureLeak | null {
  const fixtureHome = getOpenRigHome();
  if (!isFixtureScopedHome(fixtureHome)) return null;

  // A leaked OPENRIG_URL points the status probe at the fixture directly.
  const leakedUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
  if (leakedUrl) {
    return { fixtureHome, target: leakedUrl, source: "env (OPENRIG_URL)" };
  }

  // Otherwise confirm a divergent daemon.port resolved from the fixture's
  // config.json / OPENRIG_PORT (source !== "default" AND value !== 7433).
  let resolved: { value: string | number | boolean; source: string } | undefined;
  try {
    resolved = new ConfigStore().resolveWithSource("daemon.port");
  } catch {
    resolved = undefined;
  }
  if (resolved && resolved.source !== "default" && resolved.value !== DEFAULT_DAEMON_PORT) {
    return { fixtureHome, target: resolved.value as number, source: resolved.source };
  }
  return null;
}

/**
 * Build the honest, NON-MUTATING both-homes result for a detected fixture
 * leak — instead of the blocking `rig daemon start` / `scope:"host"` packet.
 * Names both the fixture home (+ its divergent target/source) and the real
 * default home (+ default port), with a non-mutating remediation.
 */
function fixtureLeakResult(leak: FixtureLeak): RestoreCheckResult {
  const realHome = join(homedir(), ".openrig");
  const evidence =
    `restore-check ran under a fixture-scoped OPENRIG_HOME (${leak.fixtureHome}) whose daemon ` +
    `target diverges (${leak.source} = ${leak.target}). The real default home is ${realHome} ` +
    `(daemon.port ${DEFAULT_DAEMON_PORT}). The real kernel was NOT probed — this is a leaked ` +
    `test fixture, not a host-down condition.`;
  const remediation =
    `Unset the leaked OPENRIG_HOME / OPENRIG_PORT / OPENRIG_URL (or re-target to ${realHome}), ` +
    `then re-run: rig restore-check`;
  return localRestoreResult({
    verdict: "unknown",
    checks: [{ check: "home.fixture-scoped", status: "yellow", evidence, remediation }],
    repairPacket: [{
      step: 1,
      command: remediation,
      rationale: "Fixture-scoped OPENRIG_HOME leaked into a real-kernel recovery command",
      safe: true,      // non-mutating: unsetting env / re-targeting, not starting a daemon
      blocking: false,
    }],
    recovery: {
      status: "unknown",
      summary:
        `Recovery state was not inspected: this invocation used a fixture-scoped home ` +
        `(${leak.fixtureHome}), not the real default home (${realHome}). Clear the leaked ` +
        `OpenRig home/target env and re-run to inspect the real kernel.`,
      actions: [],
      blocked: [],
      unknown: [],
    },
  });
}

export interface RestoreCheckDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (url: string) => DaemonClient;
}

interface CheckEntry {
  check: string;
  status: "green" | "yellow" | "red";
  evidence: string;
  remediation: string;
}

interface RepairStep {
  step: number;
  command: string;
  rationale: string;
  safe: boolean;
  blocking: boolean;
}

interface ReadinessAssertion {
  status: "ready" | "ready_with_caveats" | "not_ready" | "unknown";
  reason: string;
  blockingRigCount: number;
  caveatRigCount: number;
  unknownRigCount: number;
}

interface ContinuityAssertion {
  status: "proven" | "not_proven" | "partial" | "not_applicable";
  evidence: string;
  provenCapabilities: string[];
  unprovenCapabilities: string[];
}

interface RigRestoreRollup {
  rigId: string;
  rigName: string;
  status: "ready" | "ready_with_caveats" | "not_ready" | "unknown";
  verdict: "restorable" | "restorable_with_caveats" | "not_restorable" | "unknown";
  expectedNodes: number;
  runningReadyNodes: number;
  blockedNodes: number;
  caveatNodes: number;
  blockingChecks: CheckEntry[];
  caveatChecks: CheckEntry[];
}

interface HostInfraAssertion {
  status: "not_inspected" | "not_declared" | "declared" | "unknown";
  evidence: string;
}

interface RecoveryAction {
  scope: "rig";
  rigId: string;
  rigName: string;
  action: "restore_from_latest_snapshot";
  command: string;
  reason: string;
  safe: boolean;
  blocking: boolean;
}

interface RecoveryIssue {
  scope: "host" | "rig";
  rigId?: string;
  rigName?: string;
  reason: string;
}

interface RecoveryPlan {
  status: "not_needed" | "actionable" | "blocked" | "unknown";
  summary: string;
  actions: RecoveryAction[];
  blocked: RecoveryIssue[];
  unknown: RecoveryIssue[];
}

interface RestoreCheckResult {
  verdict: "restorable" | "restorable_with_caveats" | "not_restorable" | "unknown";
  readiness: ReadinessAssertion;
  continuity: ContinuityAssertion;
  rigs: RigRestoreRollup[];
  hostInfra: HostInfraAssertion;
  recovery: RecoveryPlan;
  counts: { red: number; yellow: number; green: number };
  // OPR.0.4.0.29 FR-8 — ready-confidence breakdown by the 5 real-enum classes.
  classCounts?: {
    ready: number;
    ready_with_caveats: number;
    not_ready: number;
    attention_required: number;
    unknown: number;
  };
  checks: CheckEntry[];
  repairPacket: RepairStep[] | null;
}

const STATUS_SYMBOLS: Record<string, string> = {
  green: "✓",
  yellow: "⚠",
  red: "✗",
};

const STATUS_COLORS: Record<string, string> = {
  green: "",
  yellow: "",
  red: "",
};

export function restoreCheckCommand(depsOverride?: RestoreCheckDeps): Command {
  const cmd = new Command("restore-check")
    .description("Check restore readiness across running rigs")
    .addHelpText("after", `
Examples:
  rig restore-check                    Check all rigs
  rig restore-check --rig openrig-pm   Check one rig
  rig restore-check --no-queue         Skip queue file checks
  rig restore-check --no-hooks         Skip hook checks
  rig restore-check --json             JSON output for agents

Exit codes:
  0  Restorable (or restorable with caveats)
  1  Not restorable (red blockers found)
  2  Unknown / probe error`);

  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--json", "JSON output (compact summary by default; use --full --json for complete detail)")
    .option("--full", "Show complete per-seat detail (today's default)")
    .option("--ready", "Show ready-seat detail in addition to not-ready")
    .option("--rig <name>", "Check one rig only")
    .option("--no-queue", "Skip queue file checks")
    .option("--no-hooks", "Skip hook checks")
    .addHelpText("after", `
Default: compact summary with per-rig readiness counts and NOT-READY seats only.
Ready seats are counted but their detail is omitted to save tokens.

Use --full for today's complete per-seat detail (all checks, repair packet, etc.).
Use --ready to include ready-seat detail alongside not-ready.
Use --full --json for the complete JSON firehose.

Readiness classes: ready, ready_with_caveats, not_ready, attention_required, unknown.

Examples:
  rig restore-check                       Compact summary (counts + not-ready)
  rig restore-check --json                Compact JSON summary
  rig restore-check --full                Complete per-seat detail
  rig restore-check --full --json         Complete JSON (the firehose)
  rig restore-check --ready               Include ready seats in output
  rig restore-check --rig my-rig          Check one rig only`)
    .action(async (opts: { json?: boolean; full?: boolean; ready?: boolean; rig?: string; queue?: boolean; hooks?: boolean }) => {
      const deps = getDepsF();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        // OPR.0.4.3.12 — fixture-home isolation guard. A leaked fixture
        // OPENRIG_HOME with a divergent daemon target makes getDaemonStatus
        // probe the WRONG port (connection-refused) and report the real
        // kernel as down. Detect that precise leak and respond honestly
        // (both homes named, non-mutating) instead of the blocking
        // `rig daemon start` / `scope:"host"` host-repair packet. Fires ONLY
        // under a detected fixture-scoped home + divergent target, so the
        // genuine daemon-down contract below is preserved for real homes.
        const leak = detectFixtureLeak();
        if (leak) {
          const result = fixtureLeakResult(leak);
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            printHuman(result);
          }
          process.exitCode = 2;
          return;
        }

        // Daemon down — produce a structured not_restorable result
        const result = localRestoreResult({
          verdict: "not_restorable",
          checks: [{
            check: "daemon.reachable",
            status: "red",
            evidence: "Daemon is not running",
            remediation: "Start the daemon with: rig daemon start",
          }],
          repairPacket: [{
            step: 1,
            command: "Start the daemon with: rig daemon start",
            rationale: "Daemon is not running",
            safe: false,  // mutating: starts a daemon process
            blocking: true,
          }],
          recovery: {
            status: "blocked",
            summary: "No exact rig recovery action is known until the daemon is running.",
            actions: [],
            blocked: [{
              scope: "host",
              reason: "Daemon is not running; rig state could not be inspected for recovery planning.",
            }],
            unknown: [],
          },
        });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printHuman(result);
        }
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));

      try {
        const params = new URLSearchParams();
        // Compact by default; --full opts out. --ready stays COMPACT and adds
        // ready-seat detail (ready=1) IN ADDITION to the not-ready rows — it is
        // NOT the full firehose (OPR.0.4.0.29 FR-2 / forward-fix corrective).
        if (!opts.full) params.set("compact", "1");
        if (opts.ready) params.set("ready", "1");
        if (opts.rig) params.set("rig", opts.rig);
        if (opts.queue === false) params.set("noQueue", "true");
        if (opts.hooks === false) params.set("noHooks", "true");
        const query = params.toString();
        const path = `/api/restore-check${query ? `?${query}` : ""}`;

        const response = await client.get<RestoreCheckResult>(path);

        if (response.status >= 500) {
          const result = localRestoreResult({
            verdict: "unknown",
            checks: [{
              check: "probe.error",
              status: "red",
              evidence: `Daemon returned HTTP ${response.status}`,
              remediation: "Check daemon logs with: rig daemon logs",
            }],
            repairPacket: [{
              step: 1,
              command: "Check daemon logs with: rig daemon logs",
              rationale: `Daemon returned HTTP ${response.status}`,
              safe: true,
              blocking: true,
            }],
            recovery: {
              status: "unknown",
              summary: `Recovery status could not be inspected because daemon returned HTTP ${response.status}.`,
              actions: [],
              blocked: [],
              unknown: [{
                scope: "host",
                reason: `Daemon returned HTTP ${response.status}`,
              }],
            },
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            printHuman(result);
          }
          process.exitCode = 2;
          return;
        }

        const result = response.data;

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (opts.full) {
          printHuman(result);
        } else {
          printCompact(result);
        }

        // Exit codes: 0 for restorable/restorable_with_caveats; 1 for not_restorable; 2 for unknown
        if (result.verdict === "not_restorable") {
          process.exitCode = 1;
        } else if (result.verdict === "unknown") {
          process.exitCode = 2;
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        console.error("Fix: check daemon status with: rig daemon status");
        process.exitCode = 2;
      }
    });

  return cmd;
}

function printHuman(result: RestoreCheckResult): void {
  const verdictLabel = result.verdict.replace(/_/g, " ").toUpperCase();
  console.log(`RESTORE CHECK — ${verdictLabel}`);
  console.log(`${result.counts.green} green | ${result.counts.yellow} yellow | ${result.counts.red} red`);
  const readinessLabel = result.readiness.status.replace(/_/g, " ");
  console.log(`READINESS: ${readinessLabel} (${result.readiness.reason})`);
  console.log(`CONTINUITY: ${result.continuity.status.replace(/_/g, " ")}`);
  if (result.hostInfra) {
    console.log(`Host bootstrap/autostart: ${result.hostInfra.status} — ${result.hostInfra.evidence}`);
  }
  console.log(`RECOVERY: ${result.recovery.status.replace(/_/g, " ").toUpperCase()}`);
  console.log(result.recovery.summary);
  for (const action of result.recovery.actions) {
    console.log(`  Action: ${action.command}`);
  }
  for (const issue of result.recovery.blocked) {
    console.log(`  Blocked: ${issue.reason}`);
  }
  for (const issue of result.recovery.unknown) {
    console.log(`  Unknown: ${issue.reason}`);
  }
  if (result.rigs && result.rigs.length > 0) {
    console.log();
    console.log("Per-rig summary:");
    console.log(`${"rig".padEnd(24)} ${"status".padEnd(16)} ${"ready".padEnd(9)} ${"blocked".padEnd(8)} caveats`);
    for (const rig of result.rigs) {
      console.log(
        `${rig.rigName.slice(0, 24).padEnd(24)} ${rig.status.padEnd(16)} ` +
        `${`${rig.runningReadyNodes}/${rig.expectedNodes}`.padEnd(9)} ${String(rig.blockedNodes).padEnd(8)} ${rig.caveatNodes}`
      );
    }
  }
  console.log();

  for (const check of result.checks) {
    const sym = STATUS_SYMBOLS[check.status] ?? "?";
    console.log(`  ${sym} ${check.check}: ${check.evidence}`);
    if (check.remediation) {
      console.log(`    Fix: ${check.remediation}`);
    }
  }

  if (result.repairPacket && result.repairPacket.length > 0) {
    const blockers = result.repairPacket.filter((s) => s.blocking).length;
    const caveats = result.repairPacket.filter((s) => !s.blocking).length;
    console.log();
    console.log(`Repair steps: ${result.repairPacket.length} (${blockers} blocking, ${caveats} caveats)`);
    if (blockers > 0) {
      console.log("Resolve blocking steps before restoring.");
    }
  } else if (result.counts.red > 0) {
    console.log();
    console.log("Blockers found. Resolve red items before restoring.");
  } else if (result.counts.yellow > 0) {
    console.log();
    console.log("Restorable with caveats. Yellow items are non-blocking but worth reviewing.");
  }
}

function printCompact(result: RestoreCheckResult): void {
  const verdictLabel = result.verdict.replace(/_/g, " ").toUpperCase();
  console.log(`RESTORE CHECK — ${verdictLabel}`);
  console.log(`${result.counts.green} green | ${result.counts.yellow} yellow | ${result.counts.red} red`);
  const readinessLabel = result.readiness.status.replace(/_/g, " ");
  console.log(`READINESS: ${readinessLabel}`);
  // FR-8: ready-confidence breakdown by class (the 5 real-enum classes).
  if (result.classCounts) {
    const cc = result.classCounts;
    console.log(
      `CLASSES: ${cc.ready} ready | ${cc.ready_with_caveats} ready_with_caveats | ` +
      `${cc.not_ready} not_ready | ${cc.attention_required} attention_required | ${cc.unknown} unknown`
    );
  }

  if (result.rigs && result.rigs.length > 0) {
    console.log();
    console.log(`${"RIG".padEnd(24)} ${"STATUS".padEnd(18)} ${"READY".padEnd(9)} ${"BLOCKED".padEnd(8)} CAVEATS`);
    for (const rig of result.rigs) {
      console.log(
        `${rig.rigName.slice(0, 24).padEnd(24)} ${rig.status.padEnd(18)} ` +
        `${`${rig.runningReadyNodes}/${rig.expectedNodes}`.padEnd(9)} ${String(rig.blockedNodes).padEnd(8)} ${rig.caveatNodes}`
      );
    }
  }

  // The route already scopes `checks` to the right set: not-ready only by
  // default, or all seats (including ready detail) when --ready (ready=1).
  // Render exactly what it returned — do not re-filter here.
  if (result.checks.length > 0) {
    console.log();
    for (const check of result.checks) {
      const sym = STATUS_SYMBOLS[check.status] ?? "?";
      console.log(`  ${sym} ${check.check}: ${check.evidence}`);
      if (check.remediation) {
        console.log(`    Fix: ${check.remediation}`);
      }
    }
  }

  if (result.recovery && result.recovery.status !== "not_needed") {
    console.log();
    console.log(`RECOVERY: ${result.recovery.status.replace(/_/g, " ").toUpperCase()}`);
    console.log(result.recovery.summary);
    for (const action of result.recovery.actions) {
      console.log(`  Action: ${action.command}`);
    }
    for (const issue of result.recovery.blocked) {
      console.log(`  Blocked: ${issue.reason}`);
    }
  }

  if (result.counts.red > 0) {
    console.log();
    console.log("Use --full for complete detail. Use --ready to include ready-seat info.");
  }
}

function localRestoreResult(input: {
  verdict: RestoreCheckResult["verdict"];
  checks: CheckEntry[];
  repairPacket: RepairStep[] | null;
  recovery: RecoveryPlan;
}): RestoreCheckResult {
  const red = input.checks.filter((c) => c.status === "red").length;
  const yellow = input.checks.filter((c) => c.status === "yellow").length;
  const green = input.checks.filter((c) => c.status === "green").length;
  const unknown = input.verdict === "unknown";

  return {
    verdict: input.verdict,
    readiness: {
      status: unknown ? "unknown" : "not_ready",
      reason: unknown ? "unknown_probe_state" : "blockers_present",
      blockingRigCount: 0,
      caveatRigCount: 0,
      unknownRigCount: 0,
    },
    continuity: {
      status: "not_proven",
      evidence: "Strict same-session/provider-context resume is not verified by restore-check v1.",
      provenCapabilities: [],
      unprovenCapabilities: ["provider_session_resume", "context_window_preservation", "interrupted_work_functional_resume"],
    },
    rigs: [],
    hostInfra: {
      status: "unknown",
      evidence: "Host bootstrap/autostart source could not be inspected because restore-check did not receive daemon route evidence",
    },
    counts: { red, yellow, green },
    checks: input.checks,
    repairPacket: input.repairPacket,
    recovery: input.recovery,
  };
}
