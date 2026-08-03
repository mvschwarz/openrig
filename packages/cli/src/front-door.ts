// Slice-17 mini-req 7 — BARE-RIG FRONT DOOR (founder, arch-reinforced).
//
// bare `rig` (no args) opens the TUI, k9s-style, TTY-AWARE:
//   - the guard checks BOTH stdin AND stdout isTTY — a pipe/redirect on
//     EITHER stream means a script is involved, so the front door does NOT
//     own the invocation and the normal commander usage path runs (prints
//     usage, exits fast, never hangs — `echo x | rig` must not block);
//   - first-impression degrade: daemon-down and TUI-init-failure print
//     HELPFUL usage ("daemon not running — try: rig up"), never a stack
//     trace — daemon-down is the likely first-run state;
//   - `--help`, `--version`, and every subcommand are ARGS, so they are
//     naturally excluded from bare invocation and behave unchanged.
import path from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { DaemonClient } from "./client.js";

/** Monorepo-first, bundled-fallback TUI entry resolution — the exact
 * resolveDaemonPath pattern (see daemon-lifecycle.ts): a dev checkout's
 * `packages/tui/dist` is the source of truth; an npm-install layout ships
 * the bundled copy next to the cli. Null = not found (caller degrades). */
export function resolveTuiPath(baseDir: string, exists: (p: string) => boolean = existsSync): string | null {
  const cliBaseDir = path.basename(baseDir) === "commands" ? path.resolve(baseDir, "..") : baseDir;
  const monorepo = path.join(path.resolve(cliBaseDir, "../../tui"), "dist/main.js");
  if (exists(monorepo)) return monorepo;
  const bundled = path.join(path.resolve(cliBaseDir, "../tui"), "dist/main.js");
  if (exists(bundled)) return bundled;
  return null;
}

const USAGE_LINES = [
  "rig — the OpenRig control plane",
  "",
  "  rig              open mission control (interactive terminal only)",
  "  rig --help       full command list",
  "  rig up <rig>     bring a rig up",
  "  rig ps           list live seats",
];

export interface FrontDoorIo {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
  exit?: (code: number) => void;
  /** fast daemon reachability probe (default: GET /healthz, 1.5s cap) */
  probeDaemon?: () => Promise<boolean>;
  /** launch the TUI and resolve with its exit code */
  launchTui?: () => Promise<number>;
}

async function defaultProbeDaemon(): Promise<boolean> {
  try {
    const client = new DaemonClient();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(`${client.baseUrl}/healthz`, { signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function defaultLaunchTui(): Promise<number> {
  const entry = resolveTuiPath(import.meta.dirname);
  if (!entry) throw new Error("mission-control TUI is not installed (no tui/dist/main.js next to this CLI)");
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

/**
 * Returns true when the front door OWNED the invocation (TUI launched or a
 * degrade message printed + exit requested); false to fall through to the
 * normal commander program (args present, or a non-TTY stream).
 */
export async function runFrontDoor(argv: readonly string[], io: FrontDoorIo = {}): Promise<boolean> {
  if (argv.length > 2) return false; // any arg → the normal CLI, unchanged
  const stdinIsTTY = io.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = io.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!stdinIsTTY || !stdoutIsTTY) return false; // script involved → usage path, fast exit

  const err = io.err ?? ((l: string) => process.stderr.write(l + "\n"));
  const exit = io.exit ?? ((c: number) => process.exit(c));
  const probe = io.probeDaemon ?? defaultProbeDaemon;
  const launch = io.launchTui ?? defaultLaunchTui;

  if (!(await probe())) {
    for (const line of USAGE_LINES) err(line);
    err("");
    err("daemon not running — try: rig up   (then bare `rig` opens mission control)");
    exit(1);
    return true;
  }
  try {
    const code = await launch();
    exit(code);
  } catch (e) {
    // first-impression degrade: the message, never the stack
    for (const line of USAGE_LINES) err(line);
    err("");
    err(`mission control could not start: ${e instanceof Error ? e.message : String(e)}`);
    exit(1);
  }
  return true;
}
