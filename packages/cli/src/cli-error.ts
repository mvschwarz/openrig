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
    const code = (e as CommanderLikeError)?.exitCode ?? 1;
    if (json) {
      out(JSON.stringify(formatCliError(e)));
    }
    // (non-JSON plain text was already emitted via configureOutput.writeErr above)
    exit(code || 1);
    return code || 1;
  }
}
