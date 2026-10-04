import { Command } from "commander";
import { DaemonClient, DaemonTimeoutError, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
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
  typingGuard?: { desired: boolean; effective: boolean; pending: boolean; heldCount: number };
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
  };
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
  /** OPR.0.5.5.5 — per-source execution record (wire mirror of the daemon shape). */
  sourceOutcome?:
    | { mode: "fork"; forkedFrom: string }
    | { mode: "rebuild"; primedArtifacts: Array<{ address: string; label: string }>; gaps: string[]; emptyChainReason?: string };
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
  if (status.typingGuard) {
    const g = status.typingGuard;
    console.log(`Typing guard: ${g.effective ? "on" : "off"}${g.pending ? ` (activation pending; requested ${g.desired ? "on" : "off"})` : ""}; ${g.heldCount} retained`);
    console.log("Automatic input pauses while on, including writing lifecycle. Disabling does not replay held messages.");
  }
  console.log(`Session: ${display(status.session_status, "unknown")}`);
  if (status.permissions) {
    const p = status.permissions;
    const formatSource = (source: string): string => {
      if (source === "member_spec") return "from the member's permission_policy";
      if (source === "rig_spec") return "from the rig's permission_policy";
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
  } else if (result.sourceOutcome?.mode === "rebuild") {
    const outcome = result.sourceOutcome;
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

export function seatCommand(depsOverride?: SeatDeps & { readStdin?: () => Promise<string> }): Command {
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
  cmd.command("set-typing-guard").argument("<seat>").requiredOption("--enabled <boolean>", "true pauses all automatic terminal input; false permits new sends")
    .requiredOption("--reason <text>").option("--json").description("Protect this seat's draft by retaining automatic delivery, even at an empty prompt")
    .addHelpText("after", `
This persistent, per-seat preference defaults off. On pauses ALL automatic terminal
input, even at an empty prompt; it is not a typing detector or permission mode.
Messages and wakes are retained in the existing outbox. Writing lifecycle operations
refuse before effects; raw/force/submit-only options do not bypass protection.
Direct human terminal input remains available. Other seats keep their own settings.

Activation can be pending while an already-started operation finishes. Read
rig seat status <seat> and wait for effective=true before relying on protection.
Inspect retained bodies with rig seat held-messages <seat> (or --id <id>).
Turning the guard off permits NEW sends; it never flushes or retries held messages.
Retire a reviewed record with rig seat retire-held-message <seat> <id> --reason <text>.
Retirement preserves evidence and frees quota; it does not deliver or close work.

Active retention defaults: 100 records / 8 MiB per seat, 1 MiB per message.
New admissions refuse at capacity. Already-committed queue intent is preserved even
when a concurrent activation exceeds that cap; inspect and retire it explicitly.
Protection covers OpenRig's managed input paths, not external tmux tools or another
process writing directly to the terminal. Disable deliberately before lifecycle work.
`)
    .action(async (seat: string, opts: { enabled: string; reason: string; json?: boolean }) => {
      if (opts.enabled !== "true" && opts.enabled !== "false") { console.error("--enabled must be true or false"); process.exitCode = 1; return; }
      await guardRequest("POST", `/api/seat/set-typing-guard/${encodeURIComponent(seat)}`, { enabled: opts.enabled === "true", reason: opts.reason }, opts.json);
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
    .option("--reason <text>", "Attest startup or subset-restore attention; cannot bypass full-restore or pane-identity checks")
    .option("--json", "JSON output for agents")
    .description("Reconcile seat attention using the checks for its attention class")
    .addHelpText("after", `
Examples:
  rig seat clear-attention dev-impl@my-rig
  rig seat clear-attention dev-impl@my-rig --reason "founder re-authed, confirmed live"
  rig seat clear-attention dev-impl@my-rig --json

--reason can acknowledge startup-status and subset-restore attention. It does
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
    path: "set-model" | "set-permissions" | "launch" | "stop" | "clean",
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
      res = path === "launch"
        ? await client.post<Record<string, unknown>>(route, body, { timeoutMs: 120_000 })
        // #260: a dynamic Claude mode waits up to 5 s for the capability query before the
        // daemon answers, so the 5 s default deadline would abort before its refusal arrives.
        : path === "set-permissions"
          ? await client.post<Record<string, unknown>>(route, body, { timeoutMs: 10_000 })
          : await client.post<Record<string, unknown>>(route, body);
    } catch (err) {
      if (path !== "launch" || !(err instanceof DaemonTimeoutError)) throw err;
      const error = {
        ok: false as const,
        code: "launch_outcome_unknown",
        status: "unknown",
        message: "The CLI timed out waiting for the daemon; the launch may still be in progress.",
        guidance: `Check the outcome before retrying: rig seat status ${seat}`,
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
    if (path === "launch") {
      for (const warning of (res.data["warnings"] as string[] | undefined) ?? []) console.warn(`Warning: ${warning}`);
    }
    if (res.status >= 400) {
      printSeatError(res.data as unknown as SeatStatusError, `Seat ${path} failed (HTTP ${res.status})`);
      process.exitCode = res.status >= 500 ? 2 : 1;
      return;
    }
    printOk(res.data);
  };

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
    .command("launch")
    .argument("<seat>", "Canonical session name or logical seat ref")
    .requiredOption("--fresh", "Explicitly create a blank native occupant; no continuity source is used")
    .requiredOption("--reason <text>", "Audit reason recorded on the seat.fresh_launched event")
    .option("--stop", "Stop the current live managed occupant before launching fresh")
    .option("--operator <address>", "Operator recorded on the audit event")
    .option("--json", "JSON output for agents")
    .description("Launch a deliberate fresh occupant for exactly one existing seat")
    .addHelpText("after", `
No resume, fork, rebuild, snapshot, checkpoint, or restore packet is used.
A live managed seat requires --stop; adopted and unmanaged sessions are refused.
Examples:
  rig seat launch dev-impl@my-rig --fresh --reason "deliberate blank restart"
  rig seat launch dev.impl --fresh --stop --reason "replace managed occupant" --json`)
    .action(async (seat: string, opts: { fresh: boolean; reason: string; stop?: boolean; operator?: string; json?: boolean }) => {
      await runLifecycleVerb("launch", seat, {
        fresh: opts.fresh === true,
        reason: opts.reason,
        stop: opts.stop === true,
        operator: opts.operator,
      }, opts, (data) => {
        const s = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
        const superseded = data["supersededSessionIds"] as string[] | undefined;
        console.log(`Fresh occupant ready: ${s?.logicalId}@${s?.rigName} (${String(data["sessionName"])}).`);
        console.log(`Generation: ${String(data["generation"])}; model: ${String(data["model"] ?? "none")}.`);
        console.log(`Startup policy: ${String(data["startupPolicyHash"])}; superseded sessions: ${superseded?.length ?? 0}.`);
        console.log("No continuity source was used; siblings and durable work were preserved.");
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
session is refused (use rig unclaim). Examples:
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
