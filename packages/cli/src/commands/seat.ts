import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export type SeatDeps = StatusDeps;

interface SeatStatusResponse {
  seat_ref: string;
  rig_id: string;
  rig_name: string;
  logical_id: string;
  pod_id: string | null;
  pod_namespace: string | null;
  runtime: string | null;
  current_occupant: string | null;
  session_status: string | null;
  startup_status: string | null;
  occupant_lifecycle: string;
  continuity_outcome: string | null;
  handover_result: string | null;
  previous_occupant: string | null;
  handover_at: string | null;
  restore_outcome: string;
}

interface SeatStatusError {
  ok: false;
  code: string;
  message?: string;
  error?: string;
  guidance?: string;
  matches?: Array<{ rig_name: string; logical_id: string; current_occupant: string | null }>;
}

interface SeatHandoverPlan {
  ok: true;
  dryRun: true;
  willMutate: false;
  seat: {
    ref: string;
    rigId: string;
    rigName: string;
    logicalId: string;
    podId: string | null;
    podNamespace: string | null;
    runtime: string | null;
  };
  source: {
    mode: "fresh" | "rebuild" | "fork" | "discovered";
    ref: string | null;
    raw: string;
    defaulted: boolean;
  };
  reason: string;
  operator: string | null;
  currentOccupant: string | null;
  currentStatus: {
    sessionStatus: string | null;
    startupStatus: string | null;
    occupantLifecycle: string;
    continuityOutcome: string | null;
    handoverResult: string | null;
    previousOccupant: string | null;
    handoverAt: string | null;
    restoreOutcome: string;
  };
  phases: Array<{
    id: "prepare" | "commit";
    title: string;
    bindingUnchangedUntilComplete: boolean;
    steps: Array<{ id: string; title: string; description: string; willMutate: false }>;
  }>;
}

interface SeatHandoverMutationResult {
  ok: true;
  dryRun: false;
  mutated: true;
  continuityTransferred: false;
  seat: SeatHandoverPlan["seat"];
  source: {
    mode: "discovered";
    ref: string;
    raw: string;
    defaulted: false;
  };
  reason: string;
  operator: string | null;
  previousOccupant: string;
  currentOccupant: string;
  previousSessionIdsSuperseded: string[];
  newSessionId: string;
  discovery: {
    id: string;
    status: "claimed";
    tmuxSession: string;
    tmuxPane: string | null;
  };
  currentStatus: SeatHandoverPlan["currentStatus"];
  handoverAt: string;
  eventSeq: number;
  sideEffects: {
    departingSessionKilled: false;
    startupContextDelivered: false;
    provenanceRecordWritten: false;
  };
}

function display(value: string | null | undefined, empty = "none"): string {
  return value ?? empty;
}

function printHuman(status: SeatStatusResponse): void {
  console.log(`Seat ${status.seat_ref}`);
  console.log(`Rig: ${status.rig_name}`);
  console.log(`Logical ID: ${status.logical_id}`);
  console.log(`Current occupant: ${display(status.current_occupant)}`);
  console.log(`Session: ${display(status.session_status, "unknown")}`);
  console.log(`Startup: ${display(status.startup_status, "unknown")}`);
  console.log(`Occupant lifecycle: ${status.occupant_lifecycle}`);
  console.log(`Continuity outcome: ${display(status.continuity_outcome, "unknown")}`);
  console.log(`Handover result: ${display(status.handover_result)}`);
  console.log(`Previous occupant: ${display(status.previous_occupant)}`);
  console.log(`Handover at: ${display(status.handover_at)}`);
}

function printHumanHandoverPlan(plan: SeatHandoverPlan): void {
  console.log(`Seat handover dry run: ${plan.seat.ref}`);
  console.log(`Rig: ${plan.seat.rigName}`);
  console.log(`Logical ID: ${plan.seat.logicalId}`);
  console.log(`Source: ${plan.source.mode}${plan.source.ref ? `:${plan.source.ref}` : ""}`);
  console.log(`Reason: ${plan.reason}`);
  console.log(`Operator: ${display(plan.operator)}`);
  console.log(`Current occupant: ${display(plan.currentOccupant)}`);
  console.log(`Current status: session=${display(plan.currentStatus.sessionStatus, "unknown")} startup=${display(plan.currentStatus.startupStatus, "unknown")} lifecycle=${plan.currentStatus.occupantLifecycle}`);
  for (const phase of plan.phases) {
    console.log(phase.title);
    for (const step of phase.steps) {
      console.log(`  - ${step.title}`);
    }
  }
  console.log("No changes were made.");
}

