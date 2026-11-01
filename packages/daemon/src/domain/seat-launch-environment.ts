import { ACCOUNT_HOME_PROVIDER_ENV, RUNTIME_HOME_VAR, type HomeRuntime } from "./seat-runtime-home.js";
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { shellQuote } from "../adapters/shell-quote.js";

// Explicit public launch metadata, not a prefix/denylist over credential names.
// Provider keys and OPENRIG_ACTIVITY_HOOK_TOKEN keep their non-typed channel.
export const SEAT_PUBLIC_ENV_KEYS = [
  "OPENRIG_HOME", "OPENRIG_DB", "TMUX_TMPDIR", "OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT",
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME",
  "OPENRIG_OCCUPANT_GENERATION", "OPENRIG_TRANSCRIPTS_LINES",
  "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS",
] as const;

export function publicSeatEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of SEAT_PUBLIC_ENV_KEYS) if (env[key] !== undefined) result[key] = env[key]!;
  if (result.OPENRIG_URL) {
    try {
      const url = new URL(result.OPENRIG_URL);
      if (url.username || url.password || url.search || url.hash) throw new Error("Not a public URL");
    } catch {
      delete result.OPENRIG_URL;
      // The existing tmux environment channel still carries it. Never log its value.
      console.warn("[seat launch] URL omitted from typed metadata; retaining the existing environment channel.");
    }
  }
  return result;
}

/** Locate the CLI paired with this daemon, never a PATH-first global install.
 * The first layout is the bundled CLI; the second is the workspace build.
 */
function pairedCli(): string {
  for (const relative of ["../../../package.json", "../../../cli/package.json"]) {
    const manifest = path.resolve(import.meta.dirname, relative);
    try {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name === "@openrig/cli" && typeof pkg.bin?.rig === "string") {
        return path.resolve(path.dirname(manifest), pkg.bin.rig);
      }
    } catch { /* try the other supported layout */ }
  }
  throw new Error("Paired CLI unavailable");
}

/** Pin npm Codex's interpreter as well as its entry file to the probe PATH.
 * Child tools still inherit the pane PATH. Unrecognised env shebang syntax
 * falls back to the old literal-PATH command instead of guessing its meaning.
 */
