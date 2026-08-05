// Slice 15 (OPR.0.4.7.15) — the ONE shared CLI error/exit path.
//
// Commander's default is to print a plain-text usage/validation error to stderr
// and exit — so a `--json` (or `-o json`) consumer parsing stdout gets nothing
// parseable and cannot tell success from failure. This wraps parse so that:
//   - validation/usage errors (missing required option, unknown option, an
//     InvalidArgumentError from a custom option parser — e.g. bad --limit / -o)
//     become a machine-readable JSON error object on stdout WITH a nonzero exit
//     when the invocation asked for JSON; otherwise the normal plain-text
//     stderr behavior is preserved;
//   - `--help`/`--version` (Commander "clean" exits, exitCode 0) pass through.
// One class-fix at the entry, not per-command patches.
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { DaemonConnectionError, DaemonResponseError, DaemonTimeoutError } from "./client.js";

/**
 * Commander option parser — a positive integer (>= 1). Rejects negative, zero,
 * and non-numeric values (finding 4). Throws InvalidArgumentError, which the
 * shared error path (below) renders as a JSON error under `--json`.
 */
export function positiveIntArg(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError(`must be a positive integer (>= 1); got '${value}'`);
  }
  return n;
}

/** Commander option parser factory — the value must be one of `allowed` (finding 3). */
export function enumArg(allowed: readonly string[]): (value: string) => string {
  return (value: string): string => {
    if (!allowed.includes(value)) {
      throw new InvalidArgumentError(`must be one of: ${allowed.join(", ")}; got '${value}'`);
    }
    return value;
  };
}

/** True when the invocation requested machine output (`--json` or `-o/--output/--format json`). */
export function wantsJsonOutput(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") return true;
    if ((a === "-o" || a === "--output" || a === "--format") && argv[i + 1] === "json") return true;
    if (/^(?:-o|--output|--format)=json$/.test(a)) return true;
  }
  return false;
}

interface CommanderLikeError {
  code?: string;
  exitCode?: number;
  message?: string;
}

/** Commander's non-error terminations (help/version) — exit cleanly, no error object. */
export function isCleanCommanderExit(err: unknown): boolean {
  const e = err as CommanderLikeError;
  return (
    e?.code === "commander.helpDisplayed" ||
    e?.code === "commander.version" ||
    e?.code === "commander.help" ||
    (typeof e?.exitCode === "number" && e.exitCode === 0)
  );
}

export function formatCliError(err: unknown): { ok: false; error: { code: string; message: string } } {
  const e = err as CommanderLikeError;
  const message = (e?.message ?? String(err)).replace(/^error:\s*/i, "").trim();
  return { ok: false, error: { code: e?.code ?? "cli_error", message } };
}

/** Recursively give every command exitOverride so parse errors throw instead of exiting. */
export function applyExitOverride(program: Command): void {
  const walk = (cmd: Command) => {
    cmd.exitOverride();
    for (const sub of cmd.commands) walk(sub);
  };
  walk(program);
}

export interface RunProgramIo {
  out?: (line: string) => void; // stdout (JSON error object)
  err?: (line: string) => void; // stderr (plain-text error)
  exit?: (code: number) => void; // process exit
}

/**
 * Response-integrity render: a daemon transport failure (bad-response /
 * slow-response / no-connect) becomes the repo's 3-part fact/consequence/action
 * error in BOTH json and human modes (Commander's writeErr does NOT fire for an
 * error thrown inside an action, so a human run would otherwise be SILENT).
 * Returns true when it handled `e`. A bad/slow response is NEVER rendered with
 * daemon-not-running language — the request was delivered; the outcome is unknown.
 */
export function renderDaemonTransportError(
  e: unknown,
  io: { out: (l: string) => void; err: (l: string) => void; json: boolean },
): boolean {
  let parts: { fact: string; consequence: string; action: string } | undefined;
  // DaemonTimeoutError is a subclass of DaemonConnectionError — check it FIRST.
  if (e instanceof DaemonResponseError) {
    parts = {
      fact: e.message,
      consequence: "The command's outcome is UNKNOWN — it may or may not have been applied.",
      action:
        "Re-check current state (e.g. 'rig queue show <id>'); if it repeats, inspect daemon health with 'rig daemon status' and the daemon logs. This is a bad response, not a stopped daemon.",
    };
  } else if (e instanceof DaemonTimeoutError) {
    parts = {
      fact: e.message,
      consequence: "The command's outcome is UNKNOWN — the daemon did not answer in time.",
      action:
        "The daemon is slow or unresponsive (check load); retry once conditions ease. This is a slow response, not a stopped daemon.",
    };
  } else if (e instanceof DaemonConnectionError) {
    parts = {
      fact: e.message,
      consequence: "The command was not delivered.",
      action: "Confirm the daemon is reachable with 'rig daemon status'; if it is down, start it with 'rig up' or 'rig daemon start'.",
    };
  }
  if (!parts) return false;
  if (io.json) {
    io.out(JSON.stringify({ error: parts }));
  } else {
    io.err(parts.fact);
    io.err(`  ${parts.consequence}`);
    io.err(`  ${parts.action}`);
  }
  return true;
}

/**
 * Parse+run the program through the shared error path. Injectable IO for tests.
 * Returns the process exit code (0 on success / clean help/version).
 */
export async function runProgram(program: Command, argv: string[], io: RunProgramIo = {}): Promise<number> {
  const out = io.out ?? ((l: string) => process.stdout.write(l + "\n"));
  const err = io.err ?? ((l: string) => process.stderr.write(l + "\n"));
  const exit = io.exit ?? ((c: number) => process.exit(c));
  const json = wantsJsonOutput(argv.slice(2));

  applyExitOverride(program);
  // Suppress Commander's own plain-text stderr write when JSON was requested, so a
  // `--json` failure emits ONLY the JSON error object (below). Non-JSON keeps the
  // familiar stderr text. Applied to the whole command tree.
  const suppressErr = (cmd: Command) => {
    cmd.configureOutput({ writeErr: (str: string) => { if (!json) err(str.replace(/\n$/, "")); } });
    for (const sub of cmd.commands) suppressErr(sub);
  };
  suppressErr(program);

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (e) {
    if (isCleanCommanderExit(e)) return 0;
    // Response-integrity: render daemon transport failures honestly (3-part, both
    // modes, honest nonzero exit) before the generic path — otherwise a thrown
    // bad-response/timeout is cryptic under --json and SILENT for a human run.
    if (renderDaemonTransportError(e, { out, err, json })) {
      exit(1);
      return 1;
    }
    const code = (e as CommanderLikeError)?.exitCode ?? 1;
    if (json) {
      out(JSON.stringify(formatCliError(e)));
    }
    // (non-JSON plain text was already emitted via configureOutput.writeErr above)
    exit(code || 1);
    return code || 1;
  }
}
