import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export type SeatDeps = StatusDeps;

/** Read all of STDIN to EOF as a UTF-8 string. Used by set-resume-token so the
 *  credential never appears in argv / shell history / ps. Injectable for tests. */
async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

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
  clients?: Array<{ name: string; session: string }>;
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
    mode: "fresh" | "rebuild" | "fork" | "discovered";
    ref: string | null;
    raw: string;
    defaulted: boolean;
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
    startupContextDelivered: boolean;
    provenanceRecordWritten: false;
  };
}

interface SeatSwitchClientResponse {
  seat_ref: string;
  session: string;
  window: number;
  target: string;
  client: string;
  mutated: false;
  retargeted: true;
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
  console.log(`Source: ${result.source.mode}${result.source.ref ? `:${result.source.ref}` : ""}`);
  console.log(`Reason: ${result.reason}`);
  console.log(`Operator: ${display(result.operator)}`);
  console.log(`Previous occupant: ${result.previousOccupant}`);
  console.log(`Current occupant: ${result.currentOccupant}`);
  console.log(`Handover result: ${display(result.currentStatus.handoverResult)}`);
  console.log("Seat binding and inventory provenance were updated.");
  if (result.sideEffects.startupContextDelivered) {
    // fresh handover: the captured restore packet was delivered to the launched
    // live successor agent.
    console.log("The captured startup context (restore packet) was delivered to the successor.");
    console.log("No conversation continuity, provenance markdown, or session stop was performed.");
  } else {
    // discovered handover: the operator-prepared successor is already live, so no
    // separate context delivery is performed (v0 live modes are fresh + discovered).
    console.log("No conversation continuity, startup context delivery, provenance markdown, or session stop was performed.");
  }
}

function printHumanSwitchClient(r: SeatSwitchClientResponse): void {
  console.log(`Retargeted client ${r.client} -> ${r.target} (seat ${r.seat_ref})`);
  console.log("View only: no routing, queue address, transcript, or seat binding was changed.");
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
  if (error.clients?.length) {
    console.error("Attached clients:");
    for (const cl of error.clients) {
      console.error(`  ${cl.name} (viewing ${display(cl.session)})`);
    }
  }
}