function codexEntry(searchPath: string, cwd: string): string {
  const executable = launchExecutable("codex", searchPath, cwd);
  const fd = openSync(executable, "r");
  let firstLine: string;
  try {
    const bytes = Buffer.alloc(512);
    firstLine = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8").split("\n")[0]!;
  } finally { closeSync(fd); }
  if (/^#!\s*\/usr\/bin\/env(?:\s|$)/.test(firstLine)) {
    if (!/^#![ \t]*\/usr\/bin\/env[ \t]+node[ \t]*\r?$/.test(firstLine)) throw new Error("Unsupported env shebang");
    return `${shellQuote(launchExecutable("node", searchPath, cwd))} ${shellQuote(executable)}`;
  }
  return shellQuote(executable);
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
 * Credentials stay in the inherited channel. An explicitly selected Codex home
 * is reasserted for Codex only; an unset selection retains the pane's defaults.
 */
export class SeatLaunchEnvironment {
  constructor(private readonly tmux: TmuxAdapter,
    private readonly sessionEnv: Readonly<Record<string, string | undefined>>,
    private readonly daemonCwd: string,
    private readonly cliPath?: string,
    private readonly codexHome?: string,
    private readonly selectedAccountHome?: (nodeId: string, runtime: string, ignoreAccountHome?: boolean) => string | undefined) {}

  private rigBin(): string {
    const cli = realpathSync(this.cliPath ?? pairedCli());
    accessSync(cli, constants.X_OK);
    if (!statSync(cli).isFile() || !this.sessionEnv.OPENRIG_HOME) throw new Error("Paired CLI or instance home unavailable");
    // Separate aliases for concurrent installed versions; never retarget another
    // daemon's link. Only rig is exposed, not the other tools in a shared bin.
    const bin = path.resolve(this.daemonCwd, this.sessionEnv.OPENRIG_HOME, "run", "seat-bin", createHash("sha256").update(cli).digest("hex"));
    mkdirSync(bin, { recursive: true });
    const link = path.join(bin, "rig");
    try { symlinkSync(cli, link); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (readlinkSync(link) !== cli || readdirSync(bin).some(name => name !== "rig")) throw new Error("Seat bin is not rig-only");
    return bin;
  }

  /** Build an identity-bound child command, scrubbing inherited credentials for a selected account home or refusing its launch. */
  async command(session: string, command: string, target: { codexCwd?: string; nodeId?: string; generation?: string; runtime?: string;
    /** The seat's own CODEX_HOME when it declares one; it wins over the daemon's. */
    codexHome?: string;
    accountHome?: string | null;
    /** A Claude seat's own token step (claude-seat-token.ts), run before Claude in the staged subshell. A POSIX pane only:
     *  a caller whose command comes back without it knows the token wasn't applied. */
    claudeTokenStep?: string } = {}): Promise<string> {
    const accountHome = target.accountHome !== undefined ? target.accountHome : (target.nodeId && target.runtime ? this.selectedAccountHome?.(target.nodeId, target.runtime) : undefined);
    const clearing = target.accountHome === null;
    const configuredHome = clearing && target.nodeId && target.runtime ? this.selectedAccountHome?.(target.nodeId, target.runtime, true) : undefined;
    const homeVar = RUNTIME_HOME_VAR[target.runtime as HomeRuntime];
    const clearStep = clearing && homeVar ? `unset ${homeVar}; ${configuredHome !== undefined ? `export ${homeVar}=${shellQuote(configuredHome)}; ` : ""}` : "";
    const codexHome = (target.runtime === "codex" ? accountHome : undefined) ?? target.codexHome ?? this.codexHome;
    const searchPath = this.sessionEnv.PATH;
    const accountStep = clearStep + (accountHome ? `unset ${ACCOUNT_HOME_PROVIDER_ENV.join(" ")}; ` : "");
    const codexEnv = target.codexCwd !== undefined
      ? [searchPath ? `PATH=${shellQuote(searchPath)}` : "", codexHome ? `CODEX_HOME=${shellQuote(codexHome)}` : ""].filter(Boolean)
      : [];
    const fallback = codexEnv.length ? `env ${codexEnv.join(" ")} ${command}` : command;
    try {
      // Nushell does not expand "$PATH". Keep its pre-existing literal command.
      const shell = path.basename(await this.tmux.getPaneCommand(session) ?? "").replace(/^-/, "");
      if (shell === "nu" || shell === "nu.exe" || ((accountHome || clearing) && !["bash", "zsh", "sh", "dash", "ksh", "mksh"].includes(shell))) throw new Error("Non-POSIX pane");
      // Pi keeps its existing command on shells where this PATH expression is not supported.
      if (target.runtime === "pi" && !["bash", "zsh", "sh", "dash", "ksh"].includes(shell)) {
        throw new Error("Unsupported Pi pane shell");
      }
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
      // Codex help/preflight uses the daemon PATH. Preserve its executable and
      // interpreter selection while child tools retain the user's PATH.
      if (target.codexCwd !== undefined) {
        if (!searchPath || !command.startsWith("codex ")) throw new Error("Expected a Codex launch command and PATH.");
        command = codexEntry(searchPath, target.codexCwd) + command.slice(5);
      }
      const binDir = this.rigBin();
      const env = publicSeatEnvironment({ OPENRIG_TRANSCRIPTS_LINES: "", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "", ...this.sessionEnv, ...identity });
      if (target.codexCwd !== undefined && codexHome) env.CODEX_HOME = codexHome;
      if (accountHome && target.runtime === "claude-code") env.CLAUDE_CONFIG_DIR = accountHome;
      // Classic Claude may be an rc alias or function, not a PATH executable.
      // Its caller sources the staged command in a pane-shell subshell. Leading
      // assignments preserve shell lookup; /usr/bin/env would bypass it.
      if (target.runtime === "claude-code") {
        const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
        const launch = `${accountStep}${accountHome && target.claudeTokenStep ? `${target.claudeTokenStep} && ` : ""}${assignments.join(" ")} PATH=${shellQuote(binDir)}:"$PATH" ${command}`;
        // The token step is POSIX shell; another shell (fish, tcsh) gets the command without it.
        const token = !accountHome && target.claudeTokenStep && ["bash", "zsh", "sh", "dash", "ksh", "mksh"].includes(shell) ? [target.claudeTokenStep] : [];
        // ksh calls a function without exporting a leading assignment that isn't already
        // exported, so it keeps the form above, where every assignment reaches Claude.
        if (!["bash", "zsh", "sh", "dash"].includes(shell)) return [...token, launch].join("\n");
        // A file command must replace the staging subshell so tmux observes
        // Claude as the foreground process. Keep aliases/functions intact and
        // pass the original leading assignments through a subshell-local function.
        // The constant eval defers function-name parsing until alias lookup is ruled out.
        return [
          'if _openrig_claude_executable=$(command -v claude) && [ -f "$_openrig_claude_executable" ] && [ -x "$_openrig_claude_executable" ]; then',
          '  case "$_openrig_claude_executable" in',
          "    */*) eval 'claude() { exec \"$_openrig_claude_executable\" \"$@\"; }' ;;",
          '  esac',
          'fi',
          ...token,
          launch,
        ].join("\n");
      }
      const assignments = Object.entries(env).map(([key, value]) => shellQuote(`${key}=${value}`));
      return `${accountStep}/usr/bin/env ${assignments.join(" ")} PATH=${shellQuote(binDir)}:"$PATH" ${command}`;
    } catch {
      // This best-effort correction is not a new launch admission gate. Do not
      // include error details: transport errors may contain environment values.
      console.warn(accountHome || clearing ? "[seat launch] Isolated account launch unavailable; no agent started."
        : "[seat launch] Environment correction unavailable; using the previous launch command.");
      return accountHome || clearing ? "printf '%s\\n' 'OpenRig: isolated account launch unavailable; no agent started.' >&2; false" : fallback;
    }
  }
}
