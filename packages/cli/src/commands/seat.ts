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
        console.error(error.message ?? error.error ?? `Seat status failed (HTTP ${res.status})`);
        if (error.guidance) {
          console.error(error.guidance);
        }
        if (error.code === "seat_ambiguous" && error.matches?.length) {
          for (const match of error.matches) {
            console.error(`  ${match.logical_id}@${match.rig_name} (${display(match.current_occupant)})`);
          }
        }
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      printHuman(res.data as SeatStatusResponse);
    });

  return cmd;
}
