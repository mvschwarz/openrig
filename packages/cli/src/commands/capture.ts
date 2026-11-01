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
  readable?: boolean;
  size?: string;
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

/** How long a readable capture request may take: the daemon's 8 s for readable reads (CAPTURE_READABLE_BUDGET_MS, shared
 *  across a fan-out), its 1 s for input-box reads, and the client's usual 5 s for the rest. */
export const READABLE_REQUEST_TIMEOUT_MS = 15_000;

/** `--readable` reads at 120x40; `--size WxH` at that size. Null when neither was given; an error for a bad --size. */
/** What happened to the window after a readable read, as far as OpenRig knows. */
export function readableRelease(release: string | undefined): string {
  switch (release) {
    case "given-back": return "its window was then given back its size and its own window-size";
    case "kept-by-another-holder": return "a web terminal opened on it meanwhile and holds its window now; it gives the window back when it closes";
    case "failed": return "giving its window back failed; a later readable capture or web terminal visit gives it back";
    default: return "its window's record had changed, so OpenRig left the window as it found it";
  }
}

export function readableSize(opts: Pick<CaptureOpts, "readable" | "size">): { width: number; height: number } | null | { error: string } {
  if (opts.size === undefined) return opts.readable ? { width: 120, height: 40 } : null;
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(opts.size);
  const width = match ? Number(match[1]) : 0;
  const height = match ? Number(match[2]) : 0;
  if (!match || width < 1 || height < 1 || width > 1000 || height > 1000) return { error: `--size wants WIDTHxHEIGHT, each from 1 to 1000 (got ${JSON.stringify(opts.size)})` };
  return { width, height };
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

/** When `--lines N` left earlier lines out, a busy seat's activity indicator (Claude draws its own above the input box)
 *  may be among them, so this capture can't say the seat is idle. It says unknown and names where activity is known.
 *  Capture never reported activity before, so no known fact is replaced. */
export const CUT_ACTIVITY_NOTE = "lines cut; busy or idle not shown here; see rig ps --nodes or --history-plus-pane";

/** Cut each successful capture in a route payload to its last `n` lines; `lines` becomes the count returned. */
function withExactLines<T>(data: T, n: number | undefined): T {
  if (n === undefined || data === null || typeof data !== "object") return data;
  const cut = (r: Record<string, unknown>): Record<string, unknown> => {
    if (r["ok"] !== true) return r;
    const last = lastLines(typeof r["content"] === "string" ? r["content"] : "", n);
    return { ...r, ...last, requestedLines: n, ...(last.omittedLines > 0 ? { activity: "unknown", activityNote: CUT_ACTIVITY_NOTE } : {}) };
  };
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
      console.error(`[rig capture: ${r["sessionName"]}: ${omitted} earlier line${omitted === 1 ? "" : "s"} not shown; last ${r["lines"]} shown; activity unknown: rig ps --nodes]`);
    }
    // A Claude Code or Codex seat's input box: whether its text is likely a harness suggestion or typed, on stderr so
    // the pane text on stdout is unchanged. An empty box, or a screen with no box, needs no note.
    const box = r["inputBox"] as { status?: string; hint?: string } | undefined;
    if (box && typeof box.hint === "string" && box.status !== "empty" && box.status !== "no-input-box") {
      console.error(`[rig capture: ${r["sessionName"]}: input box: ${box.hint}]`);
    }
    // A prompt in a pane too small to show it: say so, with the resize command, rather than leave a reader guessing.
    const pane = r["promptPane"] as { hint?: string } | undefined;
    if (pane && typeof pane.hint === "string") console.error(`[rig capture: ${r["sessionName"]}: ${pane.hint}]`);
    // --readable: the size it was read at, or why the window was left as it was.
    const readable = r["readable"] as { resized?: boolean; width?: number; height?: number; reason?: string; release?: string; sizeBack?: string } | undefined;
    if (readable?.resized === true) {
      const after = readable.release === "given-back" && readable.sizeBack
        ? `its own window-size was given back, but ${readable.sizeBack}`
        : readableRelease(readable.release);
      console.error(`[rig capture: ${r["sessionName"]}: read at ${readable.width}x${readable.height}; ${after}]`);
    } else if (readable?.resized === false) console.error(`[rig capture: ${r["sessionName"]}: not resized for reading: ${readable.reason}]`);
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
    .option("--readable", "Read a seat whose pane is smaller than 120x40 at that size, then give its window back")
    .option("--size <WxH>", "With or without --readable: read at this size instead (for example 160x50)")
    .option("--host <id>", "Capture on a remote host declared in ~/.openrig/hosts.yaml (ssh hosts shell out; http hosts go CLI-direct to the remote daemon)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig capture dev-impl@my-rig
  rig capture dev-impl@my-rig --lines 50
  rig capture dev-impl@my-rig --lines 5 --history-plus-pane
  rig capture dev-impl@my-rig --readable
  rig capture --rig my-rig
  rig capture --pod dev --rig my-rig
  rig capture --rig my-rig --json
  rig capture --host remote-dev dev-impl@my-rig --lines 50

Supported notes:
  - For a Claude Code or Codex seat, an "[rig capture: ...: input box: ...]" note on stderr says
    what the live input box holds: text the person likely typed, or text that is likely a harness
    suggestion (ghost text), judged from where the cursor is and whether the text is drawn faint.
    A suggestion isn't the person's intent, a draft or a staged command. Ambiguous evidence says
    unknown. --json has it as inputBox: status, confidence, the cursor and the input and
    suggestion regions on the visible screen (zero-based rows and columns), evidence and hint.
  - When the captured screen is at a prompt and the seat's pane is smaller than 80x24, a
    "[rig capture: ...: pane WxH is smaller than 80x24, ...]" note on stderr says the prompt may be
    cut off and suggests --readable. --json has it as promptPane: width, height and hint.
  - --readable (or --size WxH) reads a seat whose pane is smaller than that: it resizes the seat's
    window, waits for the seat to redraw, captures, then puts the window back, both its size and
    its own window-size setting, so Herdr, tmux attach and other clients size it as before. The
    seat redraws twice, and anyone watching it sees the resize briefly. A window that's already big
    enough is read as it is, and so is one whose size is pinned (window-size manual, as while the
    web terminal shows it), one whose sizing can't be read, and one with several panes. With --rig
    or --pod, small seats are read at that size for up to 8 seconds in all, and the rest as they
    are. A stderr note says which; --json has it as readable.
  - --lines N shows at most the last N lines, counted up from the last non-blank line. When lines
    above them are left out, a "[rig capture: ...]" note on stderr says how many; --json reports
    lines (returned), requestedLines and omittedLines. Trailing rows that are entirely whitespace
    are dropped before counting (a deliberately blank last row isn't returned); omittedLines counts
    only the earlier rows the limit left out.
  - When --lines N leaves earlier lines out, a busy seat's activity indicator may be among them,
    so the capture says activity unknown (the stderr note; --json: activity "unknown" with an
    activityNote) rather than looking idle. rig ps --nodes shows the seat's activity; the default
    capture and --history-plus-pane include the whole visible pane.
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
      const size = readableSize(opts);
      if (size && "error" in size) {
        console.error(size.error);
        process.exitCode = 1;
        return;
      }

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
      // The capture default is 20: a missing or non-positive count reads as 20, never 0 or negative.
      const requestedLines = Number.isNaN(lines) || lines < 1 ? 20 : lines;

      const body: Record<string, unknown> = { lines: requestedLines };
      if (opts.rig) body.rig = opts.rig;
      if (opts.pod) body.pod = opts.pod;
      if (session) body.session = session;
      body.inputBox = true; // the input box note; a daemon without it ignores the field
      if (size) body.readable = size; // a daemon without it ignores the field and captures as before

      const res = await client.post<Record<string, unknown>>("/api/transport/capture", body,
        { headers: terminalAuthHeaders(), ...(size ? { timeoutMs: READABLE_REQUEST_TIMEOUT_MS } : {}) });
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
  // A value that parses as a positive count goes over as given (the remote decides);
  // only a missing, zero, negative or non-numeric count sends the documented default.
  if (opts.linesGiven || opts.historyPlusPane) {
    const given = opts.lines ?? "20";
    const parsed = parseInt(given, 10);
    argv.push("--lines", Number.isNaN(parsed) || parsed < 1 ? "20" : given);
  }
  if (opts.historyPlusPane) argv.push("--history-plus-pane");
  if (opts.readable) argv.push("--readable");
  if (opts.size !== undefined) argv.push("--size", opts.size);
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
  const requestedLines = Number.isNaN(lines) || lines < 1 ? 20 : lines;
  const body: Record<string, unknown> = { lines: requestedLines };
  if (opts.rig) body.rig = opts.rig;
  if (opts.pod) body.pod = opts.pod;
  if (session) body.session = session;
  body.inputBox = true;
  const size = readableSize(opts);
  if (size && !("error" in size)) body.readable = size;

  const result = await runRemoteHttpOp(host.id, "POST", "/api/transport/capture", body, deps,
    body.readable ? { timeoutMs: READABLE_REQUEST_TIMEOUT_MS } : {});
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