function printHumanHandoverResult(result: SeatHandoverMutationResult): void {
  console.log(`Seat handover complete: ${result.seat.ref}`);
  console.log(`Rig: ${result.seat.rigName}`);
  console.log(`Logical ID: ${result.seat.logicalId}`);
  console.log(`Source: discovered:${result.discovery.id}`);
  console.log(`Reason: ${result.reason}`);
  console.log(`Operator: ${display(result.operator)}`);
  console.log(`Previous occupant: ${result.previousOccupant}`);
  console.log(`Current occupant: ${result.currentOccupant}`);
  console.log(`Handover result: ${display(result.currentStatus.handoverResult)}`);
  console.log("Seat binding and inventory provenance were updated.");
  console.log("No conversation continuity, startup context delivery, provenance markdown, or session stop was performed.");
}

function printSeatError(error: SeatStatusError, fallback: string): void {
  console.error(error.message ?? error.error ?? fallback);
  if (error.guidance) {
    console.error(error.guidance);
  }
  if (error.code === "seat_ambiguous" && error.matches?.length) {
    for (const match of error.matches) {
      console.error(`  ${match.logical_id}@${match.rig_name} (${display(match.current_occupant)})`);
    }
  }
}

export function seatCommand(depsOverride?: SeatDeps): Command {
  const cmd = new Command("seat")
    .description("Inspect OpenRig seat observability state");
  const getDeps = (): SeatDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .command("status")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .option("--json", "JSON output for agents")
    .description("Show read-only seat handover observability status")
    .addHelpText("after", `
Examples:
  rig seat status spec-writer@openrig-pm
  rig seat status spec.writer@openrig-pm --json
  rig seat status spec.writer --json`)
    .action(async (seat: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const daemon = await getDaemonStatus(deps.lifecycleDeps);
      if (daemon.state !== "running" || daemon.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(daemon));
      const res = await client.get<SeatStatusResponse | SeatStatusError>(`/api/seat/status/${encodeURIComponent(seat)}`);

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      if (res.status >= 400) {
        const error = res.data as SeatStatusError;
        printSeatError(error, `Seat status failed (HTTP ${res.status})`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      printHuman(res.data as SeatStatusResponse);
    });

  cmd
    .command("handover")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .option("--source <source>", "Source: discovered:<id> for live MVP; fresh, rebuild, or fork:<id> for dry-run planning")
    .option("--reason <reason>", "Why the handover is happening")
    .option("--operator <address>", "Operator initiating the handover")
    .option("--dry-run", "Plan the handover without changing topology")
    .option("--json", "JSON output for agents")
    .description("Plan a safe two-phase seat handover")
    .addHelpText("after", `
Examples:
  rig seat handover spec-writer@openrig-pm --reason context-wall --dry-run
  rig seat handover spec-writer@openrig-pm --source rebuild --reason context-wall --dry-run --json
  rig seat handover spec-writer@openrig-pm --source fork:0b0165d7 --reason successor-test --operator orch-lead@openrig-pm --dry-run
  rig seat handover spec-writer@openrig-pm --source discovered:01H... --reason mvp-proof --json`)
    .action(async (seat: string, opts: { source?: string; reason?: string; operator?: string; dryRun?: boolean; json?: boolean }) => {
      if (!opts.reason?.trim()) {
        const error: SeatStatusError = {
          ok: false,
          code: "missing_reason",
          message: "Missing required option: --reason <reason>",
          guidance: "Provide an explicit handover reason, for example: --reason context-wall",
        };
        if (opts.json) {
          console.log(JSON.stringify(error, null, 2));
        } else {
          printSeatError(error, "Missing required option: --reason <reason>");
        }
        process.exitCode = 2;
        return;
      }

      const deps = getDeps();
      const daemon = await getDaemonStatus(deps.lifecycleDeps);
      if (daemon.state !== "running" || daemon.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(daemon));
      const res = await client.post<SeatHandoverPlan | SeatHandoverMutationResult | SeatStatusError>(`/api/seat/handover/${encodeURIComponent(seat)}`, {
        source: opts.source,
        reason: opts.reason,
        operator: opts.operator,
        dryRun: opts.dryRun === true,
      });

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      if (res.status >= 400) {
        printSeatError(res.data as SeatStatusError, `Seat handover failed (HTTP ${res.status})`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      const data = res.data as SeatHandoverPlan | SeatHandoverMutationResult;
      if (data.dryRun) {
        printHumanHandoverPlan(data);
      } else {
        printHumanHandoverResult(data);
      }
    });

  return cmd;
}
