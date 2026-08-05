import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient, DaemonConnectionError, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl, fetchSelfHostId } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget, type HttpHostEntry } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure, emitRemoteHttpFailure } from "../cross-host-cli-helpers.js";
import { resolveCrossHostTarget } from "../cross-host-target.js";
import { runRemoteHttpOp } from "../remote-host-ops.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { resolveContextRef, walkSizedWarning } from "../context-resolve.js";

const WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS = 5_000;

const SENDER_FALLBACK = "<unknown sender>";

/**
 * Wrap a `rig send` body with an email-style envelope so the recipient
 * pane has both the sender's identity and a copy-pasteable reply hint.
 * Cross-host sends do NOT wrap locally: the remote rig wraps when it
 * runs the same command, and double-wrapping would nest envelopes.
 *
 * V0.3.1 slice 23 parity contract: `packages/daemon/src/lib/pane-envelope.ts`
 * exports `wrapPaneEnvelope` with BYTE-IDENTICAL output for the same
 * inputs. The two implementations live in separate packages because
 * cli + daemon don't cross-import today. Daemon-side nudges from
 * `rig queue create|handoff` use the daemon helper so queue nudges
 * render the same envelope as peer-to-peer `rig send`. If you update
 * this function, update wrapPaneEnvelope in lockstep.
 */
export function wrapSendBody(
  sender: string | undefined,
  recipient: string,
  body: string,
  selfHostId?: string | null,
): string {
  const senderLabel = sender && sender.trim().length > 0 ? sender : SENDER_FALLBACK;
  // 51-09 increment 3 (ruling cb19867f Q2 always-suffix + 2e1b737f C1 fail-open):
  // when the origin's boot-reconciled self-host id is known, the sender renders
  // as the <member>@<rig>@<selfHostId> triple ALWAYS (local included) so the
  // signature is self-describing and the reply hint is verbatim-usable. When it
  // is absent (daemon pre-reconcile / unknown sender), fall open to today's exact
  // two-part form — no new failure mode. A sender that ALREADY carries a host (a
  // --from relay passing the ORIGIN's full triple) is preserved verbatim, never
  // re-stamped with THIS host's id (which would forge the origin).
  const senderTriple =
    selfHostId && selfHostId.length > 0 && senderLabel !== SENDER_FALLBACK && senderLabel.split("@").length < 3
      ? `${senderLabel}@${selfHostId}`
      : senderLabel;
  return [
    `From: ${senderTriple}`,
    `To: ${recipient}`,
    "---",
    body,
    "---",
    `↩ Reply: rig send ${senderTriple} "..."`,
  ].join("\n");
}

function resolveSenderSession(): string | undefined {
  return readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
}

/**
 * 1b45cf21 — remediation after an ACTUAL transport failure, in the repo's
 * fact / consequence / action shape (`daemon-lifecycle.ts:61-73`).
 *
 * Deliberately NOT `daemonNotRunningError()`: that helper's text ("Daemon not
 * running." + restart advice) is the probe-derived claim qitem-c113bd41
 * removed. The SHAPE is reused; the TEXT is not.
 *
 * A `DaemonConnectionError` proves the resolved target was UNREACHABLE — not
 * why. Daemon down, wrong port, wrong host, firewall, and a wedged event loop
 * are all live explanations, so the action stays diagnostic and asserts no
 * daemon state. It also refuses to oversell `rig status`: with an env URL set,
 * that command's own probe can report `stopped` for a mere timeout
 * (`daemon-lifecycle.ts:575-585`) — the same false-stopped class this slice
 * exists to remove — so the copy names that limitation instead of hiding it,
 * and gates `rig daemon start` behind operator confirmation.
 *
 * Shared by both local paths so single-seat and fan-out remediation are
 * IDENTICAL BY CONSTRUCTION rather than by hand-maintained duplication.
 */
