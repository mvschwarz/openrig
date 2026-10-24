import { Command } from "commander";
import { DaemonClient, DaemonTimeoutError, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { shellQuote } from "../cross-host-executor.js";
import { localSelfHostId, originFor, runOnSshHost, type RunOnHostDeps } from "../lib/run-on-host.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { seatLaunchAdditionLines, type SeatLaunchAdditionsView } from "../seat-launch-additions-lines.js";

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
  typingGuard?: { desired: boolean; effective: boolean; pending: boolean; heldCount: number;
    desiredMode?: string; effectiveMode?: string; desiredLevel?: string; effectiveLevel?: string; };
  terminalPolicy?: {
    state: string; label?: string; source?: string; actor?: string | null; instruction?: string;
    helpers?: string[]; rules?: Record<string, Record<string, string>>;
    rigDefault?: { config: unknown; appliesTo: string };
    supported?: { compaction: string; model: string }; limits?: string; error?: string;
  };
  permissions?: {
    selectionState: "explicit" | "inherit" | "unknown";
    desired: { mode: string } | null;
    lastLaunchArguments: { value: string | null; approvalPolicy?: string } | null;
    nativeEffect: "unverified";
    error?: string;
    effective?: {
      effectiveMode: string;
      source: string;
      fallbackReason?: string;
    };
    /** The daemon's planned account (permission-account.ts); older daemons don't send it. */
    account?: {
      summary: string;
      overrides: string[];
      openRigAdds: { claudeAllow: string[]; claudeAsk: string[]; notes: string[] };
      unknown: string[];
      controls: string[];
    };
  };
  session_status: string | null;
  launch_cwd?: string | null;
  session_reason?: string | null;
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
  /** OPR.0.5.5.5 — per-source execution record (wire mirror of the daemon shape). */
  sourceOutcome?:
    | { mode: "fork"; forkedFrom: string; forkId?: "captured" | "pending"; limit?: string }
    | { mode: "rebuild"; primedArtifacts: Array<{ address: string; label: string }>; gaps: string[]; emptyChainReason?: string; permissions?: { state: string; detail: string } };
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

function sessionReason(reason: string | null | undefined): string | null {
  return reason === "session_missing" ? "tmux session missing; restore or relaunch the seat" : null;
}

const LEVEL_WORDS: Record<string, string> = {
  "openrig-urgent": "OpenRig's own messages and anything marked urgent type.",
  "urgent-only": "Only messages marked urgent type.",
  "sends-only": "Deliberate sends from people and agents type; OpenRig's own notices are held.",
};

function printHuman(status: SeatStatusResponse): void {
  console.log(`Seat ${status.seat_ref}`);
  console.log(`Rig: ${status.rig_name}`);
  console.log(`Logical ID: ${status.logical_id}`);
  console.log(`Current occupant: ${display(status.current_occupant)}`);
  if (status.launch_cwd !== undefined) console.log(`Working directory for future launches: ${display(status.launch_cwd)}`);
  if (status.typingGuard) {
    const g = status.typingGuard;
    const mode = g.effectiveLevel ?? g.effectiveMode ?? (g.effective ? "on" : "off");
    const requested = g.desiredLevel ?? g.desiredMode ?? (g.desired ? "on" : "off");
    console.log(`Typing guard: ${mode === "hold" ? "on (hold)" : mode}${g.pending ? ` (activation pending; requested ${requested})` : ""}; ${g.heldCount} retained`);
    if (mode === "draft-aware") console.log(`Draft-aware sends return immediately; inspect held messages with rig seat held-messages ${status.seat_ref}.`);
    else if (LEVEL_WORDS[mode]) console.log(`${LEVEL_WORDS[mode]} Other automatic input is held, readable with rig seat held-messages ${status.seat_ref}. Changing it does not replay held messages.`);
    else if (mode === "off") console.log("Off: automatic input types as it arrives.");
    else console.log("Hold pauses all automatic input, including writing lifecycle. Changing mode does not replay held messages.");
  }
  console.log(`Session: ${display(status.session_status, "unknown")}`);
  const reason = sessionReason(status.session_reason);
  if (reason) console.log(`Reason: ${reason}`);
  if (status.permissions?.account) {
    const p = status.permissions;
    const a = p.account!;
    console.log("Permissions, planned for the next fresh managed launch (not observed):");
    console.log(`  ${a.summary}`);
    if (a.overrides.length) console.log(`  This seat's choice is used instead of the ${a.overrides.join(" and the ")}.`);
    for (const note of a.openRigAdds.notes) console.log(`  ${note}`);
    if (a.openRigAdds.claudeAllow.length) console.log("  The exact allowance and ask lists are in --json, under permissions.account.openRigAdds.");
    console.log(`  Last launch arguments (observed): ${p.lastLaunchArguments?.value ?? "unknown"}${p.lastLaunchArguments?.approvalPolicy ? `; approval=${p.lastLaunchArguments.approvalPolicy}` : ""}`);
    for (const item of a.unknown) console.log(`  Unknown: ${item}`);
    if (a.controls.length) {
      console.log("  To change it, for future launches only:");
      for (const control of a.controls) console.log(`    ${control}`);
    }
  } else if (status.permissions) {
    const p = status.permissions;
    const formatSource = (source: string): string => {
      if (source === "member_spec") return "from the member's permission_policy";
      if (source === "rig_spec") return "from the rig's permission_policy";
      if (source === "kernel_default") return "kernel operational default";
      if (source === "system_default") return "OpenRig default";
      return source;
    };
    const modeStr = p.desired?.mode
      ? `${p.desired.mode} (explicit)`
      : p.effective
      ? `${p.effective.effectiveMode} (${formatSource(p.effective.source)}${p.effective.fallbackReason ? `; ${p.effective.fallbackReason}` : ""})`
      : p.selectionState;
    console.log(`Permission mode for future launches: ${modeStr}`);
    console.log(`Last launch arguments: ${p.lastLaunchArguments?.value ?? "unknown"}${p.lastLaunchArguments?.approvalPolicy ? `; approval=${p.lastLaunchArguments.approvalPolicy}` : ""}`);
    console.log("Native permission effect: unverified by this status read");
    if (p.error) console.log(`Permission selection unavailable: ${p.error}`);
  }
  if (status.terminalPolicy) {
    const p = status.terminalPolicy;
    console.log(`Terminal interaction (${p.state}; managed checks): ${p.label ?? "unknown"}${p.source ? ` [${p.source}]` : ""}`);
    for (const [scope, rules] of Object.entries(p.rules ?? {}))
      console.log(`  ${scope}: compaction=${rules.compaction}; model/effort=${rules.model}`);
    if (p.helpers?.length) console.log(`  Named helpers: ${p.helpers.join(", ")}`);
    if (p.instruction) console.log(`  Instruction: ${p.instruction}${p.actor ? ` (recorded by ${p.actor})` : ""}`);
    if (p.rigDefault) console.log(`  Rig default (${p.rigDefault.appliesTo}): ${JSON.stringify(p.rigDefault.config)}`);
    if (p.supported) console.log(`  Compaction: ${p.supported.compaction}; model/effort: ${p.supported.model}`);
    console.log("  Enforced: managed compaction and saved model/effort changes. Other interventions: guidance-only.");
    if (p.limits) console.log(`  ${p.limits}`);
    if (p.error) console.log(`  Unknown: ${p.error}`);
  }
  console.log(`Startup: ${display(status.startup_status, "unknown")}`);
  console.log(`Occupant lifecycle: ${status.occupant_lifecycle}`);
  console.log(`Continuity outcome: ${display(status.continuity_outcome, "unverified")}`);
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
  // OPR.0.5.5.5 — the per-source execution record: what actually carried context.
  if (result.sourceOutcome?.mode === "fork") {
    console.log(`Native fork of ${result.sourceOutcome.forkedFrom}: the successor carries the incumbent conversation from its first byte.`);
    if (result.sourceOutcome.forkId === "pending") console.log(`Fork id: PENDING. ${result.sourceOutcome.limit ?? ""}`.trim());
  } else if (result.sourceOutcome?.mode === "rebuild") {
    const outcome = result.sourceOutcome;
    if (outcome.permissions) console.log(`Codex rebuild permissions: ${outcome.permissions.state}. ${outcome.permissions.detail}`);
    if (outcome.primedArtifacts.length > 0) {
      console.log(`Rebuild primed from ${outcome.primedArtifacts.length} durable artifact${outcome.primedArtifacts.length === 1 ? "" : "s"}:`);
      for (const artifact of outcome.primedArtifacts) console.log(`  - ${artifact.address} — ${artifact.label}`);
    }
    for (const gap of outcome.gaps) console.log(`  ! declared but missing on disk: ${gap}`);
    if (outcome.emptyChainReason) {
      console.log(`Rebuild chain was EMPTY: ${outcome.emptyChainReason}`);
    }
  }
  if (result.sideEffects.startupContextDelivered) {
    if (result.source.mode === "rebuild") {
      console.log("The rebuild priming packet was delivered to the successor.");
    } else {
      // fresh handover: the captured restore packet was delivered to the launched
      // live successor agent.
      console.log("The captured startup context (restore packet) was delivered to the successor.");
    }
    console.log("No conversation continuity, provenance markdown, or session stop was performed.");
  } else if (result.source.mode === "fork") {
    console.log("No packet delivery: fork context rides the native conversation itself.");
  } else {
    // discovered handover: the operator-prepared successor is already live, so no
    // separate context delivery is performed.
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

export function seatCommand(depsOverride?: SeatDeps & { readStdin?: () => Promise<string>; host?: RunOnHostDeps }): Command {
  const cmd = new Command("seat")
    .description("Inspect OpenRig seat observability state");
  const getDeps = (): SeatDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };
  const readStdin = depsOverride?.readStdin ?? defaultReadStdin;

  const guardRequest = async (method: "GET" | "POST", path: string, body: Record<string, unknown> | undefined, json?: boolean) => {
    const deps = getDeps(); const daemon = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(daemon)) return;
    const client = deps.clientFactory(getDaemonUrl(daemon));
    const result = method === "GET" ? await client.get<Record<string, unknown>>(path) : await client.post<Record<string, unknown>>(path, body ?? {});
    console.log(JSON.stringify(result.data, null, json ? undefined : 2));
    if (result.status >= 400) process.exitCode = result.status >= 500 ? 2 : 1;
  };
  cmd.command("set-typing-guard").argument("<seat>")
    .option("--enabled <boolean>", "Compatibility: true selects hold; false selects off")
    .option("--mode <mode>", "off, draft-aware, openrig-urgent, urgent-only, sends-only or hold; choose this or --enabled")
    .requiredOption("--reason <text>").option("--json").description("Choose how this seat's typing guard handles automatic input")
    .addHelpText("after", `
This one persistent guard defaults off. Hold pauses ALL automatic input, including
at an empty prompt; --enabled true keeps that existing behavior. Draft-aware holds
when the current input contains a draft or cannot be read. It returns the exact
reason and held message ID immediately, without automatic retry.
Off (--enabled false) permits new automatic sends.

Between off (always interrupt) and hold (full quiet):
  openrig-urgent  OpenRig's own messages (watchdogs, scheduled wakes, notices) and
                  anything marked urgent type; other agents' messages are held.
  urgent-only     only messages marked urgent type (rig send --urgent, or a queue
                  item at priority urgent or critical).
  sends-only      deliberate sends from people and agents type; OpenRig's own
                  notices are held. A terminal member defaults to this.
What openrig-urgent and urgent-only let through never types over a draft.
sends-only types like off: a terminal member's typing isn't protected, as today
(its shell input can't be read). Everything else is held, the sender is told, and
held messages stay readable. Lifecycle work is refused at openrig-urgent and
urgent-only, as at hold.
Messages use the existing outbox. Uncertain writes never replay automatically.
Direct human input remains available. Other seats keep their own guard mode.

Activation can be pending while an already-started operation finishes. Read
rig seat status <seat> and wait for pending=false before relying on the requested mode.
Inspect retained bodies with rig seat held-messages <seat> (or --id <id>).
Changing modes never flushes held messages.
Retire a reviewed record with rig seat retire-held-message <seat> <id> --reason <text>.
Retirement preserves evidence and frees quota; it does not deliver or close work.

Active retention defaults: 100 records / 8 MiB per seat, 1 MiB per message.
New admissions refuse at capacity. Already-committed queue intent is preserved even
when a concurrent activation exceeds that cap; inspect and retire it explicitly.
Protection covers OpenRig's managed input paths, not external tmux tools or another
process writing directly to the terminal. Select off before writing lifecycle work
on an active pane; freshly created or respawned lifecycle shells have separate proof.

Examples:
  rig seat set-typing-guard dev-impl@my-rig --mode draft-aware --reason "preserve my draft"
  rig seat set-typing-guard review-r1@my-rig --mode urgent-only --reason "reviewing by hand"
  rig seat set-typing-guard dev-impl@my-rig --enabled true --reason "manual terminal"
`)
    .action(async (seat: string, opts: { enabled?: string; mode?: string; reason: string; json?: boolean }) => {
      if ((opts.enabled === undefined) === (opts.mode === undefined)
        || opts.enabled !== undefined && !["true", "false"].includes(opts.enabled)
        || opts.mode !== undefined && !["off", "draft-aware", "openrig-urgent", "urgent-only", "sends-only", "hold"].includes(opts.mode)) {
        console.error("Choose --enabled true|false or --mode off|draft-aware|openrig-urgent|urgent-only|sends-only|hold.");
        process.exitCode = 1; return;
      }
      await guardRequest("POST", `/api/seat/set-typing-guard/${encodeURIComponent(seat)}`, {
        ...(opts.mode === undefined ? { enabled: opts.enabled === "true" } : { mode: opts.mode }), reason: opts.reason,
      }, opts.json);
    });
  cmd.command("held-messages").argument("<seat>").option("--limit <n>", "Page size", "100").option("--offset <n>", "Page offset", "0").option("--id <id>", "Read one retained or retired record by ID").option("--json")
    .description("Read retained messages outside the protected terminal; reading never delivers them")
    .action(async (seat: string, opts: {limit: string; offset: string; id?: string; json?: boolean}) => {
      await guardRequest("GET", `/api/seat/held-messages/${encodeURIComponent(seat)}?limit=${encodeURIComponent(opts.limit)}&offset=${encodeURIComponent(opts.offset)}${opts.id ? `&id=${encodeURIComponent(opts.id)}` : ""}`, undefined, opts.json);
    });
  cmd.command("retire-held-message").argument("<seat>").argument("<id>").requiredOption("--reason <text>").option("--json")
    .description("Release one held message's active quota, preserving evidence; does not deliver or close work")
    .action(async (seat: string, id: string, opts: {reason: string; json?: boolean}) => {
      await guardRequest("POST", `/api/seat/retire-held-message/${encodeURIComponent(seat)}/${encodeURIComponent(id)}`, { reason: opts.reason }, opts.json);
    });


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
      if (!daemonStatusGuard(daemon)) return;

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
    .option("--source <source>", "Source: fresh (default; launches a new agent), discovered:<id> (operator-prepared), fork:<id> (native fork of the source conversation), or rebuild (fresh agent primed from the seat's durable artifacts).")
    .option("--reason <reason>", "Why the handover is happening")
    .option("--operator <address>", "Operator initiating the handover")
    .option("--dry-run", "Plan the handover without changing topology")
    .option("--json", "JSON output for agents")
    .description("Hand a seat to a successor (two-phase). Pass --dry-run to plan without changing topology.")
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
      if (!daemonStatusGuard(daemon)) return;

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
    .option("--reason <text>", "Attest startup or subset-restore attention, or that a prompt the latest hook names is gone; cannot bypass full-restore or pane-identity checks")
    .option("--json", "JSON output for agents")
    .description("Reconcile seat attention using the checks for its attention class")
    .addHelpText("after", `
Examples:
  rig seat clear-attention dev-impl@my-rig
  rig seat clear-attention dev-impl@my-rig --reason "founder re-authed, confirmed live"
  rig seat clear-attention dev-impl@my-rig --json

--reason can acknowledge startup-status and subset-restore attention. It can
also say a prompt is gone: when the seat's latest hook still says it waits on a
person (a permission prompt declined or answered with no hook after) and sends
are refused, --reason "<what you saw>" records the prompt cleared. Each send
still checks the pane for a prompt it recognizes. It does
not bypass full-restore continuity or pane-identity checks. Acknowledgment alone
does not prove that the original conversation resumed.
If the recorded native token needs correction and you know the actual token:
  printf '%s' "$TOKEN" | rig seat set-resume-token dev-impl@my-rig --token-stdin --reason "verified native token"
Then rerun clear-attention to check the live evidence. Setting the token alone,
or stopping and relaunching the seat, does not prove continuity.
reconcile-session adopts a binding; it does not clear a failed full-restore
attempt. Use clear-attention for that: the recorded token must match the live
foreground process and its pane must be usable. This check sends no input.
Version-named Claude processes behind a shell need an OS executable-path
witness (Linux /proc or macOS proc_pidpath). If that read is unavailable, the
identity remains unverified; a version number alone cannot clear it.
`)
    .action(async (session: string, opts: { reason?: string; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
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

  // S5 (OPR.0.5.4.7) — the seat-lifecycle verb surface: set-model / stop / clean.
  // Thin CLI over the daemon's SeatLifecycleService; refusals print message +
  // guidance + match list exactly as the daemon named them.
  const runLifecycleVerb = async (
    path: "set-terminal-policy" | "set-model" | "set-cwd" | "set-effort" | "set-permissions" | "launch" | "launch-plan" | "continue" | "stop" | "clean" | "restart" | "restart-plan" | "restart-verify",
    seat: string,
    body: Record<string, unknown>,
    opts: { json?: boolean },
    printOk: (data: Record<string, unknown>) => void,
  ): Promise<void> => {
    const deps = getDeps();
    const daemon = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(daemon)) return;
    const client = deps.clientFactory(getDaemonUrl(daemon));
    let res;
    try {
      const route = `/api/seat/${path}/${encodeURIComponent(seat)}`;
      res = path === "launch" || path === "continue" || path === "restart"
        ? await client.post<Record<string, unknown>>(route, body, { timeoutMs: 120_000 })
        // #260: a dynamic Claude mode waits up to 5 s for the capability query before the
        // daemon answers, so the 5 s default deadline would abort before its refusal arrives.
        : path === "set-permissions"
          ? await client.post<Record<string, unknown>>(route, body, { timeoutMs: 10_000 })
          : await client.post<Record<string, unknown>>(route, body);
    } catch (err) {
      if ((path !== "launch" && path !== "launch-plan" && path !== "continue" && path !== "restart" && path !== "set-cwd") || !(err instanceof DaemonTimeoutError)) throw err;
      const error = path === "restart" ? {
        ok: false as const,
        code: "restart_outcome_unknown",
        status: "unknown",
        message: "The CLI timed out waiting for the daemon; the in-place restart may still be in progress.",
        guidance: `Check the outcome before running it again: rig seat restart ${seat} --keep-conversation --plan refuses with restart_in_progress while it is still running, then shows its result as lastRestart.`,
      } : {
        ok: false as const,
        code: path === "launch-plan" ? "launch_plan_timeout" : `${path.replaceAll("-", "_")}_outcome_unknown`,
        status: "unknown",
        message: path === "launch-plan" ? "The read-only launch preview timed out; no launch was requested." : `The CLI timed out waiting for the daemon; the ${path === "set-cwd" ? "directory change" : path === "continue" ? "continuation" : "launch"} may still be in progress.`,
        guidance: path === "launch-plan" ? "Retry the preview when the daemon responds." : `Check the outcome before retrying: rig seat status ${seat}`,
      };
      if (opts.json) console.log(JSON.stringify(error, null, 2));
      else printSeatError(error, error.message);
      process.exitCode = 1;
      return;
    }
    // A restart that ran answers 200 with its outcome; only a verified replacement exits 0. Likewise
    // --verify answers 200 with its outcome, and only `moved` exits 0.
    const restartFailed = res.status < 400 && (
      (path === "restart" && res.data["outcome"] !== "restarted_account_unverified")
      || (path === "restart-verify" && res.data["outcome"] !== "moved"));
    if (opts.json) {
      console.log(JSON.stringify(res.data, null, 2));
      if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
      else if (restartFailed) process.exitCode = 1;
      return;
    }
    if (restartFailed) process.exitCode = 1;
    if (path === "launch" || path === "launch-plan" || path === "continue" || path === "restart" || path === "restart-plan" || path === "set-cwd") {
      for (const warning of (res.data["warnings"] as string[] | undefined) ?? []) console.warn(`Warning: ${warning}`);
    }
    if (res.status >= 400) {
      const error = path === "continue" && res.data["code"] === "continuation_unavailable"
        ? {
          ...res.data,
          message: "No verified pending startup-context delivery exists for this occupant. It is unknown whether context was already delivered or was never pending.",
          guidance: `Inspect its current state: rig seat status ${shellQuote(seat)}`,
        }
        : res.data;
      printSeatError(error as unknown as SeatStatusError, `Seat ${path} failed (HTTP ${res.status})`);
      process.exitCode = res.status >= 500 ? 2 : 1;
      return;
    }
    printOk(res.data);
  };

  const terminalPolicy = cmd.command("set-terminal-policy")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .requiredOption("--preset <preset>", "no-peer-interventions, help-within-instructions, full-control")
    .option("--helper <addresses...>", "Named helpers covered by the delegated instruction")
    .option("--rig-default", "Set this rig's default for newly added seats only, leaving existing seats unchanged")
    .requiredOption("--reason <text>", "Delegating instruction and audit reason")
    .option("--operator <address>", "Audit attribution outside a managed seat")
    .option("--json", "JSON output for agents")
    .description("Choose terminal interventions; managed compaction and saved model/effort changes are checked")
    .addHelpText("after", "\nReplaces the complete choice. Exceptions take allow or deny; model covers effort too.\nPeer presets never change self/OpenRig authority unless its exception is supplied. No native permissions or interruption levels change.\nOther interventions are guidance-only. The existing dangerous send override and its guards are unchanged.");
  for (const scope of ["peer", "self", "openrig"]) for (const action of ["compaction", "model"])
    terminalPolicy.option(`--${scope}-${action} <decision>`, `Explicit ${scope} ${action} exception: allow or deny`);
  terminalPolicy.action(async (seat: string, opts: Record<string, unknown> & { json?: boolean }) => {
    const exceptions: Record<string, Record<string, unknown>> = {};
    for (const scope of ["peer", "self", "openrig"]) for (const action of ["compaction", "model"]) {
      const value = opts[scope + action[0]!.toUpperCase() + action.slice(1)];
      if (value !== undefined) (exceptions[scope] ??= {})[action] = value;
    }
    await runLifecycleVerb("set-terminal-policy", seat, { preset: opts.preset, helpers: opts.helper ?? [],
      exceptions, rigDefault: opts.rigDefault === true, reason: opts.reason, operator: opts.operator }, opts,
      data => { console.log(String(data["effect"])); console.log(`Read the account: rig seat status ${shellQuote(seat)}`); });
  });

  cmd
    .command("set-permissions")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .requiredOption("--mode <mode>", "floor, full_bypass, inherit, or a Claude mode supported by the bound managed launch context")
    .requiredOption("--reason <text>", "Reason for the audited future-launch selection")
    .option("--operator <address>", "Operator recorded on the audit event when no session identity is present")
    .option("--json", "JSON output for agents")
    .description("Select native permissions for future managed launches; no relaunch or work-posture change")
    .addHelpText("after", "\nUse inherit to clear this seat's explicit selection. Current native processes, history, rules and hooks remain unchanged. A later lifecycle action needs its own authorization.")
    .action(async (seat: string, opts: { mode: string; reason: string; operator?: string; json?: boolean }) => {
      await runLifecycleVerb("set-permissions", seat, { mode: opts.mode, reason: opts.reason, operator: opts.operator }, opts, data => {
        const selection = data["to"] as { mode: string } | null;
        console.log(`Permission mode: ${selection?.mode ?? "inherit"}${data["changed"] === false ? " (unchanged)" : " (audited)"}`);
        console.log(String(data["effect"]));
      });
    });

  cmd
    .command("set-effort")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .option("--effort <level>", "The runtime's own effort level (for example low, medium, high; Pi also accepts off, minimal, xhigh, max)")
    .option("--clear", "Remove this seat's explicit choice and go back to its authored or default effort")
    .requiredOption("--reason <text>", "Audit reason recorded on the node.effort_changed event")
    .option("--operator <address>", "Operator recorded on the audit event")
    .option("--json", "JSON output for agents")
    .description("Save one seat's reasoning effort for its next managed continuation (audited); no restart")
    .addHelpText("after", `
Only this seat changes; its peers, model and account don't. The running process
keeps its current effort until the seat's next managed continuation. Whether the
native session then uses the level is a separate fact this command can't see.
Works on Claude Code, Codex and Pi seats; Pi gets it as --thinking <level>. Levels
are the runtime's own and are not translated; an unfamiliar one is saved with a warning.
Examples:
  rig seat set-effort dev-impl@my-rig --effort high --reason "long refactor"
  rig seat set-effort dev.impl --clear --reason "back to the spec's effort" --json`)
    .action(async (seat: string, opts: { effort?: string; clear?: boolean; reason: string; operator?: string; json?: boolean }) => {
      if (Boolean(opts.clear) === (opts.effort !== undefined)) {
        console.error("Pass exactly one of --effort <level> or --clear.");
        process.exitCode = 1;
        return;
      }
      const body = opts.clear ? { clear: true, reason: opts.reason, operator: opts.operator } : { effort: opts.effort, reason: opts.reason, operator: opts.operator };
      await runLifecycleVerb("set-effort", seat, body, opts, (data) => {
        const s = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
        const saved = data["saved"] as { choice: string | null; authored: string | null; effective: string | null; source: string };
        const name = `${s?.logicalId}@${s?.rigName}`;
        const level = saved.source === "seat_choice" ? `${saved.effective} (this seat's choice)`
          : saved.source === "authored" ? `${saved.effective} (authored)` : "no effort flag (runtime default)";
        console.log(data["changed"] === false ? `Effort for ${name} already resolves to ${level}. No change recorded.` : `Effort for ${name}: ${level}.`);
        console.log(String(data["effect"]));
        const running = data["running"] === "yes" ? "running now" : data["running"] === "no" ? "not running now" : `running state unknown (${String(data["runningDetail"] ?? "probe failed")})`;
        console.log(`Seat ${running}. Emitted at launch: not yet. Native effort: not observed.`);
        if (data["warning"]) console.log(`Warning: ${String(data["warning"])}`);
      });
    });

  cmd
    .command("effort")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .option("--json", "JSON output for agents")
    .description("Show one seat's effort four ways: requested, saved, sent at launch, and what the native session records")
    .addHelpText("after", `
Read-only. The launch value is the flag on the running process's own command line.
The native value is the effort the session recorded for a turn since that process
started (Claude's transcript, Codex's rollout, Pi's thinkingLevel on its latest
successful assistant turn: the level after Pi's own cap, recorded by Pi 0.99.0 or
later); until the seat takes a turn, or where it can't be read, it is NOT VERIFIED,
never assumed from the flag.
Examples:
  rig seat effort dev-impl@my-rig
  rig seat effort dev.impl --json`)
    .action(async (seat: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const daemon = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(daemon)) return;
      const client = deps.clientFactory(getDaemonUrl(daemon));
      const res = await client.get<Record<string, unknown>>(`/api/seat/effort/${encodeURIComponent(seat)}`);
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }
      if (res.status >= 400) {
        printSeatError(res.data as unknown as SeatStatusError, `Seat effort failed (HTTP ${res.status})`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }
      printEffortReport(res.data);
    });

  cmd
    .command("set-model")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .requiredOption("--model <id>", "Target model id (e.g. the canonical id an alias pin migrates to)")
    .requiredOption("--reason <text>", "Audit reason recorded on the node.model_changed event")
    .option("--operator <address>", "Operator recorded on the audit event")
    .option("--json", "JSON output for agents")
    .description("Persist a seat's model id (audited); subsequent managed resumes use the new model")
    .addHelpText("after", `
Session lineage is untouched — only nodes.model changes, and every managed
resume/successor launch reads it at call time. Examples:
  rig seat set-model dev-impl@my-rig --model claude-fable-5 --reason "alias fable -> canonical"
  rig seat set-model dev.impl --model claude-fable-5 --reason "canonical migration" --json`)
    .action(async (seat: string, opts: { model: string; reason: string; operator?: string; json?: boolean }) => {
      await runLifecycleVerb("set-model", seat, { model: opts.model, reason: opts.reason, operator: opts.operator }, opts, (data) => {
        const s = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
        if (data["changed"] === false) {
          console.log(`Model for ${s?.logicalId}@${s?.rigName} already ${String(data["to"])} — no change recorded.`);
          return;
        }
        console.log(`Model for ${s?.logicalId}@${s?.rigName}: ${String(data["from"] ?? "none")} -> ${String(data["to"])} (audited).`);
        console.log("The next managed resume/successor launch composes the new model.");
      });
    });

  cmd
    .command("set-cwd")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .requiredOption("--cwd <directory>", "Absolute working directory on the daemon's host; created if missing")
    .requiredOption("--reason <text>", "Audit reason for the future launch directory")
    .option("--operator <address>", "Operator recorded on the audit event when no session identity is present")
    .option("--json", "JSON output for agents")
    .description("Save an existing seat's working directory for its next fresh launch or rebuild handover")
    .addHelpText("after", `
Saves the directory (and an audit event) for this seat's next launch. The seat's
identity, address, queue and history are kept. set-cwd creates the folder if it's
missing and writes nothing else there: the next launch writes the startup files,
as it does today. Its preflight policy checks the resource copies and startup
skills that launch would place there, as they are now: an operator-edited file,
an unrecorded file with different content, or two sources for one destination
refuses the change, naming those paths. It's a point-in-time check, not a
guarantee against later changes; at adoption, launch applies its own policy.
(A refusal may leave the new folder created; nothing else changes.)

The saved directory doesn't move the running process. Adopt it with
  rig seat launch <seat> --fresh --stop --reason <text>   (a blank conversation) or
  rig seat handover <seat> --source rebuild --reason <text>   (carries durable context)
Until then, background work can already use the saved directory. For a running
Claude seat, for example, collector provisioning writes .openrig/context-collector.cjs
and merges .claude/settings.local.json there (under its existing preservation
rules), and managed compaction, manual or automatic, asks the seat to write its
restore map there, which may be outside its current workspace, where a seat
without bypass permissions may meet a write prompt. Adopting promptly is guidance; it doesn't protect against a poll or
a compaction that runs before your next command.
Before adopting, don't rig down/rig up or hand over by fork: those resume the
existing conversation in the saved directory, and Claude keeps conversations per
project directory, so a resume there may not find it (not run natively).
rig seat restart --keep-conversation (Codex) isn't adoption: it respawns in the
directory it observes from the running process.

Files in the old directory are left as they are; other seats may still use them.
Example:
  rig seat set-cwd planning-lead@project --cwd /work/project/seats/planning-lead --reason "isolate planning"`)
    .action(async (seat: string, opts: { cwd: string; reason: string; operator?: string; json?: boolean }) => {
      await runLifecycleVerb("set-cwd", seat, { cwd: opts.cwd, reason: opts.reason, operator: opts.operator }, opts, data => {
        const s = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
        console.log(`Launch directory for ${s?.logicalId}@${s?.rigName}: ${String(data["to"])}${data["changed"] === false ? " (already selected)" : " (audited)"}.`);
        console.log("set-cwd wrote nothing there but the folder: the next fresh launch or rebuild handover writes its startup files.");
        console.log("The running process keeps its current directory. Adopt the new one promptly with either:");
        console.log(`  rig seat launch ${seat} --fresh --stop --reason <text>   (a blank conversation)`);
        console.log(`  rig seat handover ${seat} --source rebuild --reason <text>   (carries durable context)`);
        console.log("Until then, background work can already use the saved directory, such as a Claude seat's managed compaction (see rig seat set-cwd --help).");
        console.log("Files in the previous directory are left as they are; other seats may still use them.");
      });
    });

  cmd
    .command("launch")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .requiredOption("--fresh", "Explicitly create a blank native occupant; no continuity source is used")
    .option("--reason <text>", "Audit reason (required when executing, optional with --plan)")
    .option("--plan", "Preview this fresh launch without changing any seat or starting tmux")
    .option("--stop", "Stop the current live managed occupant before launching fresh")
    .option("--operator <address>", "Operator recorded on the audit event")
    .option("--json", "JSON output for agents")
    .description("Launch a deliberate fresh occupant for exactly one existing seat")
    .addHelpText("after", `
No resume, fork, rebuild, snapshot, checkpoint, or restore packet is used.
A live managed seat requires --stop; adopted and unmanaged sessions are refused.
Sibling seats stay attached and untouched. The runtime adapter composes a new
command from current settings; launch does not replay a stored wrapper command.
The seat launch environment and managed executable selection still apply.
Preview is a read-only snapshot, not a reservation or a native readiness check.
A successful preview exits 0; inspect launchable to decide whether launch is allowed.
Unreadable tmux produces complete:false and unknown eligibility unless already blocked.
Examples:
  rig seat launch dev.impl --fresh --plan --json
  rig seat launch dev-impl@my-rig --fresh --reason "deliberate blank restart"
  rig seat launch dev.impl --fresh --stop --reason "replace managed occupant" --json`)
    .action(async (seat: string, opts: { fresh: boolean; reason?: string; plan?: boolean; stop?: boolean; operator?: string; json?: boolean }) => {
      if (!opts.plan && !opts.reason?.trim()) {
        const error = { ok: false, code: "missing_reason", message: "Execution requires --reason; use --plan for a read-only preview." };
        if (opts.json) console.log(JSON.stringify(error, null, 2));
        else console.error(error.message);
        process.exitCode = 1;
        return;
      }
      await runLifecycleVerb(opts.plan ? "launch-plan" : "launch", seat, {
        fresh: opts.fresh === true,
        reason: opts.reason,
        stop: opts.stop === true,
        operator: opts.operator,
      }, opts, (data) => {
        if (opts.plan) {
          console.log(`Fresh launch preview: ${String(data["sessionName"])} (no changes made).`);
          console.log(`Current occupant: ${String(data["currentOccupant"])}.`);
          console.log(`Complete: ${String(data["complete"])}; launchable: ${data["launchable"] == null ? "unknown" : String(data["launchable"])}; stop required: ${data["stopRequired"] == null ? "unknown" : String(data["stopRequired"])}; would stop: ${data["wouldStop"] == null ? "unknown" : String(data["wouldStop"])}.`);
          for (const blocker of data["blockers"] as Array<{ message: string; guidance?: string }>) {
            console.log(`Blocked: ${blocker.message}`);
            if (blocker.guidance) console.log(blocker.guidance);
          }
          const startup = data["startup"] as { projectionCount: number; fileCount: number; actionCount: number };
          console.log(`Startup: ${startup.projectionCount} projections, ${startup.fileCount} files, ${startup.actionCount} actions.`);
          for (const sibling of data["siblings"] as Array<{ logicalId: string }>) console.log(`Sibling ${sibling.logicalId}: unchanged.`);
          // OPR.0.7.0.9: the seat's own launch additions, as the seat view shows them.
          for (const line of seatLaunchAdditionLines(data["launchAdditions"] as SeatLaunchAdditionsView | null | undefined)) console.log(line);
          return;
        }
        const s = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
        const superseded = data["supersededSessionIds"] as string[] | undefined;
        console.log(`Fresh occupant ready: ${s?.logicalId}@${s?.rigName} (${String(data["sessionName"])}).`);
        console.log(`Generation: ${String(data["generation"])}; model: ${String(data["model"] ?? "none")}.`);
        console.log(`Startup policy: ${String(data["startupPolicyHash"])}; superseded sessions: ${superseded?.length ?? 0}.`);
        console.log("No continuity source was used; siblings and durable work were preserved.");
      });
    });

  cmd
    .command("restart")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .requiredOption("--keep-conversation", "Resume the seat's own conversation in its own pane; never a fresh launch or fork")
    .option("--reason <text>", "Audit reason (required when executing)")
    .option("--plan", "Run every check and show what a restart would keep; nothing is stopped or restarted")
    .option("--verify", "After a real tool-using turn, check whether the restarted seat can be reported as moved")
    .option("--expect-account <text>", "With --verify: the account Codex's /status Account line must name")
    .option("--operator <address>", "Operator recorded on the audit event")
    .option("--host <id>", "Restart a seat on this registered machine, over its SSH entry, as this seat")
    .option("--json", "JSON output for agents")
    .description("Restart one Codex seat in place so it reads its Codex home's current account")
    .addHelpText("after", `
The seat's own conversation resumes in its own pane with the settings the running
Codex uses now (model, effort, profile, permissions, cwd, Codex home), with one
exception: an explicit effort choice saved with rig seat set-effort is applied, and
--plan shows that change. With no saved choice (never set, or cleared with --clear),
an effort difference refuses as settings_drift, as a pending set-model does; the
next ordinary managed launch or resume resolves effort instead.
This never switches an account (use rig auth switch first), never reads credentials,
never launches fresh, forks or retries. Peers sharing the Codex home are reported,
not restarted.
Mid-turn activity and child processes are shown in --plan and the result; deciding
whether to interrupt them is the operator's call.
An adopted seat (origin=claimed) refuses with claimed_session. The stored conversation
must match the one the running Codex's command line names (or, when it names none, the
only one Codex has logged since it started); OpenRig can't tell which conversation
Codex is on now. If it was changed inside the running Codex, the restart may refuse or
resume the earlier one: check the pane with rig capture <seat> first.
--plan starts no Codex process: the network override, --no-daemon and add-dirs are
taken from the running Codex's own command line, not probed again. Building the
command can create OpenRig's own seat-bin link, as every managed launch does.
A restart that started under an earlier daemon run and never recorded a result is
shown as staleRestart; it does not block a new restart.
Results: restarted_account_unverified, not_started (the original is still running),
incomplete (it exited; the resume was not proven; the pane may be held for recovery),
native_unknown (what happened could not be observed). Only --verify reports moved,
and only with a completed tool turn since the restart AND --expect-account matched.
With --host, the same restart runs on that machine against its daemon, over its SSH entry; the audit names this
seat as the operator unless --operator does, and the result is that machine's, as it reports it.
Examples:
  rig seat restart dev.impl --keep-conversation --plan --json
  rig seat restart dev-impl@my-rig --keep-conversation --reason "take the home's new account"
  rig seat restart dev.impl --keep-conversation --verify --expect-account me@example.com`)
    .action(async (seat: string, opts: { keepConversation: boolean; reason?: string; plan?: boolean; verify?: boolean; expectAccount?: string; operator?: string; host?: string; json?: boolean }) => {
      if (opts.plan && opts.verify) {
        const error = { ok: false, code: "invalid_options", message: "--plan and --verify are separate steps; pass one." };
        if (opts.json) console.log(JSON.stringify(error, null, 2));
        else console.error(error.message);
        process.exitCode = 1;
        return;
      }
      if (!opts.plan && !opts.verify && !opts.reason?.trim()) {
        const error = { ok: false, code: "missing_reason", message: "A restart requires --reason; use --plan for a read-only preview." };
        if (opts.json) console.log(JSON.stringify(error, null, 2));
        else console.error(error.message);
        process.exitCode = 1;
        return;
      }
      if (opts.host) {
        const seatName = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME")?.trim() || undefined;
        const origin = await originFor(seatName, depsOverride?.host?.selfHostId ?? (() => localSelfHostId(getDeps().lifecycleDeps)));
        const changes = !opts.plan && !opts.verify;
        const operator = opts.operator ?? (changes ? origin : undefined);
        await runOnSshHost(opts.host, "seat restart", [
          "seat", "restart", seat, "--keep-conversation",
          ...(opts.plan ? ["--plan"] : []),
          ...(opts.verify ? ["--verify"] : []),
          ...(opts.expectAccount !== undefined ? ["--expect-account", opts.expectAccount] : []),
          ...(opts.reason !== undefined ? ["--reason", opts.reason] : []),
          ...(operator ? ["--operator", operator] : []),
          ...(opts.json ? ["--json"] : []),
        ], {
          origin,
          json: opts.json,
          ...(changes ? { changes: { check: `rig seat restart ${seat} --keep-conversation --plan --host ${opts.host} (its lastRestart says whether this restart ran); don't restart it again on this result alone` } } : {}),
        }, depsOverride?.host);
        return;
      }
      if (opts.verify) {
        await runLifecycleVerb("restart-verify", seat, { expectAccount: opts.expectAccount }, opts, (data) => {
          console.log(`${String(data["outcome"])}: ${String(data["message"])}`);
          const turn = data["toolTurn"] as { completed: number; errors: number; state: string };
          console.log(`Tool turn since the restart: ${turn.state}, ${turn.completed} completed, ${turn.errors} errors.`);
          console.log(`Account evidence: ${(data["accountEvidence"] as { detail: string }).detail}`);
        });
        return;
      }
      await runLifecycleVerb(opts.plan ? "restart-plan" : "restart", seat, opts.plan ? {} : { reason: opts.reason, operator: opts.operator }, opts, (data) => {
        printRestartReport(data);
      });
    });

  cmd
    .command("continue")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .option("--json", "JSON output for agents")
    .description("Deliver pending startup context to the same fresh or forked conversation")
    .addHelpText("after", "\nResolve any native prompt first. A pending Codex fork must have a verified child identity. This reuses the existing occupant and does not relaunch or replay an attempted delivery.")
    .action(async (seat: string, opts: { json?: boolean }) => {
      await runLifecycleVerb("continue", seat, {}, opts, data => {
        console.log(String(data["message"]));
      });
    });

  cmd
    .command("stop")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .requiredOption("--reason <text>", "Audit reason recorded on the session.stopped event")
    .option("--operator <address>", "Operator recorded on the audit event")
    .option("--json", "JSON output for agents")
    .description("Stop exactly one LIVE managed seat (kills only that seat's tmux session; audited)")
    .addHelpText("after", `
Siblings are untouched. A dead seat is refused (use rig seat clean); an adopted
session is refused (use rig unclaim). Stopping ends that agent's session and any
work in progress: check it first (rig capture <seat>) and stop only a seat you
own or were asked to stop. rig seat launch <seat> --fresh --reason <text> starts
a fresh occupant there; it does not resume the stopped conversation.
An intentionally stopped seat does not degrade an otherwise running rig.
Running counts still exclude the stopped seat; stopping every seat leaves the
rig stopped. Examples:
  rig seat stop dev-impl@my-rig --reason "wave boundary retirement"
  rig seat stop dev.impl --reason "stuck occupant" --json`)
    .action(async (seat: string, opts: { reason: string; operator?: string; json?: boolean }) => {
      await runLifecycleVerb("stop", seat, { reason: opts.reason, operator: opts.operator }, opts, (data) => {
        const s = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
        console.log(`Stopped ${String(data["sessionName"])} (seat ${s?.logicalId}@${s?.rigName}).`);
        console.log("Session marked exited, binding cleared; siblings untouched. Relaunch via the normal launch surface.");
      });
    });

  cmd
    .command("clean")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .requiredOption("--reason <text>", "Audit reason recorded on the session.cleaned event")
    .option("--operator <address>", "Operator recorded on the audit event")
    .option("--json", "JSON output for agents")
    .description("Return a DEAD seat to launchable (clears stale binding + session records; audited)")
    .addHelpText("after", `
Live owner state is preserved: the node row, session history (incl. resume
tokens), and the occupant-tenure ledger are untouched. A live seat is refused
(use rig seat stop). Examples:
  rig seat clean dev-impl@my-rig --reason "clean exit observed, relaunch wanted"
  rig seat clean dev.impl --reason "post-crash tidy" --json`)
    .action(async (seat: string, opts: { reason: string; operator?: string; json?: boolean }) => {
      await runLifecycleVerb("clean", seat, { reason: opts.reason, operator: opts.operator }, opts, (data) => {
        const s = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
        const actions = data["actions"] as { sessionsExited?: string[]; bindingCleared?: boolean } | undefined;
        console.log(`Cleaned seat ${s?.logicalId}@${s?.rigName}.`);
        console.log(`Sessions marked exited: ${actions?.sessionsExited?.length ? actions.sessionsExited.join(", ") : "none (already terminal)"}; binding cleared: ${actions?.bindingCleared ? "yes" : "no"}.`);
        console.log("Owner state preserved (node, session history, tenure ledger). The seat is launchable again.");
      });
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
      if (!daemonStatusGuard(status)) return;
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
  if (!daemonStatusGuard(daemon)) return; // B8-1b: epistemic-matched

  const client = deps.clientFactory(getDaemonUrl(daemon));
  const handoverRoute = `/api/seat/handover/${encodeURIComponent(seat)}`;
  const handoverBody = {
    source: opts.source,
    reason: opts.reason,
    operator: opts.operator,
    dryRun: opts.dryRun === true,
  };
  let res;
  try {
    // #260: a mutating handover launches and readies the successor, so it gets the
    // launch request window. A dry run only plans, and keeps the default deadline.
    res = opts.dryRun === true
      ? await client.post<SeatHandoverPlan | SeatHandoverMutationResult | SeatStatusError>(handoverRoute, handoverBody)
      : await client.post<SeatHandoverPlan | SeatHandoverMutationResult | SeatStatusError>(handoverRoute, handoverBody, { timeoutMs: 120_000 });
  } catch (err) {
    // The daemon keeps working when the client stops waiting, so reaching the bound leaves a
    // mutating handover's outcome unknown. One request; no retry.
    if (opts.dryRun === true || !(err instanceof DaemonTimeoutError)) throw err;
    const error = {
      ok: false as const,
      code: "handover_outcome_unknown",
      status: "unknown",
      message: "The CLI stopped waiting for the daemon after 120 seconds, so the handover outcome is unknown. The daemon may still be working on it.",
      guidance: `Inspect the seat before considering another handover: rig seat status ${seat}. A handover result shown there may belong to an earlier attempt.`,
    };
    if (opts.json) console.log(JSON.stringify(error, null, 2));
    else printSeatError(error, error.message);
    process.exitCode = 1;
    return;
  }

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
    .option("--source <source>", "Successor source: fresh (default; launches a new agent), discovered:<id> (operator-prepared), fork:<id> (native fork of the source conversation), or rebuild (fresh agent primed from the seat's durable artifacts).")
    .option("--reason <reason>", "Why the handover is happening")
    .option("--operator <address>", "Operator initiating the handover")
    .option("--dry-run", "Plan the handover without changing topology")
    .option("--json", "JSON output for agents")
    .description("Hand a seat to a successor: create -> deliver context -> verify continuity -> rebind")
    .addHelpText("after", `
All four sources execute (OPR.0.5.5.5): fresh delivers a captured restore
packet; discovered adopts an operator-prepared live session; fork:<id> launches
a NATIVE FORK of the source conversation (the successor carries the incumbent
context from its first byte); rebuild launches fresh and primes from the seat's
durable artifact chain, recording exactly what it found. A source that cannot
proceed (e.g. fork with no discoverable native id) refuses honestly before any
mutation — a handover is never silently completed.

Examples:
  rig handover spec-writer@openrig-pm --reason context-wall --dry-run
  rig handover spec-writer@openrig-pm --source fresh --reason context-wall
  rig handover spec-writer@openrig-pm --source fork:spec-writer@openrig-pm --reason context-wall
  rig handover spec-writer@openrig-pm --source rebuild --reason degraded-incumbent
  rig handover spec-writer@openrig-pm --source discovered:01H... --reason mvp-proof --json`)
    .action((seat: string, opts: HandoverActionOpts) => runSeatHandover(seat, opts, getDeps()));
}

function printEffortReport(data: Record<string, unknown>): void {
  const seat = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
  const requested = data["requested"] as { value: string | null; at: string; reason: string } | null;
  const saved = data["saved"] as { effective: string | null; source: string };
  const emitted = data["emitted"] as { state: string; value?: string | null; pid?: number; detail?: string };
  const observed = data["observed"] as { state: string; value?: string; at?: string; source?: string; outcome?: string; detail?: string };
  const precedence = data["precedence"] as { decided: boolean; detail: string };
  console.log(`Effort for ${seat?.logicalId}@${seat?.rigName} (${String(data["runtime"])}):`);
  console.log(`  Requested: ${requested ? `${requested.value ?? "cleared"} at ${requested.at} ("${requested.reason}")` : "never set with rig seat set-effort"}`);
  console.log(`  Saved:     ${saved.effective ? `${saved.effective} (${saved.source === "seat_choice" ? "this seat's choice" : "authored"})` : "no effort flag (runtime default)"}`);
  console.log(`  Launch:    ${emitted.state === "observed" ? `${emitted.value ?? "no effort flag"} (process ${emitted.pid})` : `unknown: ${emitted.detail}`}`);
  console.log(`  Native:    ${observed.state === "observed" ? `${observed.value} sent with the latest turn, ${observed.outcome} (${observed.source}, ${observed.at})` : `NOT VERIFIED: ${observed.detail}`}`);
  console.log(String(data["summary"]));
  if (!precedence.decided) console.log(`Note: ${precedence.detail}`);
}

function printRestartReport(data: Record<string, unknown>): void {
  const seat = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
  console.log(`${data["outcome"] ? String(data["outcome"]) : "preview"}: ${seat?.logicalId}@${seat?.rigName} (${String(data["sessionName"])}, pane ${String(data["pane"])}, ${String(data["paneShape"])}).`);
  console.log(String(data["message"]));
  console.log(`Conversation: ${String(data["conversationId"])} (proved by ${String(data["conversationProof"])}).`);
  const activity = data["activity"] as { state: string; detail: string };
  console.log(`Activity: ${activity.state}. ${activity.detail}`);
  const children = data["childProcesses"] as Array<{ pid: number; name: string }>;
  if (children.length > 0) console.log(`Child processes (stopped with Codex): ${children.map((child) => `${child.name} ${child.pid}`).join(", ")}.`);
  const settings = data["settings"] as { note?: string } | undefined;
  if (settings?.note) console.log(`Settings: ${settings.note}`);
  console.log(`Codex home: ${String(data["codexHome"])}.`);
  const noDaemon = data["codexNoDaemonFlag"] as { detail: string } | undefined;
  if (noDaemon) console.log(noDaemon.detail);
  const account = data["account"] as { credentialStore: { detail: string }; authFile: { detail: string }; startupGate: string | null; startupGateKind?: string | null };
  console.log(`Account: unverified. ${account.credentialStore.detail} ${account.authFile.detail}`);
  if (account.startupGate) console.log(`Codex startup gate${account.startupGateKind ? ` (${account.startupGateKind})` : ""}: ${account.startupGate}`);
  const stale = data["staleRestart"] as { startedAt: string; detail: string } | undefined;
  if (stale) console.log(`Stale restart from ${stale.startedAt}: ${stale.detail}`);
  const last = data["lastRestart"] as { outcome: string; finishedAt: string } | undefined;
  if (last) console.log(`Last restart: ${last.outcome} at ${last.finishedAt}.`);
  const held = data["paneHeld"] as { detail: string } | undefined;
  if (held) console.log(`Pane held (remain-on-exit on): ${held.detail}`);
  const seen = data["observedAfterStop"] as { detail: string } | undefined;
  if (seen) console.log(`Observed after the stop: ${seen.detail}.`);
  if (data["remainingStep"]) console.log(`Remaining step: ${String(data["remainingStep"])}`);
  if (data["recoveryCommand"]) console.log(`Recovery command: ${String(data["recoveryCommand"])}`);
  for (const item of (data["couldNotSee"] as string[] | undefined) ?? []) console.log(`Could not see: ${item}`);
  for (const peer of data["peers"] as Array<{ logicalId: string; effect: string }>) console.log(`Peer ${peer.logicalId}: ${peer.effect}`);
}
