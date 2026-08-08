import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget } from "../host-registry.js";
import { emitCrossHostError, emitRemoteHttpFailure } from "../cross-host-cli-helpers.js";
import { runRemoteHttpOp } from "../remote-host-ops.js";
import { resolveContextRef, walkSizedWarning } from "../context-resolve.js";
import { requireAttributableSender } from "../sender-identity.js";

/**
 * OPR.0.4.6.MH4 C3 — the cross-host broadcast deadline, named at the call
 * site (arch delivery-lane note (a)): the remote route responds only after
 * the ORIGIN daemon's per-target fan-out loop completes, so a many-seat rig
 * needs more than the 5s read-class default.
 */
const BROADCAST_REMOTE_TIMEOUT_MS = 30_000;

export interface BroadcastDeps extends StatusDeps {
  /** Test seam: inject a registry loader so no real ~/.openrig is touched. */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
}

export function broadcastCommand(depsOverride?: BroadcastDeps): Command {
  const cmd = new Command("broadcast").description("Send a message to multiple agent sessions");
  const getDeps = (): BroadcastDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("[text]", "Message text to broadcast (optional with --context)")
    .option("--rig <name>", "Broadcast to all sessions in a rig")
    .option("--pod <name>", "Broadcast to all sessions in a pod")
    .option("--force", "Send even if targets appear mid-task")
    .option("--host <id>", "Broadcast on a remote host declared in ~/.openrig/hosts.yaml (http hosts only — CLI-direct to the remote daemon's fan-out)")
    .option("--context <ref>", "Broadcast a context pack by its path-like ref (e.g. packs/fleet-update). Resolved content is fanned out; an oversized ref is flagged 'walk-sized'.")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig broadcast --rig my-rig "Checkpoint review complete. Resume work."
  rig broadcast --pod dev "New task spec at docs/planning/next-task.md"
  rig broadcast "System maintenance in 5 minutes."
  rig broadcast --rig my-rig "message" --json
  rig broadcast --host vps-b --rig remote-rig "coordinate the remote factory"

Without --rig or --pod, broadcasts to ALL running tmux sessions plus any attached external_cli nodes across all rigs.
Unsupported external_cli targets are returned as explicit per-target failures in the result.

--host broadcasts on a remote host declared in ~/.openrig/hosts.yaml,
CLI-direct against that daemon's shipped broadcast fan-out (http-registered
hosts, e.g. pair-registered; an ssh-registered host fails with the structured
transport-requirement error). The REMOTE daemon resolves --rig/--pod on ITS
topology and its per-target results print verbatim — a partial fan-out exits
non-zero exactly as a local one does. The positional is message text (never
parsed as a target), so broadcast takes --host or the persisted host
selection, not the agent@rig@host sugar.`)
    .action(async (text: string | undefined, opts: { rig?: string; pod?: string; force?: boolean; host?: string; context?: string; json?: boolean }) => {
      // OPR.0.4.6.MH4 C3 — explicit --host > persisted selection. Broadcast
      // has NO session-target operand (the positional is message text, which
      // must never be sugar-parsed), so the §4 sugar does not apply here.
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDeps();

      // Atom 6b: --context is a LOCAL broadcast in v1 (cross-host --context is a
      // follow-on); the message is optional when --context supplies the payload.
      if (opts.context && opts.host) {
        console.error("--context is supported on a LOCAL broadcast in v1 (not with --host).");
        process.exitCode = 1;
        return;
      }
      if ((text === undefined || text.length === 0) && !opts.context) {
        console.error("Provide a message to broadcast (or --context <ref>).");
        process.exitCode = 1;
        return;
      }

      // A1 REFUSE-LOUD (identity/audit family) — the seat boundary. A broadcast is attributable-only: if
      // the seat identity is unresolvable, REFUSE here before either dispatch path (cross-host or local) —
      // nothing on the wire. Replaces the prior session-less `<unknown sender>` fall-open marker (which
      // relied on the daemon's downstream 401): the CLI now refuses at the boundary, so no unattributable
      // broadcast is ever dispatched. Mirrors `rig send`'s guard and the daemon 401 unattributable_sender.
      const seatSender = requireAttributableSender();
      if (seatSender === null) return;

      // --- Cross-host path (CLI-direct POST to the remote daemon's shipped
      // /api/transport/broadcast; its own fan-out engine resolves the
      // TargetSpec on ITS topology; daemon untouched). ---
      if (opts.host) {
        // text is validated-defined here: --context is rejected with --host, and
        // the (no text && no context) guard above requires it on the host path.
        await runCrossHostBroadcast(opts.host, text!, opts, deps, seatSender);
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      // Atom 6b: --context resolves a pack ref to its whole content (all-or-nothing
      // — a missing member aborts before any fan-out) and delivers it. A message +
      // --context fans out the message then the context, blank-line separated.
      let payload = text ?? "";
      if (opts.context) {
        let resolved;
        try {
          resolved = await resolveContextRef(client, opts.context);
        } catch (err) {
          console.error((err as Error).message);
          process.exitCode = 1;
          return;
        }
        payload = text && text.length > 0 ? `${text}\n\n${resolved.text}` : resolved.text;
        const warn = walkSizedWarning(resolved);
        if (warn && !opts.json) console.log(`Advisory: ${warn}`);
      }
      const body: Record<string, unknown> = { text: payload, force: opts.force };
      if (opts.rig) body.rig = opts.rig;
      if (opts.pod) body.pod = opts.pod;
      // Send/broadcast header (ruling 03c35295): identify the broadcasting seat so the daemon fan-out
      // WRAPS each recipient with the scale header ("broadcast to <rig> (N seats)" / topology) instead
      // of delivering raw — a recipient tells it was a broadcast header-alone (the anti-storm teeth).
      // A1: `seatSender` is the RESOLVED broadcasting seat (the seat-boundary guard refused an
      // unattributable broadcast), so the marker is always the real sender — never a session-less
      // fall-open literal. Its VALUE is ignored daemon-side (the fan-out derives From: from the transport
      // header); its PRESENCE is the anti-storm signal to WRAP each recipient with the scale header.
      body.envelopeSender = seatSender;

      const res = await client.post<Record<string, unknown>>("/api/transport/broadcast", body);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        const results = ((res.data as Record<string, unknown>)["results"] as Array<{ ok: boolean }> | undefined) ?? [];
        if (res.status >= 400 || results.some((r) => !r.ok)) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `Broadcast failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      renderBroadcastResults(res.data as Record<string, unknown>);
    });

  return cmd;
}