function printTransportFailure(err: DaemonConnectionError, opts?: { json?: boolean }): void {
  // Remediation values are defined ONCE; the human path adds its two-space
  // indentation at render so the existing three-line output stays byte-identical,
  // while the --json envelope carries the clean strings. Same
  // {error:{fact,consequence,action}} shape as printDaemonNotRunning
  // (daemon-lifecycle.ts) so an agent on the --json path gets a parseable record
  // instead of empty stdout plus human prose on stderr.
  const fact = err.message;
  const consequence = "The message was not sent.";
  const action =
    "Inspect the configured target with 'rig status'; a failed health probe does not prove the daemon is stopped. " +
    "If the target is wrong, check OPENRIG_URL / RIGGED_URL or daemon.host + daemon.port. " +
    "If the daemon is confirmed stopped, run 'rig daemon start'.";
  if (opts?.json) {
    console.log(JSON.stringify({ error: { fact, consequence, action } }));
    return;
  }
  console.error(fact);
  console.error(`  ${consequence}`);
  console.error(`  ${action}`);
}

/** qitem-c113bd41 — the LOCAL send target. The status probe is advisory,
 *  never authoritative: a busy/wedged daemon fails the probe while the
 *  transport would succeed (the false-daemon-down incident). Resolution:
 *  the configured env alias FIRST (exact string, custom port preserved;
 *  OPENRIG_URL wins over legacy RIGGED_URL), else the status/state-derived
 *  host:port when the probe found one, else the configured file/default
 *  target (arg-less DaemonClient resolution).
 *  The ACTUAL transport call decides success — its DaemonConnectionError
 *  is the honest failure surface.
 *
 *  ff13bcdf — the probe is taken LAZILY, by this resolver, because an
 *  explicit env alias already determines the target: probing first cost
 *  ~818ms (instantly-failing probe) to ~2.05s (timeout-shaped: 5x250ms
 *  bounds + 4x200ms backoff) of pure latency on the incident path, then
 *  threw the result away at the first branch. Owning the probe here also
 *  keeps the single-seat and fan-out callers from having to sequence it
 *  identically in two places. */
async function resolveLocalDaemonUrl(deps: SendDeps): Promise<string> {
  const envUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
  if (envUrl) return envUrl;
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (status.state === "running" && status.port !== undefined) return getDaemonUrl(status);
  // Configured-target resolution reused verbatim from the arg-less
  // DaemonClient (env alias > ConfigStore file > default) — never a
  // hardcoded literal, so a config-file custom daemon.host/port is honored.
  return new DaemonClient().baseUrl;
}

/**
 * OPR.0.4.3.30 — Commander collector for `--to`: accepts BOTH a comma-list
 * (`--to a,b`) and repetition (`--to a --to b`), accumulating into one array.
 * Blank entries are dropped so a trailing comma is harmless.
 */
function collectSessions(value: string, previous: string[]): string[] {
  const parts = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return previous.concat(parts);
}

export interface SendDeps extends StatusDeps {
  /**
   * Cross-host hooks. Both default to the production loaders/executors; tests
   * inject in-package mocks so no real ssh / no real ~/.ssh / no real network
   * is touched.
   */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  crossHostRun?: (
    host: Parameters<typeof runCrossHostCommand>[0],
    argv: readonly string[],
    opts?: RunCrossHostCommandOpts,
  ) => ReturnType<typeof runCrossHostCommand>;
}

