import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget, type HttpHostEntry } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure, emitRemoteHttpFailure } from "../cross-host-cli-helpers.js";
import { resolveCrossHostTarget } from "../cross-host-target.js";
import { runRemoteHttpOp } from "../remote-host-ops.js";

export interface CaptureDeps extends StatusDeps {
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  crossHostRun?: (
    host: Parameters<typeof runCrossHostCommand>[0],
    argv: readonly string[],
    opts?: RunCrossHostCommandOpts,
  ) => ReturnType<typeof runCrossHostCommand>;
}

interface CaptureOpts {
  rig?: string;
  pod?: string;
  lines?: string;
  host?: string;
  json?: boolean;
  historyPlusPane?: boolean;
  /** --lines was given on the command line (not the "20" default). */
  linesGiven?: boolean;
  /** Set when --lines N was given (and --history-plus-pane wasn't): the output is cut to the last N lines. */
  exactLines?: number;
}

/**
 * tmux `capture-pane -S -N` returns N history lines plus the whole visible pane, so `--lines 5` on a 21-row pane
 * printed 26 lines. An explicit --lines N is cut to the last N here, in the CLI: the daemon route, the adapter and
 * their other callers (delivery checks, activity, resume) are unchanged, and so is a capture without --lines.
 * A non-numeric or non-positive --lines keeps today's output.
 */
function exactLineCount(opts: CaptureOpts, linesFromCli: boolean): number | undefined {
  if (!linesFromCli || opts.historyPlusPane || !/^\d+$/.test(opts.lines ?? "")) return undefined;
  const n = parseInt(opts.lines!, 10);
  return n > 0 ? n : undefined;
}

/**
 * The last `n` lines of a capture. The blank rows of the visible pane below its content are dropped first: on a
 * short shell pane the bottom rows are empty, and the last N rows would otherwise be all blank.
 */
export function lastLines(content: string, n: number): { content: string; lines: number; omittedLines: number } {
  const rows = content.split("\n");
  if (rows[rows.length - 1] === "") rows.pop(); // the final newline, not a line
  while (rows.length > 0 && rows[rows.length - 1]!.trim() === "") rows.pop();
  const kept = rows.slice(Math.max(0, rows.length - n));
  return { content: kept.length > 0 ? kept.join("\n") + "\n" : "", lines: kept.length, omittedLines: rows.length - kept.length };
}

/** Cut each successful capture in a route payload to its last `n` lines; `lines` becomes the count returned. */
function withExactLines<T>(data: T, n: number | undefined): T {
  if (n === undefined || data === null || typeof data !== "object") return data;
  const cut = (r: Record<string, unknown>): Record<string, unknown> =>
    r["ok"] === true ? { ...r, ...lastLines(typeof r["content"] === "string" ? r["content"] : "", n), requestedLines: n } : r;
  const payload = data as Record<string, unknown>;
  if (Array.isArray(payload["results"])) {
    return { ...payload, results: (payload["results"] as Array<Record<string, unknown>>).map(cut) } as T;
  }
  return cut(payload) as T;
}

/** Print a capture payload (single or multi-target). The omitted-lines note goes to stderr, apart from pane text. */
function renderCapture(data: Record<string, unknown>): void {
  const note = (r: Record<string, unknown>): void => {
    const omitted = r["omittedLines"];
    if (typeof omitted === "number" && omitted > 0) {
      console.error(`[rig capture: ${r["sessionName"]}: ${omitted} earlier line${omitted === 1 ? "" : "s"} not shown; last ${r["lines"]} shown]`);
    }
  };

  // Multi-target result
  const results = data["results"] as Array<{ sessionName: string; content?: string; ok: boolean; error?: string }> | undefined;
  if (results) {
    for (const r of results) {
      console.log(`--- ${r.sessionName} ---`);
      if (r.ok) {
        note(r as unknown as Record<string, unknown>);
        console.log(r.content ?? "");
      } else {
        console.log(`  (error: ${r.error ?? "no content"})`);
      }
    }
    return;
  }

  // Single target result
  note(data);
  const content = data["content"] as string | undefined;
  if (content) {
    console.log(content);
  }
}