/**
 * OPR.0.4.6.MH4 C3 — cross-host broadcast over http, CLI-DIRECT to the
 * remote daemon's shipped POST /api/transport/broadcast (zero daemon-side
 * changes). The body is the LOCAL shape verbatim ({text, force, rig?,
 * pod?}); the ORIGIN daemon's own fan-out engine resolves the TargetSpec on
 * ITS topology and returns per-target results, printed VERBATIM — per-target
 * honesty is passthrough, never summarized; a partial fan-out exits non-zero
 * exactly as the local path does. Deadline: BROADCAST_REMOTE_TIMEOUT_MS
 * (named — a full fan-out outlives the read-class default).
 */
async function runCrossHostBroadcast(
  hostId: string,
  text: string,
  opts: { rig?: string; pod?: string; force?: boolean; json?: boolean },
  deps: BroadcastDeps,
  seatSender: string = "",
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error, opts.json);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

  const body: Record<string, unknown> = { text, force: opts.force };
  if (opts.rig) body.rig = opts.rig;
  if (opts.pod) body.pod = opts.pod;
  // P21 cross-host broadcast fix + A1: ADD the enveloped-fan-out marker (a rebuild once dropped it, so the
  // remote rendered RAW while the local path wrapped). `seatSender` is the RESOLVED origin seat (the
  // seat-boundary guard refused otherwise). The DaemonClient auto-stamps X-OpenRig-Session=origin env on
  // this POST (client.ts:171, P18 chokepoint), so the remote derives From: from the transport; the marker
  // VALUE is ignored. No extra-headers stamp (that would be a second origin of an already-stamped header).
  body.envelopeSender = seatSender;

  const result = await runRemoteHttpOp(hostId, "POST", "/api/transport/broadcast", body, deps, {
    timeoutMs: BROADCAST_REMOTE_TIMEOUT_MS,
  });

  if (opts.json) {
    console.log(JSON.stringify({
      cross_host: { host: host.id, target: hostDisplayTarget(host), transport: "http" },
      result,
    }));
    const results = ((result.data as Record<string, unknown> | undefined)?.["results"] as Array<{ ok: boolean }> | undefined) ?? [];
    if (!result.ok || results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    emitRemoteHttpFailure(host.id, hostDisplayTarget(host), result, false);
    return;
  }

  console.log(`[via host=${host.id} (${hostDisplayTarget(host)})]`);
  renderBroadcastResults((result.data ?? {}) as Record<string, unknown>);
}

/** One renderer, two callers — the remote route returns the same shape the
 *  local route does, so per-target honesty prints identically. A partial
 *  fan-out sets a non-zero exit either way. */
function renderBroadcastResults(data: Record<string, unknown>): void {
  const results = (data["results"] as Array<{ sessionName: string; ok: boolean; error?: string }>) ?? [];
  for (const r of results) {
    if (r.ok) {
      console.log(`${r.sessionName}: sent`);
    } else {
      console.log(`${r.sessionName}: FAILED — ${r.error ?? "unknown error"}`);
    }
  }
  console.log(`${data["sent"]}/${data["total"]} delivered`);

  if ((data["failed"] as number) > 0 || results.some((r) => !r.ok)) {
    process.exitCode = 1;
  }
}
