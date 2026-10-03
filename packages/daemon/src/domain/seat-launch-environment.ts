import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { shellQuote } from "../adapters/shell-quote.js";

// Explicit public launch metadata, not a prefix/denylist over credential names.
// Provider keys and OPENRIG_ACTIVITY_HOOK_TOKEN keep their non-typed channel.
export const SEAT_PUBLIC_ENV_KEYS = [
  "OPENRIG_HOME", "OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT",
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME",
  "OPENRIG_OCCUPANT_GENERATION", "OPENRIG_TRANSCRIPTS_LINES",
  "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS",
] as const;

export function publicSeatEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of SEAT_PUBLIC_ENV_KEYS) if (env[key] !== undefined) result[key] = env[key]!;
  if (result.OPENRIG_URL) {
    const url = new URL(result.OPENRIG_URL);
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("Seat launch URL must not contain credentials, query parameters or a fragment.");
    }
  }
  return result;
}

/** Resolve exactly on the daemon launch PATH, without consulting the pane rc. */
export function launchExecutable(name: string, searchPath: string, cwd: string): string {
  for (const entry of searchPath.split(path.delimiter)) {
    const file = path.resolve(cwd, entry, name);
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* next entry */ }
  }
  throw new Error(`Seat launch requires ${name} on the daemon launch PATH.`);
}

/** Reassert only public seat metadata after shell startup. Session identity is
 * read from tmux's launch environment; a successor's reserved identity wins.
 * Neither credentials nor user/runtime config variables enter the command.
 */
export class SeatLaunchEnvironment {
  constructor(private readonly tmux: TmuxAdapter,
    private readonly sessionEnv: Readonly<Record<string, string | undefined>>,
    private readonly daemonCwd: string) {}

  async command(session: string, command: string, target: { codexCwd?: string; nodeId?: string; generation?: string; runtime?: string } = {}): Promise<string> {
    const searchPath = this.sessionEnv.PATH;
    if (!searchPath) throw new Error("Seat launch requires the daemon launch PATH.");
    const binDir = path.dirname(launchExecutable("rig", searchPath, this.daemonCwd));
    const identity: Record<string, string | undefined> = {};
    for (const key of ["OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "OPENRIG_OCCUPANT_GENERATION"]) {
      identity[key] = await this.tmux.getSessionEnv(session, key);
    }
    if (!identity.OPENRIG_NODE_ID || !identity.OPENRIG_SESSION_NAME) {
      throw new Error("Seat launch requires the session's OpenRig identity.");
    }
    if (target.nodeId !== undefined && identity.OPENRIG_NODE_ID !== target.nodeId) {
      throw new Error("Seat launch identity differs from the intended node.");
    }
    // Handover respawns an existing pane with -e; tmux's session environment
    // still names the predecessor. The caller owns the reserved generation.
    if (target.runtime !== undefined) identity.OPENRIG_RUNTIME = target.runtime;
    if (target.generation !== undefined) identity.OPENRIG_OCCUPANT_GENERATION = target.generation;
    const env = publicSeatEnvironment({ OPENRIG_TRANSCRIPTS_LINES: "", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "", ...this.sessionEnv, ...identity });
    // Codex help/preflight uses the daemon PATH. Keep that executable selection
    // while child tools retain the user's PATH, with the current rig bin first.
    if (target.codexCwd !== undefined) {
      if (!command.startsWith("codex ")) throw new Error("Expected a Codex launch command.");
      command = shellQuote(launchExecutable("codex", searchPath, target.codexCwd)) + command.slice(5);
    }
    const assignments = Object.entries(env).map(([key, value]) => shellQuote(`${key}=${value}`));
    return `/usr/bin/env ${assignments.join(" ")} PATH=${shellQuote(binDir)}:"$PATH" ${command}`;
  }
}