export function sendCommand(depsOverride?: SendDeps): Command {
  const cmd = new Command("send").description("Send a message to an agent's terminal");
  const getDeps = (): SendDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    // OPR.0.4.3.30 — both positionals are optional so the message can stand alone with a
    // targeting flag (`rig send --pod x "text"`). Disambiguated in the action: with a
    // targeting flag the FIRST positional IS the message; without one it's `<session> <text>`.
    .argument("[session]", "Target session name for a single-seat send (e.g. dev-impl@my-rig)")
    .argument("[text]", "Message text to send")
    .option("--to <sessions>", "Multi-recipient: comma-list or repeated (--to a,b or --to a --to b)", collectSessions, [] as string[])
    .option("--pod <name>", "Send to every seat in a pod (fan-out, per-recipient results)")
    .option("--rig <name>", "Send to every seat in a rig (fan-out, per-recipient results)")
    .option("--verify", "Verify pane only delivery by checking content after send")
    .option("--force", "Back-compat no-op: a mid-task/busy pane already sends-with-advisory by default; --force never bypasses the interactive-prompt/permission guard")
    .option("--wait-for-idle <seconds>", "Wait until the target is explicitly idle before sending")
    .option("--raw", "Send exact text/keystrokes without the From/To messaging envelope (still guarded against interactive prompts)")
    .option("--dangerously-interact", "DANGEROUS: deliberately drive an interactive prompt/permission block (implies --raw; requires --reason). The ONLY override of the prompt/permission guard.")
    .option("--reason <text>", "Why the prompt is being driven (required with --dangerously-interact; recorded in the audit log)")
    .option("--host <id>", "Send on a remote host declared in ~/.openrig/hosts.yaml (ssh hosts shell out; http hosts go CLI-direct to the remote daemon)")
    .option("--from <session>", "Originating session for the envelope sender/actor (provenance; defaults to $OPENRIG_SESSION_NAME). Plumbed through cross-host ssh sends so the remote envelope names the origin, not the relay.")
    .option("--context <ref>", "Deliver a context pack by its path-like ref (e.g. packs/compaction-restore). The resolved content is sent; an oversized ref is flagged as 'walk-sized'.")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig send dev-impl@my-rig "Context update: QA approved. Proceed."
  rig send dev-impl@my-rig "message" --verify
  rig send --to dev-impl@my-rig,dev-qa@my-rig "message to two seats"
  rig send --pod dev "message to the whole dev pod"
  rig send --rig my-rig "message to the whole rig"
  rig send dev-impl@my-rig "safe proof prompt" --wait-for-idle 30 --verify
  rig send dev-impl@my-rig "Stop and read the spec." --force
  rig send dev-impl@my-rig "message" --json
  rig send --host vm-claude-test dev-impl@my-rig "remote message" --verify
  rig send dev-impl@my-rig@vps-b "host-qualified target sugar (suffix must be a registered host id)"

Targeting: a bare seat (single send), OR one of --to / --pod / --rig (fan-out).
Fan-out reports per-recipient results + an "N/M delivered" summary; one recipient's
guard refusal does NOT block the others. Each recipient gets its own From/To envelope.

The two-step send pattern (paste text, wait, submit Enter) is handled
automatically. By default a send is REFUSED only on POSITIVE evidence the target
is at an interactive prompt or permission block (so a message can never
select/approve another agent's prompt). When the target's activity CANNOT be
determined (unknown / missing / stale telemetry) the send PROCEEDS with an
advisory note — telemetry is advisory, not authority over whether agents can
communicate. Use --wait-for-idle to send only after explicit idle evidence. Use
--verify to confirm the message appeared in the pane only; it is not agent
acknowledgement.

A mid-task/busy target now sends-with-advisory by default (busy is not a block);
--force is a back-compat no-op and never bypasses the interactive-prompt/permission
guard. Use --raw to send exact text/keystrokes
without the From/To envelope (e.g. a slash command); it is still guarded. Use
--dangerously-interact --reason "<why>" to DELIBERATELY drive a prompt (select an
option, approve a permission, send /compact to a blocked pane) — the only override
of the prompt guard; it implies --raw and is audit-logged.

--host sends on a remote host declared in ~/.openrig/hosts.yaml. The host
entry's transport decides the path: ssh hosts run the same command via
single-hop ssh (SSH success is NOT verify success: the remote rig's
'Verified: yes/no' line is what counts and is surfaced verbatim); http hosts
(e.g. pair-registered) go CLI-direct to the remote daemon's send route — the
result and verify verdict are the REMOTE's, verbatim. A target of the form
agent@rig@host is sugar for --host when the suffix is a REGISTERED host id
(explicit --host > target sugar > persisted selection; a conflict between
--host and the sugar is an error).`)
    .action(async (session: string | undefined, text: string | undefined, opts: { to?: string[]; pod?: string; rig?: string; verify?: boolean; force?: boolean; waitForIdle?: string; raw?: boolean; dangerouslyInteract?: boolean; reason?: string; host?: string; from?: string; context?: string; json?: boolean }) => {
      // OPR.0.4.6.MH1 FR-2: selected-host routing — explicit --host wins;
      // else the persisted selection feeds the SHIPPED --host path; no
      // selection = today exactly. OPR.0.4.6.MH4 §4: the raw flag is kept
      // so the single-seat target sugar can slot BETWEEN explicit and
      // selection (explicit > sugar > selection).
      const explicitHost = opts.host;
      opts.host = resolveEffectiveHost(opts.host);
      const waitForIdleMs = parseWaitForIdleMs(opts.waitForIdle);
      if (opts.force && waitForIdleMs !== undefined) {
        console.error("--wait-for-idle cannot be combined with --force");
        process.exitCode = 1;
        return;
      }
      if (waitForIdleMs === null) {
        console.error("--wait-for-idle must be a positive number of seconds");
        process.exitCode = 1;
        return;
      }
      // OPR.0.4.1.10 — the danger override requires a reason (for the audit) and cannot compose with
      // wait mode. Reject locally before contacting the daemon.
      if (opts.dangerouslyInteract && (!opts.reason || opts.reason.trim().length === 0)) {
        console.error("--dangerously-interact requires --reason \"<why>\" (recorded in the audit log)");
        process.exitCode = 1;
        return;
      }
      if (opts.dangerouslyInteract && waitForIdleMs !== undefined) {
        console.error("--dangerously-interact cannot be combined with --wait-for-idle");
        process.exitCode = 1;
        return;
      }

      // OPR.0.4.3.30 — targeting-mode resolution. Exactly one of: a bare seat, --to, --pod, --rig.
      const toList = opts.to && opts.to.length > 0 ? opts.to : undefined;
      const fanModes = [toList ? "to" : null, opts.pod ? "pod" : null, opts.rig ? "rig" : null].filter(Boolean);
      if (fanModes.length > 1) {
        console.error("Choose exactly ONE target: a seat, --to, --pod, or --rig (not several).");
        process.exitCode = 1;
        return;
      }
      const isFanOut = fanModes.length === 1;

      // Slice-03 Atom 6b: --context is single-seat LOCAL in v1 (fan-out and
      // cross-host --context are follow-ons). Reject loudly rather than silently
      // dropping the requested context.
      if (opts.context && (isFanOut || opts.host)) {
        console.error("--context is supported on a single-seat LOCAL send in v1 (not with --to/--pod/--rig or --host).");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();

      if (isFanOut) {
        // With a targeting flag the FIRST positional IS the message; a second positional (or a
        // bare seat name) means the caller mixed a single-seat and a fan-out target — reject.
        if (text !== undefined) {
          console.error("A bare seat name cannot be combined with --to/--pod/--rig. Provide only the message.");
          process.exitCode = 1;
          return;
        }
        const message = session;
        if (message === undefined || message.length === 0) {
          console.error("Provide a message to send.");
          process.exitCode = 1;
          return;
        }
        if (opts.host) {
          console.error("--host (cross-host) supports single-seat sends only; --to/--pod/--rig are local.");
          process.exitCode = 1;
          return;
        }
        if (waitForIdleMs !== undefined) {
          console.error("--wait-for-idle is not supported with a multi/pod/rig target (cumulative wait risks a client timeout). Send single-seat, or drop --wait-for-idle.");
          process.exitCode = 1;
          return;
        }
        await runFanOutSend({ toList, pod: opts.pod, rig: opts.rig, message, opts, deps });
        return;
      }

      // --- Single-seat path (byte-identical to pre-0.4.3.30) ---
      // Atom 6b: --context supplies the payload, so <text> is optional with it.
      if (session === undefined || (text === undefined && !opts.context)) {
        console.error("Usage: rig send <session> <text>  (or rig send <session> --context <ref>, or --to/--pod/--rig <message> for fan-out)");
        process.exitCode = 1;
        return;
      }

      // 51-09 increment 3: resolve the local daemon URL ONCE (reused for the
      // client below) and best-effort read THIS host's boot-reconciled self-id
      // from it — ONE identity source + one addressing resolution (rider b), the
      // same /healthz field the daemon exposes. Fail-open to undefined (C1): the
      // sugar self-strip and the From: triple both degrade to today's exact
      // behavior when it is absent (daemon down / pre-reconcile).
      const localDaemonUrl = await resolveLocalDaemonUrl(deps);
      const selfHostId = await fetchSelfHostId(deps.lifecycleDeps, localDaemonUrl);

      // OPR.0.4.6.MH4 §4 — the `agent@rig@host` target sugar (single-seat
      // only; the fan-out positional is message text). Suffix must match a
      // REGISTERED host id, else the target passes through unchanged and
      // the hint rides any later failure. Precedence: explicit --host >
      // sugar > persisted selection (already folded into opts.host above).
      // 51-09 incr 3: a suffix == this host's self-id strips-and-routes-home.
      const targetResolution = resolveCrossHostTarget(session, explicitHost, deps.hostRegistryLoader, selfHostId);
      if (!targetResolution.ok) {
        console.error(targetResolution.error);
        process.exitCode = 1;
        return;
      }
      session = targetResolution.target;
      const crossHostHint = targetResolution.hint;
      opts.host = explicitHost ?? targetResolution.sugarHost ?? opts.host;

      // Atom 6b QA fix (root cause): re-reject --context on the cross-host path
      // AFTER the agent@rig@host sugar host folds into opts.host. The early guard
      // runs before resolveCrossHostTarget, so it cannot see the sugar host — the
      // hole that let a sugar-form --context reach the remote argv (shipping a
      // literal null with no message, or silently dropping the context with one).
      // --context is single-seat LOCAL in v1; it is never handed to a remote send.
      if (opts.context && opts.host) {
        console.error("--context is supported on a LOCAL send in v1 (not with --host or an agent@rig@host cross-host target).");
        process.exitCode = 1;
        return;
      }

      // --- Cross-host short-circuit (CLI-side; ssh shell-out or the MH-4 http branch; daemon untouched) ---
      if (opts.host) {
        // text is validated-defined here: --context is rejected with --host (above,
        // for both explicit and sugar forms), and the single-seat (no text && no
        // context) guard requires it on this path.
        await runCrossHostSend(opts.host, session, text!, opts, deps, waitForIdleMs, crossHostHint, selfHostId);
        return;
      }

      // qitem-c113bd41 — the status probe is ADVISORY (target discovery
      // only); the actual transport is authoritative. A probe-timeout or
      // running/unhealthy verdict no longer refuses the send. ff13bcdf —
      // the resolver takes that probe lazily, and skips it entirely when an
      // explicit env alias already names the target.
      const client = deps.clientFactory(localDaemonUrl);
      const senderSession = opts.from ?? resolveSenderSession();
      // --raw (and --dangerously-interact, which implies it) send EXACT text with no messaging envelope.
      const raw = Boolean(opts.raw || opts.dangerouslyInteract);

      // Atom 6b: --context resolves a pack ref to its whole content (all-or-nothing
      // — a missing member aborts before any send) and delivers it. A message +
      // --context sends the message then the context, blank-line separated. An
      // oversized context surfaces the §4 walk-sized advisory.
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
        const warn = walkSizedWarning(resolved, session);
        if (warn && !opts.json) console.log(`Advisory: ${warn}`);
      }
      const outboundText = raw ? payload : wrapSendBody(senderSession, session, payload, selfHostId);
      let res: { status: number; data: Record<string, unknown> };
      try {
        res = await client.post<Record<string, unknown>>("/api/transport/send", {
          session, text: outboundText, verify: opts.verify, force: opts.force, waitForIdleMs,
          dangerouslyInteract: opts.dangerouslyInteract, reason: opts.reason, actorSession: senderSession ?? null,
        }, transportRequestOptions(waitForIdleMs));
      } catch (err) {
        if (err instanceof DaemonConnectionError) {
          // The REAL transport outcome, honestly surfaced (names the
          // configured target + the underlying error) — never the bare
          // probe-derived restart line. 1b45cf21 adds the actionable next
          // step after that real failure.
          printTransportFailure(err, { json: opts.json });
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      if (res.status >= 400) {
        const error = res.data["error"] as string | undefined;
        console.error(error ?? `Send failed (HTTP ${res.status})`);
        // MH-4 §4 loud-failure hint: the target was 3-part-shaped but its
        // suffix matched no registered host — name the near-miss.
        if (crossHostHint) console.error(`hint: ${crossHostHint}`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      console.log(`Sent to ${session}`);
      // OPR.0.4.3.28 correction — an `unknown`-telemetry send now PROCEEDS with a non-blocking
      // advisory (was a fail-closed refusal). Surface it on the human output, not only in --json.
      const advisory = res.data["warning"] as string | undefined;
      if (advisory) {
        console.log(`Advisory: ${advisory}`);
      }
      if (opts.verify) {
        // Legacy line preserved verbatim (existing scripts grep `Verified:`);
        // the Delivery line below carries the honest three-outcome vocabulary
        // (OPR.99.0.6.3): `Verified: no` alone collapsed a landed-but-redraw-
        // raced send into the same line as a miss.
        const verified = res.data["verified"] as boolean | undefined;
        console.log(`Verified: ${verified ? "yes" : "no"}`);
        const outcome = res.data["outcome"] as string | undefined;
        if (outcome === "delivered") {
          console.log("Delivery: delivered (message landed; render confirmed)");
        } else if (outcome === "rendered-unconfirmed") {
          console.log(`Delivery: rendered-unconfirmed (landed; pane re-render not confirmed - confirm with: rig capture ${session})`);
        }
      }
    });

  return cmd;
}

async function runCrossHostSend(
  hostId: string,
  session: string,
  text: string,
  opts: { verify?: boolean; force?: boolean; waitForIdle?: string; raw?: boolean; dangerouslyInteract?: boolean; reason?: string; from?: string; json?: boolean },
  deps: SendDeps,
  waitForIdleMs?: number,
  hint?: string,
  selfHostId?: string,
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const runner = deps.crossHostRun ?? runCrossHostCommand;

  const registry = loader();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error, opts.json);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", hint ? `${resolved.error} (${hint})` : resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

  // OPR.0.4.6.MH4 — the http transport branch: an http-registered host (the
  // founder's `pair` front door) takes the CLI-direct path to the remote
  // daemon's shipped /api/transport/send. The ssh path below stays
  // byte-verbatim for ssh hosts (transport is dictated by the host entry —
  // ssh XOR http, never a fallback).
  if (host.transport === "http") {
    await runHttpHostSend(host, session, text, opts, deps, waitForIdleMs, hint, selfHostId);
    return;
  }

  // Reconstruct argv for the remote `rig send` invocation. Order is positional
  // first so the remote Commander parses it the same way local does.
  const argv: string[] = ["rig", "send", session, text];
  if (opts.verify) argv.push("--verify");
  if (opts.force) argv.push("--force");
  if (opts.waitForIdle !== undefined) argv.push("--wait-for-idle", opts.waitForIdle);
  if (opts.raw) argv.push("--raw");
  if (opts.dangerouslyInteract) argv.push("--dangerously-interact");
  if (opts.reason !== undefined) argv.push("--reason", opts.reason);
  // Sender provenance: the ssh relay re-runs `rig send` on the remote, which
  // would otherwise resolve ITS OWN session and degrade the envelope sender
  // to "unknown". Carry the origin (explicit --from, else $OPENRIG_SESSION_NAME)
  // so the remote envelope names the originating session. Plumbing, not a gate.
  const originSender = opts.from ?? resolveSenderSession();
  // 51-09 increment 3: carry the ORIGIN's full <member>@<rig>@<selfHostId> triple
  // so the remote envelope names the ORIGIN host, not the relay's. Append this
  // host's self-id only when the origin isn't already a triple (a --from already
  // carrying an origin triple is preserved verbatim — never re-stamped).
  const originTriple =
    originSender && selfHostId && originSender.split("@").length < 3
      ? `${originSender}@${selfHostId}`
      : originSender;
  if (originTriple) argv.push("--from", originTriple);
  if (opts.json) argv.push("--json");

  const result = await runner(host, argv);

  if (opts.json) {
    console.log(JSON.stringify({
      cross_host: { host: host.id, target: hostDisplayTarget(host) },
      result,
    }));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log(`[via host=${host.id} (${hostDisplayTarget(host)})]`);
  if (result.ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }
  emitCrossHostFailure(host.id, hostDisplayTarget(host), result, opts.json);
}

/**
 * OPR.0.4.6.MH4 C1 — cross-host send over http, CLI-DIRECT to the remote
 * daemon's shipped POST /api/transport/send (zero daemon-side changes).
 * Wrap parity BY CONSTRUCTION: the body is built exactly as the LOCAL path
 * builds it (same wrapSendBody call, same fields), so the remote daemon
 * receives what its own local CLI would post. `actorSession` is the local
 * sender verbatim — honest provenance; unknown on the remote it degrades to
 * the shipped non-blocking advisory, never a refusal. `--verify` prints the
 * REMOTE route's verified/outcome verbatim (remote-authoritative, never
 * locally synthesized). Deadline: the read-class client default, or
 * waitForIdleMs + overhead when --wait-for-idle (the local path's math).
 *
 * Auth posture (named, v0): runRemoteHttpOp presents the REGISTRY bearer
 * WHEN ONE IS CONFIGURED; for a URL-only anonymous host the Authorization
 * header is omitted entirely (optional-bearer, a0c17305).
 * /api/transport/* is gated by the remote's TERMINAL bearer class. Default
 * (null) + tailnet binds = pass-through by design; a remote enforcing a
 * DIFFERENT terminal bearer surfaces as the structured permission-gate step
 * (never a hang, never silent). Remedy documented in cli-reference.md.
 */
async function runHttpHostSend(
  host: HttpHostEntry,
  session: string,
  text: string,
  opts: { verify?: boolean; force?: boolean; waitForIdle?: string; raw?: boolean; dangerouslyInteract?: boolean; reason?: string; from?: string; json?: boolean },
  deps: SendDeps,
  waitForIdleMs?: number,
  hint?: string,
  selfHostId?: string,
): Promise<void> {
  const senderSession = opts.from ?? resolveSenderSession();
  const raw = Boolean(opts.raw || opts.dangerouslyInteract);
  const outboundText = raw ? text : wrapSendBody(senderSession, session, text, selfHostId);

  const result = await runRemoteHttpOp(host.id, "POST", "/api/transport/send", {
    session, text: outboundText, verify: opts.verify, force: opts.force, waitForIdleMs,
    dangerouslyInteract: opts.dangerouslyInteract, reason: opts.reason, actorSession: senderSession ?? null,
  }, deps, waitForIdleMs !== undefined ? { timeoutMs: waitForIdleMs + WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS } : {});

  if (opts.json) {
    console.log(JSON.stringify({
      cross_host: { host: host.id, target: hostDisplayTarget(host), transport: "http" },
      result,
      ...(!result.ok && hint ? { hint } : {}),
    }));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    emitRemoteHttpFailure(host.id, hostDisplayTarget(host), result, false, hint);
    return;
  }

  console.log(`[via host=${host.id} (${hostDisplayTarget(host)})]`);
  const data = (result.data ?? {}) as Record<string, unknown>;
  console.log(`Sent to ${session}`);
  const advisory = data["warning"] as string | undefined;
  if (advisory) {
    console.log(`Advisory: ${advisory}`);
  }
  if (opts.verify) {
    // The REMOTE route's verdict, verbatim — mirrors the local render so
    // scripts grepping `Verified:` behave identically across hosts.
    const verified = data["verified"] as boolean | undefined;
    console.log(`Verified: ${verified ? "yes" : "no"}`);
    const outcome = data["outcome"] as string | undefined;
    if (outcome === "delivered") {
      console.log("Delivery: delivered (message landed; render confirmed)");
    } else if (outcome === "rendered-unconfirmed") {
      console.log(`Delivery: rendered-unconfirmed (landed; pane re-render not confirmed - confirm with: rig capture ${session})`);
    }
  }
}

// OPR.0.4.3.30 — fan-out send (`--to` / `--pod` / `--rig`). Reuses the DAEMON's broadcast
// machinery (resolve → per-seat send loop → per-recipient results) via /api/transport/broadcast.
// The message is sent BARE; the daemon wraps each recipient in its OWN From/To envelope
// (envelopeSender), so every seat gets `To: <that seat>` — byte-identical to a single send.
// --raw / --dangerously-interact send exact text with NO envelope (envelopeSender omitted).
// Each recipient is guarded INDEPENDENTLY server-side; one refusal never aborts the set.
async function runFanOutSend(params: {
  toList: string[] | undefined;
  pod: string | undefined;
  rig: string | undefined;
  message: string;
  // ba41fea2 — `from` was omitted here while the caller already forwarded it
  // at runtime, so an explicit --from was silently dropped on fan-out only
  // (single-seat + both cross-host paths always honored it).
  opts: { verify?: boolean; force?: boolean; raw?: boolean; dangerouslyInteract?: boolean; reason?: string; from?: string; json?: boolean };
  deps: SendDeps;
}): Promise<void> {
  const { toList, pod, rig, message, opts, deps } = params;

  // qitem-c113bd41 — same advisory-probe/transport-authoritative contract
  // as the single-seat path, including ff13bcdf's lazy probe (see
  // resolveLocalDaemonUrl).
  const client = deps.clientFactory(await resolveLocalDaemonUrl(deps));
  // ba41fea2 — explicit provenance wins, ambient identity is the fallback:
  // identical to the single-seat and cross-host paths. Feeds BOTH
  // actorSession (audit attribution) and envelopeSender (what each
  // recipient sees), so one resolution corrects both surfaces.
  const senderSession = opts.from ?? resolveSenderSession();
  const raw = Boolean(opts.raw || opts.dangerouslyInteract);

  const body: Record<string, unknown> = {
    text: message,
    verify: opts.verify,
    force: opts.force,
    dangerouslyInteract: opts.dangerouslyInteract,
    reason: opts.reason,
    actorSession: senderSession ?? null,
  };
  if (toList) body.sessions = toList;
  else if (pod) body.pod = pod;
  else if (rig) body.rig = rig;
  // Per-recipient envelope daemon-side unless raw/danger. Always pass a truthy sender (falling
  // back to the same "<unknown sender>" marker single-send uses) so the wrap fires for parity.
  if (!raw) {
    body.envelopeSender = senderSession && senderSession.trim().length > 0 ? senderSession : SENDER_FALLBACK;
  }

  let res: { status: number; data: Record<string, unknown> };
  try {
    res = await client.post<Record<string, unknown>>("/api/transport/broadcast", body, transportRequestOptions());
  } catch (err) {
    if (err instanceof DaemonConnectionError) {
      // 1b45cf21 — same helper as single-seat, so the remediation is
      // byte-identical across both local paths by construction (including the
      // --json envelope, threaded identically).
      printTransportFailure(err, { json: opts.json });
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (opts.json) {
    console.log(JSON.stringify(res.data));
    const results = (res.data["results"] as Array<{ ok: boolean }> | undefined) ?? [];
    if (res.status >= 400 || results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }

  if (res.status >= 400) {
    const error = res.data["error"] as string | undefined;
    console.error(error ?? `Send failed (HTTP ${res.status})`);
    process.exitCode = res.status >= 500 ? 2 : 1;
    return;
  }

  const data = res.data;
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

function parseWaitForIdleMs(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds * 1000);
}

function waitForIdleRequestOptions(waitForIdleMs: number | undefined): { timeoutMs: number } | undefined {
  if (waitForIdleMs === undefined) return undefined;
  return { timeoutMs: waitForIdleMs + WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS };
}

function transportRequestOptions(waitForIdleMs?: number): { timeoutMs?: number; headers?: Record<string, string> } | undefined {
  const waitOptions = waitForIdleRequestOptions(waitForIdleMs);
  const headers = terminalAuthHeaders();
  const hasHeaders = Object.keys(headers).length > 0;
  if (!waitOptions && !hasHeaders) return undefined;
  return {
    ...(waitOptions ?? {}),
    ...(hasHeaders ? { headers } : {}),
  };
}
