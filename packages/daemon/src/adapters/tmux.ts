import { DeliveryGuardError, type SeatDeliveryGuard } from "../domain/seat-delivery-guard.js";
import { writeFile as fsWriteFile, unlink as fsUnlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename as pathBaseName, isAbsolute as pathIsAbsolute, join as pathJoin } from "node:path";
import { randomUUID } from "node:crypto";
import type { ComposerSnapshot } from "../domain/composer-prompts.js";
import { inspectComposerInput } from "../domain/session-transport.js";
import { parentSessionEnvKeys, removeParentSessionEnv } from "../domain/parent-session-env.js";
import { bindNativeSessionName, isEncodedNativeSessionName, logicalNameFromNativeBinding, nativeSessionNameMayBeLegacy, NATIVE_LOGICAL_SESSION_OPTION } from "../domain/terminal/native-session-name.js";
import { addSeatRuntimeDir } from "../domain/seat-runtime-dir.js";
import type { TmuxControlExec } from "./tmux-control.js";
import { powershellQuote, hasOnlyWindowsTerminalResponseDraft } from "./windows-launch.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isWindowsPrivateEnvironmentName, psmuxPrivateEnvironmentLine, writeWindowsPrivateConfig, type PrivateConfig } from "./windows-private-config.js";
import { createPrivateTextFileAsync } from "../domain/private-text-file.js";
import { isStagedSendName, SEND_SCRIPT_PREFIX, SEND_SCRIPT_SUFFIX } from "./staged-send-name.js";
import { windowsCmdBridgeInvocation, windowsPosixBridgeInvocation } from "../domain/windows-cmd-bridge.js";
import { windowsScopedLaunch } from "./windows-scoped-launch.js";
import { nextNativeRuntimeExchangeStep, type NativeExchangeIdentity, type NativeExchangeSlot } from "../domain/native-runtime-switch-exchange.js";
import type { NativeExchangeTerminal } from "../domain/native-runtime-switch-journal.js";
import { readPlatformEnv } from "../domain/platform-env.js";
import { tmuxFormatLiteral, tmuxSessionNameFormat } from "./tmux-format.js";
const execFileAsync = promisify(execFile);

export type ExecFn = (cmd: string) => Promise<string>;

/** tmux 3.4 escapes these dollar forms in command output even for show-options -v.
 * Remove only its added escape; preserve an intentionally preceding backslash. */
export function decodeTmux34Option(value: string, serverVersion: string): string {
  return /^3\.4(?:[a-z])?$/.test(serverVersion.trim())
    ? value.replace(/\\\$(?=[A-Za-z_{])/g, "$")
    : value;
}

interface TmuxShellCommandOptions {
  /** Pi can send commands within the terminal byte bound directly. */
  stageIfLong?: boolean;
  /** A staged single-executable runner must replace the staging shell. */
  execInScript?: boolean;
  /** Preserve rc aliases/functions in POSIX or fish panes; other shells use /bin/sh. */
  sourceInPane?: boolean;
}

/**
 * Argv exec: run the multiplexer WITHOUT a shell (execFile-style — the
 * binary is argv[0], the rest are verbatim arguments, no quoting layer).
 * The daemon wires it on every platform: no shell process per call, and on
 * Windows/psmux no POSIX quoting or `/dev/null` redirections to depend on.
 * When absent every method uses the legacy shell-string path unchanged.
 */
export type ArgvExecFn = ((argv: string[], options?: { env?: Readonly<Record<string,string|undefined>> }) => Promise<string>) & {
  supportsEnvironment?: true;
};

/**
 * Injectable file/buffer operations for terminal payloads and launch environments.
 * Split out so tests can observe temp-file writes and unique-name generation
 * without touching the real filesystem; production wires node fs + os.tmpdir.
 */
export interface TmuxFileOps {
  privateConfig?(content: string): Promise<PrivateConfig>;
  writeFile(path: string, content: string, options?: { mode: number; flag: "wx" }): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Unique temp-file path per call - parallel `rig up` stands up many seats. */
  tmpName(): string;
  /** Unique tmux buffer name per call - a fixed name would collide under concurrency. */
  bufferName(): string;
}

// One source for the staged script's name: the generator (defaultTmuxFileOps) and the matcher
// (isStagedSendScriptPath) are both built from it.

/** Whether `path` names a launch script sendShellCommand staged (an absolute path with the name
 *  defaultTmuxFileOps gives it). The script removes itself first, so this is a name check only. */
export function isStagedSendScriptPath(path: string): boolean {
  return pathIsAbsolute(path) && isStagedSendName(pathBaseName(path));
}

export function defaultTmuxFileOps(): TmuxFileOps {
  return {
    privateConfig: writeWindowsPrivateConfig,
    writeFile: (p, content, options) => process.platform === "win32"
      ? createPrivateTextFileAsync(p, content)
      : fsWriteFile(p, content, { encoding: "utf8", ...options }),
    unlink: (p) => fsUnlink(p),
    tmpName: () => pathJoin(tmpdir(), `${SEND_SCRIPT_PREFIX}${process.pid}-${randomUUID()}${SEND_SCRIPT_SUFFIX}`),
    bufferName: () => `openrig_${process.pid}_${randomUUID().replace(/-/g, "")}`,
  };
}

export type TmuxResult =
  | { ok: true; warnings?: string[]; stopPhase?: StopPhase }
  | { ok: false; code: string; message: string; stopPhase?: StopPhase };

/** Furthest external stop boundary reached; an attempted command can have an uncertain effect. */
export type StopPhase = "none" | "detach_attempted" | "detached" | "kill_attempted";

export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export interface TmuxWindow {
  index: number;
  name: string;
  panes: number;
  active: boolean;
}

export interface TmuxPane {
  id: string;
  index: number;
  cwd: string;
  width: number;
  height: number;
  active: boolean;
}

/**
 * Cursor coordinates plus pane geometry, used by the live-terminal seed
 * (OPR.0.4.0.38). Coordinates are zero-based; geometry is the visible pane
 * size. Lifted from the FR-4 seed work so a new subscriber can paint the
 * current screen with the cursor in the right place and no row drift.
 */
export interface TmuxCursorPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * An attached tmux client — the human's terminal/CMUX tile. `name` is the
 * client identifier accepted by `switch-client -c` (the client tty by default);
 * `session` is the session the client is CURRENTLY viewing (may be the wrong or
 * a dead view, which is exactly the recovery case OPR.0.4.3.26 retargets).
 */
export interface TmuxClient {
  name: string;
  session: string;
}

/**
 * Result of a classified session probe (OPR.0.5.4.2). `absent` carries
 * positive tmux evidence; `transport_unavailable` means the tmux server could
 * not be reached and session existence was NOT determined — the two are never
 * interchangeable.
 */
export type SessionProbe =
  | { state: "present" }
  | { state: "absent" }
  | { state: "transport_unavailable"; cause: string };

/** Positive server absence in this adapter's namespace; match the diagnostic line, never a path or command fragment. */
export function probeShowsNoServer(probe: { state: string; cause?: string }): boolean {
  return probe.state === "transport_unavailable" && /^no server running on /.test(tmuxDiagnosticStart(probe.cause ?? ""));
}

/** Injected executors may retain exec's one-line command wrapper instead of stderr. */
function tmuxDiagnosticStart(message: string): string {
  return message.replace(/^Command failed:[^\r\n]*\r?\n/, "");
}

const TMUX_FIELD_SEPARATOR = "|";
const SESSION_FORMAT = [
  "#{session_name}",
  "#{session_windows}",
  "#{session_created}",
  "#{session_attached}",
].join(TMUX_FIELD_SEPARATOR);
const WINDOW_FORMAT = [
  "#{window_index}",
  "#{window_name}",
  "#{window_panes}",
  "#{window_active}",
].join(TMUX_FIELD_SEPARATOR);
// tmux 3.6 sanitizes literal control characters in -F output to underscores, and
// tmux 3.3a replaces tabs with underscores, so tab-delimited rows become
// unparseable on those versions. EVERY adapter-owned format uses the printable
// delimiter instead.
const PANE_FORMAT = [
  "#{pane_id}",
  "#{pane_index}",
  "#{pane_current_path}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_active}",
].join(TMUX_FIELD_SEPARATOR);
const CLIENT_FORMAT = [
  "#{client_name}",
  "#{client_session}",
].join(TMUX_FIELD_SEPARATOR);
const CURSOR_FORMAT = [
  "#{cursor_x}",
  "#{cursor_y}",
  "#{pane_width}",
  "#{pane_height}",
].join(TMUX_FIELD_SEPARATOR);

function isNoServerError(err: unknown): boolean {
  const error = tmuxReportedError(err);
  return error instanceof Error && probeShowsNoServer({ state: "transport_unavailable", cause: error.message });
}

/** The error tmux reported, without the stdout an exec error carries: in a chain that stdout is the earlier panes'
 *  text, which an agent controls. Errors that kept no stderr classify on their message. */
function tmuxReportedError(err: unknown): unknown {
  const stderr = (err as { execStderr?: unknown } | null)?.execStderr;
  return typeof stderr === "string" ? new Error(stderr) : err;
}

function isSessionAbsenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = tmuxDiagnosticStart(err.message).toLowerCase();
  return /^(?:session not found|can't find session|no current target|no sessions?)\b/.test(msg);
}

function isPaneAbsenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("can't find pane") || msg.includes("pane not found") || msg.includes("no such pane");
}

// Post-reboot the tmux socket file at /tmp/tmux-<uid>/<name> is gone, so
// `tmux has-session` exits non-zero with a transport-absent message rather than
// a server/session-absent message. probeSession() classifies this class as
// transport_unavailable — session existence NOT determined, never absence;
// only Reconciler elects to treat that state as detachable, at its own
// cold-start call site (OPR.0.5.4.2). Permission errors must remain rethrown.
function isTmuxTransportAbsentError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // Fail-closed: never classify a permission/authorization failure as absence.
  if (/permission denied|operation not permitted|EACCES|EPERM/i.test(msg)) {
    return false;
  }
  // tmux's socket-transport failure prefix; the parenthetical names the cause.
  //   "error connecting to /private/tmp/tmux-501/default (No such file or directory)"
  //   "error connecting to /private/tmp/tmux-501/default (Connection refused)"
  if (msg.startsWith("error connecting to")) {
    return /No such file or directory|Connection refused/.test(msg);
  }
  // Conservative bare-message variants that still reference a tmux socket path.
  if (/tmux-\d+/.test(msg) && /No such file or directory|Connection refused/.test(msg)) {
    return true;
  }
  return false;
}

function classifyWriteError(err: unknown): TmuxResult {
  if (err instanceof DeliveryGuardError) return { ok: false, code: err.code, message: err.message };
  if (!(err instanceof Error)) {
    return { ok: false, code: "unknown", message: String(err) };
  }
  if (err.message.includes("duplicate session")) {
    return { ok: false, code: "duplicate_session", message: err.message };
  }
  if (err.message.includes("can't find session") || err.message.includes("no server running")) {
    return { ok: false, code: "session_not_found", message: err.message };
  }
  return { ok: false, code: "unknown", message: err.message };
}

/** tmux 3.7+ refuses every send-keys, `-l` included, while the target client is read-only (`tmux attach -r`). */
function isReadOnlyClientRefusal(result: TmuxResult): boolean {
  return !result.ok && /client is read-only/i.test(result.message);
}

/** The key names that submit staged input; both reach the pane as a carriage return. */
function isSubmitKey(key: string): boolean {
  return key === "Enter" || key === "C-m";
}

/** The launch warning when the parent-session identity cleanup could not finish (#771). */
function parentSessionEnvWarning(target: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `${target}: could not remove the launching session's identity (for example CLAUDECODE) from this seat's environment, so the seat may still see it: ${reason}`;
}

/** Shell-quote a string using single quotes (POSIX-safe). */
/** One pane's text from a batched capture, with the time its chunk was read (#309 review). `text` is null for a
 *  session that is gone or an empty capture. */
export interface PaneCapture { text: string | null; capturedAt: Date; /** The listing lacked the session. */ missing?: true }

/** The most sessions one batched capture chains (#308). Not a byte bound: a chunk whose output overflows exec's buffer
 *  fails and is split in half. */
export const CAPTURE_BATCH = 24;

