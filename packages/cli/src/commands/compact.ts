import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { daemonMayAnswer } from "../daemon-reachability.js";
import { realDeps } from "./daemon.js";

// Preparation (exact map plus idle wait) shares the 180s ceiling. Give the HTTP
// call generous headroom so the client does not time out mid-sequence.
const MANUAL_COMPACT_REQUEST_TIMEOUT_MS = 240_000;

export interface CompactDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (url: string) => DaemonClient;
}

/**
 * OPR.0.4.3.14 — `rig compact <session>`: manually trigger compaction for one
 * Claude or Pi seat on demand, independent of the auto threshold. Distinct from
 * the read-only, Claude-only `rig compact-plan` triage command.
 */
export function compactCommand(depsOverride?: CompactDeps): Command {
  const cmd = new Command("compact")
    .description("Manually trigger one seat's compaction: the Claude guided lifecycle or Pi's native compact RPC")
    .argument("<session>", "Target Claude or Pi session name (e.g. dev-impl@my-rig)")
    .option("--json", "JSON output for agents")
    .option("--skip-map", "Claude: skip the restore-map prerequisite once; ignored for Pi")
    .option("--cancel", "Claude only: disarm managed preparation or pending restore/audit; cannot undo a submitted /compact")
    .option("--state", "Show the current state without triggering (Claude preparation/map/deadline; Pi runner-sidecar state)")
    .addHelpText("after", `
Examples:
  rig compact dev-impl@my-rig          Trigger one seat's compaction now
  rig compact dev-impl@my-rig --json   JSON output for agents
  rig compact dev-impl@my-rig --state  Show the current compaction state

Triggers compaction on demand for ONE Claude or Pi seat, independent of the
automatic threshold. It is NOT the read-only 'rig compact-plan' triage
(Claude-only: its threshold planning assumes the Claude compaction policy).
Runtime behavior differs:

Claude seats run the SAME guided lifecycle the auto-compaction policy runs
(pre-compact prep → a short /compact (the full trust note travels in the map) → restore-from-marker → read-depth audit)
on demand, for ONE Claude seat, without waiting for the context threshold. It is
NOT a bare /compact. Managed /compact waits for the exact attempt/occupant restore
map named by preparation, published atomically with its completion marker. This
checks completion identity, not map quality. Manual preparation and idle wait share
180 seconds; expiry disarms that attempt. --state shows the map/deadline/reason,
the preparation prompt's delivery, and the /compact result: "submitted, unconfirmed"
means /compact and Enter reached the seat; OpenRig does not check that compaction
then ran. Ordinary approvals during preparation can be answered within that same deadline;
OpenRig does not answer them. Automatic /compact, like manual, is sent only to an idle seat.
--cancel disarms preparation and pending restore/audit prompts without sending input.
An already submitted /compact stays unconfirmed: cancellation cannot undo it or prove
it never ran. No restore request follows cancellation: check the pane before retrying.
If it compacted or you cannot tell, send a normal restore request naming preparation.mapPath
from --state, asking it to skip reading if it did not compact; a retry would compact it again.
An explicit retry still waits for the live pane to be idle; no automatic retry follows
cancellation. --skip-map skips only the map requirement for this one
manual request. Cancel an active preparation before retrying or using --skip-map.
Automatic preparation allows 25 minutes from prep delivery for the map. A completed
map stays armed for idle through the next retry interval (10 minutes by default),
without another preparation prompt; --state includes idleDeadlineAt. A completed
automatic map whose /compact is refused before input (a draft in the box, the pane in
a tmux mode) or that never reaches idle in that time is held instead: --state shows
prepared with preparedAt and preparedReason, and /compact goes in at the next idle
moment with an empty box, with the same map and no new preparation prompt. A held
attempt stops on a fresh sample below the threshold or from another conversation
(below_threshold_while_prepared), once usage has risen 15 points since its request
or two hours after its map was ready (prepared_map_stale), or when its map no longer
reads ready (preparation_incomplete).
After an attempt stops with its request delivered, the next automatic request for the
same conversation waits for an idle seat, across a daemon restart too, for up to the
restart-recovery window (6 hours by default) after that attempt stopped. An unfinished
map reports preparation_incomplete. Manual requests still
share one 180-second budget and stop as before; while an attempt is held, a manual
request reads already_in_progress until --cancel.
Stopped attempts may retry automatically after the cooldown; cancellation does not.
Cancellation disarms future input; it cannot undo a command already submitted. Raw provider /compact and normal messages are unchanged.
Pi seats send the reserved /openrig-compact <attempt-id> input through the same
guarded send path every other message to the seat uses: the session transport
and its delivery guard. A person's draft is respected where the seat's draft
protection reads the Pi editor; otherwise the control can join a draft, as any
message to a Pi agent can, and that attempt reads uncertain. A hold, a prompt
and the bound occupant follow the guard's usual rules, and the send uses the
transport's bounded idle wait so a working agent is waited for. The runner turns
the reserved input into Pi's native compact RPC, not prompt text. The request's
attempt id is carried into the command and the runner sidecar, so the requested run is reported separately from
an automatic one and an earlier completion never answers a new request.
A successful trigger is reported as "submitted, unconfirmed"; when input may
have been written it is reported as uncertain. --state reports the requested
attempt as completed, failed, aborted or unsupported; an attempt that may have
been submitted without a result, or that started without an end, is uncertain,
not "not started". Activity is advisory; the sidecar is authoritative.
OpenRig sends no restore or audit prompts for Pi. --skip-map is ignored for Pi;
--cancel is rejected for Pi with runtime_filter. Refusal examples (not exhaustive):
already_in_progress, unsupported, terminal_policy_refused,
terminal_policy_unavailable, held and the transport's own reasons.

Runtimes other than Claude and Pi are rejected as runtime_filter. The unsupported
detection matches the error text of omo 5.1.48 (engine senpi 2026.10.25-2), the
fork this was checked against; general Pi support is not claimed. On such a
build, the first trigger may return submitted_unconfirmed before the RPC error
is recorded; --state then reports unsupported and later triggers refuse.
`);

  const getDepsF = (): CompactDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd.action(async (session: string, opts: { json?: boolean; skipMap?: boolean; cancel?: boolean; state?: boolean }) => {
    if ([opts.skipMap, opts.cancel, opts.state].filter(Boolean).length > 1) {
      console.error("Choose only one of --skip-map, --cancel or --state."); process.exitCode = 1; return;
    }
    const deps = getDepsF();

    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonMayAnswer(status)) {
      console.error("Daemon is not running. Start it with: rig daemon start");
      process.exitCode = 1;
      return;
    }

    const client = deps.clientFactory(getDaemonUrl(status));
    const res = opts.state ? await client.get<Record<string, unknown>>(`/api/compaction/state?session=${encodeURIComponent(session)}`, { headers: terminalAuthHeaders() }) : await client.post<Record<string, unknown>>(
      opts.cancel ? "/api/compaction/cancel" : "/api/compaction/trigger",
      { session, ...(opts.skipMap ? { skipMap: true } : {}) },
      { headers: terminalAuthHeaders(), timeoutMs: MANUAL_COMPACT_REQUEST_TIMEOUT_MS },
    );

    if (opts.json) {
      console.log(JSON.stringify(res.data));
      if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
      return;
    }

    if (res.status >= 400) {
      const error = res.data["error"] as string | undefined;
      const reason = res.data["reason"] as string | undefined;
      const runtime = res.data["runtime"] as string | undefined;
      if (error) console.error(error);
      else if (reason) console.error(`Manual compaction for ${session} was not started (${runtime ? `runtime: ${runtime}, ` : ""}reason: ${reason}, HTTP ${res.status}).`);
      else console.error(`Manual compaction failed (HTTP ${res.status})`);
      process.exitCode = res.status >= 500 ? 2 : 1;
      return;
    }

    if (opts.state || opts.cancel) {
      if (opts.state && res.data["runtime"] === "pi") {
        const state = res.data["state"] as { status?: string; attemptId?: string | null; phase?: string } | undefined;
        const uncertainty = state?.status !== "uncertain" ? ""
          : state?.phase === "started_no_end" ? " (started, no end: the result is unknown)"
          : " (may have been submitted, no result yet)";
        console.log(`Pi compaction state for ${session}: ${state?.status ?? "unknown"}${uncertainty}${state?.attemptId ? ` (attempt: ${state.attemptId})` : ""}`);
        console.log("Read from the Pi runner sidecar (authoritative); activity is advisory. No restore or audit prompts are owed for Pi.");
        return;
      }
      console.log(JSON.stringify(res.data, null, 2)); return;
    }
    const stage = res.data["stage"] as string | undefined;
    const compact = res.data["compact"] as string | undefined;
    if (res.data["runtime"] === "pi") {
      const attemptId = res.data["attemptId"] as string | undefined;
      const outcome = stage === "uncertain" ? "uncertain — input may have reached the seat; no result yet"
        : compact ?? "submitted, unconfirmed";
      console.log(`Manual compaction for ${session}: ${outcome}${attemptId ? ` (attempt: ${attemptId})` : ""} (runtime: pi)`);
      // The transport's own detail when it left text in the input box without Enter.
      const detail = res.data["error"] as string | undefined;
      if (detail) console.log(detail);
      if (opts.skipMap) console.log("--skip-map is ignored for Pi; no restore-map lifecycle is used.");
      console.log(`Pi runs its native compact RPC. Read the requested run with rig compact ${session} --state; the sidecar is authoritative and activity is advisory. OpenRig sends no restore or audit prompts for Pi.`);
      return;
    }
    console.log(`Manual compaction for ${session}: ${compact ?? "submitted, unconfirmed"}${stage ? ` (stage: ${stage})` : ""}`);
    console.log("The restore + read-depth audit prompts follow automatically as the seat drains below threshold, and a daemon restart picks them up where they stopped (rig compact --state shows one too old to resume).");
  });

  return cmd;
}