export function captureCommand(depsOverride?: CaptureDeps): Command {
  const cmd = new Command("capture").description("Capture terminal output from agent sessions");
  const getDeps = (): CaptureDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("[session]", "Session name (omit for multi-target with --rig/--pod)")
    .option("--rig <name>", "Capture all sessions in a rig")
    .option("--pod <name>", "Capture all sessions in a pod")
    .option("--lines <n>", "Show the last N lines of the pane (without it: 20 history lines plus the whole visible pane)", "20")
    .option("--history-plus-pane", "With --lines N, show N history lines plus the whole visible pane, as before --lines was exact")
    .option("--host <id>", "Capture on a remote host declared in ~/.openrig/hosts.yaml (ssh hosts shell out; http hosts go CLI-direct to the remote daemon)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig capture dev-impl@my-rig
  rig capture dev-impl@my-rig --lines 50
  rig capture dev-impl@my-rig --lines 5 --history-plus-pane
  rig capture --rig my-rig
  rig capture --pod dev --rig my-rig
  rig capture --rig my-rig --json
  rig capture --host remote-dev dev-impl@my-rig --lines 50

Supported notes:
  - --lines N shows at most the last N lines, counted up from the last non-blank line. When lines
    above them are left out, a "[rig capture: ...]" note on stderr says how many; --json reports
    lines (returned), requestedLines and omittedLines. Trailing rows that are entirely whitespace
    are dropped before counting (a deliberately blank last row isn't returned); omittedLines counts
    only the earlier rows the limit left out.
  - Over ssh (--host), the remote host's own rig CLI does the capture, so mixed versions differ:
    an older CLI here with no --lines gets the last 20 lines from a remote with this CLI (older
    CLIs always forward --lines 20); this CLI with --lines N gets the older history-plus-pane
    output from a remote with an older CLI; and --history-plus-pane fails there as an unknown
    option (plain --lines N gives that host's old view).
  - Multi-target capture reports unsupported external_cli nodes as explicit per-target failures.
  - For outbound-only external_cli nodes, use rig whoami/rig ps instead of rig capture.
  - --host captures on a remote host declared in ~/.openrig/hosts.yaml. The host
    entry's transport decides the path: ssh hosts via single-hop ssh; http hosts
    (e.g. pair-registered) CLI-direct to the remote daemon's capture route. The
    remote is authoritative on what it can capture either way. A session of the
    form agent@rig@host is sugar for --host when the suffix is a REGISTERED
    host id (explicit --host > sugar > persisted selection).`)
    .action(async (session: string | undefined, opts: CaptureOpts) => {
      // OPR.0.4.6.MH1 FR-2: selected-host routing — explicit --host wins;
      // else the persisted selection feeds the SHIPPED --host path; no
      // selection = today exactly. OPR.0.4.6.MH4 §4: the raw flag is kept
      // so the target sugar slots BETWEEN explicit and selection.
      const explicitHost = opts.host;
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDeps();
      opts.linesGiven = cmd.getOptionValueSource("lines") === "cli";
      opts.exactLines = exactLineCount(opts, opts.linesGiven);

      // OPR.0.4.6.MH4 §4 — `agent@rig@host` target sugar (session operand
      // only; --rig/--pod values are names, never sugar-parsed). Suffix must
      // match a REGISTERED host id, else passthrough + loud-failure hint.
      let crossHostHint: string | undefined;
      if (session !== undefined) {
        const targetResolution = resolveCrossHostTarget(session, explicitHost, deps.hostRegistryLoader);
        if (!targetResolution.ok) {
          console.error(targetResolution.error);
          process.exitCode = 1;
          return;
        }
        session = targetResolution.target;
        crossHostHint = targetResolution.hint;
        if (targetResolution.warning) console.error(targetResolution.warning);
        opts.host = explicitHost ?? targetResolution.sugarHost ?? opts.host;
      }

      // --- Cross-host short-circuit (CLI-side; ssh shell-out or the MH-4 http branch; daemon untouched) ---
      if (opts.host) {
        await runCrossHostCapture(opts.host, session, opts, deps, crossHostHint);
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));
      const lines = parseInt(opts.lines ?? "20", 10);

      const body: Record<string, unknown> = { lines: isNaN(lines) ? 20 : lines };
      if (opts.rig) body.rig = opts.rig;
      if (opts.pod) body.pod = opts.pod;
      if (session) body.session = session;

      const res = await client.post<Record<string, unknown>>("/api/transport/capture", body, { headers: terminalAuthHeaders() });
      if (res.status < 400) res.data = withExactLines(res.data, opts.exactLines);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `Capture failed (HTTP ${res.status})`);
        // MH-4 §4 loud-failure hint: 3-part-shaped target, unregistered suffix.
        if (crossHostHint) console.error(`hint: ${crossHostHint}`);
        process.exitCode = 1;
        return;
      }

      renderCapture(res.data as Record<string, unknown>);
    });

  return cmd;
}

async function runCrossHostCapture(
  hostId: string,
  session: string | undefined,
  opts: CaptureOpts,
  deps: CaptureDeps,
  hint?: string,
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

  // OPR.0.4.6.MH4 — the http transport branch: CLI-direct POST to the
  // remote daemon's shipped /api/transport/capture with the SAME body the
  // local path posts. ssh hosts fall through to the shell-out verbatim.
  if (host.transport === "http") {
    await runHttpHostCapture(host, session, opts, deps, hint);
    return;
  }

  // Reconstruct argv. Order: positional first, then flags.
  const argv: string[] = ["rig", "capture"];
  if (session) argv.push(session);
  if (opts.rig) argv.push("--rig", opts.rig);
  if (opts.pod) argv.push("--pod", opts.pod);
  // Only an explicit --lines is forwarded: the remote's own default stays the default.
  if (opts.linesGiven || opts.historyPlusPane) argv.push("--lines", opts.lines ?? "20");
  if (opts.historyPlusPane) argv.push("--history-plus-pane");
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
 * OPR.0.4.6.MH4 C1 — cross-host capture over http, CLI-DIRECT to the remote
 * daemon's shipped POST /api/transport/capture (zero daemon-side changes).
 * Body parity with the local path (lines/rig/pod/session); the remote's
 * single/multi result renders exactly as a local capture does, under the
 * `[via host=…]` banner. Read-class deadline (the client default).
 */
async function runHttpHostCapture(
  host: HttpHostEntry,
  session: string | undefined,
  opts: CaptureOpts,
  deps: CaptureDeps,
  hint?: string,
): Promise<void> {
  const lines = parseInt(opts.lines ?? "20", 10);
  const body: Record<string, unknown> = { lines: isNaN(lines) ? 20 : lines };
  if (opts.rig) body.rig = opts.rig;
  if (opts.pod) body.pod = opts.pod;
  if (session) body.session = session;

  const result = await runRemoteHttpOp(host.id, "POST", "/api/transport/capture", body, deps, {});
  if (result.ok) result.data = withExactLines(result.data, opts.exactLines);

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

  // Rendered exactly as the local path renders it.
  renderCapture(data);
}

