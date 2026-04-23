import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

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

interface RestoreCheckResult {
  verdict: "restorable" | "restorable_with_caveats" | "not_restorable" | "unknown";
  counts: { red: number; yellow: number; green: number };
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
    .option("--json", "JSON output for agents")
    .option("--rig <name>", "Check one rig only")
    .option("--no-queue", "Skip queue file checks")
    .option("--no-hooks", "Skip hook checks")
    .action(async (opts: { json?: boolean; rig?: string; queue?: boolean; hooks?: boolean }) => {
      const deps = getDepsF();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        // Daemon down — produce a structured not_restorable result
        const result: RestoreCheckResult = {
          verdict: "not_restorable",
          counts: { red: 1, yellow: 0, green: 0 },
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
            safe: true,
            blocking: true,
          }],
        };

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
        if (opts.rig) params.set("rig", opts.rig);
        if (opts.queue === false) params.set("noQueue", "true");
        if (opts.hooks === false) params.set("noHooks", "true");
        const query = params.toString();
        const path = `/api/restore-check${query ? `?${query}` : ""}`;

        const response = await client.get<RestoreCheckResult>(path);

        if (response.status >= 500) {
          const result: RestoreCheckResult = {
            verdict: "unknown",
            counts: { red: 0, yellow: 0, green: 0 },
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
          };
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
        } else {
          printHuman(result);
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