export function seatCommand(depsOverride?: SeatDeps & { readStdin?: () => Promise<string> }): Command {
  const cmd = new Command("seat")
    .description("Inspect OpenRig seat observability state");
  const getDeps = (): SeatDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };
  const readStdin = depsOverride?.readStdin ?? defaultReadStdin;

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
    .option("--source <source>", "Source. Live: fresh (launches a new agent) or discovered:<id> (operator-prepared). fork:<id> and rebuild are dry-run-plan only in v0.")
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
    .action((seat: string, opts: HandoverActionOpts) => runSeatHandover(seat, opts, getDeps()));

  // OPR.0.4.3.26 — seat-recovery VIEW retarget. Points an already-attached tmux
  // client at the seat's canonical session/window. VIEW-ONLY: never mutates
  // routing/queue/transcript/identity, never launches an agent, never kills a
  // session. Composes AFTER reconcile-session / handover as a distinct step.
  cmd
    .command("switch-client")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .option("--to-window <n>", "Target window index (default: 0, the canonical seat window)")
    .option("--client <id>", "Target a specific attached tmux client (required when multiple are attached)")
    .option("--json", "JSON output for agents")
    .description("Retarget an attached tmux client's view to the seat's canonical session (view-only)")
    .addHelpText("after", `
Retargets what a client SEES; it never changes OpenRig routing, queue addresses,
transcripts, or seat bindings. Repair routing first with rig reconcile-session /
rig seat handover, THEN retarget the view. Examples:
  rig seat switch-client dev-impl@my-rig
  rig seat switch-client dev-impl@my-rig --to-window 1
  rig seat switch-client dev-impl@my-rig --client /dev/ttys003 --json`)
    .action(async (seat: string, opts: { toWindow?: string; client?: string; json?: boolean }) => {
      let toWindow: number | undefined;
      if (opts.toWindow != null) {
        const n = Number(opts.toWindow);
        if (!Number.isInteger(n) || n < 0) {
          const error: SeatStatusError = {
            ok: false,
            code: "invalid_window",
            message: `Invalid --to-window "${opts.toWindow}": must be a non-negative integer.`,
          };
          if (opts.json) {
            console.log(JSON.stringify(error, null, 2));
          } else {
            printSeatError(error, "Invalid --to-window");
          }
          process.exitCode = 2;
          return;
        }
        toWindow = n;
      }

      const deps = getDeps();
      const daemon = await getDaemonStatus(deps.lifecycleDeps);
      if (daemon.state !== "running" || daemon.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(daemon));
      const res = await client.post<SeatSwitchClientResponse | SeatStatusError>(
        `/api/seat/switch-client/${encodeURIComponent(seat)}`,
        { client: opts.client, toWindow },
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      if (res.status >= 400) {
        printSeatError(res.data as SeatStatusError, `Seat switch-client failed (HTTP ${res.status})`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      printHumanSwitchClient(res.data as SeatSwitchClientResponse);
    });

  // OPR.0.3.4.10 — clear stuck attention_required / failed startup_status.
  cmd
    .command("clear-attention")
    .argument("<session>", "Canonical session name (e.g. dev-impl@my-rig)")
    .option("--reason <text>", "Operator attestation override (skip evidence gate)")
    .option("--json", "JSON output for agents")
    .description("Clear stuck attention_required startup status with evidence or operator attestation")
    .addHelpText("after", `
Examples:
  rig seat clear-attention dev-impl@my-rig
  rig seat clear-attention dev-impl@my-rig --reason "founder re-authed, confirmed live"
  rig seat clear-attention dev-impl@my-rig --json
`)
    .action(async (session: string, opts: { reason?: string; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running") {
        console.error("Daemon not running.");
        process.exitCode = 1;
        return;
      }
      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<Record<string, unknown>>(
        `/api/sessions/${encodeURIComponent(session)}/clear-attention`,
        opts.reason ? { reason: opts.reason } : {},
        { headers: terminalAuthHeaders() },
      );
      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }
      if (res.status >= 400) {
        const code = res.data["code"] as string | undefined;
        const detail = res.data["detail"] as string | undefined;
        console.error(`${code ?? "error"}: ${detail ?? String(res.data["error"] ?? "unknown")}`);
        process.exitCode = 1;
        return;
      }
      const clearedBy = res.data["clearedBy"] as string | undefined;
      const from = res.data["from"] as string | undefined;
      console.log(`Cleared ${session}: ${from} -> ready (${clearedBy})`);
    });

  // OPR.0.4.0.22 — set a managed seat's durable resume token (attested + audited).
  // The token is read from STDIN ONLY (never a positional argv, which would leak
  // via shell history + argv/ps) and is NEVER echoed back.
  cmd
    .command("set-resume-token")
    .argument("<session>", "Canonical session name (e.g. dev-impl@my-rig)")
    .option("--token-stdin", "Read the resume token from STDIN (the only supported input path)")
    .requiredOption("--reason <text>", "Operator attestation recorded in the append-only audit event")
    .option("--json", "JSON output for agents")
    .description("Set a managed seat's durable resume token (token read from stdin; attested + audited)")
    .addHelpText("after", `
The token is read from STDIN only (never an argument). Examples:
  printf '%s' "$RESUME_TOKEN" | rig seat set-resume-token dev-impl@my-rig --token-stdin --reason "founder re-authed"
  pbpaste | rig seat set-resume-token dev-qa@my-rig --token-stdin --reason "manual codex thread id" --json
`)
    .action(async (session: string, opts: { tokenStdin?: boolean; reason: string; json?: boolean }) => {
      const deps = getDeps();
      if (!opts.tokenStdin) {
        console.error("set-resume-token requires --token-stdin: the token is read from stdin, never passed as an argument (it would leak via shell history / ps). Pipe it in, e.g. printf '%s' \"$TOKEN\" | rig seat set-resume-token <session> --token-stdin --reason \"...\".");
        process.exitCode = 2;
        return;
      }
      const token = (await readStdin()).trim();
      if (!token) {
        console.error("No resume token received on stdin.");
        process.exitCode = 2;
        return;
      }
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running") {
        console.error("Daemon not running.");
        process.exitCode = 1;
        return;
      }
      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<Record<string, unknown>>(
        `/api/sessions/${encodeURIComponent(session)}/resume-token`,
        { token, reason: opts.reason },
        { headers: terminalAuthHeaders() },
      );
      // The token is NEVER echoed in either output mode (the daemon response is
      // already redacted).
      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }
      if (res.status >= 400) {
        console.error(`error: ${String(res.data["message"] ?? res.data["error"] ?? "unknown")}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Set resume token for ${session}: ${String(res.data["resumeType"] ?? "")} (provenance: operator). Token redacted.`);
    });

  return cmd;
}

interface HandoverActionOpts {
  source?: string;
  reason?: string;
  operator?: string;
  dryRun?: boolean;
  json?: boolean;
}

/** Shared handover action for both `rig seat handover` and the top-level
 *  `rig handover` verb (OPR.0.4.3.04). Posts to the same daemon route. */
export async function runSeatHandover(seat: string, opts: HandoverActionOpts, deps: SeatDeps): Promise<void> {
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
}

/**
 * OPR.0.4.3.04 — top-level `rig handover <seat>` verb: the operator-facing
 * surface for the full-cycle handover composer. Same route + behavior as
 * `rig seat handover`; hoisted to top-level for discoverability.
 */
export function handoverCommand(depsOverride?: SeatDeps): Command {
  const getDeps = (): SeatDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };
  return new Command("handover")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .option("--source <source>", "Successor source. Live: fresh (default, launches a new agent) or discovered:<id> (operator-prepared). fork:<id> and rebuild are dry-run-plan only in v0.")
    .option("--reason <reason>", "Why the handover is happening")
    .option("--operator <address>", "Operator initiating the handover")
    .option("--dry-run", "Plan the handover without changing topology")
    .option("--json", "JSON output for agents")
    .description("Hand a seat to a successor: create -> deliver context -> verify continuity -> rebind")
    .addHelpText("after", `
v0 live handover supports --source fresh and --source discovered:<id>.
fork and rebuild are rejected for a live handover (planning only) until their
follow-ons ship; a fork/rebuild handover is never silently completed.

Examples:
  rig handover spec-writer@openrig-pm --reason context-wall --dry-run
  rig handover spec-writer@openrig-pm --source fresh --reason context-wall
  rig handover spec-writer@openrig-pm --source fork:0b0165d7 --reason plan-only --dry-run
  rig handover spec-writer@openrig-pm --source discovered:01H... --reason mvp-proof --json`)
    .action((seat: string, opts: HandoverActionOpts) => runSeatHandover(seat, opts, getDeps()));
}