function shellQuote(s: string): string {
  // Replace each ' with '"'"' (end quote, double-quote the apostrophe, resume quote)
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/** tmux config joins physical newlines even inside single quotes. Encode multiline words
 * with its double-quoted escapes instead of passing shell syntax to source-file. */
function tmuxConfigQuote(s: string): string {
  if (!s.includes("\n")) return shellQuote(s);
  return '"' + s.replace(/[\\"$\n\r\t]/g, c => ({ "\\": "\\\\", '"': '\\"', "$": "\\$", "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c]!) + '"';
}

/**
 * An exact tmux target for a session name. tmux resolves a bare name by prefix when no session has that exact name,
 * so a read or pipe for a session that just ended would act on another (`dev-impl@my-rig` on `dev-impl@my-rig2`).
 * Pane, window and session ids (`%3`, `@1`, `$2`) and `session:window.pane` targets pass through unchanged (tmux
 * turns `:` in a session name into `_`, so a `:` always means an explicit target). A pane or window command gets
 * `=name:` (as the batched capture uses); a session command gets `=name`.
 */
function exactTarget(target: string, kind: "pane" | "window" | "session"): string {
  if (/^[%@$]\d+$/.test(target) || target.includes(":")) return target;
  return kind === "session" ? `=${target}` : `=${target}:`;
}

/** Elements safe to leave bare in a POSIX shell word list. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Join argv for a POSIX shell — the legacy string form. Only used when
 *  no ArgvExecFn is wired. Flags and safe words stay bare (matching the
 *  historical template strings); anything else is single-quoted. The argv
 *  arrays stay the single source of truth for what is EXECUTED on either
 *  path — this join only renders them for a shell. */
function posixJoinArgv(argv: string[]): string {
  return argv.map((a) => (SHELL_SAFE.test(a) ? a : shellQuote(a))).join(" ");
}

function parseSessionLine(line: string): TmuxSession | null {
  const parts = line.split(TMUX_FIELD_SEPARATOR);
  if (parts.length < 4) return null;
  // Only the final three fields are metadata; a literal session name may
  // itself contain the printable separator, just like pane paths/window names.
  const windows = parseInt(parts.at(-3)!, 10);
  if (isNaN(windows)) return null;
  return {
    name: parts.slice(0, -3).join(TMUX_FIELD_SEPARATOR),
    windows,
    created: parts.at(-2)!,
    attached: parts.at(-1) === "1",
  };
}

function parseClientLine(line: string): TmuxClient | null {
  // First-separator split keeps any separator inside the session name intact.
  const separator = line.indexOf(TMUX_FIELD_SEPARATOR);
  if (separator <= 0) return null;
  const session = line.slice(separator + 1);
  if (session === "") return null;
  return {
    name: line.slice(0, separator),
    session,
  };
}

function parseWindowLine(line: string): TmuxWindow | null {
  const firstSeparator = line.indexOf(TMUX_FIELD_SEPARATOR);
  const lastSeparator = line.lastIndexOf(TMUX_FIELD_SEPARATOR);
  const panesSeparator = line.lastIndexOf(TMUX_FIELD_SEPARATOR, lastSeparator - 1);
  if (firstSeparator < 0 || panesSeparator <= firstSeparator || lastSeparator <= panesSeparator) return null;

  const index = parseInt(line.slice(0, firstSeparator), 10);
  const panes = parseInt(line.slice(panesSeparator + 1, lastSeparator), 10);
  if (isNaN(index) || isNaN(panes)) return null;
  return {
    index,
    name: line.slice(firstSeparator + 1, panesSeparator),
    panes,
    active: line.slice(lastSeparator + 1) === "1",
  };
}

function parsePaneLine(line: string): TmuxPane | null {
  const parts = line.split(TMUX_FIELD_SEPARATOR);
  if (parts.length < 6) return null;
  const index = parseInt(parts[1]!, 10);
  const width = parseInt(parts.at(-3)!, 10);
  const height = parseInt(parts.at(-2)!, 10);
  if (isNaN(index) || isNaN(width) || isNaN(height)) return null;
  return {
    id: parts[0]!,
    index,
    cwd: parts.slice(2, -3).join(TMUX_FIELD_SEPARATOR),
    width,
    height,
    active: parts.at(-1) === "1",
  };
}

function parseLines<T>(output: string, parser: (line: string) => T | null): T[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map(parser)
    .filter((result): result is T => result !== null);
}

/** A session-environment listing line gives `name` a usable value: an exact `NAME=` line whose value is not blank
 *  (any such line counts). A removed (`-NAME`), empty or whitespace-only entry does not. */
function usableEnvLine(lines: readonly string[], name: string): boolean {
  const prefix = `${name}=`;
  return lines.some((line) => line.startsWith(prefix) && line.slice(prefix.length).trim().length > 0);
}

export class TmuxAdapter {
  /** Read for each new agent/successor. Unconfigured adapters retain legacy behavior. */
  launchEnvironment?: () => { inheritTmuxEnvironment: boolean; env: Readonly<Record<string, string | undefined>>;
    /** The runtime directory a seat gets when it has none of its own (seat-runtime-dir.ts); none on macOS. */
    runtimeDir?: string };

  /** Reset before the selected user shell runs, without changing the server or other sessions.
   * Multiple tmux command arguments execute directly; only this fixed non-interactive sh runs
   * before env -i. Generated pane metadata must come from this spawn, never daemon TMUX values.
   * Keep the configured default-command and default-shell lookup, including rc functions.
   */
  private async scopedLaunchCommand(seatEnv: Record<string, string>, command?: string, warnings: string[] = [], staged?: (file: string, recoveryEnv?: Record<string,string>) => void): Promise<string[] | null> {
    if (!this.launchEnvironment || !seatEnv.OPENRIG_NODE_ID) return null;
    try {
      const policy = this.launchEnvironment();
      if (policy.inheritTmuxEnvironment) return null;
      let shell = await this.getDefaultShell();
      // tmux reads these options from a running server. The first seat on a new server starts the empty server here,
      // as a first start does, so it gets the same scoped environment as every later seat (#2041).
      if (!shell && (await this.startServer()).ok) shell = await this.getDefaultShell();
      if (!shell) throw new Error("Default shell unavailable");
      if (command === undefined) {
        // Stock psmux aliases default-command to default-shell, which already
        // carries its startup arguments. Preserve upstream tmux decoding on POSIX.
        if (process.platform === "win32") command = "";
        else {
        command = (await this.run(["tmux", "show-options", "-gv", "default-command"])).replace(/\r?\n$/, "");
        // The server, not the connecting client, formats option output. If its version is unavailable,
        // retain the readback unchanged rather than guessing about a user's command.
        try {
          const serverVersion = await this.run(["tmux", "display-message", "-p", "#{version}"]);
          command = decodeTmux34Option(command, serverVersion);
        } catch { /* unknown version: keep the original readback */ }
        }
      }
      // tmux normally copies these client values from the daemon on new-session.
      // Read its configured names, but never reuse values stored on the server.
      const updated = (await this.run(["tmux", "show-options", "-gv", "update-environment"]))
        .trim().split(/\s+/).filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
      const baseline = { ...Object.fromEntries(updated.map(key => [key, process.env[key]])), ...policy.env };
      removeParentSessionEnv(baseline);
      // A seat's own value (its env:, a one-off name, or a name in update-environment) wins over the runtime directory.
      const selected: Record<string, string | undefined> = { ...baseline, ...seatEnv };
      addSeatRuntimeDir(selected, policy.runtimeDir);
      if (process.platform === "win32") {
        const file = this.fileOps.tmpName();
        const key = `OPENRIG_LAUNCH_RECOVERY_${randomUUID().replace(/-/g, "")}`;
        const launch = windowsScopedLaunch(shell, command ?? "", selected, file, false, key);
        await this.fileOps.writeFile(file, launch.content, { mode: 0o600, flag: "wx" });
        const recoveryEnv = Object.fromEntries(Object.entries(selected).filter((entry): entry is [string,string] => entry[1] !== undefined));
        if (launch.recovery) recoveryEnv[launch.recovery.key] = launch.recovery.value;
        staged?.(file, recoveryEnv);
        return ["--", ...launch.argv];
      }
      const values = Object.entries(selected)
        .filter((entry): entry is [string,string] => entry[1] !== undefined && !["TMUX", "TMUX_PANE", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "SHELL"].includes(entry[0]))
        .map(([key,value]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid environment name");
          return `export ${key}=${shellQuote(value)}`;
        });
      const file = this.fileOps.tmpName();
      // Builtin exports keep values off env/sh argv; the pane owns removal once started.
      await this.fileOps.writeFile(file, `/bin/rm -f -- ${shellQuote(file)}\n${values.join("\n")}\nexec "$@"\n`, { mode: 0o600, flag: "wx" });
      // tmux supplies its terminal identity per pane; the daemon's terminal may be different.
      const reset = 'exec /usr/bin/env -i -- TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" TERM="$TERM" TERM_PROGRAM="${TERM_PROGRAM-}" TERM_PROGRAM_VERSION="${TERM_PROGRAM_VERSION-}" SHELL="$SHELL" /bin/sh "$@"';
      return ["/bin/sh", "-c", reset, "sh", file, shell, ...(command ? ["-c", command] : ["-l"])];
    } catch {
      // Keep the working launch, with a diagnostic; this option is not a new admission gate.
      const warning = "Scoped tmux environment unavailable; retaining the previous environment for this launch.";
      warnings.push(warning);
      console.warn(`[seat launch] ${warning}`);
      return null;
    }
  }

  private async discardUnstartedScopedBootstrap(file: string | undefined, error: unknown, duplicateSession = false): Promise<void> {
    if (!file || !(error instanceof Error)) return;
    const notStarted = (error as NodeJS.ErrnoException).syscall?.startsWith("spawn")
      || (duplicateSession && error.message.includes("duplicate session"));
    // A timeout or transport failure may have launched the consumer. Retain
    // its file; only positive no-start evidence releases this owned bootstrap.
    if (notStarted) await this.fileOps.unlink(file).catch(() => {});
  }

  private inputGuard?: SeatDeliveryGuard;
  get deliveryGuard(): SeatDeliveryGuard | undefined { return this.inputGuard; }
  set deliveryGuard(guard: SeatDeliveryGuard | undefined) {
    this.inputGuard = guard;
    guard?.attachInputInspection(async (target, owned) => inspectComposerInput(await (target.pane ? this.captureComposerSnapshot(target.pane) : this.captureSessionComposerSnapshot(target.session)), null, owned), async target => {
      if (!target.pane) return true;
      const probe = await this.probeSession(target.session);
      if (probe.state === "absent") return true;
      if (probe.state !== "present") return false;
      const panes = await this.listSessionPanes(target.session);
      return panes.length === 1 && panes[0]!.id === target.pane && await this.isPaneDead(target.pane);
    });
  }
  private readonly freshProbes = new Map<string, string>();
  private readonly freshManaged = new Map<string, {nodeId: string; pane: string}>();

  /** Only the private metadata probe uses this door. Success proves allocation,
   * never authority over a pre-existing or registry-managed target. */
  async createProbeSession(name: string, cwd?: string): Promise<TmuxResult> {
    if (this.deliveryGuard?.maybeTarget(name)) return { ok: false, code: "guard_target_managed", message: "A probe cannot reuse a managed seat." };
    // #188: the create itself reports the new session's id and creation time, the only identity a rollback
    // uses. An id alone is unique only for one server's lifetime.
    let created: { id: string; at: string } | null;
    try {
      const mapped = this.terminalKind === "psmux" && !!bindNativeSessionName(name).marker;
      const formattedName = mapped ? name : tmuxSessionNameFormat(name);
      const argv = ["tmux", "new-session", "-d", "-P", "-F", "#{session_id} #{session_created}", "-s", formattedName];
      if (cwd != null) argv.push("-c", cwd);
      const out = this.terminalKind === "psmux" && !mapped ? await this.nativeRaw(argv)
        : await this.run(argv, `tmux new-session -d -P -F ${shellQuote("#{session_id} #{session_created}")} -s ${shellQuote(formattedName)}${cwd != null ? ` -c ${shellQuote(cwd)}` : ""}`);
      const match = /^(\$\d+) (\d+)$/.exec(out.trim());
      created = match ? { id: match[1]!, at: match[2]! } : null;
    } catch (err) {
      return classifyWriteError(err);
    }
    let message = "New probe pane could not be established; no input written.";
    let pane: string | null = null;
    try {
      const panes = await this.listSessionPanes(name);
      pane = panes.length === 1 ? panes[0]!.id : null;
      // #188: a fresh tmux server reuses pane ids, so a stale seat binding can name the new pane. That
      // probe could not be cleaned up safely later, so it is not used.
      if (pane && this.deliveryGuard?.maybeTarget(pane)) message = "New probe pane is named by a managed record; no input written.";
      else if (pane) { this.freshProbes.set(name, pane); this.freshProbes.set(pane, pane); return { ok: true }; }
    } catch { /* no target proof, no input */ }
    // #188: remove the unusable helper by the id its own create returned, unless a managed record has
    // since claimed its name (a binding naming only the reused pane id, under another session name, is
    // stale: that pane belongs to this session). A name reused by another session has a different id.
    const byPane = pane ? this.deliveryGuard?.maybeTarget(pane) : null;
    if (!created || this.deliveryGuard?.maybeTarget(name) || byPane?.session === name) {
      return { ok: false, code: "guard_target_unknown", message: `${message} The helper session was left in place: its ownership could not be proven.` };
    }
    const removed = await this.removeCreatedSession(name, created);
    if (!removed.ok && removed.code !== "session_not_found") message += ` The helper session was not removed: ${removed.message}`;
    return { ok: false, code: "guard_target_unknown", message };
  }

  /** #188: kill the session this adapter created only while its id still names that session. tmux checks
   *  the name and creation time and kills in one command, so a later server that reuses the id is safe. */
  private async removeCreatedSession(name: string, created: { id: string; at: string }): Promise<TmuxResult> {
    try {
      const physical = this.terminalKind === "psmux" ? await this.nativeBoundName(name) : name;
      const same = `#{&&:#{==:#{session_name},${tmuxFormatLiteral(physical)}},#{==:#{session_created},${created.at}}}`;
      // Native session ids are local to one server and are not psmux client
      // selectors. Select its physical server, check the full create receipt,
      // then kill SELF inside that conditional, as the native stop path does.
      const out = this.terminalKind === "psmux"
        ? await this.nativeRaw(["tmux", "-t", "=" + physical, "if-shell", "-F", `#{&&:${same},#{==:#{session_id},${created.id}}}`, "kill-session", "display-message -p kept"])
        : await this.run(["tmux", "if-shell", "-F", "-t", created.id, same, `kill-session -t '${created.id}'`, "display-message -p kept"],
          `tmux if-shell -F -t ${shellQuote(created.id)} ${shellQuote(same)} ${shellQuote(`kill-session -t '${created.id}'`)} ${shellQuote("display-message -p kept")}`, name);
      if (out.includes("kept")) return { ok: false, code: "guard_target_changed", message: `its id ${created.id} no longer names it (it may already be gone); nothing was killed.` };
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  private async guardedInput(target: string, write: (pane: string, beforeWrite: () => void) => Promise<TmuxResult>, allowAbsent = false, inputKind: "control" | "text" | "keys" | "respawn" = "control"): Promise<TmuxResult> {
    const guard = this.deliveryGuard;
    if (!guard) return write(target, () => {});
    try {
      const probePane = this.freshProbes.get(target);
      if (probePane && !guard.maybeTarget(target)) {
        const panes = target === probePane ? await this.listPanes(target) : await this.listSessionPanes(target);
        if (panes.length !== 1 || panes[0]!.id !== probePane) throw new Error("Private probe target changed; no input written.");
        // Awaited so a refusal inside the write (#188: the probe kill) returns as a result, not a throw.
        return await write(probePane, () => {});
      }
      const created = this.freshManaged.get(target);
      const identity = created?.nodeId ?? target;
      return await guard.input(identity, async () => {
        const bound = guard.target(identity);
        const fresh = created?.nodeId === bound.nodeId && guard.ownsLifecycle(bound.nodeId);
        let panes: TmuxPane[];
        try { panes = await this.listSessionPanes(fresh ? target : bound.session); }
        catch (error) {
          guard.checkInput(identity);
          const result = classifyWriteError(error);
          // Only termination consumes positive absence. Unknown probe failures
          // still refuse, and guard-on never reaches this observation.
          if (allowAbsent && !result.ok
            && !/permission denied|operation not permitted|EACCES|EPERM/i.test(result.message)) {
            if (result.code === "session_not_found") return result;
            // list-panes reports a missing session as "can't find window" on
            // native tmux. Do not broaden write-error classification: only
            // termination may confirm the bound session's positive absence.
            if (/can't find window/i.test(result.message)) {
              const probe = await this.probeSession(bound.session);
              guard.checkInput(identity);
              if (probe.state === "absent") return { ok: false, code: "session_not_found", message: result.message };
            }
          }
          throw error;
        }
        const pane = fresh ? created.pane : bound.pane;
        const delivery = inputKind === "text" || inputKind === "keys";
        if (!pane || (delivery ? !panes.some(candidate => candidate.id === pane) : panes.length !== 1 || panes[0]!.id !== pane)) {
          throw new Error("Managed pane identity unavailable or changed; no input written. If the seat's pane was never recorded, rig reconcile-session <seat> --repair-missing-pane --no-launch fills it (with typing protection off).");
        }
        if (inputKind === "control" && guard.needsInputCheck(identity)) await guard.beforeInput(identity);
        if (inputKind === "respawn" && guard.needsInputCheck(identity)) {
          if (!guard.ownsLifecycle(bound.nodeId) || !await this.isPaneDead(pane)) {
            throw new DeliveryGuardError("draft_aware_lifecycle", "Only a dead pane in its lifecycle operation may be respawned under draft-aware protection.");
          }
        }
        // Revalidate registry/occupant after the asynchronous observation. Write
        // to the immutable pane ID, not a session name which could be recycled.
        return guard.input(identity, () => write(pane, () => guard.checkInput(identity)));
      });
    } catch (error) {
      return { ok: false, code: (error as { code?: string }).code ?? "guard_target_unknown", message: String((error as Error).message) };
    }
  }


  /** Explicit internal human input; transport HTTP options cannot select this. */
  humanInput<T>(target: string, fn: () => Promise<T>): Promise<T> {
    return this.deliveryGuard ? this.deliveryGuard.humanInput(target, fn) : fn();
  }

  operation<T>(target: string, fn: () => Promise<T>): Promise<T> {
    return this.deliveryGuard ? this.deliveryGuard.operation(target, fn) : fn();
  }

  constructor(
    private exec: ExecFn,
    private fileOps: TmuxFileOps = defaultTmuxFileOps(),
    private argvExec?: ArgvExecFn,
    serverArgs: readonly string[] | "tmux" | "psmux" = [],
    terminalKind: "tmux" | "psmux" = "tmux",
  ) {
    this.serverArgs = typeof serverArgs === "string" ? [] : [...serverArgs];
    this.terminalKind = typeof serverArgs === "string" ? serverArgs : terminalKind;
  }

  private readonly serverArgs: readonly string[];
  private readonly terminalKind: "tmux" | "psmux";

  private async nativeRaw(argv: string[], env?: Readonly<Record<string, string | undefined>>): Promise<string> {
    if (!this.argvExec || (env && !this.argvExec.supportsEnvironment)) throw new Error("Native session-name mapping requires argv transport");
    const targeted = this.serverArgs.length ? [argv[0]!, ...this.serverArgs, ...argv.slice(1)] : argv;
    return env ? this.argvExec(targeted, { env }) : this.argvExec(targeted);
  }

  /** Session-name APIs must not parse a logical colon as a window separator. */
  private async runNamedSession(argv: string[], name: string, legacy?: string, pane = false, windowIndex?: number): Promise<string> {
    if (this.terminalKind !== "psmux" || !name.includes(":")) return this.run(argv, legacy);
    const flag = argv.indexOf("-t");
    if (flag < 1) throw new Error("Named session command lacks target");
    // Compatibility APIs also accept explicit scoped addresses. Only the
    // actual target operand can select that path, never an option value.
    if (/^psmux:[A-Za-z0-9_-]+:[%$@]\d+$/.test(argv[flag + 1] ?? "")) return this.run(argv, legacy);
    const physical = await this.nativeBoundName(name), selected = [...argv];
    selected[flag + 1] = `=${physical}${pane ? ":" + (windowIndex ?? "") : ""}`;
    return this.nativeRaw(selected);
  }

  private async nativeSessionExists(physical: string): Promise<boolean> {
    try { await this.nativeRaw(["tmux", "has-session", "-t", `=${physical}`]); return true; }
    catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; signal?: unknown; killed?: boolean };
      if ((failure.code === 1 && failure.stdout === "" && failure.stderr === "" && !failure.signal && !failure.killed)
        || isSessionAbsenceError(tmuxReportedError(error))) return false;
      throw error;
    }
  }

  private async nativeLegacyName(logical: string): Promise<boolean> {
    if (!nativeSessionNameMayBeLegacy(logical) || !await this.nativeSessionExists(logical)) return false;
    return !(await this.nativeRaw(["tmux", "show-options", "-qv", "-t", `=${logical}:`, NATIVE_LOGICAL_SESSION_OPTION])).trim();
  }

  private async nativeBoundName(logical: string): Promise<string> {
    const binding = bindNativeSessionName(logical);
    if (!binding.marker) return logical;
    const present = await this.nativeSessionExists(binding.physical);
    const marker = present ? (await this.nativeRaw(["tmux", "show-options", "-qv", "-t", `=${binding.physical}:`, NATIVE_LOGICAL_SESSION_OPTION])).trim() : undefined;
    const legacy = await this.nativeLegacyName(logical);
    if (logicalNameFromNativeBinding(binding.physical, marker) === logical) {
      if (legacy) throw new Error("Ambiguous native logical session name; legacy and mapped sessions both exist");
      return binding.physical;
    }
    if (legacy) return logical;
    if (!present) throw new Error(`can't find session: ${logical}`);
    throw new Error("Native session name has no matching logical identity marker");
  }

  private async nativeObservedName(physical: string): Promise<string> {
    if (this.terminalKind !== "psmux" || !isEncodedNativeSessionName(physical)) return physical;
    const marker = (await this.nativeRaw(["tmux", "show-options", "-qv", "-t", `=${physical}:`, NATIVE_LOGICAL_SESSION_OPTION])).trim();
    return logicalNameFromNativeBinding(physical, marker) ?? physical;
  }

  private async nativeBoundTarget(target: string): Promise<string> {
    const scoped = /^psmux:([A-Za-z0-9_-]+):([%$@]\d+)$/.exec(target);
    if (scoped) {
      const logical = Buffer.from(scoped[1]!, "base64url").toString("utf8");
      const physical = await this.nativeBoundName(logical);
      return `psmux:${Buffer.from(physical).toString("base64url")}:${scoped[2]}`;
    }
    if (/^[%@$]\d+$/.test(target)) return target;
    const exact = target.startsWith("=") ? "=" : "", body = target.slice(exact.length);
    const separator = body.indexOf(":"), logical = separator < 0 ? body : body.slice(0, separator);
    if (!logical) return target;
    return exact + await this.nativeBoundName(logical) + (separator < 0 ? "" : body.slice(separator));
  }

  /** Prefix one adapter-owned tmux invocation, including its chained commands.
   * The daemon's explicit server wins over an inherited TMUX or wrapper socket. */
  private onServer(command: string): string {
    return this.serverArgs.length ? `tmux ${posixJoinArgv([...this.serverArgs])}${command.slice(4)}` : command;
  }

  /** Whether pane commands run in the native Windows multiplexer. */
  get isNativeWindows(): boolean {
    return this.terminalKind === "psmux" && process.platform === "win32";
  }

  /**
   * Run a multiplexer command. `argv` is what is EXECUTED on both paths:
   * elements are verbatim (no quoting layer) when argvExec is wired;
   * otherwise they are POSIX-joined — byte-identical to the legacy
   * template strings for all current call sites (the suite pins them).
   * `legacy` overrides the joined form only where history quoted
   * differently (the `-F "..."` double-quoted formats); pass it ONLY to
   * preserve an exact legacy string, never to smuggle new semantics.
   */
  private async run(argv: string[], legacy?: string, bufferScope?: string, env?: Readonly<Record<string,string|undefined>>): Promise<string> {
    let createdBinding: ReturnType<typeof bindNativeSessionName> | undefined;
    if (this.terminalKind === "psmux") {
      if (argv[1] === "new-session") {
        const nameFlag = argv.indexOf("-s"), logical = argv[nameFlag + 1];
        if (nameFlag > 1 && logical) {
          const binding = bindNativeSessionName(logical);
          if (binding.marker) {
            if (await this.nativeLegacyName(logical) || await this.nativeSessionExists(binding.physical)) throw new Error("duplicate session: mapped native name is already occupied; existing session was not modified");
            const format = argv[argv.indexOf("-F") + 1];
            if (!argv.includes("-P") || !["#{pane_id}", "#{session_id} #{session_created}"].includes(format ?? "")) throw new Error("Mapped session creation requires an explicit creation receipt");
            createdBinding = binding; argv = [...argv]; argv[nameFlag + 1] = binding.physical; legacy = undefined;
          } else {
            const formatted = tmuxSessionNameFormat(logical);
            if (formatted !== logical) { argv = [...argv]; argv[nameFlag + 1] = formatted; legacy = undefined; }
          }
        }
      }
      // Only the command's first target operand can carry routing metadata.
      // Option values, key payloads and child argv are literal user data even
      // when their bytes happen to equal a scoped pane identifier.
      const end = argv.indexOf("--");
      const targetOption = argv[1] === "detach-client" ? "-s" : "-t";
      const targetFlag = argv.findIndex((arg, index) => index > 1 && (end < 0 || index < end) && arg === targetOption);
      const targetIndex = targetFlag < 0 ? -1 : targetFlag + 1;
      if (targetIndex > 0 && argv[targetIndex]) {
        const mapped = await this.nativeBoundTarget(argv[targetIndex]!);
        if (mapped !== argv[targetIndex]) { argv = [...argv]; argv[targetIndex] = mapped; legacy = undefined; }
      }
      if (bufferScope) bufferScope = await this.nativeBoundTarget(bufferScope);
      const scopedArg = targetIndex > 0 && /^psmux:[A-Za-z0-9_-]+:[%$@]\d+$/.test(argv[targetIndex] ?? "") ? argv[targetIndex] : undefined;
      const scoped = scopedArg ?? bufferScope;
      if (scoped) {
        const [, encoded, pane] = scoped.split(":");
        const session = scoped.startsWith("psmux:") ? Buffer.from(encoded!, "base64url").toString("utf8") : scoped;
        // psmux selects the server AND the initial target from the first -t.
        // Some client commands (notably send-keys) consume the later -t and
        // omit it from their control request. Carry the immutable pane/window
        // in the first target too; session-only routing would hit its active pane.
        const target = scopedArg && pane!.startsWith("%") ? `=${session}:.${pane}`
          : scopedArg && pane!.startsWith("@") ? `=${session}:${pane}` : `=${session}`;
        argv = [argv[0]!, "-t", target, ...argv.slice(1).map((a, index) => scopedArg && index + 1 === targetIndex ? pane! : a)];
        legacy = undefined;
      }
    }
    if (createdBinding?.marker) {
      const output = await this.nativeRaw(argv, env), receipt = output.trim();
      const sessionReceipt = /^(\$\d+) (\d+)$/.exec(receipt);
      if (!/^%\d+$/.test(receipt) && !sessionReceipt) throw new Error("Mapped native session creation was not confirmed; session retained");
      const target = `=${createdBinding.physical}:`;
      const condition = sessionReceipt
        ? `#{&&:#{==:#{session_id},${sessionReceipt[1]}},#{==:#{session_created},${sessionReceipt[2]}}}`
        : `#{==:#{pane_id},${receipt}}`;
      const refused = `openrig-name-binding-refused-${randomUUID()}`;
      const bound = await this.nativeRaw(["tmux", "if-shell", "-F", "-t", target, condition,
        `set-option -t ${shellQuote(target)} ${NATIVE_LOGICAL_SESSION_OPTION} ${createdBinding.marker}`, `display-message -p ${refused}`]);
      if (bound.includes(refused)) throw new Error("Mapped native session identity changed before binding; session retained");
      await this.nativeBoundName(createdBinding.logical);
      return output;
    }
    const targeted = this.serverArgs.length ? [argv[0]!, ...this.serverArgs, ...argv.slice(1)] : argv;
    if (env) {
      if (!this.argvExec?.supportsEnvironment) throw new Error("Native process environment transport unavailable");
      return this.argvExec(targeted,{env});
    }
    if (this.argvExec) return this.argvExec(targeted);
    return this.exec(legacy ? this.onServer(legacy) : posixJoinArgv(targeted));
  }

  /** Environment-bearing commands travel in a private config, never a client's argv.
   * Values stay in tmux's session environment, including for later panes. No global mutation.
   * A failed/uncertain call retains its private file: it may not have been consumed yet.
   */
  private async runEnvironmentCommand(argv: string[], legacy?: string, startServer = false, protectedLaunch = false): Promise<string> {
    // Stock psmux 3.4 cannot bootstrap new-session through source-file. A
    // versioned candidate accepts file references without serializing values.
    if (this.terminalKind === "psmux") {
      const capability = "openrig-envfile-v1:new-session,respawn-pane";
      let supported = false;
      try {
        supported = (await this.run(["tmux", "openrig-private-environment-capability"])).trim() === capability;
      } catch (error) {
        // Stock 3.4.0 explicitly rejects this command. An unavailable transport
        // is not evidence of an unsupported protocol and must not trigger retry.
        if (!/unknown command: openrig-private-environment-capability/i.test(String(error))) throw error;
      }
      if (!supported) return this.runStockPrivateEnvironmentCommand(argv, protectedLaunch);
      if (!this.fileOps.privateConfig) throw new Error("Native private environment file writer unavailable");
      const entries: [string, string][] = [];
      const rewritten: string[] = [];
      let referenceIndex = -1;
      for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]!;
        if (arg === "--") { rewritten.push(...argv.slice(index)); break; }
        if (arg !== "-e") { rewritten.push(arg); continue; }
        const assignment = argv[++index] ?? "";
        const separator = assignment.indexOf("=");
        const key = assignment.slice(0, separator), value = assignment.slice(separator + 1);
        if (separator < 1 || !isWindowsPrivateEnvironmentName(key) || value.includes("\0")) throw new Error("Invalid environment assignment");
        entries.push([key, value]);
        if (referenceIndex < 0) { rewritten.push("-e", ""); referenceIndex = rewritten.length - 1; }
      }
      // The advertised v1 -e protocol keeps identifier names; Windows names
      // outside that grammar use the established private source-file API.
      const extra = entries.filter(([key]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
      const content = JSON.stringify({ schema: "openrig.psmux.environment/v1", entries: entries.filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) });
      if (referenceIndex < 0) return this.run(argv, legacy);
      if (Buffer.byteLength(content, "utf8") > 1024 * 1024) throw new Error("Native environment file exceeds protocol limit");
      const file = await this.fileOps.privateConfig(content);
      rewritten[referenceIndex] = `@openrig-env-v1:${file.path}`;
      // Retain on an uncertain/failed command: a server may still be reading it.
      // No fallback containing values is attempted after protocol selection.
      const output = await this.run(rewritten);
      if (extra.length) {
        const creating = argv[1] === "new-session", targetIndex = argv.indexOf(creating ? "-s" : "-t"), target = argv[targetIndex+1];
        if (targetIndex < 0 || !target) throw new Error("Native environment command lacks its exact target");
        const supplement = await this.fileOps.privateConfig(extra.map(([key,value]) => psmuxPrivateEnvironmentLine(key,value)).join(""));
        const supplementArgv = ["tmux","source-file","-t",creating ? exactTarget(target,"session") : target,supplement.path];
        if (creating) await this.runNamedSession(supplementArgv, target); else await this.run(supplementArgv);
        await supplement.dispose().catch(()=>{});
      }
      await file.dispose().catch(() => {});
      return output;
    }
    const file = this.fileOps.tmpName();
    await this.fileOps.writeFile(file, (legacy ?? posixJoinArgv(argv)).slice("tmux ".length) + "\n", { mode: 0o600, flag: "wx" });
    const output = await this.run(["tmux", ...(startServer ? ["start-server", ";"] : []), "source-file", file]);
    await this.fileOps.unlink(file).catch(() => {});
    return output;
  }

  /** Stock psmux has no file-valued -e. Supply the first child through a private
   * bootstrap, then persist session values through its existing source-file API. */
  private async runStockPrivateEnvironmentCommand(argv: string[], protectedLaunch: boolean): Promise<string> {
    const entries: Record<string, string> = {}, rewritten: string[] = [];
    let command: string[] = [];
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index]!;
      if (arg === "--") { command = argv.slice(index); break; }
      if (arg !== "-e") { rewritten.push(arg); continue; }
      const assignment = argv[++index] ?? "", separator = assignment.indexOf("=");
      const key = assignment.slice(0, separator), value = assignment.slice(separator + 1);
      if (separator < 1 || !isWindowsPrivateEnvironmentName(key) || value.includes("\0")) throw new Error("Invalid environment assignment");
      entries[key] = value;
    }
    if (!Object.keys(entries).length) return this.run(argv);
    if (!this.fileOps.privateConfig) throw new Error("Native private environment file writer unavailable");
    const creating = argv[1] === "new-session";
    const targetIndex = rewritten.indexOf(creating ? "-s" : "-t");
    const target = rewritten[targetIndex + 1];
    if (targetIndex < 0 || !target) throw new Error("Native environment command lacks its exact target");
    let bootstrap: string | undefined;
    if (!protectedLaunch) {
      // A respawn's legacy raw command is the last argument after its options.
      let userCommand = "";
      if (!creating && !command.length) {
        const last = rewritten.at(-1)!;
        const previous = rewritten.at(-2);
        if (previous !== "-t" && previous !== "-c" && rewritten.length > 2) userCommand = rewritten.pop()!;
      }
      let shell = await this.getDefaultShell();
      if (!shell && (await this.startServer()).ok) shell = await this.getDefaultShell();
      if (!shell) throw new Error("Default shell unavailable for private environment launch");
      if (command.length) throw new Error("Unrecognized native command boundary for private environment launch");
      bootstrap = this.fileOps.tmpName();
      const recoveryKey = `OPENRIG_LAUNCH_RECOVERY_${randomUUID().replace(/-/g, "")}`;
      const launch = windowsScopedLaunch(shell, userCommand, entries, bootstrap, true, recoveryKey);
      await this.fileOps.writeFile(bootstrap, launch.content, { mode: 0o600, flag: "wx" });
      if (launch.recovery) entries[launch.recovery.key] = launch.recovery.value;
      command = ["--", ...launch.argv];
    }
    const config = await this.fileOps.privateConfig(Object.entries(entries).map(([key, value]) => psmuxPrivateEnvironmentLine(key, value)).join(""));
    try {
      // Keep the control client's binary/config/registry selection pinned to
      // the daemon. The private bootstrap separately supplies the child's full
      // selected environment, including its own PATH and home settings.
      const creationEnv = Object.fromEntries(Object.entries(entries).filter(([key]) =>
        !/^(?:PSMUX_.*|TMUX(?:_.*)?|TERM(?:_.*)?|SHELL|PATH|PATHEXT|SYSTEMROOT|WINDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP)$/i.test(key)));
      const output = await this.run([...rewritten, ...command], undefined, undefined,
        creating && this.argvExec?.supportsEnvironment ? creationEnv : undefined);
      const persistArgv = ["tmux", "source-file", "-t", creating ? exactTarget(target, "session") : target, config.path];
      if (creating) await this.runNamedSession(persistArgv, target); else await this.run(persistArgv);
      await config.dispose().catch(() => {});
      return output;
    } catch (error) {
      await this.discardUnstartedScopedBootstrap(bootstrap, error, creating);
      // A command may have launched. Never repeat it or expose values in argv.
      throw error;
    }
  }

  /** Ends the daemon's tmux control client, and with it its session (tmux-control.ts), when tmux is driven through one. */
  async closeControlClient(): Promise<void> {
    await (this.argvExec as Partial<TmuxControlExec> | undefined)?.close?.();
  }

  /** Start an empty native terminal server, without inventing a seat/session. */
  async startServer(): Promise<TmuxResult> {
    const probeName = `openrig-startup-${randomUUID()}`;
    try {
      if (this.isNativeWindows) {
        if (await this.getDefaultShell()) return { ok: true };
        // psmux hides its warm standby unless exit-empty is disabled there.
        // A queued command is routed to that standby before it has a session.
        await this.run(["tmux", "start-server", ";", "set-option", "-g", "exit-empty", "off"]);
        return await this.getDefaultShell()
          ? { ok: true }
          : { ok: false, code: "tmux_unavailable", message: "The native terminal server did not become available." };
      }
      if ((await this.probeSession(probeName)).state !== "transport_unavailable") return { ok: true };
      // tmux -D keeps an empty server alive. Stays on the shell-string path
      // deliberately: detach + stdio redirection have no argv equivalent,
      // and server bootstrap is POSIX-specific (psmux auto-starts its own).
      // Native socket ownership arbitrates
      // concurrent starts; the readback below, not shell exit, proves availability.
      await this.exec(this.onServer("tmux -D </dev/null >/dev/null 2>&1 &"));
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if ((await this.probeSession(probeName)).state !== "transport_unavailable") return { ok: true };
      }
      return { ok: false, code: "tmux_unavailable", message: "The terminal server did not become available. Check tmux and its socket permissions." };
    } catch (error) {
      return { ok: false, code: "tmux_unavailable", message: `Terminal server unavailable: ${(error as Error).message}` };
    }
  }

  async listSessions(): Promise<TmuxSession[]> {
    try {
      const output = await this.run(["tmux", "list-sessions", "-F", SESSION_FORMAT],
        `tmux list-sessions -F "${SESSION_FORMAT}"`);
      return await Promise.all(parseLines(output, parseSessionLine).map(async session => ({ ...session, name: await this.nativeObservedName(session.name) })));
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  async listWindows(sessionName: string): Promise<TmuxWindow[]> {
    try {
      const output = await this.run(["tmux", "list-windows", "-t", sessionName, "-F", WINDOW_FORMAT],
        `tmux list-windows -t ${shellQuote(sessionName)} -F "${WINDOW_FORMAT}"`);
      return parseLines(output, parseWindowLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  async listSessionWindows(name: string): Promise<TmuxWindow[]> {
    const target = "=" + name;
    const output = await this.runNamedSession(["tmux", "list-windows", "-t", target, "-F", WINDOW_FORMAT], name,
      `tmux list-windows -t ${shellQuote(target)} -F "${WINDOW_FORMAT}"`);
    return parseLines(output, parseWindowLine);
  }

  /** Session identity is explicit, including native names containing target punctuation. */
  async listSessionPanes(name: string, allWindows = false, windowIndex?: number): Promise<TmuxPane[]> {
    if (windowIndex !== undefined && (!Number.isSafeInteger(windowIndex) || windowIndex < 0)) throw new Error("Invalid window index");
    return this.listPanes(name, allWindows, true, windowIndex);
  }

  async listPanes(target: string, allWindows = false, literalSessionName = false, windowIndex?: number): Promise<TmuxPane[]> {
    // Callers name a session (optionally with a window), or an immutable tmux
    // id. Exact session matching prevents observing a prefix neighbor's pane.
    // A bare leading '=' belongs to the literal session name. Only qualified
    // targets already carry tmux's encoded exact-match syntax.
    const namedTarget = target.includes(":") && target.startsWith("=") ? target : `=${target}`;
    const exactTarget = literalSessionName ? `=${target}:${windowIndex ?? ""}` : target.startsWith("psmux:") ? target : /^[%$@]\d+$/.test(target) ? target
      : namedTarget.includes(":") ? namedTarget : `${namedTarget}:`;
    try {
      const format = this.terminalKind === "psmux" ? `#{session_name}|${PANE_FORMAT}` : PANE_FORMAT;
      const argv = ["tmux", "list-panes", ...(allWindows ? ["-s"] : []), "-t", exactTarget, "-F", format];
      const legacy = `tmux list-panes ${allWindows ? "-s " : ""}-t ${shellQuote(exactTarget)} -F "${format}"`;
      const output = literalSessionName ? await this.runNamedSession(argv, target, legacy, true, windowIndex) : await this.run(argv, legacy);
      if (this.terminalKind === "psmux") {
        const rows = parseLines(output, line => {
          const separator = line.indexOf("|");
          if (separator <= 0) return null;
          const session = line.slice(0, separator);
          const pane = parsePaneLine(line.slice(separator + 1));
          if (!pane || !/^%\d+$/.test(pane.id)) return null;
          // psmux has one server per session: %1 is NOT globally unique.
          // Persist its scope with the immutable pane id, never its mutable index.
          return { pane, session };
        });
        const names = new Map<string, Promise<string>>();
        return await Promise.all(rows.map(async ({ pane, session }) => {
          if (!names.has(session)) names.set(session, this.nativeObservedName(session));
          return { ...pane, id: `psmux:${Buffer.from(await names.get(session)!).toString("base64url")}:${pane.id}` };
        }));
      }
      return parseLines(output, parsePaneLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  /**
   * Classified session probe (OPR.0.5.4.2): the three error classes tmux
   * produces are distinct answers, and the adapter must not decide for its
   * callers that a transport failure means absence.
   * - `absent` requires POSITIVE tmux evidence (the can't-find-session class).
   * - `transport_unavailable` is the no-server / socket-gone class: whether
   *   the session exists was NOT determined.
   * - Unexpected probe failures (permission denied, etc.) rethrow so callers
   *   fail closed rather than treating a probe failure as an answer.
   */
  async probeSession(name: string): Promise<SessionProbe> {
    try {
      // Use `tmux has-session` directly for reliable existence check — avoids
      // parsing format-string output from `list-sessions` which can fail when
      // tab delimiters are malformed across tmux versions.
      const target = `=${name}`; // canonical session name, never a prefix lookup
      await this.runNamedSession(["tmux", "has-session", "-t", target], name,
        `tmux has-session -t ${shellQuote(target)}`);
      return { state: "present" }; // exit 0 = session exists
    } catch (err) {
      const error = tmuxReportedError(err);
      // psmux's has-session returns an empty exit 1 for an absent session.
      // Spawn/permission/transport failures carry diagnostics or a different code.
      const native = err as { code?: unknown; stdout?: unknown; stderr?: unknown; signal?: unknown; killed?: boolean };
      if (this.terminalKind === "psmux" && native.code === 1 && native.stdout === "" && native.stderr === ""
        && !native.signal && !native.killed) return { state: "absent" };
      if (isSessionAbsenceError(error)) {
        return { state: "absent" };
      }
      if (isNoServerError(error) || isTmuxTransportAbsentError(error)) {
        return { state: "transport_unavailable", cause: (error as Error).message };
      }
      throw err;
    }
  }

  /**
   * Collapsed presence view. Kept for the consumers outside the bound
   * send/capture/nudge/walk resolution path (OPR.0.5.4.2 mini-req 6 — their
   * adoption of the classification is a named follow-on). Callers that must
   * distinguish a transport blip from absence use probeSession().
   */
  async hasSession(name: string): Promise<boolean> {
    const probe = await this.probeSession(name);
    return probe.state === "present";
  }

  /** An unmanaged CLI watcher: literal child argv, with a creation receipt and native name binding. */
  async createDetachedCommandSession(name: string, command: readonly string[]): Promise<string> {
    if (this.deliveryGuard) throw new Error("Unmanaged command launch is unavailable on a guarded runtime adapter");
    if (!name || !command[0] || [name, ...command].some(word => word.includes("\0"))) throw new Error("Invalid terminal command argv");
    const escape = (word: string) => word.endsWith(";") ? word.slice(0, -1) + "\\;" : word;
    const mapped = this.terminalKind === "psmux" && !!bindNativeSessionName(name).marker;
    const formattedName = mapped ? name : tmuxSessionNameFormat(name);
    const argv = ["tmux", "new-session", "-d", "-P", "-F", "#{session_id} #{session_created}", "-s", mapped ? name : escape(formattedName),
      ...(this.terminalKind === "psmux" ? ["--"] : []), ...command.map(escape)];
    // Ordinary native names are already format-escaped; do not reinterpret
    // an escape backslash as a new logical name requiring another binding.
    const output = this.terminalKind === "psmux" && !mapped ? await this.nativeRaw(argv) : await this.run(argv);
    const receipt = /^(\$\d+) (\d+)$/.exec(output.trim());
    if (!receipt) throw new Error("Terminal command creation was not confirmed; any created session was retained");
    return receipt[1]!;
  }

  async createSession(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    const launchEnv = env === undefined ? undefined : { ...env };
    const nodeId = readPlatformEnv(launchEnv ?? {}, "OPENRIG_NODE_ID", this.isNativeWindows ? "win32" : "linux");
    if (this.deliveryGuard && (!nodeId || !this.deliveryGuard.ownsLifecycle(nodeId))) {
      return { ok: false, code: "guard_lease_required", message: "Managed launch requires a lifecycle lease before terminal creation." };
    }
    const result = await this.createSessionUnchecked(name, cwd, launchEnv);
    if (result.ok && this.deliveryGuard && nodeId) {
      try {
        const panes = await this.listSessionPanes(name);
        if (panes.length === 1) {
          this.deliveryGuard.noteFreshLifecyclePane(nodeId, panes[0]!.id);
          this.freshManaged.set(name, {nodeId, pane: panes[0]!.id});
        }
      } catch { /* no fresh pane proof: subsequent writes remain refused */ }
    }
    return result;
  }

  /** The committed binding now owns identity; this is not filesystem cleanup. */
  finishLaunchBinding(session: string): void { this.freshManaged.delete(session); }

  usesNativeRuntimeExchange(): boolean { return this.isNativeWindows; }

  /** Move attached predecessor clients before its server can be retired. A
   * failed/unconfirmed request is not retried here; recovery reobserves clients. */
  async followNativeRuntimeExchangeClients(nodeId: string, identity: NativeExchangeIdentity): Promise<TmuxResult> {
    try {
      const backend=this.nativeRuntimeExchangeTerminal(nodeId,identity);
      if(!backend.ownsLifecycle())throw new Error("Native client following requires its lifecycle lease");
      const slots=await backend.observe();
      if(slots.canonical.state!=="present" || slots.canonical.generation!==identity.successorGeneration
        || slots.parking.state!=="absent")throw new Error("Native exchange successor identity is not established");
      if(slots.staging.state==="absent")return {ok:true};
      if(slots.staging.state!=="present" || slots.staging.generation!==identity.predecessorGeneration){
        // Recovery may find the predecessor already terminated but its retained
        // pane/server not yet removed. Its identity still must match.
        if((await this.probeSession(identity.staging)).state!=="present"
          || await this.getSessionEnv(identity.staging,"OPENRIG_NODE_ID")!==nodeId
          || await this.getSessionEnv(identity.staging,"OPENRIG_OCCUPANT_GENERATION")!==identity.predecessorGeneration
          || (await this.listSessionPanes(identity.staging)).length!==1 || (await this.listSessionWindows(identity.staging)).length!==1) {
          throw new Error("Native exchange predecessor identity is not established");
        }
      }
      const clients=async()=>{
        const output=await this.run(["tmux","list-clients","-t",`=${identity.staging}`,"-F",CLIENT_FORMAT]);
        const rows=parseLines(output,parseClientLine);
        if(output.split(/\r?\n/).filter(line=>line.trim()!=="").length!==rows.length)throw new Error("Native attached-client listing is malformed");
        const rawCount=(await this.run(["tmux","display-message","-p","-t",`=${identity.staging}:`,"#{session_attached}"])).trim();
        // Stock psmux reports this format as a boolean, unlike tmux's count.
        if(!/^\d+$/.test(rawCount) || (Number(rawCount)>0)!==(rows.length>0))throw new Error("Native attached-client observation changed or is incomplete");
        return rows;
      };
      const attached=await clients();
      if(attached.some(client=>client.session!==identity.staging))throw new Error("Native client listing contains an unexpected session");
      for(const client of attached){
        if(!backend.ownsLifecycle())throw new Error("Native exchange lifecycle lease was lost");
        const refused=`openrig-native-client-refused-${randomUUID()}`;
        const condition=`#{&&:#{==:#{OPENRIG_NODE_ID},${nodeId}},#{==:#{OPENRIG_OCCUPANT_GENERATION},${identity.predecessorGeneration}}}`;
        const output=await this.run(["tmux","if-shell","-F","-t",`=${identity.staging}`,condition,
          `switch-client -c ${shellQuote(client.name)} -t ${shellQuote(`=${identity.canonical}`)}`,`display-message -p ${refused}`]);
        if(output.includes(refused))throw new Error("Native predecessor identity changed before client following");
      }
      // The native client reconnects asynchronously. Do not retire a server
      // while it still owns an attached client, including a newly attached one.
      for(let attempt=0;attempt<20;attempt++){
        if((await clients()).length===0){
          const current=await backend.observe();
          if(current.canonical.state!=="present" || current.canonical.generation!==identity.successorGeneration
            || current.parking.state!=="absent")throw new Error("Native successor identity changed during client following");
          return {ok:true};
        }
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw new Error("Native clients have not confirmed leaving the predecessor; its server was retained");
    }catch(error){return {ok:false,code:"native_client_follow_pending",message:(error as Error).message};}
  }

  /** Backend for the durable native name-exchange coordinator. It does not
   * retire servers, update bindings, or pretend that a rename preserves scope IDs. */
  nativeRuntimeExchangeTerminal(nodeId: string, identity: NativeExchangeIdentity): NativeExchangeTerminal {
    if (!this.isNativeWindows || !/^[A-Za-z0-9_-]{1,128}$/.test(nodeId)
      || nextNativeRuntimeExchangeStep(identity, {
        canonical: {state:"present",generation:identity.predecessorGeneration},
        staging: {state:"present",generation:identity.successorGeneration}, parking:{state:"absent"},
      }, "forward").state !== "rename") throw new Error("Invalid native runtime exchange backend or identity");
    const ownsLifecycle = () => !this.deliveryGuard || this.deliveryGuard.ownsLifecycle(nodeId);
    const observe = async (session: string): Promise<NativeExchangeSlot> => {
      try {
        const probe = await this.probeSession(session);
        if (probe.state === "absent") return {state:"absent"};
        if (probe.state !== "present") return {state:"unknown"};
        const panes = await this.listSessionPanes(session), windows = await this.listSessionWindows(session);
        if (panes.length !== 1 || windows.length !== 1 || await this.getSessionEnv(session,"OPENRIG_NODE_ID") !== nodeId) return {state:"unknown"};
        const generation = await this.getSessionEnv(session,"OPENRIG_OCCUPANT_GENERATION");
        const dead = (await this.run(["tmux","display-message","-p","-t",panes[0]!.id,"#{pane_dead}"])).trim();
        return generation && dead === "0" ? {state:"present",generation} : {state:"unknown"};
      } catch { return {state:"unknown"}; }
    };
    return {
      ownsLifecycle,
      observe: async () => ({canonical:await observe(identity.canonical),staging:await observe(identity.staging),parking:await observe(identity.parking)}),
      rename: async (from,to,generation) => {
        const names=[identity.canonical,identity.staging,identity.parking];
        if (!ownsLifecycle() || !names.includes(from) || !names.includes(to) || from===to
          || ![identity.predecessorGeneration,identity.successorGeneration].includes(generation)) throw new Error("Native exchange rename is outside its custody");
        if ((await this.probeSession(to)).state !== "absent") throw new Error("Native exchange destination is not proven absent");
        if (!ownsLifecycle()) throw new Error("Native exchange lifecycle lease was lost");
        const refused=`openrig-native-exchange-refused-${randomUUID()}`;
        const condition=`#{&&:#{==:#{OPENRIG_NODE_ID},${nodeId}},#{==:#{OPENRIG_OCCUPANT_GENERATION},${generation}}}`;
        const output=await this.run(["tmux","if-shell","-F","-t",`=${from}`,condition,
          `rename-session -t ${shellQuote(`=${from}`)} ${shellQuote(to)}`,`display-message -p ${refused}`]);
        if(output.includes(refused))throw new Error("Native exchange source occupant changed; no rename was performed");
        const destination=await observe(to), source=await observe(from);
        if(destination.state!=="present" || destination.generation!==generation || source.state!=="absent") {
          throw new Error("Native exchange rename outcome is unknown; reobserve before another write");
        }
      },
    };
  }

  /** Runtime switch (slice 16, from #1214 by Aschenbath): exchange the staged successor's pane with the seat's bound
   *  pane, so the seat's session keeps its name and the staging session holds the predecessor. Both memberships are
   *  checked by tmux at the write, and the same exchange undoes an uncommitted one. Requires the seat's lifecycle lease
   *  and the staging session this lease created. */
  async swapRuntimeSwitchPanes(input: { nodeId: string; stagingSession: string; canonicalSession: string; canonicalPane: string; stagedPane: string }): Promise<TmuxResult> {
    try {
      const created = this.freshManaged.get(input.stagingSession);
      if (this.deliveryGuard?.maybeTarget(input.stagingSession)) throw new Error("The staging session is now another seat's; nothing was exchanged.");
      if (this.deliveryGuard && (!this.deliveryGuard.ownsLifecycle(input.nodeId) || created?.nodeId !== input.nodeId || created.pane !== input.stagedPane)) {
        throw new Error("A runtime switch exchange requires the seat's lifecycle lease and its own staging pane.");
      }
      if (!/^%\d+$/.test(input.canonicalPane) || !/^%\d+$/.test(input.stagedPane)) throw new Error("Exact pane ids are required.");
      const canonical = await this.listSessionPanes(input.canonicalSession);
      const staged = await this.listSessionPanes(input.stagingSession);
      if (canonical.length !== 1 || canonical[0]!.id !== input.canonicalPane || staged.length !== 1 || staged[0]!.id !== input.stagedPane) {
        throw new Error("The seat's or the staging session's pane changed; nothing was exchanged.");
      }
      const sessionId = async (pane: string) => {
        const argv = ["tmux", "display-message", "-p", "-t", exactTarget(pane, "pane"), "#{session_id}"];
        const id = (await this.run(argv, posixJoinArgv(argv))).trim();
        if (!/^\$\d+$/.test(id)) throw new Error("A session's identity couldn't be established; nothing was exchanged.");
        return id;
      };
      const canonicalId = await sessionId(input.canonicalPane);
      const stagingId = await sessionId(input.stagedPane);
      this.deliveryGuard?.checkInput(input.nodeId);
      const mismatch = "display-message -p runtime-switch-target-changed";
      const swap = `swap-pane -d -s ${input.stagedPane} -t ${input.canonicalPane}`;
      const checkStaged = `if-shell -F -t ${input.stagedPane} ${shellQuote(`#{==:#{session_id},${stagingId}}`)} ${shellQuote(swap)} ${shellQuote(mismatch)}`;
      const argv = ["tmux", "if-shell", "-F", "-t", input.canonicalPane, `#{==:#{session_id},${canonicalId}}`, checkStaged, mismatch];
      const output = await this.run(argv, posixJoinArgv(argv));
      if (output.includes("runtime-switch-target-changed")) throw new Error("A pane moved at the exchange; nothing was exchanged.");
      // The staging session now holds the other pane; its retirement (or a rollback) addresses that one.
      this.freshManaged.set(input.stagingSession, { nodeId: input.nodeId, pane: input.canonicalPane });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "runtime_switch_target_changed", message: (error as Error).message };
    }
  }

  /** Recovery only: take back custody of a staging session a durable runtime-switch record names, after a restart.
   *  Its single pane, the seat it was made for and its generation must still match before it can be touched. */
  async adoptRuntimeSwitchStaging(input: { nodeId: string; stagingSession: string; pane: string; generations: string[] }): Promise<TmuxResult> {
    try {
      if (this.deliveryGuard && !this.deliveryGuard.ownsLifecycle(input.nodeId)) throw new Error("Runtime switch recovery requires the seat's lifecycle lease.");
      if (this.deliveryGuard?.maybeTarget(input.stagingSession)) throw new Error("The staging session is now another seat's; nothing was touched.");
      const panes = await this.listSessionPanes(input.stagingSession);
      const generation = await this.getSessionEnv(input.stagingSession, "OPENRIG_OCCUPANT_GENERATION");
      if ((await this.listSessionWindows(input.stagingSession)).length !== 1 || panes.length !== 1 || panes[0]!.id !== input.pane
        || await this.getSessionEnv(input.stagingSession, "OPENRIG_NODE_ID") !== input.nodeId
        || !generation || !input.generations.includes(generation)) {
        throw new Error("The staging session's identity changed; nothing was touched.");
      }
      this.freshManaged.set(input.stagingSession, { nodeId: input.nodeId, pane: input.pane });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "runtime_switch_target_changed", message: (error as Error).message };
    }
  }

  /** After a committed runtime switch: the seat's session carries the successor's runtime and generation, so a later
   *  pane or respawn in it starts as the successor's. The running successor already has them in its own process. */
  async setRuntimeSwitchEnvironment(session: string, runtime: string, generation: string): Promise<TmuxResult> {
    return this.guardedInput(session, async (_pane, beforeWrite) => {
      try {
        for (const [key, value] of [["OPENRIG_RUNTIME", runtime], ["OPENRIG_OCCUPANT_GENERATION", generation]] as const) {
          beforeWrite();
          const argv = ["tmux", "set-environment", "-t", exactTarget(session, "session"), key, value];
          await this.run(argv, posixJoinArgv(argv));
        }
        return { ok: true };
      } catch (error) { return classifyWriteError(error); }
    });
  }

  private async createSessionUnchecked(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    // These are the daemon's resolved capture settings, not seat overrides.
    // An empty per-session value prevents the tmux server's inherited values
    // from pinning an old policy over config.json inside a newly launched seat.
    // Explicit seat settings remain authoritative.
    const seatEnv: Record<string,string> = {
      OPENRIG_TRANSCRIPTS_LINES: "",
      OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "",
      ...env,
    };
    const warnings: string[] = [];
    let bootstrap: string | undefined;
    const scopedCommand = await this.scopedLaunchCommand(seatEnv, undefined, warnings, (file, recoveryEnv) => { bootstrap = file; Object.assign(seatEnv,recoveryEnv); });
    // These assignments enter our private transport, not literal psmux -e.
    // Identifier names use its versioned protocol; other representable Windows names
    // use private source-file persistence and are available to later recovery.
    const transportEnv = Object.entries(seatEnv).filter(([key]) =>
      !(this.isNativeWindows && scopedCommand) || isWindowsPrivateEnvironmentName(key));
    const formattedName = this.terminalKind === "psmux" ? name : tmuxSessionNameFormat(name);
    const argv = ["tmux", "new-session", "-d", "-s", formattedName];
    if (cwd != null) argv.push("-c", cwd);
    for (const [k, v] of transportEnv) argv.push("-e", `${k}=${v}`);
    // The pane new-session itself made: an after-new-session hook may select another window.
    argv.push("-P", "-F", "#{pane_id}");
    const legacyParts = ["tmux", "new-session", "-d", "-s", tmuxConfigQuote(formattedName)];
    if (cwd != null) legacyParts.push("-c", tmuxConfigQuote(cwd));
    for (const [k, v] of transportEnv) legacyParts.push("-e", tmuxConfigQuote(`${k}=${v}`));
    legacyParts.push("-P", "-F", tmuxConfigQuote("#{pane_id}"));
    if (scopedCommand) { argv.push(...scopedCommand); legacyParts.push(...scopedCommand.map(tmuxConfigQuote)); }
    let created: string;
    try {
      created = (await this.runEnvironmentCommand(argv, legacyParts.join(" "), true, !!scopedCommand)).trim();
    } catch (err) {
      await this.discardUnstartedScopedBootstrap(bootstrap, err, true);
      return classifyWriteError(err);
    }
    // tmux can exit 0 having made nothing: a server that can't create its socket prints its error and quits, and the
    // client still exits 0. new-session prints the pane it made; with none, the session must be read back before the
    // launch counts as created.
    if (!/^%\d+$/.test(created)) {
      const unconfirmed = await this.sessionUnconfirmedAfterCreate(name);
      if (unconfirmed) return { ok: false, ...unconfirmed };
    }
    // A tmux server started from a Claude Code session or Herdr pane hands
    // their identity to every new pane. Mark it removed for this session only
    // and restart the fresh pane so its shell starts without it. The session
    // exists either way, so a failure here is a warning, never a failed launch.
    try {
      if (await this.excludeParentSessionEnv(exactTarget(name, "session"), Object.keys(seatEnv)) && !scopedCommand) {
        if (!/^%\d+$/.test(created)) throw new Error(`new-session reported no pane id ("${created}"), so no pane was restarted`);
        const respawn = ["tmux", "respawn-pane", "-k", "-t", created];
        if (cwd != null) respawn.push("-c", cwd);
        await this.run(respawn, posixJoinArgv(respawn));
      }
      return warnings.length ? { ok: true, warnings } : { ok: true };
    } catch (err) {
      return { ok: true, warnings: [...warnings, parentSessionEnvWarning(name, err)] };
    }
  }

  /** When new-session printed no pane: why the launch can't count as created, or null when the session is there. Only a
   *  found session keeps the launch. A positive "can't find session" says it wasn't created; a probe that couldn't reach or
   *  read tmux says creation couldn't be confirmed, which isn't absence. */
  private async sessionUnconfirmedAfterCreate(name: string): Promise<{ code: "session_not_created" | "session_unconfirmed"; message: string } | null> {
    const lead = "tmux returned exit status 0 without a usable pane id";
    let cause: string;
    try {
      const probe = await this.probeSession(name);
      if (probe.state === "present") return null;
      if (probe.state === "absent") return { code: "session_not_created", message: `${lead}, and no session "${name}" exists (can't find session: ${name}).` };
      cause = probe.cause ?? "no tmux server";
    } catch (err) {
      const reported = tmuxReportedError(err);
      cause = reported instanceof Error ? reported.message : String(reported);
    }
    // tmux's own words, without an exec wrapper's "Command failed: <command>" line.
    const said = cause.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("Command failed:")).join(" ") || cause.trim();
    return { code: "session_unconfirmed", message: `${lead}; creation of session "${name}" could not be confirmed (${said}). Check that tmux `
      + "can create its server socket: the TMUX_TMPDIR directory, or the directory of an explicit -S socket path, must be writable by this user." };
  }

  /** Mark the server's inherited parent-session identity as removed in one
   * session's environment, never the server's global one. Explicit seat
   * values stay. Returns whether anything was marked. Throws when the global
   * environment can't be read: the caller can't tell whether the seat inherits
   * an identity, so it reports a warning (the launch still goes ahead). */
  private async excludeParentSessionEnv(sessionTarget: string, keep: readonly string[] = []): Promise<boolean> {
    const inherited = await this.globalEnvironment();
    const compare = (key: string) => process.platform === "win32" ? key.toUpperCase() : key;
    const kept = new Set(keep.map(compare));
    const keys = parentSessionEnvKeys(inherited).filter((key) => !kept.has(compare(key)));
    for (const key of keys) {
      const argv = ["tmux", "set-environment", "-t", sessionTarget, "-r", key];
      await this.run(argv, posixJoinArgv(argv));
    }
    return keys.length > 0;
  }

  /**
   * Bracketed paste by default, at every size. Unbracketed input can be consumed as individual
   * keystrokes by agent TUIs, losing text even below the old 8 KiB cutoff.
   * A file keeps payload bytes out of shell/tmux argv and its size limits.
   *   `-p`  bracket the paste when the receiving application enables that mode.
   *   `-r`  preserve raw LF. tmux's default paste-buffer replaces every LF with
   *         CR, and CR is SUBMIT in the Claude/Codex TUIs - a
   *         default paste of a multi-line pack would submit on every newline.
   *   `-d`  drop the buffer after a successful paste.
   * `options.bracketed: false` omits `-p` for explicit prompt answers: bytes
   * then act as keystrokes, including menu shortcuts and control keys.
   * Any trailing submit stays the caller's separate `sendKeys(["Enter"])`.
   * Cleanup unlinks the temp file in `finally`; if the buffer was loaded but the
   * paste failed (e.g. missing target), an explicit `delete-buffer` runs so no
   * buffer leaks. Unique temp + buffer names per call keep parallel `rig up`
   * seats from colliding.
   */
  async sendText(target: string, text: string, beforeInput?: () => void, options?: { bracketed?: boolean; beforePaste?: () => Promise<void> }): Promise<TmuxResult> {
    return this.guardedInput(target, (pane, beforeWrite) => {
      const guard = this.deliveryGuard;
      const identity = this.freshManaged.get(target)?.nodeId ?? target;
      const checkDraft = guard?.needsInputCheck(identity);
      const policy = checkDraft || options?.beforePaste ? {
        // A paste the guard proves it left unsubmitted (#2429) is submitted first, under this lease, once this send's own
        // checks pass; they then aren't run a second time.
        beforePaste: async () => {
          let checked = false;
          const checks = async () => { await options?.beforePaste?.(); beforeWrite(); beforeInput?.(); checked = true; };
          // The synchronous checks run again just before the key: the guard's re-read awaits after `checks`.
          const enter = async () => { beforeWrite(); beforeInput?.(); return (await this.sendKeysUnchecked(pane, ["Enter"])).ok; };
          if (checkDraft) await guard!.beforeInput(identity, false, text, { checks, enter });
          if (!checked) await options?.beforePaste?.();
        },
        afterPaste: async () => { if (checkDraft) await guard!.notePasted(identity, text); },
      } : undefined;
      return this.sendTextUnchecked(pane, text, () => { beforeWrite(); beforeInput?.(); }, options?.bracketed, policy);
    }, false, "text");
  }

  /** Launch-only repair of a recognised terminal reply, before accepting seat work. */
  async prepareWindowsCodexComposer(target: string): Promise<TmuxResult> {
    if (this.terminalKind !== "psmux" || process.platform !== "win32") return { ok: true };
    // The terminal's OSC colour replies may arrive after the first ready screen.
    // Stay inside launch's input guard while observing this bounded startup window.
    let responseDraft = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const content = await this.capturePaneScreen(target);
      if (content && hasOnlyWindowsTerminalResponseDraft(content)) { responseDraft = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!responseDraft) return { ok: true };
    const result = await this.sendKeys(target, ["C-u"]);
    if (!result.ok) return result;
    // ConPTY capture can precede the TUI redraw. Observe one write's result;
    // never repeat the clearing key against a possibly changed user draft.
    for (let attempt = 0; attempt < 10; attempt++) {
      const after = await this.capturePaneScreen(target);
      if (after && !hasOnlyWindowsTerminalResponseDraft(after)) return { ok: true };
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { ok: false, code: "native_composer_unverified", message: "Native startup terminal response removal unverified." };
  }

  private async sendTextUnchecked(target: string, text: string, beforeWrite: () => void, bracketed = true,
    policy?: { beforePaste: () => Promise<void>; afterPaste: () => Promise<void> }): Promise<TmuxResult> {
    const path = this.fileOps.tmpName();
    const buffer = this.fileOps.bufferName();
    let bufferLoaded = false;
    let created = false;
    try {
      await this.fileOps.writeFile(path, text, { mode: 0o600, flag: "wx" });
      created = true;
      const windowsCommand = this.terminalKind === "psmux" && process.platform === "win32"
        ? (await this.getPaneCommand(target) ?? "").replace(/\.exe$/, "").toLowerCase() : null;
      if (windowsCommand && bracketed && !["pwsh", "powershell"].includes(windowsCommand)) {
        const pid = await this.getPanePid(target);
        if (!pid) throw new Error("Windows pane process unavailable; no payload submitted");
        if (policy) await policy.beforePaste();
        beforeWrite();
        // ConPTY removes bracketed-paste delimiters on its pipe. Console input
        // records preserve the delimiters and raw LF for the receiving editor.
        const helper = pathJoin(import.meta.dirname, "../../assets/windows-console-input.ps1");
        const powershell = pathJoin(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
        try {
          await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
            "-TargetPid", String(pid), "-PayloadFile", path, "-Mode", ["codex", "codex-code-mode-host"].includes(windowsCommand) ? "codex" : "bracketed"], { windowsHide: true, timeout: 15000 });
        } catch (error) {
          const phase = /failed at (read|compile|attach|open|write);/.exec(String((error as { stderr?: string }).stderr ?? ""))?.[1];
          throw new Error(`Windows console delivery failed${phase ? ` at ${phase}` : ""}; payload consumption unverified`);
        }
        if (policy) await policy.afterPaste();
        return { ok: true };
      }
      await this.run(["tmux", "load-buffer", "-b", buffer, path],
        `tmux load-buffer -b ${shellQuote(buffer)} ${shellQuote(path)}`, this.terminalKind === "psmux" ? target : undefined);
      bufferLoaded = true;
      if (policy) await policy.beforePaste();
      beforeWrite();
      // Explicit prompt answers need key input, not bracketed-paste framing.
      // Keep their bytes in the file: tmux command parsing and argv limits must
      // not alter semicolons or reject long answers (#519, #602).
      await this.run(["tmux", "paste-buffer", "-t", target, "-b", buffer, "-d", "-r", ...(bracketed ? ["-p"] : [])],
        `tmux paste-buffer -t ${shellQuote(target)} -b ${shellQuote(buffer)} -d -r${bracketed ? " -p" : ""}`);
      if (policy) await policy.afterPaste();
      return { ok: true };
    } catch (err) {
      if (bufferLoaded) {
        // paste failed after load - `-d` never ran, so the buffer is still
        // resident. Best-effort delete to avoid leaking it.
        try {
          await this.run(["tmux", "delete-buffer", "-b", buffer],
        `tmux delete-buffer -b ${shellQuote(buffer)}`, this.terminalKind === "psmux" ? target : undefined);
        } catch { /* best-effort cleanup */ }
      }
      return classifyWriteError(err);
    } finally {
      if (created) {
        try {
          await this.fileOps.unlink(path);
        } catch { /* best-effort cleanup */ }
      }
    }
  }

  /**
   * Launch a POSIX command in an empty shell. A newly created pane can still
   * be in canonical input mode: on macOS it silently drops input beyond 1024
   * bytes, even when paste-buffer succeeds. Only a short invocation crosses
   * that boundary; the command's PATH, quoting and arguments travel in a file.
   * The shell removes its private script when consumed (not when pasted).
   * A shell that never consumes the invocation leaves the file for diagnosis.
   */
  async sendShellCommand(target: string, command: string, beforeInput?: () => void, options: TmuxShellCommandOptions = {}): Promise<TmuxResult> {
    // Keep the managed selector for nested paste/Enter checks. A resolved pane
    // ID can also occur in detached bindings after a tmux restart; resolving it
    // again would lose the unambiguous session/node and its existing lease.
    // Each nested write still validates the lease and targets its observed pane.
    return this.guardedInput(target, pane => this.sendShellCommandUnchecked(target, command, beforeInput, options, pane));
  }

  /** Stage or send a launch while leaving a consumed script's cleanup to the receiving shell. */
  private async sendShellCommandUnchecked(target: string, command: string, beforeInput: (() => void) | undefined, options: TmuxShellCommandOptions, observedPane: string): Promise<TmuxResult> {
    if (this.terminalKind === "psmux") return this.sendWindowsShellCommand(target, command, beforeInput, observedPane);
    const commandBytes = Buffer.byteLength(command, "utf8");
    // POSIX shells retain subshell isolation; unknown/unreadable panes use sh.
    const paneShell = options.sourceInPane ? (await this.getPaneCommand(observedPane) ?? "").replace(/^-/, "") : "";
    const sourceInPane = ["bash", "zsh", "sh", "dash", "ksh"].includes(paneShell);
    let path = options.stageIfLong && commandBytes <= 512 ? undefined : this.fileOps.tmpName();
    let invocation = path ? sourceInPane ? `( . ${shellQuote(path)} )` : `/bin/sh ${shellQuote(path)}` : command;
    if (path && paneShell === "fish") {
      const quotedPath = shellQuote(path);
      invocation = `/bin/sh ${quotedPath}`;
      // Fish single quotes reinterpret POSIX backslashes. Keep those payloads
      // (and paths) on sh, preserving existing executable launches byte-for-byte.
      if (!command.includes("\\") && !path.includes("\\")) {
        // Probe fixed syntax in the pane before sourcing, not the launch's exit
        // status: even failed cleanup must not turn a later exit into a retry.
        const sourced = `if eval 'OPENRIG_FISH_ASSIGNMENT_PROBE=1 /bin/sh -c :'; source ${quotedPath}; else; /bin/sh ${quotedPath}; end`;
        // Repeating the path must not add a refusal for previously valid TMPDIRs.
        if (Buffer.byteLength(sourced, "utf8") <= 512) invocation = sourced;
      }
    }
    if (Buffer.byteLength(invocation, "utf8") > 512) {
      // Pi commands below the canonical tty limit still fit when staging cannot.
      if (options.stageIfLong && commandBytes < 1024) {
        path = undefined;
        invocation = command;
      } else {
        return { ok: false, code: "launch_path_too_long", message: "Temporary launch-script path exceeds the safe terminal input bound" };
      }
    }
    let created = false;
    try {
      if (path) {
        await this.fileOps.writeFile(path, `/bin/rm -f -- ${shellQuote(path)} 2>/dev/null || command rm -f -- ${shellQuote(path)} || true\n${options.execInScript ? "exec " : ""}${command}\n`, { mode: 0o600, flag: "wx" });
        created = true;
      }
      const text = await this.sendText(target, invocation, beforeInput);
      if (!text.ok) return text;
      const enter = await this.sendKeys(target, ["Enter"], beforeInput);
      if (!enter.ok) {
        if (!beforeInput) await this.sendKeys(target, ["C-c"]);
        else {
          try { beforeInput(); await this.sendKeys(target, ["C-c"], beforeInput); }
          catch { /* The target changed; do not clear another occupant's input. */ }
        }
        return enter;
      }
      // The receiver now owns removal. Unlinking here races shell startup.
      created = false;
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    } finally {
      if (created && path) {
        try { await this.fileOps.unlink(path); } catch { /* best-effort cleanup */ }
      }
    }
  }

  private async sendWindowsShellCommand(target: string, command: string, beforeInput: (() => void) | undefined, observedPane: string): Promise<TmuxResult> {
    const paneShell = pathBaseName(await this.getPaneCommand(observedPane) ?? "").toLowerCase().replace(/\.exe$/, "").replace(/^-/, "");
    const posix = ["bash","sh","dash","zsh","ksh"].includes(paneShell);
    if (!["pwsh", "powershell", "cmd"].includes(paneShell) && !posix) {
      return { ok: false, code: "unsupported_windows_pane", message: "Native launch requires a PowerShell, cmd or supported POSIX pane shell; no command was typed." };
    }
    const script = this.fileOps.tmpName();
    let invocation: string;
    try {
      invocation = paneShell === "cmd" ? windowsCmdBridgeInvocation(script)
        : posix ? windowsPosixBridgeInvocation(script)
        : `& ([scriptblock]::Create([IO.File]::ReadAllText(${powershellQuote(script)})))`;
    } catch (error) { return { ok: false, code: "unsupported_windows_launch", message: (error as Error).message }; }
    if (Buffer.byteLength(invocation, "utf8") > 512) {
      return { ok: false, code: "launch_path_too_long", message: "Temporary launch-script path exceeds the safe terminal input bound" };
    }
    let created = false;
    try {
      await this.fileOps.writeFile(script, `Remove-Item -LiteralPath ${powershellQuote(script)}\n${command}\n`, { mode: 0o600, flag: "wx" });
      created = true;
      const text = await this.guardedInput(target, (pane, check) => this.sendTextUnchecked(pane, invocation,
        () => { check(); beforeInput?.(); }, paneShell !== "cmd"));
      if (!text.ok) return text;
      // The actual consumer deletes the script. Successful paste alone is not consumption.
      const enter = beforeInput
        ? await this.guardedInput(target, pane => { beforeInput(); return this.sendKeysUnchecked(pane, ["Enter"]); })
        : await this.sendKeys(target, ["Enter"]);
      if (enter.ok) created = false;
      return enter;
    } catch (error) {
      return classifyWriteError(error);
    } finally {
      if (created) { try { await this.fileOps.unlink(script); } catch { /* preserve original failure */ } }
    }
  }

  async sendKeys(target: string, keys: string[], beforeInput?: () => void, options?: { beforeKeys?: () => Promise<void> }): Promise<TmuxResult> {
    return this.guardedInput(target, async (pane, beforeWrite) => {
      const identity = this.freshManaged.get(target)?.nodeId ?? target;
      const submit = keys.some(isSubmitKey);
      const check = async () => {
        if (this.deliveryGuard?.needsInputCheck(identity)) await this.deliveryGuard.beforeInput(identity, submit);
        if (options?.beforeKeys) await options.beforeKeys();
      };
      await check();
      beforeWrite(); beforeInput?.();
      let result = await this.sendKeysUnchecked(pane, keys);
      // A read-only client stops send-keys but not load-buffer/paste-buffer (#2090). A lone submit key goes as its
      // carriage return through the unbracketed paste, once the same checks pass again, so input that changed in
      // the gap is not submitted.
      if (keys.length === 1 && isSubmitKey(keys[0]!) && isReadOnlyClientRefusal(result)) {
        result = await this.sendTextUnchecked(pane, "\r", () => { beforeWrite(); beforeInput?.(); }, false,
          { beforePaste: check, afterPaste: async () => {} });
      }
      if (result.ok && submit) this.deliveryGuard?.noteSubmitted(identity);
      return result;
    }, false, "keys");
  }

  private async sendKeysUnchecked(target: string, keys: string[]): Promise<TmuxResult> {
    try {
      if (this.terminalKind === "psmux" && process.platform === "win32" && keys.length === 1 && keys[0] === "C-u"
        && ["codex", "codex-code-mode-host"].includes((await this.getPaneCommand(target) ?? "").replace(/\.exe$/, "").toLowerCase())) {
        const pid = await this.getPanePid(target);
        if (!pid) return { ok: false, code: "guard_target_unknown", message: "Native console process unavailable; no key sent." };
        try {
          await execFileAsync(pathJoin(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", pathJoin(import.meta.dirname, "../../assets/windows-console-input.ps1"), "-TargetPid", String(pid), "-Mode", "codex-clear"], { windowsHide: true, timeout: 15000 });
        } catch { return { ok: false, code: "native_key_unverified", message: "Native console key delivery unverified." }; }
        return { ok: true };
      }
      await this.run(["tmux", "send-keys", "-t", target, ...keys],
        `tmux send-keys -t ${shellQuote(target)} ${keys.map(shellQuote).join(" ")}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async setWindowOption(target: string, option: string, value: string): Promise<TmuxResult> {
    const window = exactTarget(target, "window");
    try {
      await this.run(["tmux", "set-option", "-w", "-t", window, option, value],
        `tmux set-option -w -t ${shellQuote(window)} ${shellQuote(option)} ${shellQuote(value)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** The window's OWN value for an option, without the inherited global value: the string, null when the window
   *  sets none, undefined when tmux could not be read. A caller that changes the option for a while restores
   *  exactly this with restoreWindowOption. */
  async getWindowLocalOption(target: string, option: string): Promise<string | null | undefined> {
    const window = exactTarget(target, "window");
    try {
      const output = await this.run(["tmux", "show-options", "-w", "-v", "-t", window, option],
        `tmux show-options -w -v -t ${shellQuote(window)} ${shellQuote(option)}`);
      return output.length === 0 ? null : output.replace(/\r?\n$/, "");
    } catch {
      return undefined;
    }
  }

  /** The window a session name (its current window) or `@N` names, read in one call: its immutable id (`@N`), which
   *  later commands can target after a client switches windows, and the value of one of its user options (`@name`; ""
   *  when unset). Null when tmux can't say, including when the session or window is gone. */
  async readWindow(target: string, userOption: string): Promise<{ id: string; userOption: string } | null> {
    if (!/^@[A-Za-z0-9_-]+$/.test(userOption)) return null;
    const window = exactTarget(target, "window");
    const format = `#{window_id}|#{${userOption}}`;
    try {
      const output = (await this.run(["tmux", "display-message", "-p", "-t", window, format],
        `tmux display-message -p -t ${shellQuote(window)} ${shellQuote(format)}`)).replace(/\r?\n$/, "");
      const bar = output.indexOf("|");
      const id = output.slice(0, Math.max(bar, 0));
      return /^@\d+$/.test(id) ? { id, userOption: output.slice(bar + 1) } : null;
    } catch {
      return null;
    }
  }

  /** Put back what getWindowLocalOption read: set the value, or unset the window's own value when it had none. */
  async restoreWindowOption(target: string, option: string, value: string | null): Promise<TmuxResult> {
    const window = exactTarget(target, "window");
    const argv = value === null
      ? ["tmux", "set-option", "-w", "-u", "-t", window, option]
      : ["tmux", "set-option", "-w", "-t", window, option, value];
    try {
      await this.run(argv, argv.map((part, index) => index < 2 ? part : shellQuote(part)).join(" "));
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async resizeWindow(target: string, cols: number, rows: number): Promise<TmuxResult> {
    if (!Number.isFinite(cols) || !Number.isInteger(cols) || cols < 1) {
      return { ok: false, code: "validation_error", message: `resizeWindow: cols must be a positive integer, got ${cols}` };
    }
    if (!Number.isFinite(rows) || !Number.isInteger(rows) || rows < 1) {
      return { ok: false, code: "validation_error", message: `resizeWindow: rows must be a positive integer, got ${rows}` };
    }
    try {
      await this.run(["tmux", "resize-window", "-t", exactTarget(target, "window"), "-x", String(cols), "-y", String(rows)]);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** With a delivery guard, terminate by immutable tmux session ID; checked callers validate before detach and kill. */
  async killSession(name: string, beforeEffect?: () => void): Promise<TmuxResult> {
    let stopPhase: StopPhase = "none";
    if (this.deliveryGuard) {
      const result = await this.guardedInput(name, async (pane, beforeWrite) => {
        const stdout = await this.run(["tmux", "display-message", "-p", "-t", pane, "#{session_id}"], `tmux display-message -p -t ${shellQuote(pane)} '#{session_id}'`);
        const sessionId = stdout.trim();
        if (!/^\$\d+$/.test(sessionId)) return { ok: false, code: "guard_target_unknown", message: "Cannot establish immutable session identity; no session killed." };
        const kill = async () => {
          const scopedId = this.terminalKind === "psmux" && pane.startsWith("psmux:")
            ? `${pane.slice(0, pane.lastIndexOf(":") + 1)}${sessionId}` : sessionId;
          const result = await this.killSessionUnchecked(scopedId, beforeEffect && (() => { beforeWrite(); beforeEffect(); }), phase => { stopPhase = phase; });
          if (result.ok) { this.freshProbes.delete(name); this.freshProbes.delete(pane); this.freshManaged.delete(name); }
          return result;
        };
        if (this.freshProbes.get(name) === pane && !this.deliveryGuard!.maybeTarget(name) && !this.deliveryGuard!.maybeTarget(pane)) return kill();
        return this.deliveryGuard!.input(this.freshManaged.get(name)?.nodeId ?? name, kill);
      }, true);
      return beforeEffect ? { ...result, stopPhase } : result;
    }
    if (beforeEffect) return { ok: false, code: "guard_unavailable", message: "Checked stop requires the delivery guard.", stopPhase };
    return this.killSessionUnchecked(name);
  }

  /** Keep effect checks outside command catches so a selection refusal retains its code and phase. */
  private async killSessionUnchecked(name: string, beforeEffect?: () => void, phase?: (value: StopPhase) => void): Promise<TmuxResult> {
    if (this.terminalKind === "psmux") {
      let sessionName: string;
      let id: string;
      try {
        const scoped = /^psmux:([A-Za-z0-9_-]+):(\$\d+)$/.exec(name);
        sessionName = scoped ? Buffer.from(scoped[1]!, "base64url").toString("utf8") : name.replace(/^=/, "");
        id = scoped?.[2] ?? (await this.runNamedSession(["tmux", "display-message", "-p", "-t", `=${sessionName}:`, "#{session_id}"], sessionName, undefined, true)).trim();
        if (!/^\$\d+$/.test(id)) return { ok: false, code: "guard_target_unknown", message: "Native session identity unavailable; nothing killed." };
      } catch (error) { return classifyWriteError(error); }
      beforeEffect?.();
      phase?.("kill_attempted");
      try {
        // psmux doesn't accept $N as a selector. Select its server once, check
        // identity inside that connection, then kill SELF without resolving a
        // name again. Each native session has its own server: no sibling view can switch.
        const conditional = ["tmux", "if-shell", "-F", `#{==:#{session_id},${id}}`, "kill-session", "display-message -p kept"];
        const out = sessionName.includes(":")
          ? await this.nativeRaw(["tmux", "-t", "=" + await this.nativeBoundName(sessionName), ...conditional.slice(1)])
          : await this.run(conditional, undefined, sessionName);
        if (out.includes("kept")) return { ok: false, code: "guard_target_changed", message: "Native server identity changed; nothing killed." };
        if ((await this.probeSession(sessionName)).state !== "absent") return { ok: false, code: "kill_unverified", message: "Native session disappearance unverified." };
        this.freshProbes.delete(name); this.freshManaged.delete(name);
        return { ok: true };
      } catch (error) { return classifyWriteError(error); }
    }
    // The guarded path passes the immutable `$N` id, which stays as it is; a bare name is made exact.
    const session = exactTarget(name, "session");
    // Detach first so `detach-on-destroy off` cannot switch views onto another session.
    beforeEffect?.();
    phase?.("detach_attempted");
    try {
      await this.run(["tmux", "detach-client", "-s", session],
        `tmux detach-client -s ${shellQuote(session)}`);
    } catch (err) {
      // tmux 3.7 says "no current client" when nothing is attached (and for a missing session, which the kill classifies).
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toLowerCase().includes("no current client")) return classifyWriteError(err);
    }
    phase?.("detached");
    beforeEffect?.();
    phase?.("kill_attempted");
    try {
      await this.run(["tmux", "kill-session", "-t", session],
        `tmux kill-session -t ${shellQuote(session)}`);
      const pane = this.freshProbes.get(name);
      this.freshProbes.delete(name);
      if (pane) this.freshProbes.delete(pane);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Seat-handover cutover (plan 411c43de): respawn a pane IN PLACE (reuse the retiree's EXACT pane) so
   *  the successor boots below the predecessor's history — same window, same pane, predecessor scrollback
   *  PRESERVED above the boot. The command is shell-quoted as ONE unit (tmux runs it via the shell).
   *
   *  ⚠ NO `-k`: empirically (tmux 3.6a) `respawn-pane -k` force-kills+respawns atomically and CLEARS the
   *  pane's scrollback — defeating the money-proof. So the cutover terminates the retiree FIRST (graceful
   *  exit + `setRemainOnExit(true)` so the pane survives dead), waits for `isPaneDead`, then calls this
   *  WITHOUT -k on the already-dead pane — which preserves the history. respawn-pane refuses a still-live
   *  pane ("still active"), which is the correct guard: never respawn over a live retiree.
   *
   *  Optional `cwd`/`env` inject the successor's start-directory + OpenRig identity env onto the reused
   *  pane via respawn-pane's `-c`/`-e` flags (tmux ≥3.0), the SAME mechanism createSession uses. Any flags
   *  precede the command, which always stays LAST.
   *
   *  ⚠ KI-14: omitting `command` re-runs the pane's CREATION (or last-respawn) command — which is the
   *  default shell ONLY for panes createSession made. Adopted/hand-recovered panes can carry a full
   *  harness invocation there (`codex … resume <old-token>`), so an undefined respawn silently boots the
   *  OLD context. Callers that need a blank pane must pass an explicit shell (see getDefaultShell). */
  async respawnPane(
    paneTarget: string,
    command?: string,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<TmuxResult> {
    return this.guardedInput(paneTarget, async (pane, beforeWrite) => {
      beforeWrite();
      const result = await this.respawnPaneUnchecked(pane, command, opts);
      const guard = this.deliveryGuard;
      const target = guard?.maybeTarget(paneTarget);
      if (result.ok && target && guard!.ownsLifecycle(target.nodeId)) guard!.noteFreshLifecyclePane(target.nodeId, pane);
      return result;
    }, false, "respawn");
  }

  private async respawnPaneUnchecked(paneTarget: string, command?: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<TmuxResult> {
    const exact = exactTarget(paneTarget, "pane");
    const argv = ["tmux", "respawn-pane", "-t", exact];
    if (opts?.cwd != null) argv.push("-c", opts.cwd);
    const launchEnv = {...opts?.env};
    const warnings: string[] = [];
    let bootstrap: string | undefined;
    const scopedCommand = await this.scopedLaunchCommand(launchEnv, command, warnings, (file, recoveryEnv) => { bootstrap = file; Object.assign(launchEnv,recoveryEnv); });
    for (const [k,v] of Object.entries(launchEnv)) argv.push("-e",`${k}=${v}`);
    // Legacy commands remain one argument; the scoped wrapper executes directly before the user shell.
    if (scopedCommand) argv.push(...scopedCommand);
    else if (command != null && command.length > 0) argv.push(command);
    const quote = Object.keys(launchEnv).length ? tmuxConfigQuote : shellQuote;
    const legacyRespawn = ["tmux", "respawn-pane", "-t", quote(exact)];
    if (opts?.cwd != null) legacyRespawn.push("-c", quote(opts.cwd));
    for (const [k,v] of Object.entries(launchEnv)) legacyRespawn.push("-e",quote(`${k}=${v}`));
    if (scopedCommand) legacyRespawn.push(...scopedCommand.map(quote));
    else if (command != null && command.length > 0) legacyRespawn.push(quote(command));
    // The successor starts from the session environment: exclude inherited
    // parent-session identity there first (sessions made before this existed).
    // A failure here is a warning; the respawn goes ahead as it did before.
    try {
      await this.excludeParentSessionEnv(exact, Object.keys(launchEnv));
    } catch (err) {
      warnings.push(parentSessionEnvWarning(exact, err));
    }
    try {
      if (Object.keys(launchEnv).length) await this.runEnvironmentCommand(argv, legacyRespawn.join(" "), false, !!scopedCommand);
      else await this.run(argv, legacyRespawn.join(" "));
      return warnings.length ? { ok: true, warnings } : { ok: true };
    } catch (err) {
      await this.discardUnstartedScopedBootstrap(bootstrap, err);
      return classifyWriteError(err);
    }
  }

  /** Seat-handover cutover: set the pane-scoped `remain-on-exit` so the pane SURVIVES (goes dead, not
   *  destroyed) when the retiree process exits — holding its scrollback for the successor's respawn.
   *  Set to `on` BEFORE the retiree is signalled to exit (else the pane is destroyed on exit and there
   *  is nothing to respawn into). */
  async setRemainOnExit(paneTarget: string, on: boolean): Promise<TmuxResult> {
    const exact = exactTarget(paneTarget, "pane");
    try {
      await this.run(["tmux", "set-option", "-p", "-t", exact, "remain-on-exit", on ? "on" : "off"],
        `tmux set-option -p -t ${shellQuote(exact)} remain-on-exit ${on ? "on" : "off"}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** The pane's OWN value for an option, without inherited window/global values: the string, null when the
   *  pane sets none, undefined when tmux could not be read. A caller that changes the option for a while
   *  restores exactly this with restorePaneOption. */
  async getPaneLocalOption(paneTarget: string, option: string): Promise<string | null | undefined> {
    const exact = exactTarget(paneTarget, "pane");
    try {
      const output = await this.run(["tmux", "show-options", "-p", "-v", "-t", exact, option],
        `tmux show-options -p -v -t ${shellQuote(exact)} ${shellQuote(option)}`);
      // tmux prints nothing for an unset option and the value plus a newline when set (an empty value prints
      // a bare newline), so only the line ending is removed: the value comes back exactly as it was set.
      return output.length === 0 ? null : output.replace(/\r?\n$/, "");
    } catch {
      return undefined;
    }
  }

  /** Put back what getPaneLocalOption read: set the value, or unset the pane's own value when it had none. */
  async restorePaneOption(paneTarget: string, option: string, value: string | null): Promise<TmuxResult> {
    const exact = exactTarget(paneTarget, "pane");
    const argv = value === null
      ? ["tmux", "set-option", "-p", "-u", "-t", exact, option]
      : ["tmux", "set-option", "-p", "-t", exact, option, value];
    try {
      await this.run(argv, argv.map((part, index) => index < 2 ? part : shellQuote(part)).join(" "));
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** The pane's whole text, history and visible screen, with wrapped lines joined. Null when unreadable. */
  async capturePaneHistory(paneTarget: string): Promise<string | null> {
    const exact = exactTarget(paneTarget, "pane");
    try {
      return await this.run(["tmux", "capture-pane", "-p", "-J", "-t", exact, "-S", "-", "-E", "-"],
        `tmux capture-pane -p -J -t ${shellQuote(exact)} -S - -E -`);
    } catch {
      return null;
    }
  }

  /** The pane's history rows alone and its whole text (history and visible screen), both with wrapped lines joined,
   *  from one chained tmux call. Through tmux control mode the commands run one at a time, so the pane can change
   *  between the two captures. `history` is empty when the pane has no history. Null when unreadable. */
  async capturePaneHistoryParts(paneTarget: string): Promise<{ history: string; all: string } | null> {
    const exact = exactTarget(paneTarget, "pane");
    const nonce = randomUUID().replace(/-/g, "");
    const mark = (k: number) => `__openrig_capture_${nonce}_${k}__`;
    const argv = ["tmux",
      "display-message", "-p", "-t", exact, `${mark(0)}#{history_size}`, ";",
      "capture-pane", "-p", "-J", "-t", exact, "-S", "-", "-E", "-1", ";",
      "display-message", "-p", "-t", exact, mark(1), ";",
      "capture-pane", "-p", "-J", "-t", exact, "-S", "-", "-E", "-"];
    const legacy = `tmux display-message -p -t ${shellQuote(exact)} ${shellQuote(`${mark(0)}#{history_size}`)}`
      + ` \\; capture-pane -p -J -t ${shellQuote(exact)} -S - -E -1`
      + ` \\; display-message -p -t ${shellQuote(exact)} ${shellQuote(mark(1))}`
      + ` \\; capture-pane -p -J -t ${shellQuote(exact)} -S - -E -`;
    let output: string;
    try {
      output = await this.run(argv, legacy);
    } catch {
      return null;
    }
    const lines = output.split("\n");
    const first = lines.findIndex((line) => line.startsWith(mark(0)));
    const second = lines.indexOf(mark(1));
    if (first < 0 || second < first) return null;
    const historySize = Number.parseInt(lines[first]!.slice(mark(0).length), 10);
    if (!Number.isInteger(historySize) || historySize < 0) return null;
    // With no history, `-E -1` is outside the pane and tmux may return a screen row instead.
    const history = historySize === 0 ? "" : lines.slice(first + 1, second).join("\n");
    return { history, all: lines.slice(second + 1).join("\n") };
  }

  /** Signal one process by pid. signalPaneProcess signals the pane's root, which in a shell-backed pane is
   *  the shell, not the runtime running under it. Uses the native host's termination command. */
  async signalPid(pid: number, signal: "TERM" | "KILL"): Promise<TmuxResult> {
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, code: "invalid_pid", message: `Refusing to signal pid ${pid}.` };
    try {
      await this.exec(this.terminalKind === "psmux" && process.platform === "win32"
        ? `taskkill /PID ${pid} /T${signal === "KILL" ? " /F" : ""}`
        : `kill -${signal} ${pid}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Seat-handover cutover: is the pane's process dead (the retiree exited; the pane held by
   *  remain-on-exit)? A known-missing pane also proves physical cutover; unknown probe errors stay false. */
  async isPaneDead(paneId: string): Promise<boolean> {
    const exact = exactTarget(paneId, "pane");
    try {
      const output = await this.run(["tmux", "display-message", "-p", "-t", exact, "#{pane_dead}"],
        `tmux display-message -p -t ${shellQuote(exact)} "#{pane_dead}"`);
      return output.trim() === "1";
    } catch (error) {
      return isNoServerError(error) || isPaneAbsenceError(error);
    }
  }

  /** Seat-handover cutover: signal the pane's foreground process (the retiree) — `TERM` for the graceful
   *  exit-in-place, `KILL` for the bounded-timeout force fallback. Resolves the pane pid then `kill`s it;
   *  an unresolvable pid is a structured, non-throwing failure.
   *  Termination is host-native and remains scoped to the resolved pane process. */
  async signalPaneProcess(paneId: string, signal: "TERM" | "KILL"): Promise<TmuxResult> {
    return this.guardedInput(paneId, (pane, beforeWrite) => this.signalPaneProcessUnchecked(pane, signal, beforeWrite));
  }

  private async signalPaneProcessUnchecked(paneId: string, signal: "TERM" | "KILL", beforeWrite: () => void): Promise<TmuxResult> {
    const pid = await this.getPanePid(paneId);
    if (pid == null) {
      return { ok: false, code: "pane_pid_unavailable", message: `Could not resolve the pane pid for "${paneId}".` };
    }
    try {
      beforeWrite();
      return await this.signalPid(pid, signal);
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Get the PID of the foreground process in a pane. Returns null if unavailable. */
  async getSessionPanePid(name: string): Promise<number | null> { return this.getPanePid(name, true); }

  async getPanePid(paneId: string, literalSessionName = false): Promise<number | null> {
    const target = literalSessionName ? `=${paneId}:` : exactTarget(paneId, "pane");
    try {
      const argv = ["tmux", "display-message", "-p", "-t", target, "#{pane_pid}"], legacy = `tmux display-message -p -t ${shellQuote(target)} "#{pane_pid}"`;
      const output = literalSessionName ? await this.runNamedSession(argv, paneId, legacy, true) : await this.run(argv, legacy);
      const trimmed = output.trim();
      const parsed = parseInt(trimmed, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  /** KI-14: the server's `default-shell` option — what a createSession pane runs when no command is
   *  given. Used to make a respawn EXPLICIT about the blank shell instead of inheriting whatever
   *  command the pane was created with. Returns null if unavailable (caller falls back). */
  async getDefaultShell(): Promise<string | null> {
    try {
      const output = await this.run(["tmux", "show-options", "-gv", "default-shell"]);
      const trimmed = output.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /** Get the current foreground command in a pane. Returns null if unavailable. */
  async getSessionPaneCommand(name: string): Promise<string | null> { return this.getPaneCommand(name, true); }

  async getPaneCommand(paneId: string, literalSessionName = false): Promise<string | null> {
    const target = literalSessionName ? `=${paneId}:` : exactTarget(paneId, "pane");
    try {
      const argv = ["tmux", "display-message", "-p", "-t", target, "#{pane_current_command}"], legacy = `tmux display-message -p -t ${shellQuote(target)} "#{pane_current_command}"`;
      const output = literalSessionName ? await this.runNamedSession(argv, paneId, legacy, true) : await this.run(argv, legacy);
      const trimmed = output.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /** Whether a pane is in a mode such as copy mode. tmux reports #{pane_in_mode} as the number of
   *  modes the pane is in, so any count above 0 is in a mode. Returns null if unavailable. */
  async isPaneInMode(paneId: string): Promise<boolean | null> {
    const target = exactTarget(paneId, "pane");
    try {
      const output = await this.run(["tmux", "display-message", "-p", "-t", target, "#{pane_in_mode}"],
        `tmux display-message -p -t ${shellQuote(target)} "#{pane_in_mode}"`);
      const trimmed = output.trim();
      if (!/^\d+$/.test(trimmed)) return null;
      return Number(trimmed) > 0;
    } catch {
      return null;
    }
  }

  /** Leave the pane's current mode (copy mode) with `send-keys -X cancel`, through the same input guard as sendKeys. */
  async cancelPaneMode(target: string): Promise<TmuxResult> {
    return this.guardedInput(target, (pane, beforeWrite) => { beforeWrite(); return this.sendKeysUnchecked(pane, ["-X", "cancel"]); }, false, "keys");
  }

  /** A launch metadata read. Callers must never put credential values in terminal input. */
  async getSessionEnv(session: string, key: string): Promise<string | undefined> {
    if (!(this.terminalKind === "psmux" ? isWindowsPrivateEnvironmentName(key) : /^[A-Z_][A-Z0-9_]*$/.test(key))) throw new Error("Invalid session environment key.");
    const target = exactTarget(session, "session");
    try {
      const delimiter = this.terminalKind === "psmux" && key.startsWith("-") ? ["--"] : [];
      const output = await this.runNamedSession(["tmux", "show-environment", "-t", target, ...delimiter, key], session,
        `tmux show-environment -t ${shellQuote(target)} ${delimiter.length ? "-- " : ""}${shellQuote(key)}`);
      if (this.terminalKind === "psmux") {
        // The protocol adds one LF; a preceding CR belongs to the value.
        const body = output.endsWith("\n") ? output.slice(0, -1) : output;
        if (body.includes("\n")) {
          // Older psmux ignores the selector and returns the whole environment.
          // A missing-key query must prove selector support before interpreting
          // a multiline response as one value. Never log either response.
          const probe = `OPENRIG_SELECTOR_PROBE_${randomUUID().replace(/-/g, "")}`;
          let selective = false;
          try { await this.runNamedSession(["tmux", "show-environment", "-t", target, probe], session); }
          catch (error) { selective = error instanceof Error && error.message.includes(`unknown variable: ${probe}`); }
          if (!selective) throw new Error("Native environment selectors are not qualified");
        }
        if (body.startsWith("-") && readPlatformEnv({ [body.slice(1)]: "removed" }, key, "win32") !== undefined) return undefined;
        const separator = body.indexOf("=");
        const selected = separator < 0 ? undefined : readPlatformEnv({ [body.slice(0, separator)]: body.slice(separator + 1) }, key, "win32");
        if (selected === undefined) throw new Error("Unexpected session environment response");
        return selected;
      }
      if (output.trim() === `-${key}`) return undefined;
      if (!output.startsWith(`${key}=`)) throw new Error("Unexpected session environment response.");
      const value = output.slice(key.length + 1).replace(/\n$/, "");
      if (!value.includes("\\")) return value;
      // tmux's printable output uses VIS_CSTYLE|VIS_OCTAL|VIS_NOSLASH:
      // raw literal backslashes are indistinguishable from escaped controls.
      // Shell output escapes literal backslashes first, restoring injectivity.
      // Parse that closed representation as data; never evaluate shell text.
      const quoted = await this.run(["tmux", "show-environment", "-s", "-t", target, key],
        `tmux show-environment -s -t ${shellQuote(target)} ${shellQuote(key)}`);
      const prefix = `${key}="`, suffix = `"; export ${key};\n`;
      if (!quoted.startsWith(prefix) || !quoted.endsWith(suffix)) throw new Error("Unexpected quoted environment response");
      const encoded = quoted.slice(prefix.length, -suffix.length);
      const escapes: Record<string, string> = { "\\": "\\", '"': '"', "$": "$", "`": "`", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", s: " ", t: "\t", v: "\v", "0": "\0" };
      return encoded.replace(/\\([0-7]{3}|[\s\S])/g, (_all, escape: string) => {
        if (/^[0-7]{3}$/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
        if (!(escape in escapes)) throw new Error("Unsupported environment escape");
        return escapes[escape]!;
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes(`unknown variable: ${key}`)) return undefined;
      throw new Error("Cannot read the session's launch environment.");
    }
  }

  /** Set one variable for later panes, through the same private-file channel as launch. */
  async setSessionEnv(session: string, key: string, value: string): Promise<void> {
    if (!(this.terminalKind === "psmux" ? isWindowsPrivateEnvironmentName(key) : /^[A-Z_][A-Z0-9_]*$/.test(key))) throw new Error("Invalid session environment key.");
    const target = exactTarget(session, "session");
    if (this.terminalKind === "psmux") {
      if (!this.fileOps.privateConfig) throw new Error("Native private environment file writer unavailable");
      const config = await this.fileOps.privateConfig(psmuxPrivateEnvironmentLine(key, value));
      // Keep the file after any uncertain call; never fall back to value argv.
      await this.runNamedSession(["tmux", "source-file", "-t", target, config.path], session);
      await config.dispose().catch(() => { console.warn(`Native environment config cleanup failed: ${config.path}`); });
      return;
    }
    await this.runEnvironmentCommand(["tmux", "set-environment", "-t", target, key, value],
      `tmux set-environment -t ${tmuxConfigQuote(target)} ${tmuxConfigQuote(key)} ${tmuxConfigQuote(value)}`);
  }

  /** Remove one variable from a session's environment, so a process spawned there afterwards
   *  inherits the server's value for it, or none. A name that is the launching session's own
   *  identity in the server's environment (see parent-session-env) is marked removed instead, as a
   *  launch does, so the server's value does not come back. */
  async unsetSessionEnv(session: string, key: string): Promise<void> {
    if (!(this.terminalKind === "psmux" ? isWindowsPrivateEnvironmentName(key) : /^[A-Z_][A-Z0-9_]*$/.test(key))) throw new Error("Invalid session environment key.");
    const target = exactTarget(session, "session");
    const parents = parentSessionEnvKeys(await this.globalEnvironment()).filter(name => process.platform === "win32" ? name.toUpperCase() === key.toUpperCase() : name === key);
    const flag = parents.length ? "-r" : "-u";
    for (const name of new Set([key, ...parents])) {
      const delimiter = this.terminalKind === "psmux" && name.startsWith("-") ? ["--"] : [];
      await this.runNamedSession(["tmux", "set-environment", "-t", target, flag, ...delimiter, name], session,
        `tmux set-environment -t ${shellQuote(target)} ${flag} ${delimiter.length ? "-- " : ""}${shellQuote(name)}`);
    }
  }

  private async globalEnvironment(): Promise<Record<string, string>> {
    const global = await this.run(["tmux", "show-environment", "-g"], "tmux show-environment -g");
    const inherited: Record<string, string> = {};
    for (const line of global.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) inherited[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return inherited;
  }

  /** OPR.0.4.3.28 Part C — usable-presence check for a session-env variable.
   *  Returns whether the var has a nonblank value, NEVER that value, and null
   *  when the session environment cannot be inspected. Listing the environment
   *  distinguishes a genuinely absent var from `tmux show-environment <var>`'s
   *  nonzero lookup exit. */
  async hasSessionEnv(sessionName: string, varName: string): Promise<boolean | null> {
    if (this.terminalKind === "psmux") return this.selectedEnvPresence(sessionName, varName);
    const lines = await this.sessionEnvLines(sessionName);
    if (lines?.some(line => line.startsWith(`${varName}=`) && line.includes("\\"))) return this.selectedEnvPresence(sessionName, varName);
    return lines === null ? null : usableEnvLine(lines, varName);
  }

  /** The same usable-presence reading for several variables. POSIX shares one
   *  listing except values needing lossless decoding; native multiline listings
   *  are ambiguous and require exact selectors, deduplicated by requested key.
   *  Each requested name maps to true/false; every one maps to null when the environment cannot be inspected. Only
   *  the requested names are returned, and no value, listing or error text leaves this method. */
  async hasSessionEnvBatch(sessionName: string, varNames: readonly string[]): Promise<Record<string, boolean | null>> {
    if (this.terminalKind === "psmux") {
      return Object.fromEntries(await Promise.all([...new Set(varNames)].map(async name => [name, await this.selectedEnvPresence(sessionName, name)] as const)));
    }
    const lines = await this.sessionEnvLines(sessionName);
    return Object.fromEntries(await Promise.all(varNames.map(async name => [name, lines === null ? null
      : lines.some(line => line.startsWith(`${name}=`) && line.includes("\\")) ? await this.selectedEnvPresence(sessionName, name) : usableEnvLine(lines, name)] as const)));
  }

  private async selectedEnvPresence(session: string, name: string): Promise<boolean | null> {
    try { return ((await this.getSessionEnv(session, name)) ?? "").trim().length > 0; }
    catch { return null; }
  }

  private async sessionEnvLines(sessionName: string): Promise<string[] | null> {
    const target = exactTarget(sessionName, "session");
    try {
      const output = await this.run(["tmux", "show-environment", "-t", target],
        `tmux show-environment -t ${shellQuote(target)}`);
      return output.split(/\r?\n/);
    } catch {
      return null;
    }
  }

  /** Start pipe-pane to capture terminal output to a file. */
  async startPipePane(sessionName: string, outputPath: string): Promise<TmuxResult> {
    // Shell-quote the path for safe injection into the pipe-pane command.
    // The entire pipe command is passed as a single argument to tmux,
    // which executes it via sh -c. We use shellQuote on the path.
    // The sink travels as ONE argv unit: the multiplexer runs it via a
    // shell, so its inner quoting stays POSIX here (psmux documents the same
    // `cat >` server-side form for its own path).
    const sink = "cat >> " + shellQuote(outputPath);
    const target = exactTarget(sessionName, "pane");
    try {
      await this.run(["tmux", "pipe-pane", "-t", target, sink],
        `tmux pipe-pane -t ${shellQuote(target)} ${shellQuote(sink)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Stop pipe-pane on a session. */
  async stopPipePane(sessionName: string): Promise<TmuxResult> {
    const target = exactTarget(sessionName, "pane");
    try {
      await this.run(["tmux", "pipe-pane", "-t", target],
        `tmux pipe-pane -t ${shellQuote(target)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Capture pane content (last N lines). Returns null if unavailable. */
  /**
   * Capture many sessions' panes with a few tmux calls instead of one per session (#308). A `list-sessions` runs next
   * to the first chained call and is read only when a chain fails: a target it lacks maps to null (as a failed
   * per-target capture) without a fork. The targets are captured in chunks of CAPTURE_BATCH chained commands (a
   * `display-message` marker, then `capture-pane`), each pane's output delimited by a marker unique to the call, so the
   * text equals what `capturePaneContent` returns. Targets are exact (`=<name>:`): no prefix match, and a name with a
   * "." still resolves. tmux stops a chain at its first failing command, so a failed chunk drops the targets the
   * listing lacks (`missing`) and retries, or is split in half (an oversized output, or a session gone since the
   * listing); a single session that still fails is left OUT of the map, and the caller reads it per target. A server
   * gone since the listing maps the chunk to null without a retry. Any other chain error leaves the chunk out, so the
   * caller reads each pane per target, as an unbatched read does. Null when a chain fails because the server is gone
   * or its socket can't be reached, and tmux can't be listed; a chain that fails for another reason while the listing
   * fails too leaves the chunk to per-target reads. Each entry carries the time its own chunk was read (`capturedAt`), so a slow later
   * chunk can't make an earlier capture look fresh.
   */
  async capturePanesContent(targets: string[], lines: number = 20, now: () => Date = () => new Date()): Promise<Map<string, PaneCapture> | null> {
    const listing = this.run(["tmux", "list-sessions", "-F", "#{session_name}"], "tmux list-sessions -F '#{session_name}'")
      .then(async output => new Set(await Promise.all(output.split(/\r?\n/).filter(Boolean).map(name => this.nativeObservedName(name)))), () => null).catch(() => null);
    const out = new Map<string, PaneCapture>();
    let unlisted = false;
    /** Capture one chunk with a single chained tmux call into `out`; on failure, retry it without the unlisted targets
     *  or split it in half. */
    const captureChunk = async (chunk: string[]): Promise<void> => {
      let physical = chunk;
      if (this.terminalKind === "psmux") {
        const bindings = await Promise.all(chunk.map(async logical => {
          try { return { logical, physical: await this.nativeBoundName(logical) }; }
          catch { out.set(logical, { text: null, capturedAt: now() }); return undefined; }
        }));
        const known = bindings.filter((binding): binding is { logical: string; physical: string } => binding !== undefined);
        chunk = known.map(binding => binding.logical); physical = known.map(binding => binding.physical);
        if (!chunk.length) return;
      }
      const nonce = randomUUID().replace(/-/g, "");
      const mark = (k: number) => `__openrig_capture_${nonce}_${k}__`;
      const argv = ["tmux", ...chunk.flatMap((t, k) => [
        ...(k > 0 ? [";"] : []),
        "display-message", "-p", "-t", `=${physical[k]}:`, mark(k), ";", "capture-pane", "-p", "-t", `=${physical[k]}:`, "-S", `-${lines}`,
      ])];
      const legacy = "tmux " + chunk.map((t, k) =>
        `display-message -p -t ${shellQuote(`=${t}:`)} ${shellQuote(mark(k))} \\; capture-pane -p -t ${shellQuote(`=${t}:`)} -S -${lines}`,
      ).join(" \\; ");
      let output: string;
      let capturedAt: Date;
      try {
        output = this.terminalKind === "psmux" ? await this.nativeRaw(argv) : await this.run(argv, legacy);
        capturedAt = now(); // when THIS chunk's panes were read, not when the sweep ends
      } catch (err) {
        const live = await listing;
        if (!live) {
          // A failed listing doesn't show the server is gone; the chain's own error does.
          const cause = tmuxReportedError(err);
          if (isNoServerError(cause) || isTmuxTransportAbsentError(cause)) unlisted = true;
          return;
        }
        // The listing answered, so the server was up: the targets it lacks are dropped first.
        const listedAt = now();
        const present: string[] = [];
        for (const t of chunk) {
          if (live.has(t)) present.push(t);
          else out.set(t, { text: null, capturedAt: listedAt, missing: true });
        }
        if (present.length < chunk.length) {
          if (present.length) await captureChunk(present);
          return;
        }
        const cause = tmuxReportedError(err);
        // Every half would fail the same way: the server is gone.
        if (isNoServerError(cause) || isTmuxTransportAbsentError(cause)) {
          for (const t of chunk) out.set(t, { text: null, capturedAt: listedAt });
          return;
        }
        // Halving helps only an output that overflowed exec's buffer (wide, colour-dense panes) or a session that
        // vanished since the listing. Any other error would fail every half, so the chunk is left to per-target reads.
        // Node's overflow error is the message's first line; pane text follows it.
        if (!/^.*maxBuffer length exceeded/.test((err as Error).message) && !isSessionAbsenceError(cause) && !isPaneAbsenceError(cause)) {
          return;
        } else if (chunk.length > 1) {
          const half = Math.ceil(chunk.length / 2);
          await Promise.all([captureChunk(chunk.slice(0, half)), captureChunk(chunk.slice(half))]);
        }
        return; // a single session that failed: read per target by the caller
      }
      const segments: Array<string[] | null> = chunk.map(() => null);
      let cur = -1;
      const outLines = output.split("\n");
      if (outLines.length && outLines[outLines.length - 1] === "") outLines.pop(); // the final newline, not a line
      for (const line of outLines) {
        const m = line.startsWith(`__openrig_capture_${nonce}_`) ? /_(\d+)__$/.exec(line) : null;
        if (m && line === mark(Number(m[1]))) {
          cur = Number(m[1]);
          segments[cur] = [];
        } else if (cur >= 0) {
          segments[cur]!.push(line);
        }
      }
      chunk.forEach((t, k) => {
        const seg = segments[k];
        if (seg == null) return; // its marker never printed: read per target
        // capture-pane prints its lines newline-terminated, as the per-target read returns them
        const text = seg.length ? seg.join("\n") + "\n" : "";
        out.set(t, { text: text === "" ? null : text, capturedAt });
      });
    };
    const unique = [...new Set(targets)];
    for (let i = 0; i < unique.length && !unlisted; i += CAPTURE_BATCH) await captureChunk(unique.slice(i, i + CAPTURE_BATCH));
    return unlisted && out.size === 0 ? null : out;
  }

  async captureSessionContent(name: string, lines = 20, opts?: { escapeSequences?: boolean; joinWrappedLines?: boolean }): Promise<string | null> { return this.capturePaneContent(name, lines, opts, true); }

  async capturePaneContent(paneId: string, lines: number = 20, opts?: { escapeSequences?: boolean; joinWrappedLines?: boolean }, literalSessionName = false): Promise<string | null> {
    const target = literalSessionName ? `=${paneId}:` : exactTarget(paneId, "pane");
    // `-e` keeps text styling, such as the faint rendering of a suggestion.
    const styled = opts?.escapeSequences === true;
    // Verification can recover mid-word soft wraps without erasing logical newlines.
    const joined = opts?.joinWrappedLines === true;
    try {
      const argv = ["tmux", "capture-pane", "-p", ...(styled ? ["-e"] : []), ...(joined ? ["-J"] : []), "-t", target, "-S", `-${lines}`];
      const legacy = `tmux capture-pane -p${styled ? " -e" : ""}${joined ? " -J" : ""} -t ${shellQuote(target)} -S -${lines}`;
      const output = literalSessionName ? await this.runNamedSession(argv, paneId, legacy, true) : await this.run(argv, legacy);
      return output || null;
    } catch {
      return null;
    }
  }

  /**
   * Capture the currently VISIBLE pane screen (no scrollback). Returns null if
   * unavailable. The live-terminal seed (OPR.0.4.0.38) must use the visible
   * screen, NOT `-S -<lines>` scrollback: scrollback reintroduces the row drift
   * the absolute-paint seed exists to eliminate.
   */
  async captureSessionScreen(name: string, opts?: { escapeSequences?: boolean }): Promise<string | null> { return this.capturePaneScreen(name, opts, true); }

  async capturePaneScreen(paneId: string, opts?: { escapeSequences?: boolean }, literalSessionName = false): Promise<string | null> {
    const target = literalSessionName ? `=${paneId}:` : exactTarget(paneId, "pane");
    try {
      const argv = ["tmux", "capture-pane", "-p", ...(opts?.escapeSequences ? ["-e"] : []), "-t", target], legacy = `tmux capture-pane -p${opts?.escapeSequences ? " -e" : ""} -t ${shellQuote(target)}`;
      const output = literalSessionName ? await this.runNamedSession(argv, paneId, legacy, true) : await this.run(argv, legacy);
      return output || null;
    } catch {
      return null;
    }
  }

  /** Cursor movement during capture is an unknown input, never permission to type. */
  async captureSessionComposerSnapshot(name: string): Promise<ComposerSnapshot | null> { return this.captureComposerSnapshot(name, true); }

  async captureComposerSnapshot(paneId: string, literalSessionName = false): Promise<ComposerSnapshot | null> {
    try {
      const before = literalSessionName ? await this.getSessionCursorPosition(paneId) : await this.getPaneCursorPosition(paneId);
      if (!before) return null;
      const screen = literalSessionName ? await this.captureSessionScreen(paneId, { escapeSequences: true }) : await this.capturePaneScreen(paneId, { escapeSequences: true });
      if (screen === null) return null;
      const target = literalSessionName ? `=${paneId}:` : exactTarget(paneId, "pane");
      const argv = ["tmux", "display-message", "-p", "-t", target, "#{pane_in_mode}"];
      const mode = (literalSessionName ? await this.runNamedSession(argv, paneId, undefined, true) : await this.run(argv)).trim();
      const after = literalSessionName ? await this.getSessionCursorPosition(paneId) : await this.getPaneCursorPosition(paneId);
      if (!after || JSON.stringify(before) !== JSON.stringify(after) || !/^\d+$/.test(mode)) return null;
      return { screen, cursor: after, inMode: Number(mode) !== 0 };
    } catch { return null; }
  }

  /**
   * Get the current cursor coordinates and pane geometry. Coordinates are
   * zero-based. Returns null if unavailable or if tmux yields non-finite /
   * out-of-range values (x<0, y<0, width<1, height<1) so a bad read never
   * produces a garbage seed.
   */
  async getSessionCursorPosition(name: string): Promise<TmuxCursorPosition | null> { return this.getPaneCursorPosition(name, true); }

  async getPaneCursorPosition(paneId: string, literalSessionName = false): Promise<TmuxCursorPosition | null> {
    const exact = literalSessionName ? `=${paneId}:` : exactTarget(paneId, "pane");
    try {
      const argv = ["tmux", "display-message", "-p", "-t", exact, CURSOR_FORMAT], legacy = `tmux display-message -p -t ${shellQuote(exact)} "${CURSOR_FORMAT}"`;
      const output = literalSessionName ? await this.runNamedSession(argv, paneId, legacy, true) : await this.run(argv, legacy);
      const [xRaw, yRaw, widthRaw, heightRaw] = output.trim().split(TMUX_FIELD_SEPARATOR);
      const x = Number.parseInt(xRaw ?? "", 10);
      const y = Number.parseInt(yRaw ?? "", 10);
      const width = Number.parseInt(widthRaw ?? "", 10);
      const height = Number.parseInt(heightRaw ?? "", 10);
      if (![x, y, width, height].every(Number.isFinite)) return null;
      if (x < 0 || y < 0 || width < 1 || height < 1) return null;
      return { x, y, width, height };
    } catch {
      return null;
    }
  }

  /**
   * Set a SESSION-scoped option via `set-option -t <session>` (OPR.0.4.6.02
   * N1 JSDoc fix, arch): this is the GENERIC session-scope writer — it takes
   * ANY session option, not only `@`-prefixed user options (it is how the
   * launcher sets built-in session options like `mouse` and `status`). For
   * SERVER-scope options use `setServerOption` (`set-option -s`); the two
   * scopes are never crossed (guard b2).
   */
  async setSessionOption(sessionName: string, key: string, value: string): Promise<TmuxResult> {
    // set/show-option take a target-pane even when the option is session-scoped.
    const exact = exactTarget(sessionName, "pane");
    try {
      await this.runNamedSession(["tmux", "set-option", "-t", exact, key, value], sessionName,
        `tmux set-option -t ${shellQuote(exact)} ${shellQuote(key)} ${shellQuote(value)}`, true);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * Native psmux server scope is selected by its owning session target;
   * each session has a separate server. Call only for a freshly created target.
   */
  async setNativeServerOption(sessionName: string, option: string, value: string): Promise<TmuxResult> {
    if (this.terminalKind !== "psmux") return { ok: false, code: "unsupported", message: "Targeted native server options require psmux." };
    // psmux has one server per session. The explicit target selects only the
    // freshly created server; the unscoped POSIX server API must not be used.
    const exact = exactTarget(sessionName, "pane");
    try {
      await this.runNamedSession(["tmux", "set-option", "-s", "-t", exact, option, value], sessionName,
        `tmux set-option -s -t ${shellQuote(exact)} ${shellQuote(option)} ${shellQuote(value)}`, true);
      return { ok: true };
    } catch (err) { return classifyWriteError(err); }
  }

  /** POSIX server scope: no session target; used for clipboard defaults once per daemon. */
  async setServerOption(option: string, value: string): Promise<TmuxResult> {
    try {
      await this.run(["tmux", "set-option", "-s", option, value],
        `tmux set-option -s ${shellQuote(option)} ${shellQuote(value)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * OPR.0.4.6.02 S1: read a SERVER-scoped option value via
   * `show-options -sv <option>` (the `-s` server-scope reader — mirrors
   * `setServerOption`). Returns null if unset or on error. For tests/proof.
   */
  async showServerOption(option: string): Promise<string | null> {
    try {
      const output = await this.run(["tmux", "show-options", "-sv", option],
        `tmux show-options -sv ${shellQuote(option)}`);
      const v = output.trim();
      return v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }

  /** Get a session-scoped user option value. Returns null if not set or error. */
  async getSessionOption(sessionName: string, key: string): Promise<string | null> {
    // set/show-option take a target-pane even when the option is session-scoped.
    const exact = exactTarget(sessionName, "pane");
    try {
      const output = await this.runNamedSession(["tmux", "show-option", "-v", "-t", exact, key], sessionName,
        `tmux show-option -v -t ${shellQuote(exact)} ${shellQuote(key)}`, true);
      return output.trim() || null;
    } catch {
      return null;
    }
  }

  /**
  /**
   * Slice 15 — read the timestamp (Unix epoch seconds) of the last
   * activity on the pane's window. The daemon's SeatActivityService
   * compares this against the configured silence window: if the
   * timestamp is within the window the seat is `terminal-active`,
   * otherwise it's silent past the threshold.
   *
   * Why not `pane_silence_flag`: tmux 3.6a was observed to return a
   * blank value for `#{pane_silence_flag}` during slice 15 dogfood
   * (sticky-alert behavior + version-dependent emit semantics), so
   * we cannot rely on it as the primary signal. `#{window_activity}`
   * is reliably populated (the runtime updates it whenever the
   * window receives output) and is the timestamp the tmux status-line
   * activity indicators use themselves.
   *
   * Returns:
   *   - a Unix-epoch-seconds integer when the runtime exposed the value
   *   - `null` when the target is missing OR the value is unparseable
   *     (consumers treat null as "no signal", distinct from "idle").
   */
  /** readAllSessionWindowActivity with a key of each current window's active pane from the same call. tmux changes
   *  what a capture returns without counting activity on a resize, a reset, a respawn, a pane switch or a
   *  clear-history; each moves the pane's id, pid, size, history size or bytes, or its cursor. The session name stays last. */
  async readAllSessionWindows(): Promise<Map<string, { activity: number; size: string }> | null> {
    try {
      const format = ["#{window_active}", "#{window_activity}", "#{window_width}x#{window_height}:#{pane_id}:#{pane_pid}:#{pane_width}x#{pane_height}:#{history_size}:#{history_bytes}:#{cursor_x},#{cursor_y}", "#{session_name}"].join(TMUX_FIELD_SEPARATOR);
      const output = await this.run(["tmux", "list-windows", "-a", "-F", format], `tmux list-windows -a -F '${format}'`);
      const out = new Map<string, { activity: number; size: string }>();
      // Strip the transport's CRLF boundary, not whitespace in the session name.
      for (const line of output.split(/\r?\n/)) {
        const f1 = line.indexOf(TMUX_FIELD_SEPARATOR), f2 = line.indexOf(TMUX_FIELD_SEPARATOR, f1 + 1), f3 = line.indexOf(TMUX_FIELD_SEPARATOR, f2 + 1);
        if (f1 < 0 || f2 < 0 || f3 < 0) continue;
        const activity = line.slice(f1 + 1, f2).trim(), session = line.slice(f3 + 1);
        if (!session || line.slice(0, f1) !== "1" || !/^\d+$/.test(activity) || Number(activity) <= 0) continue;
        out.set(await this.nativeObservedName(session), { activity: Number(activity), size: line.slice(f2 + 1, f3) });
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Every session's current-window `#{window_activity}` in ONE tmux call, keyed by session name: the same value
   *  `readPaneLastActivity(<session name>)` reads (display-message -t <session> resolves to the session's current
   *  window). Only well-formed timestamps are included, so a missing key means "read it the per-target way". Null when
   *  tmux can't be read at all. The session name is the LAST field, so a separator inside it stays intact. */
  async readAllSessionWindowActivity(): Promise<Map<string, number> | null> {
    try {
      const format = ["#{window_active}", "#{window_activity}", "#{session_name}"].join(TMUX_FIELD_SEPARATOR);
      const output = await this.run(["tmux", "list-windows", "-a", "-F", format], `tmux list-windows -a -F '${format}'`);
      const out = new Map<string, number>();
      for (const line of output.split(/\r?\n/)) {
        const first = line.indexOf(TMUX_FIELD_SEPARATOR), second = line.indexOf(TMUX_FIELD_SEPARATOR, first + 1);
        if (first < 0 || second < 0) continue;
        const active = line.slice(0, first), activity = line.slice(first + 1, second).trim(), session = line.slice(second + 1);
        if (!session || active !== "1" || !/^\d+$/.test(activity)) continue;
        const n = Number(activity);
        if (Number.isFinite(n) && n > 0) out.set(await this.nativeObservedName(session), n);
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Every pane's pid, explicit dead flag and current command in ONE tmux call. A retained dead pane can keep
   *  its former PID/command: neither proves an executor is alive. A dead pane without a valid PID is retained with
   *  null PID; other invalid rows fall back to per-pane reads. The command stays LAST to preserve separators. */
  async readAllPaneProcesses(): Promise<Map<string, { pid: number | null; command: string | null; dead?: boolean }> | null> {
    // Cross-session psmux listings expose duplicate local %N ids. Use scoped
    // per-pane reads until a scoped batch projection is implemented.
    if (this.terminalKind === "psmux") return null;
    try {
      const format = ["#{pane_id}", "#{pane_pid}", "#{pane_dead}", "#{pane_current_command}"].join(TMUX_FIELD_SEPARATOR);
      const output = await this.run(["tmux", "list-panes", "-a", "-F", format], `tmux list-panes -a -F '${format}'`);
      const out = new Map<string, { pid: number | null; command: string | null; dead?: boolean }>();
      for (const line of output.split("\n")) {
        const first = line.indexOf(TMUX_FIELD_SEPARATOR), second = line.indexOf(TMUX_FIELD_SEPARATOR, first + 1);
        const third = line.indexOf(TMUX_FIELD_SEPARATOR, second + 1);
        if (first <= 0 || second < 0 || third < 0) continue;
        const id = line.slice(0, first), rawPid = Number(line.slice(first + 1, second).trim());
        const pid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : null;
        const rawDead = line.slice(second + 1, third).trim();
        const dead = rawDead === "1" ? true : rawDead === "0" ? false : undefined;
        if (pid === null && dead !== true) continue;
        out.set(id, { pid, command: line.slice(third + 1).trim() || null, ...(dead === undefined ? {} : { dead }) });
      }
      return out;
    } catch {
      return null;
    }
  }

  async readPaneLastActivity(paneId: string): Promise<number | null> {
    const exact = exactTarget(paneId, "pane");
    try {
      const output = await this.run(
        ["tmux", "display-message", "-p", "-t", exact, "#{window_activity}"],
        `tmux display-message -p -t ${shellQuote(exact)} '#{window_activity}'`,
      );
      const trimmed = output.trim();
      if (!/^\d+$/.test(trimmed)) return null;
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n;
    } catch {
      return null;
    }
  }

  /**
   * OPR.0.4.3.26 — list the tmux clients (human terminals / CMUX tiles) attached
   * to the server. VIEW-ONLY probe: it never mutates routing, bindings, or
   * sessions. Mirrors the read/parse/error-swallow shape of `listSessions`:
   * a "no server running" / socket-absent server yields `[]` (no attachable
   * client) so the caller emits an honest "attach first" error rather than
   * crashing. Unexpected failures (permission, etc.) rethrow.
   */
  async listClients(): Promise<TmuxClient[]> {
    try {
      const output = await this.run(["tmux", "list-clients", "-F", CLIENT_FORMAT],
        `tmux list-clients -F "${CLIENT_FORMAT}"`);
      return await Promise.all(parseLines(output, parseClientLine).map(async client => ({ ...client, session: await this.nativeObservedName(client.session) })));
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  /**
   * OPR.0.4.3.26 — retarget an already-attached client's VIEW to `target`
   * (`<session>` or `<session>:<window>`). This is the whole point of the
   * seat-recovery slice: it changes only what a client SEES; it never creates,
   * kills, or rebinds a session and never touches OpenRig routing/identity.
   */
  async switchClient(client: string, target: string): Promise<TmuxResult> {
    const exact = exactTarget(target, "session");
    try {
      // Keep the actual routing operand before a literal client name that may
      // itself be "-t". Native routing must not interpret that value as a flag.
      await this.run(this.terminalKind === "psmux"
        ? ["tmux", "switch-client", "-t", exact, "-c", client]
        : ["tmux", "switch-client", "-c", client, "-t", exact],
        `tmux switch-client -c ${shellQuote(client)} -t ${shellQuote(exact)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }
}
